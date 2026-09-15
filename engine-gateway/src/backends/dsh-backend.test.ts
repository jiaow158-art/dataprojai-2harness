// M1-T5 单测：mock fixture（T16 真实会话事件，zstd 解压提取），不打真 dsh。
// 六项覆盖（计划 Task 5 Step 4）：
//   1. normalize：fixture → 规范事件序列（sql result_ref/row_count、answer、stage 映射）
//   2. DshSdkClient mock：fake child 回放 → prompt 由 turn/end resolve、回调顺序正确
//   3. 超时路径：无 turn/end → killTree 被调 + pending reject（TIMEOUT）
//   4. 进程死亡：emit exit → pending reject（ENGINE_ERROR）
//   5. stderr 消毒：DWS_PASSWORD 值在任何输出中被替换（T2 红线）
//   6. createSession：目录创建 + env 断言（resolveDbAccount 集成）+ historyPrefix 拼接
//      + SDK sessionId 每次 spawn 唯一（S3 spike 约束）+ Temp 路径 WARN
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { normalize } from "./dsh-events.ts";
import { DshSdkClient, REQUIRED_ENV_KEYS, SdkPromptError } from "./dsh-sdk-client.ts";
import { DshBackend, type SessionOpts } from "./dsh-backend.ts";
import { resolveDbAccount } from "../config/db-accounts.ts";
import type { ChildProcess } from "node:child_process";

// ── fixture：T16 真实会话事件（~/.dsh/sessions t16-ea69d9d3 提取，文本截断结构保全）──
const fixture = JSON.parse(
  readFileSync(new URL("./dsh-fixture.json", import.meta.url), "utf8"),
) as Array<{ type: string; seq?: number; time?: number; data?: any }>;

// ── fake child：EventReader 骨架 + 三管道流（readline 需真 Readable）────────────────
interface FakeChild extends EventEmitter {
  stdin: { write: (s: string) => boolean; end: () => void };
  stdout: PassThrough;
  stderr: PassThrough;
  pid: number;
  killed: boolean;
}
function makeFakeChild(): FakeChild {
  const c = new EventEmitter() as FakeChild;
  (c as any).stdin = {
    write: (s: string) => {
      (c as any).__writes.push(s);
      return true;
    },
    end: () => {},
  };
  (c as any).__writes = [] as string[];
  (c as any).stdout = new PassThrough();
  (c as any).stderr = new PassThrough();
  (c as any).pid = 424242;
  (c as any).killed = false;
  return c;
}
function childWrites(c: FakeChild): any[] {
  return ((c as any).__writes as string[]).map((l) => JSON.parse(l));
}
/** 向 fake child stdout 写一行 JSON-RPC 消息。 */
function line(c: FakeChild, obj: unknown): void {
  c.stdout.write(JSON.stringify(obj) + "\n");
}
/** 把事件包装成 session.event 通知写入。 */
function notifyEvent(c: FakeChild, sessionId: string, ev: unknown): void {
  line(c, { jsonrpc: "2.0", method: "session.event", params: { sessionId, event: ev } });
}

