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
// Linux isolated cleanup hold 为 recovery_required 时，额外发送一条 code-only error
// （合成 id 编码真实断点 + 重连 204）并关流；off/Windows 不读 hold，旧行为逐字不变。
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
  /**
   * Linux isolated cleanup hold 模式。缺省/false 时 SSE 保持旧行为，绝不读取
   * cleanup_holds；只有显式开启才发送 recovery_required 受控通知。
   */
  cleanupHoldMode?: boolean;
}

/** SSE recovery 通知的错误码（与 TaskStore 的 CLEANUP_RECOVERY_REQUIRED 同值）。 */
export const CLEANUP_RECOVERY_SSE_CODE = "CLEANUP_RECOVERY_REQUIRED";

/**
 * recovery 通知的合成 SSE id 保留区。它不是 events 表里的 seq：
 *   id = CLEANUP_RECOVERY_SSE_ID_BASE + 收到通知时的真实 lastSeq
 * 这样自动重连带回合成 id 时，服务端既能识别“已通知”，又能在 hold 已解除后
 * 还原真实游标、从断点继续消费，绝不会因合成值大于所有真实 seq 而漏事件。
 *
 * 保留区上限 = BASE + (BASE - 1)：保证可还原的真实 lastSeq 始终低于 BASE，
 * 不会把另一个保留区值误当成真实断点；同时整体低于 2^31-1，旧客户端 32 位解析不溢出。
 * 真实 seq 必须远低于 BASE（任务级事件数不可能接近 10 亿）；越界视为协议损坏。
 */
export const CLEANUP_RECOVERY_SSE_ID_BASE = 1_000_000_000;
export const CLEANUP_RECOVERY_SSE_ID_MAX = CLEANUP_RECOVERY_SSE_ID_BASE * 2 - 1;

/** 仅当 id 落在保留区时返回其携带的真实 lastSeq；普通 seq 返回 null。 */
export function recoverySseCheckpoint(id: number): number | null {
  if (!Number.isSafeInteger(id)) return null;
  if (id < CLEANUP_RECOVERY_SSE_ID_BASE || id > CLEANUP_RECOVERY_SSE_ID_MAX) return null;
  return id - CLEANUP_RECOVERY_SSE_ID_BASE;
}

