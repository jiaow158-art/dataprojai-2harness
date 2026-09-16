// M1-T7：任务编排器 TaskRunner —— spec §5 流水线 + 附录 A.4 恢复矩阵的逐行实现者。
//
// 职责边界（对单个 run_id 的一轮完整生命周期，runOnce 内 while 循环承载 attempt 重试，
// 每轮 claimLease 已含 attempt+1）：
//   - claimLease 获权后一切状态写经围栏条件写（A.1 L1：失权即 cancel 自身引擎进程树
//     并静默退出，绝不写补偿记录）
//   - 恢复入口：publications 先查（行4：发布后崩溃 → 直接 succeeded 不重跑——对每次
//     获权都查，不只 attempt>1，使行4防线不依赖前次 claim 的存在）；attempt>1 注入
//     A.2 S2 会话历史 + 本任务已产 result_ref 清单 + "读文件续算"指示语
//   - 驱动 backend.ask() 归一化事件流：逐事件 appendEvent（检查点=每个事件，事件表即
//     保存点）+ cancel_requested 边界落地 + interval 心跳续租（fenced → 同失权路径）
//   - 发布顺序 = recordPublication → report 事件 → done 事件 → finalize(succeeded)
//     （A.3 结果层恰好一次；done 必须先于 finalize 落库——finalize 清 lease_owner 后
//     appendEvent 的围栏检查必拒，终态事件不存在"后补"通道）
//   - 失败统一分类（A.4，T7 裁决）：ask() 抛出与流内终止 error 事件**同路**按 code 归口
//     （真实 backend 的 ask() 从不抛——spawn/prompt 失败一律转流内 error 事件收流，
//     两类表面不同路则生产续跑臂失效）——TIMEOUT/ENGINE_ERROR（基础设施故障）在
//     deadline+maxAttempts 预算内 releaseForRetry 续跑（行1：同 session、注入
//     result_ref、不重查数）；CONFIG 零重试（行6）；REPORT_CHECK 等本地判定码终态失败
//
// T5 审查移交项落点：
//   - 归一化 report 事件 = "报告构建完成"信号，不入库（spec report 事件发布后才发）
//   - 报告产物定位以扫描 workdir *.html 为准（正则单段不可靠，扫描为准）
//   - repairing 阶段由本层在 attempt>1 起跑时产出（归一化器无 attempt 上下文）
//   - backend cancel 不产 error 事件，cancelled 终态由编排器靠 cancel_requested 标志落地
//   - EngineSession 无 dispose——finally 里 cancel 即回收（幂等，成功路径亦调）

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveDbAccount } from "../config/db-accounts.ts";
import type { BackendProvider, EngineSession } from "../backends/dsh-backend.ts";
import type { NormEvent } from "../backends/dsh-events.ts";
import type { Lease, TaskStore } from "../store/task-store.ts";

export interface TaskRunnerPaths {
  /** dsh workdir 树根：`<workroot>/<sessionId>/workdir`（Temp 树外——附录 A）。 */
  workroot: string;
  /** 查询结果树根：`<resultsRoot>/<sessionId>/results`（RESULT_DIR 同指）。 */
  resultsRoot: string;
  assetsDir: string;
  runnerPath: string;
  skillsDir: string;
  /** 发布目标树根：`<reportsRoot>/<user>/<run_id>.html`。 */
  reportsRoot: string;
}

export interface TaskRunnerConfig {
  workerId: string;
  /** TASK_BUDGET_S：跨 attempt 总预算（deadline 首次 claim 时固化）。 */
  taskBudgetS: number;
  /** MAX_REPAIR_ROUNDS 语义：基础设施故障的 attempt 总上限（默认 3）。 */
  maxAttempts?: number;
  /** 心跳间隔（默认 15s；L2：TTL >> 间隔）。 */
  heartbeatIntervalMs?: number;
  /** 租约 TTL（默认 90s）。 */
  leaseTtlMs?: number;
  /** 报告发布检查（minBytes 默认 1；cdnRegex 缺省用内置 http(s) 外链探测）。 */
  reportCheck?: { minBytes?: number; cdnRegex?: RegExp };
  paths: TaskRunnerPaths;
}

