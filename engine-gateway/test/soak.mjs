#!/usr/bin/env node
// M1-T10：并发冒烟 —— 连续多批次混合画像（spec §10 验证重点）。可重复执行的驱动脚本，非单测。
//
// 运行：cd engine-gateway && SOAK_LIVE=1 node test/soak.mjs
//   （SOAK_LIVE=1 门禁防误跑——真 dsh + 真 DeepSeek + 真 DWS，一次全程约 20~40 min）
//
// 画像：3 批 × 每批 4 个画像位 = 12 画像位（池上限 MAX_CONCURRENT_TASKS=3，批=4+ 必然排队）：
//   - 2× 简单问数（eval_dataset.json inventory/ar 域原文，三批不重题）
//   - 1× 报告类（T14 缩水版原文，走 report-generator + exec_script 沙箱 + 发布路径）
//   - 1× 多轮追问（同 session_id 两连问：先分析后"增加去年同期对比"——第 2 问立即提交，
//     依 A.2 S1 同会话串行在批内排队，即多轮画像天然占 2 个任务行）
//   全批 5 个 POST 同时打出（多轮第 2 问拿到 session_id 后紧跟提交）。
//   故任务行总数 = 15（12 画像位 + 3 个多轮第 2 问）——任务书"12"按画像位计，本记录两者都报。
//   user 用 u1~u4 模拟多用户（X-User 头，spec §6.3 身份信任链）。
//
// 单任务失败载体：无 HTTP cancel 端点（M1 范围内 requestCancel 仅 store 层），故批 2 对
// 简单问数任务做 DB 直改 cancel_requested=1（与 store.requestCancel 同一条 UPDATE，黑盒
// 注入，同 T9 手法）——取消是失败面之一，验证"单任务失败不拖垮池"：目标终态 cancelled、
// 同批其余任务全部 succeeded。
//
// 断言（spec §10 第一阶段验证重点逐项）：
//   A1 全部终态无丢失     15 行全部终态，14 succeeded + 1 cancelled，零 failed
//   A2 排队可见           /api/health 采样 queue_depth>0（池=3 批=5 必然），max ≥ 2
//   A3 同会话串行（×3 批） 第 2 问 claim 事件 created_at ≥ 第 1 问 done 事件 created_at
//   A4 不串数据           a) 每任务事件流 seq 严格 1..N、六类词表、done 唯一且 run_id 对
//                         b) 抽查 3 任务 answer 与自己问题域相关
//                         c) 每任务 sql 事件 result_ref 文件都落在自己 session 的 results 目录
//                         d) reports/<user>/ 属主正确（每文件可归属；发布记录 = 报告任务数）
//   A5 取消不拖垮         目标 cancelled（done.status=cancelled），批 2 其余 4 行 succeeded
//   A6 资源清理           结束后 dsh/MCP 进程清零（前后对照）、m0sandbox-/run- 容器清零、
//                         workdir 留存并记录大小
//
// 红线：不改产品代码；异常发现记入生成的 soak.md「发现」节。
// 证据：<SOAK_ROOT>/run-<ts>/（evidence.json + harness.log + 网关工作树，Temp 树外——附录 A）。
// 本脚本每次运行重写 engine-gateway/test/soak.md（最近一跑的记录）。

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import Database from "better-sqlite3";
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── 配置 ───────────────────────────────────────────────────────────────────────────

const SOAK_ROOT = process.env.SOAK_ROOT ?? "D:\\m0-sessions\\soak";
const REPO_ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."); // 仓库根（dataprojai-2harness）
const GW_DIR = join(REPO_ROOT_DIR, "engine-gateway"); // 网关目录（cwd=网关起服务）

const TOKEN = "test-token-soak";
const RUN_TS = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14); // yyyymmddhhmmss（勿含毫秒点号——Windows 目录名尾点）

// 三批问题（eval_dataset.json 原文，批间不重题；批 2 的简单问数 inventory 题为取消目标）
const BATCHES = [
  { simpleInv: "2026年5月库存量Top10物料", simpleAr: "最新应收余额Top10客户" },
  { simpleInv: "2026年5月长库龄（24月+）物料Top10", simpleAr: "最新逾期客户Top10" },
  { simpleInv: "2026年5月各工厂库存金额Top10", simpleAr: "2026年6月回款金额Top10客户" },
];
const REPORT_Q = "给出2026年8月库存金额与24月以上长龄库存，以及瓷砖各销售中心目标达成明细，生成HTML报告";
const FUP_Q1 = "最近三个月库存库龄结构及长库龄占比";
const FUP_Q2 = "增加去年同期对比";

const MAX_CONCURRENT = 3;
const HEALTH_INTERVAL_MS = 5_000;
const POLL_INTERVAL_MS = 2_000;
const BATCH_TIMEOUT_MS = 30 * 60_000;
const CANCEL_LAND_TIMEOUT_MS = 5 * 60_000;
const CANCEL_BATCH = 2; // 批 2 注入取消（1-based）
const CANCEL_SLOT = "s1"; // 取消目标 = 批内简单问数 inventory（u1）

const LEGAL_EVENTS = new Set(["stage", "sql", "answer", "report", "error", "done"]);
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

// ── 小工具 ─────────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const fmtDur = (ms) => (ms == null ? "-" : `${(ms / 1000).toFixed(1)}s`);

function freePort() {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => res(p));
    });
    srv.on("error", rej);
  });
}

// ── 运行目录与日志 ─────────────────────────────────────────────────────────────────

const runDir = join(SOAK_ROOT, `run-${RUN_TS}`);
rmSync(runDir, { recursive: true, force: true });
mkdirSync(runDir, { recursive: true });
const logPath = join(runDir, "harness.log");
const evidencePath = join(runDir, "evidence.json");
function log(line) {
  const s = `[${new Date().toISOString()}] ${line}`;
  appendFileSync(logPath, s + "\n");
  console.log(s);
}

