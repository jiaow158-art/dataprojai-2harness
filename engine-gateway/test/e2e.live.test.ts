// M1-T9：live E2E + 故障注入五发 —— M1 放行条件的证明材料（真 dsh + 真 DeepSeek + 真 DWS）。
//
// 默认全部 skip；E2E_LIVE=1 才跑。E2E_SHOT=<子串> 可单发选择执行（如 E2E_SHOT=shot3）。
// 运行：cd engine-gateway && E2E_LIVE=1 node --test test/e2e.live.test.ts
//
// 环境前置（缺一即 fail-fast，报 BLOCKED 原因）：
//   - 进程 env 含 DWS_PASSWORD / DEEPSEEK_API_KEY（值绝不打印——密钥红线）
//   - DWS_RUN_PASSWORD（L4 回退账号 aiuser 的口令；未设时由本文件从 DWS_PASSWORD 派生）
//   - dsh --profile sdk 已配置（T2 产物，dump-config 自检过）
//   - docker 镜像 dataplat-script:m0 在（exec_script 沙箱）
//   - E2E_ROOT（默认 D:\m0-sessions\e2e）：各 shot 的工作树根，Temp 树外（附录 A）
//
// 五发对应 spec §11.4 固定用例 + 附录 A.1 双活窗口：
//   baseline  全栈基线：http→pool→runner→真 DshBackend→dsh→DeepSeek→DWS
//   shot1     提交响应丢失重试 → client_submission_id 幂等（A.3 提交层）
//   shot2     网关进程死亡（dsh 随 stdin EOF 退出，无孤儿）→ 重启接管（A.1 boot 自愈 + A.4 行2）
//   shot3     发布后中断（publications 已写、终态未落）→ 恢复直接 succeeded（A.4 行4）
//   shot4     SSE 断线重连（Last-Event-ID）→ 不重不漏（D15/A.3 事件层）
//   shot5     双活窗口：A 心跳停滞 → B 无 heal 接管 → A 被围栏 kill 自身树（A.1 L1）
//
// 红线：故障注入不改产品代码——DB 直改 / 进程 kill / 连接断开全部黑盒。
// 每发结束清理孤儿进程/容器/临时库；证据 JSON 落各 shot 目录（E2E_ROOT 下）。

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import http from "node:http";
import net from "node:net";
import Database from "better-sqlite3";
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── 配置与环境门 ────────────────────────────────────────────────────────────────────

const LIVE = process.env.E2E_LIVE === "1";
const SHOT_FILTER = process.env.E2E_SHOT ?? "";
const E2E_ROOT = process.env.E2E_ROOT ?? "D:\\m0-sessions\\e2e";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GW_DIR = join(REPO_ROOT, "engine-gateway");
const REPO_ROOT_DIR = dirname(GW_DIR);

const TOKEN = "test-token-e2e";
const USER = "e2e-live";

// inventory 域 eval 场景原文（eval_dataset.json），按用途选择时长画像
const Q_SIMPLE = "2026年5月库存量Top10物料"; // 单查询，~2-4 min
const Q_MULTI = "最近三个月库存库龄结构及长库龄占比"; // 多查询，适合中途杀进程
const Q_TREND = "2026年上半年库存总金额与库龄趋势"; // 多查询，双活窗口跨度
const Q_REPORT =
  "请生成一份2026年5月库存分析HTML报告，内容包含：库存总量与总金额、库存量Top10物料表格、各工厂库存金额对比图。"; // 报告类（发布路径）

function skipReason(name: string): string | false {
  if (!LIVE) return "live E2E 默认跳过——需 E2E_LIVE=1（真 dsh/DeepSeek/DWS）";
  if (SHOT_FILTER && !name.includes(SHOT_FILTER)) return `被 E2E_SHOT=${SHOT_FILTER} 过滤`;
  return false;
}

/** fail-fast 环境门：缺一即抛 BLOCKED（不打印任何密钥值）。 */
function requireLiveEnv(): void {
  const missing: string[] = [];
  if (!process.env.DWS_PASSWORD) missing.push("DWS_PASSWORD");
  if (!process.env.DEEPSEEK_API_KEY) missing.push("DEEPSEEK_API_KEY");
  const img = spawnSync("docker", ["images", "dataplat-script:m0", "--format", "{{.Repository}}:{{.Tag}}"], { encoding: "utf8" });
  if (img.status !== 0 || !img.stdout?.includes("dataplat-script:m0")) missing.push("docker image dataplat-script:m0");
  const dsh = spawnSync("dsh", ["--version"], { encoding: "utf8", shell: process.platform === "win32" });
  if (dsh.status !== 0) missing.push("dsh CLI");
  if (dsh.status === 0) {
    // T2 产物自检：sdk profile 必含 m0-exec-script + mcp-dws（缺则先跑 setup-dsh-profile.mjs --profile sdk）
    const dump = spawnSync("dsh", ["--profile", "sdk", "--dump-config"], { encoding: "utf8", shell: process.platform === "win32", timeout: 60_000 });
    if (dump.status !== 0 || !/m0-exec-script/.test(dump.stdout ?? "") || !/mcp-dws/.test(dump.stdout ?? "")) {
      missing.push("dsh sdk profile 自检失败（先跑: node engine-gateway/scripts/setup-dsh-profile.mjs --profile sdk）");
    }
  }
  if (missing.length) throw new Error(`BLOCKED: live E2E 环境缺失: ${missing.join(", ")}`);
}

// L4 回退账号集成位：resolveDbAccount 读 DWS_RUN_PASSWORD；现场未建账号时从 DWS_PASSWORD 派生
if (LIVE && !process.env.DWS_RUN_PASSWORD && process.env.DWS_PASSWORD) {
  process.env.DWS_RUN_PASSWORD = process.env.DWS_PASSWORD;
}

