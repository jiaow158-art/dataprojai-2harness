// S4-B2-C2-B1：进程终止/进程组退出验证。
// Linux 原生用例真实创建 detached 进程组、直接子进程退出但孙进程存活、decoy 异组存活。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  captureProcessIdentity,
  parseLinuxProcStat,
  probeLinuxProcessGroupState,
  probeLinuxProcessGroupStateDetailed,
  terminateAndVerify,
  type LinuxProcProbeIo,
  type ProcessProbe,
} from "./process-termination.ts";

const LINUX = process.platform === "linux";
const HAS_PYTHON3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function spawnNode(script: string): ChildProcess {
  return spawn(process.execPath, ["-e", script], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

async function waitSpawned(child: ChildProcess): Promise<number> {
  if (child.pid) {
    await sleep(30);
    return child.pid;
  }
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("spawn timeout")), 2000);
    child.once("spawn", () => { clearTimeout(t); resolve(); });
  });
  return child.pid!;
}

async function waitOutput(child: ChildProcess, needle: string, timeoutMs = 2000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let buf = "";
    const t = setTimeout(() => {
      child.stdout?.off("data", onData);
      reject(new Error(`output timeout waiting for ${needle}`));
    }, timeoutMs);
    const onData = (d: Buffer) => {
      buf += d.toString("utf8");
      if (buf.includes(needle)) {
        clearTimeout(t);
        child.stdout?.off("data", onData);
        resolve();
      }
    };
    child.stdout?.on("data", onData);
  });
}

async function readOutputLine(child: ChildProcess, prefix: string, timeoutMs = 3000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buf = "";
    const t = setTimeout(() => {
      child.stdout?.off("data", onData);
      reject(new Error(`output timeout waiting for line ${prefix}`));
    }, timeoutMs);
    const onData = (d: Buffer) => {
      buf += d.toString("utf8");
      for (const line of buf.split(/\r?\n/)) {
        if (line.startsWith(prefix)) {
          clearTimeout(t);
          child.stdout?.off("data", onData);
          resolve(line);
          return;
        }
      }
    };
    child.stdout?.on("data", onData);
  });
}

async function waitExit(child: ChildProcess, timeoutMs = 2000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error("child exit timeout"));
    }, timeoutMs);
    const onExit = () => { clearTimeout(t); resolve(); };
    child.once("exit", onExit);
  });
}

async function killGroupQuiet(child: ChildProcess | null): Promise<void> {
  if (!child?.pid) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
  await Promise.race([waitExit(child, 1000).catch(() => undefined), sleep(300)]);
}

function groupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code !== "ESRCH";
  }
}

test("parseLinuxProcStat：comm 含空格/括号，取 pgrp 与 starttime", () => {
  const raw = "4242 (node: worker (x)) S 1 4242 4242 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 123456 0 0";
  const st = parseLinuxProcStat(4242, raw);
  assert.equal(st.pid, 4242);
  assert.equal(st.state, "S");
  assert.equal(st.pgid, 4242);
  assert.equal(st.startTicks, "123456");
  assert.throws(() => parseLinuxProcStat(4243, raw), /PROC_STAT_INVALID/);

  const kernel = parseLinuxProcStat(
    2,
    "2 (kthreadd) S 0 0 0 0 -1 2129984 0 0 0 0 0 440 0 0 20 0 1 0 37 0 0",
  );
  assert.equal(kernel.pgid, 0, "内核线程 pgid=0 不得让 /proc 扫描整体 unknown");
  assert.equal(kernel.startTicks, "37");
});

function procStatLine(pid: number, pgid: number, state = "S", startTicks = "123456"): string {
  return `${pid} (node: worker (x)) ${state} 1 ${pgid} ${pgid} 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 ${startTicks} 0 0`;
}

type FakeProcEntry = string | { error: string };

