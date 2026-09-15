// M1-T4：任务模型与 SQLite 持久层 —— 附录 A 四大不变量的物理载体。
// 技术选型 better-sqlite3：同步 API + 单连接，所有状态迁移都是带围栏的条件写
// （A.0：真相在 SQLite，副作用安全靠"唯一命名 + 围栏发布"，而非"避免并发"）。
//
//   A.1 L1 唯一执行者：全部状态写经围栏条件写（run_id+attempt+lease_owner 三元，
//       rowcount=0 即失权信号，调用方 kill 自身进程树退出）
//   A.2 S1 串行：listRunnable 只放行"会话队首且为 queued"的任务（同会话第二个
//       任务在前一任务终态前永不可被 claim）
//   A.3 幂等：提交层 UNIQUE(client_submission_id) 同事务 catch；事件层 seq=MAX(seq)+1
//       同步事务内分配；结果层 publications INSERT OR IGNORE
//   A.4 恢复：deadline 首次 claim 固化；reapExpired 用同一条围栏条件 UPDATE 原子判定
//
// ---- 事件词表契约（冻结，spec §5 规范事件；T5 归一化/T7 编排/T8 SSE 共同遵守）----
// events.type 只允许以下六类，payload 形状如下（JSON.stringify 后入库，读取一律 parse）：
//   "stage"  → {stage: "queued|analyzing|querying|script_running|report_checking|repairing|publishing", text?}
//              另含内部字段 attempt（接管/围栏自愈时的 claim 事件）
//   "sql"    → {sql, rows, truncated, result_ref, elapsed_ms}
//   "answer" → {markdown}                      最终回答（sessionHistory 摘要即取此）
//   "report" → {path}                          发布后才有
//   "error"  → {code, message}
//   "done"   → {run_id, status, engine, elapsed_ms, tokens, recovered}
// 词表扩充须先改 spec 再改此处——消费方（SSE 前端/历史注入）按 type 分派，私造类型即断线。
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface TaskRow {
  run_id: string;
  client_submission_id: string | null;
  session_id: string;
  user: string;
  scope_group: string;
  question: string;
  status: TaskStatus;
  stage: string | null;
  attempt: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  cancel_requested: number;
  deadline: number | null;
  error_code: string | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
}

/** 围栏写句柄：claimLease 成功后返回，此后一切状态写必须携带它（A.1 L1）。 */
export interface Lease {
  run_id: string;
  attempt: number;
  lease_owner: string;
}

export interface FencedResult {
  fenced: boolean;
}

export interface CreateTaskInput {
  client_submission_id?: string;
  session_id: string;
  user: string;
  scope_group?: string;
  question: string;
}

export interface EventRow {
  seq: number;
  type: string;
  payload: unknown;
  created_at: number;
}

/** A.2 S2：会话历史注入结构（T7 恢复路径消费）。 */
export interface SessionHistoryEntry {
  run_id: string;
  question: string;
  status: TaskStatus;
  /** 成功任务：全部 sql 事件的 result_ref 清单；失败任务：[] */
  result_refs: string[];
  /** 成功任务：final answer 事件 payload 摘要；失败任务：null */
  final_answer: string | null;
}

export interface ReapedTask {
  run_id: string;
  status: TaskStatus;
}

const FENCE = "run_id = ? AND attempt = ? AND lease_owner = ?";
const LEASE_FREE = "(lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at < ?)";
const WITHIN_BUDGET = "(deadline IS NULL OR deadline >= ?)";

export class TaskStore {
  private db: Database.Database;
  private now: () => number;

