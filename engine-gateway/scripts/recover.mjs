#!/usr/bin/env node
// S4-B2-C2-B2-4：Cleanup Recovery 只读巡检 CLI。
//
// 本文件只读：数据库用 readonly 连接，任何检查都不写 SQLite、不解除 hold、
// 不重试任务、不终止进程、不删除容器、不修改 ACL。
//
//   node scripts/recover.mjs list [--db <path>] [--json]
//   node scripts/recover.mjs inspect <run_id> [--db <path>] [--json]
//
// inspect 会尽量检查 DSH/进程组、Runner lock、Docker、ACL 与最近审计；任一
// 证据不足都明确输出 UNKNOWN / MANUAL_REVIEW_REQUIRED，不把 unknown 当 absent。

import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TaskStore } from "../src/store/task-store.ts";
import {
  isLiveLinuxState,
  parseLinuxProcStat,
  probeLinuxProcessGroupState,
} from "../src/orchestrator/process-termination.ts";
import { checkAclCleanup } from "../src/orchestrator/acl-cleanup-checker.ts";

const USAGE = `用法：
  node scripts/recover.mjs list [--db <path>] [--json]
  node scripts/recover.mjs inspect <run_id> [--db <path>] [--json]

数据库路径：--db 或 GW_DB_PATH（不设默认路径，避免误读生产库）
inspect 可选路径：
  --workroot <dir>      或 GW_WORKROOT
  --results-root <dir>  或 GW_RESULTS_ROOT
  --assets-dir <dir>    或 GW_ASSETS_DIR
  --acl-state-dir <dir> 或 SANDBOX_ACL_STATE_DIR
  --audit-log <file>    或 GATEWAY_CLEANUP_RUNTIME_ROOT/audit/cleanup-audit.jsonl

只读：不修改 SQLite、不解除 hold、不重试、不终止进程、不删除容器、不修改 ACL。`;

export class UsageError extends Error {}

function usageError(message) {
  throw new UsageError(message);
}

export function parseArgs(argv, env = process.env) {
  const out = { json: false, help: false, command: null, runId: null };
  const nextValue = (flag) => {
    const v = argv[++out._i];
    if (v === undefined || v.startsWith("--")) usageError(`${flag} 缺少参数值`);
    return v;
  };
  const positional = [];
  for (out._i = 0; out._i < argv.length; out._i++) {
    const a = argv[out._i];
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "--json") out.json = true;
    else if (a === "--db") out.db = nextValue(a);
    else if (a === "--workroot") out.workroot = nextValue(a);
    else if (a === "--results-root") out.resultsRoot = nextValue(a);
    else if (a === "--assets-dir") out.assetsDir = nextValue(a);
    else if (a === "--acl-state-dir") out.aclStateDir = nextValue(a);
    else if (a === "--audit-log") out.auditLog = nextValue(a);
    else if (a.startsWith("-")) usageError(`未知参数：${a}`);
    else positional.push(a);
  }
  delete out._i;
  if (out.help) return out;
  if (positional.length === 0) usageError("缺少命令：list 或 inspect");
  out.command = positional[0];
  if (out.command !== "list" && out.command !== "inspect") {
    usageError(`未知命令：${out.command}`);
  }
  if (out.command === "list") {
    if (positional.length !== 1) usageError("list 不接受 run_id");
  } else {
    if (positional.length !== 2) usageError("inspect 需要且只需要一个 run_id");
    out.runId = positional[1];
  }
  out.db = out.db ?? env.GW_DB_PATH;
  if (!out.db) usageError("必须通过 --db 或 GW_DB_PATH 指定只读数据库路径");
  out.workroot = out.workroot ?? env.GW_WORKROOT;
  out.resultsRoot = out.resultsRoot ?? env.GW_RESULTS_ROOT;
  out.assetsDir = out.assetsDir ?? env.GW_ASSETS_DIR;
  out.aclStateDir = out.aclStateDir ?? env.SANDBOX_ACL_STATE_DIR;
  out.auditLog = out.auditLog ?? (env.GATEWAY_CLEANUP_RUNTIME_ROOT
    ? join(env.GATEWAY_CLEANUP_RUNTIME_ROOT, "audit", "cleanup-audit.jsonl")
    : undefined);
  return out;
}

