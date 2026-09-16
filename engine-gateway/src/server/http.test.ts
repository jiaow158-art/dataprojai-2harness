// M1-T8 集成测试：in-process 组装（真 SQLite 内存库 + mock Backend 驱动的真 TaskRunner
// + 真 WorkerPool + 真监听端口的 HTTP/SSE）——spec §5 端点契约、D15 断线重连、D7 排队、
// §6.3 身份/属主、A.1 boot 自愈、T7 rider（runOnce 未捕获异常不 crash 池）。
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../store/task-store.ts";
import { TaskRunner, type TaskRunnerConfig } from "../orchestrator/task-runner.ts";
import type { BackendProvider, EngineSession, SessionOpts } from "../backends/dsh-backend.ts";
import type { NormEvent } from "../backends/dsh-events.ts";
import { WorkerPool } from "./worker-pool.ts";
import { createHttpServer } from "./http.ts";

const TOKEN = "test-token";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 5000, label = "condition"): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(15);
  }
}

// ── mock Backend（T7 同款形态：按 ask 次序演脚本；事件可带 delayMs 控节奏）────────────
interface EvItem { ev: NormEvent; delayMs?: number }
interface ScriptStep { events?: EvItem[] }

function makeBackend(script: ScriptStep[]): BackendProvider {
  let stepIdx = 0;
  class MockSession implements EngineSession {
    opts: SessionOpts;
    constructor(opts: SessionOpts) {
      this.opts = opts;
    }
    async *ask(): AsyncGenerator<NormEvent> {
      const step = script[Math.min(stepIdx++, script.length - 1)];
      for (const item of step?.events ?? []) {
        if (item.delayMs) await sleep(item.delayMs);
        yield item.ev;
      }
    }
    async cancel(): Promise<void> {}
  }
  return {
    id: "mock",
    // 镜像真实 DshBackend：建 workdir/results（产物扫描零命中 → 纯问答路径，无 report 事件）
    async createSession(opts: SessionOpts): Promise<EngineSession> {
      const { mkdirSync } = await import("node:fs");
      mkdirSync(join(opts.workroot, opts.sessionId, "workdir"), { recursive: true });
      mkdirSync(join(opts.resultsRoot, opts.sessionId, "results"), { recursive: true });
      return new MockSession(opts);
    },
  };
}

const evStageAn: NormEvent = { type: "stage", stage: "analyzing", text: "分析问题" };
const evSql = (ref: string | null): NormEvent => ({ type: "sql", sql: "SELECT 1", rows: 3, truncated: false, result_ref: ref, elapsed_ms: 5 });
const evAnswer: NormEvent = { type: "answer", markdown: "## 结论" };
const SUCCESS_SCRIPT: ScriptStep[] = [{ events: [{ ev: evStageAn }, { ev: evSql("r-1") }, { ev: evAnswer }] }];

// ── SSE 测试客户端（流式读取 + SSE 帧解析 + 类型/结束等待器）─────────────────────────
interface SseEvent { seq: number; type: string; payload: any }

class SseClient {
  events: SseEvent[] = [];
  comments = 0;
  ended = false;
  lastSeq = 0;
  private res!: http.IncomingMessage;
  private buf = "";
  private typeWaiters: { type: string; resolve: (e: SseEvent) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];
  private endWaiters: { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];

