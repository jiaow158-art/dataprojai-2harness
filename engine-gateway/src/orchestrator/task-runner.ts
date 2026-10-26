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

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { resolveDbAccount } from "../config/db-accounts.ts";
import type { BackendProvider, EngineSession } from "../backends/dsh-backend.ts";
import type { NormEvent, UsageTotal } from "../backends/dsh-events.ts";
import type { DshCleanupHandle } from "../backends/dsh-sdk-client.ts";
import type { Lease, TaskStore } from "../store/task-store.ts";
import type { CleanupTrigger, TaskCleanupReport } from "./cleanup-report.ts";
import type { SandboxContainerReaper } from "./sandbox-container-reaper.ts";
import {
  TaskCleanupCoordinator,
  type CleanupFence,
  type CoordinatorAudit,
} from "./task-cleanup-coordinator.ts";

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
  /**
   * C2-B2-2B-2：Linux 隔离清理模式。缺省=off，完全沿用 M1 旧生命周期。
   * 一旦提供，必须同时使用 cleanupHoldMode=true 的 TaskStore；任何依赖缺失都在
   * 构造期 fail-closed，不允许退化成旧路径或 mock 清理。
   */
  cleanup?: TaskRunnerCleanupConfig;
}

export interface TaskRunnerCleanupConfig {
  platform: "linux";
  /** 与 DSH/Runner SANDBOX_ACL_STATE_DIR 同源，且必须已通过启动期可信目录校验。 */
  aclStateDir: string;
  /** TaskCleanupCoordinator 总预算，必须小于租约安全窗口。 */
  timeBudgetMs: number;
  /** 真实 SandboxContainerReaper（tests 可注入显式故障，但生产禁止绕过）。 */
  reaper: Pick<SandboxContainerReaper, "cleanup" | "probeActive">;
  /** 真实持久审计（生产为 BoundedCleanupAudit 包装的 CleanupAuditLog）。 */
  audit: CoordinatorAudit;
  gracefulMs?: number;
  killMs?: number;
  runnerDrainMs?: number;
  activeProbeIntervalMs?: number;
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

const CLEANUP_FAILURE_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

function normalizeCleanupFailureCode(value: string | undefined | null): string {
  if (typeof value === "string" && CLEANUP_FAILURE_CODE_RE.test(value)) return value;
  return "CLEANUP_REPORT_UNAVAILABLE";
}

/** 只输出 code-only 清理诊断；绝不包含路径、脚本、env 或密钥。 */
function summarizeCleanup(report: TaskCleanupReport, failureCode?: string): string {
  const checks = Object.entries(report.checks)
    .filter(([, c]) => c.status !== "passed")
    .map(([name, c]) => `${name}=${c.status}:${c.reason}`);
  const suffix = failureCode ? ` code=${failureCode}` : "";
  return checks.length > 0 ? `${checks.join(",")}${suffix}` : `overallOk=false${suffix}`;
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
  private cleanup: TaskRunnerCleanupConfig | null;

  constructor(store: TaskStore, backend: BackendProvider, config: TaskRunnerConfig) {
    this.store = store;
    this.backend = backend;
    this.config = config;
    this.ttl = config.leaseTtlMs ?? 90_000;
    this.hbInterval = config.heartbeatIntervalMs ?? 15_000;
    this.maxAttempts = config.maxAttempts ?? 3;
    this.minBytes = config.reportCheck?.minBytes ?? 1;
    this.cdnRe = config.reportCheck?.cdnRegex ?? DEFAULT_CDN_RE;
    this.cleanup = config.cleanup ?? null;
    if (this.cleanup) this.assertCleanupConfig(this.cleanup);
  }

  private assertCleanupConfig(cleanup: TaskRunnerCleanupConfig): void {
    if (cleanup.platform !== "linux" || process.platform !== "linux") {
      throw new Error("[CONFIG] cleanup mode is supported only on Linux");
    }
    if (!cleanup.reaper || !cleanup.audit) {
      throw new Error("[CONFIG] cleanup mode requires a real reaper and persistent audit");
    }
    if (
      typeof cleanup.aclStateDir !== "string" ||
      cleanup.aclStateDir.length === 0 ||
      !Number.isSafeInteger(cleanup.timeBudgetMs) ||
      cleanup.timeBudgetMs <= 0
    ) {
      throw new Error("[CONFIG] cleanup mode requires aclStateDir and a positive time budget");
    }
    // 任务心跳仍由本 runner 续租；清理预算必须显著小于 TTL，给心跳与 SQLite 终态留窗口。
    if (cleanup.timeBudgetMs >= this.ttl - this.hbInterval) {
      throw new Error(
        `[CONFIG] cleanup timeBudgetMs (${cleanup.timeBudgetMs}) must be below lease safety window ` +
          `(${this.ttl} - ${this.hbInterval} ms)`,
      );
    }
    for (const [name, value] of [
      ["gracefulMs", cleanup.gracefulMs],
      ["killMs", cleanup.killMs],
      ["runnerDrainMs", cleanup.runnerDrainMs],
      ["activeProbeIntervalMs", cleanup.activeProbeIntervalMs],
    ] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
        throw new Error(`[CONFIG] cleanup ${name} must be a non-negative integer`);
      }
    }
  }

