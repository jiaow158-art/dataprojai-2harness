import json
import threading
import urllib.request
import pytest
from datetime import date, timedelta
from insight.api_main import make_server
from insight.db import open_db
from insight.merge_rank import RANKING
from insight.replay_ctx import shift_month
from insight.store import Store
from insight.brief import freeze_brief

@pytest.fixture
def base(tmp_path):
    s = Store(open_db(tmp_path / "i.db"))
    s.insert_finding("2026-09-27", "region_sales",
                     {"anchor_type": "org_channel", "anchor_id": "华南|GD01",
                      "channel": "GD01"},
                     {"yoy_pct": -11.2}, 85, is_late=False)
    freeze_brief(s, "2026-09-28", "2026-09-27",
                 [{"detector": "region_sales", "ready": True}])
    srv = make_server(s.db, host="127.0.0.1", port=0)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()

def _get(url):
    with urllib.request.urlopen(url, timeout=5) as r:
        return r.status, json.loads(r.read().decode("utf-8"))

def _serve(store):
    srv = make_server(store.db, host="127.0.0.1", port=0)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"

def test_daily_today(base):
    st, body = _get(f"{base}/api/insight/daily")
    assert st == 200 and body["briefDate"] == "2026-09-28"
    assert body["eventCount"] == 1
    ev = body["events"][0]
    assert ev["title"].endswith("业绩连续下滑") and "雷达" not in ev["title"]
    assert ev["severity"] in ("major", "minor")
    assert ev["eventKey"] and ev["metric"] == "yoy"    # 契约补全：回查 business_event，非 None

def test_daily_historical_reads_snapshots(base):
    st, body = _get(f"{base}/api/insight/daily?date=2026-09-28")
    assert st == 200 and body["events"][0]["eventId"]            # 快照还原（P0-2）

def test_daily_historical_snapshot_survives_event_evolution(tmp_path):
    """P0-2 加固：day1 发布后事件在 day2 演进（同锚更高分新 finding）→
    business_event 当前态前移，但 ?date=day1 读到的仍是 day1 快照（发布面不漂移）。"""
    s = Store(open_db(tmp_path / "i.db"))
    anchor = {"anchor_type": "org_channel", "anchor_id": "华南|GD01", "channel": "GD01"}
    s.insert_finding("2026-09-27", "region_sales", anchor, {"yoy_pct": -11.2}, 85,
                     is_late=False)
    freeze_brief(s, "2026-09-28", "2026-09-27", [{"detector": "region_sales", "ready": True}])
    snap1 = dict(s.db.execute("SELECT * FROM daily_brief_event"
                              " WHERE brief_date='2026-09-28'").fetchone())
    s.insert_finding("2026-09-28", "region_sales", anchor, {"yoy_pct": -25.0}, 95,
                     is_late=False)                 # 同锚新 finding：persist 1→2、norm 85→95
    freeze_brief(s, "2026-09-29", "2026-09-28", [{"detector": "region_sales", "ready": True}])
    cur = s.db.execute("SELECT score FROM business_event WHERE event_id=?",
                       (snap1["event_id"],)).fetchone()
    assert cur["score"] != snap1["score_snapshot"]  # 事件确实演进（64.7 → 68.7）
    srv, base = _serve(s)
    try:
        st, body = _get(f"{base}/api/insight/daily?date=2026-09-28")
        assert st == 200 and body["events"][0]["eventId"] == snap1["event_id"]
        assert body["events"][0]["score"] == snap1["score_snapshot"]   # day1 快照原值
        assert body["events"][0]["score"] != cur["score"]              # 不随当前态漂移
    finally:
        srv.shutdown()

def test_event_detail(base):
    st, daily = _get(f"{base}/api/insight/daily")
    eid = daily["events"][0]["eventId"]
    st, body = _get(f"{base}/api/insight/events/{eid}")
    assert st == 200 and body["event"]["event_id"] == eid
    assert body["attribution"]["status"] == "pending"            # 尚未归因
    assert body["evidence"][0]["detector"] == "region_sales"     # finding 来源可溯

