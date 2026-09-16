// M1-T8：工作进程池 —— spec D7 提交/执行分离 + 附录 A.1 boot 自愈。
//
// 职责边界：池只做"何时派发"与"何时收尸"，不做执行——执行（含 claimLease 获权、
// 围栏写、attempt 重试）全部在被注入的 runner 工厂（真实组装 = TaskRunner.runOnce，
// 其循环顶自行 claimLease，attempt+1）内完成。派发不 await：runOnce 的 Promise 记入
// inFlight 表防孤儿/防同任务重复派发。
//
// 容量语义：claim 是原子容量获取——listRunnable(S1 会话队首) 只给出候选，真正占用
// 槽位的是 runOnce 内 claimLease 的胜负。claim 失败者（被抢/超预算/已终态）runOnce
// 静默返回，槽位随 Promise settle 释放，下个 poll 周期重试。池不自行 claimLease
// （若池先 claim，runner 循环顶的 claim 会因租约非空被拒，任务永久卡 running）。
//
// T7 审查移交 rider（本层修复）：runOnce 抛出未捕获异常（如 copyFileSync 磁盘错）
// → 池捕获记日志、槽位释放、进程不 crash；该任务停留在 running+租约未过期，由
// 租约过期 + reapExpired 收尾（reaper 按预算/attempt 上限判 failed 或回队重派）。
//
// stop() 语义：停两个计时器后 await 全部在途 Promise（优雅停；外部先停 HTTP 入口
// 再停池即可保证不再有新任务进入）。

export interface PoolConfig {
  /** MAX_CONCURRENT_TASKS：全局并行上限（spec D7：2~3 起步压测）。 */
  maxConcurrent: number;
  /** 派发轮询间隔。 */
  pollIntervalMs: number;
  /** reaper 周期（A.4：租约过期/超预算收尸）。 */
  reapIntervalMs: number;
  /** reapExpired 的 attempt 上限——与 TaskRunner.maxAttempts 同源同值（index.ts 统一注入）。 */
  maxAttempts: number;
}

export interface PoolStats {
  running: number;
  queued: number;
}

export interface WorkerPoolDeps {
  store: import("../store/task-store.ts").TaskStore;
  /** 执行一个任务直到终态落库；真实组装 = (runId) => new TaskRunner(...).runOnce(runId)。 */
  runner: (runId: string) => Promise<void>;
  config: PoolConfig;
  /** 未捕获异常观测钩子（测试断言/接入日志）；缺省 console.error。 */
  onError?: (runId: string, err: unknown) => void;
}

export class WorkerPool {
  private store: WorkerPoolDeps["store"];
  private runner: WorkerPoolDeps["runner"];
  private config: PoolConfig;
  private onError: (runId: string, err: unknown) => void;
  /** run_id → 在途 Promise（防孤儿 + 防重复派发 + stop 优雅等待）。 */
  private inFlight = new Map<string, Promise<void>>();
  private dispatchTimer?: NodeJS.Timeout;
  private reapTimer?: NodeJS.Timeout;
  private started = false;

  constructor(deps: WorkerPoolDeps) {
    this.store = deps.store;
    this.runner = deps.runner;
    this.config = deps.config;
    this.onError = deps.onError ?? ((runId, err) => console.error(`[pool] runOnce 未捕获异常 run_id=${runId}:`, err));
  }

  /**
   * 启动派发/reap 双计时器。首步执行 A.1 boot 自愈：单服务部署不变量下，进程启动时
   * 不可能有合法租约持有者——上一次进程死亡残留的 running 任务全部回队（healOrphans），
   * 随后正常派发：claim 时 attempt+1 走恢复路径（A.4 行2），超预算者由 reaper 终态。
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    const healed = this.store.healOrphans();
    if (healed > 0) console.log(`[pool] boot 自愈：清理 ${healed} 个孤儿租约（A.1）`);
    this.dispatchTimer = setInterval(() => this.dispatchTick(), this.config.pollIntervalMs);
    this.dispatchTimer.unref?.();
    this.reapTimer = setInterval(() => this.reapTick(), this.config.reapIntervalMs);
    this.reapTimer.unref?.();
    this.dispatchTick(); // 立即首轮，不等第一个 tick
  }

  /** 停计时器并等待全部在途 runner settle（allSettled：失败的也不阻塞停机）。 */
  async stop(): Promise<void> {
    clearInterval(this.dispatchTimer);
    clearInterval(this.reapTimer);
    this.dispatchTimer = this.reapTimer = undefined;
    await Promise.allSettled([...this.inFlight.values()]);
  }

  get stats(): PoolStats {
    return { running: this.inFlight.size, queued: this.store.countQueued() };
  }

  private dispatchTick(): void {
    try {
      const capacity = this.config.maxConcurrent - this.inFlight.size;
      if (capacity <= 0) return;
      for (const t of this.store.listRunnable(capacity)) {
        if (this.inFlight.has(t.run_id)) continue; // 防重复派发（reaper 回队窗口内旧 Promise 未 settle 时）
        this.launch(t.run_id);
      }
    } catch (err) {
      // listRunnable/countQueued 是 SQLite 同步读——失败只可能是库级异常，记日志下轮重试
      console.error("[pool] dispatch tick 失败:", err);
    }
  }

  private reapTick(): void {
    try {
      const reaped = this.store.reapExpired(Date.now(), this.config.maxAttempts);
      for (const r of reaped) console.log(`[pool] reaper: ${r.run_id} → ${r.status}`);
    } catch (err) {
      console.error("[pool] reap tick 失败:", err);
    }
  }

  /**
   * 派发不 await（D7：池与执行解耦）。T7 rider：未捕获异常在此捕获——不 crash 进程，
   * 任务靠租约过期 + reaper 收尾（本层绝不代写终态：无围栏者写状态即破坏 A.1）。
   */
  private launch(runId: string): void {
    const p = this.runner(runId);
    this.inFlight.set(runId, p);
    p.then(
      () => this.settle(runId),
      (err) => {
        this.onError(runId, err);
        this.settle(runId);
      },
    );
  }

  private settle(runId: string): void {
    // 重派同 run_id 只会发生在旧 Promise settle 之后（在途期间 inFlight.has 挡住
    // dispatchTick），故无条件 delete 不会误清新 Promise。
    this.inFlight.delete(runId);
  }
}
