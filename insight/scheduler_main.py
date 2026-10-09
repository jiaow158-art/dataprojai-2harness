# insight/scheduler_main.py
"""SCH-1 常驻调度器：APScheduler 触发 + pipeline_lock 执行互斥 + trigger_queue 手动队列
+ 启动/每小时对账 + shadow 灰度模式 + 预热编排。

职责边界（裁定）：调度器只管按时触发/防并发/记账/失败处理/受控人工补跑——业务全在
worker（run_pipeline_for，与 CLI 完全同路径），detector/阈值/freeze 语义零改动。

诚实声明（裁定 2）：09:30 无实际硬门控，真实语义=first-final-wins（发布态判定）；
本调度器与后台一律不声称"严格 09:30 冻结"。

漏跑恢复（修正 D）：APScheduler misfire_grace_time=300s/coalesce 仅覆盖进程内迟到；
重启后的可靠补偿=启动/每小时对账 reconcile()——对照今日应有 fire 与 pipeline_run
（phase='pipeline'，忽略 shadow 行），daily 缺失且 09:05≤now<13:00 补跑、归因二发缺失
且 10:05≤now<14:00 补发（业务窗口自门控）；永不自动补历史日期；first-final-wins
保证 final 简报不被修改。

shadow 模式（修正 C）：INSIGHT_SCHEDULER_SHADOW=1 时触发只落 phase='shadow' 记账行
（不同 phase 不占调度去重键），不抢锁不执行业务不开队列轮询——与旧 pm2 cron 并行零风险。
"""
import json
import os
import threading
import time
import urllib.request
from datetime import date, datetime, timedelta

from apscheduler.schedulers.blocking import BlockingScheduler
from apscheduler.triggers.cron import CronTrigger
from zoneinfo import ZoneInfo

from .db import open_db
from .pipeline_log import (LockBusy, LockHeartbeat, acquire_lock, claim_next,
                           enqueue, finish_request, insert_run, mark_run,
                           new_holder, recover_stale_runs, release_lock, utcnow_iso)

TZ = ZoneInfo("Asia/Shanghai")
API_BASE = os.environ.get("INSIGHT_API_URL", "http://127.0.0.1:58095")
ADMIN_TOKEN = os.environ.get("INSIGHT_ADMIN_TOKEN", "")
SHADOW = os.environ.get("INSIGHT_SCHEDULER_SHADOW", "") == "1"
POLL_INTERVAL = 15
RETRY_DELAY_S = 300
# 补跑时限（业务窗口对齐：daily 13:00 前、归因 14:00 窗口内；均只限今日，不碰历史/final）
DAILY_CATCHUP_UNTIL = 13 * 60      # 13:00 local（分）
ATTR_CATCHUP_UNTIL = 14 * 60 - 5   # 13:55 local

JOB_SLOTS = {  # job_type -> (cron 时, cron 分) —— slot 时间同时是调度去重键
    "daily": (9, 5),
    "attribution_second": (10, 5),
}


def _local_now() -> datetime:
    return datetime.now(TZ)


def _slot_ts(job_type: str, day: date) -> int:
    h, m = JOB_SLOTS[job_type]
    return int(datetime(day.year, day.month, day.day, h, m, tzinfo=TZ).timestamp())


def _http_admin(path: str, payload: dict) -> dict:
    """scheduler → insight-api 受控调用（预热/缓存失效在 api 进程内执行，缓存才热得起来）。"""
    req = urllib.request.Request(
        API_BASE + path, data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "X-Insight-Admin-Token": ADMIN_TOKEN},
        method="POST")
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode("utf-8"))


