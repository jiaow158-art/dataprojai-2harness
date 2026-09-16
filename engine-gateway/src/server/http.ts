// M1-T8：HTTP/SSE 服务层 —— spec §5 四端点 + §6.3 身份信任链 + D15 断线重连。
//
// 身份（spec §6.3）：user 一律取 X-User 头（claudecodeui 可信后端从登录身份生成，
// 不信浏览器直传/body 内的 user 字段——body.user 即使携带也被忽略）；缺 X-User → 400。
// Bearer AUTH_TOKEN 是服务边界（内网共享 token），/api/tasks* 全端点要求；/api/health
// 不带鉴权——探活端点只暴露队列水位，无任务数据（LB/k8s probe 直接打）。
//
// SSE 实时层实现选型：http 层 500ms 轮询 store.listEvents（选简单可靠路径）——
//   1. store 是唯一事实源，轮询与断线重放走同一条 listEvents 代码路径，重连语义
//      天然正确（seq 单调、不重不漏），无需额外正确性论证；
//   2. 零跨层耦合：不做 EventEmitter 就不必穿透 TaskRunner→store 传回调，orchestrator
//      appendEvent 保持纯落库（T7 已过审面不重开）；
//   3. better-sqlite3 同步读 + PK(run_id,seq) 索引，网关规模（10 人）下单查询亚毫秒。
// 代价是事件可见延迟 ≤500ms——spec D7 明示响应时间非首要指标。终态收流：done 事件
// 发出后关闭；reaper 收尾的终态无 done 事件，以任务行 status 兜底判终态关流。
//
// stderr 红线（T2 发现）：错误响应一律 sendError 封闭集消息——异常对象文本（可能含
// 路径/env/引擎 stderr）只进服务端日志，绝不序列化进响应体。引擎 error_message 已在
// T5 消毒，但 GET 任务状态响应仍按任务书字段白名单返回（不含 error_message）。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { TaskRow, TaskStore } from "../store/task-store.ts";
import type { WorkerPool } from "./worker-pool.ts";

export interface HttpGatewayConfig {
  authToken: string;
  /** 全局排队上限（看 pool.stats.queued；超出 → 429 RATE_LIMIT）。 */
  maxQueue: number;
  /** 按 user 的每分钟提交数上限（内存滑窗）。 */
  rateLimitQpm: number;
  /** SSE 实时层轮询间隔（默认 500ms，选型理由见文件头）。 */
  ssePollMs?: number;
  /** SSE 心跳注释行间隔（默认 15s）。 */
  heartbeatMs?: number;
  /** POST body 上限字节（默认 1MB）。 */
  maxBodyBytes?: number;
}

export interface HttpGatewayDeps {
  store: TaskStore;
  pool: WorkerPool;
  config: HttpGatewayConfig;
}

const TERMINAL_STATUS = new Set(["succeeded", "failed", "cancelled"]);

// ── 响应工具 ──────────────────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** 错误响应唯一出口：code/message 都是本文件封闭集字面量——stderr 红线（见文件头）。 */
function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  if (res.writableEnded) return;
  sendJson(res, status, { error: { code, message } });
}

// ── 请求侧工具 ────────────────────────────────────────────────────────────────────

function bearerOk(req: IncomingMessage, config: HttpGatewayConfig): boolean {
  return req.headers.authorization === `Bearer ${config.authToken}`;
}

/** user 只信 X-User 头（§6.3 可信后端）；多值取首个。 */
function trustedUser(req: IncomingMessage): string | null {
  const v = req.headers["x-user"];
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.trim() ? s.trim() : null;
}

function readBody(req: IncomingMessage, limit: number): Promise<{ ok: true; value: any } | { ok: false; status: number; message: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        resolve({ ok: false, status: 413, message: "request body too large" });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({ ok: true, value: {} });
      try {
        resolve({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      } catch {
        resolve({ ok: false, status: 400, message: "invalid JSON body" });
      }
    });
    req.on("error", () => resolve({ ok: false, status: 400, message: "request aborted" }));
  });
}