def test_timeline_and_health_and_404(base):
    st, body = _get(f"{base}/api/insight/timeline?days=30")
    assert st == 200 and len(body) == 1
    st, body = _get(f"{base}/api/insight/health")
    assert st == 200 and body["ok"] is True
    with pytest.raises(urllib.error.HTTPError) as e:
        _get(f"{base}/api/insight/nope")
    assert e.value.code == 404

def test_daily_not_ready_day_not_whitewashed(tmp_path):
    s = Store(open_db(tmp_path / "i.db"))
    s.insert_finding("2026-09-27", "region_sales",
                     {"anchor_type": "org_channel", "anchor_id": "华南|GD01",
                      "channel": "GD01"},
                     {"yoy_pct": -11.2}, 85, is_late=False)
    freeze_brief(s, "2026-09-28", "2026-09-27",
                 [{"detector": "region_sales", "ready": False}])  # fail-closed
    srv, base = _serve(s)
    try:
        st, body = _get(f"{base}/api/insight/daily")
        assert st == 200
        assert body["dataFreshness"]["overall"] == "not_ready"   # 绝不冒充 ready
        assert body["eventCount"] == 0
    finally:
        srv.shutdown()

def test_event_evidence_not_cross_polluted(tmp_path):
    s = Store(open_db(tmp_path / "i.db"))
    s.insert_finding("2026-09-27", "region_sales",
                     {"anchor_type": "org_channel", "anchor_id": "华南|GD01",
                      "channel": "GD01"}, {"yoy_pct": -11.2}, 85, is_late=False)
    s.insert_finding("2026-09-27", "region_sales",
                     {"anchor_type": "org_channel", "anchor_id": "华北|HB02",
                      "channel": "HB02"}, {"yoy_pct": -22.5}, 85, is_late=False)
    freeze_brief(s, "2026-09-28", "2026-09-27",
                 [{"detector": "region_sales", "ready": True}])
    srv, base = _serve(s)
    try:
        st, daily = _get(f"{base}/api/insight/daily")
        assert st == 200 and daily["eventCount"] == 2
        eid = {e["title"]: e["eventId"] for e in daily["events"]}
        st, a = _get(f"{base}/api/insight/events/{eid['华南|GD01 业绩连续下滑']}")
        st, b = _get(f"{base}/api/insight/events/{eid['华北|HB02 业绩连续下滑']}")
        assert len(a["evidence"]) == 1
        assert a["evidence"][0]["metrics"]["yoy_pct"] == -11.2    # 只含本事件 finding
        assert len(b["evidence"]) == 1
        assert b["evidence"][0]["metrics"]["yoy_pct"] == -22.5
    finally:
        srv.shutdown()

def test_timeline_days_param_validation(base):
    for bad in ("abc", "-1"):
        with pytest.raises(urllib.error.HTTPError) as e:
            _get(f"{base}/api/insight/timeline?days={bad}")
        assert e.value.code == 400                                 # 参数非法=400 非 500


# —— M-i5：trend / health-score / related / active（DWS 编排 + db-only 扩展）——

class _CountingRunner:
    """fake DWS runner：固定行 + 调用计数（缓存命中断言用）。"""
    def __init__(self, rows):
        self.rows = rows
        self.calls = 0
    def __call__(self, sql, params=None):
        self.calls += 1
        return self.rows

class _DispatchRunner:
    """fake DWS runner：按 SQL 分派 + 调用计数。"""
    def __init__(self, fn):
        self.fn = fn
        self.calls = 0
    def __call__(self, sql, params=None):
        self.calls += 1
        return self.fn(sql, params)

def _serve_runner(store, runner):
    srv = make_server(store.db, host="127.0.0.1", port=0, trend_runner=runner)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"

