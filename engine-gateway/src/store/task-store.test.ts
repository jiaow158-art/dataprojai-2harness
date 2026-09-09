// M1-T4 单测：附录 A 四大不变量的物理载体。
// 全部用真实 SQLite 内存库（better-sqlite3 同步单连接）+ 两个逻辑 worker
// 在同进程内按确定顺序调用，使"双活窗口"竞争可确定性构造。
// beforeEach 建库 / afterEach 销库。
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { TaskStore } from "./task-store.ts";

let db: Database.Database;
let store: TaskStore;

beforeEach(() => {
  db = new Database(":memory:");
  store = new TaskStore(db);
});

afterEach(() => {
  db.close();
});

function createIn(sessionId: string, submission?: string, question = "测试问题") {
  return store.createTask({
    session_id: sessionId,
    user: "tester",
    question,
    ...(submission ? { client_submission_id: submission } : {}),
  });
}

// 模拟租约停滞：直接把 lease_expires_at 拨到过去
function expireLease(runId: string) {
  db.prepare("UPDATE tasks SET lease_expires_at=? WHERE run_id=?").run(Date.now() - 1, runId);
}

test("幂等创建：同 client_submission_id 二次 createTask 返回同 run_id 且 created=false", () => {
  const a = createIn("s1", "sub-1");
  assert.equal(a.created, true);
  assert.match(a.run_id, /^run-/);
  // 并发感模拟：同一幂等键直接调两次
  const b = createIn("s1", "sub-1");
  assert.equal(b.created, false);
  assert.equal(b.run_id, a.run_id);
  // 不同幂等键正常新建
  const c = createIn("s1", "sub-2");
  assert.equal(c.created, true);
  assert.notEqual(c.run_id, a.run_id);
  // 幂等键可空：NULL 互不冲突（SQLite UNIQUE 对 NULL 视为互异）
  assert.notEqual(createIn("s1").run_id, createIn("s1").run_id);
  // 默认 scope_group 与查询接口
  assert.equal(store.getTask(a.run_id)?.scope_group, "default");
  assert.equal(store.getTaskBySubmission("sub-1")?.run_id, a.run_id);
  assert.equal(store.getTaskBySubmission("nope"), undefined);
});

test("事件 seq 递增与 afterSeq 重放（claim 内部事件占 seq=1）", () => {
  const { run_id } = createIn("s1");
  const lease = store.claimLease(run_id, "w1", 90_000, 3600);
  assert.ok(lease, "claim 应成功");
  for (let i = 1; i <= 5; i++) {
    const r = store.appendEvent(lease, "progress", { i });
    assert.deepEqual(r, { fenced: false, seq: i + 1 }); // A.3：同步事务内 MAX(seq)+1
  }
  const all = store.listEvents(run_id, 0);
  assert.deepEqual(all.map((e) => e.seq), [1, 2, 3, 4, 5, 6]);
  assert.equal(all[0].type, "stage"); // A.1 获权时同步写入的内部事件（spec §5 词表）
  const replay = store.listEvents(run_id, 2);
  assert.deepEqual(replay.map((e) => e.seq), [3, 4, 5, 6]); // 连续无缺口
  assert.deepEqual(replay[0].payload, { i: 2 }); // payload JSON 往返
  assert.equal(typeof replay[0].created_at, "number");
});

test("双 worker 竞争 claimLease 只一胜", () => {
  const { run_id } = createIn("s1");
  const a = store.claimLease(run_id, "workerA", 90_000, 3600);
  assert.ok(a);
  assert.equal(a.attempt, 1);
  const b = store.claimLease(run_id, "workerB", 90_000, 3600);
  assert.equal(b, false); // status=running 且租约未过期
  const row = store.getTask(run_id)!;
  assert.equal(row.status, "running");
  assert.equal(row.lease_owner, "workerA");
  assert.equal(row.attempt, 1);
});

test("围栏写：B 接管后 A 的 heartbeat/updateStage/appendEvent/finalize 全被拒且无副作用", () => {
  const { run_id } = createIn("s1");
  const a = store.claimLease(run_id, "workerA", 90_000, 3600);
  assert.ok(a);
  assert.deepEqual(store.updateStage(a, "analyzing"), { fenced: false });
  assert.deepEqual(store.appendEvent(a, "progress", { from: "A" }), { fenced: false, seq: 2 });

  // 模拟 A 停滞：租约过期 → B 接管（attempt=2）
  expireLease(run_id);
  const b = store.claimLease(run_id, "workerB", 90_000, 3600);
  assert.ok(b);
  assert.equal(b.attempt, 2);
  assert.deepEqual(store.updateStage(b, "querying"), { fenced: false });

  // A 的全部状态写被围栏（A.1 L1：rowcount=0 即失权信号）
  assert.deepEqual(store.heartbeat(a, 90_000), { fenced: true });
  assert.deepEqual(store.updateStage(a, "repairing"), { fenced: true });
  assert.deepEqual(store.appendEvent(a, "progress", { from: "A-late" }), { fenced: true });
  assert.deepEqual(store.finalize(a, "failed", "X", "stale worker"), { fenced: true });

  // 无副作用：stage 仍是 B 写的值、事件数不变、租约仍在 B、未终态
  const row = store.getTask(run_id)!;
  assert.equal(row.stage, "querying");
  assert.equal(row.lease_owner, "workerB");
  assert.equal(row.status, "running");
  // seq1=A claim 的 stage，seq2=A 的 progress，seq3=B claim 的 stage
  assert.equal(store.listEvents(run_id, 0).length, 3);
});