// ── QPM 限流（内存滑窗：每 user 保留最近 60s 提交时间戳）───────────────────────────
// 单服务部署 + 提交频率低（D7：10 人量级），内存态重启丢失可接受——限流是保护闸，
// 不是计费口径（审计以 tasks 表为准）。
export class QpmLimiter {
  private hits = new Map<string, number[]>();
  private qpm: number;
  private windowMs: number;
  constructor(qpm: number, windowMs = 60_000) {
    this.qpm = qpm;
    this.windowMs = windowMs;
  }
  allow(user: string, now = Date.now()): boolean {
    const arr = (this.hits.get(user) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.qpm) {
      this.hits.set(user, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(user, arr);
    return true;
  }
}

// ── SSE ───────────────────────────────────────────────────────────────────────────

/** 断点参数双通道（D15）：Last-Event-ID 头（EventSource 重连自动带）优先，?after= 查询参兜底。 */
function resumeAfter(req: IncomingMessage, url: URL): number {
  const raw = req.headers["last-event-id"] ?? url.searchParams.get("after");
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function startSse(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders?.();
}

function sseFrame(seq: number, type: string, payload: unknown): string {
  return `id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify(payload ?? null)}\n\n`;
}

/**
 * 事件流：先重放 (afterSeq, …] 全量补发，再挂 500ms 轮询实时层；done 事件发出后
 * 服务端主动关流（正常结束语义），reaper 终态（无 done 事件）以任务行 status 兜底。
 */
function streamEvents(req: IncomingMessage, res: ServerResponse, task: TaskRow, afterSeq: number, deps: HttpGatewayDeps): void {
  const { store, config } = deps;
  const pollMs = config.ssePollMs ?? 500;
  const hbMs = config.heartbeatMs ?? 15_000;
  let lastSeq = afterSeq;
  let closed = false;
  let pollTimer: NodeJS.Timeout | undefined;
  let hbTimer: NodeJS.Timeout | undefined;

  const cleanup = () => {
    clearInterval(pollTimer);
    clearInterval(hbTimer);
    pollTimer = hbTimer = undefined;
  };
  const finish = () => {
    if (closed) return;
    closed = true;
    cleanup();
    res.end();
  };

  startSse(res);

  // 1. 重放：与重连同一查询路径（seq > afterSeq），天然不重不漏。
  for (const ev of store.listEvents(task.run_id, lastSeq)) {
    res.write(sseFrame(ev.seq, ev.type, ev.payload));
    lastSeq = ev.seq;
    if (ev.type === "done") return finish();
  }
  // 重放即终态且无 done（reaper 收尾的终态不落 done 事件——T7/T4 裁定）→ 兜底关流。
  const t0 = store.getTask(task.run_id);
  if (t0 && TERMINAL_STATUS.has(t0.status)) return finish();

  // 2. 实时层：轮询新 seq（选型理由见文件头）。
  pollTimer = setInterval(() => {
    try {
      const evs = store.listEvents(task.run_id, lastSeq);
      for (const ev of evs) {
        res.write(sseFrame(ev.seq, ev.type, ev.payload));
        lastSeq = ev.seq;
        if (ev.type === "done") return finish();
      }
      if (evs.length === 0) {
        const t = store.getTask(task.run_id);
        if (t && TERMINAL_STATUS.has(t.status)) finish(); // 兜底：终态无 done（reaper 路径）
      }
    } catch (err) {
      // 库异常（如停机中 db.close）→ 记日志关流；客户端按 seq 重连恢复。
      console.error(`[sse] poll 失败 run_id=${task.run_id}:`, err);
      finish();
    }
  }, pollMs);

  // 3. 心跳：注释行保活中间层/探活半开连接（不占用 SSE 事件通道）。
  hbTimer = setInterval(() => {
    if (!closed && res.writable) res.write(": ping\n\n");
  }, hbMs);

  req.on("close", () => {
    // 客户端断开（含正常 end 后的 close）：停计时器防泄漏；closed 已 true 时幂等。
    closed = true;
    cleanup();
  });
}

// ── 端点 ──────────────────────────────────────────────────────────────────────────

async function handleCreateTask(req: IncomingMessage, res: ServerResponse, deps: HttpGatewayDeps, qpm: QpmLimiter): Promise<void> {
  const { store, pool, config } = deps;
  const user = trustedUser(req);
  if (!user) return sendError(res, 400, "BAD_REQUEST", "missing X-User header");
  // 队列上限（spec D7：允许提交≠全速并行；满了快速拒，客户端拿到确定 429）
  if (pool.stats.queued >= config.maxQueue) {
    return sendError(res, 429, "RATE_LIMIT", "task queue is full, retry later");
  }

  const body = await readBody(req, config.maxBodyBytes ?? 1_048_576);
  if (!body.ok) return sendError(res, body.status, "BAD_REQUEST", body.message);
  if (typeof body.value.question !== "string" || !body.value.question.trim()) {
    return sendError(res, 400, "BAD_REQUEST", "question is required");
  }
  if (body.value.session_id !== undefined && typeof body.value.session_id !== "string") {
    return sendError(res, 400, "BAD_REQUEST", "session_id must be a string");
  }
  if (body.value.client_submission_id !== undefined && typeof body.value.client_submission_id !== "string") {
    return sendError(res, 400, "BAD_REQUEST", "client_submission_id must be a string");
  }
  if (body.value.scope_group !== undefined && typeof body.value.scope_group !== "string") {
    return sendError(res, 400, "BAD_REQUEST", "scope_group must be a string");
  }
  if (!qpm.allow(user)) return sendError(res, 429, "RATE_LIMIT", "user QPM limit exceeded");

  // D14 三层会话：session_id 缺省 = 首次提问，服务端开逻辑对话并在响应返回。
  const session_id = body.value.session_id || `sess-${randomUUID()}`;
  const { run_id } = store.createTask({
    session_id,
    user,
    question: body.value.question,
    ...(body.value.client_submission_id ? { client_submission_id: body.value.client_submission_id } : {}),
    ...(body.value.scope_group ? { scope_group: body.value.scope_group } : {}),
  });
  // 幂等重放（created=false）时 run_id 是原任务——响应 session_id 必须回读原值
  // （响应丢失重试场景 body 不带 session_id，回显请求侧值会开出幽灵会话）。
  const task = store.getTask(run_id)!;
  sendJson(res, 201, { run_id: task.run_id, session_id: task.session_id });
}

function handleGetTask(res: ServerResponse, runId: string, user: string, store: TaskStore): void {
  const task = store.getTask(runId);
  if (!task) return sendError(res, 404, "NOT_FOUND", "task not found");
  if (task.user !== user) return sendError(res, 403, "FORBIDDEN", "task owner mismatch");
  // 字段白名单（stderr 红线：error_message 不出网关——审计走库，前端看 stage/error_code）
  sendJson(res, 200, {
    run_id: task.run_id,
    session_id: task.session_id,
    status: task.status,
    stage: task.stage,
    attempt: task.attempt,
    error_code: task.error_code,
    created_at: task.created_at,
  });
}

function handleGetEvents(req: IncomingMessage, res: ServerResponse, runId: string, user: string, deps: HttpGatewayDeps): void {
  const task = deps.store.getTask(runId);
  if (!task) return sendError(res, 404, "NOT_FOUND", "task not found");
  if (task.user !== user) return sendError(res, 403, "FORBIDDEN", "task owner mismatch");
  streamEvents(req, res, task, resumeAfter(req, new URL(req.url ?? "/", "http://localhost")), deps);
}

export function createHttpServer(deps: HttpGatewayDeps): Server {
  const qpm = new QpmLimiter(deps.config.rateLimitQpm);
  const server: Server = createServer((req, res) => {
    // SSE 客户端中途断开时 socket 复位会产生 ECONNRESET 噪声——吞掉，流生命周期由
    // req close 驱动。
    res.on("error", () => {});
    void route(req, res, deps, qpm).catch((err) => {
      console.error("[http] handler 异常:", err);
      sendError(res, 500, "INTERNAL", "internal error");
    });
  });
  return server;
}

async function route(req: IncomingMessage, res: ServerResponse, deps: HttpGatewayDeps, qpm: QpmLimiter): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const seg = url.pathname.split("/").filter(Boolean); // ["api","tasks",id(,,"events")]

  if (req.method === "GET" && url.pathname === "/api/health") {
    const s = deps.pool.stats;
    return sendJson(res, 200, { ok: true, queue_depth: s.queued, running: s.running });
  }

  if (seg[0] === "api" && seg[1] === "tasks") {
    // 服务边界：/api/tasks* 全端点要求 Bearer（/api/health 除外，见文件头）
    if (!bearerOk(req, deps.config)) return sendError(res, 401, "UNAUTHORIZED", "missing or invalid bearer token");

    if (req.method === "POST" && seg.length === 2) return handleCreateTask(req, res, deps, qpm);

    if (req.method === "GET" && seg.length >= 3) {
      const user = trustedUser(req);
      if (!user) return sendError(res, 400, "BAD_REQUEST", "missing X-User header");
      const runId = decodeURIComponent(seg[2]!);
      if (seg.length === 3) return handleGetTask(res, runId, user, deps.store);
      if (seg.length === 4 && seg[3] === "events") return handleGetEvents(req, res, runId, user, deps);
    }
  }

  sendError(res, 404, "NOT_FOUND", "no such route");
}
