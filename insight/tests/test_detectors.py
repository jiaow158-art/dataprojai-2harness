# insight/tests/test_detectors.py
from datetime import date
from insight.replay_ctx import ReplayContext
from insight.detectors.region_sales import RegionSalesDetector

CTX = ReplayContext(as_of=date(2026, 9, 22))          # 完整月窗口=6/7/8 月

def _rows(yoy_seq):                                    # keys: 华南/GD01 + 广东/GD01(正常)
    # 授权澄清：cur_amt 由 yoy 推导（ly_amt*(1+yoy/100)），否则固定金额无法区分
    # "恢复月"与"下滑月"。华南 ly_amt=10135.0（yoy=-11.2 → cur≈9000）；广东恒 +1% 永不触发。
    rows = []
    for (y, m), yoy in zip([(2026, 6), (2026, 7), (2026, 8)], yoy_seq):
        rows.append({"month": f"{y}-{m:02d}", "org_name": "华南营销中心", "channel": "GD01",
                     "cur_amt": 10135.0 * (1 + yoy / 100), "ly_amt": 10135.0})
        rows.append({"month": f"{y}-{m:02d}", "org_name": "广东营销部", "channel": "GD01",
                     "cur_amt": 5000.0, "ly_amt": 4950.0})
    return rows

def test_fires_on_three_complete_months_decline():
    det = RegionSalesDetector.for_test()
    run = lambda sql, p=None: _rows([-11.2, -10.8, -11.5])
    res = det.detect(run, CTX)
    assert res.status == "ok" and len(res.findings) == 1
    f = res.findings[0]
    assert f.dim_keys["anchor_id"] == "华南营销中心|GD01"
    assert f.metrics["consecutive"] == 3 and f.metrics["months"] == ["2026-06", "2026-07", "2026-08"]
    assert f.threshold_passed is True

def test_quiet_when_one_month_recovers():
    det = RegionSalesDetector.for_test()
    run = lambda sql, p=None: _rows([-11.2, -10.8, 2.0])
    res = det.detect(run, CTX)
    assert res.status == "ok" and res.findings == []

def test_sql_complete_month_binds():
    det = RegionSalesDetector.for_test()
    seen = {}
    run = lambda sql, p=None: (seen.update(sql=sql, p=p) or [])
    det.detect(run, CTX)
    assert seen["p"]["month_ends"] == ["20260630", "20260731", "20260831"]  # 9 月不在
    assert seen["p"]["as_of_calday"] == "20260922"
    assert "ANY(%(month_ends)s)" in seen["sql"]
    assert "<= %(as_of_calday)s" in seen["sql"]                              # 防未来
    assert "node_desc2 = '瓷砖事业部'" in seen["sql"]
    assert ":data_date" not in seen["sql"]                                   # 无旧占位符

def test_missing_month_breaks_consecutive():           # 缺任一完整月→不构成"连续"
    det = RegionSalesDetector.for_test()
    rows = [{"month": "2026-06", "org_name": "华南营销中心", "channel": "GD01",
             "cur_amt": 17700000.0, "ly_amt": 19900000.0},
            {"month": "2026-08", "org_name": "华南营销中心", "channel": "GD01",
             "cur_amt": 17700000.0, "ly_amt": 19900000.0}]   # 2026-07 缺
    res = det.detect(lambda sql, p=None: rows, CTX)
    assert res.status == "ok" and res.findings == []

def test_production_floor_filters_small_amounts():     # 生产构造：min_ly_amt=2000 万
    det = RegionSalesDetector()
    months = ["2026-06", "2026-07", "2026-08"]
    small = [{"month": m, "org_name": "华南营销中心", "channel": "GD01",
              "cur_amt": 17700000.0, "ly_amt": 19900000.0} for m in months]  # ly<2000 万→闸掉
    assert det.detect(lambda sql, p=None: small, CTX).findings == []
    big = [{"month": m, "org_name": "华南营销中心", "channel": "GD01",
            "cur_amt": 17850000.0, "ly_amt": 20100000.0} for m in months]    # ly≥2000 万→触发
    res = det.detect(lambda sql, p=None: big, CTX)
    assert len(res.findings) == 1

# --- gross_margin 雷达（最近两个完整自然月，exact）---
from insight.detectors.gross_margin import GrossMarginDetector

def test_margin_fires_on_drop():
    det = GrossMarginDetector.for_test()
    run = lambda sql, p=None: [{"channel": "GD03", "gp": 56000000.0, "net_amt": 200000000.0,
                                "prev_gp": 62000000.0, "prev_net_amt": 200000000.0}]
    res = det.detect(run, CTX)                     # 28.0% vs 31.0% → delta -3.0 ≤ -2.0
    assert res.status == "ok" and len(res.findings) == 1
    f = res.findings[0]
    assert f.metrics["delta_pct"] == -3.0
    assert f.metrics["gmp_pct"] == 28.0 and f.metrics["prev_gmp_pct"] == 31.0
    assert f.dim_keys["anchor_type"] == "org_channel"

def test_margin_quiet_on_small_drop():
    det = GrossMarginDetector.for_test()
    run = lambda sql, p=None: [{"channel": "GD03", "gp": 61000000.0, "net_amt": 200000000.0,
                                "prev_gp": 62000000.0, "prev_net_amt": 200000000.0}]
    assert det.detect(run, CTX).findings == []      # 30.5% vs 31.0% → -0.5 未越阈

def test_margin_sql_complete_months_binds():
    det = GrossMarginDetector.for_test()
    seen = {}
    run = lambda sql, p=None: (seen.update(sql=sql, p=p) or [])
    det.detect(run, CTX)
    assert seen["p"]["cur_ym"] == "2026-08" and seen["p"]["prev_ym"] == "2026-07"
    assert "gross_profit_after_sharing" in seen["sql"]
    assert "notax_sales_net_amt" in seen["sql"]
    assert "calmonth <= %(cur_ym)s" in seen["sql"]          # 预算月防线
