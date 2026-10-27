// S4-B2-C2-B2-4：recover list/inspect 只读巡检测试。
// 所有 fixture 都在临时目录；CLI 只读；不调用 Docker/DSH/DWS，不修改数据库。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { inspectRecovery, openReadOnlyStore, parseArgs, runCli } from "./recover.mjs";

const SCHEMA = readFileSync(fileURLToPath(new URL("../src/store/schema.sql", import.meta.url)), "utf8");

function task(patch = {}) {
  return {
    run_id: "run-recovery",
    session_id: "sess-1",
    user: "tester",
    question: "q",
    status: "running",
    stage: null,
    attempt: 1,
    lease_owner: null,
    lease_expires_at: null,
    cancel_requested: 0,
    deadline: null,
    error_code: null,
    error_message: null,
    created_at: 1,
    updated_at: 2,
    ...patch,
  };
}

function hold(patch = {}) {
  return {
    run_id: "run-recovery",
    attempt: 1,
    state: "recovery_required",
    lease_owner: null,
    cleanup_id: null,
    retry_authorized: false,
    retry_trigger: null,
    reason: "BOOT_RECOVERY",
    created_at: 1,
    updated_at: 2,
    ...patch,
  };
}

function reportRow(patch = {}) {
  return {
    sealed: true,
    overall_ok: false,
    error_code: null,
    report: {
      checks: {
        dsh: { status: "pending", reason: "PROCESS_GROUP_STATE_UNKNOWN", evidence: { pid: 123, pgid: 123, startTicks: "9" } },
        runner: { status: "pending", reason: "PROCESS_GROUP_STATE_UNKNOWN", evidence: { pgid: 123 } },
        docker: { status: "pending", reason: "PROCESS_NOT_VERIFIED", evidence: {} },
        acl: { status: "pending", reason: "PROCESS_NOT_VERIFIED", evidence: {} },
        audit: { status: "passed", reason: "AUDIT_WRITTEN", evidence: {} },
      },
    },
    ...patch,
  };
}

function fakeStore(t, h, r) {
  return {
    getTask: (id) => (id === t.run_id ? t : undefined),
    getCleanupHold: (id, attempt) => (id === t.run_id && attempt === t.attempt ? h : undefined),
    getCleanupReport: (id, attempt) => (id === t.run_id && attempt === t.attempt ? r : undefined),
    listRecoveryRequired: () => (h && h.state === "recovery_required" ? [{ task: t, hold: h }] : []),
  };
}

const safeDeps = {
  inspectDsh: async () => ({ status: "ABSENT" }),
  inspectRunnerLock: async () => ({ status: "FREE" }),
  inspectDocker: async () => ({ status: "NONE", containers: [] }),
  inspectAcl: async () => ({ status: "PASSED", reason: "ACL_NO_65534_RESIDUAL", evidence: {} }),
  readProbeUnknown: async () => ({ status: "NONE", events: [] }),
};

function fixture({ withHold = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "recover-fx-"));
  const dbPath = join(dir, "gateway.db");
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  db.prepare(
    `INSERT INTO tasks
      (run_id, session_id, user, question, status, attempt, error_code, created_at, updated_at)
     VALUES (?, 'sess-1', 'tester', 'q', ?, 1, NULL, 1, 2)`,
  ).run("run-recovery", "running");
  db.prepare(
    `INSERT INTO tasks
      (run_id, session_id, user, question, status, attempt, error_code, created_at, updated_at)
     VALUES ('run-other', 'sess-2', 'tester', 'q', 'succeeded', 1, NULL, 1, 2)`,
  ).run();
  if (withHold) {
    db.prepare(
      `INSERT INTO cleanup_holds
        (run_id, attempt, state, lease_owner, cleanup_id, retry_authorized, retry_trigger, reason, created_at, updated_at)
       VALUES ('run-recovery', 1, 'recovery_required', NULL, NULL, 0, NULL, 'BOOT_RECOVERY', 1, 2)`,
    ).run();
  }
  db.close();
  return { dir, dbPath };
}

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("recover list：只显示 recovery_required；无任务时输出 NO_RECOVERY_REQUIRED", async () => {
  const f = fixture();
  try {
    let out = "";
    const code = await runCli(["list", "--db", f.dbPath, "--json"], {}, (s) => { out += s; });
    assert.equal(code, 0);
    const rows = JSON.parse(out);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].run_id, "run-recovery");
    assert.equal(rows[0].task_status, "running");
    assert.equal(rows[0].hold_status, "recovery_required");
    assert.equal(rows[0].cleanup_reason, "BOOT_RECOVERY");
    assert.equal(typeof rows[0].updated_at, "number");
    assert.equal(rows.some((x) => x.run_id === "run-other"), false);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }

  const empty = fixture({ withHold: false });
  try {
    let out = "";
    const code = await runCli(["list", "--db", empty.dbPath], {}, (s) => { out += s; });
    assert.equal(code, 0);
    assert.match(out, /NO_RECOVERY_REQUIRED/);
  } finally {
    rmSync(empty.dir, { recursive: true, force: true });
  }
});

