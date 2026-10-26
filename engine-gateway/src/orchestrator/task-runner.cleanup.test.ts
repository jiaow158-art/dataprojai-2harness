// S4-B2-C2-B2-2B-2：TaskRunner cleanup 生命周期测试。
// 使用真实 TaskStore + 真实 TaskCleanupCoordinator + 真实 CleanupAuditLog/ACL 检查；
// Docker reaper 使用显式故障/无容器替身，真实 Docker + 真实 detached DSH child 的端到端
// 用例在 task-runner.linux-cleanup.test.ts。全程不调用模型/DWS/正式服务。
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../store/task-store.ts";
import { TaskRunner, type TaskRunnerCleanupConfig, type TaskRunnerPaths } from "./task-runner.ts";
import type { BackendProvider, EngineSession, SessionOpts } from "../backends/dsh-backend.ts";
import type { DshCleanupHandle } from "../backends/dsh-sdk-client.ts";
import type { NormEvent } from "../backends/dsh-events.ts";
import type {
  SandboxActiveProbeResult,
  SandboxCleanupResult,
} from "./sandbox-container-reaper.ts";
import { CleanupAuditLog } from "./cleanup-audit.ts";
import { WorkerPool } from "../server/worker-pool.ts";

interface Harness {
  db: Database.Database;
  store: TaskStore;
  root: string;
  paths: TaskRunnerPaths;
  cleanup: TaskRunnerCleanupConfig;
  auditLog: CleanupAuditLog;
  reaperCalls: { probe: number; cleanup: number };
  setProbe(result: SandboxActiveProbeResult): void;
  setCleanup(result: SandboxCleanupResult): void;
}

const okProbe = (): SandboxActiveProbeResult => ({ ok: true, active: 0, mismatches: 0, containers: [] });
const busyProbe = ((): SandboxActiveProbeResult => ({
  ok: true,
  active: 1,
  mismatches: 0,
  containers: [],
})) as () => SandboxActiveProbeResult;
const okCleanup = (runId: string, attempt: number): SandboxCleanupResult => ({
  ok: true,
  busy: false,
  runId,
  attempt,
  found: 0,
  cleaned: [],
  stopped: [],
  forced: [],
  mismatches: [],
  warnings: [],
  errors: [],
  containers: [],
});

async function makeHarness(t: TestContext, opts: { auditFails?: boolean } = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "c2b22b2-runner-"));
  chmodSync(root, 0o700);
  const auditDir = join(root, "audit");
  const aclDir = join(root, "acl-state");
  mkdirSync(auditDir, { mode: 0o700 });
  mkdirSync(aclDir, { mode: 0o700 });
  const paths: TaskRunnerPaths = {
    workroot: join(root, "work"),
    resultsRoot: join(root, "results"),
    assetsDir: join(root, "assets"),
    runnerPath: join(root, "runner.sh"),
    skillsDir: join(root, "skills"),
    reportsRoot: join(root, "published"),
  };
  mkdirSync(paths.assetsDir, { recursive: true });
  const auditLog = await CleanupAuditLog.open({
    trustedRuntimeRoot: root,
    auditLogPath: join(auditDir, "cleanup-audit.jsonl"),
    ...(opts.auditFails
      ? { syncFile: async () => { throw new Error("injected fsync failure"); } }
      : {}),
  });
  t.after(async () => {
    await auditLog.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  });
  const db = new Database(":memory:");
  const store = new TaskStore(db, Date.now, { cleanupHoldMode: true });
  t.after(() => db.close());

  let probe = okProbe();
  let cleanupResult: SandboxCleanupResult | null = null;
  const reaperCalls = { probe: 0, cleanup: 0 };
  const reaper = {
    probeActive: async (): Promise<SandboxActiveProbeResult> => {
      reaperCalls.probe += 1;
      return probe;
    },
    cleanup: async (target: { runId: string; attempt: number }): Promise<SandboxCleanupResult> => {
      reaperCalls.cleanup += 1;
      return cleanupResult ?? okCleanup(target.runId, target.attempt);
    },
  };
  const cleanup: TaskRunnerCleanupConfig = {
    platform: "linux",
    aclStateDir: aclDir,
    timeBudgetMs: 5_000,
    reaper,
    audit: auditLog,
    gracefulMs: 100,
    killMs: 1_000,
    runnerDrainMs: 30,
    activeProbeIntervalMs: 5,
  };
  return {
    db,
    store,
    root,
    paths,
    cleanup,
    auditLog,
    reaperCalls,
    setProbe: (r) => { probe = r; },
    setCleanup: (r) => { cleanupResult = r; },
  };
}

