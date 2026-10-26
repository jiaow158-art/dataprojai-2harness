// S4-B2-C2-B2-1：TaskStore 清理证据表与事务性终态。
// 全部使用真实 better-sqlite3 内存库；不接触文件系统产物/Docker/网络/模型。
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  CleanupStoreError,
  TaskStore,
  type CleanupDoneEvent,
  type Lease,
} from "./task-store.ts";
import {
  createPendingTaskCleanupReport,
  sealTaskCleanupReport,
  type TaskCleanupReport,
} from "../orchestrator/cleanup-report.ts";

let db: Database.Database;
let store: TaskStore;

beforeEach(() => {
  db = new Database(":memory:");
  store = new TaskStore(db);
});

afterEach(() => {
  db.close();
});

function createTask(): string {
  return store.createTask({ session_id: "s1", user: "tester", question: "测试问题" }).run_id;
}

function claim(runId: string, worker = "workerA"): Lease {
  const lease = store.claimLease(runId, worker, 90_000, 3600);
  if (!lease) throw new Error("claimLease failed");
  return lease;
}

function done(
  runId: string,
  status: "succeeded" | "failed" | "cancelled",
  recovered = false,
): CleanupDoneEvent {
  return {
    run_id: runId,
    status,
    engine: "dsh",
    elapsed_ms: 12,
    tokens: { input: 1, output: 2, cache_read: 0 },
    recovered,
  };
}

/**
 * 用真实 C2-B1 seal 生成报告。pass=false 时 docker=pending，overallOk 必为 false。
 */
function cleanupReport(
  runId: string,
  attempt: number,
  opts: { pass?: boolean; trigger?: "task_success" | "engine_error"; cleanupId?: string } = {},
): TaskCleanupReport {
  const passed = opts.pass !== false;
  const draft = createPendingTaskCleanupReport({
    runId,
    attempt,
    trigger: opts.trigger ?? (passed ? "task_success" : "engine_error"),
    platform: "linux",
    cleanupId: opts.cleanupId ?? "cleanup-test-1",
    now: "2026-10-26T00:00:00.000Z",
  });
  draft.checks.dsh = {
    component: "dsh",
    required: true,
    status: "passed",
    reason: "DSH_TERMINATED_VERIFIED",
    evidence: {
      pid: 123,
      pgid: 123,
      startTicks: "456",
      directChildExited: true,
      processGroupAbsent: true,
    },
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

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

function cleanupRowCount(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM cleanup_reports").get() as { n: number }).n;
}

function doneCount(runId: string): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM events WHERE run_id=? AND type='done'").get(runId) as {
      n: number;
    }
  ).n;
}

const LEGACY_RUN_ID = "run-legacy";

function seedLegacyDatabase(target: Database.Database): void {
  target.exec(`
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
    CREATE INDEX idx_tasks_session ON tasks(session_id, created_at);
    CREATE INDEX idx_tasks_status ON tasks(status);
    INSERT INTO tasks (run_id, session_id, user, scope_group, question, status, attempt, created_at, updated_at)
      VALUES ('${LEGACY_RUN_ID}', 's-legacy', 'u', 'default', '旧问题', 'succeeded', 1, 1, 1);
    INSERT INTO events (run_id, seq, type, payload, created_at)
      VALUES ('${LEGACY_RUN_ID}', 1, 'done', '{"run_id":"${LEGACY_RUN_ID}","status":"succeeded"}', 2);
    INSERT INTO publications (run_id, report_path, published_at)
      VALUES ('${LEGACY_RUN_ID}', 'reports/u/legacy.html', 3);
  `);
}

function assertLegacyRows(target: TaskStore): void {
  assert.equal(target.getTask(LEGACY_RUN_ID)?.question, "旧问题");
  assert.equal(target.getTask(LEGACY_RUN_ID)?.status, "succeeded");
  assert.equal(target.listEvents(LEGACY_RUN_ID, 0).length, 1);
  assert.equal(target.getPublication(LEGACY_RUN_ID)?.report_path, "reports/u/legacy.html");
  assert.equal(target.getCleanupReport(LEGACY_RUN_ID, 1), undefined);
}

