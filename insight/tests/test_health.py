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


def test_score_floor_at_zero_and_clip_upper():
    # 地板 0：yoy=-60 → clip(60)=60 → 100-60×2=-20 → 0；两期同值 → delta 0（展示分一致性）
    p = compute(_runner(sales=_sales_rows(-60.0, -60.0)), CTX)
    assert _ring(p, "sales")["score"] == 0.0
    assert _ring(p, "sales")["mom_delta"] == 0.0
    # clip 上界+地板：gmp 100→100→0 → 当月环比 -100pt → clip(100)=100 → 100-100×10=-900 → 0；
    # 上月环比 0 → 100 分 → mom_delta -100；inputs.delta_pct 保留真实值（分数封地板，输入可见）
    m = compute(_runner(margins=_margin_rows(10000.0, 10000.0, 0.0)), CTX)
    r = _ring(m, "margin")
    assert r["score"] == 0.0 and r["mom_delta"] == -100.0
    assert r["inputs"]["delta_pct"] == -100.0
    # AR 同兜底：nat90 占比 150% → 100-150=-50 → 0（两期同值 delta 0）
    a = compute(_runner(ar=_ar_rows(150.0, 150.0)), CTX)
    assert _ring(a, "ar")["score"] == 0.0 and _ring(a, "ar")["mom_delta"] == 0.0


def test_partial_degradation_one_ring_down():
    p = compute(_runner(sales=_sales_rows(-5, -5), fail_on="gross_profit"), CTX)
    assert _ring(p, "sales")["available"] is True
    m = _ring(p, "margin")
    assert m["available"] is False and "dws down" in m["reason"]


# ── 10053 事件加固（2026-10-06）：环级连接自愈重试 + 异常致降级 error 标记 ──────────

class _FlakyRunner:
    """带 _conn 的假 runner，模拟 DwsQueryRunner 弃置语义：查询异常后 _conn=None
    （_recover rollback 失败弃置）；重跑时重建（_conn=object）。margin/ar 表照常。"""

    def __init__(self, sales=None, margins=None, ar=None, fail_on=None):
        self._conn = object()
        self._sales, self._margins, self._ar = sales, margins, ar
        self._fail_on = fail_on
        self.calls = 0

    def __call__(self, sql, params=None):
        self.calls += 1
        if self._fail_on and self._fail_on in sql:
            self._conn = None            # 模拟 _recover 弃置
            raise RuntimeError("could not receive data ... (10053)")
        if "ct_sales_performance_t" in sql:
            self._conn = object()
            return self._sales or []
        if "gross_profit_after_sharing" in sql:
            return self._margins or []
        if "dm_ar_analysis_rpt_f" in sql:
            return self._ar or []
        return []


def test_ring_retry_when_conn_dropped_then_recovers():
    # 空闲断连（10053）：sales 首查异常+连接弃置 → 环内重跑一次成功，环可用
    class _Once(_FlakyRunner):
        def __init__(self, **kw):
            super().__init__(**kw)
            self._first = True

        def __call__(self, sql, params=None):
            if self._first and "ct_sales_performance_t" in sql:
                self._first = False
                self._conn = None
                raise RuntimeError("OperationalError('could not receive data (10053)")
            return super().__call__(sql, params)

    r = _Once(sales=_sales_rows(-5, -5), margins=_margin_rows(1000, 950, 900),
              ar=_ar_rows(30.0, 30.0))
    p = compute(r, CTX)
    s = _ring(p, "sales")
    assert s["available"] is True and s["inputs"]["yoy_pct"] == -5.0   # 重跑救回
    assert _ring(p, "margin")["available"] is True


def test_ring_no_retry_and_error_marked_when_conn_alive():
    # 连接仍在（如语句超时）：不重试（护栏语义），环带 error 标记（数据缺失型不带）
    r = _FlakyRunner(sales=_sales_rows(-5, -5), fail_on="gross_profit")
    p = compute(r, CTX)
    m = _ring(p, "margin")
    assert m["available"] is False and m.get("error") is True and "10053" in m["reason"]
    assert _ring(p, "sales").get("error") is None                    # 可用环无标记
    empty = compute(_FlakyRunner(sales=[]), CTX)                     # 数据缺失型降级
    assert _ring(empty, "sales").get("error") is None and \
        _ring(empty, "sales")["reason"] == "完整月同比数据不足"


def test_health_cache_skips_error_ring_and_hits_clean():
    from insight.trend_service import TrendService
    # 异常致降级环（连接仍在，重试不救）→ 结果不落缓存：两次调用都真查
    r = _FlakyRunner(sales=_sales_rows(-5, -5), fail_on="gross_profit")
    svc = TrendService(r)
    svc.health(CTX.as_of)
    n = r.calls
    svc.health(CTX.as_of)
    assert r.calls > n
    # 干净结果 → 落缓存：第二次零查询；瞬断自愈（error 环不存在）同样可缓存
    r2 = _FlakyRunner(sales=_sales_rows(-5, -5), margins=_margin_rows(1000, 950, 900),
                      ar=_ar_rows(30.0, 30.0))
    svc2 = TrendService(r2)
    svc2.health(CTX.as_of)
    n2 = r2.calls
    svc2.health(CTX.as_of)
    assert r2.calls == n2


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