interface ScriptStep {
  events?: (NormEvent | { ev: NormEvent; before?: () => void })[];
  throw?: Error;
  handle?: () => DshCleanupHandle | null;
}

interface MockSession extends EngineSession {
  cancelCount: number;
}

function makeBackend(h: Harness, script: ScriptStep[]): {
  backend: BackendProvider;
  asks: number;
  sessions: MockSession[];
} {
  let index = 0;
  const sessions: MockSession[] = [];
  const result = { asks: 0, sessions };
  const backend: BackendProvider = {
    id: "mock-cleanup",
    async createSession(opts: SessionOpts): Promise<EngineSession> {
      mkdirSync(join(opts.workroot, opts.sessionId, "workdir"), { recursive: true });
      mkdirSync(join(opts.resultsRoot, opts.sessionId, "results"), { recursive: true });
      const step = script[index] ?? script[script.length - 1] ?? {};
      const session: MockSession = {
        cancelCount: 0,
        async *ask(): AsyncGenerator<NormEvent> {
          result.asks += 1;
          for (const item of step.events ?? []) {
            if ("ev" in item) {
              item.before?.();
              yield item.ev;
            } else {
              yield item;
            }
            await new Promise((r) => setImmediate(r));
          }
          if (step.throw) throw step.throw;
        },
        async cancel(): Promise<void> {
          session.cancelCount += 1;
        },
        cleanupHandle: () => (step.handle ? step.handle() : null),
        lastUsage: () => null,
      };
      sessions.push(session);
      index += 1;
      return session;
    },
  };
  return { backend, get asks() { return result.asks; }, sessions };
}

function makeRunner(h: Harness, backend: BackendProvider): TaskRunner {
  return new TaskRunner(h.store, backend, {
    workerId: "cleanup-worker",
    taskBudgetS: 3600,
    maxAttempts: 3,
    heartbeatIntervalMs: 10_000,
    leaseTtlMs: 90_000,
    reportCheck: { minBytes: 10 },
    paths: h.paths,
    cleanup: h.cleanup,
  });
}

function newTask(h: Harness): string {
  return h.store.createTask({ session_id: "s1", user: "tester", question: "cleanup lifecycle" }).run_id;
}

function types(h: Harness, runId: string): string[] {
  return h.store.listEvents(runId, 0).map((e) => e.type);
}

function payloads(h: Harness, runId: string, type: string): any[] {
  return h.store.listEvents(runId, 0).filter((e) => e.type === type).map((e) => e.payload);
}

function count(h: Harness, sql: string, ...args: unknown[]): number {
  return (h.db.prepare(sql).get(...args) as { n: number }).n;
}

const stage: NormEvent = { type: "stage", stage: "analyzing", text: "t" };
const answer: NormEvent = { type: "answer", markdown: "done" };

test("成功 → cleanup → 原子 succeeded；done/cleanup_reports 同事务落库，hold closed", async (t) => {
  const h = await makeHarness(t);
  const runId = newTask(h);
  const backend = makeBackend(h, [{ events: [stage, answer] }]);
  await makeRunner(h, backend.backend).runOnce(runId);

  const task = h.store.getTask(runId)!;
  assert.equal(task.status, "succeeded");
  assert.equal(task.error_code, null);
  assert.deepEqual(types(h, runId), ["stage", "stage", "answer", "done"]);
  assert.equal(payloads(h, runId, "done")[0].status, "succeeded");
  assert.equal(h.store.getPublication(runId), undefined);

  const row = h.store.getCleanupReport(runId, 1)!;
  assert.equal(row.sealed, true);
  assert.equal(row.overall_ok, true);
  assert.equal(row.report!.trigger, "task_success");
  assert.equal(row.report!.checks.dsh.status, "not_applicable");
  assert.equal(row.report!.checks.runner.status, "not_applicable");
  assert.equal(row.report!.checks.docker.status, "passed");
  assert.equal(row.report!.checks.acl.status, "passed");
  assert.equal(row.report!.checks.audit.status, "passed");
  assert.equal(h.store.getCleanupHold(runId, 1)!.state, "closed");
  assert.equal(h.reaperCalls.probe > 0, true);
  assert.equal(h.reaperCalls.cleanup, 1);
});