  static connect(
    port: number,
    runId: string,
    opts: { user?: string; lastEventId?: number; after?: number; token?: string | null } = {},
  ): Promise<SseClient> {
    return new Promise((resolve, reject) => {
      let path = `/api/tasks/${runId}/events`;
      if (opts.after !== undefined) path += `?after=${opts.after}`;
      const headers: Record<string, string> = { "x-user": opts.user ?? "u1" };
      if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? TOKEN}`;
      if (opts.lastEventId !== undefined) headers["last-event-id"] = String(opts.lastEventId);
      const rq = http.request({ host: "127.0.0.1", port, method: "GET", path, headers }, (res) => {
        if (res.statusCode !== 200) {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => reject(new Error(`SSE connect rejected: ${res.statusCode} ${Buffer.concat(chunks).toString("utf8")}`)));
          return;
        }
        const c = new SseClient();
        c.res = res;
        res.on("data", (d: Buffer) => c.feed(d.toString("utf8")));
        res.on("end", () => {
          c.ended = true;
          for (const w of c.endWaiters.splice(0)) {
            clearTimeout(w.timer);
            w.resolve();
          }
        });
        res.on("error", () => {});
        resolve(c);
      });
      rq.on("error", reject);
      rq.end();
    });
  }

  private feed(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf("\n\n")) >= 0) {
      this.handleFrame(this.buf.slice(0, idx));
      this.buf = this.buf.slice(idx + 2);
    }
  }

  private handleFrame(frame: string): void {
    let seq = 0;
    let type = "";
    let data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith(":")) {
        this.comments++;
        return;
      }
      if (line.startsWith("id:")) seq = Number.parseInt(line.slice(3).trim(), 10);
      else if (line.startsWith("event:")) type = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!type) return;
    const ev: SseEvent = { seq, type, payload: JSON.parse(data) };
    this.events.push(ev);
    this.lastSeq = Math.max(this.lastSeq, seq);
    this.typeWaiters = this.typeWaiters.filter((w) => {
      if (w.type !== type) return true;
      clearTimeout(w.timer);
      w.resolve(ev);
      return false;
    });
  }

  waitEvent(type: string, timeoutMs = 5000): Promise<SseEvent> {
    const existing = this.events.find((e) => e.type === type);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout waiting SSE event "${type}"; got [${this.events.map((e) => e.type).join(",")}]`)),
        timeoutMs,
      );
      this.typeWaiters.push({ type, resolve, reject, timer });
    });
  }

  waitForEnd(timeoutMs = 5000): Promise<void> {
    if (this.ended) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting SSE stream end; got [${this.events.map((e) => e.type).join(",")}]`)), timeoutMs);
      this.endWaiters.push({ resolve, reject, timer });
    });
  }

  destroy(): void {
    this.res.destroy();
  }
}

// ── JSON 请求工具 ──────────────────────────────────────────────────────────────────
interface HttpResponse { status: number; headers: http.IncomingHttpHeaders; body: any; raw: string }

function request(
  port: number,
  method: string,
  path: string,
  opts: { token?: string | null; user?: string | null; body?: unknown } = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? TOKEN}`;
    if (opts.user !== null) headers["x-user"] = opts.user ?? "u1";
    const payload = opts.body === undefined ? null : JSON.stringify(opts.body);
    if (payload !== null) {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(payload).toString();
    }
    const rq = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let body: any = raw;
        try {
          body = JSON.parse(raw);
        } catch {
          /* 非 JSON 原样返回 */
        }
        resolve({ status: res.statusCode!, headers: res.headers, body, raw });
      });
    });
    rq.on("error", reject);
    if (payload !== null) rq.write(payload);
    rq.end();
  });
}

const submit = (port: number, body: unknown, opts: { user?: string | null; token?: string | null } = {}) =>
  request(port, "POST", "/api/tasks", { body, ...opts });

// ── in-process 网关组装（每测试独立：内存库 + 临时目录 + 临时端口）─────────────────────
interface GatewayHandle {
  port: number;
  store: TaskStore;
  pool: WorkerPool;
  errors: { runId: string; err: unknown }[];
  close: () => Promise<void>;
}

const openHandles: GatewayHandle[] = [];
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gw-http-test-"));
});

afterEach(async () => {
  for (const gw of openHandles.splice(0)) await gw.close();
});