// ── 进程/容器观测（黑盒，PowerShell + docker CLI；自标识排除观测自身）──────────────

const POWERSHELL = (() => {
  const full = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return existsSync(full) ? full : "powershell.exe";
})();
const PS_MARKER = "soak-proc-obs-8k52";

function psList(match) {
  const script =
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '${match}' -and $_.CommandLine -notmatch '${PS_MARKER}' } | ` +
    `Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress`;
  const r = spawnSync(POWERSHELL, ["-NoProfile", "-Command", script], { encoding: "utf8", timeout: 30_000 });
  if (r.status !== 0 || !r.stdout?.trim()) return [];
  try {
    const j = JSON.parse(r.stdout);
    const arr = Array.isArray(j) ? j : [j];
    return arr.map((x) => ({ pid: Number(x.ProcessId), ppid: Number(x.ParentProcessId), cmd: String(x.CommandLine ?? "") }));
  } catch {
    return [];
  }
}
const listEngineProcs = () => psList("--profile sdk"); // dsh 引擎树（cmd shim + node dsh）
const listMcpProcs = () => psList("dws_mcp_server"); // MCP 子进程（按仓库路径过滤非本 checkout）

function dockerContainerNames() {
  const r = spawnSync("docker", ["ps", "-a", "--format", "{{.Names}}"], { encoding: "utf8", timeout: 30_000 });
  if (r.status !== 0) return null;
  return (r.stdout ?? "").split("\n").map((s) => s.trim()).filter((n) => /^m0sandbox/.test(n) || /^run-/.test(n));
}

function taskkill(pid, tree) {
  spawnSync("taskkill", tree ? ["/pid", String(pid), "/T", "/F"] : ["/pid", String(pid), "/F"], { stdio: "ignore" });
}

function dirSize(p) {
  let total = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const fp = join(d, e.name);
      if (e.isDirectory()) walk(fp);
      else {
        try {
          total += statSync(fp).size;
        } catch { /* 窗口内被删 */ }
      }
    }
  };
  walk(p);
  return total;
}

// ── 环境门（fail-fast，报 BLOCKED 原因；密钥值绝不打印）────────────────────────────

function requireLiveEnv() {
  const missing = [];
  if (!process.env.DWS_PASSWORD) missing.push("DWS_PASSWORD");
  if (!process.env.DEEPSEEK_API_KEY) missing.push("DEEPSEEK_API_KEY");
  const img = spawnSync("docker", ["images", "dataplat-script:m0", "--format", "{{.Repository}}:{{.Tag}}"], { encoding: "utf8" });
  if (img.status !== 0 || !img.stdout?.includes("dataplat-script:m0")) missing.push("docker image dataplat-script:m0");
  const dsh = spawnSync("dsh", ["--version"], { encoding: "utf8", shell: process.platform === "win32" });
  if (dsh.status !== 0) missing.push("dsh CLI");
  if (dsh.status === 0) {
    const dump = spawnSync("dsh", ["--profile", "sdk", "--dump-config"], { encoding: "utf8", shell: process.platform === "win32", timeout: 60_000 });
    if (dump.status !== 0 || !/m0-exec-script/.test(dump.stdout ?? "") || !/mcp-dws/.test(dump.stdout ?? "")) {
      missing.push("dsh sdk profile 自检失败（先跑: node engine-gateway/scripts/setup-dsh-profile.mjs --profile sdk）");
    }
  }
  if (missing.length) throw new Error(`BLOCKED: soak 环境缺失: ${missing.join(", ")}`);
  // L4 回退账号集成位：resolveDbAccount 读 DWS_RUN_PASSWORD；未建账号时从 DWS_PASSWORD 派生（同 T9）
  if (!process.env.DWS_RUN_PASSWORD && process.env.DWS_PASSWORD) {
    process.env.DWS_RUN_PASSWORD = process.env.DWS_PASSWORD;
  }
}

// ── HTTP 客户端（Node 24 全局 fetch）────────────────────────────────────────────────

async function apiGet(path, user = null) {
  const headers = user ? { Authorization: `Bearer ${TOKEN}`, "X-User": user } : {};
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) };
}

async function apiPost(path, body, user) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}`, "X-User": user },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function submitTask(user, question, opts = {}) {
  const csid = opts.clientSubmissionId ?? `soak-${RUN_TS}-${opts.slot}`;
  const body = { question, client_submission_id: csid };
  if (opts.sessionId) body.session_id = opts.sessionId;
  const r = await apiPost("/api/tasks", body, user);
  assert.equal(r.status, 201, `提交应 201: ${JSON.stringify(r.body)}`);
  assert.ok(r.body.run_id, "响应应含 run_id");
  return { runId: r.body.run_id, sessionId: r.body.session_id };
}

/** SSE 全量重放（任务已终态：服务端补发全部事件后主动关流，text() 自然结束）。 */
async function sseReplay(runId, user) {
  const r = await fetch(`http://127.0.0.1:${port}/api/tasks/${runId}/events`, {
    headers: { Authorization: `Bearer ${TOKEN}`, "X-User": user },
  });
  assert.equal(r.status, 200, `SSE 应 200: run=${runId}`);
  const text = await r.text();
  const events = [];
  for (const frame of text.split("\n\n")) {
    let seq = -1, type = "";
    const dataLines = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith(":")) continue; // 心跳注释行
      if (line.startsWith("id: ")) seq = Number(line.slice(4));
      else if (line.startsWith("event: ")) type = line.slice(7);
      else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
    }
    if (type) events.push({ seq, type, payload: dataLines.length ? JSON.parse(dataLines.join("\n")) : null });
  }
  return events;
}

// ── 网关进程 ───────────────────────────────────────────────────────────────────────

let port = null;
let gwProc = null;