function fakeProcIo(entries: Record<number, FakeProcEntry>, readdirError?: string): LinuxProcProbeIo {
  const pids = Object.keys(entries).map(Number);
  return {
    readdir: async (path) => {
      assert.equal(path, "/proc");
      if (readdirError) {
        const e = Object.assign(new Error("readdir failed"), { code: readdirError });
        throw e;
      }
      return pids.map(String);
    },
    readFile: async (path, encoding) => {
      assert.equal(encoding, "utf8");
      const m = /^\/proc\/([0-9]+)\/stat$/.exec(path);
      assert.ok(m, `unexpected proc path: ${path}`);
      const pid = Number(m[1]);
      const entry = entries[pid];
      if (entry === undefined) {
        const e = Object.assign(new Error("gone"), { code: "ENOENT" });
        throw e;
      }
      if (typeof entry !== "string") {
        const e = Object.assign(new Error("proc read failed"), { code: entry.error });
        throw e;
      }
      return entry;
    },
  };
}

test("/proc 详细探针：目标组不存在 → absent，不产生无谓 unknown", async () => {
  const io = fakeProcIo({
    10: procStatLine(10, 10),
    11: procStatLine(11, 11),
  });
  const r = await probeLinuxProcessGroupStateDetailed(999, io);
  assert.equal(r.state, "absent");
  assert.equal(r.unreadableCount, 0);
  assert.deepEqual(r.issues, []);
  assert.equal(r.scanned, 2);
});

test("/proc 详细探针：目标组仍存活 → exists", async () => {
  const io = fakeProcIo({
    20: procStatLine(20, 999),
    21: procStatLine(21, 21),
  });
  const r = await probeLinuxProcessGroupStateDetailed(999, io);
  assert.equal(r.state, "exists");
  assert.equal(r.unreadableCount, 0);
});

test("/proc 详细探针：无关 PID EIO → unknown，不假判 absent", async () => {
  const io = fakeProcIo({
    30: procStatLine(30, 30),
    31: { error: "EIO" },
  });
  const r = await probeLinuxProcessGroupStateDetailed(999, io);
  assert.equal(r.state, "unknown");
  assert.equal(r.unreadableCount, 1);
  assert.deepEqual(r.issues, [{ pid: 31, code: "PROC_STAT_READ_FAILED", errno: "EIO" }]);
});

test("/proc 详细探针：持续权限错误 → unknown，保留 EACCES", async () => {
  const io = fakeProcIo({ 41: { error: "EACCES" } });
  const r = await probeLinuxProcessGroupStateDetailed(999, io);
  assert.equal(r.state, "unknown");
  assert.deepEqual(r.issues, [
    { pid: 41, code: "PROC_STAT_READ_FAILED", errno: "EACCES" },
  ]);
});

test("/proc 详细探针：ENOENT/ESRCH 是进程消失竞态，不作为 unknown", async () => {
  for (const code of ["ENOENT", "ESRCH"]) {
    const io = fakeProcIo({ 51: { error: code }, 52: procStatLine(52, 52) });
    const r = await probeLinuxProcessGroupStateDetailed(999, io);
    assert.equal(r.state, "absent", `${code} should be treated as disappearance`);
    assert.equal(r.unreadableCount, 0, `${code} must not become an issue`);
  }
});

test("/proc 详细探针：解析失败 → unknown，保留状态码", async () => {
  const io = fakeProcIo({ 61: "not a valid stat line" });
  const r = await probeLinuxProcessGroupStateDetailed(999, io);
  assert.equal(r.state, "unknown");
  assert.deepEqual(r.issues, [{ pid: 61, code: "PROC_STAT_INVALID" }]);
});

test("/proc 详细探针：readdir 失败 → unknown，保留 errno", async () => {
  const r = await probeLinuxProcessGroupStateDetailed(999, fakeProcIo({}, "EIO"));
  assert.equal(r.state, "unknown");
  assert.deepEqual(r.issues, [{ pid: null, code: "PROC_READDIR_FAILED", errno: "EIO" }]);
});

