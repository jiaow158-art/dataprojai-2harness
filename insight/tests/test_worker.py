# insight/tests/test_worker.py
from datetime import datetime
from insight.db import open_db
from insight.store import Store
from insight.worker_main import run_day

def test_run_day_happy_path_all_persisted(tmp_path):
    s = Store(open_db(tmp_path / "i.db"))
    def fake_runner_spec(name):
        def run(sql, params=None):
            if "ct_sales_performance_t" in sql:
                months = [f"{p[:4]}-{p[4:6]}" for p in params["month_ends"]]
                # cur/ly 差 1000 万→delta_wan=1000→norm_score=75→brief 分 60.7，
                # 过 publish_min_score=55（生产阈值；2666 万差额只到 50.7 会上不了榜）
                return [{"month": m, "org_name": "华南营销中心",
                         "channel": "GD01", "cur_amt": 20000000.0,
                         "ly_amt": 30000000.0} for m in months]
            return []
        return run
    out = run_day(s, data_date="2026-09-27", brief_date="2026-09-28",
                  now=datetime(2026, 9, 28, 8, 0),          # cutoff 前 → 全部进当日榜
                  runner_for=fake_runner_spec, watermark_ok=lambda name, run: True,
                  freshness_detail=lambda name: "ready; eff=2026-09-27")
    assert out["brief"]["status"] == "final"
    assert out["brief"]["event_count"] >= 1
    rr = s.db.execute("SELECT * FROM radar_run ORDER BY detector").fetchall()
    assert len(rr) == 4 and rr[0]["error"].startswith("ready")   # watermark detail 落 error 列
    assert s.db.execute("SELECT COUNT(*) c FROM daily_brief_event"
                        ).fetchone()["c"] >= 1

def test_run_day_after_cutoff_marks_late(tmp_path):
    s = Store(open_db(tmp_path / "i.db"))
    def fake_runner_spec(name):
        def run(sql, params=None):
            if "ct_sales_performance_t" in sql:
                months = [f"{p[:4]}-{p[4:6]}" for p in params["month_ends"]]
                return [{"month": m, "org_name": "华南营销中心", "channel": "GD01",
                         "cur_amt": 26660000.0, "ly_amt": 30000000.0} for m in months]
            return []
        return run
    out = run_day(s, "2026-09-27", "2026-09-28",
                  now=datetime(2026, 9, 28, 10, 30),        # cutoff 后
                  runner_for=fake_runner_spec, watermark_ok=lambda name, run: True,
                  freshness_detail=lambda name: "ok")
    assert out["brief"]["event_count"] == 0                 # 晚到不进当日榜
    assert s.db.execute("SELECT COUNT(*) c FROM detector_finding WHERE is_late=1"
                        ).fetchone()["c"] >= 1

def test_run_day_radar_not_ready_isolated(tmp_path):
    s = Store(open_db(tmp_path / "i.db"))
    out = run_day(s, "2026-09-27", "2026-09-28", now=datetime(2026, 9, 28, 8, 0),
                  runner_for=lambda name: (lambda sql, p=None: []),
                  watermark_ok=lambda name, run: name == "region_sales",  # 仅一个就绪
                  freshness_detail=lambda name: "ok")
    rr = s.db.execute("SELECT detector, status FROM radar_run").fetchall()
    by = {r["detector"]: r["status"] for r in rr}
    assert by["region_sales"] == "ran" and by["ar_risk"] == "ready_check_failed"

def test_run_day_rerun_skips_ran_detectors(tmp_path):
    s = Store(open_db(tmp_path / "i.db"))
    calls = {"n": 0}
    def fake_runner_spec(name):
        def run(sql, params=None):
            calls["n"] += 1
            if "ct_sales_performance_t" in sql:
                months = [f"{p[:4]}-{p[4:6]}" for p in params["month_ends"]]
                return [{"month": m, "org_name": "华南营销中心", "channel": "GD01",
                         "cur_amt": 26660000.0, "ly_amt": 30000000.0} for m in months]
            return []
        return run
    run_day(s, "2026-09-27", "2026-09-28", now=datetime(2026, 9, 28, 8, 0),
            runner_for=fake_runner_spec, watermark_ok=lambda name, run: True,
            freshness_detail=lambda name: "ok")
    first = calls["n"]
    run_day(s, "2026-09-27", "2026-09-28", now=datetime(2026, 9, 28, 8, 30),  # 同日重跑
            runner_for=fake_runner_spec, watermark_ok=lambda name, run: True,
            freshness_detail=lambda name: "ok")
    assert calls["n"] == first                     # 已 ran 的雷达不再重复执行/重复插 findings
    findings = s.db.execute("SELECT COUNT(*) c FROM detector_finding").fetchone()["c"]
    assert findings == 1                           # 区域雷达 1 条，其余 0；重跑不翻倍