/** 内置外链 CDN 探测：src/href 引用 http(s) 资源即命中（本地 ./echarts.min.js 不命中）。 */
const DEFAULT_CDN_RE = /(?:src|href)\s*=\s*["']https?:\/\//i;

/** 失败统一载体：ask() 抛出与流内终止 error 事件同源同路（分类只看 code——T7 裁决）。 */
interface Failure {
  code: string;
  message: string;
}

/** ask() 抛错的 code 判定：SdkPromptError 带 code；createSession 的 [CONFIG] 前缀 Error 识别为 CONFIG。 */
function thrownCode(err: unknown): string {
  const e = err as { code?: unknown; message?: unknown };
  if (typeof e?.code === "string" && e.code) return e.code;
  if (typeof e?.message === "string" && e.message.startsWith("[CONFIG]")) return "CONFIG";
  return "ENGINE_ERROR";
}

/** 规范事件 → 入库 payload（词表形状不含 type；type 在 events.type 列）。 */
function eventPayload(ev: NormEvent): unknown {
  switch (ev.type) {
    case "stage":
      return ev.text !== undefined ? { stage: ev.stage, text: ev.text } : { stage: ev.stage };
    case "sql":
      return { sql: ev.sql, rows: ev.rows, truncated: ev.truncated, result_ref: ev.result_ref, elapsed_ms: ev.elapsed_ms };
    case "answer":
      return { markdown: ev.markdown };
    case "error":
      return { code: ev.code, message: ev.message };
    case "report":
      return { path: ev.path }; // 不会走到——调用方先行拦截为构建信号
  }
}

export class TaskRunner {
  private store: TaskStore;
  private backend: BackendProvider;
  private config: TaskRunnerConfig;
  private ttl: number;
  private hbInterval: number;
  private maxAttempts: number;
  private minBytes: number;
  private cdnRe: RegExp;

  constructor(store: TaskStore, backend: BackendProvider, config: TaskRunnerConfig) {
    this.store = store;
    this.backend = backend;
    this.config = config;
    this.ttl = config.leaseTtlMs ?? 90_000;
    this.hbInterval = config.heartbeatIntervalMs ?? 15_000;
    this.maxAttempts = config.maxAttempts ?? 3;
    this.minBytes = config.reportCheck?.minBytes ?? 1;
    this.cdnRe = config.reportCheck?.cdnRegex ?? DEFAULT_CDN_RE;
  }

  private workdirOf(sessionId: string): string {
    return join(this.config.paths.workroot, sessionId, "workdir");
  }

  private resultsDirOf(sessionId: string): string {
    return join(this.config.paths.resultsRoot, sessionId, "results");
  }

  /**
   * 对单个任务执行一轮完整生命周期（A.4 恢复矩阵逐行实现）。
   * while 循环承载 attempt 重试：可续跑基础设施故障 → releaseForRetry → 回循环顶
   * claimLease（attempt+1，可能被别的 worker 抢走——那也正是 A.1 允许的正确形态）。
   */
  async runOnce(runId: string): Promise<void> {
    const startedAt = Date.now();
    while (true) {
      // 1. claimLease 获权（attempt+1、deadline 首次固化）。失败=别人在跑/已终态/超预算。
      const lease = this.store.claimLease(runId, this.config.workerId, this.ttl, this.config.taskBudgetS);
      if (!lease) return;

      let lostLease = false;
      const hb = setInterval(() => {
        // 心跳续租（L2：worker 活着就续租，与模型是否出字无关）；fenced → 同失权路径：
        // 杀引擎进程树、不写任何状态，事件流随 cancel 终止后静默退出（A.1 L1）。
        const r = this.store.heartbeat(lease, this.ttl);
        if (r.fenced) lostLease = true;
      }, this.hbInterval);
      hb.unref?.();

      let session: EngineSession | null = null;
      try {
        // 2. 恢复入口——A.4 行4：publications 已写而 status 未翻（发布后崩溃）→
        //    直接补终态，不重跑。对每次获权都查（防线不依赖前次 claim 的存在）。
        if (this.store.getPublication(runId)) {
          this.emitDone(lease, runId, "succeeded", startedAt, lease.attempt > 1);
          this.store.finalize(lease, "succeeded");
          return;
        }

        const task = this.store.getTask(runId)!;

        // repairing 阶段事件（T5 移交：由本层产）仅 attempt>1；**历史注入前缀对每次
        // 执行都构造**（spec D14：任务出队执行时装载该对话最新已提交的历史）——每个
        // 任务都是新 spawn 的 dsh 会话（进程零记忆，S3 实测），同会话正常续问
        // （attempt=1）与恢复续跑（attempt>1）同样需要前缀；无历史时 buildHistoryPrefix
        // 返回 undefined（会话首问裸 prompt，不浪费 token）。
        // 在 spawn 之前做——若此刻已被接管（围栏拒），不浪费一次引擎 spawn。
        let historyPrefix: string | undefined;
        if (lease.attempt > 1) {
          this.store.updateStage(lease, "repairing");
          const w = this.store.appendEvent(lease, "stage", { stage: "repairing", attempt: lease.attempt });
          if (w.fenced) return; // A.1：失权者静默退出（session 尚未 spawn）
        }
        historyPrefix = this.buildHistoryPrefix(task.session_id, runId, this.resultsDirOf(task.session_id));

        // 3. 驱动执行。createSession 抛错（env 缺失等 [CONFIG]）→ 按其 code 终态。
        try {
          session = await this.backend.createSession({
            sessionId: task.session_id,
            attempt: lease.attempt,
            runId: runId,
            workroot: this.config.paths.workroot,
            resultsRoot: this.config.paths.resultsRoot,
            assetsDir: this.config.paths.assetsDir,
            runnerPath: this.config.paths.runnerPath,
            skillsDir: this.config.paths.skillsDir,
            db: resolveDbAccount(task.scope_group),
          });
        } catch (err) {
          const code = thrownCode(err);
          const message = `createSession failed: ${err instanceof Error ? err.message : String(err)}`;
          this.emitDone(lease, runId, "failed", startedAt, lease.attempt > 1);
          this.store.finalize(lease, "failed", code === "CONFIG" ? "CONFIG" : "ENGINE_ERROR", message);
          return;
        }

        let failure: Failure | null = null;
        let reportSignal: string | null = null;
        let cancelled = false;

        // ask 预算：deadline 剩余量即单问 timeout 上限（TASK_BUDGET_S 跨 attempt 总闸）。
        const deadlineLeft = task.deadline != null ? task.deadline - Date.now() : undefined;
        const askOpts = {
          ...(historyPrefix !== undefined ? { historyPrefix } : {}),
          ...(deadlineLeft != null ? { timeoutMs: Math.max(deadlineLeft, 1_000) } : {}),
        };

        try {
          for await (const ev of session.ask(task.question, askOpts)) {
            if (ev.type === "report") {
              // T5 审查裁定：归一化 report = "报告构建完成"信号，非 spec report 事件——
              // 只记产物路径供发布定位，事件在发布后才发（防双发）。
              reportSignal = ev.path;
            } else {
              const w = this.store.appendEvent(lease, ev.type, eventPayload(ev));
              if (w.fenced) {
                lostLease = true; // A.1 L1：围栏拒 → 杀自身进程树 + 静默退出
                break;
              }
              if (ev.type === "error") failure = { code: ev.code, message: ev.message };
            }
            // cancel 检查点（事件边界）：backend cancel 不产 error，编排器靠标志落地。
            if (this.store.getTask(runId)?.cancel_requested === 1) {
              cancelled = true;
              break;
            }
          }
        } catch (err) {
          // ask() 抛出（真实 dsh backend 不走此路——失败一律转流内 error 事件；此分支
          // 覆盖 mock/未来引擎实现）：与流内 error 事件同进统一分类器。
          failure = { code: thrownCode(err), message: err instanceof Error ? err.message : String(err) };
        }

        if (lostLease) {
          await session.cancel();
          return; // 别人已接管——不 finalize（行3：旧执行者 kill 自身退出）
        }

        // 流零事件/提前结束也补一次 cancel 检查。
        if (this.store.getTask(runId)?.cancel_requested === 1) cancelled = true;
        if (cancelled) {
          await session.cancel();
          this.emitDone(lease, runId, "cancelled", startedAt, lease.attempt > 1);
          this.store.finalize(lease, "cancelled");
          return;
        }

        // 4. 失败路径分类（A.4）——统一分类器：来源（ask 抛出 / 流内 error 事件收流）
        //    不参与判定，只看 code（计费类错误嗅探例外，见下）：
        //    TIMEOUT/ENGINE_ERROR → 基础设施故障 → 续跑臂（行1）；
        //    CONFIG → 快败零重试（行6，对应 backend :193 spawn/initialize 失败）；
        //    REPORT_CHECK 等本地判定码 → 终态失败（重试无意义）。
        if (failure) {
          // soak 发现1：计费类错误（402 QUOTA / Insufficient Balance）经 turn/end error
          // reason 统一映射为 ENGINE_ERROR，重试毫无意义（烧满 3 attempt ×15 任务=45 次
          // 无效 turn）——按行6 语义归 CONFIG 快败零重试。
          if (
            failure.code === "ENGINE_ERROR" &&
            /Insufficient\s+Balance|("code"\s*:\s*"QUOTA")|status"?\s*[:=]\s*402/i.test(failure.message)
          ) {
            this.emitDone(lease, runId, "failed", startedAt, lease.attempt > 1);
            this.store.finalize(lease, "failed", "CONFIG", `计费/配额错误（快败不重试）: ${failure.message}`);
            return;
          }
          if (failure.code === "TIMEOUT" || failure.code === "ENGINE_ERROR") {
            // 行1：基础设施故障——deadline/attempt 预算内续跑（带历史注入，不重查数）。
            const t = this.store.getTask(runId)!;
            if (t.deadline != null && t.deadline < Date.now()) {
              // 超预算：TIMEOUT 触发的标 TIMEOUT（任务文本），其余归 UNRECOVERABLE（同 reaper）。
              const code = failure.code === "TIMEOUT" ? "TIMEOUT" : "UNRECOVERABLE";
              this.emitDone(lease, runId, "failed", startedAt, lease.attempt > 1);
              this.store.finalize(lease, "failed", code, `deadline 已过: ${failure.message}`);
              return;
            }
            if (lease.attempt >= this.maxAttempts) {
              this.emitDone(lease, runId, "failed", startedAt, lease.attempt > 1);
              this.store.finalize(lease, "failed", "UNRECOVERABLE", `attempt 达上限 ${this.maxAttempts}: ${failure.message}`);
              return;
            }
            // 重试前最后看一眼取消标志（失败窗口期到的取消不丢）。
            if (t.cancel_requested === 1) {
              await session.cancel();
              this.emitDone(lease, runId, "cancelled", startedAt, lease.attempt > 1);
              this.store.finalize(lease, "cancelled");
              return;
            }
            // 主动让出租约（status 保持 running）→ 循环顶 claimLease 才能以 attempt+1 接管。
            const rel = this.store.releaseForRetry(lease);
            if (rel.fenced) return; // 已被接管——静默退出
            continue;
          }
          // CONFIG（行6）与其余本地判定码：终态失败零重试。
          this.emitDone(lease, runId, "failed", startedAt, lease.attempt > 1);
          this.store.finalize(lease, "failed", failure.code, failure.message);
          return;
        }

        // 5. 成功路径：报告发布。
        const artifact = this.locateArtifact(this.workdirOf(task.session_id), reportSignal);
        if (!artifact) {
          // 无 HTML 产物且无 pendingError → 纯问答任务，跳过发布。
          this.emitDone(lease, runId, "succeeded", startedAt, lease.attempt > 1);
          this.store.finalize(lease, "succeeded");
          return;
        }

        // 发布检查（M1 简化：失败不 Self-Heal，走失败终态，消息含检查详情）。
        const check = this.checkReport(artifact);
        if (!check.ok) {
          this.emitDone(lease, runId, "failed", startedAt, lease.attempt > 1);
          this.store.finalize(lease, "failed", "REPORT_CHECK", `报告发布检查失败: ${check.detail}`);
          return;
        }

        this.store.updateStage(lease, "publishing");
        const wp = this.store.appendEvent(lease, "stage", { stage: "publishing" });
        if (wp.fenced) {
          // 已被接管：publications 未写，接管者会重跑发布——此处静默退出即可。
          await session.cancel();
          return;
        }

        const dest = join(this.config.paths.reportsRoot, task.user, `${runId}.html`);
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(artifact, dest);
        // A.3 结果层：先 publications（INSERT OR IGNORE 恰好一次）、后事件、后终态。
        this.store.recordPublication(runId, dest);
        const wr = this.store.appendEvent(lease, "report", { path: dest });
        if (wr.fenced) return; // publications 已写：接管者走行4恢复补终态——恰好一次发布成立
        this.emitDone(lease, runId, "succeeded", startedAt, lease.attempt > 1);
        this.store.finalize(lease, "succeeded");
        return;
      } finally {
        clearInterval(hb);
        // T5 Minor-6：EngineSession 无 dispose——cancel 即回收（幂等；成功路径亦调）。
        if (session) await session.cancel();
      }
    }
  }

  /** done 事件（词表六类之一）：必须先于 finalize 落库（见文件头发布顺序注）。 */
  private emitDone(lease: Lease, runId: string, status: "succeeded" | "failed" | "cancelled", startedAt: number, recovered: boolean): void {
    this.store.appendEvent(lease, "done", {
      run_id: runId,
      status,
      engine: "dsh",
      elapsed_ms: Date.now() - startedAt,
      tokens: null,
      recovered,
    });
  }

  /**
   * A.2 S2 历史注入前缀（attempt>1 恢复路径）：本会话全部已成功任务（问题+回答摘要
   * +result_ref 清单）+ 失败任务仅问题文本（模型知道问过什么、结果不可信）；
   * 另附本任务已产生的 result_ref 清单（sessionHistory 从 events 表 sql 事件提取，
   * 跨 attempt 累积）+ 指示语——这些结果已落盘，直接读文件续算，不要重新查询。
   */
  private buildHistoryPrefix(sessionId: string, runId: string, resultsDir: string): string | undefined {
    const lines: string[] = ["【会话历史注入（事实源=网关事件表）】"];
    const hist = this.store.sessionHistory(sessionId);
    const current = hist.find((h) => h.run_id === runId);
    let n = 0;
    for (const h of hist) {
      if (h.run_id === runId) continue; // 本任务的 result_ref 单列，不进历史清单
      // T7 审查 Minor-1：只有终态任务进历史——queued/running 是尚未出结果的在途任务
      // （如同会话排在本任务之后的提问），渲染成"失败，结果不可信"会让恢复实例
      // 误否定真实历史。
      if (h.status === "queued" || h.status === "running") continue;
      n++;
      lines.push(`${n}. [${h.status}] 问题：${h.question}`);
      if (h.status === "succeeded") {
        if (h.final_answer) lines.push(`   回答摘要：${h.final_answer.slice(0, 500)}`);
        if (h.result_refs.length) lines.push(`   结果文件：${h.result_refs.join(", ")}`);
      } else {
        lines.push(`   （该任务${h.status === "cancelled" ? "已取消" : "失败"}，结果不可信）`);
      }
    }
    const refs = current?.result_refs ?? [];
    // 无可注入内容（会话首问且本任务无既往结果）→ undefined，裸 prompt。
    if (n === 0 && refs.length === 0) return undefined;
    if (refs.length) lines.push(`本任务此前已产生的查询结果文件：${refs.join(", ")}`);
    lines.push(`以上查询结果已保存在 ${resultsDir}，请直接读取文件续算，不要重新查询。`);
    return lines.join("\n");
  }

  /**
   * 报告产物定位：优先归一化 report 信号路径（归一化器只保留 reports/ 相对段，
   * 宿主前缀按 workdir 映射）；文件不存在 → 兜底扫描 workdir *.html
   * （T5 Minor：正则单段不可靠，扫描为准；递归，mtime 最新优先）。
   */
  private locateArtifact(workdir: string, signal: string | null): string | null {
    if (signal) {
      const p = join(workdir, ...signal.split("/"));
      if (existsSync(p) && statSync(p).isFile()) return p;
    }
    const hits: { p: string; m: number }[] = [];
    const walk = (d: string): void => {
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.toLowerCase().endsWith(".html")) {
          try {
            hits.push({ p, m: statSync(p).mtimeMs });
          } catch {
            /* 扫描窗口内被删——跳过 */
          }
        }
      }
    };
    walk(workdir);
    hits.sort((a, b) => b.m - a.m);
    return hits[0]?.p ?? null;
  }

  /** 发布检查：非空且大于 minBytes + 无外链 CDN（详情进错误消息，走 REPORT_CHECK 终态）。 */
  private checkReport(p: string): { ok: true } | { ok: false; detail: string } {
    let size = 0;
    try {
      size = statSync(p).size;
    } catch (e) {
      return { ok: false, detail: `产物不可读: ${String(e)}` };
    }
    if (size <= this.minBytes) {
      return { ok: false, detail: `HTML 产物 ${size} bytes ≤ minBytes ${this.minBytes}（空或过小）` };
    }
    let html: string;
    try {
      html = readFileSync(p, "utf8");
    } catch (e) {
      return { ok: false, detail: `产物读取失败: ${String(e)}` };
    }
    const m = html.match(this.cdnRe);
    if (m) return { ok: false, detail: `检测到外链 CDN 引用: ${JSON.stringify(m[0])}` };
    return { ok: true };
  }
}