test("succeeded + cleanup passed：报告、publication、report、done、终态同事务提交", () => {
  const runId = createTask();
  const lease = claim(runId);
  const report = cleanupReport(runId, lease.attempt);
  const res = store.finalizeWithCleanup(lease, {
    status: "succeeded",
    report,
    doneEvent: done(runId, "succeeded"),
    publication: { reportPath: "reports/tester/a.html" },
  });
  assert.equal(res.fenced, false);
  assert.equal(res.reportStored, true);
  assert.equal(res.publicationPath, "reports/tester/a.html");

  const task = store.getTask(runId)!;
  assert.equal(task.status, "succeeded");
  assert.equal(task.error_code, null);
  assert.equal(task.lease_owner, null);
  assert.equal(store.getPublication(runId)?.report_path, "reports/tester/a.html");

  const events = store.listEvents(runId, 0);
  assert.deepEqual(events.map((e) => e.type), ["stage", "report", "done"]);
  assert.deepEqual(events[1].payload, { path: "reports/tester/a.html" });
  assert.equal((events[2].payload as CleanupDoneEvent).status, "succeeded");
  assert.equal(doneCount(runId), 1);

  const row = store.getCleanupReport(runId, lease.attempt)!;
  assert.equal(row.sealed, true);
  assert.equal(row.overall_ok, true);
  assert.equal(row.report?.runId, runId);
  assert.equal(row.report?.attempt, lease.attempt);
  assert.equal(row.report?.overallOk, true);
});

test("succeeded 不接受非 task_success trigger 的清理报告", () => {
  const runId = createTask();
  const lease = claim(runId);
  const report = cleanupReport(runId, lease.attempt, { trigger: "engine_error" });
  assert.equal(codeOf(() => store.finalizeWithCleanup(lease, {
    status: "succeeded",
    report,
    doneEvent: done(runId, "succeeded"),
  })), "CLEANUP_TRIGGER_STATUS_INVALID");
  assert.equal(store.getTask(runId)!.status, "running");
  assert.equal(cleanupRowCount(), 0);
  assert.equal(doneCount(runId), 0);
});

test("succeeded + cleanup failed/pending 被拒绝且无任何写入", () => {
  const runId = createTask();
  const lease = claim(runId);
  const report = cleanupReport(runId, lease.attempt, { pass: false });
  assert.equal(codeOf(() => store.finalizeWithCleanup(lease, {
    status: "succeeded",
    report,
    doneEvent: done(runId, "succeeded"),
  })), "CLEANUP_REPORT_NOT_OK");
  assert.equal(store.getTask(runId)!.status, "running");
  assert.equal(cleanupRowCount(), 0);
  assert.equal(doneCount(runId), 0);
});

test("业务失败 + cleanup passed 仍保持 failed 与原错误码", () => {
  const runId = createTask();
  const lease = claim(runId);
  const report = cleanupReport(runId, lease.attempt, { trigger: "engine_error" });
  const res = store.finalizeWithCleanup(lease, {
    status: "failed",
    errorCode: "CONFIG",
    errorMessage: "bad config",
    report,
    doneEvent: done(runId, "failed"),
  });
  assert.equal(res.fenced, false);
  const task = store.getTask(runId)!;
  assert.equal(task.status, "failed");
  assert.equal(task.error_code, "CONFIG");
  assert.equal(task.error_message, "bad config");
  assert.equal(store.getCleanupReport(runId, lease.attempt)?.overall_ok, true);
  assert.equal(doneCount(runId), 1);
});