test("recover inspect：report 缺失时 MANUAL_REVIEW_REQUIRED，资源 unknown 不推成安全", async () => {
  const t = task();
  const h = hold();
  const result = await inspectRecovery(fakeStore(t, h, null), t.run_id, {}, {
    ...safeDeps,
    inspectDsh: async () => ({ status: "UNKNOWN", reason: "DSH_IDENTITY_UNAVAILABLE" }),
    inspectRunnerLock: async () => ({ status: "UNKNOWN", reason: "RUNNER_LOCK_PROBE_UNAVAILABLE" }),
    inspectDocker: async () => ({ status: "UNKNOWN", reason: "DOCKER_PROBE_UNAVAILABLE", containers: [] }),
    inspectAcl: async () => ({ status: "UNKNOWN", reason: "ACL_PATHS_UNAVAILABLE" }),
  });
  assert.equal(result.readiness, "MANUAL_REVIEW_REQUIRED");
  assert.ok(result.blockers.includes("CLEANUP_REPORT_MISSING"));
  assert.ok(result.blockers.some((x) => x.startsWith("DSH_")));
  assert.ok(result.blockers.some((x) => x.startsWith("RUNNER_LOCK_")));
  assert.ok(result.blockers.some((x) => x.startsWith("DOCKER_")));
  assert.ok(result.blockers.some((x) => x.startsWith("ACL_")));
  assert.equal(result.report, null);
});

test("recover inspect：running + recovery 不得被当成可直接关闭 Hold", async () => {
  const t = task();
  const h = hold();
  const result = await inspectRecovery(fakeStore(t, h, reportRow()), t.run_id, {}, safeDeps);
  assert.equal(result.task.status, "running");
  assert.equal(result.hold?.state, "recovery_required");
  assert.equal(result.readiness, "MANUAL_REVIEW_REQUIRED");
  assert.ok(result.blockers.includes("TASK_NOT_TERMINAL_FOR_CLOSE"));
});

test("recover inspect：failed/cancelled 终态仍可保留 recovery 并独立展示", async () => {
  for (const status of ["failed", "cancelled"]) {
    const t = task({ status });
    const result = await inspectRecovery(fakeStore(t, hold(), reportRow()), t.run_id, {}, safeDeps);
    assert.equal(result.task.status, status);
    assert.equal(result.report?.sealed, true);
    assert.equal(result.readiness, "READY_FOR_MANUAL_REVIEW");
  }
});

test("recover inspect：没有 recovery hold 时明确 NOT_RECOVERY_REQUIRED", async () => {
  const t = task({ status: "succeeded" });
  const result = await inspectRecovery(fakeStore(t, null, reportRow({ sealed: true, overall_ok: true })), t.run_id, {}, safeDeps);
  assert.equal(result.hold, null);
  assert.equal(result.readiness, "NOT_RECOVERY_REQUIRED");
});

test("recover inspect：未完成/缺失 CleanupReport 不推断安全", async () => {
  const t = task();
  const result = await inspectRecovery(
    fakeStore(t, hold(), reportRow({ sealed: false, report: null })),
    t.run_id,
    {},
    safeDeps,
  );
  assert.equal(result.report?.sealed, false);
  assert.equal(result.report?.checks, null);
  assert.equal(result.readiness, "MANUAL_REVIEW_REQUIRED");
  assert.ok(result.blockers.includes("CLEANUP_REPORT_MISSING"));

  const incomplete = await inspectRecovery(
    fakeStore(
      t,
      hold(),
      reportRow({
        sealed: true,
        report: { checks: { dsh: { status: "passed", reason: "DSH_TERMINATED_VERIFIED", evidence: {} } } },
      }),
    ),
    t.run_id,
    {},
    safeDeps,
  );
  assert.equal(incomplete.readiness, "MANUAL_REVIEW_REQUIRED");
  assert.ok(incomplete.blockers.includes("CLEANUP_REPORT_MISSING"));
});