test("publication 幂等：二次记录被拒且返回既有路径", () => {
  const { run_id } = createIn("s1");
  const first = store.recordPublication(run_id, "reports/u/a.html");
  assert.deepEqual(first, { published: true, report_path: "reports/u/a.html" });
  const second = store.recordPublication(run_id, "reports/u/b.html");
  assert.deepEqual(second, { published: false, report_path: "reports/u/a.html" });
});

test("同会话串行：前一任务未到终态时后一任务不进 listRunnable（A.2 S1）", () => {
  const t1 = createIn("s1", "sub-1", "第一问");
  const t2 = createIn("s1", "sub-2", "第二问");
  const t9 = createIn("s9", "sub-9", "别会话"); // 跨会话对照

  // 两个 queued 同会话：只队首可见（S1 严格化：前一任务未终态，后一不可行进）
  assert.deepEqual(store.listRunnable(10).map((r) => r.run_id), [t1.run_id, t9.run_id]);

  const lease = store.claimLease(t1.run_id, "w1", 90_000, 3600);
  assert.ok(lease);
  // t1 running：s1 全队列不可见，s9 不受影响
  assert.deepEqual(store.listRunnable(10).map((r) => r.run_id), [t9.run_id]);

  store.finalize(lease, "succeeded");
  // t1 终态：t2 可见（reap 回队路径同理——回 queued 即重新可被过滤选中）
  assert.deepEqual(store.listRunnable(10).map((r) => r.run_id), [t2.run_id, t9.run_id]);
});

test("Reaper 三分支：cancel→cancelled / attempt 达上限→failed/UNRECOVERABLE / 其余回 queued", () => {
  const maxAttempts = 3;
  // ① 租约过期 + cancel_requested → cancelled
  const c = createIn("sc", "c");
  store.claimLease(c.run_id, "w", 90_000, 3600);
  assert.equal(store.requestCancel(c.run_id), true);
  expireLease(c.run_id);
  // ② attempt 达上限 → failed/UNRECOVERABLE
  const m = createIn("sm", "m");
  store.claimLease(m.run_id, "w", 90_000, 3600);
  db.prepare("UPDATE tasks SET attempt=3 WHERE run_id=?").run(m.run_id); // 模拟历经 3 次 attempt
  expireLease(m.run_id);
  // ③ deadline 已过（A.4：跨 attempt 总预算）→ failed/UNRECOVERABLE
  const d = createIn("sd", "d");
  store.claimLease(d.run_id, "w", 90_000, 3600);
  db.prepare("UPDATE tasks SET deadline=? WHERE run_id=?").run(Date.now() - 1, d.run_id);
  expireLease(d.run_id);
  // ④ 其余 → 回 queued：lease 清空、attempt 不动、可再 claim
  const r = createIn("sr", "r");
  store.claimLease(r.run_id, "w", 90_000, 3600);
  expireLease(r.run_id);

  const reaped = store.reapExpired(Date.now(), maxAttempts);
  assert.equal(reaped.length, 4);
  const byId = new Map(reaped.map((x) => [x.run_id, x]));
  assert.equal(byId.get(c.run_id)?.status, "cancelled");
  const cRow = store.getTask(c.run_id)!;
  assert.equal(cRow.lease_owner, null);

  assert.equal(byId.get(m.run_id)?.status, "failed");
  assert.equal(store.getTask(m.run_id)?.error_code, "UNRECOVERABLE");
  assert.equal(byId.get(d.run_id)?.status, "failed");
  assert.equal(store.getTask(d.run_id)?.error_code, "UNRECOVERABLE");

  assert.equal(byId.get(r.run_id)?.status, "queued");
  const rRow = store.getTask(r.run_id)!;
  assert.equal(rRow.attempt, 1); // attempt 不动
  assert.equal(rRow.lease_owner, null); // lease 清空
  const reclaim = store.claimLease(r.run_id, "w2", 90_000, 3600);
  assert.ok(reclaim);
  assert.equal(reclaim.attempt, 2); // 下次 claim 时 +1
});