test("业务失败 + cleanup failed/pending 仍为 failed，不成功", () => {
  const runId = createTask();
  const lease = claim(runId);
  const report = cleanupReport(runId, lease.attempt, { pass: false, trigger: "engine_error" });
  const res = store.finalizeWithCleanup(lease, {
    status: "failed",
    errorCode: "ENGINE_ERROR",
    errorMessage: "engine failed",
    report,
    doneEvent: done(runId, "failed"),
  });
  assert.equal(res.fenced, false);
  const task = store.getTask(runId)!;
  assert.equal(task.status, "failed");
  assert.equal(task.error_code, "ENGINE_ERROR");
  assert.equal(store.getCleanupReport(runId, lease.attempt)?.overall_ok, false);
});

test("report 归属不一致：runId/attempt 不匹配拒绝且无写入", () => {
  const runId = createTask();
  const lease = claim(runId);
  const otherRun = createTask();
  const wrongRun = cleanupReport(otherRun, lease.attempt);
  const wrongAttempt = cleanupReport(runId, lease.attempt + 1);
  assert.equal(codeOf(() => store.finalizeWithCleanup(lease, {
    status: "succeeded",
    report: wrongRun,
    doneEvent: done(runId, "succeeded"),
  })), "CLEANUP_REPORT_RUN_MISMATCH");
  assert.equal(codeOf(() => store.finalizeWithCleanup(lease, {
    status: "succeeded",
    report: wrongAttempt,
    doneEvent: done(runId, "succeeded"),
  })), "CLEANUP_REPORT_ATTEMPT_MISMATCH");
  assert.equal(cleanupRowCount(), 0);
  assert.equal(doneCount(runId), 0);
  assert.equal(store.getTask(runId)!.status, "running");
});

test("旧 attempt / 错误 lease_owner 围栏拒绝，不补写 done/report/终态", () => {
  const runId = createTask();
  const oldLease = claim(runId, "workerA");
  db.prepare("UPDATE tasks SET lease_expires_at=? WHERE run_id=?").run(Date.now() - 1, runId);
  const newLease = claim(runId, "workerB");
  assert.equal(newLease.attempt, oldLease.attempt + 1);

  const staleReport = cleanupReport(runId, oldLease.attempt);
  const res = store.finalizeWithCleanup(oldLease, {
    status: "succeeded",
    report: staleReport,
    doneEvent: done(runId, "succeeded"),
  });
  assert.equal(res.fenced, true);
  assert.equal(store.getTask(runId)!.status, "running");
  assert.equal(store.getTask(runId)!.lease_owner, "workerB");
  assert.equal(cleanupRowCount(), 0);
  assert.equal(doneCount(runId), 0);

  const wrongOwner: Lease = { ...newLease, lease_owner: "workerC" };
  const newReport = cleanupReport(runId, newLease.attempt);
  assert.equal(
    store.finalizeWithCleanup(wrongOwner, {
      status: "succeeded",
      report: newReport,
      doneEvent: done(runId, "succeeded"),
    }).fenced,
    true,
  );
  assert.equal(cleanupRowCount(), 0);
  assert.equal(doneCount(runId), 0);
});

test("事务中途异常全量回滚：cleanup_reports/publication/report/done/终态", () => {
  const runId = createTask();
  const lease = claim(runId);
  db.exec(`
    CREATE TRIGGER fail_done BEFORE INSERT ON events
    WHEN NEW.type = 'done'
    BEGIN SELECT RAISE(ABORT, 'forced done failure'); END;
  `);
  const report = cleanupReport(runId, lease.attempt);
  assert.throws(
    () => store.finalizeWithCleanup(lease, {
      status: "succeeded",
      report,
      doneEvent: done(runId, "succeeded"),
      publication: { reportPath: "reports/tester/a.html" },
    }),
    /forced done failure/,
  );
  assert.equal(store.getTask(runId)!.status, "running");
  assert.equal(cleanupRowCount(), 0);
  assert.equal(store.getPublication(runId), undefined);
  assert.equal(doneCount(runId), 0);
  assert.deepEqual(store.listEvents(runId, 0).map((e) => e.type), ["stage"]);
});