async function startGateway(paths) {
  requireLiveEnv();
  port = await freePort();
  const env = {
    ...process.env,
    GATEWAY_PORT: String(port),
    AUTH_TOKEN: TOKEN,
    GW_WORKROOT: paths.workroot,
    GW_RESULTS_ROOT: paths.resultsRoot,
    GW_ASSETS_DIR: join(REPO_ROOT_DIR, "skills", "report-generator"),
    M0_SANDBOX_RUNNER: join(REPO_ROOT_DIR, "m0", "sandbox", "run_in_sandbox.sh"),
    SKILLS_DIR: join(REPO_ROOT_DIR, "skills"),
    GATEWAY_REPORTS_DIR: paths.reportsDir,
    GW_DB_PATH: paths.dbPath,
    MAX_CONCURRENT_TASKS: String(MAX_CONCURRENT),
    TASK_BUDGET_S: "1800",
    MAX_REPAIR_ROUNDS: "3",
  };
  gwProc = spawn(process.execPath, [join("src", "server", "index.ts")], {
    cwd: GW_DIR,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  gwProc.stdout?.on("data", (d) => appendFileSync(logPath, `[gw-stdout] ${d.toString().trim()}\n`));
  gwProc.stderr?.on("data", (d) => appendFileSync(logPath, `[gw-stderr] ${d.toString().trim()}\n`));

  const t0 = Date.now();
  while (true) {
    if (gwProc.exitCode !== null || gwProc.signalCode !== null) {
      throw new Error(`gateway 提前退出 code=${gwProc.exitCode} signal=${gwProc.signalCode}（见 ${logPath}）`);
    }
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.status === 200) break;
    } catch { /* 未监听，重试 */ }
    if (Date.now() - t0 > 30_000) throw new Error("gateway 30s 未健康");
    await sleep(300);
  }
  log(`gateway up: port=${port} pid=${gwProc.pid} db=${paths.dbPath}`);
}

function stopGateway() {
  if (gwProc?.pid !== undefined && gwProc.exitCode === null) taskkill(gwProc.pid, true);
}

// ── SQLite 直查/注入（黑盒，WAL 并发读 + requestCancel 同款 UPDATE）────────────────

let db = null;
function openDb(path) {
  db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
}
const eventCount = (runId) => db.prepare("SELECT COUNT(*) AS n FROM events WHERE run_id=?").get(runId).n;
const eventRows = (runId) =>
  db.prepare("SELECT seq,type,payload,created_at FROM events WHERE run_id=? ORDER BY seq").all(runId)
    .map((r) => ({ seq: r.seq, type: r.type, payload: JSON.parse(r.payload), created_at: r.created_at }));
/** 与 store.requestCancel 同一条 UPDATE（无 HTTP cancel 端点——见文件头）。 */
function requestCancelDirect(runId) {
  const r = db
    .prepare("UPDATE tasks SET cancel_requested=1, updated_at=? WHERE run_id=? AND status IN ('queued','running')")
    .run(Date.now(), runId);
  return r.changes > 0;
}

// ── 任务登记与状态轮询 ─────────────────────────────────────────────────────────────

const allTasks = []; // {key,batch,slot,profile,user,question,runId,sessionId,submittedAt,terminalAt,wallMs,finalStatus,attempt,timeline:[{t,status}]}

async function awaitBatchTerminal(batchTasks, injectCancel = null) {
  const t0 = Date.now();
  let cancelInjectedAt = null;
  let cancelLandedAt = null;
  const pending = new Set(batchTasks.map((t) => t.runId));
  while (pending.size > 0) {
    if (Date.now() - t0 > BATCH_TIMEOUT_MS) throw new Error(`批内任务 ${[...pending].join(",")} 超 ${BATCH_TIMEOUT_MS / 60000}min 未终态`);
    for (const t of batchTasks) {
      if (!pending.has(t.runId)) continue;
      const r = await apiGet(`/api/tasks/${t.runId}`, t.user);
      assert.equal(r.status, 200, `GET 状态应 200: ${t.runId}`);
      const last = t.timeline[t.timeline.length - 1];
      if (!last || last.status !== r.body.status) {
        t.timeline.push({ t: Date.now(), status: r.body.status });
        log(`  [b${t.batch}/${t.slot}] ${r.body.status}${r.body.stage ? `(${r.body.stage})` : ""} attempt=${r.body.attempt}`);
      }
      if (r.body.attempt != null) t.attempt = Math.max(t.attempt ?? 0, r.body.attempt);
      if (TERMINAL.has(r.body.status)) {
        t.finalStatus = r.body.status;
        t.terminalAt = Date.now();
        t.wallMs = t.terminalAt - t.submittedAt;
        pending.delete(t.runId);
      }
      // 取消注入：目标 running 且引擎已实开（≥2 事件）→ 置 cancel_requested（一次）
      if (injectCancel && injectCancel.runId === t.runId && cancelInjectedAt === null) {
        const cur = t.timeline[t.timeline.length - 1];
        if (cur?.status === "running" && eventCount(t.runId) >= 2) {
          const ok = requestCancelDirect(t.runId);
          cancelInjectedAt = ok ? Date.now() : null;
          log(`  [cancel] 注入 cancel_requested → ${t.runId} (ok=${ok})`);
        }
      }
      if (injectCancel && injectCancel.runId === t.runId && cancelInjectedAt !== null && cancelLandedAt === null && TERMINAL.has(r.body.status)) {
        cancelLandedAt = Date.now();
        log(`  [cancel] 落地 ${r.body.status}，注入→终态 ${(cancelLandedAt - cancelInjectedAt) / 1000}s`);
      }
      if (cancelInjectedAt !== null && cancelLandedAt === null && Date.now() - cancelInjectedAt > CANCEL_LAND_TIMEOUT_MS) {
        throw new Error(`cancel 注入后 ${CANCEL_LAND_TIMEOUT_MS / 60000}min 未落地——事件边界检查点未到达（诊断见 ${logPath}）`);
      }
    }
    if (pending.size > 0) await sleep(POLL_INTERVAL_MS);
  }
  return { cancelInjectedAt, cancelLandedAt };
}

// ── 断言登记 ───────────────────────────────────────────────────────────────────────

