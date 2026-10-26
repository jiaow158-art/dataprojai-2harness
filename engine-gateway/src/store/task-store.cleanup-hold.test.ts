// S4-B2-C2-B2-2A-1：持久化 cleanup hold 数据库基础测试。
// 只使用内存/临时 SQLite 与 C2-B1 报告契约；不接触 TaskRunner/WorkerPool/HTTP/模型/DWS。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  CleanupStoreError,
  TaskStore,
  type Lease,
} from "./task-store.ts";
import {
  createPendingTaskCleanupReport,
  sealTaskCleanupReport,
  type TaskCleanupReport,
} from "../orchestrator/cleanup-report.ts";

interface HoldCtx {
  db: Database.Database;
  store: TaskStore;
}

function setup(cleanupHoldMode = true): HoldCtx {
  const db = new Database(":memory:");
  const store = new TaskStore(db, Date.now, { cleanupHoldMode });
  return { db, store };
}

function createTask(store: TaskStore, session = "s1"): string {
  return store.createTask({ session_id: session, user: "tester", question: "hold test" }).run_id;
}

function claimWithHold(store: TaskStore, runId: string, worker = "workerA"): Lease {
  const lease = store.claimLeaseWithCleanupHold(runId, worker, 90_000, 3600);
  if (!lease) throw new Error("claimLeaseWithCleanupHold failed");
  return lease;
}

function begin(store: TaskStore, lease: Lease, cleanupId = "cleanup-1"): void {
  const r = store.beginCleanup(lease, cleanupId);
  assert.equal(r.fenced, false);
}

function doneEvent(
  runId: string,
  status: "succeeded" | "failed" | "cancelled",
): {
  run_id: string;
  status: "succeeded" | "failed" | "cancelled";
  engine: string;
  elapsed_ms: number;
  tokens: { input: number; output: number; cache_read: number } | null;
  recovered: boolean;
} {
  return {
    run_id: runId,
    status,
    engine: "dsh",
    elapsed_ms: 1,
    tokens: null,
    recovered: false,
  };
}

function cleanupReport(
  runId: string,
  attempt: number,
  cleanupId: string,
  opts: {
    pass?: boolean;
    trigger?: "task_success" | "engine_error" | "timeout";
  } = {},
): TaskCleanupReport {
  const passed = opts.pass !== false;
  const draft = createPendingTaskCleanupReport({
    runId,
    attempt,
    trigger: opts.trigger ?? (passed ? "task_success" : "engine_error"),
    platform: "linux",
    cleanupId,
    now: "2026-10-26T00:00:00.000Z",
  });
  draft.checks.dsh = {
    component: "dsh",
    required: true,
    status: "passed",
    reason: "DSH_TERMINATED_VERIFIED",
    evidence: { pid: 123, pgid: 123, startTicks: "456", directChildExited: true, processGroupAbsent: true },
  };
  draft.checks.runner = {
    component: "runner",
    required: true,
    status: "passed",
    reason: "RUNNER_COVERED_BY_DSH",
    evidence: { pgid: 123, processGroupAbsent: true, coveredBy: "dsh_process_group" },
  };
  draft.checks.docker = {
    component: "docker",
    required: true,
    status: passed ? "passed" : "pending",
    reason: passed ? "DOCKER_CLEAN" : "CLEANUP_BUSY",
    evidence: { dockerFound: 0, dockerCleaned: 0 },
  };
  draft.checks.acl = {
    component: "acl",
    required: true,
    status: "passed",
    reason: "ACL_NO_65534_RESIDUAL",
    evidence: {
      platform: "linux",
      aclStateFiles: 0,
      aclResidualEntries: 0,
      aclVerifiedWith: "getfacl",
    },
  };
  draft.checks.audit = {
    component: "audit",
    required: true,
    status: "passed",
    reason: "AUDIT_WRITTEN",
    evidence: { auditEvents: 1, auditFailures: 0 },
  };
  return sealTaskCleanupReport(draft, "2026-10-26T00:00:01.000Z");
}

function rowCount(db: Database.Database, table: "cleanup_holds" | "cleanup_reports" | "publications"): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function doneCount(db: Database.Database, runId: string): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM events WHERE run_id=? AND type='done'").get(runId) as {
      n: number;
    }
  ).n;
}