def _ins_event(db, event_id, key, score, created_at, etype="sales_decline",
               org="华南营销中心", lifecycle="active", resolved_at=None,
               first="2026-09-26", sev="minor"):
    db.execute(
        "INSERT INTO business_event (event_id,event_key,lifecycle,data_date,"
        "first_seen_date,last_seen_date,persist_days,detector,event_type,title,summary,"
        "severity,scope_json,period_json,facts_json,score,score_breakdown_json,metric,"
        "status,attribution_status,created_at,updated_at,resolved_at)"
        " VALUES (?,?,?,'2026-09-27',?,'2026-09-27',2,'region_sales',"
        "?,?,'s',?,?,'{\"类型\":\"月\"}','[]',?,'{}','yoy',"
        "'discovered','pending',?,?,?)",
        (event_id, key, lifecycle, first, etype, f"{event_id} 业绩连续下滑", sev,
         json.dumps({"范围": "瓷砖事业部", "组织节点": org}, ensure_ascii=False),
         score, created_at, created_at, resolved_at))

def test_trend_endpoint_cached_and_validated(tmp_path):
    s = Store(open_db(tmp_path / "i.db"))
    s.insert_finding("2026-09-27", "region_sales",
                     {"anchor_type": "org_channel", "anchor_id": "华南营销中心|GD01",
                      "channel": "GD01"},
                     {"yoy_pct": -11.2}, 85, is_late=False)
    freeze_brief(s, "2026-09-28", "2026-09-27",
                 [{"detector": "region_sales", "ready": True}])
    eid = s.db.execute("SELECT event_id FROM business_event").fetchone()["event_id"]
    runner = _CountingRunner([{"month": "2026-08", "cur_wan": 100.0, "prev_wan": 120.0},
                              {"month": "2026-09", "cur_wan": 90.0, "prev_wan": 110.0}])
    srv, base = _serve_runner(s, runner)
    try:
        st, body = _get(f"{base}/api/insight/events/{eid}/trend")
        assert st == 200 and body["kind"] == "month_compare"
        assert body["anchor_id"] == "华南营销中心|GD01"
        assert body["series"][0] == {"month": "2026-08", "cur": 100.0, "prev": 120.0}
        assert runner.calls == 1
        st, again = _get(f"{base}/api/insight/events/{eid}/trend")
        assert st == 200 and again == body and runner.calls == 1   # 缓存命中不重查 DWS
        for bad in ("25", "abc", "0"):
            with pytest.raises(urllib.error.HTTPError) as e:
                _get(f"{base}/api/insight/events/{eid}/trend?months={bad}")
            assert e.value.code == 400                              # BAD_MONTHS
        with pytest.raises(urllib.error.HTTPError) as e:
            _get(f"{base}/api/insight/events/ev-nope/trend")
        assert e.value.code == 404
    finally:
        srv.shutdown()

def _seed_region_event(s):
    s.insert_finding("2026-09-27", "region_sales",
                     {"anchor_type": "org_channel", "anchor_id": "华南营销中心|GD01",
                      "channel": "GD01"},
                     {"yoy_pct": -11.2}, 85, is_late=False)
    freeze_brief(s, "2026-09-28", "2026-09-27",
                 [{"detector": "region_sales", "ready": True}])
    return s.db.execute("SELECT event_id FROM business_event").fetchone()["event_id"]

class _ConnDroppedRunner:
    """连接级失败形态：首调抛 SSL 掐断且 _conn=None（_recover 已弃连接）→ 允许重试。"""
    def __init__(self, rows):
        self.rows = rows
        self.calls = 0
        self._conn = None
    def __call__(self, sql, params=None):
        self.calls += 1
        if self.calls == 1:
            raise RuntimeError("SSL connection has been closed unexpectedly")
        return self.rows

class _TimeoutRunner:
    """非连接级失败形态：语句超时 rollback 成功、连接仍活（_conn 非 None）→ 照抛。"""
    def __init__(self):
        self.calls = 0
        self._conn = object()
    def __call__(self, sql, params=None):
        self.calls += 1
        raise RuntimeError("canceling statement due to statement timeout")

