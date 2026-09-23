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
