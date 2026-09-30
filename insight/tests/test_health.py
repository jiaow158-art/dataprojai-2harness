# spec §5 确定性映射：封顶/clip/环比差/局部降级（某环查询异常→available:false 不炸整卡）
from datetime import date

from insight.health import compute
from insight.replay_ctx import ReplayContext

CTX = ReplayContext(as_of=date(2026, 9, 22))   # 完整月窗口=6/7/8；ar 当月=2026-09


def _sales_rows(yoy_cur, yoy_prev):
    return [{"month": "2026-07", "cur_amt": 100.0 * (1 + yoy_prev / 100), "ly_amt": 100.0},
            {"month": "2026-08", "cur_amt": 100.0 * (1 + yoy_cur / 100), "ly_amt": 100.0}]


def _margin_rows(gp3, gp2, gp1):
    return [{"month": "2026-06", "gp": gp3, "net_amt": 10000.0},
            {"month": "2026-07", "gp": gp2, "net_amt": 10000.0},
            {"month": "2026-08", "gp": gp1, "net_amt": 10000.0}]


def _ar_rows(share_cur, share_prev):
    return [{"calmonth": "2026-08", "nat90": share_prev, "total": 100.0},
            {"calmonth": "2026-09", "nat90": share_cur, "total": 100.0}]


def _runner(sales=None, margins=None, ar=None, actual=None, target=None, fail_on=None):
    def run(sql, params=None):
        if fail_on and fail_on in sql:
            raise RuntimeError("dws down")
        if "ct_sales_performance_t" in sql:
            return sales or []
        if "gross_profit_after_sharing" in sql and "calmonth = ANY" in sql:
            return margins or []
        if "dm_ar_analysis_rpt_f" in sql:
            return ar or []
        if "ambperformance" in sql:
            return actual or []
        if "dm_dp_api_sales_target" in sql:
            return target or []
        return []
    return run


def _ring(payload, key):
    return next(r for r in payload["rings"] if r["key"] == key)


def test_sales_ring_formula_and_delta():
    p = compute(_runner(sales=_sales_rows(-11.2, -14.4)), CTX)
    r = _ring(p, "sales")
    assert r["score"] == 77.6                        # 100 − clip(11.2)×2
    assert r["mom_delta"] == 6.4                     # 上月 yoy −14.4→71.2；本月 −11.2→77.6；+6.4
    assert r["inputs"]["yoy_pct"] == -11.2 and r["inputs"]["month"] == "2026-08"
    assert "× 2.0" in r["formula"]


def test_sales_ring_caps_at_100_when_growing():
    p = compute(_runner(sales=_sales_rows(3.0, -2.0)), CTX)
    assert _ring(p, "sales")["score"] == 100.0       # 同比为正→封顶


def test_margin_ring_formula():
    p = compute(_runner(margins=_margin_rows(1000, 900, 850)), CTX)
    # gmp 10.0→9.0→8.5：上月环比 −1.0→score 90；当月环比 −0.5→score 95；95−90=+5
    r = _ring(p, "margin")
    assert r["score"] == 95.0                        # 100 − 0.5×10
    assert r["mom_delta"] == 5.0                     # 90→95
    assert r["inputs"]["delta_pct"] == -0.5


def test_ar_ring_share_formula():
    p = compute(_runner(ar=_ar_rows(38.0, 41.0)), CTX)
    r = _ring(p, "ar")
    assert r["score"] == 62.0                        # 100 − 38%
    assert r["mom_delta"] == 3.0                     # 上月 41%→59；本月 38%→62；59→62=+3
    assert r["inputs"]["nat90_share_pct"] == 38.0


def test_partial_degradation_one_ring_down():
    p = compute(_runner(sales=_sales_rows(-5, -5), fail_on="gross_profit"), CTX)
    assert _ring(p, "sales")["available"] is True
    m = _ring(p, "margin")
    assert m["available"] is False and "dws down" in m["reason"]


def test_inventory_ring_honest_unavailable():
    p = compute(_runner(), CTX)
    inv = _ring(p, "inventory")
    assert inv["available"] is False and "日汇总" in inv["reason"]


def test_target_block_from_trend_meta():
    p = compute(_runner(actual=[{"month": "2026-09", "actual_amt": 420460000.0}],
                        target=[{"month": "2026-09", "target_amt": 538462000.0}]), CTX)
    t = p["target"]
    assert t["year"] == 2026
    assert t["actual_wan"] == 42046.0 and t["annual_target_wan"] == round(538462000.0 / 10000, 1)
    assert t["achieve_pct"] == 78.1                  # 42046/53846.2 万
    assert t["time_pct"] == round(265 / 365 * 100, 1)   # 2026-09-22 是第 265 天