def test_trend_retries_once_on_discarded_connection(tmp_path):
    """生产冒烟回归：空闲后首个 trend 请求吃到被服务端掐断的缓存连接（_conn 已弃）
    → 重建后原样重跑一次，用户首请求不吃 500。"""
    s = Store(open_db(tmp_path / "i.db"))
    eid = _seed_region_event(s)
    runner = _ConnDroppedRunner([{"month": "2026-08", "cur_wan": 100.0, "prev_wan": 120.0}])
    srv, base = _serve_runner(s, runner)
    try:
        st, body = _get(f"{base}/api/insight/events/{eid}/trend")
        assert st == 200 and body["kind"] == "month_compare"
        assert runner.calls == 2                       # 弃连接→重试一次后成功
        st, again = _get(f"{base}/api/insight/events/{eid}/trend")
        assert st == 200 and again == body and runner.calls == 2   # 成功后照常缓存
    finally:
        srv.shutdown()

def test_trend_no_retry_when_connection_alive(tmp_path):
    """语句超时等非连接级失败：_conn 仍在 → 不重试（调用计数 1），首请求如实 500。"""
    s = Store(open_db(tmp_path / "i.db"))
    eid = _seed_region_event(s)
    runner = _TimeoutRunner()
    srv, base = _serve_runner(s, runner)
    try:
        with pytest.raises(urllib.error.HTTPError) as e:
            _get(f"{base}/api/insight/events/{eid}/trend")
        assert e.value.code == 500
        assert runner.calls == 1                       # 连接未弃→未重试
    finally:
        srv.shutdown()

def test_health_score_endpoint(tmp_path):
    s = Store(open_db(tmp_path / "i.db"))
    as_of = date.today() - timedelta(days=1)                    # 端点口径：今天-1
    ym, prev_ym = as_of.strftime("%Y-%m"), shift_month(as_of, -1).strftime("%Y-%m")
    def run(sql, params=None):
        if "ct_sales_performance_t" in sql:                     # sales 环（ct 表）
            return [{"month": "m1", "cur_amt": 90.0, "ly_amt": 100.0},
                    {"month": "m2", "cur_amt": 88.0, "ly_amt": 100.0}]
        if "dm_ar_analysis_rpt_f" in sql:                       # ar 环两月快照
            return [{"calmonth": prev_ym, "nat90": 41.0, "total": 100.0},
                    {"calmonth": ym, "nat90": 38.0, "total": 100.0}]
        return []                                               # mix/目标表空 → 降级
    srv, base = _serve_runner(s, run)
    try:
        st, body = _get(f"{base}/api/insight/health-score")
        assert st == 200 and body["as_of"] == as_of.isoformat()
        assert [r["key"] for r in body["rings"]] == ["sales", "margin", "ar", "inventory"]
        ar = body["rings"][2]
        assert ar["available"] is True and ar["score"] == 62.0    # 100 − 38%（T5 公式）
        assert body["rings"][0]["available"] is True
        assert body["rings"][1]["available"] is False             # mix 空 → 诚实降级
        assert body["rings"][3]["available"] is False             # 库存未接入
        assert body["target"] is None                             # 目标表空
    finally:
        srv.shutdown()

def test_dws_unavailable_503_local_isolation(tmp_path):
    s = Store(open_db(tmp_path / "i.db"))
    srv, base = _serve(s)                       # 无 trend_runner（进程无 DWS_PASSWORD 形态）
    try:
        with pytest.raises(urllib.error.HTTPError) as e:
            _get(f"{base}/api/insight/health-score")
        assert e.value.code == 503
        assert json.loads(e.value.read())["error"] == "DWS_UNAVAILABLE"
        with pytest.raises(urllib.error.HTTPError) as e:
            _get(f"{base}/api/insight/events/ev-x/trend")
        assert e.value.code == 503
        st, body = _get(f"{base}/api/insight/events?state=active")   # db-only 不受影响
        assert st == 200 and body["events"] == []
        with pytest.raises(urllib.error.HTTPError) as e:
            _get(f"{base}/api/insight/events?state=closed")
        assert e.value.code == 400                                  # BAD_STATE
    finally:
        srv.shutdown()

