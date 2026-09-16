// M1-T8：网关组装入口（T9 live E2E 的启动命令 = node src/server/index.ts）。
//
// env 清单（spec §5 配置节 + 任务书）：
//   GATEWAY_PORT           监听端口（默认 8080）
//   AUTH_TOKEN             Bearer token（必填，缺省拒绝启动——空 token 等于不设防）
//   MAX_CONCURRENT_TASKS   池并行上限（默认 3，spec D7 压测起点）
//   MAX_QUEUE              全局排队上限（默认 100）
//   RATE_LIMIT_QPM         按 user 每分钟提交上限（默认 30）
//   GW_WORKROOT            dsh workdir 树根（必填；附录 A：Temp 树外）
//   GW_RESULTS_ROOT        查询结果树根（默认 <GW_WORKROOT>/results，RESULT_DIR 同指）
//   GW_ASSETS_DIR          报告模板/静态资源目录（必填）
//   M0_SANDBOX_RUNNER      沙箱 runner 脚本路径（必填，注入 M0_SANDBOX_RUNNER）
//   SKILLS_DIR             Skills 根目录（必填）
//   GATEWAY_REPORTS_DIR    发布树根 <GATEWAY_REPORTS_DIR>/<user>/<run_id>.html（必填）
//   GW_DB_PATH             SQLite 路径（默认 ./gateway.db）
//   TASK_BUDGET_S          跨 attempt 总预算（默认 1800）
//   MAX_REPAIR_ROUNDS      基础设施故障 attempt 上限（默认 3）
import Database from "better-sqlite3";
import { resolve } from "node:path";
import { TaskStore } from "../store/task-store.ts";
import { TaskRunner } from "../orchestrator/task-runner.ts";
import { DshBackend } from "../backends/dsh-backend.ts";
import { WorkerPool } from "./worker-pool.ts";
import { createHttpServer } from "./http.ts";
import { randomUUID } from "node:crypto";

function envInt(name: string, dflt: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return dflt;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`[CONFIG] ${name} 必须为正整数，得到: ${v}`);
  return n;
}

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`[CONFIG] 缺少必填环境变量 ${name}`);
  return v;
}

// ── 建库 + WAL（T4 审查 Minor-3：WAL 断言——读回 journal_mode 必须 'wal'）──────────
const dbPath = process.env.GW_DB_PATH || "./gateway.db";
const db = new Database(resolve(dbPath));
db.pragma("journal_mode = WAL");
const journalMode = db.pragma("journal_mode", { simple: true });
if (journalMode !== "wal") {
  db.close();
  throw new Error(`[CONFIG] WAL 未生效（journal_mode=${journalMode}）——网络盘/旧文件系统会导致并发写丢更新，拒绝启动`);
}
const store = new TaskStore(db);

// ── 执行层组装：DshBackend → TaskRunner 工厂（池的注入点）──────────────────────────
const backend = new DshBackend();
const runnerPaths = {
  workroot: requiredEnv("GW_WORKROOT"),
  resultsRoot: process.env.GW_RESULTS_ROOT || resolve(requiredEnv("GW_WORKROOT"), "results"),
  assetsDir: requiredEnv("GW_ASSETS_DIR"),
  runnerPath: requiredEnv("M0_SANDBOX_RUNNER"),
  skillsDir: requiredEnv("SKILLS_DIR"),
  reportsRoot: requiredEnv("GATEWAY_REPORTS_DIR"),
};
const taskBudgetS = envInt("TASK_BUDGET_S", 1800);
const maxAttempts = envInt("MAX_REPAIR_ROUNDS", 3);
const runnerFactory = (runId: string): Promise<void> =>
  new TaskRunner(store, backend, {
    // 单服务部署：workerId 唯一即可，per-run 随机段防跨启动复用（A.1 围栏语义只要求
    // 同一时刻不同执行者 id 不同）
    workerId: `gw-${process.pid}-${randomUUID().slice(0, 8)}`,
    taskBudgetS,
    maxAttempts,
    paths: runnerPaths,
  }).runOnce(runId);

// ── 池 + HTTP ─────────────────────────────────────────────────────────────────────
const pool = new WorkerPool({
  store,
  runner: runnerFactory,
  config: {
    maxConcurrent: envInt("MAX_CONCURRENT_TASKS", 3),
    pollIntervalMs: 500,
    reapIntervalMs: 30_000,
    maxAttempts,
  },
});

const server = createHttpServer({
  store,
  pool,
  config: {
    authToken: requiredEnv("AUTH_TOKEN"),
    maxQueue: envInt("MAX_QUEUE", 100),
    rateLimitQpm: envInt("RATE_LIMIT_QPM", 30),
  },
});

pool.start();
server.listen(envInt("GATEWAY_PORT", 8080), () => {
  console.log(`[gateway] listening on :${envInt("GATEWAY_PORT", 8080)} db=${dbPath} workroot=${runnerPaths.workroot}`);
});

// ── 优雅停：停入流 → 停池（等在途 runner）→ 停 HTTP → 关库 ─────────────────────────
async function shutdown(sig: string): Promise<void> {
  console.log(`[gateway] ${sig} — graceful shutdown`);
  await pool.stop();
  server.close();
  server.closeAllConnections?.(); // SSE 长连接会挂住 close()——终态之外的流直接断开，客户端按 seq 重连
  db.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