async function startGateway(opts: {
  script?: ScriptStep[];
  maxQueue?: number;
  qpm?: number;
  startPool?: boolean;
  maxConcurrent?: number;
  /** rider 测试用：包裹真实 runner 工厂 */
  runnerWrapper?: (real: (runId: string) => Promise<void>) => (runId: string) => Promise<void>;
} = {}): Promise<GatewayHandle> {
  const db = new Database(":memory:");
  const store = new TaskStore(db);
  const backend = makeBackend(opts.script ?? SUCCESS_SCRIPT);
  let wSeq = 0;
  const realFactory = (runId: string): Promise<void> =>
    new TaskRunner(store, backend, {
      workerId: `w${++wSeq}`,
      taskBudgetS: 3600,
      heartbeatIntervalMs: 3_600_000, // 缺省不心跳（专项用例自行调）
      leaseTtlMs: 90_000,
      reportCheck: { minBytes: 100 },
      paths: {
        workroot: join(root, "work"),
        resultsRoot: join(root, "results"),
        assetsDir: join(root, "assets"),
        runnerPath: join(root, "runner"),
        skillsDir: join(root, "skills"),
        reportsRoot: join(root, "published"),
      } satisfies TaskRunnerConfig["paths"],
    }).runOnce(runId);
  const runner = opts.runnerWrapper ? opts.runnerWrapper(realFactory) : realFactory;

  const errors: GatewayHandle["errors"] = [];
  const pool = new WorkerPool({
    store,
    runner,
    config: { maxConcurrent: opts.maxConcurrent ?? 2, pollIntervalMs: 15, reapIntervalMs: 10_000, maxAttempts: 3 },
    onError: (runId, err) => errors.push({ runId, err }),
  });
  const server = createHttpServer({
    store,
    pool,
    config: {
      authToken: TOKEN,
      maxQueue: opts.maxQueue ?? 100,
      rateLimitQpm: opts.qpm ?? 1000,
      ssePollMs: 15,
      heartbeatMs: 100,
    },
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("no port"));
    });
  });
  if (opts.startPool !== false) pool.start();

  const handle: GatewayHandle = {
    port,
    store,
    pool,
    errors,
    close: async () => {
      await pool.stop();
      server.close();
      server.closeAllConnections?.();
      db.close();
    },
  };
  openHandles.push(handle);
  return handle;
}

// ── 用例 1：提交→排队→running→SSE 全套事件 + done 后服务端关流 + 心跳注释行 ───────────
test("提交→排队→running→SSE 全套事件（stage/sql/answer/done）到达客户端，done 后服务端关流", async () => {
  // analyzing 事件延迟 300ms > 心跳间隔 100ms：done 前必有注释行（心跳可确定性断言）
  const gw = await startGateway({ script: [{ events: [{ ev: evStageAn, delayMs: 300 }, { ev: evSql("r-0001") }, { ev: evAnswer }] }] });

  const sub = await submit(gw.port, { question: "2024年Q3瓷砖事业部库存跌价TOP10" });
  assert.equal(sub.status, 201);
  const { run_id, session_id } = sub.body;
  assert.match(run_id, /^run-/);
  assert.match(session_id, /^sess-/);

  const c = await SseClient.connect(gw.port, run_id);
  const done = await c.waitEvent("done");
  assert.equal(done.payload.status, "succeeded");
  assert.equal(done.payload.run_id, run_id);
  assert.equal(done.payload.engine, "dsh");
  await c.waitForEnd(); // done 事件后服务端主动关闭流

  // 事件序列：claim 的 stage(queued→running) + analyzing + sql + answer + done
  assert.deepEqual(
    c.events.map((e) => e.type),
    ["stage", "stage", "sql", "answer", "done"],
  );
  assert.equal(c.events[0]!.payload.stage, "queued");
  const sql = c.events.find((e) => e.type === "sql")!;
  assert.equal(sql.payload.result_ref, "r-0001");
  assert.equal(sql.payload.rows, 3);
  const ans = c.events.find((e) => e.type === "answer")!;
  assert.equal(ans.payload.markdown, "## 结论");
  assert.ok(c.comments > 0, "SSE 心跳注释行（: ping）已到达客户端");

  // seq 从 1 连续单调（D15：递增编号可重放）
  assert.deepEqual(
    c.events.map((e) => e.seq),
    c.events.map((_, i) => i + 1),
  );

  // 终态状态查询（字段白名单）
  const st = await request(gw.port, "GET", `/api/tasks/${run_id}`);
  assert.equal(st.status, 200);
  assert.deepEqual(Object.keys(st.body).sort(), ["attempt", "created_at", "error_code", "run_id", "session_id", "stage", "status"]);
  assert.equal(st.body.status, "succeeded");
  assert.equal(st.body.attempt, 1);
  assert.equal(st.body.error_code, null);
  assert.equal(st.body.session_id, session_id);
  assert.equal(typeof st.body.created_at, "number");

  const h = await request(gw.port, "GET", "/api/health");
  assert.equal(h.status, 200);
  assert.deepEqual(h.body, { ok: true, queue_depth: 0, running: 0 });
});