def test_related_and_active_events(tmp_path):
    s = Store(open_db(tmp_path / "i.db"))
    _ins_event(s.db, "ev-a", "k-a", 40.0, 100)
    _ins_event(s.db, "ev-b", "k-b", 80.0, 200)
    _ins_event(s.db, "ev-c", "k-c", 80.0, 150)   # 与 ev-b 同分：tie-break updated_at desc
    s.db.execute("INSERT INTO daily_brief VALUES ('2026-09-28','瓷砖事业部','final',0,"
                 "1000,1,'{}',0)")
    s.db.execute("INSERT INTO daily_brief_event VALUES ('2026-09-28','ev-b',1,80.0,"
                 "'minor','t','s','[]','sales_decline',2,'2026-09-26','active',1000)")
    s.db.commit()
    srv, base = _serve(s)
    try:
        st, rel = _get(f"{base}/api/insight/events/ev-a/related")
        assert st == 200
        assert [e["event_id"] for e in rel["sameType"]] == ["ev-b", "ev-c"]  # 同类型+排除自身
        assert [e["event_id"] for e in rel["sameRegion"]] == ["ev-b", "ev-c"]
        with pytest.raises(urllib.error.HTTPError) as e:
            _get(f"{base}/api/insight/events/ev-zz/related")
        assert e.value.code == 404

        st, act = _get(f"{base}/api/insight/events?state=active")
        assert st == 200
        assert act["briefDate"] == "2026-09-28"
        assert act["publishMinScore"] == RANKING["publish_min_score"]
        assert [e["event_id"] for e in act["events"]] == ["ev-b", "ev-c", "ev-a"]
        b, c, a = act["events"]
        assert b["publishedToday"] is True and b["rankToday"] == 1
        assert c["publishedToday"] is False and c["rankToday"] is None
        assert a["publishedToday"] is False and a["rankToday"] is None
        assert a["scoreGap"] == round(40.0 - RANKING["publish_min_score"], 1)   # -15.0
    finally:
        srv.shutdown()

def test_related_not_truncated_by_recent_window(tmp_path):
    """I-1 回归：105 条更新的异类型事件把 ev-b 挤出"全局最新 100"窗口——
    按桶查询仍须配到 ev-b（旧全表 LIMIT 100 窗口实现会漏配）。"""
    s = Store(open_db(tmp_path / "i.db"))
    for i in range(105):
        _ins_event(s.db, f"ev-f{i}", f"kf{i}", 10.0, 300 + i,
                   etype="margin_drop", org="华东营销中心")
    _ins_event(s.db, "ev-a", "k-a", 40.0, 100)
    _ins_event(s.db, "ev-b", "k-b", 80.0, 200)
    s.db.commit()
    srv, base = _serve(s)
    try:
        st, rel = _get(f"{base}/api/insight/events/ev-a/related")
        assert st == 200
        assert [e["event_id"] for e in rel["sameType"]] == ["ev-b"]     # 窗口外仍可配
        assert [e["event_id"] for e in rel["sameRegion"]] == ["ev-b"]
    finally:
        srv.shutdown()