test("正常 graceful 关闭：进程组真实退出，forced=false", { skip: !LINUX }, async () => {
  const child = spawnNode('process.on("SIGTERM",()=>process.exit(0)); setInterval(()=>{},1000);');
  try {
    const pid = await waitSpawned(child);
    const identity = await captureProcessIdentity(pid);
    assert.equal(identity.platform, "linux");
    assert.equal(identity.pgid, pid, "detached 子进程应为进程组长");
    assert.ok(identity.startTicks && /^[0-9]+$/.test(identity.startTicks));
    const res = await terminateAndVerify({ identity, child, gracefulMs: 1500, killMs: 1500 });
    assert.equal(res.status, "passed");
    assert.equal(res.reason, "PROCESS_GROUP_EXITED");
    assert.equal(res.directChildExited, true);
    assert.equal(res.processGroupAbsent, true);
    assert.equal(res.forced, false);
    assert.equal(groupExists(identity.pgid), false);
  } finally {
    await killGroupQuiet(child);
  }
});

test("优雅关闭超时：有界等待后强制 SIGKILL，仍验证组退出", { skip: !LINUX }, async () => {
  const child = spawnNode('process.on("SIGTERM",()=>{}); process.stdout.write("ready\\n"); setInterval(()=>{},1000);');
  try {
    const pid = await waitSpawned(child);
    await waitOutput(child, "ready");
    const identity = await captureProcessIdentity(pid);
    const started = Date.now();
    const res = await terminateAndVerify({ identity, child, gracefulMs: 120, killMs: 1500 });
    assert.equal(res.status, "passed");
    assert.equal(res.gracefulTimedOut, true);
    assert.equal(res.forced, true);
    assert.equal(res.processGroupAbsent, true);
    assert.ok(Date.now() - started < 2500);
    assert.equal(groupExists(identity.pgid), false);
  } finally {
    await killGroupQuiet(child);
  }
});

test("直接子进程退出但孙进程仍存活：不得误报 passed，禁止盲杀不可证明的 PGID", { skip: !LINUX }, async () => {
  const child = spawnNode(`
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000);'], { stdio: 'ignore' });
    process.stdout.write('ready\\n');
    setTimeout(() => process.exit(0), 100);
  `);
  try {
    const pid = await waitSpawned(child);
    await waitOutput(child, "ready");
    const identity = await captureProcessIdentity(pid);
    await waitExit(child);
    assert.notEqual(child.exitCode, null, "直接子进程应已退出");
    assert.equal(groupExists(identity.pgid), true, "孙进程应仍在原进程组");
    const res = await terminateAndVerify({ identity, child, gracefulMs: 120, killMs: 1500 });
    assert.equal(res.status, "pending");
    assert.equal(res.reason, "PROCESS_LEADER_GONE_UNVERIFIABLE");
    assert.equal(res.directChildExited, true);
    assert.equal(res.processGroupAbsent, false);
    assert.equal(groupExists(identity.pgid), true, "无法证明组身份时不得向 PGID 发送信号");
  } finally {
    await killGroupQuiet(child);
  }
});

test("PGID 身份不一致（startTicks 相同）：拒绝盲杀", async () => {
  const identity = { pid: 424245, pgid: 424245, startTicks: "100", platform: "linux" as const };
  let signalled = false;
  const probe: Partial<ProcessProbe> = {
    readStat: async () => ({ pid: 424245, state: "S", pgid: 999999, startTicks: "100" }),
    groupState: async () => "exists",
    signalGroup: async () => { signalled = true; },
    sleep: async () => {},
    now: () => Date.now(),
  };
  const res = await terminateAndVerify({ identity, probe, gracefulMs: 0, killMs: 0 });
  assert.equal(res.status, "failed");
  assert.equal(res.reason, "PROCESS_IDENTITY_MISMATCH");
  assert.equal(signalled, false);
});

test("初始组状态 unknown：pending 且不发送任何信号", async () => {
  const identity = { pid: 424246, pgid: 424246, startTicks: "101", platform: "linux" as const };
  let signalled = false;
  const probe: Partial<ProcessProbe> = {
    readStat: async () => ({ pid: 424246, state: "S", pgid: 424246, startTicks: "101" }),
    groupState: async () => "unknown",
    signalGroup: async () => { signalled = true; },
    sleep: async () => {},
    now: () => Date.now(),
  };
  const res = await terminateAndVerify({ identity, probe, gracefulMs: 0, killMs: 0 });
  assert.equal(res.status, "pending");
  assert.equal(res.reason, "PROCESS_GROUP_STATE_UNKNOWN");
  assert.equal(signalled, false);
});