test("重复提交：第二次围栏拒绝，done 只写一次", () => {
  const runId = createTask();
  const lease = claim(runId);
  const report = cleanupReport(runId, lease.attempt);
  const first = store.finalizeWithCleanup(lease, {
    status: "succeeded",
    report,
    doneEvent: done(runId, "succeeded"),
  });
  assert.equal(first.fenced, false);
  const second = store.finalizeWithCleanup(lease, {
    status: "succeeded",
    report,
    doneEvent: done(runId, "succeeded"),
  });
  assert.equal(second.fenced, true);
  assert.equal(doneCount(runId), 1);
  assert.equal(store.getTask(runId)!.status, "succeeded");
});

test("releaseForRetryWithCleanup：cleanup passed 才释放租约，不产生 done", () => {
  const runId = createTask();
  const lease = claim(runId);
  const report = cleanupReport(runId, lease.attempt, { trigger: "engine_error" });
  const res = store.releaseForRetryWithCleanup(lease, { report });
  assert.equal(res.fenced, false);
  assert.equal(res.reportStored, true);
  const task = store.getTask(runId)!;
  assert.equal(task.status, "running");
  assert.equal(task.lease_owner, null);
  assert.equal(task.attempt, 1);
  assert.equal(doneCount(runId), 0);
  const row = store.getCleanupReport(runId, lease.attempt)!;
  assert.equal(row.sealed, true);
  assert.equal(row.overall_ok, true);
  const reclaim = store.claimLease(runId, "workerB", 90_000, 3600);
  assert.ok(reclaim);
  assert.equal(reclaim.attempt, 2);
});

test("releaseForRetryWithCleanup：cleanup pending/failed 拒绝且租约不释放", () => {
  const runId = createTask();
  const lease = claim(runId);
  const report = cleanupReport(runId, lease.attempt, { pass: false, trigger: "engine_error" });
  assert.equal(codeOf(() => store.releaseForRetryWithCleanup(lease, { report })), "CLEANUP_REPORT_NOT_OK");
  const task = store.getTask(runId)!;
  assert.equal(task.status, "running");
  assert.equal(task.lease_owner, "workerA");
  assert.equal(cleanupRowCount(), 0);
  assert.equal(doneCount(runId), 0);
});

test("releaseForRetryWithCleanup：非 timeout/engine_error 清理报告拒绝", () => {
  const runId = createTask();
  const lease = claim(runId);
  const report = cleanupReport(runId, lease.attempt, { trigger: "task_success" });
  assert.equal(
    codeOf(() => store.releaseForRetryWithCleanup(lease, { report })),
    "CLEANUP_RETRY_TRIGGER_INVALID",
  );
  const task = store.getTask(runId)!;
  assert.equal(task.status, "running");
  assert.equal(task.lease_owner, "workerA");
  assert.equal(cleanupRowCount(), 0);
  assert.equal(doneCount(runId), 0);
});

test("releaseForRetry 事务中途 SQL 错误回滚：报告不落地、租约保留", () => {
  const runId = createTask();
  const lease = claim(runId);
  db.exec(`
    CREATE TRIGGER fail_release BEFORE UPDATE ON tasks
    WHEN NEW.lease_owner IS NULL AND OLD.lease_owner IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'forced release failure'); END;
  `);
  const report = cleanupReport(runId, lease.attempt, { trigger: "engine_error" });
  assert.throws(
    () => store.releaseForRetryWithCleanup(lease, { report }),
    /forced release failure/,
  );
  const task = store.getTask(runId)!;
  assert.equal(task.status, "running");
  assert.equal(task.lease_owner, "workerA");
  assert.equal(cleanupRowCount(), 0);
  assert.equal(doneCount(runId), 0);
});