function expireLease(db: Database.Database, runId: string): void {
  db.prepare("UPDATE tasks SET lease_expires_at=? WHERE run_id=?").run(Date.now() - 1, runId);
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

const LEGACY_RUN_ID = "run-legacy-hold";

function seedLegacy(db: Database.Database): void {
  db.exec(`
    CREATE TABLE tasks (
      run_id TEXT PRIMARY KEY, client_submission_id TEXT, session_id TEXT NOT NULL,
      user TEXT NOT NULL, scope_group TEXT NOT NULL DEFAULT 'default', question TEXT NOT NULL,
      status TEXT NOT NULL, stage TEXT, attempt INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT, lease_expires_at INTEGER, cancel_requested INTEGER NOT NULL DEFAULT 0,
      deadline INTEGER, error_code TEXT, error_message TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(client_submission_id)
    );
    CREATE TABLE events (
      run_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL,
      payload TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(run_id, seq)
    );
    CREATE TABLE publications (
      run_id TEXT PRIMARY KEY, report_path TEXT NOT NULL, published_at INTEGER NOT NULL
    );
    INSERT INTO tasks (run_id, session_id, user, scope_group, question, status, attempt, created_at, updated_at)
      VALUES ('${LEGACY_RUN_ID}', 's-legacy', 'u', 'default', '旧问题', 'succeeded', 1, 1, 1);
    INSERT INTO events (run_id, seq, type, payload, created_at)
      VALUES ('${LEGACY_RUN_ID}', 1, 'done', '{"run_id":"${LEGACY_RUN_ID}","status":"succeeded"}', 2);
    INSERT INTO publications (run_id, report_path, published_at)
      VALUES ('${LEGACY_RUN_ID}', 'reports/u/legacy.html', 3);
  `);
}

test("claimLeaseWithCleanupHold：task claim 与 executing hold 同事务创建", (t) => {
  const { db, store } = setup();
  t.after(() => db.close());
  const runId = createTask(store);
  const lease = claimWithHold(store, runId);
  const task = store.getTask(runId)!;
  assert.equal(task.status, "running");
  assert.equal(task.attempt, 1);
  const hold = store.getCleanupHold(runId, 1)!;
  assert.equal(hold.state, "executing");
  assert.equal(hold.lease_owner, "workerA");
  assert.equal(hold.cleanup_id, null);
  assert.equal(hold.retry_authorized, false);
  assert.equal(hold.retry_trigger, null);
  assert.equal(lease.attempt, 1);
});

test("hold INSERT 失败：claim 完整回滚，不留 stage/hold", (t) => {
  const { db, store } = setup();
  t.after(() => db.close());
  const runId = createTask(store);
  db.exec(`
    CREATE TRIGGER fail_hold BEFORE INSERT ON cleanup_holds
    BEGIN SELECT RAISE(ABORT, 'forced hold failure'); END;
  `);
  assert.throws(
    () => store.claimLeaseWithCleanupHold(runId, "workerA", 90_000, 3600),
    /CLEANUP_HOLD_CREATE_FAILED|forced hold failure/,
  );
  const task = store.getTask(runId)!;
  assert.equal(task.status, "queued");
  assert.equal(task.attempt, 0);
  assert.equal(store.getCleanupHold(runId, 1), undefined);
  assert.equal(store.listEvents(runId, 0).length, 0);
});

test("executing / cleanup_pending / recovery_required / closed 均禁止自动 claim", (t) => {
  const { db, store } = setup();
  t.after(() => db.close());

  const executingRun = createTask(store, "s-exec");
  claimWithHold(store, executingRun, "workerA");
  expireLease(db, executingRun);
  assert.equal(store.claimLeaseWithCleanupHold(executingRun, "workerB", 90_000, 3600), false);

  const pendingRun = createTask(store, "s-pending");
  const pendingLease = claimWithHold(store, pendingRun, "workerA");
  begin(store, pendingLease, "cleanup-pending-1");
  expireLease(db, pendingRun);
  assert.equal(store.claimLeaseWithCleanupHold(pendingRun, "workerB", 90_000, 3600), false);

  const recoveryRun = createTask(store, "s-recovery");
  const recoveryLease = claimWithHold(store, recoveryRun, "workerA");
  begin(store, recoveryLease, "cleanup-recovery-1");
  const healed = store.healOrphansWithHolds(Date.now(), 3);
  assert.equal(healed.recoveryRequired >= 1, true);
  assert.equal(store.getCleanupHold(recoveryRun, 1)?.state, "recovery_required");
  assert.equal(store.claimLeaseWithCleanupHold(recoveryRun, "workerB", 90_000, 3600), false);

  const closedRun = createTask(store, "s-closed");
  const closedLease = claimWithHold(store, closedRun, "workerA");
  begin(store, closedLease, "cleanup-closed-1");
  const closedReport = cleanupReport(closedRun, 1, "cleanup-closed-1");
  store.finalizeWithCleanup(closedLease, {
    status: "succeeded",
    report: closedReport,
    doneEvent: doneEvent(closedRun, "succeeded"),
  });
  assert.equal(store.getCleanupHold(closedRun, 1)?.state, "closed");
  assert.equal(store.claimLeaseWithCleanupHold(closedRun, "workerB", 90_000, 3600), false);
});

test("retry 授权：releaseForRetryWithCleanup 原子写入 cleanup_verified + retry_authorized", (t) => {
  const { db, store } = setup();
  t.after(() => db.close());
  const runId = createTask(store);
  const lease = claimWithHold(store, runId);
  begin(store, lease, "cleanup-retry-1");
  const report = cleanupReport(runId, 1, "cleanup-retry-1", { trigger: "engine_error" });
  const res = store.releaseForRetryWithCleanup(lease, { report });
  assert.equal(res.fenced, false);

  const hold = store.getCleanupHold(runId, 1)!;
  assert.equal(hold.state, "cleanup_verified");
  assert.equal(hold.retry_authorized, true);
  assert.equal(hold.retry_trigger, "engine_error");
  assert.equal(hold.cleanup_id, "cleanup-retry-1");
  assert.equal(store.getTask(runId)!.lease_owner, null);
  assert.equal(doneCount(db, runId), 0);

  const next = store.claimLeaseWithCleanupHold(runId, "workerB", 90_000, 3600);
  assert.ok(next);
  assert.equal(next.attempt, 2);
  assert.equal(store.getCleanupHold(runId, 2)?.state, "executing");
  assert.equal(store.getCleanupHold(runId, 1)?.state, "cleanup_verified");
  assert.equal(store.getCleanupHold(runId, 1)?.retry_authorized, true);
});

test("retry 授权绑定 trigger/cleanup_id；非 timeout/engine_error 拒绝", (t) => {
  const { db, store } = setup();
  t.after(() => db.close());

  const badTriggerRun = createTask(store, "s-trigger");
  const badTriggerLease = claimWithHold(store, badTriggerRun);
  begin(store, badTriggerLease, "cleanup-trigger-1");
  const badTriggerReport = cleanupReport(badTriggerRun, 1, "cleanup-trigger-1", { trigger: "task_success" });
  assert.equal(
    codeOf(() => store.releaseForRetryWithCleanup(badTriggerLease, { report: badTriggerReport })),
    "CLEANUP_RETRY_TRIGGER_INVALID",
  );
  assert.equal(store.getCleanupHold(badTriggerRun, 1)?.state, "cleanup_pending");
  assert.equal(store.getTask(badTriggerRun)!.lease_owner, "workerA");

  const badIdRun = createTask(store, "s-id");
  const badIdLease = claimWithHold(store, badIdRun);
  begin(store, badIdLease, "cleanup-id-1");
  const badIdReport = cleanupReport(badIdRun, 1, "cleanup-id-OTHER", { trigger: "engine_error" });
  assert.equal(
    codeOf(() => store.releaseForRetryWithCleanup(badIdLease, { report: badIdReport })),
    "CLEANUP_HOLD_CLEANUP_ID_MISMATCH",
  );
  assert.equal(store.getCleanupReport(badIdRun, 1), undefined);
  assert.equal(store.getTask(badIdRun)!.lease_owner, "workerA");
});

test("cleanup_verified 不能仅凭 report 伪造：hold 必须 retry_authorized + 匹配 report", (t) => {
  const { db, store } = setup();
  t.after(() => db.close());
  const runId = createTask(store);
  const lease = claimWithHold(store, runId);
  begin(store, lease, "cleanup-forge-1");

  // 直接塞入一份 overallOk=true 的报告，但 hold 仍是 cleanup_pending。
  const report = cleanupReport(runId, 1, "cleanup-forge-1", { trigger: "engine_error" });
  db.prepare(
    `INSERT INTO cleanup_reports
       (run_id, attempt, cleanup_id, trigger, platform, sealed, overall_ok, report_json, error_code, created_at)
     VALUES (?, ?, ?, ?, ?, 1, 1, ?, NULL, ?)`,
  ).run(runId, 1, "cleanup-forge-1", "engine_error", "linux", JSON.stringify(report), Date.now());
  assert.equal(store.claimLeaseWithCleanupHold(runId, "workerB", 90_000, 3600), false);

  // 即使强行改 hold 状态，DB CHECK 也不允许没有 retry_authorized 的 cleanup_verified。
  assert.throws(
    () => db.prepare("UPDATE cleanup_holds SET state='cleanup_verified' WHERE run_id=? AND attempt=?").run(runId, 1),
    /CHECK constraint failed/,
  );
});

test("cleanup_verified 授权被篡改后禁止 claim", (t) => {
  const { db, store } = setup();
  t.after(() => db.close());

  const runId = createTask(store, "s-tamper-report");
  const lease = claimWithHold(store, runId);
  begin(store, lease, "cleanup-tamper-1");
  const report = cleanupReport(runId, 1, "cleanup-tamper-1", { trigger: "engine_error" });
  store.releaseForRetryWithCleanup(lease, { report });
  db.prepare("UPDATE cleanup_reports SET trigger='task_success' WHERE run_id=? AND attempt=?").run(runId, 1);
  assert.equal(store.claimLeaseWithCleanupHold(runId, "workerB", 90_000, 3600), false);

  const runId2 = createTask(store, "s-tamper-missing");
  const lease2 = claimWithHold(store, runId2);
  begin(store, lease2, "cleanup-tamper-2");
  const report2 = cleanupReport(runId2, 1, "cleanup-tamper-2", { trigger: "engine_error" });
  store.releaseForRetryWithCleanup(lease2, { report: report2 });
  db.prepare("DELETE FROM cleanup_reports WHERE run_id=? AND attempt=?").run(runId2, 1);
  assert.equal(store.claimLeaseWithCleanupHold(runId2, "workerB", 90_000, 3600), false);
});

test("release 事务失败：report/hold/lease 全量回滚", (t) => {
  const { db, store } = setup();
  t.after(() => db.close());
  const runId = createTask(store);
  const lease = claimWithHold(store, runId);
  begin(store, lease, "cleanup-rollback-1");
  const report = cleanupReport(runId, 1, "cleanup-rollback-1", { trigger: "engine_error" });
  db.exec(`
    CREATE TRIGGER fail_release_hold BEFORE UPDATE ON tasks
    WHEN NEW.lease_owner IS NULL AND OLD.lease_owner IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'forced release failure'); END;
  `);
  assert.throws(
    () => store.releaseForRetryWithCleanup(lease, { report }),
    /forced release failure|CLEANUP/,
  );
  assert.equal(store.getCleanupHold(runId, 1)?.state, "cleanup_pending");
  assert.equal(store.getCleanupHold(runId, 1)?.retry_authorized, false);
  assert.equal(store.getCleanupReport(runId, 1), undefined);
  assert.equal(store.getTask(runId)!.lease_owner, "workerA");
  assert.equal(doneCount(db, runId), 0);
});

test("finalize 成功：hold closed、publication/report/done/终态同事务", (t) => {
  const { db, store } = setup();
  t.after(() => db.close());
  const runId = createTask(store);
  const lease = claimWithHold(store, runId);
  begin(store, lease, "cleanup-success-1");
  const report = cleanupReport(runId, 1, "cleanup-success-1");
  store.finalizeWithCleanup(lease, {
    status: "succeeded",
    report,
    doneEvent: doneEvent(runId, "succeeded"),
    publication: { reportPath: "reports/tester/hold.html" },
  });
  const hold = store.getCleanupHold(runId, 1)!;
  assert.equal(hold.state, "closed");
  assert.equal(hold.retry_authorized, false);
  assert.equal(hold.retry_trigger, null);
  assert.equal(store.getTask(runId)!.status, "succeeded");
  assert.equal(store.getPublication(runId)?.report_path, "reports/tester/hold.html");
  assert.equal(store.getCleanupReport(runId, 1)?.overall_ok, true);
  assert.equal(doneCount(db, runId), 1);
});

test("业务成功但 finalize 事务失败：不得产生 retry 授权，重启仍阻止重跑", (t) => {
  const { db, store } = setup();
  t.after(() => db.close());
  const runId = createTask(store);
  const lease = claimWithHold(store, runId);
  begin(store, lease, "cleanup-finalize-fail-1");
  const report = cleanupReport(runId, 1, "cleanup-finalize-fail-1");
  db.exec(`
    CREATE TRIGGER fail_finalize_done BEFORE INSERT ON events
    WHEN NEW.type = 'done'
    BEGIN SELECT RAISE(ABORT, 'forced finalize failure'); END;
  `);
  assert.throws(
    () => store.finalizeWithCleanup(lease, {
      status: "succeeded",
      report,
      doneEvent: doneEvent(runId, "succeeded"),
      publication: { reportPath: "reports/tester/failed.html" },
    }),
    /forced finalize failure/,
  );
  assert.equal(store.getCleanupHold(runId, 1)?.state, "cleanup_pending");
  assert.equal(store.getCleanupHold(runId, 1)?.retry_authorized, false);
  assert.equal(store.getCleanupReport(runId, 1), undefined);
  assert.equal(store.getPublication(runId), undefined);
  assert.equal(doneCount(db, runId), 0);
  assert.equal(store.getTask(runId)!.status, "running");
  assert.equal(store.claimLeaseWithCleanupHold(runId, "workerB", 90_000, 3600), false);

  const healed = store.healOrphansWithHolds(Date.now(), 3);
  assert.equal(healed.recoveryRequired, 1);
  const task = store.getTask(runId)!;
  assert.equal(task.status, "running");
  assert.equal(task.lease_owner, null);
  assert.equal(task.error_code, "CLEANUP_RECOVERY_REQUIRED");
  assert.equal(store.getCleanupHold(runId, 1)?.state, "recovery_required");
  assert.equal(store.claimLeaseWithCleanupHold(runId, "workerB", 90_000, 3600), false);

  const reaped = store.reapExpiredWithHolds(Date.now(), 3);
  assert.equal(reaped.some((r) => r.run_id === runId), false);
  assert.equal(store.getCleanupHold(runId, 1)?.state, "recovery_required");
});

test("文件库：finalize 失败后关闭重开，hold 仍为 cleanup_pending 并阻止重跑", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "c2b22a-hold-reopen-"));
  const dbPath = join(dir, "hold.db");
  let first: Database.Database | null = null;
  t.after(() => {
    if (first) first.close();
    rmSync(dir, { recursive: true, force: true });
  });
  first = new Database(dbPath);
  const firstStore = new TaskStore(first, Date.now, { cleanupHoldMode: true });
  const runId = createTask(firstStore);
  const lease = claimWithHold(firstStore, runId);
  begin(firstStore, lease, "cleanup-reopen-1");
  const report = cleanupReport(runId, 1, "cleanup-reopen-1");
  first.exec(`
    CREATE TRIGGER fail_reopen_done BEFORE INSERT ON events
    WHEN NEW.type = 'done'
    BEGIN SELECT RAISE(ABORT, 'forced reopen failure'); END;
  `);
  assert.throws(
    () => firstStore.finalizeWithCleanup(lease, {
      status: "succeeded",
      report,
      doneEvent: doneEvent(runId, "succeeded"),
    }),
    /forced reopen failure/,
  );
  first.close();
  first = null;

  const reopened = new Database(dbPath);
  try {
    const reopenedStore = new TaskStore(reopened, Date.now, { cleanupHoldMode: true });
    assert.equal(reopenedStore.getCleanupHold(runId, 1)?.state, "cleanup_pending");
    assert.equal(reopenedStore.claimLeaseWithCleanupHold(runId, "workerB", 90_000, 3600), false);
    const healed = reopenedStore.healOrphansWithHolds(Date.now(), 3);
    assert.equal(healed.recoveryRequired, 1);
    assert.equal(reopenedStore.getCleanupHold(runId, 1)?.state, "recovery_required");
    assert.equal(reopenedStore.getTask(runId)!.error_code, "CLEANUP_RECOVERY_REQUIRED");
  } finally {
    reopened.close();
  }
});