// ── shot 工作树（Temp 树外）─────────────────────────────────────────────────────────

interface ShotDir {
  dir: string;
  workroot: string;
  resultsRoot: string;
  reportsDir: string;
  dbPath: string;
  logPath: string;
  evidence: (obj: unknown) => void;
  log: (line: string) => void;
  dispose: () => void;
}

function makeShot(name: string): ShotDir {
  const dir = join(E2E_ROOT, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, "harness.log");
  const evidencePath = join(dir, "evidence.json");
  return {
    dir,
    workroot: join(dir, "sessions"),
    resultsRoot: join(dir, "results"),
    reportsDir: join(dir, "reports"),
    dbPath: join(dir, "gateway.db"),
    logPath,
    log(line: string) {
      appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`);
    },
    evidence(obj: unknown) {
      writeFileSync(evidencePath, JSON.stringify(obj, null, 1));
    },
    dispose() {
      // 保留工作树（证据）；仅关临时库句柄由各测试自行管理
    },
  };
}

// ── 网关进程管理 ────────────────────────────────────────────────────────────────────

interface Gateway {
  proc: ChildProcess;
  port: number;
  dbPath: string;
  shot: ShotDir;
  /** kill(onlyProcess=true) = taskkill /F 仅本进程（制造孤儿）；默认 /T /F 全树。 */
  kill(onlyProcess?: boolean): void;
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => res(p));
    });
    srv.on("error", rej);
  });
}

async function startGateway(shot: ShotDir, opts: { taskBudgetS?: number } = {}): Promise<Gateway> {
  requireLiveEnv();
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GATEWAY_PORT: String(port),
    AUTH_TOKEN: TOKEN,
    GW_WORKROOT: shot.workroot,
    GW_RESULTS_ROOT: shot.resultsRoot,
    GW_ASSETS_DIR: join(REPO_ROOT_DIR, "skills", "report-generator"),
    M0_SANDBOX_RUNNER: join(REPO_ROOT_DIR, "m0", "sandbox", "run_in_sandbox.sh"),
    SKILLS_DIR: join(REPO_ROOT_DIR, "skills"),
    GATEWAY_REPORTS_DIR: shot.reportsDir,
    GW_DB_PATH: shot.dbPath,
    MAX_CONCURRENT_TASKS: "2",
    TASK_BUDGET_S: String(opts.taskBudgetS ?? 1800),
    MAX_REPAIR_ROUNDS: "3",
  };
  const proc = spawn(process.execPath, [join("src", "server", "index.ts")], {
    cwd: GW_DIR,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout?.on("data", (d: Buffer) => shot.log(`[gw-stdout] ${d.toString().trim()}`));
  proc.stderr?.on("data", (d: Buffer) => shot.log(`[gw-stderr] ${d.toString().trim()}`));

  // 健康等待（/api/health 无鉴权；30s 内不监听即失败）
  const t0 = Date.now();
  while (true) {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(`gateway 提前退出 code=${proc.exitCode} signal=${proc.signalCode}（见 ${shot.logPath}）`);
    }
    try {
      const r = await apiGet(port, "/api/health", false);
      if (r.status === 200) break;
    } catch { /* 未监听，重试 */ }
    if (Date.now() - t0 > 30_000) throw new Error("gateway 30s 未健康");
    await sleep(300);
  }
  shot.log(`gateway up: port=${port} pid=${proc.pid} db=${shot.dbPath}`);
  const gw: Gateway = {
    proc,
    port,
    dbPath: shot.dbPath,
    shot,
    kill(onlyProcess = false) {
      if (proc.pid === undefined || proc.exitCode !== null) return;
      taskkill(proc.pid, !onlyProcess);
      // 等进程真正消失（kill 后 3s 内）
      const t = Date.now();
      while (pidAlive(proc.pid) && Date.now() - t < 3000) sleepSync(200);
    },
  };
  return gw;
}

// ── HTTP API 客户端 ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

async function apiGet(port: number, path: string, auth = true): Promise<{ status: number; body: any }> {
  return new Promise((res, rej) => {
    http.get(
      {
        host: "127.0.0.1",
        port,
        path,
        headers: auth ? { Authorization: `Bearer ${TOKEN}`, "X-User": USER } : {},
      },
      (r) => {
        let b = "";
        r.on("data", (c) => (b += c));
        r.on("end", () => res({ status: r.statusCode ?? 0, body: b ? JSON.parse(b) : null }));
      },
    ).on("error", rej);
  });
}

async function apiPost(
  port: number,
  path: string,
  body: unknown,
  opts: { abandonResponse?: boolean } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((res, rej) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
          "X-User": USER,
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (r) => {
        let b = "";
        r.on("data", (c) => (b += c));
        r.on("end", () => res({ status: r.statusCode ?? 0, body: b ? JSON.parse(b) : null }));
      },
    );
    req.on("error", (e) => {
      // abandonResponse 模式：destroy 产生的 ECONNRESET/ socket hang up 是预期噪声
      if (opts.abandonResponse && (e as any)?.code === "ECONNRESET") return;
      rej(e);
    });
    req.write(data);
    req.end();
    if (opts.abandonResponse) {
      // 请求体已 flush 后直接弃连（不读响应）——shot1 注入手段
      setTimeout(() => req.destroy(), 150);
    }
  });
}

async function postTask(gw: Gateway, question: string, clientSubmissionId: string): Promise<string> {
  const r = await apiPost(gw.port, "/api/tasks", { question, client_submission_id: clientSubmissionId });
  assert.equal(r.status, 201, `提交应 201: ${JSON.stringify(r.body)}`);
  assert.ok(r.body.run_id, "响应应含 run_id");
  assert.ok(r.body.session_id, "响应应含 session_id");
  return r.body.run_id as string;
}

// ── SSE 收流 ────────────────────────────────────────────────────────────────────────

interface SseEvent {
  seq: number;
  type: string;
  payload: any;
}

/**
 * 收事件流直到服务端关流（done 后服务端主动 end；reaper 终态以任务行兜底关流）。
 * lastEventId 提供时走 D15 断线重连通道（Last-Event-ID 头）。
 */
function sseCollect(
  port: number,
  runId: string,
  opts: { after?: number; lastEventId?: number; onEvent?: (ev: SseEvent) => void } = {},
): Promise<{ events: SseEvent[]; endedByServer: boolean }> {
  return new Promise((res, rej) => {
    const headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}`, "X-User": USER };
    if (opts.lastEventId !== undefined) headers["Last-Event-ID"] = String(opts.lastEventId);
    const req = http.get(
      { host: "127.0.0.1", port, path: `/api/tasks/${runId}/events`, headers },
      (r) => {
        if (r.statusCode !== 200) {
          let b = "";
          r.on("data", (c) => (b += c));
          r.on("end", () => rej(new Error(`SSE ${r.statusCode}: ${b}`)));
          return;
        }
        const events: SseEvent[] = [];
        let buf = "";
        let ended = false;
        r.setEncoding("utf8");
        r.on("data", (chunk: string) => {
          buf += chunk;
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            let seq = -1;
            let type = "";
            const dataLines: string[] = [];
            for (const line of frame.split("\n")) {
              if (line.startsWith("id: ")) seq = Number(line.slice(4));
              else if (line.startsWith("event: ")) type = line.slice(7);
              else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
            }
            if (!type) continue; // 心跳注释行等
            const ev: SseEvent = { seq, type, payload: dataLines.length ? JSON.parse(dataLines.join("\n")) : null };
            events.push(ev);
            opts.onEvent?.(ev);
          }
        });
        r.on("end", () => {
          if (ended) return;
          ended = true;
          res({ events, endedByServer: true });
        });
        r.on("error", (e) => {
          if (ended) return;
          ended = true;
          res({ events, endedByServer: false }); // 客户端主动 destroy（shot4 注入）走此路
        });
      },
    );
    req.on("error", rej);
  });
}