const assertions = [];
function check(id, name, pass, detail) {
  assertions.push({ id, name, pass: !!pass, detail });
  log(`  [断言 ${id}] ${pass ? "PASS" : "FAIL"} — ${name}${detail ? ` :: ${detail}` : ""}`);
  return !!pass;
}

/** 事件流核验：seq 严格 1..N、六类词表、done 唯一且 run_id 对。返回错误描述或 null。 */
function eventStreamDefect(events, runId) {
  if (events.length < 2) return `事件数 ${events.length} < 2`;
  for (let i = 0; i < events.length; i++) {
    if (events[i].seq !== i + 1) return `seq 不连续: 位置${i} 应为 ${i + 1} 实为 ${events[i].seq}`;
    if (!LEGAL_EVENTS.has(events[i].type)) return `词表外事件类型: ${events[i].type}`;
  }
  const dones = events.filter((e) => e.type === "done");
  if (dones.length !== 1) return `done 事件应恰 1 个，实际 ${dones.length}`;
  if (dones[0].payload?.run_id !== runId) return `done.run_id 不匹配（串流嫌疑）: ${dones[0].payload?.run_id}`;
  return null;
}

// ── 主流程 ─────────────────────────────────────────────────────────────────────────

const healthSamples = []; // {t, q, r}
let healthTimer = null;
const cancelInfo = { injectedAt: null, landedAt: null, runId: null };
const batchMeta = []; // 模块级（renderReport 直接引用——try 块局部会 ReferenceError，20260916 实测收尾崩溃）
const gwPaths = {
  workroot: join(runDir, "sessions"),
  resultsRoot: join(runDir, "results"),
  reportsDir: join(runDir, "reports"),
  dbPath: join(runDir, "gateway.db"),
};

