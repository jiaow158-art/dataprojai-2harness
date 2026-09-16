// M1-T7 单测：mock Backend（makeScript 按第 N 次 ask 演脚本）+ 真 TaskStore（内存库）。
// 用例逐行对齐附录 A.4 恢复矩阵（docs/superpowers/plans/2026-09-09-dsh-m1-service-gateway.md §A.4）。
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../store/task-store.ts";
import { TaskRunner, type TaskRunnerConfig } from "./task-runner.ts";
import { SdkPromptError } from "../backends/dsh-sdk-client.ts";
import type { BackendProvider, EngineSession, SessionOpts } from "../backends/dsh-backend.ts";
import type { NormEvent } from "../backends/dsh-events.ts";

let db: Database.Database;
let store: TaskStore;
let root: string;

beforeEach(() => {
  db = new Database(":memory:");
  store = new TaskStore(db);
  root = mkdtempSync(join(tmpdir(), "task-runner-test-"));
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

// ── 脚本化 mock：第 N 次 ask 按第 N 个 ScriptStep 演 ──────────────────────────────
type EvItem = NormEvent | { ev: NormEvent; before?: () => void; after?: () => void; delayMs?: number };
interface ScriptStep {
  events?: EvItem[];
  throw?: Error;
  before?: () => void;
}

interface AskRecord {
  sessionId: string;
  question: string;
  historyPrefix?: string;
  attempt: number;
}

interface MockBackend extends BackendProvider {
  asks: AskRecord[];
  sessions: MockSession[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeBackend(script: ScriptStep[]): MockBackend {
  const asks: AskRecord[] = [];
  const sessions: MockSession[] = [];
  let stepIdx = 0;

  class MockSession implements EngineSession {
    cancelCount = 0;
    cancelled = false;
    opts: SessionOpts;
    constructor(opts: SessionOpts) {
      this.opts = opts;
      sessions.push(this);
    }
    async *ask(question: string, o?: { historyPrefix?: string; timeoutMs?: number }): AsyncGenerator<NormEvent> {
      asks.push({ sessionId: this.opts.sessionId, question, historyPrefix: o?.historyPrefix, attempt: this.opts.attempt ?? 0 });
      const step = script[stepIdx++];
      step?.before?.();
      for (const item of step?.events ?? []) {
        const it = item as { ev?: NormEvent; before?: () => void; after?: () => void; delayMs?: number };
        if (it && it.ev) {
          it.before?.();
          if (it.delayMs) await sleep(it.delayMs);
          yield it.ev;
          it.after?.();
        } else {
          yield item as NormEvent;
        }
        if (this.cancelled) return; // cancel 后流终止（真实 backend：killTree → prompt 拒 → 流结束）
        await new Promise((r) => setImmediate(r));
      }
      // 事件演完再抛（真实形态：流中事件先到，prompt 终态拒绝在后）
      if (step?.throw) throw step.throw;
    }
    async cancel(): Promise<void> {
      this.cancelCount++;
      this.cancelled = true;
    }
  }

  return {
    id: "mock",
    asks,
    sessions,
    // 镜像真实 DshBackend：建 workdir/results 目录（供产物扫描与发布断言）
    async createSession(opts: SessionOpts): Promise<EngineSession> {
      mkdirSync(join(opts.workroot, opts.sessionId, "workdir"), { recursive: true });
      mkdirSync(join(opts.resultsRoot, opts.sessionId, "results"), { recursive: true });
      return new MockSession(opts);
    },
  } as MockBackend;
}

// ── 公共脚手架 ────────────────────────────────────────────────────────────────────
const PATHS = () => ({
  workroot: join(root, "work"),
  resultsRoot: join(root, "results"),
  assetsDir: join(root, "assets"),
  runnerPath: join(root, "runner.sh"),
  skillsDir: join(root, "skills"),
  reportsRoot: join(root, "published"),
});

function makeRunner(backend: BackendProvider, overrides: Partial<TaskRunnerConfig> = {}): TaskRunner {
  return new TaskRunner(store, backend, {
    workerId: "w1",
    taskBudgetS: 3600,
    heartbeatIntervalMs: 3_600_000, // 缺省不触发心跳（专项用例自行调小）
    leaseTtlMs: 90_000,
    reportCheck: { minBytes: 100 },
    paths: PATHS(),
    ...overrides,
  });
}

function newTask(sessionId = "s1", question = "查一下库存") {
  return store.createTask({ session_id: sessionId, user: "tester", question }).run_id;
}

function workdirOf(sessionId = "s1"): string {
  return join(root, "work", sessionId, "workdir");
}

function eventTypes(runId: string): string[] {
  return store.listEvents(runId, 0).map((e) => e.type);
}

function eventPayloads(runId: string, type: string): any[] {
  return store
    .listEvents(runId, 0)
    .filter((e) => e.type === type)
    .map((e) => e.payload);
}

function expireLease(runId: string) {
  db.prepare("UPDATE tasks SET lease_expires_at=? WHERE run_id=?").run(Date.now() - 1, runId);
}

const evStage: NormEvent = { type: "stage", stage: "analyzing", text: "t" };
const evSql = (ref: string | null): NormEvent => ({ type: "sql", sql: "SELECT 1", rows: 1, truncated: false, result_ref: ref, elapsed_ms: 5 });
const evAnswer: NormEvent = { type: "answer", markdown: "# 结论" };

// ── 1. 正常完成流（纯问答，无产物） ───────────────────────────────────────────────
test("正常完成流：事件全落库 + done succeeded + 无产物跳过发布 + session.cancel 被调", async () => {
  const runId = newTask();
  const backend = makeBackend([{ events: [evStage, evSql(null), evAnswer] }]);
  await makeRunner(backend).runOnce(runId);

  const task = store.getTask(runId)!;
  assert.equal(task.status, "succeeded");
  assert.equal(task.error_code, null);
  assert.equal(task.attempt, 1);

  assert.deepEqual(eventTypes(runId), ["stage", "stage", "sql", "answer", "done"]); // seq1=claim 内部事件
  const done = eventPayloads(runId, "done")[0];
  assert.equal(done.status, "succeeded");
  assert.equal(done.engine, "dsh");
  assert.equal(done.recovered, false);
  assert.equal(done.run_id, runId);
  assert.equal(typeof done.elapsed_ms, "number");
  assert.deepEqual(eventPayloads(runId, "sql")[0], { sql: "SELECT 1", rows: 1, truncated: false, result_ref: null, elapsed_ms: 5 });

  assert.equal(store.getPublication(runId), undefined); // 纯问答不发布
  assert.ok(backend.sessions[0]!.cancelCount >= 1); // T5 Minor-6：finally cancel 即回收
});

// ── 2. 报告任务：发布顺序 report 事件在 publication 之后 + 二跑不重发 ─────────────
test("报告任务：产物发布 recordPublication → report 事件 → done；二跑幂等不重发", async () => {
  const runId = newTask();
  const html = '<html><head><script src="./echarts.min.js"></script></head><body>' + "x".repeat(300) + "</body></html>";
  mkdirSync(join(workdirOf(), "reports"), { recursive: true });
  writeFileSync(join(workdirOf(), "reports", "r.html"), html);

  const backend = makeBackend([
    { events: [{ type: "stage", stage: "report_checking" }, { type: "report", path: "reports/r.html" }, evAnswer] as NormEvent[] },
  ]);
  await makeRunner(backend).runOnce(runId);

  const task = store.getTask(runId)!;
  assert.equal(task.status, "succeeded");
  const pub = store.getPublication(runId)!;
  const expectedDest = join(root, "published", "tester", `${runId}.html`);
  assert.equal(pub.report_path, expectedDest);
  assert.equal(readFileSync(expectedDest, "utf8"), html); // 产物确实拷贝

  const events = store.listEvents(runId, 0);
  const reportIdx = events.findIndex((e) => e.type === "report");
  const doneIdx = events.findIndex((e) => e.type === "done");
  assert.ok(reportIdx > 0 && doneIdx > reportIdx, "report 事件在 done 之前（publication 先于两者——A.3）");
  assert.deepEqual(events[reportIdx]!.payload, { path: expectedDest });
  assert.ok(events.some((e) => e.type === "stage" && (e.payload as any).stage === "publishing"));

  // 二跑：任务已终态 → claim 拒 → 零 ask、零新事件（发布幂等）
  const before = store.listEvents(runId, 0).length;
  await makeRunner(backend).runOnce(runId);
  assert.equal(store.listEvents(runId, 0).length, before);
  assert.equal(backend.asks.length, 1);
});

// ── 3. A.4 行1：dsh 死亡续跑 ──────────────────────────────────────────────────────
test("行1 dsh 死亡续跑：ask#1 出结果后抛 ENGINE_ERROR → attempt=2 注入 result_ref 清单续跑", async () => {
  const runId = newTask();
  const backend = makeBackend([
    { events: [evSql("r-ref-1")], throw: new SdkPromptError("ENGINE_ERROR", "dsh process exited") },
    { events: [evAnswer] },
  ]);
  await makeRunner(backend).runOnce(runId);

  const task = store.getTask(runId)!;
  assert.equal(task.status, "succeeded");
  assert.equal(task.attempt, 2);
  const done = eventPayloads(runId, "done")[0];
  assert.equal(done.status, "succeeded");
  assert.equal(done.recovered, true);

  assert.equal(backend.asks.length, 2);
  assert.equal(backend.asks[0]!.historyPrefix, undefined); // 首跑不注入
  const prefix = backend.asks[1]!.historyPrefix!;
  assert.ok(prefix.includes("r-ref-1"), "前缀含本任务已产 result_ref 清单");
  assert.ok(prefix.includes("不要重新查询"), "前缀含读文件续算指示语");
  assert.equal(backend.sessions[1]!.opts.attempt, 2);

  // attempt1 的 sql 事件保留（事件表即保存点）；repairing 阶段由本层产（T5 移交）
  assert.equal(eventPayloads(runId, "sql").length, 1);
  const repairing = eventPayloads(runId, "stage").find((p: any) => p.stage === "repairing");
  assert.deepEqual(repairing, { stage: "repairing", attempt: 2 });
});

// ── 4. A.4 行1 上限臂：attempt 达 MAX → failed/UNRECOVERABLE ─────────────────────
test("attempt 上限：脚本全抛 ENGINE_ERROR → failed/UNRECOVERABLE，attempt=maxAttempts", async () => {
  const runId = newTask();
  const backend = makeBackend([
    { throw: new SdkPromptError("ENGINE_ERROR", "died 1") },
    { throw: new SdkPromptError("ENGINE_ERROR", "died 2") },
  ]);
  await makeRunner(backend, { maxAttempts: 2 }).runOnce(runId);

  const task = store.getTask(runId)!;
  assert.equal(task.status, "failed");
  assert.equal(task.error_code, "UNRECOVERABLE");
  assert.equal(task.attempt, 2);
  assert.equal(backend.asks.length, 2); // 每限一次：第2次失败即终态，不再续
  const done = eventPayloads(runId, "done")[0];
  assert.equal(done.status, "failed");
  assert.equal(done.recovered, true);
});

// ── 5. A.4 deadline：超预算 → failed/TIMEOUT 不重试 ──────────────────────────────
test("deadline 超预算：ask 抛 TIMEOUT 且 deadline 已过 → failed/TIMEOUT 不重试", async () => {
  const runId = newTask();
  const backend = makeBackend([
    {
      before: () => {
        // 首次 claim 已固化 deadline（created_at+budgetS）；模拟跨 attempt 消耗后超预算
        db.prepare("UPDATE tasks SET deadline=? WHERE run_id=?").run(Date.now() - 1000, runId);
      },
      throw: new SdkPromptError("TIMEOUT", "prompt timeout exceeded"),
    },
  ]);
  await makeRunner(backend, { maxAttempts: 3 }).runOnce(runId);

  const task = store.getTask(runId)!;
  assert.equal(task.status, "failed");
  assert.equal(task.error_code, "TIMEOUT");
  assert.equal(task.attempt, 1); // deadline 判定先于 attempt 判定——零续跑
  assert.equal(backend.asks.length, 1);
});

// ── 6. A.4 行6：凭据/配置 → failed/CONFIG 零重试零 attempt 消耗 ──────────────────
test("CONFIG 快败：抛 CONFIG → failed/CONFIG，attempt 停在 1", async () => {
  const runId = newTask();
  const backend = makeBackend([{ throw: new SdkPromptError("CONFIG", "DEEPSEEK_API_KEY not set") }]);
  await makeRunner(backend, { maxAttempts: 3 }).runOnce(runId);

  const task = store.getTask(runId)!;
  assert.equal(task.status, "failed");
  assert.equal(task.error_code, "CONFIG");
  assert.equal(task.attempt, 1);
  assert.equal(backend.asks.length, 1);
  const done = eventPayloads(runId, "done")[0];
  assert.equal(done.status, "failed");
});

// ── 7. A.4 行4：发布后崩溃恢复——publications 已写 → 直接 succeeded 不重跑 ────────
test("已发布恢复：预置 recordPublication → runOnce 直接 succeeded 不调 ask", async () => {
  const runId = newTask();
  store.recordPublication(runId, "reports/x/a.html");
  const backend = makeBackend([]);
  await makeRunner(backend).runOnce(runId);

  const task = store.getTask(runId)!;
  assert.equal(task.status, "succeeded");
  assert.equal(backend.asks.length, 0); // 不重跑
  assert.equal(backend.sessions.length, 0); // 连引擎会话都不开
  const done = eventPayloads(runId, "done")[0];
  assert.equal(done.status, "succeeded");
  assert.equal(store.getPublication(runId)!.report_path, "reports/x/a.html"); // 不覆盖既有发布
});

// ── 8. A.4 行5：cancel 在事件边界落地 cancelled ──────────────────────────────────
test("cancel 落地：事件流中途 requestCancel → cancelled 终态 + done status=cancelled", async () => {
  const runId = newTask();
  const backend = makeBackend([
    {
      events: [
        evStage,
        { ev: evSql("r-ref-9"), before: () => store.requestCancel(runId) },
        evAnswer, // 不得被消费
      ],
    },
  ]);
  await makeRunner(backend).runOnce(runId);

  const task = store.getTask(runId)!;
  assert.equal(task.status, "cancelled");
  assert.equal(task.attempt, 1);
  assert.deepEqual(eventTypes(runId), ["stage", "stage", "sql", "done"]); // answer 未落库
  const done = eventPayloads(runId, "done")[0];
  assert.equal(done.status, "cancelled");
  assert.ok(backend.sessions[0]!.cancelCount >= 1, "session.cancel 被调（cancel 不产 error——编排器靠标志）");
  assert.equal(eventPayloads(runId, "error").length, 0);
});

// ── 9. A.4 行3：worker 停滞被接管——旧执行者围栏拒 → kill 自身退出不 finalize ─────
test("围栏失权：事件流中途租约被 workerB 夺走 → appendEvent fenced → session.cancel + 不 finalize", async () => {
  const runId = newTask();
  const backend = makeBackend([
    {
      events: [
        evStage,
        {
          ev: evSql("r-ref-2"),
          before: () => {
            expireLease(runId);
            const b = store.claimLease(runId, "workerB", 90_000, 3600);
            assert.ok(b, "workerB 接管应成功");
            assert.equal(b.attempt, 2);
          },
        },
      ],
    },
  ]);
  await makeRunner(backend).runOnce(runId);

  const task = store.getTask(runId)!;
  assert.equal(task.status, "running"); // 旧执行者无权终态——workerB 负责
  assert.equal(task.lease_owner, "workerB");
  assert.ok(backend.sessions[0]!.cancelCount >= 1, "旧执行者 kill 自身引擎进程树（A.1 L1）");
  assert.ok(!eventTypes(runId).includes("done"), "失权者不写 done 事件");
  assert.ok(!eventTypes(runId).includes("sql"), "失权者的 sql 事件未入库");
});

// ── 10. 发布检查失败：空产物 → failed 消息含检查详情 ──────────────────────────────
test("发布检查失败：html 为空文件 → failed/REPORT_CHECK 且消息含 minBytes 详情", async () => {
  const runId = newTask();
  mkdirSync(join(workdirOf(), "reports"), { recursive: true });
  writeFileSync(join(workdirOf(), "reports", "empty.html"), "");

  const backend = makeBackend([{ events: [{ type: "report", path: "reports/empty.html" }, evAnswer] as NormEvent[] }]);
  await makeRunner(backend).runOnce(runId);

  const task = store.getTask(runId)!;
  assert.equal(task.status, "failed");
  assert.equal(task.error_code, "REPORT_CHECK");
  assert.ok(task.error_message!.includes("minBytes 100"), `消息含检查详情: ${task.error_message}`);
  assert.equal(store.getPublication(runId), undefined); // 检查不过不发布
  const done = eventPayloads(runId, "done")[0];
  assert.equal(done.status, "failed");
});

// ── 11. 发布检查：外链 CDN 拒发（本地 echarts 白名单天然放行，见用例2） ───────────
test("发布检查：外链 CDN 引用 → failed/REPORT_CHECK 消息含 CDN 详情", async () => {
  const runId = newTask();
  const html = '<html><head><script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script></head><body>' + "y".repeat(300) + "</body></html>";
  mkdirSync(join(workdirOf(), "reports"), { recursive: true });
  writeFileSync(join(workdirOf(), "reports", "cdn.html"), html);

  const backend = makeBackend([{ events: [{ type: "report", path: "reports/cdn.html" }] as NormEvent[] }]);
  await makeRunner(backend).runOnce(runId);

  const task = store.getTask(runId)!;
  assert.equal(task.status, "failed");
  assert.equal(task.error_code, "REPORT_CHECK");
  assert.ok(task.error_message!.includes("CDN"), `消息含 CDN 详情: ${task.error_message}`);
});

// ── 12. 产物定位兜底：report 信号路径不存在 → 扫描 workdir *.html（T5 Minor） ─────
test("产物定位兜底：信号路径落空 → 扫描 workdir 找到 html 并发布", async () => {
  const runId = newTask();
  mkdirSync(workdirOf(), { recursive: true });
  writeFileSync(join(workdirOf(), "out.html"), "<html><body>" + "z".repeat(300) + "</body></html>");

  // 信号指向不存在的 reports/ghost.html——扫描兜底必须找到 out.html
  const backend = makeBackend([{ events: [{ type: "report", path: "reports/ghost.html" }] as NormEvent[] }]);
  await makeRunner(backend).runOnce(runId);

  const task = store.getTask(runId)!;
  assert.equal(task.status, "succeeded");
  assert.equal(store.getPublication(runId)!.report_path, join(root, "published", "tester", `${runId}.html`));
});

// ── 13. 心跳续租：事件间空隙由 interval 续租，租约不过期（L2） ────────────────────
test("心跳：事件间空隙 interval 续租，lease_expires_at 被推后且不触发失权", async () => {
  const runId = newTask();
  let expiryAtAskStart = 0;
  let expiryAfterGap = 0;
  const backend = makeBackend([
    {
      events: [
        evStage,
        {
          ev: evAnswer,
          delayMs: 150, // 事件间空隙 > 多个心跳间隔
          after: () => {
            expiryAfterGap = store.getTask(runId)!.lease_expires_at!;
          },
        },
      ],
      before: () => {
        expiryAtAskStart = store.getTask(runId)!.lease_expires_at!;
      },
    },
  ]);
  await makeRunner(backend, { heartbeatIntervalMs: 10, leaseTtlMs: 1000 }).runOnce(runId);

  assert.equal(store.getTask(runId)!.status, "succeeded");
  assert.ok(expiryAfterGap > expiryAtAskStart, `心跳推后租约: ${expiryAtAskStart} -> ${expiryAfterGap}`);
});

// ── 14. 统一失败分类器（T7 裁决）：流内 error 事件与 ask() 抛出同路进 A.4 续跑臂 ───
// 真实 DshBackend.ask() 从不抛（dsh-backend.ts :193/:217——spawn/prompt 失败一律转
// 流内 error 事件收流）；与用例3（抛出表面）对偶：同一矩阵行、两种失败表面。
test("流内 ENGINE_ERROR 收流（真实 backend 表面）：attempt=2 续跑注入历史 + done recovered=true", async () => {
  const runId = newTask();
  const backend = makeBackend([
    { events: [evSql("r-ref-3"), { type: "error", code: "ENGINE_ERROR", message: "turn/end reason: error" }] as NormEvent[] },
    { events: [evAnswer] },
  ]);
  await makeRunner(backend).runOnce(runId);

  const task = store.getTask(runId)!;
  assert.equal(task.status, "succeeded");
  assert.equal(task.attempt, 2); // 流内 ENGINE_ERROR 同进续跑臂
  assert.equal(backend.asks.length, 2);
  const prefix = backend.asks[1]!.historyPrefix!;
  assert.ok(prefix.includes("r-ref-3"), "续跑注入本任务已产 result_ref 清单");
  assert.ok(prefix.includes("不要重新查询"));
  const done = eventPayloads(runId, "done")[0];
  assert.equal(done.status, "succeeded");
  assert.equal(done.recovered, true);
  // attempt1 的流内 error 事件本身已入库（spec 词表：error 事件原样入库）
  const errs = eventPayloads(runId, "error");
  assert.equal(errs.length, 1);
  assert.equal(errs[0].code, "ENGINE_ERROR");
});

test("流内 CONFIG 收流（backend :193 spawn 失败表面）：零重试快败，attempt 停在 1", async () => {
  const runId = newTask();
  const backend = makeBackend([
    { events: [{ type: "error", code: "CONFIG", message: "dsh spawn/initialize failed" }] as NormEvent[] },
  ]);
  await makeRunner(backend, { maxAttempts: 3 }).runOnce(runId);

  const task = store.getTask(runId)!;
  assert.equal(task.status, "failed");
  assert.equal(task.error_code, "CONFIG");
  assert.equal(task.attempt, 1); // 行6：凭据/配置零 attempt 消耗
  assert.equal(backend.asks.length, 1);
  const done = eventPayloads(runId, "done")[0];
  assert.equal(done.status, "failed");
});

// ── T7 审查 Minor-1：historyPrefix 状态过滤——仅终态任务进历史，在途任务不误标失败 ──
test("historyPrefix 状态过滤：queued/running 在途任务跳过，不渲染为失败", async () => {
  // 同会话四任务：cancelled → succeeded → queued（在途）→ 本任务（续跑恢复）
  const cId = newTask("s-hist", "被取消的问题");
  store.finalize(store.claimLease(cId, "w0", 90_000, 3600)!, "cancelled");
  const okId = newTask("s-hist", "已成功的问题");
  const okLease = store.claimLease(okId, "w0", 90_000, 3600)!;
  store.appendEvent(okLease, "sql", { sql: "SELECT 1", rows: 1, truncated: false, result_ref: "r-hist-1", elapsed_ms: 1 });
  store.appendEvent(okLease, "answer", { markdown: "结论 A" });
  store.finalize(okLease, "succeeded");
  newTask("s-hist", "排队中的问题"); // queued 在途——不得进历史
  const retryId = newTask("s-hist", "待续跑的问题");
  const l = store.claimLease(retryId, "w0", 90_000, 3600)!;
  store.releaseForRetry(l); // running + 无租约：模拟基础设施故障后的续跑窗口（attempt 已 =1）

  const backend = makeBackend([{ events: [evAnswer] }]);
  await makeRunner(backend).runOnce(retryId); // 续跑 claim → attempt=2 → 注入 historyPrefix

  assert.equal(store.getTask(retryId)!.attempt, 2);
  const prefix = backend.asks[0]!.historyPrefix!;
  assert.ok(prefix.includes("[cancelled] 问题：被取消的问题"), "终态取消任务进历史");
  assert.ok(prefix.includes("已取消，结果不可信"));
  assert.ok(prefix.includes("[succeeded] 问题：已成功的问题"), "终态成功任务进历史");
  assert.ok(prefix.includes("r-hist-1"), "成功任务的 result_ref 进历史");
  assert.ok(!prefix.includes("排队中的问题"), "queued 在途任务跳过——不误渲染为失败（Minor-1）");
  assert.ok(!prefix.includes("失败，结果不可信"), "无误标的失败渲染");
});

// ── soak 发现2修复：同会话正常续问（attempt=1）也注入历史（spec D14）──────────────
test("D14 续问注入：同会话任务2 首跑（attempt=1）注入前人历史；会话首问仍裸 prompt", async () => {
  // 任务1：独立会话首问 → 无前缀
  const firstId = newTask("s-cont", "第一问");
  const b1 = makeBackend([{ events: [evAnswer] }]);
  await makeRunner(b1).runOnce(firstId);
  assert.equal(b1.asks[0]!.historyPrefix, undefined, "会话首问无历史 → 裸 prompt");

  // 任务2：同会话续问，attempt=1（正常路径非恢复）→ 必须注入任务1历史
  const secondId = newTask("s-cont", "增加去年同期对比");
  const b2 = makeBackend([{ events: [evAnswer] }]);
  await makeRunner(b2).runOnce(secondId);
  assert.equal(store.getTask(secondId)!.attempt, 1, "正常续问不占 attempt");
  const prefix = b2.asks[0]!.historyPrefix!;
  assert.ok(prefix.includes("第一问"), "续问前缀含任务1问题");
  assert.ok(prefix.includes("结论"), "续问前缀含任务1回答摘要");
  assert.ok(!prefix.includes("repairing"), "attempt=1 不产 repairing 阶段");
  const stages = eventPayloads(secondId, "stage").map((p: any) => p.stage);
  assert.ok(!stages.includes("repairing"), "repairing 事件仍仅限 attempt>1");
});

// ── soak 发现1修复：计费类错误（402 QUOTA）快败零重试（行6 语义）──────────────────
test("QUOTA 快败：流内 error 含 Insufficient Balance → failed/CONFIG 零重试", async () => {
  const runId = newTask();
  const quotaEv: NormEvent = {
    type: "error", code: "ENGINE_ERROR",
    message: 'turn/end reason: {"kind":"error","error":{"message":"Insufficient Balance","code":"QUOTA","status":402}}',
  };
  const backend = makeBackend([{ events: [quotaEv] }]);
  await makeRunner(backend).runOnce(runId);

  const task = store.getTask(runId)!;
  assert.equal(task.status, "failed");
  assert.equal(task.error_code, "CONFIG", "计费错误归 CONFIG（非 UNRECOVERABLE）");
  assert.equal(task.attempt, 1, "零重试——不烧第二次引擎 turn");
  assert.equal(backend.asks.length, 1);
  assert.ok(task.error_message!.includes("计费/配额错误"), "错误消息明确计费语义");
});