/** readonly 连接；TaskStore 构造只会在 schema 已存在时读表，不写数据库。 */
export function openReadOnlyStore(dbPath) {
  let db;
  try {
    db = new Database(resolve(dbPath), { readonly: true, fileMustExist: true, timeout: 5_000 });
    if (db.readonly !== true) {
      db.close();
      throw new Error("数据库连接不是 readonly");
    }
    const store = new TaskStore(db, Date.now, { cleanupHoldMode: true });
    return { db, store };
  } catch (err) {
    try { db?.close(); } catch { /* ignore */ }
    throw new Error(`数据库不可只读打开：${err.message}`);
  }
}

export function listRecovery(store, limit = 100) {
  return store.listRecoveryRequired(limit).map(({ task, hold }) => ({
    run_id: task.run_id,
    task_status: task.status,
    hold_status: hold.state,
    cleanup_reason: hold.reason,
    updated_at: hold.updated_at,
  }));
}

function procIdentity(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    return { ok: true, stat: parseLinuxProcStat(pid, raw) };
  } catch (e) {
    if (e?.code === "ENOENT" || e?.code === "ESRCH") return { ok: true, stat: null };
    return { ok: false, code: e?.code ?? "PROC_STAT_READ_FAILED" };
  }
}

async function inspectDsh(identity, deps) {
  if (deps.inspectDsh) return deps.inspectDsh(identity);
  if (
    !identity ||
    !Number.isSafeInteger(identity.pid) ||
    !Number.isSafeInteger(identity.pgid) ||
    typeof identity.startTicks !== "string" ||
    !identity.startTicks
  ) {
    return { status: "UNKNOWN", reason: "DSH_IDENTITY_UNAVAILABLE" };
  }
  let group;
  try {
    group = await probeLinuxProcessGroupState(identity.pgid);
  } catch {
    return { status: "UNKNOWN", reason: "DSH_GROUP_PROBE_ERROR", pid: identity.pid, pgid: identity.pgid, startTicks: identity.startTicks };
  }
  const current = procIdentity(identity.pid);
  if (!current.ok) {
    return { status: "UNKNOWN", reason: "DSH_PROC_READ_FAILED", pid: identity.pid, pgid: identity.pgid, startTicks: identity.startTicks };
  }
  if (current.stat && (current.stat.pgid !== identity.pgid || current.stat.startTicks !== identity.startTicks)) {
    return { status: "UNKNOWN", reason: "DSH_IDENTITY_MISMATCH", pid: identity.pid, pgid: identity.pgid, startTicks: identity.startTicks };
  }
  if (group === "absent" && current.stat && isLiveLinuxState(current.stat.state)) {
    return { status: "UNKNOWN", reason: "DSH_STATE_INCONSISTENT", pid: identity.pid, pgid: identity.pgid, startTicks: identity.startTicks };
  }
  return {
    status: group === "absent" ? "ABSENT" : group === "exists" ? "EXISTS" : "UNKNOWN",
    reason: group === "unknown" ? "DSH_GROUP_STATE_UNKNOWN" : undefined,
    pid: identity.pid,
    pgid: identity.pgid,
    startTicks: identity.startTicks,
  };
}

function inspectRunnerLock(task, opts, deps) {
  if (deps.inspectRunnerLock) return deps.inspectRunnerLock(task, opts);
  if (!opts.workroot || !opts.aclStateDir) {
    return { status: "UNKNOWN", reason: "RUNNER_LOCK_PATHS_UNAVAILABLE" };
  }
  const workdir = join(opts.workroot, task.session_id, "workdir");
  let real;
  try {
    real = realpathSync(workdir);
  } catch {
    return { status: "UNKNOWN", reason: "RUNNER_WORKDIR_UNAVAILABLE" };
  }
  const key = createHash("sha256").update(real).digest("hex").slice(0, 16);
  const lockPath = join(opts.aclStateDir, `${key}.lock`);
  if (!existsSync(lockPath)) {
    return { status: "NOT_PRESENT", reason: "RUNNER_LOCK_FILE_MISSING", lock_path: lockPath };
  }
  const r = spawnSync("lsof", ["-nP", "-t", lockPath], {
    encoding: "utf8",
    timeout: 3_000,
    windowsHide: true,
  });
  if (r.error || (r.status !== 0 && r.status !== 1)) {
    return { status: "UNKNOWN", reason: "RUNNER_LOCK_PROBE_UNAVAILABLE", lock_path: lockPath };
  }
  if (r.status === 1 && String(r.stderr ?? "").trim()) {
    return { status: "UNKNOWN", reason: "RUNNER_LOCK_PROBE_UNAVAILABLE", lock_path: lockPath };
  }
  const pids = String(r.stdout ?? "").trim().split(/\s+/).filter(Boolean).map(Number).filter(Number.isSafeInteger);
  if (pids.length === 0) return { status: "FREE", lock_path: lockPath };
  const holders = pids.map((pid) => {
    const st = procIdentity(pid);
    return st.ok && st.stat
      ? { pid, state: st.stat.state, pgid: st.stat.pgid, startTicks: st.stat.startTicks }
      : { pid, state: "UNKNOWN" };
  });
  return { status: "HELD", lock_path: lockPath, holders };
}

