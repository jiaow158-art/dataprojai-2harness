# SCH-1 调度服务化测试：用户指定的 8 项验收场景 + 锁并发压测。
# 业务执行一律 monkeypatch（Scheduler._run_business）——调度机制测试不烧 DWS/网关。
import json
import threading
import urllib.request
from datetime import date, datetime, timedelta

import pytest

from insight import pipeline_log as pl
from insight import scheduler_main as sm
from insight.db import open_db
from insight.trend_service import TrendService


_DB_PATH: dict = {}


@pytest.fixture()
def db(tmp_path):
    p = tmp_path / "t.db"
    _DB_PATH["v"] = str(p)
    conn = open_db(p)
    yield conn
    conn.close()


@pytest.fixture()
def sch(db, monkeypatch):
    """Scheduler 实例（不起 APScheduler 主循环）；业务执行打桩为 succeeded。"""
    s = sm.Scheduler.__new__(sm.Scheduler)
    s.db_path = "unused"
    s.db = db
    s.holder = pl.new_holder()
    s._started_iso = pl.utcnow_iso()
    from apscheduler.schedulers.blocking import BlockingScheduler
    s.sched = BlockingScheduler(timezone=sm.TZ)
    calls = {"n": 0}
    monkeypatch.setattr(s, "_run_business", lambda run_id, jt, bd: calls.__setitem__("n", calls["n"] + 1) or "succeeded")
    s._biz_calls = calls
    s._now_minute = lambda: 9 * 60 + 30            # 固定窗口内时刻（deadline 判定与真实时钟解耦）
    return s


NOW = {"t": 1791300000}  # 可注入时钟（epoch 秒）


def run_row(db, run_id):
    return db.execute("SELECT * FROM pipeline_run WHERE run_id=?", (run_id,)).fetchone()


# ── 场景 1：09:05 自动任务与管理员补跑同时触发 ────────────────────────────────────

def test_scheduled_and_manual_concurrent(db, sch):
    # 定时先抢到锁（活跃心跳）
    holder_daily = pl.new_holder()
    assert pl.acquire_lock(db, holder=holder_daily, brief_date="2026-10-09")
    # 定时触发（deadline 内）→ deferred：排队等锁，不并发执行
    rid1, ok1 = pl.insert_run(db, job_type="daily", phase="pipeline", status="queued",
                              trigger_type="scheduled", brief_date="2026-10-09", scheduled_at=100)
    assert ok1
    assert sch.execute(rid1, "daily", "2026-10-09", "scheduled", sm.DAILY_CATCHUP_UNTIL) == "deferred"
    assert run_row(db, rid1)["status"] == "queued"
    # 管理员补跑同时到达 → 明确拒绝（busy-rejected），绝不排队执行第二个流水线
    rid2, _ = pl.insert_run(db, job_type="manual_rerun", phase="pipeline", status="queued",
                            trigger_type="manual", brief_date="2026-10-09", triggered_by="admin-prod")
    assert sch.execute(rid2, "manual_rerun", "2026-10-09", "manual", None) == "busy-rejected"
    assert run_row(db, rid2)["status"] == "failed"
    assert sch._biz_calls["n"] == 0, "锁被占用期间零业务执行"
    pl.release_lock(db, holder=holder_daily)


def test_lock_concurrency_stress(db):
    """并发抢占：8 线程各自独立连接（真实跨进程语义），恰好 1 成功 7 拒绝。"""
    results = []
    bar = threading.Barrier(8)
    lock_path = _DB_PATH["v"]

    def worker(i):
        conn = open_db(lock_path)          # 每线程独立连接（sqlite 线程绑定）
        try:
            bar.wait()
            try:
                acquire_ok = pl.acquire_lock(conn, holder=f"x{i}")
                if acquire_ok:
                    results.append("ok")   # 不释放——其余必须全部 busy
            except pl.LockBusy:
                results.append("busy")
            except Exception:
                results.append("err")
        finally:
            conn.close()

    ts = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
    [t.start() for t in ts]
    [t.join(timeout=30) for t in ts]
    assert not any(t.is_alive() for t in ts), "并发压测卡死"
    assert results.count("ok") == 1 and results.count("busy") == 7 and results.count("err") == 0