test("成功报告 → cleanup 通过后 publication/report/done 由 finalizeWithCleanup 统一提交", async (t) => {
  const h = await makeHarness(t);
  const runId = newTask(h);
  const html = "<html><body>" + "x".repeat(100) + "</body></html>";
  const workdir = join(h.paths.workroot, "s1", "workdir");
  mkdirSync(join(workdir, "reports"), { recursive: true });
  writeFileSync(join(workdir, "reports", "r.html"), html);
  const backend = makeBackend(h, [{
    events: [{ type: "stage", stage: "report_checking" }, { type: "report", path: "reports/r.html" }, answer],
  }]);
  await makeRunner(h, backend.backend).runOnce(runId);

  assert.equal(h.store.getTask(runId)!.status, "succeeded");
  const pub = h.store.getPublication(runId)!;
  assert.equal(pub.report_path, join(h.paths.reportsRoot, "tester", `${runId}.html`));
  assert.equal(readFileSync(pub.report_path, "utf8"), html);
  const evs = h.store.listEvents(runId, 0);
  const reportIdx = evs.findIndex((e) => e.type === "report");
  const doneIdx = evs.findIndex((e) => e.type === "done");
  assert.ok(reportIdx > 0 && doneIdx > reportIdx);
  assert.equal(h.store.getCleanupReport(runId, 1)!.overall_ok, true);
  assert.equal(h.store.getCleanupHold(runId, 1)!.state, "closed");
});

test("业务失败但 cleanup 通过：保留原错误码；timeout/engine_error 授权新 attempt", async (t) => {
  const h = await makeHarness(t);
  const runId = newTask(h);
  const backend = makeBackend(h, [
    { events: [{ type: "error", code: "ENGINE_ERROR", message: "dsh process exited" }] },
    { events: [answer] },
  ]);
  await makeRunner(h, backend.backend).runOnce(runId);

  const task = h.store.getTask(runId)!;
  assert.equal(task.status, "succeeded");
  assert.equal(task.attempt, 2);
  assert.equal(backend.asks, 2);
  const done = payloads(h, runId, "done");
  assert.equal(done.length, 1);
  assert.equal(done[0].status, "succeeded");
  assert.equal(done[0].recovered, true);

  const r1 = h.store.getCleanupReport(runId, 1)!;
  assert.equal(r1.sealed, true);
  assert.equal(r1.overall_ok, true);
  assert.equal(r1.report!.trigger, "engine_error");
  const hold1 = h.store.getCleanupHold(runId, 1)!;
  assert.equal(hold1.state, "cleanup_verified");
  assert.equal(hold1.retry_authorized, true);
  assert.equal(hold1.retry_trigger, "engine_error");
  assert.equal(h.store.getCleanupHold(runId, 2)!.state, "closed");
  assert.equal(h.reaperCalls.cleanup, 2);
});

test("业务失败 + cleanup 失败：终态失败、错误码保持、绝不自动重试", async (t) => {
  const h = await makeHarness(t);
  h.setProbe(busyProbe());
  const runId = newTask(h);
  const backend = makeBackend(h, [
    { events: [{ type: "error", code: "ENGINE_ERROR", message: "dsh died" }] },
    { events: [answer] },
  ]);
  await makeRunner(h, backend.backend).runOnce(runId);

  const task = h.store.getTask(runId)!;
  assert.equal(task.status, "failed");
  assert.equal(task.error_code, "ENGINE_ERROR");
  assert.equal(task.attempt, 1);
  assert.equal(backend.asks, 1);
  const row = h.store.getCleanupReport(runId, 1)!;
  assert.equal(row.sealed, true);
  assert.equal(row.overall_ok, false);
  assert.equal(h.store.getCleanupHold(runId, 1)!.state, "recovery_required");
  assert.equal(payloads(h, runId, "done")[0].status, "failed");
});