test("finalizeCleanupFailure 事务中途 SQL 错误回滚：标记/done/终态均不落地", () => {
  const runId = createTask();
  const lease = claim(runId);
  db.exec(`
    CREATE TRIGGER fail_cleanup_marker BEFORE INSERT ON cleanup_reports
    WHEN NEW.sealed = 0
    BEGIN SELECT RAISE(ABORT, 'forced marker failure'); END;
  `);
  assert.throws(
    () => store.finalizeCleanupFailure(lease, {
      status: "failed",
      cleanupId: "cleanup-failure-rollback",
      trigger: "engine_error",
      platform: "linux",
      errorCode: "CLEANUP_REPORT_INVALID",
      doneEvent: done(runId, "failed"),
    }),
    /forced marker failure/,
  );
  assert.equal(store.getTask(runId)!.status, "running");
  assert.equal(cleanupRowCount(), 0);
  assert.equal(doneCount(runId), 0);
});

test("finalizeCleanupFailure：sealed=0、overall_ok=0、明确 failed、done 一次", () => {
  const runId = createTask();
  const lease = claim(runId);
  const res = store.finalizeCleanupFailure(lease, {
    status: "failed",
    cleanupId: "cleanup-failure-1",
    trigger: "engine_error",
    platform: "linux",
    errorCode: "CLEANUP_REPORT_INVALID",
    errorMessage: "seal failed",
    doneEvent: done(runId, "failed"),
  });
  assert.equal(res.fenced, false);
  const task = store.getTask(runId)!;
  assert.equal(task.status, "failed");
  assert.equal(task.error_code, "CLEANUP_REPORT_INVALID");
  const row = store.getCleanupReport(runId, lease.attempt)!;
  assert.equal(row.sealed, false);
  assert.equal(row.overall_ok, false);
  assert.equal(row.report, null);
  assert.equal(row.error_code, "CLEANUP_REPORT_INVALID");
  assert.deepEqual(store.listEvents(runId, 0).map((e) => e.type), ["stage", "done"]);
  assert.equal(doneCount(runId), 1);
  assert.equal(store.getPublication(runId), undefined);
});

test("finalizeCleanupFailure 不能产生 succeeded", () => {
  const runId = createTask();
  const lease = claim(runId);
  assert.equal(codeOf(() => store.finalizeCleanupFailure(lease, {
    status: "succeeded" as any,
    cleanupId: "cleanup-failure-2",
    trigger: "engine_error",
    platform: "linux",
    errorCode: "CLEANUP_REPORT_INVALID",
    doneEvent: done(runId, "succeeded"),
  })), "CLEANUP_SUCCESS_FORBIDDEN");
  assert.equal(store.getTask(runId)!.status, "running");
  assert.equal(cleanupRowCount(), 0);
});

test("sealed=0 不得授权 succeeded：终态 failed 后旧 lease 再提交被围栏拒绝", () => {
  const runId = createTask();
  const lease = claim(runId);
  store.finalizeCleanupFailure(lease, {
    status: "failed",
    cleanupId: "cleanup-failure-3",
    trigger: "engine_error",
    platform: "linux",
    errorCode: "CLEANUP_REPORT_INVALID",
    doneEvent: done(runId, "failed"),
  });
  assert.equal(store.getCleanupReport(runId, lease.attempt)?.sealed, false);
  const report = cleanupReport(runId, lease.attempt);
  const res = store.finalizeWithCleanup(lease, {
    status: "succeeded",
    report,
    doneEvent: done(runId, "succeeded"),
  });
  assert.equal(res.fenced, true);
  assert.equal(store.getTask(runId)!.status, "failed");
  assert.equal(doneCount(runId), 1);
});