  constructor(db: Database.Database, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
    db.exec(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "schema.sql"), "utf8"));
  }

  // ---------- A.3 提交层：幂等创建 ----------

  createTask(input: CreateTaskInput): { run_id: string; created: boolean } {
    const run_id = `run-${randomUUID()}`;
    const ts = this.now();
    try {
      return this.db.transaction(() => {
        this.db
          .prepare(
            `INSERT INTO tasks (run_id, client_submission_id, session_id, user, scope_group,
                                question, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
          )
          .run(
            run_id,
            input.client_submission_id ?? null,
            input.session_id,
            input.user,
            input.scope_group ?? "default",
            input.question,
            ts,
            ts,
          );
        return { run_id, created: true };
      })();
    } catch (err) {
      // UNIQUE(client_submission_id) 冲突：同事务内 catch 并 SELECT 返回原 run_id（A.3）。
      if (!this.isUniqueViolation(err) || input.client_submission_id == null) throw err;
      const existing = this.getTaskBySubmission(input.client_submission_id);
      if (!existing) throw err;
      return { run_id: existing.run_id, created: false };
    }
  }

  private isUniqueViolation(err: unknown): boolean {
    return err instanceof Error && err.message.includes("UNIQUE constraint failed");
  }

  getTask(runId: string): TaskRow | undefined {
    return this.db.prepare("SELECT * FROM tasks WHERE run_id = ?").get(runId) as TaskRow | undefined;
  }

  getTaskBySubmission(id: string): TaskRow | undefined {
    return this.db
      .prepare("SELECT * FROM tasks WHERE client_submission_id = ?")
      .get(id) as TaskRow | undefined;
  }

  // ---------- A.1 核心：租约与围栏写 ----------

  /**
   * 原子获权（A.1 L1）：单条条件 UPDATE——status='queued'，或 status='running' 但租约
   * 已过期/无主（接管与 boot 自愈路径），且租约空闲、未过 deadline（A.4 接管臂：超预算
   * 任务不可被接管续跑，只能走 reaper 的 deadline 分支终态 failed）才放行。
   * rowcount 判定胜负；成功时 attempt+1、deadline 首次固化（A.4）、同步写 stage 事件
   * （seq 在同一同步事务内 MAX(seq)+1 分配，A.3 事件层）。
   */
  claimLease(runId: string, workerId: string, ttlMs: number, budgetS: number): Lease | false {
    const ts = this.now();
    return this.db.transaction(() => {
      const r = this.db
        .prepare(
          `UPDATE tasks
           SET status='running', lease_owner=?, lease_expires_at=?,
               attempt=attempt+1, deadline=COALESCE(deadline, created_at + ? * 1000), updated_at=?
           WHERE run_id=? AND status IN ('queued','running') AND ${LEASE_FREE} AND ${WITHIN_BUDGET}`,
        )
        .run(workerId, ts + ttlMs, budgetS, ts, runId, ts, ts);
      if (r.changes === 0) return false;
      const attempt = this.getTask(runId)!.attempt;
      this.insertEventUnfenced(runId, "stage", { stage: "queued", to: "running", attempt }, ts);
      return { run_id: runId, attempt, lease_owner: workerId };
    })();
  }

  heartbeat(lease: Lease, ttlMs: number): FencedResult {
    const ts = this.now();
    const r = this.db
      .prepare(
        `UPDATE tasks SET lease_expires_at = ?, updated_at = ? WHERE ${FENCE} AND status='running'`,
      )
      .run(ts + ttlMs, ts, lease.run_id, lease.attempt, lease.lease_owner);
    return { fenced: r.changes === 0 };
  }

  updateStage(lease: Lease, stage: string): FencedResult {
    const ts = this.now();
    const r = this.db
      .prepare(`UPDATE tasks SET stage = ?, updated_at = ? WHERE ${FENCE} AND status='running'`)
      .run(stage, ts, lease.run_id, lease.attempt, lease.lease_owner);
    return { fenced: r.changes === 0 };
  }

  /**
   * 终态写入（A.3：先到先得）——WHERE 追加 status='running'，二次 finalize 自然被拒。
   * 终态同时清租约与 cancel_requested（终态后 requestCancel 不再生效）。
   */
  finalize(
    lease: Lease,
    status: "succeeded" | "failed" | "cancelled",
    errorCode?: string,
    errorMessage?: string,
  ): FencedResult {
    const ts = this.now();
    const r = this.db
      .prepare(
        `UPDATE tasks SET status=?, error_code=?, error_message=?, lease_owner=NULL,
                          lease_expires_at=NULL, cancel_requested=0, updated_at=?
         WHERE ${FENCE} AND status='running'`,
      )
      .run(status, errorCode ?? null, errorMessage ?? null, ts, lease.run_id, lease.attempt, lease.lease_owner);
    return { fenced: r.changes === 0 };
  }

  /**
   * A.3 事件层：seq 在同一同步事务内 MAX(seq)+1 分配（better-sqlite3 同步调用天然原子
   * 单调），写事件前先验围栏——失权者连事件都写不进（A.1）。
   */
  appendEvent(lease: Lease, type: string, payload: unknown): FencedResult & { seq?: number } {
    const ts = this.now();
    return this.db.transaction(() => {
      const held = this.db
        .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE ${FENCE} AND status='running'`)
        .get(lease.run_id, lease.attempt, lease.lease_owner).n as number;
      if (held === 0) return { fenced: true };
      const seq = this.insertEventUnfenced(lease.run_id, type, payload, ts);
      this.db
        .prepare(`UPDATE tasks SET updated_at=? WHERE ${FENCE}`)
        .run(ts, lease.run_id, lease.attempt, lease.lease_owner);
      return { fenced: false, seq };
    })();
  }

  /** seq 分配唯一入口：仅限已验证围栏/已获权的同步事务内调用（A.3）。 */
  private insertEventUnfenced(runId: string, type: string, payload: unknown, ts: number): number {
    const seq = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events WHERE run_id = ?")
      .get(runId).seq as number;
    this.db
      .prepare("INSERT INTO events (run_id, seq, type, payload, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(runId, seq, type, JSON.stringify(payload ?? null), ts);
    return seq;
  }

  listEvents(runId: string, afterSeq: number): EventRow[] {
    return this.db
      .prepare(
        "SELECT seq, type, payload, created_at FROM events WHERE run_id = ? AND seq > ? ORDER BY seq",
      )
      .all(runId, afterSeq)
      .map((r: any) => ({
        seq: r.seq,
        type: r.type,
        payload: JSON.parse(r.payload as string),
        created_at: r.created_at,
      }));
  }

  // ---------- A.3 结果层：恰好一次发布 ----------

  recordPublication(runId: string, reportPath: string): { published: boolean; report_path: string } {
    return this.db.transaction((): { published: boolean; report_path: string } => {
      const r = this.db
        .prepare("INSERT OR IGNORE INTO publications (run_id, report_path, published_at) VALUES (?, ?, ?)")
        .run(runId, reportPath, this.now());
      if (r.changes > 0) return { published: true, report_path: reportPath };
      const existing = this.db
        .prepare("SELECT report_path FROM publications WHERE run_id = ?")
        .get(runId) as { report_path: string };
      return { published: false, report_path: existing.report_path };
    })();
  }

  /** A.4 行4 恢复入口查询：run_id 是否已发布（只读，无需围栏——恢复路径的判定事实源）。 */
  getPublication(runId: string): { report_path: string; published_at: number } | undefined {
    return this.db
      .prepare("SELECT report_path, published_at FROM publications WHERE run_id = ?")
      .get(runId) as { report_path: string; published_at: number } | undefined;
  }

  /**
   * 重试释放（A.4 行1 的接续臂，T7 编排器专用）：可续跑的基础设施故障后，本执行者
   * 主动让出租约（status 保持 running、清 lease 字段）——紧随其后的 claimLease 才能以
   * attempt+1 接管（同 worker 或接管者均可；释放与重 claim 的窗口内被抢走属 A.1 允许
   * 的正确形态）。围栏条件写：失权返回 fenced，调用方不得再续跑。
   */
  releaseForRetry(lease: Lease): FencedResult {
    const ts = this.now();
    const r = this.db
      .prepare(
        `UPDATE tasks SET lease_owner=NULL, lease_expires_at=NULL, updated_at=?
         WHERE ${FENCE} AND status='running'`,
      )
      .run(ts, lease.run_id, lease.attempt, lease.lease_owner);
    return { fenced: r.changes === 0 };
  }

  // ---------- A.3 取消标志 / A.4 Reaper ----------

  /** 无围栏（A.3：无执行权者只置标志，不直接写终态）。终态任务上无效。 */
  requestCancel(runId: string): boolean {
    return (
      this.db
        .prepare(
          "UPDATE tasks SET cancel_requested=1, updated_at=? WHERE run_id=? AND status IN ('queued','running')",
        )
        .run(this.now(), runId).changes > 0
    );
  }

  /**
   * A.1 Reaper：对 running 且租约过期的任务，用同一条围栏条件 UPDATE 原子判定——
   *   cancel_requested → cancelled；attempt 达 maxAttempts 或 deadline<now → failed/UNRECOVERABLE；
   *   否则回 queued（lease 清空、stage 复位、attempt 不动，下次 claim 时 +1）。
   * 围栏含 lease_expires_at < now：过期瞬间被原主 heartbeat 续上的任务自动落空。
   * 另处理 queued 且 deadline 已过的任务（接管臂拒 claim 后的僵尸收尾：boot 自愈回队
   * 或回队后过预算——否则永久卡 queued 且堵死会话队首）→ failed/UNRECOVERABLE。
   */
  reapExpired(now: number, maxAttempts: number): ReapedTask[] {
    const expired = this.db
      .prepare(
        `SELECT run_id, lease_owner, attempt, cancel_requested, deadline
         FROM tasks WHERE status='running' AND ${LEASE_FREE}`,
      )
      .all(now) as { run_id: string; lease_owner: string; attempt: number; cancel_requested: number; deadline: number | null }[];
    const out: ReapedTask[] = [];
    for (const t of expired) {
      const overLimit = t.attempt >= maxAttempts;
      const overDeadline = t.deadline != null && t.deadline < now;
      const verdict: TaskStatus =
        t.cancel_requested === 1 ? "cancelled" : overLimit || overDeadline ? "failed" : "queued";
      // 逐行事务包裹：围栏判定基于行快照（cancel_requested/deadline）与条件 UPDATE 必须
      // 原子成立——未来第二连接场景下防止 requestCancel 落在 SELECT→UPDATE 窗口被清（取消丢失）。
      const applied = this.db.transaction((): boolean => {
        const r = this.db
          .prepare(
            `UPDATE tasks SET status=?, error_code=?, error_message=?, cancel_requested=0,
                              lease_owner=NULL, lease_expires_at=NULL, stage=NULL, updated_at=?
             WHERE ${FENCE} AND status='running' AND lease_expires_at < ?`,
          )
          .run(
            verdict,
            verdict === "failed" ? "UNRECOVERABLE" : null,
            verdict === "failed" ? (overLimit ? "reaper: attempt 超限" : "reaper: deadline 已过") : null,
            now,
            t.run_id,
            t.attempt,
            t.lease_owner,
            now,
          );
        return r.changes > 0;
      })();
      if (applied) out.push({ run_id: t.run_id, status: verdict });
    }
    // queued 且已过 deadline：接管臂使 claim 永远 false，此处是唯一终态出口
    const zombies = this.db
      .prepare("SELECT run_id FROM tasks WHERE status='queued' AND deadline IS NOT NULL AND deadline < ?")
      .all(now) as { run_id: string }[];
    for (const z of zombies) {
      const r = this.db
        .prepare(
          `UPDATE tasks SET status='failed', error_code='UNRECOVERABLE',
                            error_message='reaper: deadline 已过（queued）', updated_at=?
           WHERE run_id=? AND status='queued' AND deadline < ?`,
        )
        .run(now, z.run_id, now);
      if (r.changes > 0) out.push({ run_id: z.run_id, status: "failed" });
    }
    return out;
  }

  // ---------- A.2 S1：同会话串行 + S2 历史查询 ----------

  /**
   * A.2 S1：只放行"会话队首（最早的未终态任务）且恰为 queued"的任务——同会话第二个
   * 任务在前一任务终态前不可见、不可 claim（reap 回队路径同理：回 queued 即重新成为
   * 队首候选）。created_at 同毫秒用隐式 rowid 保持严格 FIFO。
   */
  listRunnable(limit: number): TaskRow[] {
    return this.db
      .prepare(
        `SELECT * FROM tasks t
         WHERE t.status='queued'
           AND t.rowid = (
             SELECT r.rowid FROM tasks r
             WHERE r.session_id = t.session_id AND r.status IN ('queued','running')
             ORDER BY r.created_at, r.rowid LIMIT 1
           )
         ORDER BY t.created_at, t.rowid
         LIMIT ?`,
      )
      .all(limit) as TaskRow[];
  }

  /** 本会话全部任务（按创建序）：A.2 S2 历史注入的事实源查询（T7 恢复路径消费）。 */
  sessionHistory(sessionId: string): SessionHistoryEntry[] {
    const tasks = this.db
      .prepare(
        "SELECT run_id, question, status FROM tasks WHERE session_id = ? ORDER BY created_at, rowid",
      )
      .all(sessionId) as { run_id: string; question: string; status: TaskStatus }[];
    const sqlRefs = this.db.prepare(
      "SELECT payload FROM events WHERE run_id = ? AND type='sql' ORDER BY seq",
    );
    const answerStmt = this.db.prepare(
      "SELECT payload FROM events WHERE run_id = ? AND type='answer' ORDER BY seq DESC LIMIT 1",
    );
    return tasks.map((t) => {
      // 失败任务仅保留问题文本（S2：模型知道问过什么、结果不可信）
      const failed = t.status === "failed" || t.status === "cancelled";
      const refs: string[] = [];
      if (!failed) {
        for (const e of sqlRefs.all(t.run_id) as { payload: string }[]) {
          const ref = (JSON.parse(e.payload) as { result_ref?: string }).result_ref;
          if (ref != null) refs.push(ref);
        }
      }
      const ansRow = failed ? undefined : (answerStmt.get(t.run_id) as { payload: string } | undefined);
      // spec §5：answer 事件 payload 形状为 {markdown}——摘要取 markdown 字段
      const final_answer = ansRow ? ((JSON.parse(ansRow.payload) as { markdown?: string }).markdown ?? null) : null;
      return { run_id: t.run_id, question: t.question, status: t.status, result_refs: refs, final_answer };
    });
  }
}
