# insight/tests/test_brief.py
from insight.db import open_db
from insight.store import Store
from insight.brief import freeze_brief

def _seed(tmp_path, findings, data_date="2026-09-27"):
    s = Store(open_db(tmp_path / "i.db"))
    for f in findings:
        s.insert_finding(data_date, f["detector"], f["dim_keys"],
                         f.get("metrics", {"yoy_pct": -11.2}), f["norm_score"],
                         is_late=f.get("is_late", False))
    return s

_FI = {"detector": "region_sales", "norm_score": 85,
       "dim_keys": {"anchor_type": "org_channel", "anchor_id": "华南|GD01",
                    "channel": "GD01"}, "metrics": {"yoy_pct": -11.2}}

def test_freeze_writes_brief_and_snapshots(tmp_path):
    s = _seed(tmp_path, [_FI])
    out = freeze_brief(s, brief_date="2026-09-28", data_date="2026-09-27",
                       freshness=[{"detector": "region_sales", "ready": True,
                                   "effective_data_date": "2026-09-27",
                                   "checked_at": "2026-09-28T09:00:00"}])
    assert out["status"] == "final" and out["event_count"] == 1
    brief = s.db.execute("SELECT * FROM daily_brief WHERE brief_date='2026-09-28'").fetchone()
    assert brief["status"] == "final"
    snap = s.db.execute("SELECT * FROM daily_brief_event").fetchone()
    assert snap["rank"] == 1 and snap["event_type_snapshot"] == "sales_decline"
    assert snap["persist_days_snapshot"] == 1 and snap["lifecycle_snapshot"] == "active"

def test_late_finding_not_in_snapshot_but_episode_continues(tmp_path):
    late = {**_FI, "is_late": True, "norm_score": 90}
    s = _seed(tmp_path, [late])
    out = freeze_brief(s, "2026-09-28", "2026-09-27",
                       [{"detector": "region_sales", "ready": True}])
    assert out["event_count"] == 0                       # 晚到不进当日榜（P0-3）
    rows = s.db.execute("SELECT COUNT(*) c FROM daily_brief_event").fetchone()
    assert rows["c"] == 0
    active = s.db.execute(
        "SELECT COUNT(*) c FROM business_event WHERE lifecycle='active'").fetchone()
    assert active["c"] == 1   # 晚到 finding 仍延续事件生命周期——update_episodes 用 include_late 全集

def test_freeze_idempotent_same_day_rerun(tmp_path):
    s = _seed(tmp_path, [_FI])
    _ok = [{"detector": "region_sales", "ready": True}]
    freeze_brief(s, "2026-09-28", "2026-09-27", _ok)
    freeze_brief(s, "2026-09-28", "2026-09-27", _ok)     # 重跑不翻倍不洗牌
    rows = s.db.execute("SELECT COUNT(*) c FROM daily_brief_event").fetchone()
    assert rows["c"] == 1

def test_not_ready_when_no_radar_ready(tmp_path):
    s = _seed(tmp_path, [_FI])
    out = freeze_brief(s, "2026-09-28", "2026-09-27",
                       [{"detector": "region_sales", "ready": False}])
    assert out["status"] == "not_ready"                  # 数据未就绪≠无异常

def test_empty_freshness_is_not_ready(tmp_path):
    s = _seed(tmp_path, [_FI])
    out = freeze_brief(s, "2026-09-28", "2026-09-27", [])   # 空=无就绪信息
    assert out["status"] == "not_ready"                     # fail-closed：不得假平安发布
    assert s.db.execute(
        "SELECT COUNT(*) c FROM daily_brief_event").fetchone()["c"] == 0
    assert s.db.execute(
        "SELECT COUNT(*) c FROM business_event").fetchone()["c"] == 0   # 事件状态完全不动