/** 轮询等待条件成立（generator 惰性驱动与帧写入的解耦——ask 的应答由本测试喂）。 */
async function waitFor(cond: () => boolean, ms = 3000, what = "condition"): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`waitFor timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const BASE_ENV: Record<string, string> = {
  M0_SANDBOX_RUNNER: "D:\\x\\run_in_sandbox.sh",
  M0_SANDBOX_WORKDIR: "D:\\x\\workdir",
  M0_RESULTS_DIR: "D:\\x\\results",
  M0_ASSETS_DIR: "D:\\x\\assets",
  M0_PROJECT_SKILL_DIR: "D:\\x\\skills",
  RESULT_DIR: "D:\\x\\results",
  DWS_USER: "aiuser",
  DWS_PASSWORD: "secret123",
  DEEPSEEK_API_KEY: "sk-test-key",
  PATH: process.env.PATH ?? "",
};

// ── 1. normalize：fixture → 规范事件序列 ─────────────────────────────────────────
test("normalize(fixture)：sql 事件提取 result_ref/row_count/elapsed，answer/stage 映射正确", () => {
  const out = normalize(fixture);

  // 首事件：turn/start → analyzing
  assert.deepEqual(out[0], { type: "stage", stage: "analyzing", text: "turn 1 started" });

  // run_query 调用 → querying（fixture 精选了 step5/step6 两对：seq 1656、2162）
  const querying = out.filter((e) => e.type === "stage" && e.stage === "querying");
  assert.equal(querying.length, 2);

  // sql 事件：首个 run_query 的 result 关联（seq 1656 call → 1657 result）
  const sqls = out.filter((e) => e.type === "sql");
  assert.equal(sqls.length, 2);
  assert.deepEqual(
    { rows: sqls[0].rows, truncated: sqls[0].truncated, result_ref: sqls[0].result_ref },
    { rows: 3, truncated: false, result_ref: "r-20260909103751-34092-1" },
  );
  // sql 文本来自 tool/call arguments（M0 双通道：result 文本无 sql 字段）
  assert.ok(sqls[0].sql.includes("SELECT calmonth"));
  // elapsed_ms = result.time - call.time（fixture seq 1656→1657）
  assert.equal(sqls[0].elapsed_ms, 1788921471380 - 1788921466581);

  // answer：turn1 终文（text 块且无 tool-call 块的那条 assistant/message）
  const answers = out.filter((e) => e.type === "answer");
  assert.equal(answers.length, 1);
  assert.ok(answers[0].markdown.length > 0);

  // exec_script（fixture 追加的 turn2 对）→ script_running
  const scriptStage = out.find((e) => e.type === "stage" && e.stage === "script_running");
  assert.ok(scriptStage, "exec_script 应产生 script_running");
  assert.ok(scriptStage!.text!.includes("yoy_calc.py"));

  // turn2 turn/start → analyzing "turn 2 started"
  assert.ok(out.some((e) => e.type === "stage" && e.text === "turn 2 started"));

  // turn/end completed → 不产 error
  assert.equal(out.filter((e) => e.type === "error").length, 0);
  // done 不在归一化产出（编排层职责）
  assert.ok(out.every((e) => (e as any).type !== "done"));
});

test("normalize 合成事件：report_checking / report 产物路径 / turn/end 异常 reason", () => {
  const out = normalize([
    { type: "tool/call", seq: 1, time: 1000, data: { turn: 1, step: 1, callId: "c1", name: "skill", arguments: '{"name": "report-generator"}' } },
    { type: "tool/call", seq: 2, time: 2000, data: { turn: 1, step: 2, callId: "c2", name: "exec_script", arguments: '{"script": "run_build.sh"}' } },
    { type: "tool/result", seq: 3, time: 3000, data: { turn: 1, step: 2, message: { source: { kind: "tool", callId: "c2" }, content: [{ type: "tool-result", toolCallId: "c2", content: [{ type: "text", text: "[sandbox: exit code 0]\nstdout:\nOK /workdir/reports/report_inventory_20260909.html\n" }] }] } } },
    { type: "turn/end", seq: 4, time: 4000, data: { turn: 1, reason: { kind: "error", error: { message: "boom", code: "UNKNOWN" } } } },
  ]);
  assert.deepEqual(out[0], { type: "stage", stage: "report_checking", text: "skill report-generator" });
  assert.equal(out[1].type, "stage");
  assert.equal((out[1] as any).stage, "script_running");
  // 报告产物 → report {path}（反斜杠归一为正斜杠）
  const report = out.find((e) => e.type === "report");
  assert.ok(report);
  assert.equal(report!.path, "reports/report_inventory_20260909.html");
  // 异常 reason → error
  const err = out.find((e) => e.type === "error");
  assert.ok(err);
  assert.equal(err!.code, "ENGINE_ERROR");
  assert.ok(err!.message.includes("boom"));
});

// ── 2. DshSdkClient mock：回放 fixture 原始通知 ─────────────────────────────────
test("DshSdkClient：fake child 回放 → prompt 由 turn/end resolve，onEvent 顺序正确", async () => {
  const child = makeFakeChild();
  const events: string[] = [];
  const client = new DshSdkClient({
    cwd: "D:\\x\\workdir",
    env: { ...BASE_ENV },
    spawnFn: () => child as unknown as ChildProcess,
    killTreeFn: () => { child.emit("exit", 1); },
    initTimeoutMs: 2000,
    onEvent: (ev) => events.push(ev.type ?? "?"),
  });

  const startP = client.start({ provider: "deepseek-official", model: "deepseek-v4-flash" });
  // initialize 请求帧形态（T16 同款：id 计数 + method + params 含 cwd）
  const initFrame = childWrites(child)[0];
  assert.equal(initFrame.method, "initialize");
  assert.equal(initFrame.params.cwd, "D:\\x\\workdir");
  line(child, { jsonrpc: "2.0", id: initFrame.id, result: { serverInfo: { name: "deepseek-harness-sdk-runtime", version: "0.0.1" } } });
  const init = await startP;
  assert.equal(init.serverInfo.name, "deepseek-harness-sdk-runtime");

  const promptP = client.prompt("gw-s1-a1", "分析Q3库存", 10_000);
  const promptFrame = childWrites(child).find((f) => f.method === "session/prompt");
  assert.equal(promptFrame.params.sessionId, "gw-s1-a1");
  assert.equal(promptFrame.params.contentBlocks[0].text, "分析Q3库存");
  // 入队回执 + fixture 全量回放 + turn/end completed
  line(child, { jsonrpc: "2.0", id: promptFrame.id, result: { messageId: "m1" } });
  for (const ev of fixture) notifyEvent(child, "gw-s1-a1", ev);
  const turnEnd = await promptP;
  assert.deepEqual(turnEnd, { turn: 1, reason: { kind: "completed" } });
  // onEvent 逐事件回调且顺序 = fixture 顺序（fixture 末尾是追加的 turn2 exec 对）
  assert.equal(events.length, fixture.length);
  const fixtureTypes = fixture.map((e) => e.type);
  assert.deepEqual(events, fixtureTypes);
});

// ── 3. 超时路径：killTree + pending reject（TIMEOUT）──────────────────────────────
test("超时：回放无 turn/end → killTree 被调 + prompt 以 TIMEOUT 拒绝", async () => {
  const child = makeFakeChild();
  let killCalled = 0;
  const client = new DshSdkClient({
    cwd: "D:\\x\\workdir",
    env: { ...BASE_ENV },
    spawnFn: () => child as unknown as ChildProcess,
    killTreeFn: () => { killCalled++; child.emit("exit", 1); }, // taskkill 落地后进程树退出
    initTimeoutMs: 2000,
  });
  const initF = (() => { const p = client.start({ provider: "x", model: "y" }); const f = childWrites(child)[0]; line(child, { jsonrpc: "2.0", id: f.id, result: { serverInfo: { name: "s", version: "0" } } }); return p; })();
  await initF;

  const promptP = client.prompt("gw-s1-a1", "q", 80);
  await assert.rejects(promptP, (e: unknown) => {
    assert.ok(e instanceof SdkPromptError);
    assert.equal((e as SdkPromptError).code, "TIMEOUT");
    return true;
  });
  assert.equal(killCalled, 1);
  assert.ok(client.hasExited);
});

// ── 3b. initialize 失败杀孤儿（I-2：env 带密钥的 dsh 进程不得泄漏）──────────────
test("initialize 超时：start 拒绝 + killTree 被调（不留孤儿 dsh）", async () => {
  const child = makeFakeChild();
  let killCalled = 0;
  const client = new DshSdkClient({
    cwd: "D:\\x\\workdir",
    env: { ...BASE_ENV },
    spawnFn: () => child as unknown as ChildProcess,
    killTreeFn: () => { killCalled++; child.emit("exit", 1); },
    initTimeoutMs: 60,
  });
  // 不应答 initialize → 超时
  await assert.rejects(client.start({ provider: "x", model: "y" }), (e: unknown) => {
    assert.ok(e instanceof SdkPromptError);
    assert.equal((e as SdkPromptError).code, "TIMEOUT");
    return true;
  });
  assert.equal(killCalled, 1, "initialize 超时必须 killTree");
});

test("initialize 错误应答：start 拒绝 + killTree 被调", async () => {
  const child = makeFakeChild();
  let killCalled = 0;
  const client = new DshSdkClient({
    cwd: "D:\\x\\workdir",
    env: { ...BASE_ENV },
    spawnFn: () => child as unknown as ChildProcess,
    killTreeFn: () => { killCalled++; child.emit("exit", 1); },
    initTimeoutMs: 2000,
  });
  const startP = client.start({ provider: "x", model: "y" });
  const f = childWrites(child)[0];
  line(child, { jsonrpc: "2.0", id: f.id, error: { code: -32603, message: "cannot create effect on inactive context" } });
  await assert.rejects(startP, /-32603|inactive context/);
  assert.equal(killCalled, 1, "initialize 错误应答必须 killTree");
});

// ── 4. 进程死亡：emit exit → pending reject（ENGINE_ERROR）────────────────────────
test("进程死亡：prompt 在途时 exit → prompt 以 ENGINE_ERROR 拒绝", async () => {
  const child = makeFakeChild();
  const client = new DshSdkClient({
    cwd: "D:\\x\\workdir",
    env: { ...BASE_ENV },
    spawnFn: () => child as unknown as ChildProcess,
    killTreeFn: () => {},
    initTimeoutMs: 2000,
  });
  await (async () => {
    const p = client.start({ provider: "x", model: "y" });
    const f = childWrites(child)[0];
    line(child, { jsonrpc: "2.0", id: f.id, result: { serverInfo: { name: "s", version: "0" } } });
    await p;
  })();

  const promptP = client.prompt("gw-s1-a1", "q", 60_000);
  const f2 = childWrites(child).find((w) => w.method === "session/prompt");
  line(child, { jsonrpc: "2.0", id: f2.id, result: { messageId: "m1" } });
  // 意外死亡（非超时）
  child.emit("exit", 137);
  await assert.rejects(promptP, (e: unknown) => {
    assert.ok(e instanceof SdkPromptError);
    assert.equal((e as SdkPromptError).code, "ENGINE_ERROR");
    return true;
  });
  // 死后再 prompt 立即拒绝
  await assert.rejects(client.prompt("gw-s1-a1", "q2", 1000), /not running/);
});

// ── 5. stderr 消毒（T2 红线）─────────────────────────────────────────────────────
test("stderr 消毒：DWS_PASSWORD/DEEPSEEK_API_KEY 值在环形缓冲与输出中被替换", async () => {
  const child = makeFakeChild();
  const client = new DshSdkClient({
    cwd: "D:\\x\\workdir",
    env: { ...BASE_ENV },
    spawnFn: () => child as unknown as ChildProcess,
    killTreeFn: () => {},
    initTimeoutMs: 2000,
  });
  const startP = client.start({ provider: "x", model: "y" });
  const f = childWrites(child)[0];
  line(child, { jsonrpc: "2.0", id: f.id, result: { serverInfo: { name: "s", version: "0" } } });
  await startP;

  // 模拟 T2 场景：启动失败的 stderr 含解析后 env map（密钥明文）
  child.stderr.write("config load failed: resolved env: { DWS_PASSWORD: 'secret123', DWS_USER: 'aiuser', DEEPSEEK_API_KEY: 'sk-test-key' }\n");
  await new Promise((r) => setImmediate(r));
  const tail = client.stderrTail();
  assert.ok(!tail.includes("secret123"), "DWS_PASSWORD 值不得出现在 stderrTail");
  assert.ok(!tail.includes("sk-test-key"), "DEEPSEEK_API_KEY 值不得出现在 stderrTail");
  assert.ok(tail.includes("***"));
  // KEY=value 形态兜底（值未知时也遮蔽）；词表放宽：未预知键（AUTH_TOKEN 等）同样遮蔽
  child.stderr.write("DWS_RUN_PASSWORD=other-secret-99\nAUTH_TOKEN=xyz-token-88\n");
  await new Promise((r) => setImmediate(r));
  const tail2 = client.stderrTail();
  assert.ok(!tail2.includes("other-secret-99"));
  assert.ok(tail2.includes("DWS_RUN_PASSWORD=***"));
  assert.ok(!tail2.includes("xyz-token-88"), "AUTH_TOKEN 值不得出现在 stderrTail");
  assert.ok(tail2.includes("AUTH_TOKEN=***"));

  // 环形缓冲：只保尾 4KB
  child.stderr.write("x".repeat(10_000));
  await new Promise((r) => setImmediate(r));
  assert.ok(client.stderrTail().length <= 4096 + 100); // 消毒替换可能增宽极少量
});

// ── 6. createSession：目录 + env（resolveDbAccount 集成）+ historyPrefix + sessionId 唯一 ──
const ENV_KEYS = ["DWS_RUN_USER", "DWS_RUN_PASSWORD", "DEEPSEEK_API_KEY"] as const;
let savedEnv: Record<string, string | undefined>;
beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; }
  process.env.DWS_RUN_USER = "dws_readonly";
  process.env.DWS_RUN_PASSWORD = "run-pass-77";
  process.env.DEEPSEEK_API_KEY = "sk-live";
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function makeSessionOpts(workroot: string, resultsRoot: string): SessionOpts {
  return {
    sessionId: "sess-001",
    workroot,
    resultsRoot,
    assetsDir: "D:\\x\\assets",
    runnerPath: "D:\\x\\run_in_sandbox.sh",
    skillsDir: "D:\\x\\skills",
    db: resolveDbAccount("default"),
    attempt: 3,
  };
}

test("createSession：建目录 + env 全量注入（REQUIRED_ENV_KEYS）+ DWS 凭据经 resolveDbAccount + Temp WARN", async () => {
  const root = mkdtempSync(join(tmpdir(), "gw-t5-"));
  try {
    const warnings: string[] = [];
    const children: FakeChild[] = [];
    const kills: number[] = [];
    const backend = new DshBackend({
      onWarn: (m) => warnings.push(m),
      spawnFn: (_c, _a, opts) => { const ch = makeFakeChild(); (ch as any).__opts = opts; children.push(ch); return ch as unknown as ChildProcess; },
      killTreeFn: (pid) => { kills.push(pid ?? -1); children.forEach((c) => c.emit("exit", 9)); },
    });

    // Temp 树内 → WARN（附录 A）
    const session = await backend.createSession(makeSessionOpts(root, root));
    assert.ok(warnings.some((w) => w.includes("Temp") && w.includes("workdir")), `应 WARN Temp 路径: ${warnings}`);

    // 目录创建
    assert.ok(existsSync(join(root, "sess-001", "workdir")));
    assert.ok(existsSync(join(root, "sess-001", "results")));

    // 首次 ask → spawn；generator 惰性，先起消费协程再喂应答
    const collected: any[] = [];
    const askIt = session.ask("分析Q3库存", { historyPrefix: "历史：PX-77", timeoutMs: 60_000 });
    const askDone = (async () => { for await (const ev of askIt) collected.push(ev); })();
    await waitFor(() => children.length === 1 && childWrites(children[0]).some((f) => f.method === "initialize"), 3000, "initialize 帧");
    const opts = (children[0] as any).__opts;
    for (const k of REQUIRED_ENV_KEYS) {
      assert.ok(opts.env[k] !== undefined, `env 缺 ${k}`);
    }
    assert.equal(opts.env.DWS_PASSWORD, "run-pass-77"); // 经 db.passwordEnv（DWS_RUN_PASSWORD）
    assert.equal(opts.env.DWS_USER, "dws_readonly");    // 经 resolveDbAccount
    assert.equal(opts.env.DEEPSEEK_API_KEY, "sk-live");
    assert.equal(opts.env.M0_SANDBOX_WORKDIR, join(root, "sess-001", "workdir"));
    assert.equal(opts.env.M0_RESULTS_DIR, join(root, "sess-001", "results"));
    assert.equal(opts.env.RESULT_DIR, join(root, "sess-001", "results"));
    assert.equal(opts.env.M0_SANDBOX_RUNNER, "D:\\x\\run_in_sandbox.sh");
    assert.equal(opts.cwd, join(root, "sess-001", "workdir"));

    // initialize + prompt 帧应答（historyPrefix 拼接 + SDK sessionId 跨实例唯一形态）
    const w0 = childWrites(children[0]).find((f) => f.method === "initialize");
    line(children[0], { jsonrpc: "2.0", id: w0.id, result: { serverInfo: { name: "deepseek-harness-sdk-runtime", version: "0.0.1" } } });
    await waitFor(() => childWrites(children[0]).some((f) => f.method === "session/prompt"), 3000, "prompt 帧");
    const wPrompt = childWrites(children[0]).find((f) => f.method === "session/prompt");
    // 形态断言：gw-sess-001-a3-<6位随机hex>（随机段=实例无关唯一性，I-1）
    assert.ok(/^gw-sess-001-a3-[0-9a-f]{6}$/.test(wPrompt.params.sessionId), `sessionId 形态: ${wPrompt.params.sessionId}`);
    const sid1: string = wPrompt.params.sessionId;
    assert.ok(wPrompt.params.contentBlocks[0].text.startsWith("历史：PX-77"));
    assert.ok(wPrompt.params.contentBlocks[0].text.endsWith("分析Q3库存"));
    line(children[0], { jsonrpc: "2.0", id: wPrompt.id, result: { messageId: "m1" } });
    notifyEvent(children[0], sid1, { type: "turn/end", seq: 2, data: { turn: 1, reason: { kind: "completed" } } });
    await askDone;
    assert.equal(collected.length, 0); // 该问无中间事件 → 空流自然终止

    // 第二问同客户端（同 spawn → 同 SDK sessionId）
    const got: any[] = [];
    const it2 = session.ask("第二问");
    const done2 = (async () => { for await (const ev of it2) got.push(ev); })();
    await waitFor(() => childWrites(children[0]).filter((f) => f.method === "session/prompt").length >= 2, 3000, "第二问 prompt 帧");
    const w2 = childWrites(children[0]).filter((f) => f.method === "session/prompt").pop();
    assert.equal(w2.params.sessionId, sid1);
    line(children[0], { jsonrpc: "2.0", id: w2.id, result: { messageId: "m2" } });
    notifyEvent(children[0], sid1, {
      type: "assistant/message", seq: 3, data: { turn: 2, message: { role: "assistant", content: [{ type: "text", text: "答" }] } },
    });
    notifyEvent(children[0], sid1, { type: "turn/end", seq: 4, data: { turn: 2, reason: { kind: "completed" } } });
    await done2;
    assert.deepEqual(got.map((e) => e.type), ["answer"]);
    assert.equal(got[0].markdown, "答");

    // cancel：killTree 击杀进程树
    await session.cancel();
    assert.ok(kills.length >= 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createSession：进程死亡后下一问 respawn 新 SDK sessionId（S3 约束：跨 spawn 复用必 id collision）", async () => {
  const root = mkdtempSync(join(tmpdir(), "gw-t5b-"));
  try {
    const children: FakeChild[] = [];
    const backend = new DshBackend({
      spawnFn: () => { const ch = makeFakeChild(); children.push(ch); return ch as unknown as ChildProcess; },
      killTreeFn: () => {},
    });
    const session = await backend.createSession(makeSessionOpts(root, root));

    // 第一问：完成（消费协程驱动 generator，测试喂应答）
    const it1 = session.ask("q1");
    const done1 = (async () => { for await (const _ of it1) { /* drain */ } })();
    await waitFor(() => children.length >= 1 && childWrites(children[0]).some((f) => f.method === "initialize"), 3000, "initialize 帧");
    const w1 = childWrites(children[0]).find((f) => f.method === "initialize");
    line(children[0], { jsonrpc: "2.0", id: w1.id, result: { serverInfo: { name: "s", version: "0" } } });
    await waitFor(() => childWrites(children[0]).some((f) => f.method === "session/prompt"), 3000, "prompt 帧");
    const p1 = childWrites(children[0]).find((f) => f.method === "session/prompt");
    line(children[0], { jsonrpc: "2.0", id: p1.id, result: { messageId: "m1" } });
    notifyEvent(children[0], p1.params.sessionId, { type: "turn/end", seq: 1, data: { turn: 1, reason: { kind: "completed" } } });
    await done1;

    // 子进程意外死亡 → 下一问 respawn：新进程 + 新 SDK sessionId（代数+1）
    children[0].emit("exit", 1);
    const it2 = session.ask("q2");
    const done2 = (async () => { for await (const _ of it2) { /* drain */ } })();
    await waitFor(() => children.length === 2, 3000, "respawn 新子进程");
    await waitFor(() => childWrites(children[1]).some((f) => f.method === "initialize"), 3000, "initialize 帧(2)");
    const w2 = childWrites(children[1]).find((f) => f.method === "initialize");
    line(children[1], { jsonrpc: "2.0", id: w2.id, result: { serverInfo: { name: "s", version: "0" } } });
    await waitFor(() => childWrites(children[1]).some((f) => f.method === "session/prompt"), 3000, "prompt 帧(2)");
    const p2 = childWrites(children[1]).find((f) => f.method === "session/prompt");
    // respawn：代数+1 且随机段重掷（形态断言 + 与首代不同——跨 spawn 不复用）
    assert.ok(/^gw-sess-001-a4-[0-9a-f]{6}$/.test(p2.params.sessionId), `respawn sessionId 形态: ${p2.params.sessionId}`);
    assert.notEqual(p2.params.sessionId, p1.params.sessionId, "respawn 后 SDK sessionId 必须换代");
    line(children[1], { jsonrpc: "2.0", id: p2.id, result: { messageId: "m2" } });
    notifyEvent(children[1], p2.params.sessionId, { type: "turn/end", seq: 1, data: { turn: 1, reason: { kind: "completed" } } });
    await done2;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createSession：缺 DWS_RUN_PASSWORD → CONFIG 快败（不 spawn）", async () => {
  delete process.env.DWS_RUN_PASSWORD;
  const backend = new DshBackend({ spawnFn: () => { throw new Error("must not spawn"); } });
  const root = mkdtempSync(join(tmpdir(), "gw-t5c-"));
  try {
    await assert.rejects(backend.createSession(makeSessionOpts(root, root)), /DWS_RUN_PASSWORD not set/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