test("finalize cleanup 不通过：任务 failed，hold recovery_required", (t) => {
  const { db, store } = setup();
  t.after(() => db.close());
  const runId = createTask(store);
  const lease = claimWithHold(store, runId);
  begin(store, lease, "cleanup-failed-1");
  const report = cleanupReport(runId, 1, "cleanup-failed-1", { pass: false, trigger: "engine_error" });
  store.finalizeWithCleanup(lease, {
    status: "failed",
    errorCode: "ENGINE_ERROR",
    report,
    doneEvent: doneEvent(runId, "failed"),
  });
  assert.equal(store.getTask(runId)!.status, "failed");
  assert.equal(store.getCleanupHold(runId, 1)?.state, "recovery_required");
  assert.equal(store.getCleanupHold(runId, 1)?.retry_authorized, false);
  assert.equal(store.getCleanupReport(runId, 1)?.overall_ok, false);
});

test("finalizeCleanupFailure：sealed=0 失败标记 + hold recovery_required", (t) => {
  const { db, store } = setup();
  t.after(() => db.close());
  const runId = createTask(store);
  const lease = claimWithHold(store, runId);
  begin(store, lease, "cleanup-failure-1");
  store.finalizeCleanupFailure(lease, {
    status: "failed",
    cleanupId: "cleanup-failure-1",
    trigger: "engine_error",
    platform: "linux",
    errorCode: "CLEANUP_REPORT_INVALID",
    doneEvent: doneEvent(runId, "failed"),
  });
  assert.equal(store.getTask(runId)!.status, "failed");
  assert.equal(store.getCleanupHold(runId, 1)?.state, "recovery_required");
  assert.equal(store.getCleanupReport(runId, 1)?.sealed, false);
  assert.equal(store.getCleanupReport(runId, 1)?.report, null);
  assert.equal(doneCount(db, runId), 1);
});