/** sseCollect 的可中断形态：返回句柄，测试可中途 destroy 连接（shot4）。 */
function sseOpen(
  port: number,
  runId: string,
  onEvent: (ev: SseEvent) => void,
  opts: { after?: number; lastEventId?: number } = {},
): { done: Promise<{ events: SseEvent[]; endedByServer: boolean }>; destroy: () => void } {
  let fulfill: (v: { events: SseEvent[]; endedByServer: boolean }) => void = () => {};
  const done = new Promise<{ events: SseEvent[]; endedByServer: boolean }>((f) => (fulfill = f));
  const events: SseEvent[] = [];
  const headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}`, "X-User": USER };
  if (opts.lastEventId !== undefined) headers["Last-Event-ID"] = String(opts.lastEventId);
  const req = http.get(
    { host: "127.0.0.1", port, path: `/api/tasks/${runId}/events`, headers },
    (r) => {
      assert.equal(r.statusCode, 200, "SSE 应 200");
      let buf = "";
      r.setEncoding("utf8");
      r.on("data", (chunk: string) => {
        buf += chunk;
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let seq = -1;
          let type = "";
          const dataLines: string[] = [];
          for (const line of frame.split("\n")) {
            if (line.startsWith("id: ")) seq = Number(line.slice(4));
            else if (line.startsWith("event: ")) type = line.slice(7);
            else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
          }
          if (!type) continue;
          const ev: SseEvent = { seq, type, payload: dataLines.length ? JSON.parse(dataLines.join("\n")) : null };
          events.push(ev);
          onEvent(ev);
        }
      });
      r.on("end", () => fulfill({ events, endedByServer: true }));
      r.on("error", () => fulfill({ events, endedByServer: false }));
    },
  );
  req.on("error", () => {});
  return { done, destroy: () => req.destroy() };
}

// ── SQLite 直查（黑盒观测/注入）─────────────────────────────────────────────────────

interface TaskRowLite {
  run_id: string;
  status: string;
  stage: string | null;
  attempt: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  error_code: string | null;
  error_message: string | null;
}

function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  return db;
}

function getTask(db: Database.Database, runId: string): TaskRowLite {
  const r = db.prepare("SELECT run_id,status,stage,attempt,lease_owner,lease_expires_at,error_code,error_message FROM tasks WHERE run_id=?").get(runId) as TaskRowLite | undefined;
  assert.ok(r, `任务行应存在: ${runId}`);
  return r!;
}

async function waitFor(
  cond: () => boolean,
  timeoutMs: number,
  label: string,
  intervalMs = 1000,
): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout(${timeoutMs}ms) waiting: ${label}`);
    await sleep(intervalMs);
  }
}

// ── 进程/容器观测（PowerShell + docker CLI，黑盒）───────────────────────────────────

interface ProcInfo {
  pid: number;
  ppid: number;
  cmd: string;
}

// PowerShell 绝对路径（Git Bash 环境 PATH 常缺 WindowsPowerShell 目录）
const POWERSHELL = (() => {
  const full = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return existsSync(full) ? full : "powershell.exe";
})();

// 观测查询自标识：查询进程自身命令行必含本标记，用 -notmatch 排除自身/同类查询
// （pattern 全部不用反斜杠——跨 shell/argv 转义层行为一致）
const PS_MARKER = "e2e-proc-obs-7q31";

