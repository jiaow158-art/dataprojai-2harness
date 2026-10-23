// LIN-1 C1 单测：spawn/detached/killTree 平台规则。
// Windows 上断言 win32 侧零变化（shell=true、detached=false、dsh.cmd）；
// posix 分支的真实进程组击杀在 Linux S2 用 decoy 负向测试验证（dp-server runbook）。
import { test } from "node:test";
import assert from "node:assert/strict";
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