test("beginCleanup 必须持有正确 lease/owner，旧 lease 不更新新 attempt", (t) => {
  const { db, store } = setup();
  t.after(() => db.close());
  const runId = createTask(store);
  const lease = claimWithHold(store, runId);
  assert.equal(store.beginCleanup({ ...lease, lease_owner: "workerZ" }, "cleanup-owner-1").fenced, true);
  assert.equal(store.getCleanupHold(runId, 1)?.state, "executing");
  begin(store, lease, "cleanup-owner-2");
  const report = cleanupReport(runId, 1, "cleanup-owner-2", { trigger: "engine_error" });
  store.releaseForRetryWithCleanup(lease, { report });
  const next = store.claimLeaseWithCleanupHold(runId, "workerB", 90_000, 3600);
  assert.ok(next);
  assert.equal(store.beginCleanup(lease, "cleanup-old-lease").fenced, true);
  assert.equal(store.getCleanupHold(runId, 2)?.state, "executing");
  assert.equal(store.getCleanupHold(runId, 1)?.state, "cleanup_verified");
  assert.equal(codeOf(() => store.claimLease(runId, "workerC", 90_000, 3600)), "CLEANUP_HOLD_MODE_ACTIVE");
  assert.equal(codeOf(() => store.finalize(lease, "failed")), "CLEANUP_HOLD_MODE_ACTIVE");
  assert.equal(codeOf(() => store.releaseForRetry(lease)), "CLEANUP_HOLD_MODE_ACTIVE");
  assert.equal(codeOf(() => store.recordPublication(runId, "reports/u/legacy.html")), "CLEANUP_HOLD_MODE_ACTIVE");
  assert.equal(codeOf(() => store.healOrphans()), "CLEANUP_HOLD_MODE_ACTIVE");
  assert.equal(codeOf(() => store.reapExpired(Date.now(), 3)), "CLEANUP_HOLD_MODE_ACTIVE");
  assert.equal(codeOf(() => store.listRunnable(1)), "CLEANUP_HOLD_MODE_ACTIVE");
  assert.equal(codeOf(() => store.appendEvent(lease, "done", {})), "CLEANUP_HOLD_MODE_ACTIVE");
  assert.equal(store.appendEvent(next, "stage", { stage: "analyzing" }).fenced, false);
});

