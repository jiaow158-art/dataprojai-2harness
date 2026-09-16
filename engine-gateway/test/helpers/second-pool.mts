// M1-T9 shot5 专用：第二个 WorkerPool 实例（B 侧）——独立进程、无 boot heal。
//
// 与网关 A 并存于双活窗口：直接驱动产品路径 TaskRunner.runOnce（其循环顶
// claimLease 走 LEASE_FREE 接管臂——status='running' 且租约过期/无主时放行，
// attempt+1）。不调 WorkerPool.start()/healOrphans——那是单服务部署 boot 语义，
// 会无条件回队 running 行，遮蔽本发要验证的"租约过期被接管"路径。
// 500ms 轮询复刻 WorkerPool.dispatchTick 的派发节奏；claim 失败（别人持有新租约）
// runOnce 静默返回，下轮重试——与池语义一致。
//
// 用法：node test/helpers/second-pool.mts <dbPath> <runId> <workroot> <resultsRoot>
//                                       <assetsDir> <runnerPath> <skillsDir> <reportsRoot>
// env：须含 DWS_PASSWORD(或 DWS_RUN_PASSWORD)/DEEPSEEK_API_KEY 及 M1 网关同款环境。
// 退出码：0=任务终态；2=参数错误；3=25min 预算耗尽未终态。
import Database from "better-sqlite3";
import { TaskStore } from "../../src/store/task-store.ts";
import { TaskRunner } from "../../src/orchestrator/task-runner.ts";
import { DshBackend } from "../../src/backends/dsh-backend.ts";

const args = process.argv.slice(2);
if (args.length < 8) {
  console.error("usage: second-pool.mts <dbPath> <runId> <workroot> <resultsRoot> <assetsDir> <runnerPath> <skillsDir> <reportsRoot>");
  process.exit(2);
}
const [dbPath, runId, workroot, resultsRoot, assetsDir, runnerPath, skillsDir, reportsRoot] = args;

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
const store = new TaskStore(db);
const backend = new DshBackend();
const workerId = `poolB-${process.pid}-${Date.now() % 100000}`;
const runner = new TaskRunner(store, backend, {
  workerId,
  taskBudgetS: 1800,
  maxAttempts: 3,
  heartbeatIntervalMs: 15_000,
  leaseTtlMs: 90_000,
  paths: { workroot, resultsRoot, assetsDir, runnerPath, skillsDir, reportsRoot },
});

const t0 = Date.now();
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
let busy = false;
console.log(`[poolB] up pid=${process.pid} workerId=${workerId} runId=${runId}`);

const timer = setInterval(() => {
  if (busy) return;
  const t = store.getTask(runId);
  if (!t) {
    console.error("[poolB] task row missing");
    process.exit(2);
  }
  if (TERMINAL.has(t.status)) {
    console.log(`[poolB] terminal status=${t.status} attempt=${t.attempt} elapsed_ms=${Date.now() - t0}`);
    process.exit(0);
  }
  if (Date.now() - t0 > 25 * 60_000) {
    console.error("[poolB] 25min budget exceeded without terminal");
    process.exit(3);
  }
  const claimable =
    t.status === "queued" ||
    (t.status === "running" && (!t.lease_owner || !t.lease_expires_at || t.lease_expires_at < Date.now()));
  if (!claimable) return;
  busy = true;
  const expiresIn = t.lease_expires_at != null ? t.lease_expires_at - Date.now() : null;
  console.log(`[poolB] runOnce(claim) status=${t.status} owner=${t.lease_owner} lease_expires_in_ms=${expiresIn}`);
  runner
    .runOnce(runId)
    .then(() => {
      busy = false;
    })
    .catch((e) => {
      console.error("[poolB] runOnce threw:", e);
      busy = false;
    });
}, 500);
// 主 interval 不 unref：进程借它持活，terminal/预算出口 process.exit