test("业务成功 + cleanup 失败：不得 succeeded、不发布报告、hold recovery_required", async (t) => {
  const h = await makeHarness(t);
  h.setProbe(busyProbe());
  const runId = newTask(h);
  const workdir = join(h.paths.workroot, "s1", "workdir");
  mkdirSync(workdir, { recursive: true });
  writeFileSync(join(workdir, "out.html"), "<html><body>" + "z".repeat(100) + "</body></html>");
  const backend = makeBackend(h, [{ events: [{ type: "report", path: "out.html" }, answer] }]);
  await makeRunner(h, backend.backend).runOnce(runId);

  const task = h.store.getTask(runId)!;
  assert.equal(task.status, "failed");
  assert.equal(task.error_code, "CLEANUP_INCOMPLETE");
  assert.ok(task.error_message!.includes("cleanup did not pass"));
  assert.equal(h.store.getPublication(runId), undefined);
  assert.equal(existsSync(join(h.paths.reportsRoot, "tester", `${runId}.html`)), false);
  assert.equal(h.store.getCleanupReport(runId, 1)!.overall_ok, false);
  assert.equal(h.store.getCleanupHold(runId, 1)!.state, "recovery_required");
  assert.equal(payloads(h, runId, "done")[0].status, "failed");
});

test("CONFIG 业务失败 + cleanup 通过：保持 failed/CONFIG，不重试", async (t) => {
  const h = await makeHarness(t);
  const runId = newTask(h);
  const backend = makeBackend(h, [{ throw: Object.assign(new Error("[CONFIG] key missing"), { code: "CONFIG" }) }]);
  await makeRunner(h, backend.backend).runOnce(runId);

  const task = h.store.getTask(runId)!;
  assert.equal(task.status, "failed");
  assert.equal(task.error_code, "CONFIG");
  assert.equal(task.attempt, 1);
  assert.equal(backend.asks, 1);
  assert.equal(h.store.getCleanupReport(runId, 1)!.overall_ok, true);
  assert.equal(h.store.getCleanupHold(runId, 1)!.state, "closed");
});

test("报告文件复制成功但终态事务失败：publication 回滚且本次孤儿文件被删除", async (t) => {
  const h = await makeHarness(t);
  const runId = newTask(h);
  const html = "<html><body>" + "r".repeat(100) + "</body></html>";
  const workdir = join(h.paths.workroot, "s1", "workdir");
  mkdirSync(join(workdir, "reports"), { recursive: true });
  writeFileSync(join(workdir, "reports", "r.html"), html);
  const dest = join(h.paths.reportsRoot, "tester", `${runId}.html`);
  h.db.exec(`
    CREATE TRIGGER fail_terminal_report BEFORE UPDATE ON tasks
    WHEN NEW.status IN ('succeeded','failed','cancelled')
    BEGIN SELECT RAISE(ABORT, 'injected terminal failure'); END;
  `);
  const backend = makeBackend(h, [{
    events: [{ type: "report", path: "reports/r.html" }, answer],
  }]);

  await assert.rejects(() => makeRunner(h, backend.backend).runOnce(runId));
  assert.equal(existsSync(dest), false, "未提交的复制文件不得残留为正式报告形态");
  assert.equal(h.store.getPublication(runId), undefined);
  assert.equal(count(h, "SELECT COUNT(*) AS n FROM cleanup_reports WHERE run_id=?", runId), 0);
  assert.deepEqual(types(h, runId).filter((x) => x === "done" || x === "report"), []);
  assert.equal(h.store.getTask(runId)!.status, "running");
  assert.equal(h.store.getCleanupHold(runId, 1)!.state, "cleanup_pending");
});

test("最终 SQLite 事务失败：cleanup/done/publication 原子回滚；boot recovery 后绝不重跑", async (t) => {
  const h = await makeHarness(t);
  const runId = newTask(h);
  const backend = makeBackend(h, [{ events: [answer] }]);
  h.db.exec(`
    CREATE TRIGGER fail_terminal BEFORE UPDATE ON tasks
    WHEN NEW.status IN ('succeeded','failed','cancelled')
    BEGIN SELECT RAISE(ABORT, 'injected terminal failure'); END;
  `);

  await assert.rejects(() => makeRunner(h, backend.backend).runOnce(runId));
  assert.equal(h.store.getTask(runId)!.status, "running");
  assert.equal(h.store.getCleanupHold(runId, 1)!.state, "cleanup_pending");
  assert.equal(count(h, "SELECT COUNT(*) AS n FROM cleanup_reports WHERE run_id=?", runId), 0);
  assert.deepEqual(types(h, runId).filter((x) => x === "done" || x === "report"), []);
  assert.equal(h.store.getPublication(runId), undefined);

  const healed = h.store.healOrphansWithHolds(Date.now(), 3);
  assert.equal(healed.recoveryRequired, 1);
  assert.equal(h.store.getCleanupHold(runId, 1)!.state, "recovery_required");
  assert.equal(h.store.getTask(runId)!.error_code, "CLEANUP_RECOVERY_REQUIRED");

  await makeRunner(h, backend.backend).runOnce(runId);
  assert.equal(backend.asks, 1, "recovery_required 不得自动重跑");
  assert.equal(h.store.getTask(runId)!.status, "running");
});