def test_health_all_degraded_not_cached_normal_cached(tmp_path):
    """I-2：三数据环全降级（疑似 DWS 故障）不落缓存→下次重查；正常结果缓存命中。"""
    s = Store(open_db(tmp_path / "i.db"))
    degraded = _DispatchRunner(lambda sql, p: [])
    srv, base = _serve_runner(s, degraded)
    try:
        st, body = _get(f"{base}/api/insight/health-score")
        assert st == 200 and all(not r["available"] for r in body["rings"][:3])
        n1 = degraded.calls
        st, body = _get(f"{base}/api/insight/health-score")
        assert st == 200 and degraded.calls > n1                # 全降级不缓存→重查
    finally:
        srv.shutdown()

    as_of = date.today() - timedelta(days=1)
    ym, prev_ym = as_of.strftime("%Y-%m"), shift_month(as_of, -1).strftime("%Y-%m")
    def healthy(sql, params=None):                              # 三数据环全 available
        if "ct_sales_performance_t" in sql:
            return [{"month": "m1", "cur_amt": 90.0, "ly_amt": 100.0},
                    {"month": "m2", "cur_amt": 88.0, "ly_amt": 100.0}]
        if "gross_profit_after_sharing" in sql and "calmonth = ANY" in sql:
            return [{"month": "a", "gp": 1000.0, "net_amt": 10000.0},
                    {"month": "b", "gp": 950.0, "net_amt": 10000.0},
                    {"month": "c", "gp": 900.0, "net_amt": 10000.0}]
        if "dm_ar_analysis_rpt_f" in sql:
            return [{"calmonth": prev_ym, "nat90": 41.0, "total": 100.0},
                    {"calmonth": ym, "nat90": 38.0, "total": 100.0}]
        return []
    good = _DispatchRunner(healthy)
    srv, base = _serve_runner(s, good)
    try:
        st, body = _get(f"{base}/api/insight/health-score")
        assert st == 200 and all(r["available"] for r in body["rings"][:3])
        n1 = good.calls
        st, body = _get(f"{base}/api/insight/health-score")
        assert st == 200 and good.calls == n1                    # 正常结果缓存命中
    finally:
        srv.shutdown()

def test_daily_detail_attribution_done_and_resolved(tmp_path):
    """M-3 补强：归因 done 的当前态回读（daily 摘要/generatedAt）+ resolved 事件 resolved_at。"""
    s = Store(open_db(tmp_path / "i.db"))
    s.insert_finding("2026-09-27", "region_sales",
                     {"anchor_type": "org_channel", "anchor_id": "华南|GD01",
                      "channel": "GD01"},
                     {"yoy_pct": -11.2}, 85, is_late=False)
    freeze_brief(s, "2026-09-28", "2026-09-27",
                 [{"detector": "region_sales", "ready": True}])
    eid = s.db.execute("SELECT event_id FROM business_event").fetchone()["event_id"]
    s.db.execute("UPDATE business_event SET attribution_summary='归因摘要',"
                 " attribution_status='done', attribution_generated_at=123"
                 " WHERE event_id=?", (eid,))
    _ins_event(s.db, "ev-r", "k-r", 70.0, 50, lifecycle="resolved", resolved_at=123)
    s.db.commit()
    srv, base = _serve(s)
    try:
        st, body = _get(f"{base}/api/insight/daily?date=2026-09-28")
        assert st == 200
        ev = body["events"][0]
        assert ev["attributionSummary"] == "归因摘要"           # 归因当前态回读
        assert ev["attributionStatus"] == "done"
        st, d = _get(f"{base}/api/insight/events/{eid}")
        assert st == 200 and d["attribution"]["generatedAt"] == 123
        st, d = _get(f"{base}/api/insight/events/ev-r")
        assert st == 200 and d["event"]["lifecycle"] == "resolved"
        assert d["event"]["resolved_at"] == 123                 # resolve 时点透出
    finally:
        srv.shutdown()

def test_daily_data_date_and_attribution_fields(base):
    st, body = _get(f"{base}/api/insight/daily?date=2026-09-28")
    assert st == 200 and body["dataDate"] == "2026-09-27"       # 数据日=发布日-1
    ev = body["events"][0]
    assert ev["attributionStatus"] == "pending" and ev["attributionSummary"] is None
    st, d = _get(f"{base}/api/insight/events/{ev['eventId']}")
    assert st == 200
    assert d["event"]["resolved_at"] is None                    # 尚未 resolve
    assert d["attribution"]["generatedAt"] is None              # 尚未归因


