// S4-B2-C2-B2-2B：TaskCleanupCoordinator 独立实现测试。
// 使用真实 detached 子进程验证进程组；Docker 通过注入 reaper 测试（真实 Docker 在
// sandbox-container-reaper.test.ts 的隔离用例）。不调用模型/DWS/正式服务。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TaskCleanupCoordinator,
  type CleanupFence,
  type CoordinatorAudit,
  type TaskCleanupCoordinatorResult,
} from "./task-cleanup-coordinator.ts";
import {
  captureProcessIdentity,
  probeLinuxProcessGroupState,
  type ProcessGroupProbeResult,
  type ProcessIdentity,
} from "./process-termination.ts";
import type { DshCleanupHandle } from "../backends/dsh-sdk-client.ts";
import type {
  SandboxActiveProbeResult,
  SandboxCleanupResult,
} from "./sandbox-container-reaper.ts";
import type { AclCleanupDeps, AclCleanupResult } from "./acl-cleanup-checker.ts";
import { CleanupAuditLog } from "./cleanup-audit.ts";
import { prepareTrustedRuntime } from "../config/trusted-runtime.ts";

let seq = 0;

class FakeAudit implements CoordinatorAudit {
  auditOk = true;
  failureCount = 0;
  eventCount = 0;
  events: Record<string, unknown>[] = [];
  failCode: string | null = null;

  async append(event: Record<string, unknown>): Promise<{ ok: boolean; code?: string }> {
    this.events.push(event);
    if (this.failCode) {
      this.auditOk = false;
      this.failureCount += 1;
      return { ok: false, code: this.failCode };
    }
    this.eventCount += 1;
    return { ok: true };
  }
}

function okProbe(): SandboxActiveProbeResult {
  return { ok: true, active: 0, mismatches: 0, containers: [] };
}

function okCleanup(): SandboxCleanupResult {
  return {
    ok: true,
    busy: false,
    runId: "run",
    attempt: 1,
    found: 0,
    cleaned: [],
    stopped: [],
    forced: [],
    mismatches: [],
    warnings: [],
    errors: [],
    containers: [],
  };
}

function fakeReaper(
  probe: SandboxActiveProbeResult = okProbe(),
  cleanup: SandboxCleanupResult = okCleanup(),
): {
  reaper: { probeActive: () => Promise<SandboxActiveProbeResult>; cleanup: () => Promise<SandboxCleanupResult> };
  calls: { probe: number; cleanup: number };
} {
  const calls = { probe: 0, cleanup: 0 };
  return {
    calls,
    reaper: {
      probeActive: async () => {
        calls.probe += 1;
        return probe;
      },
      cleanup: async () => {
        calls.cleanup += 1;
        return cleanup;
      },
    },
  };
}

function okAcl(): AclCleanupResult {
  return {
    status: "passed",
    required: true,
    reason: "ACL_NO_65534_RESIDUAL",
    evidence: {
      platform: "linux",
      aclStateFiles: 0,
      aclResidualEntries: 0,
      aclVerifiedWith: "getfacl",
    },
  };
}

function stateDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "c2b22b-coord-"));
  chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function baseOptions(
  dir: string,
  reaper: ReturnType<typeof fakeReaper>["reaper"],
  audit: CoordinatorAudit,
  overrides: Record<string, unknown> = {},
): any {
  seq += 1;
  return {
    runId: `run-c2b22b-${seq}`,
    attempt: 1,
    trigger: "task_success",
    platform: "linux",
    cleanupId: `cleanup-c2b22b-${seq}`,
    paths: {
      workdir: dir,
      resultsDir: dir,
      assetsDir: dir,
      aclStateDir: dir,
    },
    reaper,
    audit,
    aclChecker: async () => okAcl(),
    fence: { check: () => true },
    timeBudgetMs: 5_000,
    gracefulMs: 80,
    killMs: 1_000,
    runnerDrainMs: 40,
    activeProbeIntervalMs: 10,
    ...overrides,
  };
}

function probeResult(
  state: ProcessGroupProbeResult["state"],
  issues: ProcessGroupProbeResult["issues"] = [],
): ProcessGroupProbeResult {
  return {
    pgid: 4242,
    state,
    scanned: 1,
    unreadableCount: issues.length,
    issues,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(cond: () => boolean, ms = 2_000, what = "condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`waitFor timeout: ${what}`);
    await sleep(10);
  }
}

const READY_TIMEOUT_MS = 5_000;

/** 等待子进程完成脚本初始化并显式发送 READY；提前退出/超时都直接失败。 */
async function waitForReady(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("message", onMessage);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      fn();
    };
    const onMessage = (message: unknown) => {
      if (message === "READY") finish(resolve);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(() =>
        reject(
          new Error(
            `child exited before READY (pid=${child.pid ?? "unknown"} code=${code} signal=${signal})`,
          ),
        ),
      );
    };
    const onError = (err: Error) => finish(() => reject(err));
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new Error(
              `timeout waiting for READY (pid=${child.pid ?? "unknown"}, ${READY_TIMEOUT_MS}ms)`,
            ),
          ),
        ),
      READY_TIMEOUT_MS,
    );
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
    if (child.exitCode !== null || child.signalCode !== null) {
      onExit(child.exitCode, child.signalCode);
    }
  });
}