test("recover inspect：持续 unknown / ACL pending / Docker 存在均阻止 READY", async () => {
  const t = task();
  const result = await inspectRecovery(fakeStore(t, hold(), reportRow()), t.run_id, {}, {
    ...safeDeps,
    inspectDsh: async () => ({ status: "UNKNOWN", reason: "DSH_GROUP_STATE_UNKNOWN" }),
    inspectDocker: async () => ({ status: "PRESENT", containers: [{ id: "c1", labels: { "com.dpit.gateway.task.run_id": t.run_id } }] }),
    inspectAcl: async () => ({ status: "PENDING", reason: "ACL_RESTORE_PENDING_C3", evidence: {} }),
    readProbeUnknown: async () => ({ status: "FOUND", events: [{ ts: "t", phase: "dsh_wait", issues: [] }] }),
  });
  assert.equal(result.readiness, "MANUAL_REVIEW_REQUIRED");
  assert.ok(result.blockers.includes("DSH_UNKNOWN"));
  assert.ok(result.blockers.includes("DOCKER_PRESENT"));
  assert.ok(result.blockers.includes("ACL_PENDING"));
  assert.ok(result.blockers.includes("PROBE_UNKNOWN_FOUND"));
});

test("recover inspect：run_id 不存在返回 null（CLI 退出 1）", async () => {
  const f = fixture();
  try {
    const result = await inspectRecovery(fakeStore(task(), hold(), reportRow()), "run-nope", {}, safeDeps);
    assert.equal(result, null);
    let out = "";
    const code = await runCli(["inspect", "run-nope", "--db", f.dbPath], {}, (s) => { out += s; }, safeDeps);
    assert.equal(code, 1);
    assert.equal(out, "");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("recover inspect：读取扁平 cleanup_probe_unknown 审计，并阻止 READY", async () => {
  const dir = mkdtempSync(join(tmpdir(), "recover-audit-"));
  const auditLog = join(dir, "cleanup-audit.jsonl");
  try {
    const event = {
      ts: "2026-10-27T12:00:00.000Z",
      action: "cleanup_probe_unknown",
      phase: "dsh_wait",
      code: "PROCESS_GROUP_STATE_UNKNOWN",
      pgid: 123,
      issue_count: 8,
      issue_total: 10,
      truncated: true,
    };
    for (let i = 0; i < 8; i++) {
      event[`issue_${i}_pid`] = 7003 + i;
      event[`issue_${i}_code`] = "PROC_STAT_READ_FAILED";
      event[`issue_${i}_errno`] = "EIO";
    }
    writeFileSync(auditLog, JSON.stringify(event) + "\n");
    const t = task();
    const result = await inspectRecovery(
      fakeStore(t, hold(), reportRow()),
      t.run_id,
      { auditLog },
      {
        ...safeDeps,
        // 故意不注入 readProbeUnknown，走真实扁平审计解析。
        readProbeUnknown: undefined,
      },
    );
    assert.equal(result.recent_probe_unknown.status, "FOUND");
    assert.equal(result.recent_probe_unknown.events[0].issues.length, 8);
    assert.equal(result.recent_probe_unknown.events[0].issue_total, 10);
    assert.equal(result.recent_probe_unknown.events[0].truncated, true);
    assert.deepEqual(result.recent_probe_unknown.events[0].issues[0], {
      pid: 7003,
      code: "PROC_STAT_READ_FAILED",
      errno: "EIO",
    });
    assert.ok(result.blockers.includes("PROBE_UNKNOWN_FOUND"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recover CLI 只读：list/inspect 前后数据库哈希一致，不产生 -wal/-shm", async () => {
  const f = fixture();
  try {
    const ro = openReadOnlyStore(f.dbPath);
    assert.equal(ro.db.readonly, true, "CLI 数据库连接必须 readonly");
    ro.db.close();
    const before = hashFile(f.dbPath);
    await runCli(["list", "--db", f.dbPath], {}, () => {}, safeDeps);
    await runCli(["inspect", "run-recovery", "--db", f.dbPath], {}, () => {}, safeDeps);
    assert.equal(hashFile(f.dbPath), before);
    assert.equal(existsSync(`${f.dbPath}-wal`), false);
    assert.equal(existsSync(`${f.dbPath}-shm`), false);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("parseArgs：list/inspect 参数约束且 db 必须显式提供", () => {
  assert.throws(() => parseArgs(["list"], {}), /GW_DB_PATH/);
  assert.throws(() => parseArgs(["inspect", "run-1"], {}), /GW_DB_PATH/);
  assert.throws(() => parseArgs(["inspect"], { GW_DB_PATH: "x" }), /run_id/);
  assert.throws(() => parseArgs(["list", "extra"], { GW_DB_PATH: "x" }), /不接受/);
  const o = parseArgs(["inspect", "run-1", "--db", "x", "--json"], {});
  assert.equal(o.command, "inspect");
  assert.equal(o.runId, "run-1");
  assert.equal(o.json, true);
});
