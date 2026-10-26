// S4-B2-C2-B2-2B-2：WorkerPool hold-aware 恢复/派发/reap 接线测试。
// 只使用真实 TaskStore（内存 SQLite）与注入 runner；不接触模型/DWS/Docker。
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { TaskStore, type Lease } from "../store/task-store.ts";
import { WorkerPool, type PoolConfig } from "./worker-pool.ts";

function setup(cleanupHoldMode: boolean): { db: Database.Database; store: TaskStore } {
  const db = new Database(":memory:");
  const store = new TaskStore(db, Date.now, { cleanupHoldMode });
  return { db, store };
}

function config(cleanupHoldMode: boolean): PoolConfig {
  return {
    maxConcurrent: 2,
    pollIntervalMs: 1_000,
    reapIntervalMs: 1_000,
    maxAttempts: 3,
    cleanupHoldMode,
  };
}

function patchLegacyUnavailable(store: TaskStore, calls: Record<string, number>): void {
  store.healOrphans = () => { calls.legacyHeal += 1; throw new Error("legacy heal must not run"); };
  store.listRunnable = () => { calls.legacyList += 1; throw new Error("legacy list must not run"); };
  store.reapExpired = () => { calls.legacyReap += 1; throw new Error("legacy reap must not run"); };
}

function patchHoldUnavailable(store: TaskStore, calls: Record<string, number>): void {
  store.healOrphansWithHolds = () => { calls.holdHeal += 1; throw new Error("hold heal must not run"); };
  store.listRunnableWithCleanupHolds = () => { calls.holdList += 1; throw new Error("hold list must not run"); };
  store.reapExpiredWithHolds = () => { calls.holdReap += 1; throw new Error("hold reap must not run"); };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("off 模式：只调用 legacy heal/list/reap，hold API 零调用", async () => {
  const { db, store } = setup(false);
  try {
    const runId = store.createTask({ session_id: "s-off", user: "u", question: "q" }).run_id;
    const calls = { legacyHeal: 0, legacyList: 0, legacyReap: 0, holdHeal: 0, holdList: 0, holdReap: 0 };
    const origHeal = store.healOrphans.bind(store);
    const origList = store.listRunnable.bind(store);
    store.healOrphans = () => { calls.legacyHeal += 1; return origHeal(); };
    store.listRunnable = (n) => { calls.legacyList += 1; return origList(n); };
    store.reapExpired = () => { calls.legacyReap += 1; return []; };
    patchHoldUnavailable(store, calls);

    const launched: string[] = [];
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const pool = new WorkerPool({
      store,
      runner: async (id) => { launched.push(id); await gate; },
      config: config(false),
    });
    pool.start();
    await sleep(20);
    (pool as any).reapTick();
    release!();
    await pool.stop();

    assert.deepEqual(launched, [runId]);
    assert.equal(calls.legacyHeal, 1);
    assert.equal(calls.legacyList >= 1, true);
    assert.equal(calls.legacyReap, 1);
    assert.deepEqual([calls.holdHeal, calls.holdList, calls.holdReap], [0, 0, 0]);
  } finally {
    db.close();
  }
});

test("cleanup hold 模式：boot 恢复先于派发；executing/cleanup_pending 一律 recovery_required，不重跑", async () => {
  const { db, store } = setup(true);
  try {
    const executing = store.createTask({ session_id: "s-exec", user: "u", question: "q1" }).run_id;
    const execLease = store.claimLeaseWithCleanupHold(executing, "old-worker", 90_000, 3600)!;
    assert.ok(execLease);

    const pending = store.createTask({ session_id: "s-pending", user: "u", question: "q2" }).run_id;
    const pendLease = store.claimLeaseWithCleanupHold(pending, "old-worker", 90_000, 3600)!;
    store.beginCleanup(pendLease, "cleanup-pending-1");

    const ready = store.createTask({ session_id: "s-ready", user: "u", question: "q3" }).run_id;

    const calls = { legacyHeal: 0, legacyList: 0, legacyReap: 0, holdHeal: 0, holdList: 0, holdReap: 0 };
    patchLegacyUnavailable(store, calls);
    const origHoldHeal = store.healOrphansWithHolds.bind(store);
    const origHoldList = store.listRunnableWithCleanupHolds.bind(store);
    store.healOrphansWithHolds = (now, max) => { calls.holdHeal += 1; return origHoldHeal(now, max); };
    store.listRunnableWithCleanupHolds = (n) => { calls.holdList += 1; return origHoldList(n); };
    store.reapExpiredWithHolds = () => { calls.holdReap += 1; return []; };

    const launched: string[] = [];
    const pool = new WorkerPool({
      store,
      runner: async (id) => { launched.push(id); },
      config: config(true),
    });
    pool.start();
    await sleep(20);
    (pool as any).reapTick();
    await pool.stop();

    assert.deepEqual(launched, [ready], "只有 attempt=0 且无 hold 的新任务可派发");
    assert.equal(calls.holdHeal, 1);
    assert.equal(calls.holdList >= 1, true);
    assert.equal(calls.holdReap, 1);
    assert.deepEqual([calls.legacyHeal, calls.legacyList, calls.legacyReap], [0, 0, 0]);

    for (const [id, state] of [[executing, "executing"], [pending, "cleanup_pending"]] as const) {
      const task = store.getTask(id)!;
      const hold = store.getCleanupHold(id, 1)!;
      assert.equal(task.status, "running");
      assert.equal(task.error_code, "CLEANUP_RECOVERY_REQUIRED");
      assert.equal(hold.state, "recovery_required");
      assert.notEqual(hold.state, state);
      assert.equal(
        store.listEvents(id, 0).filter((e) => e.type === "done").length,
        0,
        "recovery_required 不得伪造 done",
      );
    }
  } finally {
    db.close();
  }
});

test("cleanup hold boot 恢复失败：start 拒绝启动，不派发、不降级 legacy", async () => {
  const { db, store } = setup(true);
  try {
    store.createTask({ session_id: "s-boot", user: "u", question: "q" }).run_id;
    store.healOrphansWithHolds = () => { throw new Error("corrupt hold row"); };
    const legacyHeal = store.healOrphans.bind(store);
    let legacyCalled = 0;
    store.healOrphans = () => { legacyCalled += 1; return legacyHeal(); };

    const launched: string[] = [];
    const pool = new WorkerPool({
      store,
      runner: async (id) => { launched.push(id); },
      config: config(true),
    });
    assert.throws(() => pool.start(), /corrupt hold row/);
    await sleep(20);
    await pool.stop();

    assert.deepEqual(launched, []);
    assert.equal(legacyCalled, 0);
    assert.equal(pool.stats.running, 0);
  } finally {
    db.close();
  }
});