test("未 seal（未冻结）报告拒绝，不能伪造 overallOk", () => {
  const runId = createTask();
  const lease = claim(runId);
  const sealed = cleanupReport(runId, lease.attempt);
  const unsealed = JSON.parse(JSON.stringify(sealed));
  assert.equal(codeOf(() => store.finalizeWithCleanup(lease, {
    status: "succeeded",
    report: unsealed,
    doneEvent: done(runId, "succeeded"),
  })), "CLEANUP_REPORT_UNSEALED");

  const forged = deepFreeze({
    ...sealed,
    checks: {
      ...sealed.checks,
      docker: { ...sealed.checks.docker, status: "pending", reason: "CLEANUP_BUSY" },
    },
    overallOk: true,
  });
  assert.equal(codeOf(() => store.finalizeWithCleanup(lease, {
    status: "succeeded",
    report: forged as any,
    doneEvent: done(runId, "succeeded"),
  })), "CLEANUP_REPORT_INCONSISTENT");

  const optionalDsh = deepFreeze({
    ...sealed,
    checks: {
      ...sealed.checks,
      dsh: { ...sealed.checks.dsh, required: false },
    },
  });
  assert.equal(codeOf(() => store.finalizeWithCleanup(lease, {
    status: "succeeded",
    report: optionalDsh as any,
    doneEvent: done(runId, "succeeded"),
  })), "CLEANUP_REPORT_INVALID");
  assert.equal(cleanupRowCount(), 0);
  assert.equal(doneCount(runId), 0);
});

test("报告 JSON 超限拒绝且无写入", () => {
  const runId = createTask();
  const lease = claim(runId);
  const sealed = cleanupReport(runId, lease.attempt);
  const huge = deepFreeze({ ...sealed, extra: "x".repeat(70 * 1024) });
  assert.equal(codeOf(() => store.finalizeWithCleanup(lease, {
    status: "succeeded",
    report: huge as any,
    doneEvent: done(runId, "succeeded"),
  })), "CLEANUP_REPORT_TOO_LARGE");
  assert.equal(cleanupRowCount(), 0);
});

test("done 状态不匹配拒绝且无写入", () => {
  const runId = createTask();
  const lease = claim(runId);
  const report = cleanupReport(runId, lease.attempt);
  assert.equal(codeOf(() => store.finalizeWithCleanup(lease, {
    status: "succeeded",
    report,
    doneEvent: done(runId, "failed"),
  })), "CLEANUP_DONE_INVALID");
  assert.equal(cleanupRowCount(), 0);
  assert.equal(doneCount(runId), 0);
});

test("已有 publication 时全事务回滚，不复用旧发布记录", () => {
  const runId = createTask();
  const lease = claim(runId);
  store.recordPublication(runId, "reports/tester/old.html");
  const report = cleanupReport(runId, lease.attempt);
  assert.equal(codeOf(() => store.finalizeWithCleanup(lease, {
    status: "succeeded",
    report,
    doneEvent: done(runId, "succeeded"),
    publication: { reportPath: "reports/tester/new.html" },
  })), "CLEANUP_PUBLICATION_ALREADY_EXISTS");
  assert.equal(store.getTask(runId)!.status, "running");
  assert.equal(cleanupRowCount(), 0);
  assert.equal(doneCount(runId), 0);
  assert.deepEqual(store.listEvents(runId, 0).map((e) => e.type), ["stage"]);
  assert.equal(store.getPublication(runId)?.report_path, "reports/tester/old.html");
});

test("已有 report 事件时拒绝，report 事件必须由最终事务写入", () => {
  const runId = createTask();
  const lease = claim(runId);
  store.appendEvent(lease, "report", { path: "reports/tester/legacy.html" });
  const report = cleanupReport(runId, lease.attempt);
  assert.equal(codeOf(() => store.finalizeWithCleanup(lease, {
    status: "succeeded",
    report,
    doneEvent: done(runId, "succeeded"),
    publication: { reportPath: "reports/tester/new.html" },
  })), "CLEANUP_REPORT_EVENT_ALREADY_EXISTS");
  assert.equal(store.getTask(runId)!.status, "running");
  assert.equal(cleanupRowCount(), 0);
  assert.equal(doneCount(runId), 0);
  assert.equal(store.getPublication(runId), undefined);
  assert.deepEqual(store.listEvents(runId, 0).map((e) => e.type), ["stage", "report"]);
});

