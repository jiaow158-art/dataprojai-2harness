# insight/tests/test_progress.py
from datetime import date
from insight.detectors.target import time_progress_pct

CURVE = {1: 2.5, 10: 31.0, 20: 66.0, 22: 73.0, 30: 100.0}   # day → progress_pct

def test_workday_progress_2026_09_22():                      # 16 个工作日 / 22 个 → 72.7
    assert time_progress_pct(date(2026, 9, 22), "workday") == 72.7

def test_natural_day_fallback():
    assert time_progress_pct(date(2026, 9, 22), "natural") == round(22 / 30 * 100, 1)

def test_curve_exact_hit():
    assert time_progress_pct(date(2026, 9, 22), "curve", CURVE) == 73.0

def test_curve_linear_interpolation():                       # day15：31 + (66-31)*5/10 = 48.5
    assert time_progress_pct(date(2026, 9, 15), "curve", CURVE) == 48.5

def test_curve_no_later_point_clamps_to_last():              # 曲线只到 day10 → 取 10.0
    assert time_progress_pct(date(2026, 9, 28), "curve", {1: 1.0, 10: 10.0}) == 10.0

def test_curve_missing_falls_back_to_basis():                # basis=curve 但无曲线 → 自然日兜底
    assert time_progress_pct(date(2026, 9, 22), "curve", None) == 73.3

def test_curve_before_first_point_uses_first():              # 早于首点 → 取首点值
    assert time_progress_pct(date(2026, 9, 1), "curve", {5: 10.0, 20: 60.0}) == 10.0