# ── 场景 2：09:05 Worker 未结束，10:05 第二任务到达 ──────────────────────────────

def test_second_fire_waits_then_runs(db, sch):
    holder_first = pl.new_holder()
    assert pl.acquire_lock(db, holder=holder_first, brief_date="2026-10-09")
    rid1, _ = pl.insert_run(db, job_type="daily", phase="pipeline", status="queued",
                            trigger_type="scheduled", brief_date="2026-10-09", scheduled_at=100)
    assert sch.execute(rid1, "daily", "2026-10-09", "scheduled", sm.DAILY_CATCHUP_UNTIL) == "deferred"
    # 09:05 释放（模拟完成）
    pl.release_lock(db, holder=holder_first)
    # 10:05 的重试到达 → 真实执行
    assert sch.execute(rid1, "daily", "2026-10-09", "retry", sm.DAILY_CATCHUP_UNTIL) == "succeeded"
    assert run_row(db, rid1)["status"] == "succeeded"
    assert sch._biz_calls["n"] == 1
    assert db.execute("SELECT COUNT(*) c FROM pipeline_lock").fetchone()["c"] == 0, "执行后锁释放"


# ── 场景 3：Scheduler 重启且存在运行中任务（崩溃恢复） ───────────────────────────

def test_restart_recovers_stale_running(db, sch):
    rid, _ = pl.insert_run(db, job_type="daily", phase="pipeline", status="running",
                           trigger_type="scheduled", brief_date="2026-10-09")
    # 崩溃：心跳停在 2 小时前；锁也是孤儿
    db.execute("UPDATE pipeline_run SET heartbeat_at=? WHERE run_id=?", (NOW["t"] - 7200, rid))
    db.execute("INSERT INTO pipeline_lock (id, holder, acquired_at, heartbeat_at) VALUES (1,'dead',?,?)",
               (NOW["t"] - 7200, NOW["t"] - 7200))
    db.commit()
    stale = pl.recover_stale_runs(db, stale_seconds=3600, clock=lambda: NOW["t"])
    assert stale == [rid]
    assert run_row(db, rid)["status"] == "failed"
    # 孤儿锁被新实例夺回
    assert pl.acquire_lock(db, holder=sch.holder, stale_seconds=300, clock=lambda: NOW["t"])
    # 活跃锁不可夺：新鲜心跳 → LockBusy
    pl.release_lock(db, holder=sch.holder)
    pl.acquire_lock(db, holder="alive", clock=lambda: NOW["t"])
    pl.touch_lock(db, holder="alive", clock=lambda: NOW["t"])
    with pytest.raises(pl.LockBusy):
        pl.acquire_lock(db, holder=sch.holder, stale_seconds=300, clock=lambda: NOW["t"])


# ── 场景 4：服务器错过 09:05 后重启（对账补跑，遵守窗口与"仅今日"） ───────────────

def test_reconcile_catches_up_within_window(db, sch, monkeypatch):
    fake_now = datetime(2026, 10, 9, 12, 0, 0, tzinfo=sm.TZ)
    monkeypatch.setattr(sm, "_local_now", lambda: fake_now)
    sch.reconcile()
    row = db.execute("SELECT * FROM pipeline_run WHERE job_type='daily' AND phase='pipeline'").fetchone()
    assert row is not None and row["status"] == "succeeded", "12:00<13:00 → 补跑今日"
    assert row["brief_date"] == "2026-10-09"

    # 13:00 后不再补（窗口过）
    db2_rows_before = db.execute("SELECT COUNT(*) c FROM pipeline_run").fetchone()["c"]
    fake_late = datetime(2026, 10, 9, 14, 30, 0, tzinfo=sm.TZ)
    monkeypatch.setattr(sm, "_local_now", lambda: fake_late)
    sch2 = sch  # 复用（今日 daily 已有成功行 → 不再触发）
    sch2.reconcile()
    assert db.execute("SELECT COUNT(*) c FROM pipeline_run").fetchone()["c"] == db2_rows_before

    # 昨日缺失永不自动补：换一天，无任何历史补跑行
    fake_next_day = datetime(2026, 10, 10, 12, 0, 0, tzinfo=sm.TZ)
    monkeypatch.setattr(sm, "_local_now", lambda: fake_next_day)
    before = db.execute("SELECT COUNT(*) c FROM pipeline_run WHERE brief_date='2026-10-09'"
                        " AND trigger_type='scheduled'").fetchone()["c"]
    sch.reconcile()
    after = db.execute("SELECT COUNT(*) c FROM pipeline_run WHERE brief_date='2026-10-09'"
                       " AND trigger_type='scheduled'").fetchone()["c"]
    assert before == after, "对账只看今日——不为历史日期自动补跑"


