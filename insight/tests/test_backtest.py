# insight/tests/test_backtest.py
from datetime import date
import pytest
from insight.backtest import assert_point_in_time, run_window

def _fake_run_log():
    log = []
    def run(sql, params=None):
        log.append((sql, params)); return []
    return run, log

def test_point_in_time_covers_all_date_like_params():    # 裁定 #7：不止 data_date
    as_of = date(2025, 9, 30)
    assert_point_in_time({"data_date": "20250901"}, as_of)          # ok
    assert_point_in_time({"cur_month_ym": "2025-09"}, as_of)        # ok（=月内）
    assert_point_in_time({"as_of_iso": "2025-09-30"}, as_of)        # ok
    with pytest.raises(AssertionError):
        assert_point_in_time({"cur_month_ym": "2025-10"}, as_of)    # 下个月 → 拒
    with pytest.raises(AssertionError):
        assert_point_in_time({"d1": "2025-10-05"}, as_of)
    assert_point_in_time({"limit": 5}, as_of)                       # 非日期参数不误伤
    assert_point_in_time({"comp_codes": ["X1"]}, as_of)

def test_point_in_time_rejects_future_element_in_list():   # 守卫硬化：列表逐元素解析
    with pytest.raises(AssertionError):
        assert_point_in_time({"month_ends": ["20260630", "20261231"]}, date(2025, 9, 30))

def test_point_in_time_allows_past_list():
    assert_point_in_time({"month_ends": ["20250630", "20250901"]}, date(2025, 9, 30))

def test_point_in_time_compares_date_objects_directly():   # 守卫硬化：date 对象直比
    with pytest.raises(AssertionError):
        assert_point_in_time({"snap": date(2026, 1, 1)}, date(2025, 9, 30))

def test_replay_bounds_every_query_to_window_end():
    run, log = _fake_run_log()
    run_window(run, start=date(2025, 9, 1), end=date(2025, 9, 30), step_days=7,
               detectors=["region_sales"])
    for _, params in log:
        for v in params.values():
            s = str(v)
            if len(s) == 8 and s.isdigit():        # YYYYMMDD
                assert s <= "20250930"
            elif len(s) == 10 and s[4] == "-":
                assert s <= "2025-09-30"

def _fixture_run():     # 按 SQL 内容分派：region 三月连降 / target 落后 → 必产 findings
    def run(sql, params=None):
        if "ct_sales_performance_t" in sql:
            months = [f"{s[:4]}-{s[4:6]}" for s in params["month_ends"]]
            return [{"month": m, "org_name": "华南营销中心", "channel": "GD01",
                     "cur_amt": 26660000.0, "ly_amt": 30000000.0} for m in months]
            # 金额为生产量级（ly=3000万 ≥ min_ly_amt 2000万）——玩具金额会被闸吞
        if "sales_target" in sql:
            return [{"actual_amt": 69400000.0, "target_amt": 100000000.0}]
        return []
    return run

def test_determinism_and_mode_tagging():
    # 窗口须含 09-22/09-29：target=retrospective，69.4% 达成仅在 workday 时间进度 ≥72.4%
    # （即 09-22 起）越过 -3pct 闸（与 test_target_fires_when_behind_schedule 的 09-22 钉点同源）；
    # 计划原文窗口止于 09-15（进度 50%，gap +19.4）→ target 恒静默，modes 缺 target 必挂。
    a = run_window(_fixture_run(), date(2025, 9, 1), date(2025, 9, 30), 7,
                   ["region_sales", "target"])
    b = run_window(_fixture_run(), date(2025, 9, 1), date(2025, 9, 30), 7,
                   ["region_sales", "target"])
    assert a == b and a                             # 同窗二跑逐字段一致且非空
    modes = {r["detector"]: r["point_in_time_mode"] for r in a}
    assert modes.get("region_sales") == "exact"
    assert modes.get("target") == "retrospective"

def test_non_ok_status_echoed_to_stderr(capsys):        # ★ 控制端新增
    def run(sql, params=None):
        if "sales_target" in sql:
            return []          # target 查询无行 → not_ready
        return []
    out = run_window(run, date(2025, 9, 1), date(2025, 9, 1), 7, ["target"])
    assert out == []
    err = capsys.readouterr().err
    assert "target" in err and "not_ready" in err

def test_crashed_detector_doesnt_abort_window(capsys):  # 崩溃可观测但不炸整窗
    def run(sql, params=None):
        if "sales_target" in sql:
            raise RuntimeError("boom")
        if "ct_sales_performance_t" in sql:
            months = [f"{s[:4]}-{s[4:6]}" for s in params["month_ends"]]
            return [{"month": m, "org_name": "华南营销中心", "channel": "GD01",
                     "cur_amt": 26660000.0, "ly_amt": 30000000.0} for m in months]
        return []
    out = run_window(run, date(2025, 9, 1), date(2025, 9, 1), 7,
                     ["region_sales", "target"])
    assert any(r["detector"] == "region_sales" for r in out)   # region 照常产出
    err = capsys.readouterr().err
    assert "crash" in err and "boom" in err
