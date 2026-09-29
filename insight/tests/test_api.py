import json
import threading
import urllib.request
import pytest
from insight.api_main import make_server
from insight.db import open_db
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
