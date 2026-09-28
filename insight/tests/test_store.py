# insight/tests/test_store.py
import sqlite3
from datetime import date
from insight.db import open_db
from insight.store import Store

def _store(tmp_path):
    return Store(open_db(tmp_path / "insight.db"))

def test_radar_run_roundtrip_with_watermark_detail(tmp_path):
    s = _store(tmp_path)
    run_id = s.insert_radar_run(detector="ar_risk", data_date="2026-09-27",
                                status="ran", findings_count=2,
                                watermark_detail="ready; effective=2026-09-27")
    row = s.db.execute("SELECT * FROM radar_run WHERE run_id=?", (run_id,)).fetchone()
    assert row["detector"] == "ar_risk" and row["error"] == "ready; effective=2026-09-27"

def test_insert_finding_and_late_flag(tmp_path):
    s = _store(tmp_path)
    fid = s.insert_finding(data_date="2026-09-27", detector="region_sales",
                           dim_keys={"anchor_type": "org_channel",
                                     "anchor_id": "华南|GD01", "channel": "GD01"},
                           metrics={"yoy_pct": -11.2}, norm_score=80, is_late=False)
    s.insert_finding(data_date="2026-09-27", detector="region_sales",
                     dim_keys={"anchor_type": "org_channel",
                               "anchor_id": "华南|GD01", "channel": "GD01"},
                     metrics={"yoy_pct": -11.5}, norm_score=85, is_late=True)
    rows = s.db.execute(
        "SELECT is_late, metrics_json FROM detector_finding "
        "WHERE data_date='2026-09-27' ORDER BY rowid").fetchall()
    assert rows[0]["is_late"] == 0 and rows[1]["is_late"] == 1

def test_findings_for_date_excludes_late(tmp_path):
    s = _store(tmp_path)
    s.insert_finding("2026-09-27", "region_sales",
                     {"anchor_type": "org_channel", "anchor_id": "A|GD01", "channel": "GD01"},
                     {"yoy_pct": -11.2}, 80, is_late=False)
    s.insert_finding("2026-09-27", "gross_margin",
                     {"anchor_type": "org_channel", "anchor_id": "B|GD02", "channel": "GD02"},
                     {"delta_pct": -2.5}, 60, is_late=True)
    got = s.findings_for_date("2026-09-27")          # freeze 用：不含晚到
    assert [f["detector"] for f in got] == ["region_sales"]
    got_all = s.findings_for_date("2026-09-27", include_late=True)   # 事件延续用
    assert len(got_all) == 2

def test_active_episode_lookup(tmp_path):
    s = _store(tmp_path)
    s.upsert_episode(event_key="K1", event_id="ev-1", data_date="2026-09-25",
                     detector="region_sales", event_type="sales_decline",
                     title="t", summary="s", severity="minor",
                     scope={"范围": "瓷砖事业部"}, period={"类型": "月"},
                     facts=[], score=60.0, breakdown={}, metric="yoy",
                     dim_keys={"anchor_type": "org_channel", "anchor_id": "A|GD01",
                               "channel": "GD01"})
    ep = s.active_episode("K1")
    assert ep["event_id"] == "ev-1" and ep["lifecycle"] == "active"
    assert s.active_episode("K-nope") is None