test("publication-only 旧路径无法绕过：claim 拒绝，legacy finalize/recordPublication 均禁用", async (t) => {
  const h = await makeHarness(t);
  const runId = newTask(h);
  h.db.prepare("INSERT INTO publications (run_id, report_path, published_at) VALUES (?, ?, ?)")
    .run(runId, "reports/legacy.html", Date.now());
  const backend = makeBackend(h, [{ events: [answer] }]);

  await makeRunner(h, backend.backend).runOnce(runId);

  assert.equal(backend.asks, 0);
  assert.equal(h.store.getTask(runId)!.status, "queued");
  assert.deepEqual(types(h, runId), []);
  assert.throws(() => h.store.recordPublication(runId, "reports/x.html"), /CLEANUP_HOLD_MODE_ACTIVE/);
  assert.throws(() => h.store.finalize(
    h.store.claimLeaseWithCleanupHold(runId, "x", 1_000, 1_000) || { run_id: runId, attempt: 1, lease_owner: "x" },
    "succeeded",
  ), /CLEANUP_HOLD_MODE_ACTIVE|CLEANUP_HOLD/);
});

test("终止权移交失败：完全不运行 Coordinator；sealed=0 失败终态 + recovery_required", async (t) => {
  const h = await makeHarness(t);
  const runId = newTask(h);
  const badHandle: DshCleanupHandle = {
    identity: null,
    child: {} as never,
    promptActive: false,
    hasExited: true,
    aclStateDir: h.cleanup.aclStateDir,
    requestShutdown: async () => true,
    markTerminationOwned: () => { throw new Error("ownership refused"); },
    isTerminationOwned: () => false,
  };
  const backend = makeBackend(h, [{ events: [answer], handle: () => badHandle }]);
  await makeRunner(h, backend.backend).runOnce(runId);

  const task = h.store.getTask(runId)!;
  assert.equal(task.status, "failed");
  assert.equal(task.error_code, "TERMINATION_OWNERSHIP_UNPROVEN");
  assert.equal(h.reaperCalls.cleanup, 0);
  const row = h.store.getCleanupReport(runId, 1)!;
  assert.equal(row.sealed, false);
  assert.equal(row.report, null);
  assert.equal(h.store.getCleanupHold(runId, 1)!.state, "recovery_required");
  assert.equal(payloads(h, runId, "done")[0].status, "failed");
  assert.equal(
    backend.sessions[0]!.cancelCount,
    0,
    "cleanup 模式即使 ownership 失败也不得用旧 cancel 抢杀未验证进程组",
  );
});

test("Audit fsync 失败：cleanup 物理结果不产生 overallOk=true，success 降级 failed", async (t) => {
  const h = await makeHarness(t, { auditFails: true });
  const runId = newTask(h);
  const backend = makeBackend(h, [{ events: [answer] }]);
  await makeRunner(h, backend.backend).runOnce(runId);

  const task = h.store.getTask(runId)!;
  assert.equal(task.status, "failed");
  assert.equal(task.error_code, "CLEANUP_INCOMPLETE");
  assert.equal(h.store.getCleanupReport(runId, 1)!.overall_ok, false);
  assert.equal(h.store.getCleanupReport(runId, 1)!.report!.checks.audit.status, "failed");
  assert.equal(h.store.getCleanupHold(runId, 1)!.state, "recovery_required");
});