function psList(match: string): ProcInfo[] {
  const script =
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '${match}' -and $_.CommandLine -notmatch '${PS_MARKER}' } | ` +
    `Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress`;
  const r = spawnSync(POWERSHELL, ["-NoProfile", "-Command", script], { encoding: "utf8", timeout: 30_000 });
  if (r.status !== 0 || !r.stdout?.trim()) return [];
  try {
    const j = JSON.parse(r.stdout);
    const arr = Array.isArray(j) ? j : [j];
    return arr.map((x: any) => ({ pid: Number(x.ProcessId), ppid: Number(x.ParentProcessId), cmd: String(x.CommandLine ?? "") }));
  } catch {
    return [];
  }
}

/** dsh 引擎进程树（cmd shim + node dsh，命令行含 "--profile sdk" 空格形态）。 */
function listEngineProcs(): ProcInfo[] {
  return psList("--profile sdk");
}

/** MCP server 子进程（python dws_mcp_server.py）。 */
function listMcpProcs(): ProcInfo[] {
  return psList("dws_mcp_server");
}

function taskkill(pid: number, tree: boolean): void {
  if (!pidAlive(pid)) return;
  const args = tree ? ["/pid", String(pid), "/T", "/F"] : ["/pid", String(pid), "/F"];
  spawnSync("taskkill", args, { stdio: "ignore" });
}

function pidAlive(pid: number | undefined | null): boolean {
  if (pid === undefined || pid === null) return false;
  const r = spawnSync(POWERSHELL, ["-NoProfile", "-Command", `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'ALIVE' }`], {
    encoding: "utf8",
    timeout: 15_000,
  });
  return r.status === 0 && (r.stdout ?? "").includes("ALIVE");
}

function dockerPs(): string[] {
  const r = spawnSync("docker", ["ps", "--format", "{{.Names}}\t{{.Image}}\t{{.Status}}"], { encoding: "utf8", timeout: 30_000 });
  return r.status === 0 ? (r.stdout ?? "").trim().split("\n").filter((l) => l.includes("m0sandbox")) : [];
}

/** shot 收尾清理：杀掉本次测试产生的 dsh/MCP 残留并核验。
 *  MCP 子进程按仓库路径过滤（机器上可能存在其他 checkout 的无关 dws_mcp_server.py，
 *  不属本测试清理范围）；dsh sdk profile 为本机独占，全杀安全。 */
function killAllEngineProcs(shot: ShotDir): void {
  const ours = REPO_ROOT_DIR.toLowerCase();
  const targets = [
    ...listEngineProcs(),
    ...listMcpProcs().filter((p) => p.cmd.toLowerCase().includes(ours)),
  ];
  for (const p of targets) {
    shot.log(`cleanup: taskkill /T /F pid=${p.pid} (${p.cmd.slice(0, 90)})`);
    taskkill(p.pid, true);
  }
  const left = [
    ...listEngineProcs(),
    ...listMcpProcs().filter((p) => p.cmd.toLowerCase().includes(ours)),
  ];
  assert.equal(left.length, 0, `清理后不应残留本测试的 dsh/MCP 进程: ${JSON.stringify(left)}`);
}

// ── 通用断言 ────────────────────────────────────────────────────────────────────────

/** 事件流核验：seq 严格连续（无缺口/无回退/无重复）、type ∈ 六类词表、done 至多一个。 */
function assertEventStream(events: SseEvent[]): void {
  assert.ok(events.length >= 2, "事件流至少含 claim stage + done");
  for (let i = 0; i < events.length; i++) {
    assert.equal(events[i]!.seq, i + 1, `seq 连续: 位置${i}应为${i + 1}，实际${events[i]!.seq}`);
  }
  const LEGAL = new Set(["stage", "sql", "answer", "report", "error", "done"]);
  for (const ev of events) assert.ok(LEGAL.has(ev.type), `事件词表六类之外: ${ev.type}`);
  const dones = events.filter((e) => e.type === "done");
  assert.ok(dones.length <= 1, `done 事件至多一个，实际 ${dones.length}`);
}

// ═════════════════════════════════════════════════════════════════════════════════════

test("live baseline: 真实问数全链路 http→pool→runner→dsh→DeepSeek→DWS", { timeout: 20 * 60_000 }, async (t: TestContext) => {
  const reason = skipReason("baseline");
  if (reason) return t.skip(reason);
  requireLiveEnv();
  const shot = makeShot("baseline");
  const gw = await startGateway(shot);
  const t0 = Date.now();
  try {
    const runId = await postTask(gw, Q_SIMPLE, `baseline-${Date.now()}`);
    const { events } = await sseCollect(gw.port, runId);
    assertEventStream(events);

    const fin = await apiGet(gw.port, `/api/tasks/${runId}`);
    assert.equal(fin.body.status, "succeeded", `终态 succeeded，实际: ${JSON.stringify(fin.body)}`);

    const done = events.find((e) => e.type === "done")!;
    assert.equal(done.payload.status, "succeeded");
    assert.equal(done.payload.engine, "dsh");
    const types: Record<string, number> = {};
    for (const e of events) types[e.type] = (types[e.type] ?? 0) + 1;
    assert.ok(types.stage >= 1, "应有 stage 事件（claim/analyzing/querying）");
    assert.ok(types.sql >= 1, "应有 sql 事件（真 DWS 查询）");
    assert.ok(types.answer === 1, "应有且仅有一个 answer 事件");

    const result = {
      run_id: runId,
      wall_ms: Date.now() - t0,
      done_elapsed_ms: done.payload.elapsed_ms,
      event_count: events.length,
      type_counts: types,
      tokens: done.payload.tokens, // M1 编排层未实现 token 统计（词表字段保留，恒 null）
      sql_events: events.filter((e) => e.type === "sql").map((e) => ({ rows: e.payload.rows, result_ref: e.payload.result_ref })),
      answer_head: String(events.find((e) => e.type === "answer")?.payload.markdown ?? "").slice(0, 200),
    };
    shot.evidence(result);
    shot.log(`baseline PASS: ${JSON.stringify({ ...result, answer_head: undefined, sql_events: undefined })}`);
    console.log(`[baseline] wall=${(result.wall_ms / 1000).toFixed(1)}s events=${result.event_count} types=${JSON.stringify(types)}`);
  } finally {
    gw.kill();
    killAllEngineProcs(shot);
  }
});

// ── shot1：提交响应丢失重试 → 幂等（A.3 提交层）─────────────────────────────────────

test("shot1: 提交响应丢失重试同 client_submission_id → 同 run_id 无第二行", { timeout: 20 * 60_000 }, async (t: TestContext) => {
  const reason = skipReason("shot1");
  if (reason) return t.skip(reason);
  requireLiveEnv();
  const shot = makeShot("shot1-submission-retry");
  const gw = await startGateway(shot);
  const t0 = Date.now();
  try {
    const csid = `shot1-${Date.now()}`;
    // 第一发：请求发出但不读响应（150ms 后 destroy 连接）
    await apiPost(gw.port, "/api/tasks", { question: Q_SIMPLE, client_submission_id: csid }, { abandonResponse: true });
    await sleep(500); // 给服务端处理窗口（请求体已到达）
    // 第二发：同幂等键重发，正常读响应
    const runId = await postTask(gw, Q_SIMPLE, csid);

    const db = openDb(gw.dbPath);
    try {
      const n = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE client_submission_id=?").get(csid).n as number;
      assert.equal(n, 1, `store 无第二行（实际 ${n} 行 client_submission_id=${csid}）`);

      const { events } = await sseCollect(gw.port, runId);
      assertEventStream(events);
      const fin = await apiGet(gw.port, `/api/tasks/${runId}`);
      assert.equal(fin.body.status, "succeeded", `任务正常走完，实际: ${JSON.stringify(fin.body)}`);
      assert.equal(fin.body.run_id, runId);

      const result = {
        run_id: runId,
        client_submission_id: csid,
        task_rows: n,
        wall_ms: Date.now() - t0,
        event_count: events.length,
        final_status: fin.body.status,
        verdict: "PASS: 响应丢失后重发同幂等键 → 同 run_id、单行、任务正常完成（用户视角：无需重问，无重复任务）",
      };
      shot.evidence(result);
      console.log(`[shot1] PASS rows=1 run_id=${runId} wall=${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } finally {
      db.close();
    }
  } finally {
    gw.kill();
    killAllEngineProcs(shot);
  }
});