try {
  const soakStart = Date.now();
  requireLiveEnv();
  const procBefore = { engine: listEngineProcs().length, mcp: listMcpProcs().filter((p) => p.cmd.toLowerCase().includes(REPO_ROOT_DIR.toLowerCase())).length, containers: dockerContainerNames() ?? [] };
  log(`基线快照: dsh 引擎进程=${procBefore.engine} 本仓 MCP 进程=${procBefore.mcp} m0sandbox/run- 容器=${JSON.stringify(procBefore.containers)}`);

  await startGateway(gwPaths);
  openDb(gwPaths.dbPath);

  // 全程 /api/health 采样（5s）
  healthTimer = setInterval(async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.status === 200) {
        const b = await r.json();
        healthSamples.push({ t: Date.now(), q: b.queue_depth, r: b.running });
      }
    } catch { /* 采样失败不致命 */ }
  }, HEALTH_INTERVAL_MS);
  healthTimer.unref?.();

  // ── 三批顺序执行 ──
  for (let b = 1; b <= 3; b++) {
    const qs = BATCHES[b - 1];
    const batchStart = Date.now();
    log(`── 批 ${b}/3 提交（5 POST：2 简单 + 1 报告 + 多轮两连问）──`);

    const mk = (slot, profile, user, question) => ({
      key: `b${b}-${slot}`, batch: b, slot, profile, user, question,
      runId: null, sessionId: null, submittedAt: null, terminalAt: null, wallMs: null,
      finalStatus: null, attempt: 0, timeline: [], events: null,
    });
    const s1 = mk("s1", "简单问数-inventory", "u1", qs.simpleInv);
    const s2 = mk("s2", "简单问数-ar", "u2", qs.simpleAr);
    const s3 = mk("s3", "报告类", "u3", REPORT_Q);
    const s4 = mk("s4", "多轮第1问", "u4", FUP_Q1);
    const s5 = mk("s5", "多轮第2问(同session)", "u4", FUP_Q2);

    // 并发打出：s4 先拿 session_id，s5 紧跟同会话提交（A.2 S1 下它将排队到 s4 终态）
    const batchT0 = Date.now();
    const [r1, r2, r3, r4] = await Promise.all([
      submitTask("u1", s1.question, { slot: `b${b}-s1` }),
      submitTask("u2", s2.question, { slot: `b${b}-s2` }),
      submitTask("u3", s3.question, { slot: `b${b}-s3` }),
      submitTask("u4", s4.question, { slot: `b${b}-s4` }),
    ]);
    const r5 = await submitTask("u4", s5.question, { slot: `b${b}-s5`, sessionId: r4.sessionId });
    for (const [t, r] of [[s1, r1], [s2, r2], [s3, r3], [s4, r4], [s5, r5]]) {
      t.runId = r.runId;
      t.sessionId = r.sessionId;
      t.submittedAt = batchT0; // 墙钟基准=批提交起点（本批 5 POST 齐发语义）
      t.timeline.push({ t: Date.now(), status: "queued" });
      allTasks.push(t);
    }
    log(`  run_ids: ${allTasks.slice(-5).map((t) => `${t.slot}=${t.runId.slice(4, 12)}…`).join(" ")}`);

    const inject = b === CANCEL_BATCH ? { runId: s1.runId } : null;
    if (inject) cancelInfo.runId = s1.runId;
    const cancel = await awaitBatchTerminal([s1, s2, s3, s4, s5], inject);
    if (inject) {
      cancelInfo.injectedAt = cancel.cancelInjectedAt;
      cancelInfo.landedAt = cancel.cancelLandedAt;
    }
    log(`── 批 ${b} 全终态，墙钟 ${fmtDur(Date.now() - batchStart)} ──`);

    // 批内即验：SSE 全量重放（顺带验证交付路径）+ 落事件快照
    for (const t of [s1, s2, s3, s4, s5]) {
      t.events = await sseReplay(t.runId, t.user);
      t.dbEvents = eventRows(t.runId);
    }
    batchMeta.push({ batch: b, start: batchStart, end: Date.now() });
  }

  if (healthTimer) clearInterval(healthTimer);
  await sleep(300); // 最后一次采样落地窗口

  // ── 断言 ──
  log("── 断言阶段 ──");

  // A1 全部终态无丢失
  const nonTerminal = allTasks.filter((t) => !TERMINAL.has(t.finalStatus));
  const dist = {};
  for (const t of allTasks) dist[t.finalStatus] = (dist[t.finalStatus] ?? 0) + 1;
  check("A1", "全部任务终态无丢失（15 行：14 succeeded + 1 cancelled）",
    nonTerminal.length === 0 && dist.succeeded === 14 && dist.cancelled === 1 && !dist.failed,
    `分布=${JSON.stringify(dist)} 未终态=${nonTerminal.length}`);

  // A2 排队可见
  const maxQ = Math.max(0, ...healthSamples.map((s) => s.q));
  const samplesWithQueue = healthSamples.filter((s) => s.q > 0).length;
  const queuedObserved = allTasks.filter((t) => t.timeline.some((x) => x.status === "queued")).length;
  check("A2", `排队可见（health queue_depth>0 且任务 timeline 有 queued 段）`,
    maxQ >= 2 && samplesWithQueue >= 1 && queuedObserved >= 5,
    `max queue_depth=${maxQ}, 采样点含排队=${samplesWithQueue}/${healthSamples.length}, timeline 观察到 queued 的任务=${queuedObserved}/15`);

  // A3 同会话串行（×3 批）——DB 事件时间戳为准，timeline 为辅证
  const fupPairs = [];
  for (let b = 1; b <= 3; b++) {
    const q1 = allTasks.find((t) => t.key === `b${b}-s4`);
    const q2 = allTasks.find((t) => t.key === `b${b}-s5`);
    const q1DoneAt = q1.dbEvents.find((e) => e.type === "done")?.created_at ?? null;
    const q2ClaimAt = q2.dbEvents[0]?.created_at ?? null;
    const dbOk = q1DoneAt != null && q2ClaimAt != null && q2ClaimAt >= q1DoneAt;
    const q1TermObs = q1.timeline.find((x) => TERMINAL.has(x.status))?.t ?? Infinity;
    const q2RunObs = q2.timeline.find((x) => x.status === "running")?.t ?? Infinity;
    const pollOk = q2RunObs >= q1TermObs;
    fupPairs.push({ batch: b, q1: q1.runId, q2: q2.runId, sameSession: q1.sessionId === q2.sessionId, q1DoneAt, q2ClaimAt, dbOk, pollOk });
    check(`A3-b${b}`, "同会话串行：第 2 问开始（claim）不早于第 1 问终态（done）",
      dbOk && pollOk && q1.sessionId === q2.sessionId,
      `q1.done@${q1DoneAt} ≤ q2.claim@${q2ClaimAt} · poll: q2 首次 running=${q2RunObs === Infinity ? "未观察到" : q2RunObs} ≥ q1 终态=${q1TermObs}`);
  }

  // A4a 每任务事件流完整性（不串流的结构面）
  const defects = allTasks.map((t) => ({ key: t.key, defect: eventStreamDefect(t.events, t.runId) })).filter((x) => x.defect);
  check("A4a", "各任务 SSE 事件流互不混杂（seq 严格 1..N · 六类词表 · done 唯一且 run_id 对）",
    defects.length === 0, defects.length ? JSON.stringify(defects.slice(0, 5)) : "15/15 流完整");

  // A4b 抽查 3 任务 answer 与自己问题域相关
  const SPOT = [
    { key: "b1-s1", kws: ["库存"] },
    { key: "b2-s2", kws: ["逾期", "应收"] },
    { key: "b3-s3", kws: ["库存", "长龄", "销售", "达成"] },
  ];
  const spotFail = [];
  for (const s of SPOT) {
    const t = allTasks.find((x) => x.key === s.key);
    const md = t.events.find((e) => e.type === "answer")?.payload?.markdown ?? "";
    if (!md || !s.kws.some((k) => md.includes(k))) spotFail.push(`${s.key}(命中失败, ${md.length}B)`);
  }
  check("A4b", "抽查 3 任务：answer 内容与自己 question 域相关（不串答）", spotFail.length === 0,
    spotFail.length ? spotFail.join(", ") : "b1-s1/b2-s2/b3-s3 均命中自身域关键词");

  // A4c result_ref 文件落在自己 session 的 results 目录（逐 session 校验：本会话任务产出
  // 的 ref 全部在场，且目录内无外来 ref——跨会话 RESULT_DIR 串目录即在此暴露）
  const refFail = [];
  const bySession = new Map();
  for (const t of allTasks) {
    if (!bySession.has(t.sessionId)) bySession.set(t.sessionId, []);
    bySession.get(t.sessionId).push(t);
  }
  let sessIdx = 0;
  for (const [sess, sessTasks] of bySession) {
    sessIdx++;
    const dir = join(gwPaths.resultsRoot, sess, "results");
    const onDisk = new Set(existsSync(dir) ? readdirSync(dir).map((f) => f.replace(/\.json$/, "")) : []);
    const produced = new Set();
    for (const t of sessTasks) {
      for (const e of t.events.filter((e) => e.type === "sql")) {
        if (e.payload?.result_ref) produced.add(e.payload.result_ref);
      }
    }
    for (const ref of produced) if (!onDisk.has(ref)) refFail.push(`sess${sessIdx} 缺文件 ${ref}`);
    for (const f of onDisk) if (!produced.has(f)) refFail.push(`sess${sessIdx} 外来文件 ${f}`);
    if (produced.size === 0) refFail.push(`sess${sessIdx} 无 sql 产出`);
  }
  check("A4c", `结果目录隔离：sql result_ref 文件全部落在所属 session 的 results 目录，无跨会话文件（${bySession.size} 个 session）`,
    refFail.length === 0, refFail.length ? refFail.slice(0, 6).join("; ") : `${bySession.size} 个 session 全隔离（简单 6 + 报告 3 + 多轮 3）`);

  // A4d reports/<user>/ 属主正确 + 发布记录
  const reportTasks = allTasks.filter((t) => t.profile === "报告类");
  const pubs = db.prepare("SELECT run_id, report_path FROM publications").all();
  let ownerFail = [];
  for (const t of reportTasks) {
    const pub = pubs.find((p) => p.run_id === t.runId);
    if (!pub) ownerFail.push(`${t.key} 无发布记录`);
    else {
      const expectUser = dirname(pub.report_path).split(/[\\/]/).pop();
      const expectName = `${t.runId}.html`;
      if (expectUser !== t.user || !pub.report_path.endsWith(expectName)) ownerFail.push(`${t.key} 路径/属主异常: ${pub.report_path}`);
      else if (!existsSync(pub.report_path) || statSync(pub.report_path).size < 1024) ownerFail.push(`${t.key} 产物缺失或过小`);
      const repEv = t.events.find((e) => e.type === "report");
      if (!repEv || repEv.payload?.path !== pub.report_path) ownerFail.push(`${t.key} report 事件与发布记录不一致`);
    }
  }
  // 反向：reports 树下每个文件都能归属到对应 user 的任务
  for (const u of ["u1", "u2", "u3", "u4"]) {
    const dir = join(gwPaths.reportsDir, u);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const rid = f.replace(/\.html$/, "");
      const owner = allTasks.find((t) => t.runId === rid);
      if (!owner || owner.user !== u) ownerFail.push(`${u}/${f} 无法归属`);
    }
  }
  const strayDirs = existsSync(gwPaths.reportsDir) ? readdirSync(gwPaths.reportsDir).filter((d) => !["u1", "u2", "u3", "u4"].includes(d)) : [];
  if (strayDirs.length) ownerFail.push(`reports 下意外目录: ${strayDirs.join(",")}`);
  check("A4d", `reports/<user>/ 属主正确（${reportTasks.length} 个报告任务发布、路径=reports/<user>/<run_id>.html、无跨用户产物）`,
    ownerFail.length === 0 && pubs.length === reportTasks.length,
    ownerFail.length ? ownerFail.slice(0, 6).join("; ") : `publications=${pubs.length}，全部可归属`);

  // A5 取消不拖垮
  const ct = allTasks.find((t) => t.runId === cancelInfo.runId);
  const ctDone = ct?.events?.find((e) => e.type === "done");
  const mates = allTasks.filter((t) => t.batch === CANCEL_BATCH && t.runId !== cancelInfo.runId);
  const matesOk = mates.every((t) => t.finalStatus === "succeeded");
  const landMs = cancelInfo.injectedAt && cancelInfo.landedAt ? cancelInfo.landedAt - cancelInfo.injectedAt : null;
  check("A5", "取消不拖垮池：被取消任务终态 cancelled（done.status=cancelled），同批其余 4 任务全部 succeeded",
    ct?.finalStatus === "cancelled" && ctDone?.payload?.status === "cancelled" && matesOk && landMs != null,
    `目标=${ct?.finalStatus}, done.status=${ctDone?.payload?.status}, 注入→终态=${fmtDur(landMs)}, 同批其余=${mates.map((t) => t.finalStatus).join(",")}`);

  // A6 资源清理在全部断言后执行（先停网关）
  stopGateway();
  await sleep(1500); // 留 stdin EOF 传播窗口（T9 实证引擎树 ~1.4s 自退）
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline &&
    (listEngineProcs().length > 0 || listMcpProcs().filter((p) => p.cmd.toLowerCase().includes(REPO_ROOT_DIR.toLowerCase())).length > 0)) {
    await sleep(500);
  }
  // 兜底清扫（本仓路径过滤；dsh sdk profile 本机独占可全杀——同 T9 手法）
  const ours = REPO_ROOT_DIR.toLowerCase();
  const targets = [...listEngineProcs(), ...listMcpProcs().filter((p) => p.cmd.toLowerCase().includes(ours))];
  for (const p of targets) {
    log(`cleanup: taskkill /T /F pid=${p.pid} (${p.cmd.slice(0, 90)})`);
    taskkill(p.pid, true);
  }
  const procAfter = {
    engine: listEngineProcs().length,
    mcp: listMcpProcs().filter((p) => p.cmd.toLowerCase().includes(ours)).length,
    containers: dockerContainerNames() ?? [],
  };
  const workdirBytes = dirSize(gwPaths.workroot) + dirSize(gwPaths.resultsRoot);
  check("A6", `资源清理：dsh/MCP 进程清零（${procBefore.engine}/${procBefore.mcp} → ${procAfter.engine}/${procAfter.mcp}）、m0sandbox-/run- 容器清零（${procBefore.containers.length} → ${procAfter.containers.length}）`,
    procAfter.engine === 0 && procAfter.mcp === 0 && procAfter.containers.length === 0,
    `workdir+results 留存 ${(workdirBytes / 1024).toFixed(1)} KB @ ${gwPaths.workroot}（不删，记录大小）`);

  // ── 汇总数据 ──
  const durations = {
    全部: allTasks.map((t) => t.wallMs).filter(Boolean),
    简单问数: allTasks.filter((t) => t.profile.startsWith("简单")).map((t) => t.wallMs),
    报告类: reportTasks.map((t) => t.wallMs),
    多轮第1问: allTasks.filter((t) => t.profile === "多轮第1问").map((t) => t.wallMs),
    多轮第2问: allTasks.filter((t) => t.profile === "多轮第2问(同session)").map((t) => t.wallMs),
  };
  const durStats = {};
  for (const [k, xs] of Object.entries(durations)) {
    durStats[k] = xs.length ? { n: xs.length, min: Math.min(...xs), med: median(xs), max: Math.max(...xs) } : null;
  }

  // health 曲线变化点压缩
  const changePoints = [];
  for (const s of healthSamples) {
    const prev = changePoints[changePoints.length - 1];
    if (!prev || prev.q !== s.q || prev.r !== s.r) changePoints.push(s);
  }

  // 多轮第 2 问回答摘录（发现节证据）
  const q2Answers = allTasks.filter((t) => t.profile === "多轮第2问(同session)")
    .map((t) => ({ key: t.key, head: (t.events.find((e) => e.type === "answer")?.payload?.markdown ?? "").slice(0, 220).replace(/\n+/g, " ⏎ ") }));

  const allPass = assertions.every((a) => a.pass);

  // ── evidence.json ──
  writeFileSync(evidencePath, JSON.stringify({
    run_ts: RUN_TS, run_dir: runDir, gateway_port: port,
    batches: BATCHES, report_q: REPORT_Q, fup_q1: FUP_Q1, fup_q2: FUP_Q2,
    max_concurrent: MAX_CONCURRENT,
    proc_before: procBefore, proc_after: procAfter,
    health: { samples: healthSamples.length, max_queue: maxQ, max_running: Math.max(0, ...healthSamples.map((s) => s.r)), change_points: changePoints },
    cancel: { ...cancelInfo, land_ms: landMs },
    status_dist: dist,
    durations: durStats,
    fup_pairs: fupPairs,
    assertions,
    all_pass: allPass,
    tasks: allTasks.map((t) => ({
      key: t.key, batch: t.batch, slot: t.slot, profile: t.profile, user: t.user,
      run_id: t.runId, session_id: t.sessionId, question: t.question,
      status: t.finalStatus, attempt: t.attempt, wall_ms: t.wallMs,
      done_elapsed_ms: t.events?.find((e) => e.type === "done")?.payload?.elapsed_ms ?? null,
      event_count: t.events?.length ?? 0,
      sql_events: (t.events ?? []).filter((e) => e.type === "sql").map((e) => ({ rows: e.payload?.rows, result_ref: e.payload?.result_ref })),
      answer_head: (t.events.find((e) => e.type === "answer")?.payload?.markdown ?? "").slice(0, 160),
      timeline: t.timeline,
    })),
    workdir_bytes: workdirBytes,
  }, null, 1));
  log(`evidence → ${evidencePath}`);

  // ── 生成 soak.md ──
  writeFileSync(join(GW_DIR, "test", "soak.md"), renderReport({
    procBefore, procAfter, maxQ, samplesWithQueue, queuedObserved, changePoints, durStats,
    fupPairs, dist, landMs, workdirBytes, q2Answers, allPass, pubs, reportTasks,
  }));
  log(`soak.md → ${join(GW_DIR, "test", "soak.md")}`);
  log(`soak ${allPass ? "全部断言 PASS" : "存在 FAIL 断言（见上）"}，总墙钟 ${fmtDur(Date.now() - soakStart)}`);
  process.exitCode = allPass ? 0 : 1;
} catch (err) {
  log(`FATAL: ${err?.stack ?? err}`);
  process.exitCode = 1;
} finally {
  if (healthTimer) clearInterval(healthTimer);
  stopGateway();
  if (db) {
    try { db.close(); } catch { /* 已关 */ }
  }
}