test("SIGTERM 前 leader 消失：pending 且不发信号，避免命中复用 PGID", async () => {
  const identity = { pid: 424247, pgid: 424247, startTicks: "102", platform: "linux" as const };
  let reads = 0;
  let signalled = false;
  const probe: Partial<ProcessProbe> = {
    readStat: async () =>
      reads++ === 0
        ? { pid: 424247, state: "S", pgid: 424247, startTicks: "102" }
        : null,
    groupState: async () => "exists",
    signalGroup: async () => { signalled = true; },
    sleep: async () => {},
    now: () => Date.now(),
  };
  const res = await terminateAndVerify({ identity, probe, gracefulMs: 20, killMs: 20 });
  assert.equal(res.status, "pending");
  assert.equal(res.reason, "PROCESS_LEADER_GONE_UNVERIFIABLE");
  assert.equal(signalled, false);
});

test("Linux 原生：仅剩僵尸的进程组不算存活，kill(-pgid,0) 不再作为判据", { skip: !LINUX || !HAS_PYTHON3 }, async () => {
  const script = String.raw`
import ctypes, os, time
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
    raise OSError(ctypes.get_errno(), "prctl")
leader = os.fork()
if leader == 0:
    os.setsid()
    child = os.fork()
    if child == 0:
        os._exit(0)
    os._exit(0)
os.waitpid(leader, 0)
time.sleep(0.3)
print(f"PGID={leader}", flush=True)
time.sleep(30)
`;
  const holder = spawn("python3", ["-c", script], { stdio: ["ignore", "pipe", "ignore"] });
  try {
    const pgid = Number((await readOutputLine(holder, "PGID=")).slice(5));
    assert.ok(Number.isSafeInteger(pgid) && pgid > 1);
    assert.equal(groupExists(pgid), true, "kill(-pgid,0) 仍会看到僵尸组");
    assert.equal(await probeLinuxProcessGroupState(pgid), "absent");
  } finally {
    try { holder.kill("SIGKILL"); } catch { /* gone */ }
    await waitExit(holder, 2000).catch(() => undefined);
  }
});

test("decoy 异组不受目标组清理影响", { skip: !LINUX }, async () => {
  const target = spawnNode('process.on("SIGTERM",()=>{}); setInterval(()=>{},1000);');
  const decoy = spawnNode('process.on("SIGTERM",()=>{}); setInterval(()=>{},1000);');
  try {
    const targetPid = await waitSpawned(target);
    const decoyPid = await waitSpawned(decoy);
    const identity = await captureProcessIdentity(targetPid);
    const decoyIdentity = await captureProcessIdentity(decoyPid);
    const res = await terminateAndVerify({ identity, child: target, gracefulMs: 80, killMs: 1500 });
    assert.equal(res.status, "passed");
    assert.equal(groupExists(identity.pgid), false);
    assert.equal(groupExists(decoyIdentity.pgid), true, "异组 decoy 必须存活");
  } finally {
    await killGroupQuiet(target);
    await killGroupQuiet(decoy);
  }
});

test("自定义 graceful 回调优先执行；正常退出时 forced=false", { skip: !LINUX }, async () => {
  const child = spawnNode('process.on("SIGTERM",()=>process.exit(0)); process.stdout.write("ready\\n"); setInterval(()=>{},1000);');
  try {
    const pid = await waitSpawned(child);
    await waitOutput(child, "ready");
    const identity = await captureProcessIdentity(pid);
    let called = 0;
    const res = await terminateAndVerify({
      identity,
      child,
      gracefulMs: 1000,
      killMs: 1000,
      graceful: () => {
        called += 1;
        process.kill(-identity.pgid, "SIGTERM");
      },
    });
    assert.equal(called, 1);
    assert.equal(res.status, "passed");
    assert.equal(res.forced, false);
  } finally {
    await killGroupQuiet(child);
  }
});