// ── shot2：网关进程死亡 → 孤儿观察 → 重启接管（A.1 boot 自愈 + A.4 行2）──────────────

test("shot2: 网关进程死亡 taskkill → dsh树EOF退出观察 → 重启同DB接管 → 新attempt终态", { timeout: 30 * 60_000 }, async (t: TestContext) => {
  const reason = skipReason("shot2");
  if (reason) return t.skip(reason);
  requireLiveEnv();
  const shot = makeShot("shot2-process-death");
  const gw1 = await startGateway(shot);
  const db = openDb(gw1.dbPath);
  let observations: Record<string, unknown> = {};
  try {
    const runId = await postTask(gw1, Q_MULTI, `shot2-${Date.now()}`);

    // 等 running 且真实 dsh 已开工（≥3 事件：claim + 至少2个引擎事件）
    await waitFor(
      () => getTask(db, runId).status === "running" && (db.prepare("SELECT COUNT(*) AS n FROM events WHERE run_id=?").get(runId).n as number) >= 3,
      8 * 60_000,
      "任务 running 且事件≥3",
    );
    await waitFor(() => listEngineProcs().length >= 1, 60_000, "dsh 进程出现");
    const beforeKill = listEngineProcs();
    shot.log(`kill 前 dsh 进程: ${JSON.stringify(beforeKill.map((p) => ({ pid: p.pid, cmd: p.cmd.slice(0, 100) })))}`);

    // 注入：仅杀网关 node 进程（taskkill /F 不带 /T）
    gw1.kill(true);
    assert.ok(!pidAlive(gw1.proc.pid), "网关进程应已死");

    // 孤儿观察（附录 A.1 副作用取证）：dsh 是 stdio JSON-RPC 服务——网关死亡即其
    // stdin 管道写端关闭 → EOF → 引擎进程树自行退出（transport 随宿主死亡），
    // 实测 1.5s 内清零——无孤儿进程泄漏，接管期间无双 dsh 副作用窗口。
    const tKill = Date.now();
    await waitFor(() => listEngineProcs().length === 0 && listMcpProcs().length === 0, 20_000, "dsh 树随 stdin EOF 自行退出", 500);
    const eofExitMs = Date.now() - tKill;
    const orphans = listEngineProcs();
    const orphanMcp = listMcpProcs();
    const containers = dockerPs();
    assert.equal(orphans.length, 0, "不应残留孤儿 dsh 进程（stdio EOF 退出）");
    observations = {
      killed_gateway_pid: gw1.proc.pid,
      dsh_tree_at_kill: beforeKill.map((p) => ({ pid: p.pid, cmd: p.cmd.slice(0, 120) })),
      engine_procs_after_kill: orphans.length,
      mcp_procs_after_kill: orphanMcp.length,
      eof_exit_ms: eofExitMs,
      docker_containers: containers,
      container_note: "exec_script 容器为调用期瞬态（--rm + rm -f 兜底），观察窗口内可能为空；M1 网关未注入 SANDBOX_RUN_ID，容器名为缺省 m0sandbox-*（附录 A.1 的 run_id-a<attempt> 命名属插件已支持、网关未接线，见遗留 L-1）",
    };
    shot.log(`孤儿观察（EOF 退出 ${eofExitMs}ms）: ${JSON.stringify(observations)}`);

    // 重启网关（同 DB/同工作树）→ boot 自愈 → 接管
    const tRestart = Date.now();
    const gw2 = await startGateway(shot);
    try {
      const { events } = await sseCollect(gw2.port, runId);
      assertEventStream(events);
      const fin = getTask(db, runId);
      const finalTask = await apiGet(gw2.port, `/api/tasks/${runId}`);
      assert.ok(
        fin.status === "succeeded" || fin.status === "failed",
        `任务应到终态（无丢失/无死锁），实际: ${fin.status}`,
      );
      assert.ok(fin.attempt >= 2, `应有新 attempt 接管（实际 attempt=${fin.attempt}）`);
      const pubs = db.prepare("SELECT COUNT(*) AS n FROM publications WHERE run_id=?").get(runId).n as number;
      assert.ok(pubs <= 1, `publications 至多一条（实际 ${pubs}）`);

      const healed = (db.prepare("SELECT COUNT(*) AS n FROM events WHERE run_id=? AND type='stage' AND payload LIKE '%\"attempt\":2%'").get(runId).n as number) >= 1;
      const result = {
        ...observations,
        run_id: runId,
        final_status: fin.status,
        final_attempt: fin.attempt,
        error_code: fin.error_code,
        publications: pubs,
        restart_to_terminal_ms: Date.now() - tRestart,
        event_count_total: events.length,
        heal_claim_attempt2_event: healed,
        wall_note: "重启后 healOrphans 回队 → claim attempt+1 → repairing+历史注入 → 新 dsh 完成任务",
        verdict: fin.status === "succeeded"
          ? "PASS: 进程死亡后重启即自动接管跑完，用户视角无需重问、无感恢复"
          : "PASS(按预算失败): 任务未丢失未死锁，终态 failed 由预算/上限收口（用户视角得到明确失败而非悬挂）",
      };
      shot.evidence(result);
      console.log(`[shot2] ${result.verdict} attempt=${fin.attempt} status=${fin.status} restart→terminal=${(result.restart_to_terminal_ms as number) / 1000}s`);
    } finally {
      gw2.kill();
    }

    // 清理孤儿 dsh 进程树并记录
    killAllEngineProcs(shot);
    shot.log("cleanup: 孤儿 dsh/MCP 进程树已 taskkill /T /F 并核验为 0");
  } finally {
    db.close();
    gw1.kill();
    try { killAllEngineProcs(shot); } catch { /* 已清 */ }
  }
});