function dockerLabels(raw) {
  const labels = {};
  for (const part of String(raw ?? "").split(",")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const k = part.slice(0, idx);
    if (
      k === "com.dpit.gateway.managed" ||
      k === "com.dpit.gateway.task.run_id" ||
      k === "com.dpit.gateway.task.attempt"
    ) {
      labels[k] = part.slice(idx + 1);
    }
  }
  return labels;
}

function inspectDocker(task, opts, deps) {
  if (deps.inspectDocker) return deps.inspectDocker(task, opts);
  const r = spawnSync(
    "docker",
    [
      "ps", "-a",
      "--filter", `label=com.dpit.gateway.task.run_id=${task.run_id}`,
      "--format", "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Labels}}",
    ],
    { encoding: "utf8", timeout: 5_000, windowsHide: true },
  );
  if (r.error || r.status !== 0) {
    return { status: "UNKNOWN", reason: "DOCKER_PROBE_UNAVAILABLE", containers: [] };
  }
  const containers = String(r.stdout ?? "").trim().split("\n").filter(Boolean).map((line) => {
    const [id, name, image, status, labels] = line.split("\t");
    return {
      id: id ?? null,
      name: name ?? null,
      image: image ?? null,
      status: status ?? null,
      labels: dockerLabels(labels),
    };
  });
  return containers.length === 0
    ? { status: "NONE", containers: [] }
    : { status: "PRESENT", containers };
}

async function inspectAcl(task, opts, deps) {
  if (deps.inspectAcl) return deps.inspectAcl(task, opts);
  if (!opts.workroot || !opts.assetsDir || !opts.aclStateDir) {
    return { status: "UNKNOWN", reason: "ACL_PATHS_UNAVAILABLE" };
  }
  if (!opts.resultsRoot) return { status: "UNKNOWN", reason: "ACL_RESULTS_PATH_UNAVAILABLE" };
  try {
    const r = await checkAclCleanup({
      workdir: join(opts.workroot, task.session_id, "workdir"),
      resultsDir: join(opts.resultsRoot, task.session_id, "results"),
      assetsDir: opts.assetsDir,
      aclStateDir: opts.aclStateDir,
    });
    return {
      status: r.status.toUpperCase(),
      reason: r.reason,
      evidence: r.evidence,
    };
  } catch (err) {
    return { status: "UNKNOWN", reason: "ACL_CHECK_ERROR" };
  }
}

function parseAuditEvents(file, pgid) {
  if (!file) return { status: "UNKNOWN", reason: "AUDIT_LOG_PATH_UNAVAILABLE", events: [] };
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { status: "UNKNOWN", reason: "AUDIT_LOG_UNAVAILABLE", events: [] };
  }
  if (!Number.isSafeInteger(pgid)) {
    return { status: "UNKNOWN", reason: "AUDIT_PGID_UNAVAILABLE", events: [] };
  }
  const events = [];
  let invalid = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { invalid += 1; continue; }
    if (e?.action !== "cleanup_probe_unknown" || e.pgid !== pgid) continue;
    const issues = [];
    const included = Number.isSafeInteger(e.issue_count) ? Math.min(e.issue_count, 8) : 0;
    for (let i = 0; i < included; i++) {
      const pid = e[`issue_${i}_pid`];
      const code = e[`issue_${i}_code`];
      if (pid === undefined && code === undefined) continue;
      issues.push({
        pid: pid ?? null,
        code: code ?? null,
        ...(e[`issue_${i}_errno`] ? { errno: e[`issue_${i}_errno`] } : {}),
      });
    }
    const total = Number.isSafeInteger(e.issue_total) ? e.issue_total : issues.length;
    events.push({
      ts: e.ts ?? null,
      phase: e.phase ?? null,
      code: e.code ?? null,
      pgid: e.pgid,
      issues,
      issue_total: total,
      truncated: e.truncated === true,
    });
  }
  if (invalid > 0) {
    return { status: "UNKNOWN", reason: "AUDIT_LOG_CORRUPT", events: events.slice(-5), invalid_lines: invalid };
  }
  return events.length ? { status: "FOUND", events: events.slice(-5) } : { status: "NONE", events: [] };
}

