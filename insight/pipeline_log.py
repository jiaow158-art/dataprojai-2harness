# insight/pipeline_log.py
"""SCH-1 调度服务化的执行底座：运行记录 / 单例执行互斥锁 / 跨进程触发队列。

修正A（锁模型）：uq_pipeline_fire 只做调度触发去重；真正的执行互斥是 pipeline_lock
单例行——原子抢占（INSERT ON CONFLICT DO NOTHING）→ 抢不到时仅当持锁者心跳过期才
CAS 夺回；持锁执行期由心跳线程续期；释放/夺回都比对 holder 防误伤。定时、人工补跑、
重试、预热全部经 acquire_pipeline_lock 串行——两个 worker 不可能同时执行生产流水线。

修正B（跨进程触发）：insight-api 与 scheduler_main 不同进程，不共享内存——手动触发
经 trigger_queue 持久化入队，scheduler 用 CAS 领取（UPDATE ... WHERE status='pending'）。

所有时间戳 epoch 秒；测试可注入 clock。
"""
import os
import socket
import sqlite3
import threading
import uuid
from datetime import datetime, timezone

STALE_LOCK_SECONDS = 300          # 心跳超过 5 分钟视为持锁者已死（心跳周期 30s）
HEARTBEAT_INTERVAL = 30


def _now(clock=None) -> int:
    if clock is not None:
        return int(clock() if callable(clock) else clock)
    return int(datetime.now(timezone.utc).timestamp())


def new_holder() -> str:
    return f"{socket.gethostname()}:{os.getpid()}:{uuid.uuid4().hex[:8]}"


def new_run_id() -> str:
    return f"pr-{uuid.uuid4()}"


# ── 运行记录 ─────────────────────────────────────────────────────────────────────

def insert_run(db, *, job_type: str, phase: str, status: str, trigger_type: str,
               brief_date: str | None = None, as_of_date: str | None = None,
               scheduled_at: int | None = None, triggered_by: str | None = None,
               clock=None) -> tuple[str, bool]:
    """插入运行记录。返回 (run_id, inserted)——调度触发去重：同 (job_type,phase,scheduled_at)
    已存在则不插入（INSERT OR IGNORE），inserted=False 表示本次触发已被占用。"""
    run_id = new_run_id()
    started = _now(clock) if status == "running" else None
    with db:
        cur = db.execute(
            "INSERT OR IGNORE INTO pipeline_run (run_id, job_type, phase, brief_date,"
            " as_of_date, scheduled_at, started_at, status, trigger_type, triggered_by,"
            " heartbeat_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (run_id, job_type, phase, brief_date, as_of_date, scheduled_at,
             started, status, trigger_type, triggered_by, started))
        if cur.rowcount == 0:
            return "", False
        return run_id, True


def mark_run(db, run_id: str, *, status: str | None = None, error: str | None = None,
             watermark_json: str | None = None, radar_status_json: str | None = None,
             clock=None) -> None:
    sets, args = ["heartbeat_at = ?"], [_now(clock)]
    if status is not None:
        sets.append("status = ?"); args.append(status)
        if status == "running":
            sets.append("started_at = COALESCE(started_at, ?)"); args.append(_now(clock))
        if status in ("succeeded", "partial", "not_ready", "failed", "skipped"):
            sets.append("finished_at = ?"); args.append(_now(clock))
    if error is not None:
        sets.append("error_message = ?"); args.append(error[:500])
    if watermark_json is not None:
        sets.append("watermark_json = ?"); args.append(watermark_json)
    if radar_status_json is not None:
        sets.append("radar_status_json = ?"); args.append(radar_status_json)
    args.append(run_id)
    with db:
        db.execute(f"UPDATE pipeline_run SET {', '.join(sets)} WHERE run_id = ?", args)


def heartbeat_run(db, run_id: str, clock=None) -> None:
    with db:
        db.execute("UPDATE pipeline_run SET heartbeat_at = ? WHERE run_id = ?",
                   (_now(clock), run_id))


def recover_stale_runs(db, *, stale_seconds: int = 3600, clock=None) -> list[str]:
    """启动对账（修正D 一环）：进程崩溃遗留的 running 记录标 failed(stale)。
    阈值独立于锁（长任务心跳在，锁在；无心跳且超 1h 的 running 判孤儿）。"""
    rows = db.execute(
        "SELECT run_id FROM pipeline_run WHERE status='running' AND heartbeat_at < ?",
        (_now(clock) - stale_seconds,)).fetchall()
    for r in rows:
        mark_run(db, r["run_id"], status="failed", error="stale: heartbeat lost (crash recovery)")
    return [r["run_id"] for r in rows]


# ── 执行互斥锁（修正A） ──────────────────────────────────────────────────────────

class LockBusy(RuntimeError):
    """锁被活跃持锁者占用（调用方应排队/拒绝，绝不并发执行）。"""