// ── shot3：发布后中断 → 恢复直接 succeeded 不重跑不重发（A.4 行4）────────────────────

test("shot3: 报告已发布但任务未终态 → 重启后查publications直接succeeded", { timeout: 40 * 60_000 }, async (t: TestContext) => {
  const reason = skipReason("shot3");
  if (reason) return t.skip(reason);
  requireLiveEnv();
  const shot = makeShot("shot3-publish-crash");
  const gw1 = await startGateway(shot, { taskBudgetS: 2700 });
  const db = openDb(gw1.dbPath);
  try {
    // 1. 跑一个报告类问题到 succeeded（真实 publications 行）
    const runId = await postTask(gw1, Q_REPORT, `shot3-${Date.now()}`);
    const t0 = Date.now();
    await sseCollect(gw1.port, runId);
    let task = getTask(db, runId);
    assert.equal(task.status, "succeeded", `报告任务应成功，实际 ${task.status} / ${task.error_code} ${task.error_message}`);
    const pub = db.prepare("SELECT report_path, published_at FROM publications WHERE run_id=?").get(runId) as any;
    assert.ok(pub, "应有 publications 行");
    const stat1 = statSync(pub.report_path);
    shot.log(`报告完成: ${pub.report_path} (${stat1.size}B, ${(Date.now() - t0) / 1000}s)`);

    // 2. DB 直改构造崩溃窗口：publications 已写、status 回 running、终态与 report/done 事件清掉
    //    （黑盒注入——模拟进程死在 recordPublication 与 finalize 之间）
    db.prepare(
      `UPDATE tasks SET status='running', lease_owner='sim-crashed-post-publish', lease_expires_at=?,
                          error_code=NULL, error_message=NULL WHERE run_id=?`,
    ).run(Date.now() + 60_000, runId);
    db.prepare("DELETE FROM events WHERE run_id=? AND type IN ('report','done')").run(runId);
    // 边界取删除后的 MAX(seq)（删除后恢复路径会复用被删 seq 段——COUNT 作边界会漏检）
    const maxSeqAfterSurgery = db.prepare("SELECT MAX(seq) AS m FROM events WHERE run_id=?").get(runId).m as number;
    shot.log(`注入完成: status→running(假租约), report/done 事件已删(边界 seq=${maxSeqAfterSurgery}), publications 保留`);

    // 3. 重启网关 → 恢复路径
    const tRestart = Date.now();
    const gw2 = await startGateway(shot);
    try {
      await waitFor(() => getTask(db, runId).status === "succeeded", 90_000, "恢复直接 succeeded（不重跑）");
      const recoverMs = Date.now() - tRestart;

      task = getTask(db, runId);
      assert.equal(task.status, "succeeded");
      const pub2 = db.prepare("SELECT report_path, published_at FROM publications WHERE run_id=?").get(runId) as any;
      assert.equal(pub2.published_at, pub.published_at, "publications 未重写（published_at 不变）");
      const stat2 = statSync(pub2.report_path);
      assert.equal(stat2.size, stat1.size, "报告文件未被第二副本覆盖（size 不变）");
      assert.equal(stat2.mtimeMs, stat1.mtimeMs, "报告文件 mtime 不变（未重发）");
      const eventsAfter = maxSeqAfterSurgery;
      const newEvents = db.prepare("SELECT seq,type,payload FROM events WHERE run_id=? AND seq>? ORDER BY seq").all(runId, eventsAfter) as any[];
      const newTypes = newEvents.map((e) => e.type);
      assert.deepEqual(newTypes, ["stage", "done"], `恢复只应新增 claim stage + done，实际: ${JSON.stringify(newEvents.map((e) => [e.seq, e.type]))}`);
      const donePayload = JSON.parse(newEvents.find((e) => e.type === "done")!.payload);
      assert.equal(donePayload.status, "succeeded");
      assert.equal(donePayload.recovered, true, "done.recovered 应为 true（恢复路径）");

      // 全流 SSE 复核
      const { events } = await sseCollect(gw2.port, runId);
      assertEventStream(events);

      const result = {
        run_id: runId,
        report_path: pub.report_path,
        report_bytes: stat1.size,
        first_run_ms: Date.now() - t0 - recoverMs,
        recover_ms: recoverMs,
        new_event_types: newTypes,
        done_recovered: donePayload.recovered,
        publications_unchanged: pub2.published_at === pub.published_at,
        report_file_unchanged: stat2.size === stat1.size && stat2.mtimeMs === stat1.mtimeMs,
        verdict: "PASS: 发布后崩溃由 publications 兜底直接终态——不重跑引擎、不重发报告；用户视角报告已在、刷新即见 succeeded",
      };
      shot.evidence(result);
      console.log(`[shot3] PASS recover=${(recoverMs / 1000).toFixed(1)}s publications_unchanged=true`);
    } finally {
      gw2.kill();
    }
  } finally {
    db.close();
    gw1.kill();
    try { killAllEngineProcs(shot); } catch { /* 已清 */ }
  }
});