function readiness(hold, taskStatus, reportValid, dsh, runnerLock, docker, acl, probe) {
  if (!hold) return { status: "NOT_RECOVERY_REQUIRED", blockers: [] };
  if (hold.state !== "recovery_required") {
    return { status: "NOT_RECOVERY_REQUIRED", blockers: [] };
  }
  const blockers = [];
  if (taskStatus !== "failed" && taskStatus !== "cancelled") {
    blockers.push("TASK_NOT_TERMINAL_FOR_CLOSE");
  }
  if (!reportValid) blockers.push("CLEANUP_REPORT_MISSING");
  if (dsh.status !== "ABSENT") blockers.push(`DSH_${dsh.status}`);
  if (runnerLock.status !== "FREE") blockers.push(`RUNNER_LOCK_${runnerLock.status}`);
  if (docker.status !== "NONE") blockers.push(`DOCKER_${docker.status}`);
  if (acl.status !== "PASSED") blockers.push(`ACL_${acl.status}`);
  if (probe.status !== "NONE") blockers.push(`PROBE_UNKNOWN_${probe.status}`);
  return {
    status: blockers.length === 0 ? "READY_FOR_MANUAL_REVIEW" : "MANUAL_REVIEW_REQUIRED",
    blockers,
  };
}

export async function inspectRecovery(store, runId, opts = {}, deps = {}) {
  const task = store.getTask(runId);
  if (!task) return null;
  const hold = store.getCleanupHold(task.run_id, task.attempt) ?? null;
  let reportRow = null;
  let reportError = null;
  try {
    reportRow = store.getCleanupReport(task.run_id, task.attempt) ?? null;
  } catch (err) {
    reportError = err?.code ?? "CLEANUP_REPORT_INVALID";
  }
  const report = reportRow?.report ?? null;
  const checks =
    report && typeof report.checks === "object" && report.checks !== null && !Array.isArray(report.checks)
      ? Object.fromEntries(
          ["dsh", "runner", "docker", "acl", "audit"].map((key) => {
            const check = report.checks[key];
            return [
              key,
              check
                ? { status: check.status, reason: check.reason, evidence: check.evidence ?? {} }
                : { status: "UNKNOWN", reason: "CLEANUP_CHECK_MISSING", evidence: {} },
            ];
          }),
        )
      : null;
  const checkKeys = ["dsh", "runner", "docker", "acl", "audit"];
  const checksComplete =
    checks !== null &&
    checkKeys.every((key) => {
      const check = report?.checks?.[key];
      return check && typeof check.status === "string" && typeof check.reason === "string";
    });
  const reportValid = reportRow?.sealed === true && checksComplete;
  const identity = checks?.dsh?.evidence ?? null;
  const dsh = await inspectDsh(identity, deps);
  const runnerLock = await inspectRunnerLock(task, opts, deps);
  const docker = await inspectDocker(task, opts, deps);
  const acl = await inspectAcl(task, opts, deps);
  const probe = deps.readProbeUnknown
    ? await deps.readProbeUnknown(opts, identity)
    : parseAuditEvents(opts.auditLog, identity?.pgid);
  const ready = readiness(hold, task.status, reportValid, dsh, runnerLock, docker, acl, probe);
  return {
    run_id: task.run_id,
    task: {
      status: task.status,
      attempt: task.attempt,
      error_code: task.error_code,
      updated_at: task.updated_at,
    },
    hold: hold
      ? { state: hold.state, reason: hold.reason, updated_at: hold.updated_at, attempt: hold.attempt }
      : null,
    report: reportRow
      ? {
          sealed: reportRow.sealed,
          overall_ok: reportRow.overall_ok,
          error_code: reportRow.error_code,
          checks,
        }
      : null,
    report_error: reportError,
    dsh,
    runner_lock: runnerLock,
    docker,
    acl,
    recent_probe_unknown: probe,
    readiness: ready.status,
    blockers: ready.blockers,
  };
}