// ── 用例 2：SSE 断线重连（Last-Event-ID 补发不重复；after=0 全量对账）────────────────
test("SSE 断线重连：Last-Event-ID 补发且不重复；?after=0 全量重放 seq 连续单调", async () => {
  const gw = await startGateway({
    script: [{ events: [{ ev: evStageAn }, { ev: evSql("r-1"), delayMs: 150 }, { ev: evAnswer, delayMs: 150 }] }],
  });
  const { run_id } = (await submit(gw.port, { question: "多轮第一问" })).body;

  // 连接 1：看到 sql 后断开
  const c1 = await SseClient.connect(gw.port, run_id);
  await c1.waitEvent("sql");
  const lastSeq = c1.lastSeq;
  assert.ok(lastSeq >= 3, `断点在 sql 事件之后（实际 seq=${lastSeq}）`);
  c1.destroy();

  await sleep(300); // answer/done 在断开窗口内落库（服务端不感知客户端存活）

  // 连接 2：带 Last-Event-ID——只补 lastSeq 之后的事件
  const c2 = await SseClient.connect(gw.port, run_id, { lastEventId: lastSeq });
  await c2.waitEvent("done");
  await c2.waitForEnd();
  assert.ok(c2.events.length > 0, "补发了断开窗口内的事件");
  assert.ok(
    c2.events.every((e) => e.seq > lastSeq),
    `补发不重复：全部 seq > ${lastSeq}，实际 ${c2.events.map((e) => e.seq)}`,
  );
  const seen = new Set([...c1.events.map((e) => e.seq), ...c2.events.map((e) => e.seq)]);
  assert.equal(seen.size, c1.events.length + c2.events.length, "两段连接并集无重复 seq");

  // 全量对账：?after=0 重放全部事件，seq 从 1 连续；总量与两段并集一致（无丢失）
  const c3 = await SseClient.connect(gw.port, run_id, { after: 0 });
  await c3.waitEvent("done");
  await c3.waitForEnd();
  const seqs = c3.events.map((e) => e.seq);
  assert.deepEqual(seqs, Array.from({ length: seqs.length }, (_, i) => i + 1), "全量重放 seq 连续单调");
  assert.equal(seqs.length, seen.size, "重连并集覆盖全部事件（无丢失）");
});

// ── 用例 3：幂等重提交 ─────────────────────────────────────────────────────────────
test("幂等重提交：同 client_submission_id → 同 run_id 同 session_id，均 201，无重复任务", async () => {
  const gw = await startGateway();
  // 三次提交都不带 session_id（响应丢失重试的极端形态：服务端每次会生成新 session_id，
  // 幂等必须回显原任务的 session_id 而非新值）
  const r1 = await submit(gw.port, { question: "q", client_submission_id: "cs-1" });
  const r2 = await submit(gw.port, { question: "q", client_submission_id: "cs-1" });
  const r3 = await submit(gw.port, { question: "q", client_submission_id: "cs-1" });
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 201);
  assert.equal(r3.status, 201);
  assert.equal(r2.body.run_id, r1.body.run_id);
  assert.equal(r3.body.run_id, r1.body.run_id);
  assert.equal(r2.body.session_id, r1.body.session_id);
  assert.equal(r3.body.session_id, r1.body.session_id);
  assert.equal(gw.store.getTaskBySubmission("cs-1")!.run_id, r1.body.run_id);
  const n = gw.store.sessionHistory(r1.body.session_id).length;
  assert.equal(n, 1, "store 只有一行任务（UNIQUE 幂等，无重复创建）");
});

