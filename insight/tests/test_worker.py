# insight/tests/test_worker.py
import sys
from datetime import datetime, time as dtime
import pytest
from insight import worker_main
from insight.brief import freeze_brief
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

def test_run_day_after_cutoff_first_run_publishes(tmp_path):
    """裁定：late=发布态判定。10:30 首跑无已发布面 → 照常发布（防空 final 假平安）。"""
    s = Store(open_db(tmp_path / "i.db"))
    def fake_runner_spec(name):
        def run(sql, params=None):
            if "ct_sales_performance_t" in sql:
                months = [f"{p[:4]}-{p[4:6]}" for p in params["month_ends"]]
                return [{"month": m, "org_name": "华南营销中心", "channel": "GD01",
                         "cur_amt": 20000000.0, "ly_amt": 30000000.0} for m in months]
            return []
        return run
    out = run_day(s, "2026-09-27", "2026-09-28",
                  now=datetime(2026, 9, 28, 10, 30),        # cutoff 后首跑：无 prior final
                  runner_for=fake_runner_spec, watermark_ok=lambda name, run: True,
                  freshness_detail=lambda name: "ok")
    assert out["brief"]["status"] == "final"
    assert out["brief"]["event_count"] >= 1                # 真实 findings 照常发布
    assert s.db.execute("SELECT COUNT(*) c FROM detector_finding WHERE is_late=1"
                        ).fetchone()["c"] == 0              # 未发布不标 late

def test_run_day_after_final_marks_late(tmp_path):
    """已发布后续到 = late：新 finding is_late=1；榜单 first-final-wins 不被改写。"""
    s = Store(open_db(tmp_path / "i.db"))
    def fake_runner_spec(name):
        def run(sql, params=None):
            if "ct_sales_performance_t" in sql:
                months = [f"{p[:4]}-{p[4:6]}" for p in params["month_ends"]]
                return [{"month": m, "org_name": "华南营销中心", "channel": "GD01",
                         "cur_amt": 20000000.0, "ly_amt": 30000000.0} for m in months]
            return []
        return run
    ready = {"ar_risk", "gross_margin", "target"}           # 首跑 region_sales 未就绪
    run_day(s, "2026-09-27", "2026-09-28", now=datetime(2026, 9, 28, 8, 0),
            runner_for=fake_runner_spec, watermark_ok=lambda name, run: name in ready,
            freshness_detail=lambda name: "ok")
    ready.add("region_sales")                               # 二跑补就绪 → 新 finding
    out2 = run_day(s, "2026-09-27", "2026-09-28", now=datetime(2026, 9, 28, 10, 30),
                   runner_for=fake_runner_spec,
                   watermark_ok=lambda name, run: name in ready,
                   freshness_detail=lambda name: "ok")
    assert s.db.execute("SELECT COUNT(*) c FROM detector_finding WHERE is_late=1"
                        ).fetchone()["c"] == 1              # 已发布后到达 = late
    assert out2["brief"]["status"] == "final" and out2["brief"]["event_count"] == 0
    # first-final-wins：首跑空榜（3 雷达干净）不被晚到高分改写

def test_run_day_radar_not_ready_isolated(tmp_path):
    s = Store(open_db(tmp_path / "i.db"))
    out = run_day(s, "2026-09-27", "2026-09-28", now=datetime(2026, 9, 28, 8, 0),
                  runner_for=lambda name: (lambda sql, p=None: []),
                  watermark_ok=lambda name, run: name == "region_sales",  # 仅一个就绪
                  freshness_detail=lambda name: "ok")
    rr = s.db.execute("SELECT detector, status FROM radar_run").fetchall()
    by = {r["detector"]: r["status"] for r in rr}
    assert by["region_sales"] == "ran" and by["ar_risk"] == "ready_check_failed"

def test_run_day_detect_error_isolated(tmp_path):
    """detect 异常分支：单雷达 SQL 抛错 → radar_run error 态，其余照常，brief 仍发布。"""
    s = Store(open_db(tmp_path / "i.db"))
    def fake_runner_spec(name):
        def run(sql, params=None):
            if "dm_ar_analysis_rpt_f" in sql:              # ar_risk 的表 → 执行层抛错
                raise RuntimeError("dws timeout boom")
            if "ct_sales_performance_t" in sql:
                months = [f"{p[:4]}-{p[4:6]}" for p in params["month_ends"]]
                return [{"month": m, "org_name": "华南营销中心", "channel": "GD01",
                         "cur_amt": 20000000.0, "ly_amt": 30000000.0} for m in months]
            return []
        return run
    out = run_day(s, "2026-09-27", "2026-09-28", now=datetime(2026, 9, 28, 8, 0),
                  runner_for=fake_runner_spec, watermark_ok=lambda name, run: True,
                  freshness_detail=lambda name: "ok")
    by = {r["detector"]: r["status"] for r in
          s.db.execute("SELECT detector, status FROM radar_run").fetchall()}
    assert by["ar_risk"] == "error"                          # 异常隔离不炸整日
    assert by["region_sales"] == "ran" and by["gross_margin"] == "ran" \
        and by["target"] == "ran"
    assert out["brief"]["status"] == "final"                 # 其余就绪 → 照常发布
    assert out["brief"]["event_count"] >= 1

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

