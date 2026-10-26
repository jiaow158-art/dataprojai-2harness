// S4-B2-C2-B2-2B：TaskCleanupCoordinator 独立实现测试。
// 使用真实 detached 子进程验证进程组；Docker 通过注入 reaper 测试（真实 Docker 在
// sandbox-container-reaper.test.ts 的隔离用例）。不调用模型/DWS/正式服务。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TaskCleanupCoordinator,
  type CleanupFence,
  type CoordinatorAudit,
} from "./task-cleanup-coordinator.ts";
import {
  captureProcessIdentity,
  probeLinuxProcessGroupState,
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

async function waitFor(cond: () => boolean, ms = 2_000, what = "condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`waitFor timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function spawnDetached(script: string): Promise<{ child: ChildProcess; identity: ProcessIdentity }> {
  const child = spawn(process.execPath, ["-e", script], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  await waitFor(() => typeof child.pid === "number" && child.pid > 1, 2_000, "child pid");
  const identity = await captureProcessIdentity(child.pid!);
  return { child, identity };
}

function killGroup(identity: ProcessIdentity): void {
  try {
    process.kill(-identity.pgid, "SIGKILL");
  } catch {
    /* already gone */
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
  const key = createHash("sha256").update(dir).digest("hex").slice(0, 16);
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
    assert.equal(result.overallOk, true);
    assert.equal(result.report?.checks.dsh.evidence.forced, true);
    const key = createHash("sha256").update(dir).digest("hex").slice(0, 16);
    const lockPath = join(dir, `${key}.lock`);
    // 锁 holder 已被释放；flock 可立即再次取得。
    execFileSync("flock", ["-n", lockPath, "true"], { stdio: "ignore" });
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
    assert.equal(result.overallOk, true);
    assert.equal(result.report?.checks.dsh.status, "passed");
    assert.equal(result.report?.checks.dsh.evidence.forced, true);
    assert.equal(await probeLinuxProcessGroupState(identity.pgid), "absent");
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
    assert.equal(result.overallOk, false);
    assert.equal(result.report?.checks.acl.status, "failed");
    assert.equal(result.report?.checks.acl.reason, "ACL_STATE_DIR_MISMATCH");
    assert.equal(aclCalls, 0);
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