  private workdirOf(sessionId: string): string {
    return join(this.config.paths.workroot, sessionId, "workdir");
  }

  private resultsDirOf(sessionId: string): string {
    return join(this.config.paths.resultsRoot, sessionId, "results");
  }

  /**
   * 对单个任务执行一轮完整生命周期（A.4 恢复矩阵逐行实现）。
   * cleanup 缺省 = C2-B2-2B-1 及以前的旧路径，行为逐字不变；显式 Linux isolated
   * cleanup 模式走 hold-aware 新路径（claim → execute → beginCleanup → handoff →
   * TaskCleanupCoordinator → TaskStore 原子终态/重试）。
   */
  async runOnce(runId: string): Promise<void> {
    if (this.cleanup) return this.runOnceWithCleanup(runId);
    return this.runOnceLegacy(runId);
  }

  private async runOnceLegacy(runId: string): Promise<void> {
    const startedAt = Date.now();
    // M2-T0：done.tokens——跨 ask/attempt 的 usage 累计（每次 ask 结束累计
    // session.lastUsage()）；null = 引擎未提供任何 usage（mock/旧实现兜底，词表允许 null）。
    let tokens: UsageTotal | null = null;
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
      let earlyTerminationGuard: NodeJS.Timeout | null = null;
      try {
        // 2. 恢复入口——A.4 行4：publications 已写而 status 未翻（发布后崩溃）→
        //    直接补终态，不重跑。对每次获权都查（防线不依赖前次 claim 的存在）。
        if (this.store.getPublication(runId)) {
          this.emitDone(lease, runId, "succeeded", startedAt, lease.attempt > 1, tokens);
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
          this.emitDone(lease, runId, "failed", startedAt, lease.attempt > 1, tokens);
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

        // M2-T0：本 ask 结束（成功/失败/取消路径都算）累计本轮 usage。旧 mock/未来
        // 引擎实现无 lastUsage 方法 → typeof 守卫跳过（tokens 保持 null 兜底）；
        // 本 ask 无 usage 数据（返回 null）同样跳过。
        if (typeof session.lastUsage === "function") {
          const u = session.lastUsage();
          if (u) {
            tokens = tokens ?? { input: 0, output: 0, cache_read: 0 };
            tokens.input += u.input;
            tokens.output += u.output;
            tokens.cache_read += u.cache_read;
          }
        }

        if (lostLease) {
          await session.cancel();
          return; // 别人已接管——不 finalize（行3：旧执行者 kill 自身退出）
        }

        // 流零事件/提前结束也补一次 cancel 检查。
        if (this.store.getTask(runId)?.cancel_requested === 1) cancelled = true;
        if (cancelled) {
          await session.cancel();
          this.emitDone(lease, runId, "cancelled", startedAt, lease.attempt > 1, tokens);
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
            this.emitDone(lease, runId, "failed", startedAt, lease.attempt > 1, tokens);
            this.store.finalize(lease, "failed", "CONFIG", `计费/配额错误（快败不重试）: ${failure.message}`);
            return;
          }
          if (failure.code === "TIMEOUT" || failure.code === "ENGINE_ERROR") {
            // 行1：基础设施故障——deadline/attempt 预算内续跑（带历史注入，不重查数）。
            const t = this.store.getTask(runId)!;
            if (t.deadline != null && t.deadline < Date.now()) {
              // 超预算：TIMEOUT 触发的标 TIMEOUT（任务文本），其余归 UNRECOVERABLE（同 reaper）。
              const code = failure.code === "TIMEOUT" ? "TIMEOUT" : "UNRECOVERABLE";
              this.emitDone(lease, runId, "failed", startedAt, lease.attempt > 1, tokens);
              this.store.finalize(lease, "failed", code, `deadline 已过: ${failure.message}`);
              return;
            }
            if (lease.attempt >= this.maxAttempts) {
              this.emitDone(lease, runId, "failed", startedAt, lease.attempt > 1, tokens);
              this.store.finalize(lease, "failed", "UNRECOVERABLE", `attempt 达上限 ${this.maxAttempts}: ${failure.message}`);
              return;
            }
            // 重试前最后看一眼取消标志（失败窗口期到的取消不丢）。
            if (t.cancel_requested === 1) {
              await session.cancel();
              this.emitDone(lease, runId, "cancelled", startedAt, lease.attempt > 1, tokens);
              this.store.finalize(lease, "cancelled");
              return;
            }
            // 主动让出租约（status 保持 running）→ 循环顶 claimLease 才能以 attempt+1 接管。
            const rel = this.store.releaseForRetry(lease);
            if (rel.fenced) return; // 已被接管——静默退出
            continue;
          }
          // CONFIG（行6）与其余本地判定码：终态失败零重试。
          this.emitDone(lease, runId, "failed", startedAt, lease.attempt > 1, tokens);
          this.store.finalize(lease, "failed", failure.code, failure.message);
          return;
        }

        // 5. 成功路径：报告发布。
        const artifact = this.locateArtifact(this.workdirOf(task.session_id), reportSignal);
        if (!artifact) {
          // 无 HTML 产物且无 pendingError → 纯问答任务，跳过发布。
          this.emitDone(lease, runId, "succeeded", startedAt, lease.attempt > 1, tokens);
          this.store.finalize(lease, "succeeded");
          return;
        }

        // 发布检查（M1 简化：失败不 Self-Heal，走失败终态，消息含检查详情）。
        const check = this.checkReport(artifact);
        if (!check.ok) {
          this.emitDone(lease, runId, "failed", startedAt, lease.attempt > 1, tokens);
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
        this.emitDone(lease, runId, "succeeded", startedAt, lease.attempt > 1, tokens);
        this.store.finalize(lease, "succeeded");
        return;
      } finally {
        clearInterval(hb);
        // T5 Minor-6：EngineSession 无 dispose——cancel 即回收（幂等；成功路径亦调）。
        if (session) await session.cancel();
      }
    }
  }