// ── 用例 4a：队列满 429 ────────────────────────────────────────────────────────────
test("队列满 → 429 RATE_LIMIT（MAX_QUEUE 看 queued 水位）", async () => {
  const gw = await startGateway({ startPool: false, maxQueue: 2 }); // 池不启动：任务全部滞留 queued
  assert.equal((await submit(gw.port, { question: "q1", client_submission_id: "q-1" })).status, 201);
  assert.equal((await submit(gw.port, { question: "q2", client_submission_id: "q-2" })).status, 201);
  const r3 = await submit(gw.port, { question: "q3", client_submission_id: "q-3" });
  assert.equal(r3.status, 429);
  assert.equal(r3.body.error.code, "RATE_LIMIT");
  const h = await request(gw.port, "GET", "/api/health");
  assert.equal(h.body.queue_depth, 2);
});

// ── 用例 4b：QPM 限流 429 ──────────────────────────────────────────────────────────
test("按 user QPM 限流 → 429 RATE_LIMIT；其他 user 不受影响", async () => {
  const gw = await startGateway({ startPool: false, qpm: 2 });
  assert.equal((await submit(gw.port, { question: "q1", client_submission_id: "a-1" }, { user: "zhang" })).status, 201);
  assert.equal((await submit(gw.port, { question: "q2", client_submission_id: "a-2" }, { user: "zhang" })).status, 201);
  const r3 = await submit(gw.port, { question: "q3", client_submission_id: "a-3" }, { user: "zhang" });
  assert.equal(r3.status, 429);
  assert.equal(r3.body.error.code, "RATE_LIMIT");
  assert.equal((await submit(gw.port, { question: "q4", client_submission_id: "a-4" }, { user: "li" })).status, 201, "其他 user 独立配额");
});

// ── 用例 4c/4d：鉴权 401 / 身份 400 ─────────────────────────────────────────────────
test("无 token/错 token → 401；无 X-User → 400（POST 与 GET 一致）", async () => {
  const gw = await startGateway();
  const { run_id } = (await submit(gw.port, { question: "q", client_submission_id: "auth-1" })).body;

  assert.equal((await submit(gw.port, { question: "q" }, { token: null })).status, 401);
  assert.equal((await submit(gw.port, { question: "q" }, { token: "wrong" })).status, 401);
  assert.equal((await request(gw.port, "GET", `/api/tasks/${run_id}`, { token: null })).status, 401);
  const err401 = await submit(gw.port, { question: "q" }, { token: null });
  assert.equal(err401.body.error.code, "UNAUTHORIZED");

  assert.equal((await submit(gw.port, { question: "q" }, { user: null })).status, 400);
  assert.equal((await request(gw.port, "GET", `/api/tasks/${run_id}`, { user: null })).status, 400);
  const err400 = await submit(gw.port, { question: "q" }, { user: null });
  assert.equal(err400.body.error.code, "BAD_REQUEST");
});

// ── 用例 5：跨 user 属主校验 403 ───────────────────────────────────────────────────
test("跨 user 访问 → 403：GET task 与 GET events 各一；未知 run_id → 404", async () => {
  const gw = await startGateway();
  const { run_id } = (await submit(gw.port, { question: "q", client_submission_id: "own-1" }, { user: "zhang" })).body;

  const st = await request(gw.port, "GET", `/api/tasks/${run_id}`, { user: "attacker" });
  assert.equal(st.status, 403);
  assert.equal(st.body.error.code, "FORBIDDEN");

  await assert.rejects(
    () => SseClient.connect(gw.port, run_id, { user: "attacker" }),
    /403/,
    "跨 user 订阅事件流被拒",
  );

  assert.equal((await request(gw.port, "GET", `/api/tasks/run-not-exist`, { user: "zhang" })).status, 404);
});