function recoverySseId(lastSeq: number): number {
  if (!Number.isSafeInteger(lastSeq) || lastSeq < 0 || lastSeq >= CLEANUP_RECOVERY_SSE_ID_BASE) {
    throw new Error("event sequence exceeded recovery cursor reserved range");
  }
  return CLEANUP_RECOVERY_SSE_ID_BASE + lastSeq;
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
 * 是否处于 cleanup recovery_required：
 * - 只读当前 tasks 行与当前 attempt 的 hold，每轮取最新值，避免 SSE 持有旧 attempt；
 * - 只在 cleanupHoldMode 显式开启时生效，Windows/off 路径零查询、零行为变化；
 * - hold 读取失败按 recovery 处理（fail-closed），不让连接静默悬挂。
 */
function cleanupRecoveryRequired(deps: HttpGatewayDeps, runId: string): boolean {
  if (deps.config.cleanupHoldMode !== true) return false;
  try {
    const current = deps.store.getTask(runId);
    if (!current) return false;
    if (current.status === "running" && current.error_code === CLEANUP_RECOVERY_SSE_CODE) {
      return true;
    }
    return deps.store.getCleanupHold(current.run_id, current.attempt)?.state === "recovery_required";
  } catch (err) {
    console.error(`[sse] cleanup hold 读取失败 run_id=${runId}:`, err);
    return true;
  }
}

/** code-only 通知：只给码和 run_id；文案由 BFF/UI 按码映射，不把其余状态带出网关。
 *  若真实 seq 已进入保留区（协议损坏），拒绝编码并返回 null；调用方关流，绝不抛出
 *  未捕获异常。GET 仍可通过 recovery_required 观察状态。 */
function recoveryErrorFrame(runId: string, lastSeq: number): string | null {
  try {
    return sseFrame(recoverySseId(lastSeq), "error", {
      code: CLEANUP_RECOVERY_SSE_CODE,
      run_id: runId,
    });
  } catch (err) {
    console.error(`[sse] recovery 游标编码失败 run_id=${runId}:`, err);
    return null;
  }
}

function sendRecoveryNotice(res: ServerResponse, runId: string, lastSeq: number): void {
  const frame = recoveryErrorFrame(runId, lastSeq);
  if (frame !== null) res.write(frame);
}

/**
 * 事件流：先重放 (afterSeq, …] 全量补发，再挂 500ms 轮询实时层；done 事件发出后
 * 服务端主动关流（正常结束语义），reaper 终态（无 done 事件）以任务行 status 兜底。
 *
 * cleanup hold 模式额外规则：只要当前 attempt 进入 recovery_required，就在已重放事件
 * 之后补发一条 code-only error 并立即关流。通知 id 编码真实 lastSeq（BASE + lastSeq）；
 * 自动重连带回时：仍 recovery → 204，已解除 → 还原断点继续消费，绝不把合成值当普通 seq。
 * 这里绝不写任务状态、绝不补 done、绝不触发重试。
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
  const finishWithRecoveryNoticeIfNeeded = () => {
    if (cleanupRecoveryRequired(deps, task.run_id)) {
      sendRecoveryNotice(res, task.run_id, lastSeq);
    }
    finish();
  };

  startSse(res);

  try {
    // 1. 重放：与重连同一查询路径（seq > afterSeq），天然不重不漏。done 是最后一条
    // 业务事件；命中后先检查 recovery hold，再决定发通知/正常关流。
    let replayedDone = false;
    for (const ev of store.listEvents(task.run_id, lastSeq)) {
      res.write(sseFrame(ev.seq, ev.type, ev.payload));
      lastSeq = ev.seq;
      if (ev.type === "done") {
        replayedDone = true;
        break;
      }
    }
    if (replayedDone) return finishWithRecoveryNoticeIfNeeded();

    // recovery_required 的任务保持 running（或已有 failed/cancelled done），SSE 不能等
    // 待后续事件，也不能把任务伪装成终态；发受控通知后关闭。
    if (cleanupRecoveryRequired(deps, task.run_id)) {
      sendRecoveryNotice(res, task.run_id, lastSeq);
      return finish();
    }

    // 重放即终态且无 done（reaper 收尾的终态不落 done 事件——T7/T4 裁定）→ 兜底关流。
    const t0 = store.getTask(task.run_id);
    if (t0 && TERMINAL_STATUS.has(t0.status)) return finish();
  } catch (err) {
    // headers 已发出后不能再走 sendError（会二次 writeHead）；这里必须收尾关流，
    // 绝不让 SSE 请求因库/编码异常永久挂起。
    console.error(`[sse] 初始重放失败 run_id=${task.run_id}:`, err);
    return finish();
  }

  // 2. 实时层：轮询新 seq（选型理由见文件头）。
  pollTimer = setInterval(() => {
    try {
      const evs = store.listEvents(task.run_id, lastSeq);
      let sawDone = false;
      for (const ev of evs) {
        res.write(sseFrame(ev.seq, ev.type, ev.payload));
        lastSeq = ev.seq;
        if (ev.type === "done") {
          sawDone = true;
          break;
        }
      }
      if (sawDone) return finishWithRecoveryNoticeIfNeeded();

      // reaper/boot recovery 不追加事件，必须在每轮 poll 主动检查 hold。
      if (cleanupRecoveryRequired(deps, task.run_id)) {
        sendRecoveryNotice(res, task.run_id, lastSeq);
        return finish();
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

function handleGetTask(res: ServerResponse, runId: string, user: string, deps: HttpGatewayDeps): void {
  const task = deps.store.getTask(runId);
  if (!task) return sendError(res, 404, "NOT_FOUND", "task not found");
  if (task.user !== user) return sendError(res, 403, "FORBIDDEN", "task owner mismatch");
  // 字段白名单（stderr 红线：error_message 不出网关——审计走库，前端看 stage/error_code）。
  // cleanup recovery 仅在 Linux isolated 且当前确实 recovery 时附加一个布尔字段：
  // off/Windows/正常任务的 JSON 形状逐字不变；旧客户端可忽略未知字段。
  const body: Record<string, unknown> = {
    run_id: task.run_id,
    session_id: task.session_id,
    status: task.status,
    stage: task.stage,
    attempt: task.attempt,
    error_code: task.error_code,
    created_at: task.created_at,
  };
  if (cleanupRecoveryRequired(deps, runId)) body.recovery_required = true;
  sendJson(res, 200, body);
}

function handleGetEvents(req: IncomingMessage, res: ServerResponse, runId: string, user: string, deps: HttpGatewayDeps): void {
  const task = deps.store.getTask(runId);
  if (!task) return sendError(res, 404, "NOT_FOUND", "task not found");
  if (task.user !== user) return sendError(res, 403, "FORBIDDEN", "task owner mismatch");
  const rawAfter = resumeAfter(req, new URL(req.url ?? "/", "http://localhost"));
  // 合成 id 只用于“已收到 recovery 通知”的断点标记，不能当普通 seq：
  // - 仍在 recovery_required → 204 终止自动重连；
  // - hold 已解除/人工恢复 → 还原其携带的真实 lastSeq，从断点继续消费，避免漏事件；
  // - 保留区之外的超大游标（真实 seq 不可能到这里）→ 从 0 重放，防越界污染。
  // 仅在 cleanup 模式解释保留区；Windows/off 的任意 after 语义完全不变。
  const recoveryCheckpoint =
    deps.config.cleanupHoldMode === true ? recoverySseCheckpoint(rawAfter) : null;
  if (recoveryCheckpoint !== null && cleanupRecoveryRequired(deps, runId)) {
    res.writeHead(204, { "Cache-Control": "no-store" });
    res.end();
    return;
  }
  const afterSeq =
    deps.config.cleanupHoldMode === true
      ? recoveryCheckpoint ?? (rawAfter >= CLEANUP_RECOVERY_SSE_ID_BASE ? 0 : rawAfter)
      : rawAfter;
  streamEvents(req, res, task, afterSeq, deps);
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
      if (seg.length === 3) return handleGetTask(res, runId, user, deps);
      if (seg.length === 4 && seg[3] === "events") return handleGetEvents(req, res, runId, user, deps);
    }
  }

  sendError(res, 404, "NOT_FOUND", "no such route");
}