  // ── C2-B2-2B-2：Linux isolated cleanup 生命周期 ─────────────────────────────────

  /**
   * hold-aware 生命周期。与 legacy 路径严格分离，off/Windows 不进入本方法。
   *
   * 每个 attempt：
   *   claimLeaseWithCleanupHold → 执行 → beginCleanup → DSH 终止权移交 →
   *   TaskCleanupCoordinator → releaseForRetryWithCleanup | finalizeWithCleanup |
   *   finalizeCleanupFailure。
   *
   * 终态、publication、report 事件、done、cleanup_reports 只通过 TaskStore 的单一
   * 原子方法落库；本方法不调用 recordPublication/appendEvent(done)/finalize。
   */
  private async runOnceWithCleanup(runId: string): Promise<void> {
    const cleanup = this.cleanup;
    if (!cleanup) return; // 构造期已保证；防御性 fail-closed
    const startedAt = Date.now();
    let tokens: UsageTotal | null = null;

    while (true) {
      const lease = this.store.claimLeaseWithCleanupHold(
        runId,
        this.config.workerId,
        this.ttl,
        this.config.taskBudgetS,
      );
      if (!lease) return;

      let lostLease = false;
      const hb = setInterval(() => {
        const r = this.store.heartbeat(lease, this.ttl);
        if (r.fenced) lostLease = true;
      }, this.hbInterval);
      hb.unref?.();

      let session: EngineSession | null = null;
      let earlyTerminationGuard: NodeJS.Timeout | null = null;
      try {
        if (lostLease) return;
        const task = this.store.getTask(runId);
        if (!task) return;

        // ACL 清理检查要求三个目录可 realpath。这里只补建任务自己的 workdir/results，
        // 不触碰 assets；即使 createSession 在 CONFIG 阶段失败，清理仍有确定现场。
        try {
          mkdirSync(this.workdirOf(task.session_id), { recursive: true });
          mkdirSync(this.resultsDirOf(task.session_id), { recursive: true });
        } catch {
          // 目录不可建会在 createSession/ACL 检查中显式失败，不能在这里假装清理成功。
        }

        // 新模式下 publications 不能作为恢复成功入口。claimLeaseWithCleanupHold 已在
        // 同一事务拒绝已发布任务；若外部旧写路径仍插入 publication，本执行者只允许
        // 走安全失败，不产生 done(succeeded)，也绝不重跑发布。
        const existingPublication = this.store.getPublication(runId);
        if (existingPublication) {
          return await this.finishPublicationOnlyRejection(
            lease,
            cleanup,
            task.session_id,
            startedAt,
            tokens,
          );
        }

        if (lease.attempt > 1) {
          this.store.updateStage(lease, "repairing");
          const w = this.store.appendEvent(lease, "stage", { stage: "repairing", attempt: lease.attempt });
          if (w.fenced) return;
        }
        const historyPrefix = this.buildHistoryPrefix(
          task.session_id,
          runId,
          this.resultsDirOf(task.session_id),
        );

        let createFailure: Failure | null = null;
        try {
          session = await this.backend.createSession({
            sessionId: task.session_id,
            attempt: lease.attempt,
            runId,
            workroot: this.config.paths.workroot,
            resultsRoot: this.config.paths.resultsRoot,
            assetsDir: this.config.paths.assetsDir,
            runnerPath: this.config.paths.runnerPath,
            skillsDir: this.config.paths.skillsDir,
            db: resolveDbAccount(task.scope_group),
          });
        } catch (err) {
          const code = thrownCode(err);
          createFailure = {
            code: code === "CONFIG" ? "CONFIG" : "ENGINE_ERROR",
            message: `createSession failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
        if (session) earlyTerminationGuard = this.armEarlyTerminationOwnership(session);

        let failure: Failure | null = createFailure;
        let reportSignal: string | null = null;
        let cancelled = false;

        if (session && !createFailure) {
          const deadlineLeft = task.deadline != null ? task.deadline - Date.now() : undefined;
          const askOpts = {
            ...(historyPrefix !== undefined ? { historyPrefix } : {}),
            ...(deadlineLeft != null ? { timeoutMs: Math.max(deadlineLeft, 1_000) } : {}),
          };

          try {
            for await (const ev of session.ask(task.question, askOpts)) {
              if (ev.type === "report") {
                reportSignal = ev.path;
              } else {
                const w = this.store.appendEvent(lease, ev.type, eventPayload(ev));
                if (w.fenced) {
                  lostLease = true;
                  break;
                }
                if (ev.type === "error") failure = { code: ev.code, message: ev.message };
              }
              if (this.store.getTask(runId)?.cancel_requested === 1) {
                cancelled = true;
                break;
              }
            }
          } catch (err) {
            failure = {
              code: thrownCode(err),
              message: err instanceof Error ? err.message : String(err),
            };
          }

          if (typeof session.lastUsage === "function") {
            const u = session.lastUsage();
            if (u) {
              tokens = tokens ?? { input: 0, output: 0, cache_read: 0 };
              tokens.input += u.input;
              tokens.output += u.output;
              tokens.cache_read += u.cache_read;
            }
          }
        }

        // 失权者不得 beginCleanup/写任何终态，也不得用旧 cancel 向未经验证的进程组
        // 发信号。持有 hold 的 attempt 由 reaper/boot recovery 标 recovery_required；
        // 进程清理留给受 Runner 锁闸门保护的 Coordinator 路径，绝不在这里抢杀。
        if (lostLease) return;
        if (this.store.getTask(runId)?.cancel_requested === 1) cancelled = true;

        // 业务结果与清理结果分开：这里只决定业务终态候选，清理永远随后独立执行。
        let businessStatus: "succeeded" | "failed" | "cancelled";
        let terminalCode: string | null = null;
        let terminalMessage: string | null = null;
        let retryEligible = false;
        let cleanupTrigger: CleanupTrigger = "engine_error";
        let artifactPath: string | null = null;
        let publicationSource: string | null = null;
        let publicationDest: string | null = null;

        if (cancelled) {
          businessStatus = "cancelled";
          cleanupTrigger = "cancel";
        } else if (createFailure) {
          businessStatus = "failed";
          terminalCode = createFailure.code;
          terminalMessage = createFailure.message;
          cleanupTrigger = "engine_error";
        } else if (failure) {
          let code = failure.code;
          let message = failure.message;
          if (
            code === "ENGINE_ERROR" &&
            /Insufficient\s+Balance|("code"\s*:\s*"QUOTA")|status"?\s*[:=]\s*402/i.test(message)
          ) {
            code = "CONFIG";
            message = `计费/配额错误（快败不重试）: ${message}`;
          }
          cleanupTrigger = code === "TIMEOUT" ? "timeout" : "engine_error";

          if (code === "TIMEOUT" || code === "ENGINE_ERROR") {
            const t = this.store.getTask(runId)!;
            if (t.deadline != null && t.deadline < Date.now()) {
              terminalCode = code === "TIMEOUT" ? "TIMEOUT" : "UNRECOVERABLE";
              terminalMessage = `deadline 已过: ${message}`;
            } else if (lease.attempt >= this.maxAttempts) {
              terminalCode = "UNRECOVERABLE";
              terminalMessage = `attempt 达上限 ${this.maxAttempts}: ${message}`;
            } else if (t.cancel_requested === 1) {
              businessStatus = "cancelled";
              cleanupTrigger = "cancel";
            } else {
              businessStatus = "failed";
              terminalCode = code;
              terminalMessage = message;
              retryEligible = true;
            }
          } else {
            businessStatus = "failed";
            terminalCode = code;
            terminalMessage = message;
          }
        } else {
          // 成功路径：发布检查仍先做，但真正 copy + publication 行在清理通过后由
          // TaskStore 事务统一提交。
          artifactPath = this.locateArtifact(this.workdirOf(task.session_id), reportSignal);
          if (!artifactPath) {
            businessStatus = "succeeded";
            cleanupTrigger = "task_success";
          } else {
            const check = this.checkReport(artifactPath);
            if (!check.ok) {
              businessStatus = "failed";
              terminalCode = "REPORT_CHECK";
              terminalMessage = `报告发布检查失败: ${check.detail}`;
              cleanupTrigger = "engine_error";
            } else {
              businessStatus = "succeeded";
              cleanupTrigger = "task_success";
              publicationSource = artifactPath;
              publicationDest = join(this.config.paths.reportsRoot, task.user, `${runId}.html`);
            }
          }
        }

        if (businessStatus === undefined) {
          // TypeScript 控制流兜底；正常分支不可达，绝不静默写成功。
          businessStatus = "failed";
          terminalCode = "CLEANUP_INTERNAL";
          cleanupTrigger = "engine_error";
        }

        // 终止权移交前最后一次 fence 检查。beginCleanup 自身也在事务内复核。
        if (lostLease || !this.leaseHeld(lease)) return;

        const cleanupId = randomUUID();
        try {
          const begin = this.store.beginCleanup(lease, cleanupId);
          if (begin.fenced) return;
        } catch (err) {
          // hold 缺失/损坏/owner 不匹配：不能生成清理证据，也不能写终态，更不能向
          // 未经验证的进程组发送旧 cancel 信号。交给 reaper/boot recovery 标
          // recovery_required（fail-closed）。
          throw err;
        }

        if (lostLease || !this.leaseHeld(lease)) return;

        // 取消不在这里做旧 cancel/killTree：DSH 进程组可能仍含正在执行 Docker/ACL
        // rollback 的 Runner。取消交给 Coordinator：先取得终止权，若 prompt 仍活跃则
        // 只报 pending，绝不发信号；任务以 cancelled + cleanup recovery_required 落地。

        const handle = session?.cleanupHandle?.() ?? null;
        if (handle && !this.takeTerminationOwnership(handle)) {
          if (this.leaseHeld(lease)) {
            this.finalizeSealedReportFailure(
              lease,
              cleanupId,
              cleanupTrigger,
              businessStatus,
              "TERMINATION_OWNERSHIP_UNPROVEN",
              "cleanup termination ownership could not be proven",
              startedAt,
              lease.attempt > 1,
              tokens,
            );
          }
          return;
        }
        let result;
        try {
          result = await this.buildCleanupCoordinator({
            cleanup,
            lease,
            task,
            cleanupId,
            trigger: cleanupTrigger,
            dsh: handle,
          }).run();
        } catch {
          // Coordinator 内部异常不应产生“未发生清理却成功”的报告；这里只落 sealed=0。
          if (this.leaseHeld(lease)) {
            this.finalizeSealedReportFailure(
              lease,
              cleanupId,
              cleanupTrigger,
              businessStatus,
              "CLEANUP_INTERNAL",
              "cleanup coordinator failed before producing evidence",
              startedAt,
              lease.attempt > 1,
              tokens,
            );
          }
          return;
        }

        if (result.fenced || lostLease || !this.leaseHeld(lease)) return;

        if (!result.sealed || !result.report) {
          const fallbackCode =
            businessStatus === "failed" && terminalCode !== null
              ? terminalCode
              : normalizeCleanupFailureCode(result.failureCode);
          const message =
            businessStatus === "failed" && terminalMessage !== null
              ? `${terminalMessage}; cleanup unavailable (${result.failureCode ?? "CLEANUP_REPORT_UNAVAILABLE"})`
              : `cleanup report unavailable (${result.failureCode ?? "CLEANUP_REPORT_UNAVAILABLE"})`;
          this.finalizeSealedReportFailure(
            lease,
            cleanupId,
            cleanupTrigger,
            businessStatus,
            fallbackCode,
            message,
            startedAt,
            lease.attempt > 1,
            tokens,
          );
          return;
        }

        // 只有 sealed + overallOk 的 timeout/engine_error 清理报告可授权下一 attempt。
        // 清理本身可能跨过 deadline；必须在释放前重新判定，否则会落入“已授权但不可
        // 再 claim”的悬挂状态。清理期间到达的 cancel 同样优先落地为 cancelled。
        const postCleanupTask = this.store.getTask(runId);
        if (businessStatus === "failed" && retryEligible) {
          if (postCleanupTask?.cancel_requested === 1) {
            businessStatus = "cancelled";
            retryEligible = false;
            terminalCode = null;
            terminalMessage = null;
            cleanupTrigger = "cancel";
          } else if (postCleanupTask?.deadline != null && postCleanupTask.deadline < Date.now()) {
            retryEligible = false;
            terminalCode = terminalCode === "TIMEOUT" ? "TIMEOUT" : "UNRECOVERABLE";
            terminalMessage = `deadline 已过（cleanup 后复核）: ${terminalMessage ?? "infrastructure failure"}`;
          }
        }
        if (businessStatus === "failed" && retryEligible && result.overallOk) {
          const rel = this.store.releaseForRetryWithCleanup(lease, { report: result.report });
          if (rel.fenced) return;
          continue;
        }

        const recovery = lease.attempt > 1;
        const cleanupSummary = summarizeCleanup(result.report, result.failureCode);

        if (businessStatus === "succeeded") {
          if (!result.overallOk) {
            const message = `cleanup did not pass: ${cleanupSummary}`;
            const fin = this.store.finalizeWithCleanup(lease, {
              status: "failed",
              errorCode: "CLEANUP_INCOMPLETE",
              errorMessage: message,
              report: result.report,
              doneEvent: this.cleanupDone(runId, "failed", startedAt, recovery, tokens),
            });
            void fin;
            return;
          }

          let publication: { reportPath: string } | undefined;
          let publicationIdentity: { dev: string; ino: string } | null = null;
          if (publicationSource !== null && publicationDest !== null) {
            try {
              mkdirSync(dirname(publicationDest), { recursive: true });
              copyFileSync(publicationSource, publicationDest);
              const copied = statSync(publicationDest);
              publicationIdentity = { dev: String(copied.dev), ino: String(copied.ino) };
              publication = { reportPath: publicationDest };
            } catch (err) {
              // copyFileSync 可能已产生部分目标文件。只有没有任何 publication 时才清理，
              // 绝不动另一执行者已正式提交的路径。
              this.removeUnpublishedReport(runId, publicationDest);
              const message = `报告发布失败: ${err instanceof Error ? err.message : String(err)}`;
              this.store.finalizeWithCleanup(lease, {
                status: "failed",
                errorCode: "PUBLICATION_FAILED",
                errorMessage: message,
                report: result.report,
                doneEvent: this.cleanupDone(runId, "failed", startedAt, recovery, tokens),
              });
              return;
            }
          }

          try {
            const fin = this.store.finalizeWithCleanup(lease, {
              status: "succeeded",
              report: result.report,
              doneEvent: this.cleanupDone(runId, "succeeded", startedAt, recovery, tokens),
              ...(publication ? { publication } : {}),
            });
            if (fin.fenced) {
              // 事务未提交：我们复制的文件不能被留成“看似已发布”的孤儿。
              if (publicationDest !== null) {
                this.removeUnpublishedReport(runId, publicationDest, publicationIdentity);
              }
            }
            return;
          } catch (err) {
            // SQLite 终态事务失败：publication/report/done 已回滚；仅删除本次复制且
            // 仍无 publication 的同一 inode，防路径误删其他执行者文件。
            if (publicationDest !== null) {
              this.removeUnpublishedReport(runId, publicationDest, publicationIdentity);
            }
            throw err;
          }
        }

        // 业务失败/取消：清理成功时保持原业务状态与错误码；清理未通过时同样不得重试。
        // 取消没有业务错误码，但清理未通过必须留下可观察的 CLEANUP_INCOMPLETE，
        // 不能只把 recovery_required 藏在 cleanup_holds 里。
        const finalCode =
          terminalCode ?? (!result.overallOk ? "CLEANUP_INCOMPLETE" : null);
        const message =
          result.overallOk
            ? terminalMessage
            : `${terminalMessage ?? "task failed"}; cleanup did not pass: ${cleanupSummary}`;
        this.store.finalizeWithCleanup(lease, {
          status: businessStatus,
          ...(finalCode !== null ? { errorCode: finalCode } : {}),
          ...(message !== null ? { errorMessage: message } : {}),
          report: result.report,
          doneEvent: this.cleanupDone(runId, businessStatus, startedAt, recovery, tokens),
        });
        return;
      } finally {
        if (earlyTerminationGuard) clearInterval(earlyTerminationGuard);
        clearInterval(hb);
        // cleanup 模式绝不在 finally 使用旧 cancel：未移交终止权时无法证明 Runner
        // 状态，任何 SIGKILL 都可能撞上 Docker/ACL rollback。相关任务保留在
        // recovery_required，等待受控人工/后续恢复路径。
      }
    }
  }

  /**
   * 删除本次复制但未被 TaskStore publication 正式认可的报表文件。
   * - 已有 publication：绝不删除（可能是另一执行者/另一路径的正式结果）。
   * - 提供 inode 时必须仍匹配，防路径在失败窗口内被替换。
   * - 跨进程崩溃发生在 copy 与事务提交之间时无法在进程内清理，文件仍可能残留；
   *   正式发布的事实源是 publications 表，不是文件存在性。
   */
  private removeUnpublishedReport(
    runId: string,
    path: string,
    identity?: { dev: string; ino: string } | null,
  ): void {
    try {
      if (this.store.getPublication(runId)) return;
      if (identity) {
        const st = statSync(path);
        if (String(st.dev) !== identity.dev || String(st.ino) !== identity.ino) return;
      }
      unlinkSync(path);
    } catch {
      // 文件不存在/已被替换/无法删除：保留现场，任务仍不会因该文件被视为已发布。
    }
  }

  /**
   * spawn 身份一旦可验证就提前锁死 DSH 的旧终止权，使 DshSdkClient 的内部
   * prompt-timeout killTree 变成 no-op。物理终止仍必须等 Coordinator 在
   * beginCleanup 后通过 Runner flock / active-container 闸门执行。
   *
   * 不要求 identity 的早期标记会破坏 initialize 失败路径的自清理；因此这里只
   * 在 identity 非 null 且进程未退出时接管。identity 不可验证时保留原行为并让
   * Coordinator 报 pending。
   */
  private armEarlyTerminationOwnership(session: EngineSession): NodeJS.Timeout {
    const take = (): void => {
      try {
        const handle = session.cleanupHandle?.();
        if (!handle || !handle.identity || handle.hasExited) return;
        if (!handle.isTerminationOwned()) handle.markTerminationOwned();
      } catch {
        // 身份/句柄未就绪：下一 tick 再试；显式 handoff 仍会最终复核。
      }
    };
    take();
    const timer = setInterval(take, 20);
    timer.unref?.();
    return timer;
  }

  private takeTerminationOwnership(handle: DshCleanupHandle): boolean {
    try {
      handle.markTerminationOwned();
      return handle.isTerminationOwned() === true;
    } catch {
      return false;
    }
  }

  private leaseHeld(lease: Lease): boolean {
    try {
      const t = this.store.getTask(lease.run_id);
      return (
        t !== undefined &&
        t.status === "running" &&
        t.attempt === lease.attempt &&
        t.lease_owner === lease.lease_owner
      );
    } catch {
      return false;
    }
  }

  private cleanupDone(
    runId: string,
    status: "succeeded" | "failed" | "cancelled",
    startedAt: number,
    recovered: boolean,
    tokens: UsageTotal | null,
  ): {
    run_id: string;
    status: "succeeded" | "failed" | "cancelled";
    engine: string;
    elapsed_ms: number;
    tokens: UsageTotal | null;
    recovered: boolean;
  } {
    return {
      run_id: runId,
      status,
      engine: "dsh",
      elapsed_ms: Date.now() - startedAt,
      tokens,
      recovered,
    };
  }

  private buildCleanupCoordinator(input: {
    cleanup: TaskRunnerCleanupConfig;
    lease: Lease;
    task: import("../store/task-store.ts").TaskRow;
    cleanupId: string;
    trigger: CleanupTrigger;
    dsh: DshCleanupHandle | null;
  }): TaskCleanupCoordinator {
    const fence: CleanupFence = {
      heartbeat: () => !this.store.heartbeat(input.lease, this.ttl).fenced,
      check: () => this.leaseHeld(input.lease),
    };
    return new TaskCleanupCoordinator({
      runId: input.lease.run_id,
      attempt: input.lease.attempt,
      trigger: input.trigger,
      platform: "linux",
      cleanupId: input.cleanupId,
      paths: {
        workdir: this.workdirOf(input.task.session_id),
        resultsDir: this.resultsDirOf(input.task.session_id),
        assetsDir: this.config.paths.assetsDir,
        aclStateDir: input.cleanup.aclStateDir,
      },
      dsh: input.dsh,
      reaper: input.cleanup.reaper,
      audit: input.cleanup.audit,
      fence,
      timeBudgetMs: input.cleanup.timeBudgetMs,
      ...(input.cleanup.gracefulMs !== undefined ? { gracefulMs: input.cleanup.gracefulMs } : {}),
      ...(input.cleanup.killMs !== undefined ? { killMs: input.cleanup.killMs } : {}),
      ...(input.cleanup.runnerDrainMs !== undefined ? { runnerDrainMs: input.cleanup.runnerDrainMs } : {}),
      ...(input.cleanup.activeProbeIntervalMs !== undefined
        ? { activeProbeIntervalMs: input.cleanup.activeProbeIntervalMs }
        : {}),
    });
  }

  /**
   * publication 先于 cleanup 存在的异常现场：不覆盖、不重跑、不伪造成功。
   * 只生成 sealed=0 清理失败终态（或 cancelled），交由人工恢复。
   */
  private async finishPublicationOnlyRejection(
    lease: Lease,
    cleanup: TaskRunnerCleanupConfig,
    sessionId: string,
    startedAt: number,
    tokens: UsageTotal | null,
  ): Promise<void> {
    if (!this.leaseHeld(lease)) return;
    const cleanupId = randomUUID();
    const began = this.store.beginCleanup(lease, cleanupId);
    if (began.fenced) return;

    let result;
    try {
      result = await new TaskCleanupCoordinator({
        runId: lease.run_id,
        attempt: lease.attempt,
        trigger: "boot_recovery",
        platform: "linux",
        cleanupId,
        paths: {
          workdir: this.workdirOf(sessionId),
          resultsDir: this.resultsDirOf(sessionId),
          assetsDir: this.config.paths.assetsDir,
          aclStateDir: cleanup.aclStateDir,
        },
        dsh: null,
        reaper: cleanup.reaper,
        audit: cleanup.audit,
        fence: {
          heartbeat: () => !this.store.heartbeat(lease, this.ttl).fenced,
          check: () => this.leaseHeld(lease),
        },
        timeBudgetMs: cleanup.timeBudgetMs,
        ...(cleanup.gracefulMs !== undefined ? { gracefulMs: cleanup.gracefulMs } : {}),
        ...(cleanup.killMs !== undefined ? { killMs: cleanup.killMs } : {}),
        ...(cleanup.runnerDrainMs !== undefined ? { runnerDrainMs: cleanup.runnerDrainMs } : {}),
        ...(cleanup.activeProbeIntervalMs !== undefined
          ? { activeProbeIntervalMs: cleanup.activeProbeIntervalMs }
          : {}),
      }).run();
    } catch {
      if (this.leaseHeld(lease)) {
        this.finalizeSealedReportFailure(
          lease,
          cleanupId,
          "boot_recovery",
          "failed",
          "CLEANUP_PUBLICATION_RECOVERY_FORBIDDEN",
          "publication exists without a cleanup report; physical cleanup could not run",
          startedAt,
          lease.attempt > 1,
          tokens,
        );
      }
      return;
    }
    if (result.fenced || !this.leaseHeld(lease)) return;

    if (!result.sealed || !result.report) {
      this.finalizeSealedReportFailure(
        lease,
        cleanupId,
        "boot_recovery",
        "failed",
        "CLEANUP_PUBLICATION_RECOVERY_FORBIDDEN",
        `publication-only recovery forbidden; cleanup unavailable (${result.failureCode ?? "CLEANUP_REPORT_UNAVAILABLE"})`,
        startedAt,
        lease.attempt > 1,
        tokens,
      );
      return;
    }

    this.store.finalizeWithCleanup(lease, {
      status: "failed",
      errorCode: "CLEANUP_PUBLICATION_RECOVERY_FORBIDDEN",
      errorMessage: "publication exists without cleanup; publication-only recovery is forbidden",
      report: result.report,
      doneEvent: this.cleanupDone(lease.run_id, "failed", startedAt, lease.attempt > 1, tokens),
    });
  }

  private finalizeSealedReportFailure(
    lease: Lease,
    cleanupId: string,
    trigger: CleanupTrigger,
    businessStatus: "succeeded" | "failed" | "cancelled",
    errorCode: string,
    errorMessage: string,
    startedAt: number,
    recovered: boolean,
    tokens: UsageTotal | null,
  ): void {
    const status: "failed" | "cancelled" = businessStatus === "cancelled" ? "cancelled" : "failed";
    this.store.finalizeCleanupFailure(lease, {
      status,
      cleanupId,
      trigger,
      platform: "linux",
      errorCode: normalizeCleanupFailureCode(errorCode),
      errorMessage,
      doneEvent: this.cleanupDone(lease.run_id, status, startedAt, recovered, tokens),
    });
  }


  /** done 事件（词表六类之一）：仅在 legacy 路径使用；cleanup 模式由 TaskStore 事务生成。
   *  tokens = 本次 runOnce 的跨 attempt usage 累计（无 ask 的早退路径为 null）。 */
  private emitDone(lease: Lease, runId: string, status: "succeeded" | "failed" | "cancelled", startedAt: number, recovered: boolean, tokens: UsageTotal | null): void {
    this.store.appendEvent(lease, "done", {
      run_id: runId,
      status,
      engine: "dsh",
      elapsed_ms: Date.now() - startedAt,
      tokens,
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