# —— M-i6 事件中心：state=all 统计口径（D-e5/D-e6，统计全在服务端）——

def test_event_center_summary_windows_and_trend(tmp_path):
    """窗口（D-e6）：近30=[today-29,today]=[09-01,09-30]、前30=[today-59,today-30]=
    [08-02,08-31]（含界不重叠）；分布=全量（含窗口外旧发与已解除）。
    种子日期已按窗口核算配平：prev 事件 08-20（前窗内）、旧发 07-30（两窗外）、
    ev-r2 解除日 08-31（前窗尾）——计划稿 09-05/08-26/09-01 分别落错近窗/前窗/近窗。"""
    from insight.api_main import _event_center
    db = open_db(tmp_path / "ec.db")
    today = date(2026, 9, 30)
    # 近30天新发 3（1 major / 2 minor，其中 1 target_gap）；前30天 1（minor）；两窗外旧发 1
    _ins_event(db, "ev-new1", "k-n1", 90.0, 100, first="2026-09-28", sev="major")
    _ins_event(db, "ev-new2", "k-n2", 60.0, 100, first="2026-09-20")
    _ins_event(db, "ev-new3", "k-n3", 60.0, 100, first="2026-09-10",
               etype="target_gap")
    _ins_event(db, "ev-prev1", "k-p1", 60.0, 100, first="2026-08-20",
               etype="ar_overdue")
    _ins_event(db, "ev-old", "k-old", 60.0, 100, first="2026-07-30",
               etype="margin_drop")
    # 已解除：解除日近窗 1、前窗尾 1（first 均在两窗外，不进新发卡分母）
    _ins_event(db, "ev-r1", "k-r1", 60.0, 100, first="2026-08-01",
               lifecycle="resolved", resolved_at="2026-09-15")
    _ins_event(db, "ev-r2", "k-r2", 60.0, 100, first="2026-07-01",
               lifecycle="resolved", resolved_at="2026-08-31")
    p = _event_center(db, today)
    s = p["summary"]
    assert s["total"] == {"count": 3, "prevCount": 1, "delta": 200}
    assert s["major"]["count"] == 1 and s["major"]["delta"] is None   # 前窗 0 → delta None
    assert s["minor"]["count"] == 2 and s["minor"]["prevCount"] == 1
    assert s["targetGap"]["count"] == 1
    assert s["resolved"] == {"count": 1, "prevCount": 1, "delta": 0}
    # trend：30 点补零、首点=2026-09-01、09-28 只有 ev-new1（major）
    assert len(p["trend"]["points"]) == 30
    assert p["trend"]["points"][0]["date"] == "2026-09-01"
    d28 = next(x for x in p["trend"]["points"] if x["date"] == "2026-09-28")
    assert d28 == {"date": "2026-09-28", "total": 1, "major": 1, "minor": 0}
    assert all(x["total"] == 0 for x in p["trend"]["points"]
               if x["date"] == "2026-09-03")                          # 空日补零
    # 分布=全量（7 事件全计，含两窗外旧发与已解除）
    assert {d["key"]: d["count"] for d in p["eventTypeDistribution"]}["sales_decline"] == 4
    assert {d["key"]: d["count"] for d in p["lifecycleDistribution"]} == {"active": 5, "resolved": 2}