test("heal：cleanup_pending 不回 queued；recovery_required 保留且无 TTL 删除", (t) => {
  const { db, store } = setup();
  t.after(() => db.close());
  const runId = createTask(store);
  const lease = claimWithHold(store, runId);
  begin(store, lease, "cleanup-heal-1");
  const first = store.healOrphansWithHolds(Date.now(), 3);
  assert.equal(first.recoveryRequired, 1);
  assert.equal(store.getTask(runId)!.status, "running");
  assert.equal(store.getTask(runId)!.lease_owner, null);
  assert.equal(store.getTask(runId)!.error_code, "CLEANUP_RECOVERY_REQUIRED");
  assert.equal(store.getCleanupHold(runId, 1)?.state, "recovery_required");
  const second = store.healOrphansWithHolds(Date.now(), 3);
  assert.equal(second.recoveryRequired, 1);
  assert.equal(store.getCleanupHold(runId, 1)?.state, "recovery_required");
  assert.equal(store.claimLeaseWithCleanupHold(runId, "workerB", 90_000, 3600), false);
});

test("heal：cleanup_verified 有效授权才 requeue；缺失 report 转 recovery", (t) => {
  const { db, store } = setup();
  t.after(() => db.close());
  const runId = createTask(store, "s-heal-verified");
  const lease = claimWithHold(store, runId);
  begin(store, lease, "cleanup-heal-2");
  const report = cleanupReport(runId, 1, "cleanup-heal-2", { trigger: "timeout" });
  store.releaseForRetryWithCleanup(lease, { report });
  const healed = store.healOrphansWithHolds(Date.now(), 3);
  assert.equal(healed.requeued, 1);
  assert.equal(store.getTask(runId)!.status, "queued");
  assert.equal(store.getCleanupHold(runId, 1)?.state, "cleanup_verified");
  assert.ok(store.claimLeaseWithCleanupHold(runId, "workerB", 90_000, 3600));

  const runId2 = createTask(store, "s-heal-invalid");
  const lease2 = claimWithHold(store, runId2);
  begin(store, lease2, "cleanup-heal-3");
  const report2 = cleanupReport(runId2, 1, "cleanup-heal-3", { trigger: "engine_error" });
  store.releaseForRetryWithCleanup(lease2, { report: report2 });
  db.prepare("DELETE FROM cleanup_reports WHERE run_id=? AND attempt=?").run(runId2, 1);
  const healed2 = store.healOrphansWithHolds(Date.now(), 3);
  assert.equal(healed2.recoveryRequired >= 1, true);
  assert.equal(store.getCleanupHold(runId2, 1)?.state, "recovery_required");
});

