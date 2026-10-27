// S4-B2-C2-B2-2B-2：Linux 真实隔离集成测试（无模型/DWS/正式服务）。
//
// 组成：真实 detached DSH 替身进程（JSON-RPC initialize/shutdown）+ 真实
// TaskCleanupCoordinator + 真实 SandboxContainerReaper + 真实 Docker 停止容器 +
// 真实 getfacl/ACL 状态目录 + 真实 CleanupAuditLog。
// 目的：证明 TaskRunner 主链路会在业务完成后移交终止权、由 Coordinator（而非旧
// finally）终止 DSH 进程组，并按精确 label/name/image 清掉本 attempt 的容器。
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { TaskStore } from "../store/task-store.ts";
import { TaskRunner, type TaskRunnerCleanupConfig, type TaskRunnerPaths } from "./task-runner.ts";
import type { BackendProvider, EngineSession, SessionOpts } from "../backends/dsh-backend.ts";
import { DshSdkClient, type DshCleanupHandle } from "../backends/dsh-sdk-client.ts";
import type { NormEvent } from "../backends/dsh-events.ts";
import { SandboxContainerReaper } from "./sandbox-container-reaper.ts";
import { CleanupAuditLog } from "./cleanup-audit.ts";

function commandWorks(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function skipReason(): string | null {
  if (process.platform !== "linux") return "linux only";
  if (!commandWorks("getfacl", ["--version"])) return "getfacl unavailable";
  if (!commandWorks("flock", ["--version"])) return "flock unavailable";
  const id = commandWorks("docker", [
    "image",
    "inspect",
    process.env.SANDBOX_IMAGE || "dataplat-script:m0",
    "--format",
    "{{.Id}}",
  ]);
  if (!id || !/^sha256:[0-9a-f]{64}$/i.test(id)) return "trusted Docker image unavailable";
  return null;
}

const SKIP = skipReason();

const DSH_CHILD = String.raw`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: m.id, result: { serverInfo: { name: "fake-dsh", version: "1" } }
    }) + "\n");
  } else if (m.method === "shutdown") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} }) + "\n");
    setTimeout(() => process.exit(0), 20);
  }
});
setInterval(() => {}, 1000);
`;

// 应答 shutdown 但拒绝退出：用于制造“DSH 进程组仍存活”的 Runner-lock 窗口。
const DSH_CHILD_IGNORE_SHUTDOWN = String.raw`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: m.id, result: { serverInfo: { name: "fake-dsh-stubborn", version: "1" } }
    }) + "\n");
  } else if (m.method === "shutdown") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} }) + "\n");
  }
});
setInterval(() => {}, 1000);
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface IntegrationHarness {
  root: string;
  aclDir: string;
  paths: TaskRunnerPaths;
  cleanup: TaskRunnerCleanupConfig;
  clientRef: { client: DshSdkClient | null; handle: DshCleanupHandle | null; cancelCount: number };
  backend: BackendProvider;
}

async function makeHarness(
  t: TestContext,
  imageId: string,
  childScript = DSH_CHILD,
): Promise<IntegrationHarness> {
  const root = mkdtempSync(join(tmpdir(), "c2b22b2-linux-"));
  chmodSync(root, 0o700);
  const auditDir = join(root, "audit");
  const lockDir = join(root, "cleanup-locks");
  const aclDir = join(root, "acl-state");
  mkdirSync(auditDir, { mode: 0o700 });
  mkdirSync(lockDir, { mode: 0o700 });
  mkdirSync(aclDir, { mode: 0o700 });
  const paths: TaskRunnerPaths = {
    workroot: join(root, "work"),
    resultsRoot: join(root, "results"),
    assetsDir: join(root, "assets"),
    runnerPath: join(root, "run_in_sandbox.sh"),
    skillsDir: join(root, "skills"),
    reportsRoot: join(root, "published"),
  };
  mkdirSync(paths.assetsDir, { recursive: true });
  const auditLog = await CleanupAuditLog.open({
    trustedRuntimeRoot: root,
    auditLogPath: join(auditDir, "cleanup-audit.jsonl"),
    platform: "linux",
  });
  t.after(async () => {
    await auditLog.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  });
  const reaper = new SandboxContainerReaper({
    trustedImageId: imageId,
    trustedRuntimeRoot: root,
    cleanupLockDir: lockDir,
    auditLogPath: join(auditDir, "container-reaper-audit.jsonl"),
  });
  const clientRef: IntegrationHarness["clientRef"] = { client: null, handle: null, cancelCount: 0 };

  const backend: BackendProvider = {
    id: "real-dsh-handle-fake-child",
    async createSession(opts: SessionOpts): Promise<EngineSession> {
      mkdirSync(join(opts.workroot, opts.sessionId, "workdir"), { recursive: true });
      mkdirSync(join(opts.resultsRoot, opts.sessionId, "results"), { recursive: true });
      const client = new DshSdkClient({
        cwd: join(opts.workroot, opts.sessionId, "workdir"),
        env: { SANDBOX_ACL_STATE_DIR: aclDir },
        command: process.execPath,
        args: ["-e", childScript],
        initTimeoutMs: 3_000,
      });
      await client.start({ provider: "fake", model: "fake" });
      clientRef.client = client;
      clientRef.handle = client.cleanupHandle();
      const session: EngineSession = {
        async *ask(): AsyncGenerator<NormEvent> {
          yield { type: "stage", stage: "analyzing" };
          yield { type: "answer", markdown: "集成测试结论" };
        },
        async cancel(): Promise<void> {
          clientRef.cancelCount += 1;
          await client.kill();
        },
        cleanupHandle: () => clientRef.handle,
        lastUsage: () => null,
      };
      return session;
    },
  };

  const cleanup: TaskRunnerCleanupConfig = {
    platform: "linux",
    aclStateDir: aclDir,
    timeBudgetMs: 8_000,
    reaper,
    audit: auditLog,
    gracefulMs: 300,
    killMs: 1_000,
    runnerDrainMs: 100,
    activeProbeIntervalMs: 10,
  };
  return { root, aclDir, paths, cleanup, clientRef, backend };
}

test("真实 detached DSH 替身 + 真实 Docker 停止容器：Coordinator 终止进程组并精确清容器", { skip: SKIP ?? false }, async (t) => {
  const imageId = commandWorks("docker", [
    "image",
    "inspect",
    process.env.SANDBOX_IMAGE || "dataplat-script:m0",
    "--format",
    "{{.Id}}",
  ])!;
  const h = await makeHarness(t, imageId);
  const db = new Database(":memory:");
  t.after(() => db.close());
  const store = new TaskStore(db, Date.now, { cleanupHoldMode: true });
  const runId = store.createTask({ session_id: "s-linux", user: "tester", question: "真实清理" }).run_id;
  const containerName = `${runId}-a1-${process.pid}`;
  let containerId = "";
  let cleanupContainer = true;
  t.after(() => {
    if (!cleanupContainer) return;
    try { execFileSync("docker", ["rm", "-f", containerName], { stdio: "ignore" }); } catch { /* gone */ }
  });

  // 只 create 不 start：active 探针不会误判 Runner 仍在执行，但 cleanup 必须按精确
  // labels/name/image 找到并删除这个本 attempt 的停止容器。
  containerId = execFileSync("docker", [
    "create",
    "--name", containerName,
    "--label", "com.dpit.gateway.managed=true",
    "--label", `com.dpit.gateway.task.run_id=${runId}`,
    "--label", "com.dpit.gateway.task.attempt=1",
    imageId,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  assert.match(containerId, /^[0-9a-f]{12,64}$/i);

  const runner = new TaskRunner(store, h.backend, {
    workerId: "linux-isolated-worker",
    taskBudgetS: 3600,
    maxAttempts: 3,
    heartbeatIntervalMs: 10_000,
    leaseTtlMs: 90_000,
    reportCheck: { minBytes: 10 },
    paths: h.paths,
    cleanup: h.cleanup,
  });

  await runner.runOnce(runId);

  const task = store.getTask(runId)!;
  assert.equal(
    task.status,
    "succeeded",
    cleanupFailureDiagnostic(store, runId),
  );
  const report = store.getCleanupReport(runId, 1)!;
  assert.equal(report.sealed, true);
  assert.equal(report.overall_ok, true, cleanupFailureDiagnostic(store, runId));
  assert.equal(report.report!.checks.dsh.status, "passed");
  assert.equal(report.report!.checks.runner.status, "passed");
  assert.equal(report.report!.checks.docker.status, "passed");
  assert.equal(report.report!.checks.acl.status, "passed");
  assert.equal(report.report!.checks.audit.status, "passed");
  assert.equal(report.report!.checks.docker.evidence.dockerFound, 1);
  assert.equal(report.report!.checks.docker.evidence.dockerCleaned, 1);
  assert.equal(store.getCleanupHold(runId, 1)!.state, "closed");
  assert.equal(h.clientRef.cancelCount, 0, "终止权移交后旧 finally 不得调用 cancel");
  assert.equal(h.clientRef.client!.hasExited, true, "Coordinator 必须真正结束 DSH 替身进程");

  let stillThere = false;
  try {
    execFileSync("docker", ["inspect", "--format", "{{.Id}}", containerId], { stdio: "ignore" });
    stillThere = true;
  } catch {
    stillThere = false;
  }
  assert.equal(stillThere, false, "精确归属的停止容器必须被 Coordinator/reaper 删除");
  cleanupContainer = false; // 已无可删
  assert.equal(existsSync(join(h.root, "cleanup-locks", `${runId}-a1.reaper.lock`)), false);
});

test("Host Runner 持有同源 flock：Coordinator 不向 DSH 进程组发信号，任务安全失败", { skip: SKIP ?? false }, async (t) => {
  const imageId = commandWorks("docker", [
    "image",
    "inspect",
    process.env.SANDBOX_IMAGE || "dataplat-script:m0",
    "--format",
    "{{.Id}}",
  ])!;
  const h = await makeHarness(t, imageId, DSH_CHILD_IGNORE_SHUTDOWN);
  h.cleanup.gracefulMs = 100;
  h.cleanup.killMs = 300;
  h.cleanup.runnerDrainMs = 30;
  h.cleanup.activeProbeIntervalMs = 5;
  h.cleanup.timeBudgetMs = 3_000;

  const db = new Database(":memory:");
  t.after(() => db.close());
  const store = new TaskStore(db, Date.now, { cleanupHoldMode: true });
  const runId = store.createTask({ session_id: "s1", user: "tester", question: "runner lock" }).run_id;
  const workdir = join(h.paths.workroot, "s1", "workdir");
  mkdirSync(workdir, { recursive: true });
  const key = createHash("sha256").update(realpathSync(workdir)).digest("hex").slice(0, 16);
  const lockPath = join(h.aclDir, `${key}.lock`);

  const holder = spawn("flock", ["-n", lockPath, "sh", "-c", "printf HELD\\n; sleep 20"], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  let dshPid = 0;
  t.after(() => {
    try { if (holder.pid) process.kill(-holder.pid, "SIGKILL"); } catch { /* gone */ }
    killDshGroup(h, dshPid);
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("flock holder did not acquire")), 2_000);
    holder.stdout?.on("data", (d) => {
      if (String(d).includes("HELD")) {
        clearTimeout(timer);
        resolve();
      }
    });
    holder.once("error", reject);
  });

  const runner = new TaskRunner(store, h.backend, {
    workerId: "linux-lock-worker",
    taskBudgetS: 3600,
    maxAttempts: 3,
    heartbeatIntervalMs: 10_000,
    leaseTtlMs: 90_000,
    reportCheck: { minBytes: 10 },
    paths: h.paths,
    cleanup: h.cleanup,
  });
  await runner.runOnce(runId);
  dshPid = h.clientRef.handle?.identity?.pgid ?? 0;

  const task = store.getTask(runId)!;
  assert.equal(
    task.status,
    "failed",
    cleanupFailureDiagnostic(store, runId),
  );
  assert.equal(task.error_code, "CLEANUP_INCOMPLETE");
  const report = store.getCleanupReport(runId, 1)!;
  assert.equal(report.overall_ok, false, cleanupFailureDiagnostic(store, runId));
  assert.equal(report.report!.checks.dsh.status, "pending");
  assert.equal(report.report!.checks.dsh.reason, "RUNNER_LOCK_BUSY");
  assert.equal(report.report!.checks.runner.status, "pending");
  assert.equal(report.report!.checks.docker.status, "pending");
  assert.equal(report.report!.checks.acl.status, "pending");
  assert.equal(h.clientRef.cancelCount, 0, "移交后旧 finally 不得抢杀");
  assert.equal(h.clientRef.client!.hasExited, false);
  assert.doesNotThrow(() => process.kill(dshPid, 0), "Runner 锁存在时 DSH 进程组必须仍存活");
  await sleep(20);
});

const DSH_CHILD_ACTIVE_PROMPT = String.raw`
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: m.id, result: { serverInfo: { name: "fake-dsh-active", version: "1" } }
    }) + "\n");
  } else if (m.method === "session/prompt") {
    spawn("flock", [
      "-n", process.env.TEST_LOCK_PATH,
      "sh", "-c", 'printf locked > "$TEST_MARKER"; sleep 30',
    ], { stdio: "ignore", env: process.env });
    // 故意不返回 turn/end：模拟 in-flight prompt。
  } else if (m.method === "shutdown") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} }) + "\n");
    // 应答但不退出：保留 DSH 进程组和 Runner flock 供安全断言。
  }
});
setInterval(() => {}, 1000);
`;

function killDshGroup(h: IntegrationHarness, fallbackPgid = 0): void {
  const pgid = fallbackPgid || h.clientRef.handle?.identity?.pgid || 0;
  if (pgid <= 1) return;
  try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ }
}

async function waitForFile(path: string, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!existsSync(path)) {
    if (Date.now() > end) throw new Error(`waitForFile timeout: ${path}`);
    await sleep(20);
  }
}

/** 失败时输出脱敏清理现场；不包含路径、env、命令或模型内容。 */
function cleanupFailureDiagnostic(store: TaskStore, runId: string): string {
  const task = store.getTask(runId);
  if (!task) return JSON.stringify({ task: null });
  const cleanup = store.getCleanupReport(runId, task.attempt);
  const report = cleanup?.report;
  const checks = report
    ? Object.fromEntries(
        (["dsh", "runner", "docker", "acl", "audit"] as const).map((key) => [
          key,
          {
            status: report.checks[key].status,
            reason: report.checks[key].reason,
            evidence: report.checks[key].evidence,
          },
        ]),
      )
    : null;
  return JSON.stringify(
    {
      task: {
        status: task.status,
        attempt: task.attempt,
        error_code: task.error_code,
      },
      cleanup: report ? { sealed: cleanup.sealed, overallOk: report.overallOk, checks } : null,
    },
    null,
    2,
  );
}


function makeActivePromptBackend(
  h: IntegrationHarness,
  store: TaskStore,
  lockPath: string,
  marker: string,
  promptTimeoutMs = 600_000,
): BackendProvider {
  return {
    id: "real-dsh-active-prompt",
    async createSession(opts: SessionOpts): Promise<EngineSession> {
      mkdirSync(join(opts.workroot, opts.sessionId, "workdir"), { recursive: true });
      mkdirSync(join(opts.resultsRoot, opts.sessionId, "results"), { recursive: true });
      const client = new DshSdkClient({
        cwd: join(opts.workroot, opts.sessionId, "workdir"),
        env: {
          SANDBOX_ACL_STATE_DIR: h.aclDir,
          TEST_LOCK_PATH: lockPath,
          TEST_MARKER: marker,
        },
        command: process.execPath,
        args: ["-e", DSH_CHILD_ACTIVE_PROMPT],
        initTimeoutMs: 3_000,
      });
      await client.start({ provider: "fake", model: "fake" });
      h.clientRef.client = client;
      h.clientRef.handle = client.cleanupHandle();
      const runId = opts.runId!;
      const session: EngineSession = {
        async *ask(): AsyncGenerator<NormEvent> {
          let promptSettled = false;
          client.prompt("fake-session", "long-running", promptTimeoutMs).then(
            () => { promptSettled = true; },
            () => { promptSettled = true; },
          );
          yield { type: "stage", stage: "analyzing" };
          while (!promptSettled && store.getTask(runId)?.cancel_requested !== 1) await sleep(20);
          if (!promptSettled) {
            yield { type: "stage", stage: "analyzing", text: "cancel-observed" };
            return;
          }
          yield { type: "error", code: "TIMEOUT", message: "prompt timed out" };
        },
        async cancel(): Promise<void> {
          h.clientRef.cancelCount += 1;
          await client.kill();
        },
        cleanupHandle: () => {
          // 必须每次重新取句柄：promptActive 是调用时快照，不能在 createSession 时缓存。
          h.clientRef.handle = client.cleanupHandle();
          return h.clientRef.handle;
        },
        lastUsage: () => null,
      };
      return session;
    },
  };
}

test("取消路径：不移交前 kill、不碰 Runner flock；promptActive 只进入 recovery_required", { skip: SKIP ?? false }, async (t) => {
  const imageId = commandWorks("docker", [
    "image",
    "inspect",
    process.env.SANDBOX_IMAGE || "dataplat-script:m0",
    "--format",
    "{{.Id}}",
  ])!;
  const h = await makeHarness(t, imageId);
  const db = new Database(":memory:");
  t.after(() => db.close());
  const store = new TaskStore(db, Date.now, { cleanupHoldMode: true });
  const runId = store.createTask({ session_id: "s1", user: "tester", question: "cancel safety" }).run_id;
  const workdir = join(h.paths.workroot, "s1", "workdir");
  mkdirSync(workdir, { recursive: true });
  const key = createHash("sha256").update(realpathSync(workdir)).digest("hex").slice(0, 16);
  const lockPath = join(h.aclDir, `${key}.lock`);
  const marker = join(h.root, "runner-lock-held.marker");
  let dshPgid = 0;
  t.after(() => killDshGroup(h, dshPgid));

  const backend = makeActivePromptBackend(h, store, lockPath, marker);
  const runner = new TaskRunner(store, backend, {
    workerId: "linux-cancel-worker",
    taskBudgetS: 3600,
    maxAttempts: 3,
    heartbeatIntervalMs: 10_000,
    leaseTtlMs: 90_000,
    reportCheck: { minBytes: 10 },
    paths: h.paths,
    cleanup: h.cleanup,
  });

  const runPromise = runner.runOnce(runId);
  await waitForFile(marker);
  store.requestCancel(runId);
  await runPromise;
  dshPgid = h.clientRef.handle?.identity?.pgid ?? 0;

  const task = store.getTask(runId)!;
  assert.equal(
    task.status,
    "cancelled",
    cleanupFailureDiagnostic(store, runId),
  );
  assert.equal(task.error_code, "CLEANUP_INCOMPLETE");
  assert.equal(h.clientRef.cancelCount, 0, "不得在 handoff 前调用旧 cancel");
  assert.equal(h.clientRef.client!.hasExited, false, "promptActive 时不得强杀 DSH 进程组");
  assert.equal(h.clientRef.client!.isTerminationOwned, true, "spawn 身份确认后必须提前锁死旧终止权");
  assert.doesNotThrow(() => process.kill(dshPgid, 0), "DSH 进程组必须仍存活");
  assert.equal(h.clientRef.handle!.promptActive, true);
  let lockFree = true;
  try {
    execFileSync("flock", ["-n", lockPath, "true"], { stdio: "ignore", timeout: 1_000 });
  } catch {
    lockFree = false;
  }
  assert.equal(lockFree, false, "Runner-like flock holder 必须仍然持锁（未被 SIGKILL）");

  const report = store.getCleanupReport(runId, 1)!;
  assert.equal(report.sealed, true);
  assert.equal(report.overall_ok, false, cleanupFailureDiagnostic(store, runId));
  assert.equal(report.report!.checks.dsh.status, "pending");
  assert.equal(report.report!.checks.dsh.reason, "PROMPT_ACTIVE");
  assert.equal(store.getCleanupHold(runId, 1)!.state, "recovery_required");
  assert.equal(
    store.listEvents(runId, 0).filter((e) => e.type === "done").length,
    1,
    "业务取消只产生 cancelled done，不伪造成功/失败 done",
  );
  assert.equal(store.listEvents(runId, 0).filter((e) => e.type === "done")[0]!.payload.status, "cancelled");

  killDshGroup(h, dshPgid);
});

test("DSH 内部 prompt timeout 不得绕过 Runner flock：提前终止权使 killTree 失效", { skip: SKIP ?? false }, async (t) => {
  const imageId = commandWorks("docker", [
    "image",
    "inspect",
    process.env.SANDBOX_IMAGE || "dataplat-script:m0",
    "--format",
    "{{.Id}}",
  ])!;
  const h = await makeHarness(t, imageId);
  const db = new Database(":memory:");
  t.after(() => db.close());
  const store = new TaskStore(db, Date.now, { cleanupHoldMode: true });
  const runId = store.createTask({ session_id: "s1", user: "tester", question: "prompt timeout safety" }).run_id;
  const workdir = join(h.paths.workroot, "s1", "workdir");
  mkdirSync(workdir, { recursive: true });
  const key = createHash("sha256").update(realpathSync(workdir)).digest("hex").slice(0, 16);
  const lockPath = join(h.aclDir, `${key}.lock`);
  const marker = join(h.root, "runner-lock-held.marker");
  let dshPgid = 0;
  t.after(() => killDshGroup(h, dshPgid));

  const backend = makeActivePromptBackend(h, store, lockPath, marker, 1_000);
  const runner = new TaskRunner(store, backend, {
    workerId: "linux-timeout-worker",
    taskBudgetS: 3600,
    maxAttempts: 3,
    heartbeatIntervalMs: 10_000,
    leaseTtlMs: 90_000,
    reportCheck: { minBytes: 10 },
    paths: h.paths,
    cleanup: h.cleanup,
  });

  await runner.runOnce(runId);
  dshPgid = h.clientRef.handle?.identity?.pgid ?? 0;

  const task = store.getTask(runId)!;
  assert.equal(
    task.status,
    "failed",
    cleanupFailureDiagnostic(store, runId),
  );
  assert.equal(task.error_code, "TIMEOUT");
  assert.equal(h.clientRef.cancelCount, 0);
  assert.equal(h.clientRef.client!.hasExited, false, "DSH 内部 timeout killTree 必须被终止权拦截");
  assert.equal(h.clientRef.client!.isTerminationOwned, true);
  assert.doesNotThrow(() => process.kill(dshPgid, 0), "DSH 进程组必须仍存活");
  let lockFree = true;
  try {
    execFileSync("flock", ["-n", lockPath, "true"], { stdio: "ignore", timeout: 1_000 });
  } catch {
    lockFree = false;
  }
  assert.equal(lockFree, false, "Runner-like flock holder 必须仍然持锁");
  const report = store.getCleanupReport(runId, 1)!;
  assert.equal(report.overall_ok, false, cleanupFailureDiagnostic(store, runId));
  assert.equal(report.report!.checks.dsh.status, "pending");
  assert.equal(report.report!.checks.dsh.reason, "RUNNER_LOCK_BUSY");
  assert.equal(store.getCleanupHold(runId, 1)!.state, "recovery_required");

  killDshGroup(h, dshPgid);
});