// ── shot4：SSE 断线重连（Last-Event-ID）→ 不重不漏（D15）────────────────────────────

test("shot4: SSE中途断开→Last-Event-ID重连→补发连续无重复", { timeout: 20 * 60_000 }, async (t: TestContext) => {
  const reason = skipReason("shot4");
  if (reason) return t.skip(reason);
  requireLiveEnv();
  const shot = makeShot("shot4-sse-reconnect");
  const gw = await startGateway(shot);
  try {
    const runId = await postTask(gw, Q_SIMPLE, `shot4-${Date.now()}`);

    // 第一段连接：收若干事件后 abrupt 断开
    const c1Events: SseEvent[] = [];
    let destroyed = false;
    const c1 = sseOpen(gw.port, runId, (ev) => {
      c1Events.push(ev);
      if (!destroyed && c1Events.length >= 3) {
        destroyed = true;
        c1.destroy(); // 中途断开（socket 直接弃）
      }
    });
    const c1Result = await c1.done;
    assert.ok(!c1Result.endedByServer, "第一段应由客户端断开（非服务端关流）");
    const lastSeq = c1Events[c1Events.length - 1]!.seq;
    shot.log(`断开于 seq=${lastSeq}（已收 ${c1Events.length} 事件）`);
    await sleep(600); // 服务端感知断连

    // 第二段连接：Last-Event-ID 续传
    const c2 = await sseCollect(gw.port, runId, { lastEventId: lastSeq });
    assert.ok(c2.endedByServer, "第二段应由服务端在 done 后关流");
    assert.equal(c2.events[0]!.seq, lastSeq + 1, `重连首帧应补发 ${lastSeq + 1}，实际 ${c2.events[0]!.seq}`);

    const combined = [...c1Events, ...c2.events];
    assertEventStream(combined); // 含 seq 连续无重复 + 词表 + done 唯一
    const fin = await apiGet(gw.port, `/api/tasks/${runId}`);
    assert.equal(fin.body.status, "succeeded", `任务成功，实际: ${JSON.stringify(fin.body)}`);

    const result = {
      run_id: runId,
      disconnect_at_seq: lastSeq,
      c1_events: c1Events.length,
      c2_events: c2.events.length,
      total_events: combined.length,
      final_status: fin.body.status,
      verdict: "PASS: 断线重连补发严格续接（首帧=断点+1），全程无丢失无重复；用户视角进度条无缝续播",
    };
    shot.evidence(result);
    console.log(`[shot4] PASS break@${lastSeq} c1=${c1Events.length} c2=${c2.events.length}`);
  } finally {
    gw.kill();
    killAllEngineProcs(shot);
  }
});

// ── shot5：双活窗口（附录 A.1 构造性验证）───────────────────────────────────────────
// A=网关真 TaskRunner 驱动真 dsh；DB 直改 lease_expires_at 为过去（模拟 A 心跳停滞）；
// B=第二个 WorkerPool 实例（独立进程，无 boot heal——走 claimLease 的 LEASE_FREE 接管臂，
//   驱动真 TaskRunner+真 dsh）；断言 A 下一次写被围栏 → kill 自身 dsh 树静默退出；
//   最终唯一产物：事件 seq 连续、done 唯一、publications/report 无第二副本。