test("heal：running 无 hold 创建 recovery；hold INSERT 失败则抛错不回队", (t) => {
  const { db, store } = setup();
  t.after(() => db.close());
  const runId = createTask(store);
  db.prepare(
    `UPDATE tasks SET status='running', attempt=1, lease_owner='workerX',
                      lease_expires_at=?, updated_at=? WHERE run_id=?`,
  ).run(Date.now() + 90_000, Date.now(), runId);
  const healed = store.healOrphansWithHolds(Date.now(), 3);
  assert.equal(healed.recoveryRequired, 1);
  assert.equal(store.getTask(runId)!.error_code, "CLEANUP_RECOVERY_REQUIRED");
  assert.equal(store.getCleanupHold(runId, 1)?.state, "recovery_required");

  const runId2 = createTask(store, "s-heal-fail");
  db.prepare(
    `UPDATE tasks SET status='running', attempt=1, lease_owner='workerX',
                      lease_expires_at=?, updated_at=? WHERE run_id=?`,
  ).run(Date.now() + 90_000, Date.now(), runId2);
  db.exec(`
    CREATE TRIGGER fail_heal_hold BEFORE INSERT ON cleanup_holds
    BEGIN SELECT RAISE(ABORT, 'forced heal hold failure'); END;
  `);
  assert.throws(
    () => store.healOrphansWithHolds(Date.now(), 3),
    /CLEANUP_HOLD_CREATE_FAILED|forced heal hold failure/,
  );
  assert.equal(store.getTask(runId2)!.status, "running");
  assert.equal(store.getCleanupHold(runId2, 1), undefined);
});