async function spawnDetached(script: string): Promise<{ child: ChildProcess; identity: ProcessIdentity }> {
  // IPC 用于 READY handshake。READY 由子进程脚本末尾在 SIGTERM handler 安装完成后发送，
  // 父测试必须在收到 READY 后才允许 Coordinator 进入终止流程。
  const child = spawn(process.execPath, ["-e", `${script}\n;process.send?.("READY");`], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const ready = waitForReady(child);
  void ready.catch(() => undefined); // 身份采集失败路径也必须消费 rejection
  let identity: ProcessIdentity | null = null;
  try {
    await waitFor(() => typeof child.pid === "number" && child.pid > 1, 2_000, "child pid");
    identity = await captureProcessIdentity(child.pid!);
    await ready;
    return { child, identity };
  } catch (err) {
    // 仅回收本次 spawn 的测试子进程；不触碰任何其他进程。
    if (identity) killGroup(identity);
    else if (child.pid) {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
    await ready.catch(() => undefined);
    throw err;
  }
}

function killGroup(identity: ProcessIdentity): void {
  try {
    process.kill(-identity.pgid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

/** 非阻塞 flock 探测；不存在的锁文件不会被“创建成功”误判。 */
function flockProbe(lockPath: string): boolean {
  if (!existsSync(lockPath)) return false;
  try {
    execFileSync("flock", ["-n", lockPath, "true"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function procSnapshot(pid: number): string {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = raw.lastIndexOf(")");
    const tail = raw.slice(close + 1).trim().split(/\s+/);
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8")
      .split("\0")
      .filter(Boolean)
      .join(" ");
    return `pid=${pid} state=${tail[0]} ppid=${tail[1]} pgid=${tail[2]} startTicks=${tail[19]} cmd=${cmdline}`;
  } catch (e) {
    return `pid=${pid} unreadable (${e instanceof Error ? e.message : String(e)})`;
  }
}

function lockDiagnostics(lockPath: string): string {
  let pids: number[] = [];
  try {
    const out = execFileSync("lsof", ["-nP", "-t", lockPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    pids = out.trim().split(/\s+/).filter(Boolean).map(Number).filter(Number.isSafeInteger);
  } catch {
    // 无 holder 或 lsof 不可用；后面 ps 仍会输出
  }
  const holderLines = pids.map(procSnapshot).join("\n") || "(lsof 未报告 lock holder)";
  let fdLines = "";
  for (const pid of pids) {
    try {
      const out = execFileSync("lsof", ["-nP", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      fdLines += out
        .split("\n")
        .filter((line) => line.startsWith("COMMAND") || line.includes(lockPath))
        .join("\n");
      fdLines += "\n";
    } catch {
      fdLines += `pid=${pid} lsof unavailable\n`;
    }
  }
  let psLines = "";
  try {
    psLines = execFileSync("ps", ["-eo", "pid,ppid,pgid,stat,lstart,args"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .filter((line) => line.includes(lockPath))
      .join("\n");
  } catch {
    psLines = "(ps unavailable)";
  }
  return [
    `lockPath=${lockPath}`,
    `exists=${existsSync(lockPath)}`,
    `flockProbe=${flockProbe(lockPath)}`,
    "holders:",
    holderLines,
    "fd:",
    fdLines.trim() || "(none)",
    "ps:",
    psLines || "(no matching process)",
  ].join("\n");
}

/** 等待 Coordinator 的 lock holder 完全退出并释放 FD；超时保留现场并失败。 */
async function waitForFlockRelease(
  lockPath: string,
  timeoutMs = 2_000,
  intervalMs = 20,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (flockProbe(lockPath)) return;
    await sleep(intervalMs);
  }
  throw new Error(`flock 未在 ${timeoutMs}ms 内释放\n${lockDiagnostics(lockPath)}`);
}

function coordinatorDiagnostics(
  result: TaskCleanupCoordinatorResult,
  extra: { identity?: ProcessIdentity | null; lockPath?: string | null } = {},
): string {
  const report = result.report;
  const checks = report
    ? Object.fromEntries(
        (["dsh", "runner", "docker", "acl", "audit"] as const).map((key) => [
          key,
          { status: report.checks[key].status, reason: report.checks[key].reason },
        ]),
      )
    : null;
  return JSON.stringify(
    {
      overallOk: result.overallOk,
      sealed: result.sealed,
      fenced: result.fenced,
      terminationOwned: result.terminationOwned,
      failureCode: result.failureCode ?? null,
      reason: result.reason ?? null,
      checks,
      dshIdentity: extra.identity ?? null,
      runnerLock: extra.lockPath
        ? {
            path: extra.lockPath,
            flockProbe: flockProbe(extra.lockPath),
            diagnostics: lockDiagnostics(extra.lockPath),
          }
        : null,
    },
    null,
    2,
  );
}

async function assertWithDiagnostics(
  t: { diagnostic: (message: string) => void },
  result: TaskCleanupCoordinatorResult,
  extra: { identity?: ProcessIdentity | null; lockPath?: string | null },
  assertions: () => void | Promise<void>,
): Promise<void> {
  try {
    await assertions();
  } catch (err) {
    try {
      t.diagnostic(coordinatorDiagnostics(result, extra));
    } catch {
      /* diagnostic 本身不得掩盖原始失败 */
    }
    throw err;
  }
}

function dshHandle(
  identity: ProcessIdentity,
  child: ChildProcess,
  aclStateDir: string | null,
  requestShutdown: () => Promise<boolean>,
): { handle: DshCleanupHandle; state: { owned: boolean; shutdowns: number } } {
  const state = { owned: false, shutdowns: 0 };
  return {
    state,
    handle: {
      identity,
      child,
      promptActive: false,
      hasExited: false,
      aclStateDir,
      requestShutdown: async () => {
        state.shutdowns += 1;
        return requestShutdown();
      },
      markTerminationOwned: () => {
        state.owned = true;
      },
      isTerminationOwned: () => state.owned,
    },
  };
}

test("ACL getfacl 超时按剩余预算三分，避免三路扫描越过总预算", async (t) => {
  const dir = stateDir(t);
  const r = fakeReaper();
  const audit = new FakeAudit();
  let deps: AclCleanupDeps | undefined;
  const result = await new TaskCleanupCoordinator(
    baseOptions(dir, r.reaper, audit, {
      timeBudgetMs: 300,
      aclChecker: async (_target, d) => {
        deps = d;
        return okAcl();
      },
    }),
  ).run();
  assert.equal(result.overallOk, true);
  assert.ok(deps?.getfaclTimeoutMs !== undefined);
  assert.ok(deps!.getfaclTimeoutMs! > 0);
  assert.ok(deps!.getfaclTimeoutMs! <= 100);
});

test("Host Runner ACL 收尾窗口：Runner 持有 .lock 时不得向 DSH 进程组发信号", async (t) => {
  const dir = stateDir(t);
  const { child, identity } = await spawnDetached(
    'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000);',
  );
  const key = createHash("sha256").update(realpathSync(dir)).digest("hex").slice(0, 16);
  const lockPath = join(dir, `${key}.lock`);
  const holder = spawn("flock", ["-n", lockPath, "sh", "-c", "printf HELD\\n; sleep 10"], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  let held = false;
  holder.stdout?.on("data", (d) => {
    if (String(d).includes("HELD")) held = true;
  });
  const r = fakeReaper();
  const audit = new FakeAudit();
  try {
    await waitFor(() => held, 2_000, "runner lock held");
    const { handle } = dshHandle(identity, child, dir, async () => false);
    const result = await new TaskCleanupCoordinator(
      baseOptions(dir, r.reaper, audit, { dsh: handle, gracefulMs: 20 }),
    ).run();
    assert.equal(result.overallOk, false);
    assert.equal(result.report?.checks.dsh.status, "pending");
    assert.equal(result.report?.checks.dsh.reason, "RUNNER_LOCK_BUSY");
    assert.equal(r.calls.cleanup, 0);
    assert.equal(await probeLinuxProcessGroupState(identity.pgid), "exists");
  } finally {
    try { if (holder.pid) process.kill(-holder.pid, "SIGKILL"); } catch { /* gone */ }
    killGroup(identity);
  }
});

test("Host Runner gate 取得锁后强杀 DSH，并在完成后释放锁", async (t) => {
  const dir = stateDir(t);
  const { child, identity } = await spawnDetached(
    'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000);',
  );
  const r = fakeReaper();
  const audit = new FakeAudit();
  try {
    const { handle } = dshHandle(identity, child, dir, async () => false);
    const result = await new TaskCleanupCoordinator(
      baseOptions(dir, r.reaper, audit, { dsh: handle, gracefulMs: 20 }),
    ).run();
    const key = createHash("sha256").update(realpathSync(dir)).digest("hex").slice(0, 16);
    const lockPath = join(dir, `${key}.lock`);
    await assertWithDiagnostics(t, result, { identity, lockPath }, async () => {
      assert.equal(result.overallOk, true);
      assert.equal(result.report?.checks.dsh.evidence.forced, true);
      // 锁 holder 完全退出后才算释放；等待有界，超时必须保留现场并失败。
      await waitForFlockRelease(lockPath);
    });
  } finally {
    killGroup(identity);
  }
});

test("fence 失权：不执行任何清理，不 seal", async (t) => {
  const dir = stateDir(t);
  const r = fakeReaper();
  const audit = new FakeAudit();
  const coordinator = new TaskCleanupCoordinator(baseOptions(dir, r.reaper, audit, {
    fence: { check: () => false },
  }));
  const result = await coordinator.run();
  assert.equal(result.fenced, true);
  assert.equal(result.report, null);
  assert.equal(result.terminationOwned, false);
  assert.equal(r.calls.cleanup, 0);
  assert.equal(r.calls.probe, 0);
});

test("fence heartbeat 失败：不执行清理、不 seal", async (t) => {
  const dir = stateDir(t);
  const r = fakeReaper();
  const audit = new FakeAudit();
  const result = await new TaskCleanupCoordinator(
    baseOptions(dir, r.reaper, audit, {
      fence: { check: () => true, heartbeat: () => false },
    }),
  ).run();
  assert.equal(result.fenced, true);
  assert.equal(result.report, null);
  assert.equal(r.calls.cleanup, 0);
});

test("Docker cleanup 查询失败：failed，不伪造成 passed", async (t) => {
  const dir = stateDir(t);
  const failedCleanup: SandboxCleanupResult = {
    ...okCleanup(),
    ok: false,
    reason: "DOCKER_QUERY_FAILED",
  };
  const r = fakeReaper(okProbe(), failedCleanup);
  const audit = new FakeAudit();
  let aclCalls = 0;
  const result = await new TaskCleanupCoordinator(
    baseOptions(dir, r.reaper, audit, {
      aclChecker: async () => {
        aclCalls += 1;
        return okAcl();
      },
    }),
  ).run();
  assert.equal(result.overallOk, false);
  assert.equal(result.report?.checks.docker.status, "failed");
  assert.equal(result.report?.checks.docker.reason, "DOCKER_QUERY_FAILED");
  assert.equal(result.report?.checks.acl.status, "pending");
  assert.equal(aclCalls, 0);
});

test("DSH 未 spawn：Docker + ACL + audit 通过时 report overallOk", async (t) => {
  const dir = stateDir(t);
  const r = fakeReaper();
  const audit = new FakeAudit();
  const coordinator = new TaskCleanupCoordinator(baseOptions(dir, r.reaper, audit));
  const result = await coordinator.run();
  assert.equal(result.sealed, true);
  assert.equal(result.overallOk, true);
  assert.equal(result.report?.checks.dsh.status, "not_applicable");
  assert.equal(result.report?.checks.runner.status, "not_applicable");
  assert.equal(result.report?.checks.docker.status, "passed");
  assert.equal(result.report?.checks.acl.status, "passed");
  assert.equal(result.report?.checks.audit.status, "passed");
  assert.equal(r.calls.cleanup, 1);
});

test("正常 graceful 退出：requestShutdown 后组消失，不升级强杀", async (t) => {
  const dir = stateDir(t);
  const { child, identity } = await spawnDetached(
    'process.on("SIGTERM",()=>process.exit(0)); setInterval(()=>{},1000);',
  );
  const r = fakeReaper();
  const audit = new FakeAudit();
  try {
    const { handle, state } = dshHandle(identity, child, dir, async () => {
      try {
        process.kill(identity.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
      return true;
    });
    const result = await new TaskCleanupCoordinator(
      baseOptions(dir, r.reaper, audit, { dsh: handle }),
    ).run();
    assert.equal(result.sealed, true);
    assert.equal(result.overallOk, true);
    assert.equal(result.report?.checks.dsh.status, "passed");
    assert.equal(result.report?.checks.dsh.evidence.forced, false);
    assert.equal(result.report?.checks.runner.status, "passed");
    assert.equal(result.terminationOwned, true);
    assert.equal(state.owned, true);
    assert.equal(state.shutdowns, 1);
    assert.equal(await probeLinuxProcessGroupState(identity.pgid), "absent");
  } finally {
    killGroup(identity);
  }
});

test("unknown 单次瞬时读取失败：预算内复核为 absent，不阻断正常清理", async (t) => {
  const dir = stateDir(t);
  const { child, identity } = await spawnDetached(
    'process.on("SIGTERM",()=>process.exit(0)); setInterval(()=>{},1000);',
  );
  const r = fakeReaper();
  const audit = new FakeAudit();
  let probes = 0;
  try {
    const { handle } = dshHandle(identity, child, dir, async () => false);
    const result = await new TaskCleanupCoordinator(
      baseOptions(dir, r.reaper, audit, {
        dsh: handle,
        gracefulMs: 20,
        probeGroupState: async () => {
          probes += 1;
          return probes === 1
            ? probeResult("unknown", [{ pid: 7001, code: "PROC_STAT_READ_FAILED", errno: "EIO" }])
            : probeResult("absent");
        },
      }),
    ).run();
    assert.equal(result.overallOk, true);
    assert.equal(result.report?.checks.dsh.status, "passed");
    assert.equal(probes, 3, "首次 unknown + 1 次复核 + final 完整探针");
    assert.equal(audit.events.some((e) => e.action === "cleanup_probe_unknown"), false);
  } finally {
    killGroup(identity);
  }
});

test("unknown 两次复核后恢复：最多 2 次复核仍成功", async (t) => {
  const dir = stateDir(t);
  const { child, identity } = await spawnDetached(
    'process.on("SIGTERM",()=>process.exit(0)); setInterval(()=>{},1000);',
  );
  const r = fakeReaper();
  const audit = new FakeAudit();
  let probes = 0;
  try {
    const { handle } = dshHandle(identity, child, dir, async () => false);
    const result = await new TaskCleanupCoordinator(
      baseOptions(dir, r.reaper, audit, {
        dsh: handle,
        gracefulMs: 20,
        probeGroupState: async () => {
          probes += 1;
          return probes <= 2 ? probeResult("unknown") : probeResult("absent");
        },
      }),
    ).run();
    assert.equal(result.overallOk, true);
    assert.equal(result.report?.checks.dsh.status, "passed");
    assert.equal(probes, 4, "unknown + 2 次复核 + final 完整探针");
    assert.equal(audit.events.some((e) => e.action === "cleanup_probe_unknown"), false);
  } finally {
    killGroup(identity);
  }
});

test("unknown 持续权限错误：最多 2 次复核后仍 pending，绝不发信号", async (t) => {
  const dir = stateDir(t);
  const { child, identity } = await spawnDetached(
    'process.on("SIGTERM",()=>process.exit(0)); setInterval(()=>{},1000);',
  );
  const r = fakeReaper();
  const audit = new FakeAudit();
  let probes = 0;
  try {
    const { handle } = dshHandle(identity, child, dir, async () => false);
    const result = await new TaskCleanupCoordinator(
      baseOptions(dir, r.reaper, audit, {
        dsh: handle,
        gracefulMs: 20,
        probeGroupState: async () => {
          probes += 1;
          return probeResult("unknown", [
            { pid: 7002, code: "PROC_STAT_READ_FAILED", errno: "EACCES" },
          ]);
        },
      }),
    ).run();
    assert.equal(result.overallOk, false);
    assert.equal(result.report?.checks.dsh.status, "pending");
    assert.equal(result.report?.checks.dsh.reason, "PROCESS_GROUP_STATE_UNKNOWN");
    assert.equal(probes, 3, "首次 unknown + 最多 2 次复核");
    assert.equal(r.calls.cleanup, 0);
    assert.doesNotThrow(() => process.kill(identity.pid, 0), "探针 unknown 不得发送信号");
    const unknownEvent = audit.events.find((e) => e.action === "cleanup_probe_unknown");
    assert.ok(unknownEvent, "unknown 必须留下脱敏审计");
    assert.equal(unknownEvent!.code, "PROCESS_GROUP_STATE_UNKNOWN");
    assert.equal(unknownEvent!.issue_count, 1);
    assert.equal(unknownEvent!.issue_0_pid, 7002);
    assert.equal(unknownEvent!.issue_0_code, "PROC_STAT_READ_FAILED");
    assert.equal(unknownEvent!.issue_0_errno, "EACCES");
    assert.equal(Object.values(unknownEvent!).some((v) => typeof v === "object"), false, "审计必须是扁平值");
  } finally {
    killGroup(identity);
  }
});

test("unknown 审计使用真实 CleanupAuditLog 可接受的扁平字段", async (t) => {
  const dir = stateDir(t);
  const rtDir = mkdtempSync(join(tmpdir(), "c2b22b-audit-unknown-"));
  t.after(() => rmSync(rtDir, { recursive: true, force: true }));
  const rt = await prepareTrustedRuntime({ root: join(rtDir, "runtime"), forbiddenRoots: [] });
  const logPath = join(rt.auditDir, "cleanup.jsonl");
  const log = await CleanupAuditLog.open({ trustedRuntimeRoot: rt.root, auditLogPath: logPath });
  const { child, identity } = await spawnDetached(
    'process.on("SIGTERM",()=>process.exit(0)); setInterval(()=>{},1000);',
  );
  const r = fakeReaper();
  try {
    const { handle } = dshHandle(identity, child, dir, async () => false);
    const result = await new TaskCleanupCoordinator(
      baseOptions(dir, r.reaper, log, {
        dsh: handle,
        gracefulMs: 20,
        probeGroupState: async () =>
          probeResult("unknown", [
            { pid: 7003, code: "PROC_STAT_READ_FAILED", errno: "EIO" },
            { pid: 7004, code: "PROC_STAT_READ_FAILED", errno: "EACCES" },
            { pid: 7005, code: "PROC_STAT_INVALID" },
            { pid: 7006, code: "PROC_STAT_READ_FAILED", errno: "EIO" },
            { pid: 7007, code: "PROC_STAT_READ_FAILED", errno: "EIO" },
            { pid: 7008, code: "PROC_STAT_READ_FAILED", errno: "EIO" },
            { pid: 7009, code: "PROC_STAT_READ_FAILED", errno: "EIO" },
            { pid: 7010, code: "PROC_STAT_READ_FAILED", errno: "EIO" },
            { pid: 7011, code: "PROC_STAT_READ_FAILED", errno: "EIO" },
            { pid: 7012, code: "PROC_STAT_READ_FAILED", errno: "EIO" },
          ]),
      }),
    ).run();
    assert.equal(result.overallOk, false);
    assert.equal(result.report?.checks.audit.status, "passed");
    await log.close();
    const events = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const event = events.find((e) => e.action === "cleanup_probe_unknown");
    assert.ok(event, "真实审计文件必须包含 cleanup_probe_unknown");
    assert.equal(event.issue_count, 8, "审计仅保留固定上限内的 issue 字段");
    assert.equal(event.issue_total, 10);
    assert.equal(event.truncated, true);
    assert.equal(event.issue_0_pid, 7003);
    assert.equal(event.issue_0_code, "PROC_STAT_READ_FAILED");
    assert.equal(event.issue_0_errno, "EIO");
    assert.equal(event.issue_7_pid, 7010);
    assert.equal(event.issue_8_pid, undefined, "截断后不得再写动态字段");
    assert.equal(Object.values(event).some((v) => typeof v === "object"), false, "审计必须是扁平值");
  } finally {
    await log.close().catch(() => {});
    killGroup(identity);
  }
});

test("unknown 复核期间 fence 失权：不发送信号，返回 fenced", async (t) => {
  const dir = stateDir(t);
  const { child, identity } = await spawnDetached(
    'process.on("SIGTERM",()=>process.exit(0)); setInterval(()=>{},1000);',
  );
  const r = fakeReaper();
  const audit = new FakeAudit();
  let fenceChecks = 0;
  try {
    const { handle } = dshHandle(identity, child, dir, async () => false);
    const result = await new TaskCleanupCoordinator(
      baseOptions(dir, r.reaper, audit, {
        dsh: handle,
        gracefulMs: 20,
        fence: {
          check: () => {
            fenceChecks += 1;
            return fenceChecks <= 2;
          },
        },
        probeGroupState: async () => probeResult("unknown"),
      }),
    ).run();
    assert.equal(result.fenced, true);
    assert.equal(result.report, null);
    assert.equal(r.calls.cleanup, 0);
    assert.doesNotThrow(() => process.kill(identity.pid, 0), "fence 失权后不得发送信号");
  } finally {
    killGroup(identity);
  }
});

test("graceful 超时：active 探针安全后 terminateAndVerify 强杀并验证组空", async (t) => {
  const dir = stateDir(t);
  const { child, identity } = await spawnDetached(
    'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000);',
  );
  const r = fakeReaper();
  const audit = new FakeAudit();
  try {
    const { handle } = dshHandle(identity, child, dir, async () => false);
    const result = await new TaskCleanupCoordinator(
      baseOptions(dir, r.reaper, audit, { dsh: handle, gracefulMs: 30 }),
    ).run();
    await assertWithDiagnostics(t, result, { identity }, async () => {
      assert.equal(result.overallOk, true);
      assert.equal(result.report?.checks.dsh.status, "passed");
      assert.equal(result.report?.checks.dsh.evidence.forced, true);
      assert.equal(await probeLinuxProcessGroupState(identity.pgid), "absent");
    });
  } finally {
    killGroup(identity);
  }
});

test("DSH leader 丢失且组仍有活进程：pending，不发信号", async (t) => {
  const dir = stateDir(t);
  const script = `
    const {spawn}=require("node:child_process");
    spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});
    setTimeout(()=>process.exit(0),50);
  `;
  const { child, identity } = await spawnDetached(script);
  const r = fakeReaper();
  const audit = new FakeAudit();
  try {
    await waitFor(() => child.exitCode !== null, 2_000, "leader exit");
    const { handle } = dshHandle(identity, child, dir, async () => false);
    const result = await new TaskCleanupCoordinator(
      baseOptions(dir, r.reaper, audit, { dsh: handle, gracefulMs: 50 }),
    ).run();
    assert.equal(result.sealed, true);
    assert.equal(result.overallOk, false);
    assert.equal(result.report?.checks.dsh.status, "pending");
    assert.equal(result.report?.checks.dsh.reason, "PROCESS_LEADER_GONE_UNVERIFIABLE");
    assert.equal(result.report?.checks.runner.status, "pending");
    assert.equal(await probeLinuxProcessGroupState(identity.pgid), "exists");
    assert.equal(r.calls.cleanup, 0);
  } finally {
    killGroup(identity);
  }
});

test("终止权移交失败：pending，不继续任何清理", async (t) => {
  const dir = stateDir(t);
  const r = fakeReaper();
  const audit = new FakeAudit();
  const handle: DshCleanupHandle = {
    identity: null,
    child: {} as ChildProcess,
    promptActive: false,
    hasExited: false,
    aclStateDir: dir,
    requestShutdown: async () => false,
    markTerminationOwned: () => { throw new Error("ownership handoff failed"); },
    isTerminationOwned: () => false,
  };
  const result = await new TaskCleanupCoordinator(
    baseOptions(dir, r.reaper, audit, { dsh: handle }),
  ).run();
  assert.equal(result.overallOk, false);
  assert.equal(result.terminationOwned, false);
  assert.equal(result.report?.checks.dsh.status, "pending");
  assert.equal(result.report?.checks.dsh.reason, "TERMINATION_OWNERSHIP_UNPROVEN");
  assert.equal(r.calls.cleanup, 0);
});

test("DSH 身份缺失：pending，不发信号但先接管终止权", async (t) => {
  const dir = stateDir(t);
  const { child, identity } = await spawnDetached(
    'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000);',
  );
  const r = fakeReaper();
  const audit = new FakeAudit();
  try {
    const state = { owned: false };
    const handle: DshCleanupHandle = {
      identity: null,
      child,
      promptActive: false,
      hasExited: false,
      aclStateDir: dir,
      requestShutdown: async () => false,
      markTerminationOwned: () => { state.owned = true; },
      isTerminationOwned: () => state.owned,
    };
    const result = await new TaskCleanupCoordinator(
      baseOptions(dir, r.reaper, audit, { dsh: handle }),
    ).run();
    assert.equal(result.overallOk, false);
    assert.equal(result.report?.checks.dsh.status, "pending");
    assert.equal(result.report?.checks.dsh.reason, "PROCESS_IDENTITY_UNVERIFIABLE");
    assert.equal(state.owned, true);
    assert.equal(r.calls.cleanup, 0);
    assert.equal(await probeLinuxProcessGroupState(identity.pgid), "exists");
  } finally {
    killGroup(identity);
  }
});

test("PID/PGID/startTicks 不一致：failed，不发信号", async (t) => {
  const dir = stateDir(t);
  const { child, identity } = await spawnDetached(
    'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000);',
  );
  const r = fakeReaper();
  const audit = new FakeAudit();
  try {
    const wrong: ProcessIdentity = { ...identity, startTicks: "0" };
    const { handle } = dshHandle(wrong, child, dir, async () => false);
    const result = await new TaskCleanupCoordinator(
      baseOptions(dir, r.reaper, audit, { dsh: handle, gracefulMs: 20 }),
    ).run();
    assert.equal(result.overallOk, false);
    assert.equal(result.report?.checks.dsh.status, "failed");
    assert.equal(result.report?.checks.dsh.reason, "PROCESS_IDENTITY_MISMATCH");
    assert.equal(await probeLinuxProcessGroupState(identity.pgid), "exists");
  } finally {
    killGroup(identity);
  }
});

test("active Runner 存在：不向 DSH 进程组发信号", async (t) => {
  const dir = stateDir(t);
  const { child, identity } = await spawnDetached(
    'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000);',
  );
  const active: SandboxActiveProbeResult = {
    ok: true,
    active: 1,
    mismatches: 0,
    containers: [],
  };
  const r = fakeReaper(active);
  const audit = new FakeAudit();
  try {
    const { handle } = dshHandle(identity, child, dir, async () => false);
    const result = await new TaskCleanupCoordinator(
      baseOptions(dir, r.reaper, audit, {
        dsh: handle,
        gracefulMs: 20,
        runnerDrainMs: 20,
      }),
    ).run();
    assert.equal(result.overallOk, false);
    assert.equal(result.report?.checks.dsh.status, "pending");
    assert.equal(result.report?.checks.dsh.reason, "CLEANUP_RUNNER_ACTIVE");
    assert.equal(result.report?.checks.runner.status, "pending");
    assert.equal(r.calls.cleanup, 0);
    assert.equal(await probeLinuxProcessGroupState(identity.pgid), "exists");
  } finally {
    killGroup(identity);
  }
});

test("Docker 探针失败：pending，不调用 cleanup/ACL", async (t) => {
  const dir = stateDir(t);
  const failedProbe: SandboxActiveProbeResult = {
    ok: false,
    active: 0,
    mismatches: 0,
    reason: "DOCKER_QUERY_FAILED",
    containers: [],
  };
  const r = fakeReaper(failedProbe);
  const audit = new FakeAudit();
  let aclCalls = 0;
  const result = await new TaskCleanupCoordinator(
    baseOptions(dir, r.reaper, audit, {
      aclChecker: async () => {
        aclCalls += 1;
        return okAcl();
      },
    }),
  ).run();
  assert.equal(result.overallOk, false);
  assert.equal(result.report?.checks.docker.status, "pending");
  assert.equal(result.report?.checks.docker.reason, "DOCKER_PROBE_UNVERIFIED");
  assert.equal(result.report?.checks.acl.status, "pending");
  assert.equal(r.calls.cleanup, 0);
  assert.equal(aclCalls, 0);
});

test("CLEANUP_BUSY：docker pending，ACL 不扫描", async (t) => {
  const dir = stateDir(t);
  const busy: SandboxCleanupResult = { ...okCleanup(), ok: false, busy: true, reason: "CLEANUP_BUSY" };
  const r = fakeReaper(okProbe(), busy);
  const audit = new FakeAudit();
  let aclCalls = 0;
  const result = await new TaskCleanupCoordinator(
    baseOptions(dir, r.reaper, audit, {
      aclChecker: async () => {
        aclCalls += 1;
        return okAcl();
      },
    }),
  ).run();
  assert.equal(result.overallOk, false);
  assert.equal(result.report?.checks.docker.status, "pending");
  assert.equal(result.report?.checks.docker.reason, "CLEANUP_BUSY");
  assert.equal(result.report?.checks.acl.status, "pending");
  assert.equal(aclCalls, 0);
});

test("Docker 所有权不匹配：failed，ACL 不扫描", async (t) => {
  const dir = stateDir(t);
  const mismatch: SandboxCleanupResult = {
    ...okCleanup(),
    ok: false,
    mismatches: ["container mismatch"],
  };
  const r = fakeReaper(okProbe(), mismatch);
  const audit = new FakeAudit();
  let aclCalls = 0;
  const result = await new TaskCleanupCoordinator(
    baseOptions(dir, r.reaper, audit, {
      aclChecker: async () => {
        aclCalls += 1;
        return okAcl();
      },
    }),
  ).run();
  assert.equal(result.overallOk, false);
  assert.equal(result.report?.checks.docker.status, "failed");
  assert.equal(result.report?.checks.docker.reason, "OWNERSHIP_MISMATCH");
  assert.equal(result.report?.checks.acl.status, "pending");
  assert.equal(aclCalls, 0);
});

test("ACL 残留：failed，不伪造成 passed", async (t) => {
  const dir = stateDir(t);
  const r = fakeReaper();
  const audit = new FakeAudit();
  const result = await new TaskCleanupCoordinator(
    baseOptions(dir, r.reaper, audit, {
      aclChecker: async () => ({
        status: "failed",
        required: true,
        reason: "ACL_RESIDUAL_GRANT",
        evidence: { platform: "linux", aclResidualEntries: 1, aclStateFiles: 0, aclVerifiedWith: "getfacl" },
      }),
    }),
  ).run();
  assert.equal(result.overallOk, false);
  assert.equal(result.report?.checks.acl.status, "failed");
  assert.equal(result.report?.checks.acl.reason, "ACL_RESIDUAL_GRANT");
});

test("ACL .acl.bak/.acl.snap 残留：pending，不伪造成 passed", async (t) => {
  const dir = stateDir(t);
  const r = fakeReaper();
  const audit = new FakeAudit();
  const result = await new TaskCleanupCoordinator(
    baseOptions(dir, r.reaper, audit, {
      aclChecker: async () => ({
        status: "pending",
        required: true,
        reason: "ACL_RESTORE_PENDING_C3",
        evidence: { platform: "linux", aclStateFiles: 1, aclResidualEntries: 0 },
      }),
    }),
  ).run();
  assert.equal(result.overallOk, false);
  assert.equal(result.report?.checks.acl.status, "pending");
  assert.equal(result.report?.checks.acl.reason, "ACL_RESTORE_PENDING_C3");
});

test("ACL 状态目录与 DSH 配置不同源：failed，不调用 ACL 扫描", async (t) => {
  const dir = stateDir(t);
  const { child, identity } = await spawnDetached(
    'process.on("SIGTERM",()=>process.exit(0)); setInterval(()=>{},1000);',
  );
  const r = fakeReaper();
  const audit = new FakeAudit();
  let aclCalls = 0;
  try {
    const { handle } = dshHandle(identity, child, "/wrong/acl-state", async () => {
      try { process.kill(identity.pid, "SIGTERM"); } catch { /* gone */ }
      return true;
    });
    const result = await new TaskCleanupCoordinator(
      baseOptions(dir, r.reaper, audit, {
        dsh: handle,
        aclChecker: async () => {
          aclCalls += 1;
          return okAcl();
        },
      }),
    ).run();
    const key = createHash("sha256").update(realpathSync(dir)).digest("hex").slice(0, 16);
    const lockPath = join(dir, `${key}.lock`);
    await assertWithDiagnostics(t, result, { identity, lockPath }, async () => {
      assert.equal(result.overallOk, false);
      assert.equal(result.report?.checks.acl.status, "failed");
      assert.equal(result.report?.checks.acl.reason, "ACL_STATE_DIR_MISMATCH");
      assert.equal(aclCalls, 0);
    });
  } finally {
    killGroup(identity);
  }
});

test("ACL 状态目录缺失：failed，不把空扫描当成功", async (t) => {
  const dir = stateDir(t);
  const r = fakeReaper();
  const audit = new FakeAudit();
  const missing = join(dir, "missing-acl-state");
  let aclCalls = 0;
  const result = await new TaskCleanupCoordinator(
    baseOptions(dir, r.reaper, audit, {
      paths: { workdir: dir, resultsDir: dir, assetsDir: dir, aclStateDir: missing },
      aclChecker: async () => {
        aclCalls += 1;
        return okAcl();
      },
    }),
  ).run();
  assert.equal(result.overallOk, false);
  assert.equal(result.report?.checks.acl.status, "failed");
  assert.equal(result.report?.checks.acl.reason, "ACL_STATE_DIR_MISSING");
  assert.equal(aclCalls, 0);
});

test("Audit fsync 失败：物理清理继续，但 overallOk=false", async (t) => {
  const dir = stateDir(t);
  const rtDir = mkdtempSync(join(tmpdir(), "c2b22b-audit-"));
  t.after(() => rmSync(rtDir, { recursive: true, force: true }));
  const rt = await prepareTrustedRuntime({ root: join(rtDir, "runtime"), forbiddenRoots: [] });
  const log = await CleanupAuditLog.open({
    trustedRuntimeRoot: rt.root,
    auditLogPath: join(rt.auditDir, "cleanup.jsonl"),
    syncFile: async () => { throw new Error("fsync fail"); },
  });
  const r = fakeReaper();
  let aclCalls = 0;
  try {
    const result = await new TaskCleanupCoordinator(
      baseOptions(dir, r.reaper, log, {
        aclChecker: async () => {
          aclCalls += 1;
          return okAcl();
        },
      }),
    ).run();
    assert.equal(result.overallOk, false);
    assert.equal(result.report?.checks.audit.status, "failed");
    assert.equal(result.report?.checks.audit.reason, "AUDIT_FSYNC_FAILED");
    assert.equal(result.report?.checks.docker.status, "passed");
    assert.equal(result.report?.checks.acl.status, "passed");
    assert.equal(r.calls.cleanup, 1);
    assert.equal(aclCalls, 1);
    assert.equal(log.auditOk, false);
  } finally {
    await log.close();
  }
});

test("Audit 中间事件持久写入：start/docker/acl/summary", async (t) => {
  const dir = stateDir(t);
  const rtDir = mkdtempSync(join(tmpdir(), "c2b22b-audit-ok-"));
  t.after(() => rmSync(rtDir, { recursive: true, force: true }));
  const rt = await prepareTrustedRuntime({ root: join(rtDir, "runtime"), forbiddenRoots: [] });
  const logPath = join(rt.auditDir, "cleanup.jsonl");
  const log = await CleanupAuditLog.open({ trustedRuntimeRoot: rt.root, auditLogPath: logPath });
  try {
    const r = fakeReaper();
    const result = await new TaskCleanupCoordinator(baseOptions(dir, r.reaper, log)).run();
    assert.equal(result.overallOk, true);
    await log.close();
    const lines = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const actions = lines.map((l) => l.action);
    assert.ok(actions.includes("cleanup_start"));
    assert.ok(actions.includes("docker_cleanup"));
    assert.ok(actions.includes("acl_check"));
    assert.ok(actions.includes("cleanup_summary"));
  } finally {
    await log.close().catch(() => {});
  }
});

test("CleanupReport seal 异常：返回 null + CLEANUP_REPORT_SEAL_FAILED", async (t) => {
  const dir = stateDir(t);
  const r = fakeReaper();
  const audit = new FakeAudit();
  const result = await new TaskCleanupCoordinator(
    baseOptions(dir, r.reaper, audit, {
      aclChecker: async () => ({
        status: "passed",
        required: true,
        reason: "ACL_NO_65534_RESIDUAL",
        evidence: {},
      }),
    }),
  ).run();
  assert.equal(result.sealed, false);
  assert.equal(result.report, null);
  assert.equal(result.overallOk, false);
  assert.equal(result.failureCode, "CLEANUP_REPORT_SEAL_FAILED");
});

test("总时间预算：cleanup 后超预算，不进入 ACL，overallOk=false", async (t) => {
  const dir = stateDir(t);
  let clock = 0;
  let cleanupCalls = 0;
  let aclCalls = 0;
  const reaper = {
    probeActive: async () => okProbe(),
    cleanup: async () => {
      cleanupCalls += 1;
      clock = 200;
      return okCleanup();
    },
  };
  const audit = new FakeAudit();
  const result = await new TaskCleanupCoordinator(
    baseOptions(dir, reaper, audit, {
      now: () => clock,
      timeBudgetMs: 100,
      aclChecker: async () => {
        aclCalls += 1;
        return okAcl();
      },
    }),
  ).run();
  assert.equal(cleanupCalls, 1);
  assert.equal(aclCalls, 0);
  assert.equal(result.overallOk, false);
  assert.equal(result.report?.checks.acl.status, "pending");
  assert.equal(result.report?.checks.acl.reason, "CLEANUP_TIME_BUDGET_EXCEEDED");
});

test("非 Linux 平台：不启动清理，不返回成功", async (t) => {
  const dir = stateDir(t);
  const r = fakeReaper();
  const audit = new FakeAudit();
  const result = await new TaskCleanupCoordinator(
    baseOptions(dir, r.reaper, audit, { platform: "win32" }),
  ).run();
  assert.equal(result.sealed, true);
  assert.equal(result.overallOk, false);
  assert.equal(result.failureCode, "PLATFORM_UNSUPPORTED");
  assert.equal(result.report?.checks.docker.status, "pending");
  assert.equal(result.report?.checks.acl.status, "not_applicable");
  assert.equal(r.calls.cleanup, 0);
  assert.equal(r.calls.probe, 0);
});