function formatList(items) {
  if (items.length === 0) return "NO_RECOVERY_REQUIRED\n";
  const lines = [
    `# Recovery required (${items.length})`,
    "| run_id | task_status | hold | reason | updated_at |",
    "|---|---|---|---|---|",
  ];
  for (const x of items) {
    lines.push(`| ${x.run_id} | ${x.task_status} | ${x.hold_status} | ${x.cleanup_reason ?? "—"} | ${new Date(x.updated_at).toISOString()} |`);
  }
  return lines.join("\n") + "\n";
}

function formatInspect(x) {
  const lines = [
    `# Recovery inspect ${x.run_id}`,
    `- task_status: ${x.task.status}`,
    `- attempt: ${x.task.attempt}`,
    `- task_error_code: ${x.task.error_code ?? "—"}`,
    `- hold: ${x.hold ? `${x.hold.state} (reason=${x.hold.reason ?? "—"})` : "NONE"}`,
    `- report: ${x.report ? `sealed=${x.report.sealed} overall_ok=${x.report.overall_ok}` : "MISSING"}`,
    `- dsh: ${x.dsh.status}${x.dsh.reason ? ` (${x.dsh.reason})` : ""}`,
    `- dsh_identity: pid=${x.dsh.pid ?? "—"} pgid=${x.dsh.pgid ?? "—"} startTicks=${x.dsh.startTicks ?? "—"}`,
    `- runner_lock: ${x.runner_lock.status}${x.runner_lock.reason ? ` (${x.runner_lock.reason})` : ""}`,
    `- runner_lock_path: ${x.runner_lock.lock_path ?? "—"}`,
    `- runner_lock_holders: ${x.runner_lock.holders?.length ? JSON.stringify(x.runner_lock.holders) : "—"}`,
    `- docker: ${x.docker.status}`,
    `- acl: ${x.acl.status}${x.acl.reason ? ` (${x.acl.reason})` : ""}`,
    `- acl_evidence: ${JSON.stringify(x.acl.evidence ?? {})}`,
    `- recent_probe_unknown: ${x.recent_probe_unknown.status}${x.recent_probe_unknown.reason ? ` (${x.recent_probe_unknown.reason})` : ""}`,
    `- readiness: ${x.readiness}`,
    `- blockers: ${x.blockers.length ? x.blockers.join(", ") : "—"}`,
  ];
  if (x.report?.checks) {
    lines.push("", "## Cleanup checks");
    for (const [k, v] of Object.entries(x.report.checks)) {
      lines.push(`- ${k}: ${v.status} (${v.reason})`);
    }
  }
  if (x.docker.containers.length) {
    lines.push("", "## Docker containers");
    for (const c of x.docker.containers) {
      lines.push(`- ${c.id} ${c.name} image=${c.image} status=${c.status} labels=${JSON.stringify(c.labels)}`);
    }
  }
  if (x.runner_lock.holders?.length) {
    lines.push("", `## Runner lock holders: ${JSON.stringify(x.runner_lock.holders)}`);
  }
  if (x.recent_probe_unknown.events.length) {
    lines.push("", "## Recent cleanup_probe_unknown");
    for (const e of x.recent_probe_unknown.events) {
      lines.push(
        `- ${e.ts ?? "—"} phase=${e.phase ?? "—"} issues=${JSON.stringify(e.issues)}` +
          ` issue_total=${e.issue_total ?? e.issues.length} truncated=${e.truncated === true}`,
      );
    }
  }
  return lines.join("\n") + "\n";
}

export async function runCli(argv, env = process.env, write = (s) => process.stdout.write(s), deps = {}) {
  const opts = parseArgs(argv, env);
  if (opts.help) { write(USAGE + "\n"); return 0; }
  const { db, store } = openReadOnlyStore(opts.db);
  try {
    if (opts.command === "list") {
      const items = listRecovery(store);
      write(opts.json ? JSON.stringify(items, null, 2) + "\n" : formatList(items));
      return 0;
    }
    const result = await inspectRecovery(store, opts.runId, opts, deps);
    if (!result) {
      process.stderr.write(`RUN_NOT_FOUND: ${opts.runId}\n`);
      return 1;
    }
    write(opts.json ? JSON.stringify(result, null, 2) + "\n" : formatInspect(result));
    return 0;
  } finally {
    db.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runCli(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => {
      if (err instanceof UsageError) {
        process.stderr.write(`${err.message}\n\n${USAGE}\n`);
        process.exitCode = 2;
      } else {
        process.stderr.write(`RECOVER_ERROR: ${err?.message ?? String(err)}\n`);
        process.exitCode = 1;
      }
    },
  );
}