test("reap：cleanup_pending/ recovery_required 不 requeue；cleanup_verified 有效才 queued", (t) => {
  const { db, store } = setup();
  t.after(() => db.close());
  const pendingRun = createTask(store, "s-reap-pending");
  const pendingLease = claimWithHold(store, pendingRun);
  begin(store, pendingLease, "cleanup-reap-1");
  expireLease(db, pendingRun);
  const pendingReap = store.reapExpiredWithHolds(Date.now(), 3);
  assert.equal(pendingReap.find((r) => r.run_id === pendingRun)?.action, "recovery_required");
  assert.equal(store.getTask(pendingRun)!.status, "running");
  assert.equal(store.getTask(pendingRun)!.error_code, "CLEANUP_RECOVERY_REQUIRED");
  const secondReap = store.reapExpiredWithHolds(Date.now(), 3);
  assert.equal(secondReap.some((r) => r.run_id === pendingRun), false);
  assert.equal(store.getCleanupHold(pendingRun, 1)?.state, "recovery_required");

  const verifiedRun = createTask(store, "s-reap-verified");
  const verifiedLease = claimWithHold(store, verifiedRun);
  begin(store, verifiedLease, "cleanup-reap-2");
  const report = cleanupReport(verifiedRun, 1, "cleanup-reap-2", { trigger: "timeout" });
  store.releaseForRetryWithCleanup(verifiedLease, { report });
  const reaped = store.reapExpiredWithHolds(Date.now(), 3);
  assert.equal(reaped.find((r) => r.run_id === verifiedRun)?.action, "queued");
  assert.equal(store.getTask(verifiedRun)!.status, "queued");
  assert.equal(store.getCleanupHold(verifiedRun, 1)?.state, "cleanup_verified");
  assert.ok(store.claimLeaseWithCleanupHold(verifiedRun, "workerB", 90_000, 3600));
});

test("reap：cleanup_verified 缺失 report 转 recovery；running 无 hold 不重跑", (t) => {
  const { db, store } = setup();
  t.after(() => db.close());
  const runId = createTask(store, "s-reap-missing");
  const lease = claimWithHold(store, runId);
  begin(store, lease, "cleanup-reap-3");
  const report = cleanupReport(runId, 1, "cleanup-reap-3", { trigger: "engine_error" });
  store.releaseForRetryWithCleanup(lease, { report });
  db.prepare("DELETE FROM cleanup_reports WHERE run_id=? AND attempt=?").run(runId, 1);
  const reaped = store.reapExpiredWithHolds(Date.now(), 3);
  assert.equal(reaped.find((r) => r.run_id === runId)?.action, "recovery_required");
  assert.equal(store.getCleanupHold(runId, 1)?.state, "recovery_required");
  assert.equal(store.claimLeaseWithCleanupHold(runId, "workerB", 90_000, 3600), false);

  const noHoldRun = createTask(store, "s-reap-no-hold");
  db.prepare(
    `UPDATE tasks SET status='running', attempt=1, lease_owner='workerX',
                      lease_expires_at=?, updated_at=? WHERE run_id=?`,
  ).run(Date.now() - 1, Date.now(), noHoldRun);
  const reapedNoHold = store.reapExpiredWithHolds(Date.now(), 3);
  assert.equal(reapedNoHold.find((r) => r.run_id === noHoldRun)?.action, "recovery_required");
  assert.equal(store.getCleanupHold(noHoldRun, 1)?.state, "recovery_required");
  assert.equal(store.getTask(noHoldRun)!.status, "running");
});

test("reap：queued 超 deadline 且有 hold 不自动 failed，转 recovery_required", (t) => {
  const { db, store } = setup();
  t.after(() => db.close());
  const runId = createTask(store);
  const lease = claimWithHold(store, runId);
  begin(store, lease, "cleanup-zombie-1");
  db.prepare(
    "UPDATE tasks SET status='queued', deadline=?, lease_owner=NULL, lease_expires_at=NULL WHERE run_id=?",
  ).run(Date.now() - 1, runId);
  const reaped = store.reapExpiredWithHolds(Date.now(), 3);
  assert.equal(reaped.find((r) => r.run_id === runId)?.action, "recovery_required");
  assert.equal(store.getTask(runId)!.status, "running");
  assert.equal(store.getTask(runId)!.error_code, "CLEANUP_RECOVERY_REQUIRED");
  assert.equal(store.getCleanupHold(runId, 1)?.state, "recovery_required");
});

