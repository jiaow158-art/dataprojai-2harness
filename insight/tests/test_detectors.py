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

def test_margin_guard_and_floor():                     # 守卫四态：单侧月缺数/零净额/小额闸
    det = GrossMarginDetector.for_test()
    guards = [                                         # 任一侧缺数 → 不构成可比环比
        {"channel": "GD04", "gp": None, "net_amt": 200000000.0,
         "prev_gp": 62000000.0, "prev_net_amt": 200000000.0},  # 当月渠道消失
        {"channel": "GD05", "gp": 56000000.0, "net_amt": 200000000.0,
         "prev_gp": None, "prev_net_amt": 200000000.0},        # 新渠道无基数
        {"channel": "GD06", "gp": 56000000.0, "net_amt": 0.0,
         "prev_gp": 62000000.0, "prev_net_amt": 200000000.0},  # 零净额（除零守卫）
    ]
    res = det.detect(lambda sql, p=None: guards, CTX)
    assert res.status == "ok" and res.findings == []
    floor = [{"channel": "GD09", "gp": 4000000.0, "net_amt": 20000000.0,
              "prev_gp": 6000000.0, "prev_net_amt": 20000000.0}]  # -10pct 但 gp=400万<500万闸
    assert det.detect(lambda sql, p=None: floor, CTX).findings == []

# --- ar_risk 雷达（双侧最新快照，exact；追加）---
from insight.detectors.ar_risk import ArRiskDetector

AR_CTX = ReplayContext(as_of=date(2026, 9, 22))       # prev_bound = 2026-08-23

def _ar_rows():   # 7 个正增量客户：360/280/190/60/40/30/20 → 总 980，Top5=930 → 95%
    return [
        {"cust_code": "D1", "cust_name": "经销商A", "over90": 920.0, "prev_over90": 560.0},
        {"cust_code": "D2", "cust_name": "工程客户B", "over90": 680.0, "prev_over90": 400.0},
        {"cust_code": "D3", "cust_name": "经销商C", "over90": 510.0, "prev_over90": 320.0},
        {"cust_code": "D4", "cust_name": "客户D", "over90": 160.0, "prev_over90": 100.0},
        {"cust_code": "D5", "cust_name": "客户E", "over90": 140.0, "prev_over90": 100.0},
        {"cust_code": "D6", "cust_name": "客户F", "over90": 130.0, "prev_over90": 100.0},
        {"cust_code": "D7", "cust_name": "客户G", "over90": 120.0, "prev_over90": 100.0},
    ]

def _ar_run(snaps, detail_rows, log):
    def run(sql, params=None):
        log.append((sql, params))
        if "MAX(query_date)" in sql:
            return [{"snap": snaps.get(params["bound"])}]
        return detail_rows
    return run

def test_ar_math_total_and_top5_share():
    log = []
    run = _ar_run({"2026-09-22": "2026-09-22", "2026-08-23": "2026-08-23"}, _ar_rows(), log)
    res = ArRiskDetector.for_test().detect(run, AR_CTX)
    assert res.status == "ok" and len(res.findings) == 1
    m = res.findings[0].metrics
    assert m["delta_wan"] == 980                        # 360+280+190+60+40+30+20
    assert m["top5_share_pct"] == 95                    # (360+280+190+60+40)/980
    assert m["current_snapshot_date"] == "2026-09-22"
    assert m["previous_snapshot_date"] == "2026-08-23"

def test_ar_insufficient_history_not_zero():           # 裁定 #11：缺上期≠0
    log = []
    run = _ar_run({"2026-09-22": "2026-09-22", "2026-08-23": None}, _ar_rows(), log)
    res = ArRiskDetector.for_test().detect(run, AR_CTX)
    assert res.status == "insufficient_history" and res.findings == []
    assert "2026-08-23" in res.note
    assert not any("cust_code" in s for s, _ in log)    # 未做对比查询

def test_ar_sql_future_row_guard():
    log = []
    run = _ar_run({"2026-09-22": "2026-09-22", "2026-08-23": "2026-08-23"}, _ar_rows(), log)
    ArRiskDetector.for_test().detect(run, AR_CTX)
    detail_sql = next(s for s, _ in log if "cust_code" in s)
    assert "query_date <= %(as_of_iso)s" in detail_sql
    # 实测 Oracle A 兼容库 ''≡NULL：COALESCE(col,'')='' 恒 0 行匹配，录制口径形态不可回退
    assert "special_general_ledger IS NULL OR special_general_ledger = ''" in detail_sql
    snap_sql = next(s for s, _ in log if "MAX(query_date)" in s)
    assert "<= %(bound)s" in snap_sql
    assert "special_general_ledger IS NULL OR special_general_ledger = ''" in snap_sql

def test_ar_prev_equals_cur_is_insufficient():       # prev 解析到同一快照 → 无环比可言
    run = _ar_run({"2026-09-22": "2026-09-22", "2026-08-23": "2026-09-22"}, _ar_rows(), [])
    res = ArRiskDetector.for_test().detect(run, AR_CTX)
    assert res.status == "insufficient_history" and res.findings == []

def test_ar_negative_delta_excluded():               # 下降客户不计入（纯正增量口径钉死）
    rows = _ar_rows() + [{"cust_code": "D8", "cust_name": "回款良好",
                          "over90": 80.0, "prev_over90": 200.0}]   # delta -120
    run = _ar_run({"2026-09-22": "2026-09-22", "2026-08-23": "2026-08-23"}, rows, [])
    res = ArRiskDetector.for_test().detect(run, AR_CTX)
    m = res.findings[0].metrics
    assert m["delta_wan"] == 980 and m["top5_share_pct"] == 95
