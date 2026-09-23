# insight/tests/test_replay_ctx.py
from datetime import date
from insight.replay_ctx import ReplayContext, month_end_of, shift_month

def test_param_derivation_formats():
    ctx = ReplayContext(as_of=date(2026, 9, 22))
    assert ctx.calday() == "20260922"        # mix/ct
    assert ctx.ym() == "2026-09"             # calmonth/stat_month
    assert ctx.iso() == "2026-09-22"         # aging query_date

def test_completed_month_ends_mid_month():   # 9-22 → 6/7/8 月（9 月未结束不参与）
    ctx = ReplayContext(as_of=date(2026, 9, 22))
    assert ctx.completed_month_ends(3) == [date(2026, 6, 30), date(2026, 7, 31),
                                           date(2026, 8, 31)]

def test_completed_month_ends_on_month_end():  # 9-30 当天 → 9 月视为已结束
    ctx = ReplayContext(as_of=date(2026, 9, 30))
    assert ctx.completed_month_ends(2) == [date(2026, 8, 31), date(2026, 9, 30)]

def test_calendar_helpers():
    assert month_end_of(date(2026, 2, 10)) == date(2026, 2, 28)
    assert shift_month(date(2026, 1, 15), -1) == date(2025, 12, 15)
    assert shift_month(date(2026, 12, 5), 1) == date(2027, 1, 5)
    assert shift_month(date(2026, 3, 31), -1) == date(2026, 2, 28)   # 月末钳位
    assert shift_month(date(2024, 1, 31), 1) == date(2024, 2, 29)    # 闰年钳位
    assert shift_month(date(2023, 1, 31), 1) == date(2023, 2, 28)    # 平年钳位
    assert month_end_of(date(2024, 2, 10)) == date(2024, 2, 29)      # 闰年月末
