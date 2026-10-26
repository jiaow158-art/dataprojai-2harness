// LIN-1 C1 单测：spawn/detached/killTree 平台规则。
// Windows 上断言 win32 侧零变化（shell=true、detached=false、dsh.cmd）；
// posix 分支的真实进程组击杀在 Linux S2 用 decoy 负向测试验证（dp-server runbook）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { DshSdkClient, defaultKillTree } from "./dsh-sdk-client.ts";

function fakeChild(): any {
  const c: any = new EventEmitter();
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.stdin = { write: () => true, end: () => {} };
  c.pid = 424242;
  c.kill = () => true;
  return c;
}

test("start() spawn 平台规则：command/shell 仅 win32；detached 仅 posix（进程组击杀前提，C1）", async () => {
  let captured: { command: string; args: string[]; opts: any } | null = null;
  const client = new DshSdkClient({
    cwd: process.cwd(),
    env: {},
    initTimeoutMs: 100,
    spawnFn: (command: string, args: string[], opts: any) => {
      captured = { command, args, opts };
      return fakeChild();
    },
  });
  const p = client.start({ provider: "deepseek", model: "lin1-test" });
  await p.catch(() => {}); // fake child 无 initialize 回显 → init 超时拒绝；本测试只断言 spawn opts
  assert.ok(captured, "spawnFn 必被调用");
  assert.equal(captured!.command, process.platform === "win32" ? "dsh.cmd" : "dsh");
  assert.deepEqual(captured!.args, ["--profile", "sdk"], "未显式传 args 时保持生产默认 sdk");
  assert.equal(captured!.opts.shell, process.platform === "win32");
  assert.equal(captured!.opts.detached, process.platform !== "win32", "posix 必须建进程组，win32 必须不建");
});

test("start() 显式 args：sdk-s4b profile 按 argv 传入，不拼接其他参数", async () => {
  let captured: { command: string; args: string[]; opts: any } | null = null;
  const client = new DshSdkClient({
    cwd: process.cwd(),
    env: {},
    args: ["--profile", "sdk-s4b"],
    initTimeoutMs: 100,
    spawnFn: (command: string, args: string[], opts: any) => {
      captured = { command, args, opts };
      return fakeChild();
    },
  });
  await client.start({ provider: "deepseek", model: "lin1-test" }).catch(() => {});
  assert.deepEqual(captured!.args, ["--profile", "sdk-s4b"]);
  assert.equal(captured!.opts.shell, process.platform === "win32");
  assert.equal(captured!.opts.detached, process.platform !== "win32");
});

test("defaultKillTree 守护：undefined / 自身 pid 直接早退（防误杀网关自身进程组）", () => {
  assert.doesNotThrow(() => defaultKillTree(undefined));
  assert.doesNotThrow(() => defaultKillTree(process.pid));
});

test("requestShutdown 只发 shutdown；终止权移交后 kill/killTree/stop 均为 no-op", async () => {
  const child = fakeChild();
  let kills = 0;
  child.stdin.write = (s: string) => {
    const m = JSON.parse(s);
    if (m.method === "initialize") {
      setImmediate(() => child.stdout.write(JSON.stringify({
        jsonrpc: "2.0", id: m.id, result: { serverInfo: { name: "fake", version: "test" } },
      }) + "\n"));
    } else if (m.method === "shutdown") {
      setImmediate(() => {
        child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} }) + "\n");
        child.emit("exit", 0);
      });
    }
    return true;
  };
  const client = new DshSdkClient({
    cwd: process.cwd(),
    env: { SANDBOX_ACL_STATE_DIR: "/tmp/acl-state-test" },
    initTimeoutMs: 1000,
    spawnFn: () => child,
    killTreeFn: () => { kills += 1; },
  });
  await client.start({ provider: "fake", model: "fake" });
  const handle = client.cleanupHandle();
  assert.ok(handle);
  assert.equal(handle!.aclStateDir, "/tmp/acl-state-test");
  assert.equal(await handle!.requestShutdown(500), true);
  assert.equal(kills, 0, "requestShutdown 不得调用 killTree");
  handle!.markTerminationOwned();
  handle!.markTerminationOwned();
  assert.equal(handle!.isTerminationOwned(), true);
  await client.kill();
  client.killTree();
  await client.stop();
  assert.equal(kills, 0, "终止权移交后旧 kill/killTree/stop 不得发信号");
});

test("Linux 真实 detached spawn：采集 PID/PGID/startTicks，shutdown 不 kill", { skip: process.platform === "win32" }, async () => {
  const script = `
    process.stdin.on("data", (d) => {
      for (const line of d.toString().split("\\n")) {
        if (!line) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.method === "initialize") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { serverInfo: { name: "fake", version: "1" } } }) + "\\n");
        } else if (m.method === "shutdown") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} }) + "\\n");
          setTimeout(() => process.exit(0), 20);
        }
      }
    });
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["-e", script], {
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let kills = 0;
  try {
    const client = new DshSdkClient({
      cwd: process.cwd(),
      env: { SANDBOX_ACL_STATE_DIR: "/tmp/acl-real-test" },
      initTimeoutMs: 2000,
      spawnFn: () => child,
      killTreeFn: () => { kills += 1; },
    });
    await client.start({ provider: "fake", model: "fake" });
    const handle = client.cleanupHandle();
    assert.ok(handle?.identity, "Linux 上必须采集真实进程身份");
    assert.equal(handle!.identity!.pid, child.pid);
    assert.equal(handle!.identity!.pgid, child.pid);
    assert.match(handle!.identity!.startTicks ?? "", /^[0-9]+$/);
    assert.equal(handle!.aclStateDir, "/tmp/acl-real-test");
    handle!.markTerminationOwned();
    assert.equal(await handle!.requestShutdown(1000), true);
    await client.kill();
    assert.equal(kills, 0);
  } finally {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
});