test("旧 SQLite 数据库兼容：补表不覆盖历史任务/事件/publication", () => {
  const legacy = new Database(":memory:");
  try {
    seedLegacyDatabase(legacy);
    const legacyStore = new TaskStore(legacy);
    assertLegacyRows(legacyStore);
    const table = legacy
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cleanup_reports'")
      .get() as { name: string } | undefined;
    assert.equal(table?.name, "cleanup_reports");
    // 旧任务仍可被新接口读取为空报告（不伪造历史清理证据）
    assert.equal(legacyStore.getCleanupReport(LEGACY_RUN_ID, 1), undefined);
  } finally {
    legacy.close();
  }
});

test("旧 SQLite 文件库：升级补表后重复打开仍正确，历史行不变", () => {
  const dir = mkdtempSync(join(tmpdir(), "c2b21-legacy-reopen-"));
  const dbPath = join(dir, "legacy.db");
  try {
    const seedDb = new Database(dbPath);
    try {
      seedLegacyDatabase(seedDb);
    } finally {
      seedDb.close();
    }

    for (let i = 0; i < 2; i++) {
      const reopened = new Database(dbPath);
      try {
        const reopenedStore = new TaskStore(reopened);
        assertLegacyRows(reopenedStore);
        const tables = reopened
          .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='cleanup_reports'")
          .get() as { n: number };
        assert.equal(tables.n, 1, `open #${i + 1} cleanup_reports table count`);
      } finally {
        reopened.close();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("事务中途失败后关闭并重新打开：无部分 cleanup/publication/done 残留", () => {
  const dir = mkdtempSync(join(tmpdir(), "c2b21-rollback-reopen-"));
  const dbPath = join(dir, "rollback.db");
  let first: Database.Database | null = null;
  try {
    first = new Database(dbPath);
    const firstStore = new TaskStore(first);
    const runId = firstStore.createTask({
      session_id: "s-reopen",
      user: "tester",
      question: "回滚重开",
    }).run_id;
    const lease = firstStore.claimLease(runId, "workerA", 90_000, 3600);
    assert.ok(lease);
    first.exec(`
      CREATE TRIGGER fail_done_reopen BEFORE INSERT ON events
      WHEN NEW.type = 'done'
      BEGIN SELECT RAISE(ABORT, 'forced done failure'); END;
    `);
    const report = cleanupReport(runId, lease.attempt);
    assert.throws(
      () => firstStore.finalizeWithCleanup(lease, {
        status: "succeeded",
        report,
        doneEvent: done(runId, "succeeded"),
        publication: { reportPath: "reports/tester/reopen.html" },
      }),
      /forced done failure/,
    );
    first.close();
    first = null;

    const reopened = new Database(dbPath);
    try {
      const reopenedStore = new TaskStore(reopened);
      const task = reopenedStore.getTask(runId)!;
      assert.equal(task.status, "running");
      assert.equal(task.lease_owner, "workerA");
      assert.equal(task.attempt, lease.attempt);
      assert.equal(reopenedStore.getCleanupReport(runId, lease.attempt), undefined);
      assert.equal(reopenedStore.getPublication(runId), undefined);
      assert.equal(
        (reopened.prepare("SELECT COUNT(*) AS n FROM events WHERE run_id=? AND type='done'")
          .get(runId) as { n: number }).n,
        0,
      );
      assert.deepEqual(reopenedStore.listEvents(runId, 0).map((e) => e.type), ["stage"]);
    } finally {
      reopened.close();
    }
  } finally {
    if (first) first.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