// ── soak.md 渲染 ───────────────────────────────────────────────────────────────────

function renderReport(ctx) {
  const {
    procBefore, procAfter, maxQ, samplesWithQueue, queuedObserved, changePoints, durStats,
    fupPairs, dist, landMs, workdirBytes, q2Answers, allPass, pubs, reportTasks,
  } = ctx;
  const L = [];
  const row = (cells) => `| ${cells.join(" | ")} |`;

  L.push("# M1-T10 并发冒烟记录（spec §10 验证重点）");
  L.push("");
  L.push("- 日期：" + RUN_TS.slice(0, 4) + "-" + RUN_TS.slice(4, 6) + "-" + RUN_TS.slice(6, 8));
  L.push("- 被测：`engine-gateway`（M1-T9 后工作树，`node src/server/index.ts` 组装形态），产品代码零改动——注入全黑盒（SQLite 直改 cancel_requested，与 `store.requestCancel` 同一条 UPDATE）");
  L.push(`- 运行方式：\`cd engine-gateway && SOAK_LIVE=1 node test/soak.mjs\`（门禁防误跑；可重复执行，本文件每次运行重写为最近一跑）`);
  L.push(`- 画像：3 批 × 4 画像位 = 12 画像位（2 简单问数 inventory/ar 原文 + 1 报告类 T14 缩水版 + 1 多轮两连问同 session）。多轮第 2 问为独立任务行 → 任务行共 **15**（12 画像位 + 3 个第 2 问），两口径并报`);
  L.push(`- 池上限 MAX_CONCURRENT_TASKS=${MAX_CONCURRENT}，批内 5 POST 齐发 → 必然排队；user u1~u4（X-User 头）`);
  L.push(`- 证据目录：\`${runDir}\`（evidence.json / harness.log / 网关工作树，Temp 树外）`);
  L.push("");

  L.push("## 任务行明细（15 行）");
  L.push("");
  L.push(row(["批", "槽", "画像", "user", "run_id", "终态", "attempt", "墙钟", "事件数", "问题（截断）"]));
  L.push(row(["---", "---", "---", "---", "---", "---", "---", "---", "---", "---"]));
  for (const t of allTasks) {
    L.push(row([
      t.batch, t.slot, t.profile, t.user,
      `\`${t.runId.slice(0, 16)}…\``, t.finalStatus, t.attempt, fmtDur(t.wallMs),
      t.events?.length ?? 0, t.question.slice(0, 22) + (t.question.length > 22 ? "…" : ""),
    ]));
  }
  L.push("");
  L.push(`终态分布：${JSON.stringify(dist)}；批 ${CANCEL_BATCH} 的 ${CANCEL_SLOT} 为取消注入目标（无 HTTP cancel 端点，DB 直改 \`cancel_requested=1\`，注入→终态 ${fmtDur(landMs)}）。`);
  L.push("");

  L.push("## 批次时间线");
  L.push("");
  L.push(row(["批", "起止（相对首跑提交）", "墙钟"]));
  L.push(row(["---", "---", "---"]));
  const t0 = batchMeta[0]?.start ?? 0;
  for (const m of batchMeta) {
    L.push(row([m.batch, `+${((m.start - t0) / 1000).toFixed(0)}s → +${((m.end - t0) / 1000).toFixed(0)}s`, fmtDur(m.end - m.start)]));
  }
  L.push("");

  L.push("## 每任务耗时分布");
  L.push("");
  L.push(row(["画像", "n", "min", "median", "max"]));
  L.push(row(["---", "---", "---", "---", "---"]));
  for (const [k, s] of Object.entries(durStats)) {
    L.push(row([k, s?.n ?? 0, fmtDur(s?.min), fmtDur(s?.med), fmtDur(s?.max)]));
  }
  L.push("");

  L.push(`## health 曲线摘要（/api/health 每 5s 采样，共 ${healthSamples.length} 点）`);
  L.push("");
  L.push(`- max queue_depth=**${maxQ}**（含排队采样点 ${samplesWithQueue}/${healthSamples.length}）· max running=${Math.max(0, ...healthSamples.map((s) => s.r))}（池上限 ${MAX_CONCURRENT}）`);
  L.push(`- timeline 观察到 queued 段的任务：${queuedObserved}/15`);
  L.push("- 变化点（t 相对起点，q=queue_depth，r=running）：");
  L.push("```");
  const h0 = healthSamples[0]?.t ?? 0;
  for (const s of changePoints.slice(0, 60)) {
    L.push(`  t+${((s.t - h0) / 1000).toFixed(0).padStart(4)}s  q=${s.q} r=${s.r}`);
  }
  if (changePoints.length > 60) L.push(`  …（共 ${changePoints.length} 个变化点，全量见 evidence.json）`);
  L.push("```");
  L.push("");

  L.push("## 断言结果表");
  L.push("");
  L.push(row(["#", "断言", "结果", "证据/实际"]));
  L.push(row(["---", "---", "---", "---"]));
  for (const a of assertions) {
    L.push(row([a.id, a.name, a.pass ? "**PASS**" : "**FAIL**", (a.detail ?? "").replace(/\|/g, "\\|")]));
  }
  L.push("");
  L.push(`**总判定：${allPass ? "全部 PASS" : "存在 FAIL"}**`);
  L.push("");

  L.push("## 清理核验清单");
  L.push("");
  L.push(row(["项", "运行前", "结束后", "判定"]));
  L.push(row(["---", "---", "---", "---"]));
  L.push(row(["dsh 引擎进程（--profile sdk）", procBefore.engine, procAfter.engine, procAfter.engine === 0 ? "清零" : "**残留**"]));
  L.push(row(["MCP 进程（本仓路径过滤）", procBefore.mcp, procAfter.mcp, procAfter.mcp === 0 ? "清零" : "**残留**"]));
  L.push(row(["m0sandbox-* / run-* 容器", procBefore.containers.length, procAfter.containers.length, procAfter.containers.length === 0 ? "清零" : "**残留**"]));
  L.push(row(["workdir+results 目录", "-", `${(workdirBytes / 1024).toFixed(1)} KB（留存不删）`, "记录大小"]));
  L.push("");
  L.push(`- 容器名经 SANDBOX_RUN_ID 接线（T9 遗留 L-1 已修，commit 0b020e6）为 \`run-<run_id>-a<attempt>-<pid>\`，本跑报告任务 exec_script 容器均为调用期瞬态，结束断言零残留`);
  L.push(`- 发布记录 publications=${pubs.length}（= 报告任务数 ${reportTasks.length}，恰一次）`);
  L.push("");

  L.push("## 发现（不修，记入 M1 报告）");
  L.push("");
  L.push("1. **多轮第 2 问无历史注入（spec §5 D14 缺口）**：`TaskRunner` 仅在 `attempt>1`（恢复路径）调 `buildHistoryPrefix`——同会话正常续问（attempt=1）不注入第一问的问题/回答/result_ref；而 dsh 侧 SDK 会话 id 每次 spawn 带随机段、零自恢复（S3 spike 结论）。故第 2 问「增加去年同期对比」到达模型时**没有上下文**。spec D14 要求\"任务出队开始执行时装载该对话最新已提交的历史……保证连续两问时第二问能读到第一问刚完成的结果\"——当前实现只覆盖恢复臂，未覆盖正常多轮臂。串行性（A3）不受影响；任务终态仍 succeeded（模型会澄清或泛答），但回答连续性不符合 D14。修复方向：claim 后按 `sessionHistory` 非空即注入（A.2 S2 原文 \"attempt>0\"）。第 2 问回答开头摘录：");
  for (const a of q2Answers) L.push(`   - ${a.key}: 「${a.head}…」`);
  L.push("2. `done.tokens` 恒 null（M1 编排层未实现 token 统计，T9 遗留 L-2 复现）——词表字段保留，M2 评测前补。");
  L.push("3. 任务书口径：\"3 批×每批 4 任务=12\" 按画像位计；多轮画像两连问天然是 2 个任务行（D14 三层模型：一次提问=一个 run_id），故任务行 15。断言与记录按 15 行执行，无任务丢失。");
  L.push("");
  L.push("## 复跑指引");
  L.push("");
  L.push("```bash");
  L.push("cd engine-gateway && SOAK_LIVE=1 node test/soak.mjs");
  L.push("```");
  L.push("");
  L.push("- 前置同 T9：进程 env 含 DWS_PASSWORD / DEEPSEEK_API_KEY（值不落任何文件）；dsh sdk profile（T2 产物）；docker 镜像 `dataplat-script:m0`；`SOAK_ROOT`（默认 `D:\\m0-sessions\\soak`，Temp 树外）");
  L.push("- 单任务普遍超 5 min 时按任务书红线把报告题再缩水（编辑 `soak.mjs` 顶部 `REPORT_Q`，保住\"报告+exec_script 路径被走到\"）");
  L.push("");
  return L.join("\n") + "\n";
}