test("shot5: 双活窗口 A心跳停滞→B接管→A被围栏kill自身树→唯一产物", { timeout: 40 * 60_000 }, async (t: TestContext) => {
  const reason = skipReason("shot5");
  if (reason) return t.skip(reason);
  requireLiveEnv();
  const shot = makeShot("shot5-dual-active");
  const gwA = await startGateway(shot);
  const db = openDb(gwA.dbPath);
  let helper: ChildProcess | undefined;
  try {
    const runId = await postTask(gwA, Q_TREND, `shot5-${Date.now()}`);

    // A 起跑：running + 真实 dsh 开工
    await waitFor(
      () => getTask(db, runId).status === "running" && (db.prepare("SELECT COUNT(*) AS n FROM events WHERE run_id=?").get(runId).n as number) >= 3,
      8 * 60_000,
      "A 任务 running 且事件≥3",
    );
    await waitFor(() => listEngineProcs().length >= 1, 60_000, "A 的 dsh 进程出现");
    const aProcs = listEngineProcs();
    shot.log(`A 的 dsh 树: ${JSON.stringify(aProcs.map((p) => p.pid))}`);

    // 注入：A 心跳停滞（租约置为过去）
    const leaseEdit = () =>
      db.prepare("UPDATE tasks SET lease_expires_at=? WHERE run_id=? AND status='running'").run(Date.now() - 1000, runId);
    leaseEdit();

    // B = 第二个 WorkerPool 实例（独立进程、无 boot heal，驱动真 TaskRunner+真 dsh）
    const helperLog = join(shot.dir, "poolB.log");
    helper = spawn(
      process.execPath,
      [join("test", "helpers", "second-pool.mts"), shot.dbPath, runId, shot.workroot, shot.resultsRoot,
       join(REPO_ROOT_DIR, "skills", "report-generator"), join(REPO_ROOT_DIR, "m0", "sandbox", "run_in_sandbox.sh"),
       join(REPO_ROOT_DIR, "skills"), shot.reportsDir],
      { cwd: GW_DIR, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    helper.stdout?.on("data", (d: Buffer) => shot.log(`[poolB] ${d.toString().trim()}`));
    helper.stderr?.on("data", (d: Buffer) => shot.log(`[poolB-err] ${d.toString().trim()}`));

    // 等 B 接管（attempt=2）；若 A 心跳在窗口内抢先续租则重置注入（最多 5 次）
    let claimed = false;
    for (let i = 0; i < 5 && !claimed; i++) {
      try {
        await waitFor(() => getTask(db, runId).attempt >= 2, 20_000, "B claim attempt=2", 500);
        claimed = true;
      } catch {
        shot.log(`第${i + 1}次注入窗口被 A 心跳抢先续租——重置注入重试`);
        leaseEdit();
      }
    }
    assert.ok(claimed, "B 应在重试预算内接管（attempt≥2）");
    shot.log(`B 已接管 attempt=${getTask(db, runId).attempt} —— 双活窗口开启（A 活着 + B 在跑）`);

    // 断言 A 被围栏：A 的 dsh 进程树被 kill（session.cancel 被调的外部证据）
    await waitFor(
      () => aProcs.every((p) => !pidAlive(p.pid)),
      6 * 60_000,
      "A 的 dsh 进程树死亡（围栏→cancel 自身树）",
      2000,
    );
    shot.log("A 的 dsh 树已死——围栏生效，A 静默退出（不 finalize）");

    // 等终态（B 跑完）
    await waitFor(() => ["succeeded", "failed", "cancelled"].includes(getTask(db, runId).status), 20 * 60_000, "B 终态");
    const fin = getTask(db, runId);
    assert.equal(fin.status, "succeeded", `B 应跑完成功，实际 ${fin.status} / ${fin.error_code}`);
    assert.equal(fin.attempt, 2, `终态 attempt 应为 2（B），实际 ${fin.attempt}`);

    // 唯一产物断言
    const { events } = await sseCollect(gwA.port, runId);
    assertEventStream(events);
    const dones = events.filter((e) => e.type === "done");
    assert.equal(dones.length, 1, "done 事件唯一（A 不写 done 不 finalize）");
    const answers = events.filter((e) => e.type === "answer");
    assert.ok(answers.length >= 1 && answers.length <= 2, `answer 事件 1~2 个（A 围栏前可能已有部分产出），实际 ${answers.length}`);
    const pubs = db.prepare("SELECT COUNT(*) AS n FROM publications WHERE run_id=?").get(runId).n as number;
    assert.equal(pubs, 0, "纯问答无发布（Q&A）；报告类由 shot2/shot3 断言 ≤1");
    const reportsDirUser = join(shot.reportsDir, USER);
    let reportCopies = 0;
    try {
      reportCopies = readdirSync(reportsDirUser).length;
    } catch { /* 目录不存在 = 0 */ }
    assert.equal(reportCopies, 0, "reports/ 无第二副本");

    // B 的 dsh 树是唯一幸存引擎进程（收尾由 B cancel 回收；此处兜底清理）
    const result = {
      run_id: runId,
      final_status: fin.status,
      final_attempt: fin.attempt,
      a_dsh_pids: aProcs.map((p) => p.pid),
      a_dsh_dead: aProcs.every((p) => !pidAlive(p.pid)),
      done_count: dones.length,
      answer_count: answers.length,
      publications: pubs,
      report_copies: reportCopies,
      event_count: events.length,
      verdict: "PASS: 双活窗口内 A 下一次写被围栏→kill 自身 dsh 树静默退出（不 finalize 不写 done）；唯一产物=单 done、seq 连续、publications 无第二行；用户视角只有一个答案",
    };
    shot.evidence(result);
    console.log(`[shot5] PASS attempt=${fin.attempt} done=${dones.length} A_dsh_dead=true`);
  } finally {
    db.close();
    helper?.kill();
    if (helper?.pid) taskkill(helper.pid, true);
    gwA.kill();
    try { killAllEngineProcs(shot); } catch { /* 已清 */ }
  }
});