def acquire_lock(db, *, holder: str, brief_date: str | None = None,
                 stale_seconds: int = STALE_LOCK_SECONDS, clock=None) -> bool:
    """原子抢占执行锁：成功 True。已被占用时，仅当持锁者心跳超时才 CAS 夺回；
    活跃占用抛 LockBusy（带持锁者信息）。SQLite WAL 下单写者序列化保证原子性。"""
    ts = _now(clock)
    try:
        with db:
            db.execute(
                "INSERT INTO pipeline_lock (id, holder, acquired_at, heartbeat_at, brief_date)"
                " VALUES (1,?,?,?,?)", (holder, ts, ts, brief_date))
        return True
    except sqlite3.IntegrityError:
        pass
    row = db.execute("SELECT holder, heartbeat_at FROM pipeline_lock WHERE id=1").fetchone()
    if row is None:                                   # 竞态：刚被释放——再试一次插入
        with db:
            db.execute(
                "INSERT INTO pipeline_lock (id, holder, acquired_at, heartbeat_at, brief_date)"
                " VALUES (1,?,?,?,?)", (holder, ts, ts, brief_date))
        return True
    if ts - row["heartbeat_at"] > stale_seconds:      # 持锁者已死 → CAS 夺回（比对旧 holder）
        with db:
            cur = db.execute(
                "UPDATE pipeline_lock SET holder=?, acquired_at=?, heartbeat_at=?,"
                " brief_date=? WHERE id=1 AND holder=?",
                (holder, ts, ts, brief_date, row["holder"]))
            if cur.rowcount == 1:
                return True
    raise LockBusy(f"pipeline busy: holder={row['holder']} heartbeat={ts - row['heartbeat_at']}s ago")


def release_lock(db, *, holder: str, clock=None) -> None:
    with db:
        db.execute("DELETE FROM pipeline_lock WHERE id=1 AND holder=?", (holder,))


def touch_lock(db, *, holder: str, clock=None) -> None:
    with db:
        db.execute("UPDATE pipeline_lock SET heartbeat_at=? WHERE id=1 AND holder=?",
                   (_now(clock), holder))


class LockHeartbeat:
    """执行期心跳：锁与 run 记录双续期；线程随 with 块退出而停。"""

    def __init__(self, db, holder: str, run_id: str, interval: int = HEARTBEAT_INTERVAL):
        self.db, self.holder, self.run_id, self.interval = db, holder, run_id, interval
        self._stop = threading.Event()
        self._t: threading.Thread | None = None

    def __enter__(self):
        self._t = threading.Thread(target=self._loop, daemon=True)
        self._t.start()
        return self

    def _loop(self):
        while not self._stop.wait(self.interval):
            try:
                touch_lock(self.db, holder=self.holder)
                heartbeat_run(self.db, self.run_id)
            except Exception:
                pass                              # 心跳失败不杀业务；锁过期兜底在 acquire 侧
    def __exit__(self, *exc):
        self._stop.set()
        if self._t:
            self._t.join(timeout=2)


# ── 跨进程触发队列（修正B） ──────────────────────────────────────────────────────

# 修正E：只暴露 worker 当前真实支持的安全操作（无 --phase 能力 → 不提供单阶段补跑）
QUEUE_ACTIONS = {
    "daily_run",        # 整日流水线（--brief-date 语义；参数校验限定今日/昨日）
    "prewarm_target",   # 预热 target_overview（依赖就绪检查通过才执行）
    "prewarm_region",   # 预热 region_map（同上）
    "cache_invalidate", # 清 insight-api 进程内 trend 缓存（同日修订兜底）
}


def enqueue(db, *, action: str, brief_date: str | None, requested_by: str,
            clock=None) -> tuple[str, str]:
    """入队（insight-api 侧调用）。幂等：已有同 (action, brief_date) 的 pending →
    返回既有 request_id（note 标注 dedup）。返回 (request_id, status)。"""
    if action not in QUEUE_ACTIONS:
        raise ValueError(f"unknown action: {action}")
    existing = db.execute(
        "SELECT request_id FROM trigger_queue WHERE status='pending' AND action=?"
        " AND brief_date IS ?", (action, brief_date)).fetchone()
    if existing:
        return existing["request_id"], "pending(dedup)"
    rid = f"rq-{uuid.uuid4()}"
    with db:
        db.execute(
            "INSERT INTO trigger_queue (request_id, action, brief_date, requested_by,"
            " requested_at, status) VALUES (?,?,?,?,?,'pending')",
            (rid, action, brief_date, requested_by, _now(clock)))
    return rid, "pending"


def claim_next(db, *, claimed_by: str, clock=None) -> dict | None:
    """scheduler 原子领取一条 pending（FIFO）：CAS UPDATE ... WHERE status='pending'。
    SQLite 单写者保证两 scheduler 实例不会领到同一条。"""
    row = db.execute(
        "SELECT * FROM trigger_queue WHERE status='pending'"
        " ORDER BY requested_at LIMIT 1").fetchone()
    if row is None:
        return None
    with db:
        cur = db.execute(
            "UPDATE trigger_queue SET status='claimed', claimed_at=?, claimed_by=?"
            " WHERE request_id=? AND status='pending'",
            (_now(clock), claimed_by, row["request_id"]))
        if cur.rowcount == 0:
            return None                              # 被另一实例抢走
    return dict(row)


def finish_request(db, request_id: str, *, status: str, run_id: str | None = None,
                   note: str | None = None, clock=None) -> None:
    with db:
        db.execute(
            "UPDATE trigger_queue SET status=?, result_run_id=?, note=? WHERE request_id=?",
            (status, run_id, note, request_id))


def utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")