// ── 用例 6：boot 自愈（附录 A.1）────────────────────────────────────────────────────
test("boot 自愈：预置孤儿 running 租约 → pool.start 清租约 → attempt+1 接管至终态", async () => {
  const gw = await startGateway({ startPool: false });
  const { run_id } = (await submit(gw.port, { question: "上次进程死亡时正在跑的问题", client_submission_id: "orphan-1" })).body;
  // 模拟上一次进程死亡残留：running + 未过期租约（死实例再也不会心跳）
  assert.ok(gw.store.claimLease(run_id, "dead-instance", 3_600_000, 3600));
  assert.equal(gw.store.getTask(run_id)!.status, "running");
  assert.equal(gw.store.getTask(run_id)!.attempt, 1);

  gw.pool.start(); // start() 首步 healOrphans → 接管臂 claimLease（attempt=2）

  await waitFor(() => gw.store.getTask(run_id)!.status === "succeeded", 5000, "孤儿任务被接管并跑完");
  const t = gw.store.getTask(run_id)!;
  assert.equal(t.attempt, 2, "接管 claim 的 attempt+1（非从 0 重来）");
  const doneEv = gw.store.listEvents(run_id, 0).find((e) => e.type === "done")!;
  assert.equal(doneEv.payload.recovered, true, "done.recovered 标记恢复路径");
});

// ── 用例 7：终态后新建 SSE 连接 → 重放含 done → 服务端主动关流 ────────────────────────
test("done 后 SSE 流正常关闭：终态后连接只重放即关，不悬挂", async () => {
  const gw = await startGateway();
  const { run_id } = (await submit(gw.port, { question: "q", client_submission_id: "close-1" })).body;
  await waitFor(() => gw.store.getTask(run_id)!.status === "succeeded", 5000, "任务完成");

  const c = await SseClient.connect(gw.port, run_id);
  await c.waitForEnd(3000);
  assert.equal(c.ended, true, "服务端在重放完 done 后主动 end");
  const types = c.events.map((e) => e.type);
  assert.ok(types.includes("done"), "重放包含 done");
  assert.ok(!types.includes("error"), "无错误事件");
});

// ── 用例 8：T7 rider——runOnce 未捕获异常 → 池不 crash、后续任务正常派发 ───────────────
test("T7 rider：runner 抛未捕获异常 → 池捕获不 crash、受害者留待 reaper、下个任务正常派发", async () => {
  let victim: string | null = null;
  const gw = await startGateway({
    startPool: false, // 先提交、标记受害者后再启动池（保证受害者先派发）
    runnerWrapper: (real) => async (runId) => {
      if (runId === victim) {
        // 真实表面：copyFileSync 磁盘错发生在 runOnce 中段（claimLease 获权之后）——
        // 先同形获权，再抛未捕获异常
        gw.store.claimLease(runId, "victim-worker", 3_600_000, 3600);
        throw new Error("EACCES: copyFileSync 模拟磁盘错（runOnce 未捕获异常表面）");
      }
      await real(runId);
    },
  });
  const r1 = await submit(gw.port, { question: "会触发磁盘错的任务", client_submission_id: "rider-1" });
  victim = r1.body.run_id;
  gw.pool.start();

  await waitFor(() => gw.errors.some((e) => e.runId === victim), 3000, "池捕获未捕获异常并记录");
  assert.match(String(gw.errors[0]!.err), /copyFileSync/);
  assert.equal(gw.store.getTask(r1.body.run_id)!.status, "running", "受害者不被池代写终态——租约过期后由 reaper 收尾（A.1）");

  // 池仍活着：后续任务正常派发并完成
  const r2 = await submit(gw.port, { question: "异常后的正常任务", client_submission_id: "rider-2" });
  await waitFor(() => gw.store.getTask(r2.body.run_id)!.status === "succeeded", 5000, "下个任务正常跑完");
  await waitFor(() => gw.pool.stats.running === 0, 3000, "失败槽位已释放");

  const h = await request(gw.port, "GET", "/api/health");
  assert.equal(h.status, 200, "进程/服务未受未捕获异常影响");
  assert.equal(h.body.ok, true);
});