class Scheduler:
    def __init__(self, db_path: str):
        self.db_path = db_path
        # APScheduler job 线程 + poll/广播/心跳线程共用：关线程检查（短事务，模块级串行化）
        self.db = open_db(db_path, check_same_thread=False)
        self.holder = new_holder()
        self._started_iso = utcnow_iso()
        self.sched = BlockingScheduler(timezone=TZ,
                                       job_defaults={"misfire_grace_time": 300,
                                                     "coalesce": True})

    # ── 业务执行（定时/人工/对账共用；唯一入口，全部经执行锁） ────────────────────
    def _now_minute(self) -> int:
        now = _local_now()
        return now.hour * 60 + now.minute

    def execute(self, run_id: str, job_type: str, brief_date: str,
                trigger_type: str, deadline_minute: int | None):
        """deadline_minute=本地时刻（分）截止：错过即 skipped（对齐业务窗口，不追改）。"""
        try:
            acquire_lock(self.db, holder=self.holder, brief_date=brief_date)
        except LockBusy:
            if deadline_minute is None:
                mark_run(self.db, run_id, status="failed", error="pipeline busy (manual rejected)")
                return "busy-rejected"
            mark_run(self.db, run_id, status="queued", error="deferred: lock busy")
            if self._now_minute() >= deadline_minute:
                mark_run(self.db, run_id, status="skipped", error="window passed while waiting lock")
                return "skipped"
            self.sched.add_job(self._retry, "date",
                                run_date=datetime.now(TZ) + timedelta(seconds=RETRY_DELAY_S),
                                args=[run_id, job_type, brief_date, deadline_minute],
                                id=f"retry-{run_id}", replace_existing=True)
            return "deferred"
        try:
            with LockHeartbeat(self.db, self.holder, run_id):
                mark_run(self.db, run_id, status="running")
                final = self._run_business(run_id, job_type, brief_date)
                mark_run(self.db, run_id, status=final)   # 终态记账归调度层（异常路径 _run_business 已标 failed）
                return final
        finally:
            release_lock(self.db, holder=self.holder)

    def _retry(self, run_id, job_type, brief_date, deadline_minute):
        if deadline_minute is not None and self._now_minute() >= deadline_minute:
            mark_run(self.db, run_id, status="skipped", error="window passed while waiting lock")
            return
        row = self.db.execute("SELECT retry_count FROM pipeline_run WHERE run_id=?",
                              (run_id,)).fetchone()
        if row and row["retry_count"] is not None:
            self.db.execute("UPDATE pipeline_run SET retry_count=retry_count+1 WHERE run_id=?",
                            (run_id,))
        self.execute(run_id, job_type, brief_date, "retry", deadline_minute)

    def _run_business(self, run_id: str, job_type: str, brief_date: str) -> str:
        """业务执行（与 worker CLI 同路径）。状态映射：单雷达失败≠全天成功。"""
        from .worker_main import run_pipeline_for
        from .store import Store
        data_date = (date.fromisoformat(brief_date) - timedelta(days=1)).isoformat()
        try:
            out, attrs = run_pipeline_for(Store(self.db), data_date, brief_date,
                                          datetime.now())
        except Exception as e:
            mark_run(self.db, run_id, status="failed", error=repr(e)[:400])
            return "failed"
        brief = out["brief"]
        # 雷达分解（radar_run 当日实况——already-ran/ran/ready_check_failed/error 全景）
        radar = {r["detector"]: r["status"] for r in self.db.execute(
            "SELECT detector, status FROM radar_run WHERE data_date=?", (data_date,))}
        attr_stat = {"done": sum(1 for a in attrs if a.get("status") == "done"),
                     "failed": sum(1 for a in attrs if a.get("status") == "failed")}
        mark_run(self.db, run_id, radar_status_json=json.dumps(
            {"radars": radar, "attribution": attr_stat}, ensure_ascii=False))
        fresh = json.loads(self.db.execute(
            "SELECT freshness_json FROM daily_brief WHERE brief_date=?",
            (brief_date,)).fetchone()["freshness_json"])
        mark_run(self.db, run_id, watermark_json=json.dumps(
            fresh, ensure_ascii=False))
        if brief["status"] == "final":
            not_ready_radars = [d for d, s in radar.items()
                                if s in ("ready_check_failed", "error")]
            return "partial" if not_ready_radars else "succeeded"
        return "not_ready"

    # ── 定时触发（去重键=当日 slot 时间戳：进程内 misfire 与重启对账天然幂等） ──────
    def fire(self, job_type: str):
        today = _local_now().date()
        slot = _slot_ts(job_type, today)
        run_id, inserted = insert_run(
            self.db, job_type=job_type, phase="shadow" if SHADOW else "pipeline",
            status="shadow" if SHADOW else "queued", trigger_type="shadow" if SHADOW else "scheduled",
            brief_date=today.isoformat(), scheduled_at=slot)
        if not inserted:
            print(f"[sched] {job_type} slot 已有触发记录，跳过（防双跑）", flush=True)
            return
        if SHADOW:
            print(f"[shadow] {job_type} 触发计划已记账（不执行业务）", flush=True)
            return
        deadline = DAILY_CATCHUP_UNTIL if job_type == "daily" else ATTR_CATCHUP_UNTIL
        self.execute(run_id, job_type, today.isoformat(), "scheduled", deadline)

    # ── 对账（修正 D：启动 + 每小时；只看 pipeline 行，shadow 不算已执行） ─────────
    def reconcile(self):
        stale = recover_stale_runs(self.db)
        if stale:
            print(f"[reconcile] 孤儿 running 标 failed: {stale}", flush=True)
        now = _local_now()
        today = now.date()
        now_m = now.hour * 60 + now.minute
        for job_type, (h, m) in JOB_SLOTS.items():
            done = self.db.execute(
                "SELECT 1 FROM pipeline_run WHERE job_type=? AND brief_date=?"
                " AND phase='pipeline' AND trigger_type IN ('scheduled','retry')",
                (job_type, today.isoformat())).fetchone()
            if done:
                continue
            if job_type == "daily" and (h * 60 + m) <= now_m < DAILY_CATCHUP_UNTIL:
                print(f"[reconcile] 今日 {job_type} 缺失，对账补跑", flush=True)
                self.fire(job_type)          # slot 去重键=当日 slot，双保险
            elif job_type == "attribution_second" and (h * 60 + m) <= now_m < ATTR_CATCHUP_UNTIL:
                print(f"[reconcile] 今日 {job_type} 缺失，对账补发", flush=True)
                self.fire(job_type)

    # ── 手动队列（修正 B；shadow 模式不领取——不产生半套执行） ───────────────────
    def poll_queue(self):
        while True:
            if not SHADOW:
                try:
                    self._drain_one()
                except Exception as e:
                    print(f"[queue] error: {repr(e)[:200]}", flush=True)
            time.sleep(POLL_INTERVAL)

    def _drain_one(self):
        req = claim_next(self.db, claimed_by=self.holder)
        if req is None:
            return
        action, brief_date, requested_by = req["action"], req["brief_date"], req["requested_by"]
        print(f"[queue] 领取 {req['request_id']} {action} by {requested_by}", flush=True)
        if action == "daily_run":
            bd = brief_date or _local_now().date().isoformat()
            run_id, _ = insert_run(self.db, job_type="manual_rerun", phase="pipeline",
                                   status="queued", trigger_type="manual", brief_date=bd,
                                   triggered_by=requested_by)
            r = self.execute(run_id, "manual_rerun", bd, "manual", deadline_minute=None)
            finish_request(self.db, req["request_id"],
                           status="done" if r in ("succeeded", "partial", "not_ready") else "failed",
                           run_id=run_id, note=r)
        elif action in ("prewarm_target", "prewarm_region"):
            kind = "target" if action == "prewarm_target" else "region"
            run_id, _ = insert_run(self.db, job_type=action, phase="prewarm",
                                   status="queued", trigger_type="manual", triggered_by=requested_by)
            mark_run(self.db, run_id, status="running")
            try:
                # 预热在 api 进程内执行（缓存才热得起来）；依赖就绪检查由 api 侧
                # watermark-aware 入口承担（裁定 3：各自依赖判定，不挂靠四雷达结果）
                out = _http_admin("/admin/prewarm", {"kind": kind})
                mark_run(self.db, run_id,
                         status="succeeded" if out.get("ok") else "skipped",
                         error=None if out.get("ok") else str(out.get("reason"))[:200])
                finish_request(self.db, req["request_id"],
                               status="done" if out.get("ok") else "failed",
                               run_id=run_id, note=str(out.get("reason") or "warm"))
            except Exception as e:
                mark_run(self.db, run_id, status="failed", error=repr(e)[:300])
                finish_request(self.db, req["request_id"], status="failed",
                               run_id=run_id, note=repr(e)[:200])
        elif action == "cache_invalidate":
            run_id, _ = insert_run(self.db, job_type="cache_invalidate", phase="invalidate",
                                   status="queued", trigger_type="manual", triggered_by=requested_by)
            mark_run(self.db, run_id, status="running")
            try:
                out = _http_admin("/admin/cache/invalidate", {})
                mark_run(self.db, run_id, status="succeeded")
                finish_request(self.db, req["request_id"], status="done", run_id=run_id,
                               note=f"cleared={out.get('cleared')}")
            except Exception as e:
                mark_run(self.db, run_id, status="failed", error=repr(e)[:300])
                finish_request(self.db, req["request_id"], status="failed", run_id=run_id,
                               note=repr(e)[:200])

    # ── 状态广播（管理后台读 scheduler_state 表；api 进程展示） ──────────────────
    def broadcast_state(self):
        while True:
            try:
                # APScheduler 3.11：Job.next_run_time 属性兼容（getattr 兜底防 pending 态）
                def next_of(jt):
                    j = self.sched.get_job(jt)
                    t = getattr(j, "next_run_time", None) if j else None
                    return t.isoformat() if t else None
                nxt = {jt: next_of(jt) for jt in JOB_SLOTS}
                with self.db:
                    self.db.execute(
                        "INSERT INTO scheduler_state (k, v, updated_at) VALUES ('main', ?, ?)"
                        " ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at",
                        (json.dumps({"mode": "shadow" if SHADOW else "live",
                                     "holder": self.holder, "pid": os.getpid(),
                                     "started_at": self._started_iso,
                                     "next_fire": nxt}, ensure_ascii=False),
                         int(time.time())))
            except Exception as e:
                print(f"[broadcast] error: {repr(e)[:150]}", flush=True)
            time.sleep(60)

    def run(self):
        import socket
        import uuid
        self.holder = f"{socket.gethostname()}:{os.getpid()}:{uuid.uuid4().hex[:8]}"
        self._started_iso = utcnow_iso()
        mode = "shadow" if SHADOW else "live"
        if not ADMIN_TOKEN and not SHADOW:
            print("[sched] 警告：INSIGHT_ADMIN_TOKEN 未设置——预热/缓存失效队列将失败"
                  "（定时流水线不受影响）", flush=True)
        self.reconcile()
        for jt, (h, m) in JOB_SLOTS.items():
            self.sched.add_job(self.fire, CronTrigger(hour=h, minute=m, timezone=TZ),
                               args=[jt], id=jt)
        self.sched.add_job(self.reconcile, "cron", minute="0", id="reconcile-hourly")
        threading.Thread(target=self.poll_queue, daemon=True).start()
        threading.Thread(target=self.broadcast_state, daemon=True).start()
        print(f"[sched] scheduler {mode} 启动：daily 09:05 / attribution 10:05（Asia/Shanghai）",
              flush=True)
        self.sched.start()


def main():
    db_path = os.environ["INSIGHT_DB_PATH"]
    Scheduler(db_path).run()


if __name__ == "__main__":
    main()