test("真实 ACL 65534 残留：cleanup 不得 passed，success 降级 failed/CLEANUP_INCOMPLETE", { skip: process.platform !== "linux" }, async (t) => {
  let hasSetfacl = true;
  try {
    execFileSync("setfacl", ["--version"], { stdio: "ignore" });
  } catch {
    hasSetfacl = false;
  }
  if (!hasSetfacl) {
    t.skip("setfacl unavailable");
    return;
  }
  const h = await makeHarness(t);
  const runId = newTask(h);
  const backend = makeBackend(h, [{
    events: [{
      ev: answer,
      before: () => {
        const f = join(h.paths.workroot, "s1", "workdir", "acl-residual.txt");
        writeFileSync(f, "x");
        execFileSync("setfacl", ["-m", "u:65534:r--", f], { stdio: "ignore" });
      },
    }],
  }]);
  await makeRunner(h, backend.backend).runOnce(runId);

  const task = h.store.getTask(runId)!;
  assert.equal(task.status, "failed");
  assert.equal(task.error_code, "CLEANUP_INCOMPLETE");
  const report = h.store.getCleanupReport(runId, 1)!;
  assert.equal(report.overall_ok, false);
  assert.equal(report.report!.checks.acl.status, "failed");
  assert.equal(report.report!.checks.acl.reason, "ACL_RESIDUAL_GRANT");
  assert.equal(h.store.getCleanupHold(runId, 1)!.state, "recovery_required");
});

test("cancel 业务终止仍执行 cleanup；成功清理后终态 cancelled", async (t) => {
  const h = await makeHarness(t);
  const runId = newTask(h);
  const backend = makeBackend(h, [{
    events: [stage, { ev: answer, before: () => h.store.requestCancel(runId) }],
  }]);
  await makeRunner(h, backend.backend).runOnce(runId);

  const task = h.store.getTask(runId)!;
  assert.equal(task.status, "cancelled");
  assert.equal(h.store.getCleanupReport(runId, 1)!.report!.trigger, "cancel");
  assert.equal(h.store.getCleanupReport(runId, 1)!.overall_ok, true);
  assert.equal(h.store.getCleanupHold(runId, 1)!.state, "closed");
  assert.equal(payloads(h, runId, "done")[0].status, "cancelled");
  assert.equal(
    backend.sessions[0]!.cancelCount,
    0,
    "cleanup 模式不再调用旧 cancel；无 DSH 时 Coordinator 正常完成清理",
  );
});

test("hold store 已启用但 TaskRunner 无 cleanup 配置：拒绝 claim，不退回 legacy", async (t) => {
  const h = await makeHarness(t);
  const runId = newTask(h);
  const backend = makeBackend(h, [{ events: [answer] }]);
  const runner = new TaskRunner(h.store, backend.backend, {
    workerId: "missing-cleanup-config",
    taskBudgetS: 3600,
    heartbeatIntervalMs: 10_000,
    leaseTtlMs: 90_000,
    paths: h.paths,
    // 故意不提供 cleanup：store 已 hold-mode，legacy claimLease 必须抛错。
  });
  await assert.rejects(() => runner.runOnce(runId), /CLEANUP_HOLD_MODE_ACTIVE/);
  assert.equal(backend.asks, 0);
  assert.equal(h.store.getTask(runId)!.status, "queued");
  assert.deepEqual(types(h, runId), []);
});

test("WorkerPool cleanup hold 模式实际派发到 TaskRunner 并完成原子终态", async (t) => {
  const h = await makeHarness(t);
  const runId = newTask(h);
  const backend = makeBackend(h, [{ events: [answer] }]);
  const pool = new WorkerPool({
    store: h.store,
    runner: (id) => makeRunner(h, backend.backend).runOnce(id),
    config: {
      maxConcurrent: 1,
      pollIntervalMs: 10,
      reapIntervalMs: 10,
      maxAttempts: 3,
      cleanupHoldMode: true,
    },
  });
  pool.start();
  const deadline = Date.now() + 5_000;
  while (h.store.getTask(runId)!.status === "queued" || h.store.getTask(runId)!.status === "running") {
    if (Date.now() > deadline) throw new Error("pool did not finish cleanup task");
    await new Promise((r) => setTimeout(r, 10));
  }
  await pool.stop();

  assert.equal(h.store.getTask(runId)!.status, "succeeded");
  assert.equal(backend.asks, 1);
  assert.equal(h.store.getCleanupReport(runId, 1)!.overall_ok, true);
  assert.equal(h.store.getCleanupHold(runId, 1)!.state, "closed");
  assert.deepEqual(payloads(h, runId, "done").map((d) => d.status), ["succeeded"]);
});