# —— run_attributions（归因循环；Fix 2 抽函数可测）——

def _published_store(tmp_path, events=2):
    """两个上榜事件（norm_score 90 → brief 分 66.7 ≥ 55），brief_date=2026-09-28。"""
    s = Store(open_db(tmp_path / "i.db"))
    for i in range(events):
        s.insert_finding("2026-09-27", "region_sales",
                         {"anchor_type": "org_channel", "anchor_id": f"org{i}|GD01",
                          "channel": "GD01"}, {"yoy_pct": -11.2}, 90, is_late=False)
    freeze_brief(s, "2026-09-28", "2026-09-27",
                 [{"detector": "region_sales", "ready": True, "detail": "ok"}])
    return s

def _ranked_event_ids(s):
    return [r["event_id"] for r in s.db.execute(
        "SELECT event_id FROM daily_brief_event WHERE brief_date='2026-09-28'"
        " ORDER BY rank")]

def test_run_attributions_window(tmp_path, monkeypatch):
    s = _published_store(tmp_path)
    calls = []
    monkeypatch.setattr(worker_main, "run_attribution",
                        lambda store, eid, d: calls.append(eid) or {"status": "done"})
    assert worker_main.run_attributions(s, "2026-09-28", dtime(9, 0)) == []   # 窗口前
    assert not calls
    worker_main.run_attributions(s, "2026-09-28", dtime(10, 0))               # 边界含
    assert len(calls) == 2
    calls.clear()
    worker_main.run_attributions(s, "2026-09-28", dtime(14, 0))               # 边界含
    assert len(calls) == 2
    calls.clear()
    assert worker_main.run_attributions(s, "2026-09-28", dtime(14, 1)) == []  # 越窗不跑
    assert not calls

def test_run_attributions_skips_done_today_reanalyses_stale(tmp_path, monkeypatch):
    """每日重归因裁定：done+analysis_date=当日 → 跳过；done+分析日期落后当日 → 重归因。"""
    s = _published_store(tmp_path)
    ids = _ranked_event_ids(s)
    for eid, ad in ((ids[0], "2026-09-28"), (ids[1], "2026-09-27")):  # 今日/昨日分析
        s.db.execute("UPDATE business_event SET attribution_status='done' WHERE event_id=?",
                     (eid,))
        s.db.execute("INSERT INTO event_analysis_run (analysis_id, event_id, analysis_date,"
                     " gateway_run_id, status, submitted_at, finished_at)"
                     " VALUES (?,?,?,'gw-x','done',0,0)", (f"an-{ad}", eid, ad))
    s.db.commit()
    calls = []
    monkeypatch.setattr(worker_main, "run_attribution",
                        lambda store, eid, d: calls.append(eid) or {"status": "done"})
    res = worker_main.run_attributions(s, "2026-09-28", dtime(11, 0))
    assert calls == [ids[1]]          # 今日已分析的跳过；分析日期落后的重归因（幂等键当日去重）
    assert len(res) == 1

def test_run_attributions_isolation(tmp_path, monkeypatch):
    s = _published_store(tmp_path)
    ids = _ranked_event_ids(s)
    def fake(store, eid, d):
        if eid == ids[0]:
            raise RuntimeError("gw down")
        return {"status": "done"}
    monkeypatch.setattr(worker_main, "run_attribution", fake)
    res = worker_main.run_attributions(s, "2026-09-28", dtime(11, 0))
    assert len(res) == 2                                    # 首事件失败不中断后续
    assert res[0]["event_id"] == ids[0] and res[0]["status"] == "failed" \
        and res[0]["error"]
    assert res[1]["event_id"] == ids[1] and res[1]["status"] == "done"

# —— run_prod --brief-date（补归因入口）——

def test_brief_date_arg_default_and_override():
    from insight.worker_main import _brief_date
    assert _brief_date(["--brief-date", "2026-09-29"]) == "2026-09-29"
    assert _brief_date([]) == datetime.now().date().isoformat()   # 缺省 today
    with pytest.raises(ValueError):                               # 非法日期显式炸
        _brief_date(["--brief-date", "not-a-date"])

def test_run_prod_brief_date_override_wiring(tmp_path, monkeypatch):
    """--brief-date D：data_date=D-1、freeze 与归因循环均用 D（补归因路径接线）。"""
    calls = {}

    class FakeDT(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2026, 9, 30, 11, 0)

    monkeypatch.setattr(worker_main, "datetime", FakeDT)
    monkeypatch.setenv("INSIGHT_DB_PATH", str(tmp_path / "i.db"))
    monkeypatch.setattr(worker_main, "run_day",
                        lambda s, dd, bd, now, runner_for, watermark_ok, freshness_detail:
                        calls.update(data_date=dd, brief_date=bd) or {"brief": {}})
    monkeypatch.setattr(worker_main, "run_attributions",
                        lambda s, bd, t: calls.update(attr_brief=bd, attr_t=t) or [])
    monkeypatch.setattr(sys, "argv",
                        ["-m", "insight.worker_main", "--brief-date", "2026-09-29"])
    worker_main.run_prod()
    assert calls["brief_date"] == "2026-09-29" and calls["data_date"] == "2026-09-28"
    assert calls["attr_brief"] == "2026-09-29" and calls["attr_t"] == dtime(11, 0)