def test_slot_dedup_prevents_double_fire(db, sch, monkeypatch):
    """同日 slot 重复触发（进程内 misfire + 对账并发）只执行一次。"""
    fake_now = datetime(2026, 10, 9, 9, 6, 0, tzinfo=sm.TZ)
    monkeypatch.setattr(sm, "_local_now", lambda: fake_now)
    sch.fire("daily")
    sch.fire("daily")   # 立即重复触发
    assert sch._biz_calls["n"] == 1
    assert db.execute("SELECT COUNT(*) c FROM pipeline_run WHERE job_type='daily'"
                      " AND phase='pipeline'").fetchone()["c"] == 1


# ── 场景 5/6：DWS 延迟落数→补齐；同日修订 ────────────────────────────────────────

class FakeRunner:
    """watermark 探针造假账：max_day 可切换（延迟→补齐）。"""
    def __init__(self, max_day):
        self.max_day = max_day
        self.queries = 0

    def __call__(self, sql, params=None):
        self.queries += 1
        if "max(calmonth)" in sql.lower() or "max(" in sql.lower():
            return [{"max_day": self.max_day, "rows_": 5}]
        raise AssertionError(f"unexpected sql in probe test: {sql[:80]}")


@pytest.fixture()
def ts_service(monkeypatch):
    def make(max_day):
        runner = FakeRunner(max_day)
        calls = {"n": 0, "last": None}

        def fake_report(runner_, ctx):
            calls["n"] += 1
            calls["last"] = f"v{calls['n']}"
            return {"annual": {"a": calls["last"]}, "months": {"m": 1}, "centers": {"c": 1}}

        from insight import trend_service as tsm
        monkeypatch.setattr(tsm, "_report", fake_report)
        return TrendService(runner), runner, calls
    return make


def test_cache_not_ready_then_backfill(ts_service):
    as_of = date(2026, 10, 15)
    svc, runner, calls = ts_service("2026-09")      # 当月账未开（上月底）
    out = svc.target_overview(as_of)
    assert out["available"] is False and out["dataFreshness"]["ready"] is False
    assert len(svc._cache) == 0, "未就绪不落缓存"
    assert calls["n"] == 0, "未就绪不触发重查询"
    # DWS 补齐（当月账开出）
    runner.max_day = "2026-10"
    svc._probe.clear()                               # 越过 60s 探针负缓存（真实由 TTL 自然过期）
    out2 = svc.target_overview(as_of)
    assert out2["dataFreshness"]["ready"] is True and calls["n"] == 1
    assert any("2026-10" in "|".join(map(str, k)) for k in svc._cache), "缓存键含 effective 月"


def test_cache_same_day_revision_and_invalidate(ts_service):
    as_of = date(2026, 10, 15)
    svc, runner, calls = ts_service("2026-10")
    assert svc.target_overview(as_of)["annual"]["a"] == "v1"
    assert svc.target_overview(as_of)["annual"]["a"] == "v1" and calls["n"] == 1
    # 同日修订（月键不变内容变）——v1 钉住：文档化限制
    assert svc.target_overview(as_of)["annual"]["a"] == "v1" and calls["n"] == 1
    # 管理端缓存失效 → 重新计算拿到 v2
    assert svc.invalidate_cache() == 1
    assert svc.target_overview(as_of)["annual"]["a"] == "v2" and calls["n"] == 2


# ── 场景 7：未授权调用管理触发接口 ───────────────────────────────────────────────

def _http(port, method, path, body=None, headers=None):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}",
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", **(headers or {})},
                                 method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")