def test_event_center_late_badge_and_org_parse_and_state_branch(tmp_path):
    """端点级：state=all 200 + late 派生（同 event_key 的 is_late finding）+ org 解析；
    state=active 契约形状不动；state 非 active/all → 400 BAD_STATE（M-i5 语义保留）。"""
    from insight.merge_rank import event_key_of
    s = Store(open_db(tmp_path / "ec2.db"))
    dk = {"anchor_type": "org_channel", "anchor_id": "粤东运营中心|GD03", "channel": "GD03"}
    _ins_event(s.db, "ev-l1", event_key_of({"dim_keys": dk}), 70.0, 100,
               first="2026-09-28", org="粤东运营中心")
    # 晚到 finding：与 ev-l1 同 event_key 且 is_late=1 → late Badge 派生命中
    s.db.execute("INSERT INTO detector_finding (finding_id,data_date,detector,dim_keys_json,"
                 "metrics_json,norm_score,threshold_passed,is_late) VALUES"
                 "('f-late','2026-09-29','region_sales',?,'{}',50,1,1)",
                 (json.dumps(dk, ensure_ascii=False),))
    s.db.commit()
    srv, base = _serve(s)
    try:
        st, body = _get(f"{base}/api/insight/events?state=all")
        assert st == 200 and body["truncated"] is False
        ev1 = body["events"][0]
        assert ev1["late"] is True and ev1["org"] == "粤东运营中心"
        st, act = _get(f"{base}/api/insight/events?state=active")
        assert st == 200
        assert set(act.keys()) >= {"briefDate", "publishMinScore", "events"}   # 契约形状不动
        with pytest.raises(urllib.error.HTTPError) as e:
            _get(f"{base}/api/insight/events?state=xyz")
        assert e.value.code == 400
    finally:
        srv.shutdown()

def test_event_center_third_value_defense(tmp_path):
    """第三值防御：severity 出现 major/minor 之外的值（如 critical）不炸——
    计入 summary total 与 trend total 不丢；trend 点仍只输出 total/major/minor；
    lifecycle 第三值计入 lc 但不进 lifecycleDistribution 输出。"""
    from insight.api_main import _event_center
    db = open_db(tmp_path / "ec3.db")
    _ins_event(db, "ev-crit", "k-crit", 60.0, 100, first="2026-09-12", sev="critical")
    p = _event_center(db, date(2026, 9, 30))          # 无守卫时此处 KeyError → 端点 500
    assert p["summary"]["total"]["count"] == 1        # 第三值计入 total 不丢
    d12 = next(x for x in p["trend"]["points"] if x["date"] == "2026-09-12")
    assert d12 == {"date": "2026-09-12", "total": 1, "major": 0, "minor": 0}
    assert {d["key"]: d["count"] for d in p["lifecycleDistribution"]} == {"active": 1, "resolved": 0}

def test_event_center_truncates_at_505(tmp_path):
    """500 截断正例：505 条 → truncated=True、events 恰 500（截断集口径，docstring 已披露）。"""
    from insight.api_main import _event_center
    db = open_db(tmp_path / "ec4.db")
    for i in range(505):
        _ins_event(db, f"ev-t{i}", f"kt{i}", 10.0, i, first="2026-09-01")
    db.commit()
    p = _event_center(db, date(2026, 9, 30))
    assert p["truncated"] is True
    assert len(p["events"]) == 500

def test_event_center_org_display_normalization(tmp_path):
    """展示归一（不动数据/锚点/event_key）：组织节点存的是锚点串——
    影响范围列取首段；BU 级首段短名"瓷砖"回显范围字段"瓷砖事业部"；
    无竖线（粤东运营中心）原样直出。"""
    from insight.api_main import _event_center
    db = open_db(tmp_path / "ec5.db")
    _ins_event(db, "ev-bu", "k-bu", 60.0, 100, first="2026-09-12", org="瓷砖|nat90")
    _ins_event(db, "ev-plain", "k-plain", 60.0, 100, first="2026-09-13",
               org="粤东运营中心")
    p = _event_center(db, date(2026, 9, 30))
    by_id = {e["event_id"]: e["org"] for e in p["events"]}
    assert by_id["ev-bu"] == "瓷砖事业部"          # 锚点串首段"瓷砖"→范围字段
    assert by_id["ev-plain"] == "粤东运营中心"     # 无竖线原样