test("自定义 graceful 回调挂起也必须在 gracefulMs 后强制回收", { skip: !LINUX }, async () => {
  const child = spawnNode('process.on("SIGTERM",()=>{}); process.stdout.write("ready\\n"); setInterval(()=>{},1000);');
  try {
    const pid = await waitSpawned(child);
    await waitOutput(child, "ready");
    const identity = await captureProcessIdentity(pid);
    const res = await terminateAndVerify({
      identity,
      child,
      gracefulMs: 100,
      killMs: 1000,
      graceful: () => new Promise<void>(() => { /* hangs forever */ }),
    });
    assert.equal(res.status, "passed");
    assert.equal(res.gracefulTimedOut, true);
    assert.equal(res.forced, true);
    assert.equal(groupExists(identity.pgid), false);
  } finally {
    await killGroupQuiet(child);
  }
});

test("fake probe：SIGKILL 后组仍存在 → failed，不误判通过", async () => {
  const identity = { pid: 424242, pgid: 424242, startTicks: "777", platform: "linux" as const };
  const probe: Partial<ProcessProbe> = {
    readStat: async () => ({ pid: 424242, state: "S", pgid: 424242, startTicks: "777" }),
    groupState: async () => "exists",
    signalGroup: async () => {},
    sleep: async () => {},
    now: () => Date.now(),
  };
  const res = await terminateAndVerify({ identity, probe, gracefulMs: 0, killMs: 0 });
  assert.equal(res.status, "failed");
  assert.equal(res.reason, "PROCESS_GROUP_ALIVE");
  assert.equal(res.forced, true);
});

test("fake probe：组状态 unknown → pending，不当作成功", async () => {
  const identity = { pid: 424243, pgid: 424243, startTicks: "778", platform: "linux" as const };
  const probe: Partial<ProcessProbe> = {
    readStat: async () => null,
    groupState: async () => "unknown",
    signalGroup: async () => {},
    sleep: async () => {},
    now: () => Date.now(),
  };
  const res = await terminateAndVerify({ identity, probe, gracefulMs: 0, killMs: 0 });
  assert.equal(res.status, "pending");
  assert.equal(res.reason, "PROCESS_GROUP_STATE_UNKNOWN");
  assert.equal(res.processGroupAbsent, false);
});

test("PID 复用：starttime 不一致拒绝盲杀", async () => {
  const identity = { pid: 424244, pgid: 424244, startTicks: "100", platform: "linux" as const };
  let signalled = false;
  const probe: Partial<ProcessProbe> = {
    readStat: async () => ({ pid: 424244, state: "S", pgid: 424244, startTicks: "999" }),
    groupState: async () => "exists",
    signalGroup: async () => { signalled = true; },
    sleep: async () => {},
    now: () => Date.now(),
  };
  const res = await terminateAndVerify({ identity, probe, gracefulMs: 0, killMs: 0 });
  assert.equal(res.status, "failed");
  assert.equal(res.reason, "PROCESS_IDENTITY_MISMATCH");
  assert.equal(signalled, false);
});

test("拒绝终止网关自身/自身进程组", async () => {
  if (!LINUX) return;
  const own = await captureProcessIdentity(process.pid);
  await assert.rejects(
    () => terminateAndVerify({ identity: own }),
    (e: any) => e.code === "REFUSE_SELF_GROUP",
  );
});

test("Windows 规则 mock：结果 pending，不声称实机验证", async () => {
  const res = await terminateAndVerify({
    identity: { pid: 1234, pgid: 1234, startTicks: null, platform: "win32" },
    platform: "win32",
    gracefulMs: 0,
    killMs: 0,
  });
  assert.equal(res.status, "pending");
  assert.equal(res.reason, "WINDOWS_TREE_UNVERIFIABLE");
  assert.equal(res.processGroupAbsent, false);
});