test("finalize 竞态先到先得：succeeded 成功后 cancelled 被拒", () => {
  const { run_id } = createIn("s1");
  const lease = store.claimLease(run_id, "w1", 90_000, 3600);
  assert.ok(lease);
  store.requestCancel(run_id); // 取消请求已挂起，但完成写先到
  assert.deepEqual(store.finalize(lease, "succeeded"), { fenced: false });
  // 二次 finalize 被 WHERE status='running' 拒绝（A.3：先到先得单一终态）
  assert.deepEqual(store.finalize(lease, "cancelled"), { fenced: true });
  assert.equal(store.getTask(run_id)?.status, "succeeded");
});

test("requestCancel 只置标志，不直接改终态（A.3）", () => {
  const q = createIn("s1", "q");
  assert.equal(store.requestCancel(q.run_id), true);
  let row = store.getTask(q.run_id)!;
  assert.equal(row.cancel_requested, 1);
  assert.equal(row.status, "queued"); // 状态不变

  const r = createIn("s2", "r");
  const lease = store.claimLease(r.run_id, "w", 90_000, 3600);
  assert.ok(lease);
  assert.equal(store.requestCancel(r.run_id), true);
  row = store.getTask(r.run_id)!;
  assert.equal(row.status, "running"); // 状态不变
  assert.equal(row.cancel_requested, 1);

  // 终态任务上的取消请求无效
  store.finalize(lease, "succeeded");
  assert.equal(store.requestCancel(r.run_id), false);
});

test("sessionHistory：成功任务含回答摘要与 result_ref 清单，失败任务无（A.2 S2）", () => {
  const ok = createIn("hist", "h1", "净利润是多少");
  const l1 = store.claimLease(ok.run_id, "w", 90_000, 3600);
  assert.ok(l1);
  store.appendEvent(l1, "sql", { sql: "SELECT 1", result_ref: "refs/r1.json" });
  store.appendEvent(l1, "sql", { sql: "SELECT 2", result_ref: "refs/r2.json" });
  // spec §5：answer 事件 payload 形状 {markdown}
  store.appendEvent(l1, "answer", { markdown: "2025 年净利润为 X 亿元" });
  store.finalize(l1, "succeeded");

  const bad = createIn("hist", "h2", "应收账款呢");
  const l2 = store.claimLease(bad.run_id, "w", 90_000, 3600);
  assert.ok(l2);
  store.finalize(l2, "failed", "CONFIG", "凭据无效");

  const hist = store.sessionHistory("hist");
  assert.equal(hist.length, 2);
  const [h1, h2] = hist;
  assert.deepEqual(
    { run_id: h1.run_id, question: h1.question, status: h1.status },
    { run_id: ok.run_id, question: "净利润是多少", status: "succeeded" },
  );
  assert.deepEqual(h1.result_refs, ["refs/r1.json", "refs/r2.json"]);
  assert.equal(h1.final_answer, "2025 年净利润为 X 亿元");
  assert.equal(h2.question, "应收账款呢");
  assert.equal(h2.status, "failed");
  assert.equal(h2.final_answer, null);
  assert.deepEqual(h2.result_refs, []);
});

test("deadline 接管臂：超预算任务不可被 claim，reaper 判 failed/UNRECOVERABLE（A.4）", () => {
  // 场景①：deadline 已过的 queued 任务（reap 回队路径）claim 被拒
  const t = createIn("sdl", "dl-1");
  const l1 = store.claimLease(t.run_id, "w1", 90_000, 1); // budgetS=1 → deadline=created_at+1s
  assert.ok(l1);
  const deadline = store.getTask(t.run_id)!.deadline!;
  assert.ok(deadline > 0, "deadline 首次 claim 固化");
  db.prepare("UPDATE tasks SET deadline=? WHERE run_id=?").run(Date.now() - 1000, t.run_id);
  expireLease(t.run_id);
  const reaped = store.reapExpired(Date.now(), 3);
  assert.equal(reaped.find((x) => x.run_id === t.run_id)?.status, "failed");
  assert.equal(store.getTask(t.run_id)?.error_code, "UNRECOVERABLE");

  // 场景②：deadline 已过但任务仍 queued（boot 自愈/回队后过预算）——claim 直接 false
  const q = createIn("sdl", "dl-2");
  db.prepare("UPDATE tasks SET deadline=? WHERE run_id=?").run(Date.now() - 1000, q.run_id);
  assert.equal(store.claimLease(q.run_id, "w2", 90_000, 3600), false); // WITHIN_BUDGET 接管臂
  assert.equal(store.getTask(q.run_id)?.status, "queued"); // 未被误置 running
  // 只能走 reaper 终态
  const reaped2 = store.reapExpired(Date.now(), 3);
  assert.equal(reaped2.find((x) => x.run_id === q.run_id)?.status, "failed");
  assert.equal(store.getTask(q.run_id)?.error_code, "UNRECOVERABLE");
});
