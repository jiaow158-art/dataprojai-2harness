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

def _serve_runner(store, runner):
    srv = make_server(store.db, host="127.0.0.1", port=0, trend_runner=runner)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"

def _ins_event(db, event_id, key, score, created_at):
    db.execute(
        "INSERT INTO business_event (event_id,event_key,lifecycle,data_date,"
        "first_seen_date,last_seen_date,persist_days,detector,event_type,title,summary,"
        "severity,scope_json,period_json,facts_json,score,score_breakdown_json,metric,"
        "status,attribution_status,created_at,updated_at)"
        " VALUES (?,?,'active','2026-09-27','2026-09-26','2026-09-27',2,'region_sales',"
        "'sales_decline',?,'s','minor',?,'{\"类型\":\"月\"}','[]',?,'{}','yoy',"
        "'discovered','pending',?,?)",
        (event_id, key, f"{event_id} 业绩连续下滑",
         json.dumps({"范围": "瓷砖事业部", "组织节点": "华南营销中心"}, ensure_ascii=False),
         score, created_at, created_at))

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
    s.db.execute("INSERT INTO daily_brief VALUES ('2026-09-28','瓷砖事业部','final',0,"
                 "1000,1,'{}',0)")
    s.db.execute("INSERT INTO daily_brief_event VALUES ('2026-09-28','ev-b',1,80.0,"
                 "'minor','t','s','[]','sales_decline',2,'2026-09-26','active',1000)")
    s.db.commit()
    srv, base = _serve(s)
    try:
        st, rel = _get(f"{base}/api/insight/events/ev-a/related")
        assert st == 200
        assert [e["event_id"] for e in rel["sameType"]] == ["ev-b"]     # 同类型+排除自身
        assert [e["event_id"] for e in rel["sameRegion"]] == ["ev-b"]   # 同组织节点
        with pytest.raises(urllib.error.HTTPError) as e:
            _get(f"{base}/api/insight/events/ev-zz/related")
        assert e.value.code == 404

        st, act = _get(f"{base}/api/insight/events?state=active")
        assert st == 200
        assert act["briefDate"] == "2026-09-28"
        assert act["publishMinScore"] == RANKING["publish_min_score"]
        assert [e["event_id"] for e in act["events"]] == ["ev-b", "ev-a"]   # score 降序
        b, a = act["events"]
        assert b["publishedToday"] is True and b["rankToday"] == 1
        assert a["publishedToday"] is False and a["rankToday"] is None
        assert a["scoreGap"] == round(40.0 - RANKING["publish_min_score"], 1)   # -15.0
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