test("listRunnableWithCleanupHolds：新任务可见；recovery/无 hold attempt>0 不可见；verified 可重试", (t) => {
  const { db, store } = setup();
  t.after(() => db.close());
  const fresh = createTask(store, "s-list-fresh");
  assert.deepEqual(store.listRunnableWithCleanupHolds(10).map((x) => x.run_id), [fresh]);

  const recoveryRun = createTask(store, "s-list-recovery");
  const recoveryLease = claimWithHold(store, recoveryRun);
  begin(store, recoveryLease, "cleanup-list-1");
  store.healOrphansWithHolds(Date.now(), 3);
  db.prepare("UPDATE tasks SET status='queued' WHERE run_id=?").run(recoveryRun);
  assert.equal(store.listRunnableWithCleanupHolds(10).some((x) => x.run_id === recoveryRun), false);

  const retryRun = createTask(store, "s-list-retry");
  const retryLease = claimWithHold(store, retryRun);
  begin(store, retryLease, "cleanup-list-2");
  const retryReport = cleanupReport(retryRun, 1, "cleanup-list-2", { trigger: "engine_error" });
  store.releaseForRetryWithCleanup(retryLease, { report: retryReport });
  db.prepare("UPDATE tasks SET status='queued' WHERE run_id=?").run(retryRun);
  assert.equal(store.listRunnableWithCleanupHolds(10).some((x) => x.run_id === retryRun), true);
});

test("publication-only 旁路：hold 模式下旧 recordPublication 必须拒绝；有 publication 不得 claim", (t) => {
  const { db, store } = setup();
  t.after(() => db.close());
  const runId = createTask(store);
  const lease = claimWithHold(store, runId);
  begin(store, lease, "cleanup-publication-1");
  assert.equal(
    codeOf(() => store.recordPublication(runId, "reports/tester/bypass.html")),
    "CLEANUP_HOLD_MODE_ACTIVE",
  );
  assert.equal(store.getPublication(runId), undefined);

  const publishedRun = createTask(store, "s-publication-only");
  db.prepare("INSERT INTO publications (run_id, report_path, published_at) VALUES (?, ?, ?)")
    .run(publishedRun, "reports/tester/legacy.html", Date.now());
  assert.equal(store.claimLeaseWithCleanupHold(publishedRun, "workerB", 90_000, 3600), false);
  assert.equal(
    store.listRunnableWithCleanupHolds(10).some((x) => x.run_id === publishedRun),
    false,
  );

  const retryRun = createTask(store, "s-publication-retry");
  const retryLease = claimWithHold(store, retryRun);
  begin(store, retryLease, "cleanup-publication-2");
  const retryReport = cleanupReport(retryRun, 1, "cleanup-publication-2", { trigger: "engine_error" });
  store.releaseForRetryWithCleanup(retryLease, { report: retryReport });
  db.prepare("INSERT INTO publications (run_id, report_path, published_at) VALUES (?, ?, ?)")
    .run(retryRun, "reports/tester/legacy-retry.html", Date.now());
  assert.equal(store.claimLeaseWithCleanupHold(retryRun, "workerB", 90_000, 3600), false);
  store.healOrphansWithHolds(Date.now(), 3);
  assert.equal(store.getCleanupHold(retryRun, 1)?.state, "recovery_required");
});

test("默认 off：旧 claim/finalize 行为不变，不创建 hold 行", (t) => {
  const db = new Database(":memory:");
  const store = new TaskStore(db);
  t.after(() => db.close());
  const runId = createTask(store);
  const lease = store.claimLease(runId, "workerA", 90_000, 3600);
  assert.ok(lease);
  assert.equal(store.getCleanupHold(runId, lease.attempt), undefined);
  assert.deepEqual(store.finalize(lease, "succeeded"), { fenced: false });
  assert.equal(store.getTask(runId)!.status, "succeeded");
  assert.equal(rowCount(db, "cleanup_holds"), 0);
});

test("旧 SQLite：自动补 cleanup_holds，历史 tasks/events/publications 不变", (t) => {
  const db = new Database(":memory:");
  t.after(() => db.close());
  seedLegacy(db);
  const store = new TaskStore(db, Date.now, { cleanupHoldMode: true });
  assert.equal(store.getTask(LEGACY_RUN_ID)?.question, "旧问题");
  assert.equal(store.getTask(LEGACY_RUN_ID)?.status, "succeeded");
  assert.equal(store.listEvents(LEGACY_RUN_ID, 0).length, 1);
  assert.equal(store.getPublication(LEGACY_RUN_ID)?.report_path, "reports/u/legacy.html");
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cleanup_holds'")
    .get() as { name: string } | undefined;
  assert.equal(table?.name, "cleanup_holds");
  assert.equal(store.getCleanupHold(LEGACY_RUN_ID, 1), undefined);
  assert.equal(rowCount(db, "cleanup_holds"), 0);
});

test("CleanupStoreError 类型可用于错误路径", () => {
  const err = new CleanupStoreError("X", "y");
  assert.equal(err.code, "X");
  assert.match(err.message, /\[X\]/);
});