def test_admin_endpoint_auth_and_validation(tmp_path, db):
    from insight.api_main import make_server
    db_path = tmp_path / "t2.db"
    conn = open_db(db_path)
    srv = make_server(conn, host="127.0.0.1", port=0, admin_token="tok-1")
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        # 无 token / 错 token → 403（未授权）
        assert _http(port, "POST", "/admin/trigger", {"action": "daily_run"})[0] == 403
        assert _http(port, "POST", "/admin/trigger", {"action": "daily_run"},
                     {"X-Insight-Admin-Token": "wrong"})[0] == 403
        assert _http(port, "GET", "/admin/status")[0] == 403
        # 参数校验：未知 action / 越界 brief_date → 400
        s, b = _http(port, "POST", "/admin/trigger", {"action": "phase_scan"},
                     {"X-Insight-Admin-Token": "tok-1"})
        assert s == 400 and b["error"] == "BAD_ACTION"
        old = (date.today() - timedelta(days=3)).isoformat()
        s, b = _http(port, "POST", "/admin/trigger", {"action": "daily_run", "brief_date": old},
                     {"X-Insight-Admin-Token": "tok-1"})
        assert s == 400 and b["error"] == "BAD_BRIEF_DATE", "只允许今日/昨日（修正E）"
        # 合法入队 → 201 + 幂等去重
        s1, b1 = _http(port, "POST", "/admin/trigger", {"action": "daily_run", "by": "admin-prod"},
                        {"X-Insight-Admin-Token": "tok-1"})
        s2, b2 = _http(port, "POST", "/admin/trigger", {"action": "daily_run", "by": "admin-prod"},
                        {"X-Insight-Admin-Token": "tok-1"})
        assert s1 == 201 and s2 == 201 and b1["request_id"] == b2["request_id"], "pending 幂等"
        rows = conn.execute("SELECT * FROM trigger_queue").fetchall()
        assert len(rows) == 1 and rows[0]["requested_by"] == "admin-prod", "入队即审计行"
        # 状态接口（带 token）
        s, b = _http(port, "GET", "/admin/status", None, {"X-Insight-Admin-Token": "tok-1"})
        assert s == 200 and "first-final-wins" in b["freeze_note"], "诚实声明在状态面"
    finally:
        srv.shutdown()
        srv.server_close()
        conn.close()


# ── 场景 8：切换新旧调度器无双跑（shadow 不执行；同 slot live 唯一执行） ───────────

def test_shadow_mode_no_execution(db, sch, monkeypatch):
    fake_now = datetime(2026, 10, 9, 9, 6, 0, tzinfo=sm.TZ)
    monkeypatch.setattr(sm, "_local_now", lambda: fake_now)
    monkeypatch.setattr(sm, "SHADOW", True)
    sch.fire("daily")
    assert sch._biz_calls["n"] == 0, "shadow 只记账不执行"
    assert db.execute("SELECT COUNT(*) c FROM pipeline_lock").fetchone()["c"] == 0, "shadow 不抢锁"
    assert db.execute("SELECT status FROM pipeline_run WHERE phase='shadow'").fetchone()["status"] == "shadow"
    # 切换 live：同日再触发（不同 phase 不占同键）→ 恰好一次真实执行
    monkeypatch.setattr(sm, "SHADOW", False)
    sch.fire("daily")
    assert sch._biz_calls["n"] == 1
    assert db.execute("SELECT COUNT(*) c FROM pipeline_run WHERE phase='pipeline'").fetchone()["c"] == 1


# ── 队列领取原子性（修正B）：两个 scheduler 实例不会领到同一条 ─────────────────────

def test_queue_claim_atomic(db):
    r1, _ = pl.enqueue(db, action="cache_invalidate", brief_date=None, requested_by="a")
    a = pl.claim_next(db, claimed_by="s1")
    b = pl.claim_next(db, claimed_by="s2")
    assert a is not None and b is None, "第二条领取扑空"
    assert a["request_id"] == r1
    pl.finish_request(db, r1, status="done", note="x")
    assert db.execute("SELECT status FROM trigger_queue WHERE request_id=?", (r1,)).fetchone()["status"] == "done"
