# M-i7 目标管理页口径（spec 2026-10-02 §3）：annual 与 health 同源对拍 / 线性年化 /
# 月度 MTD 封顶 / centers 欠进度·占比·恢复潜力 / 局部降级
from datetime import date

from insight.replay_ctx import ReplayContext
from insight.target_report import target_overview

CTX = ReplayContext(as_of=date(2026, 9, 22))   # 年内已过 265 天/365；完整月 1-8 月；当月 9 月 MTD


def _ly(month):          # 上年同月
    y, m = int(month[:4]) - 1, month[5:7]
    return f"{y}-{m}"


def _runner(actuals, targets, ly_actuals=None, center_actuals=None, center_targets=None,
            center_ly=None, fail_on=None, seen=None):
    """actuals/targets: {month: 万元}; center_*: {center: 万元}（center 集从 targets 键推）。
    分派串对齐 target_report 真实 SQL：annual 同源走 target.py TREND_*（元单位 *_amt 列）；
    月度/中心查询以 wan 列区分；上年查询用独立绑定名 %(ly_ym)s/%(ly_as_of_calday)s（含 ly）。"""
    ly_actuals = ly_actuals or {}
    center_actuals = center_actuals or {}
    center_targets = center_targets or {}
    center_ly = center_ly or {}

    def run(sql, params=None):
        if seen is not None:
            seen.append(sql[:48])
        if fail_on and fail_on in sql:
            raise RuntimeError("dws down")
        if "AS actual_amt" in sql:                 # TREND_ACTUAL（annual 同源，元）
            return [{"month": m, "actual_amt": v * 10000.0} for m, v in actuals.items()]
        if "AS target_amt" in sql:                 # TREND_TARGET（annual 同源，元）
            return [{"month": m, "target_amt": v * 10000.0} for m, v in targets.items()]
        if "dm_dp_api_sales_target" in sql:        # 目标表：月度行 vs 中心行两形
            if "sales_center_code" in sql:
                return [{"center": c, "wan": v} for c, v in center_targets.items()]
            return [{"month": m, "wan": v} for m, v in targets.items()]
        if "node_name5 AS center" in sql:          # 中心实绩：当年 vs 上年（LY 绑定名含 ly）
            src = center_ly if "ly" in sql.lower() else center_actuals
            return [{"center": c, "wan": v} for c, v in src.items()]
        if "GROUP BY m.calmonth" in sql:           # 月度实绩：当年 vs 上年（键转上年同月）
            if "ly" in sql.lower():
                return [{"month": _ly(m), "wan": v} for m, v in ly_actuals.items()]
            return [{"month": m, "wan": v} for m, v in actuals.items()]
        return []
    return run


def test_annual_matches_health_semantics():
    # 1-8 月实绩各 1000 万 + 9 月 MTD 500 万；目标各月 1000 万
    acts = {f"2026-{m:02d}": 1000.0 for m in range(1, 9)} | {"2026-09": 500.0}
    tgts = {f"2026-{m:02d}": 1000.0 for m in range(1, 10)}
    out = target_overview(_runner(acts, tgts), CTX)
    a = out["annual"]
    assert a["actualWan"] == 8500.0 and a["targetWan"] == 9000.0
    assert a["achievePct"] == round(8500 / 9000 * 100, 1)
    assert a["timePct"] == round(265 / 365 * 100, 1)      # 与 health 同年日内自然日口径


def test_projection_linear_annualization():
    acts = {f"2026-{m:02d}": 1000.0 for m in range(1, 9)} | {"2026-09": 500.0}
    tgts = {f"2026-{m:02d}": 1000.0 for m in range(1, 10)}
    p = target_overview(_runner(acts, tgts), CTX)["projection"]
    assert p["dailyWan"] == round(8500 / 265, 1)
    assert p["projectedWan"] == round(8500 / 265 * 365, 1)
    assert p["projectedGapWan"] == round(9000 - 8500 / 265 * 365, 1)   # 负值=预计超额，如实


def test_months_mtd_cap_and_nulls():
    acts = {"2026-01": 1200.0, "2026-09": 500.0}
    tgts = {"2026-01": 1000.0, "2026-09": 1000.0}         # 2-8 月无目标
    ly = {"2026-01": 1000.0}                               # 9 月无上年
    ms = target_overview(_runner(acts, tgts, ly_actuals=ly), CTX)["months"]
    assert len(ms) == 9                                     # 1..9 月
    m1 = ms[0]
    assert m1["achievePct"] == 120.0 and m1["yoyPct"] == 20.0 and m1["isCurrent"] is False
    m2 = ms[1]
    assert m2["targetWan"] is None and m2["achievePct"] is None   # 目标缺→null 不造
    m9 = ms[8]
    assert m9["isCurrent"] is True and m9["yoyPct"] is None       # MTD 行标记 + 上年缺→null
    assert m9["timePct"] == round(16 / 22 * 100, 1)               # 当月行附月度工作日进度


def test_centers_behind_share_and_recovery():
    # 两个中心：A 落后（目标1000 实绩500）、B 超前（目标1000 实绩1100）
    ca, ct = {"A": 500.0, "B": 1100.0}, {"A": 1000.0, "B": 1000.0}
    cly = {"A": 3000.0}   # A 上年同期 3000 万 → 日均高 → 有恢复潜力；B 无上年→0
    cs = target_overview(_runner({"2026-09": 1600.0}, {"2026-09": 2000.0},
                                 center_actuals=ca, center_targets=ct, center_ly=cly), CTX)
    centers = cs["centers"]
    assert centers[0]["centerCode"] == "A"                    # 按欠进度额降序（spec §3）
    a = next(c for c in centers if c["centerCode"] == "A")
    tp = round(265 / 365 * 100, 1)
    assert a["behindWan"] == round(1000 * tp / 100 - 500, 1)
    assert a["behindSharePct"] == 100.0                     # 分母只计落后者（B 超前不计）
    # 恢复潜力两侧同为该中心口径（spec §3"该中心恢复潜力"）：当前日均=该中心 YTD/已过自然日。
    # 配平说明：计划稿此处误写 1600/265（BU 年化日均），按公式改用 A 实绩 500/265。
    assert a["recoveryWan"] == round(max(0, 3000 / 265 - 500 / 265) * (365 - 265), 1)
    assert a["centerName"] is None                          # 无名称映射→cname 缺省回显码
    b = next(c for c in centers if c["centerCode"] == "B")
    assert b["behindWan"] < 0 and b["recoveryWan"] == 0.0    # 超前带负号；上年缺→0
    assert cs["centersTotalBehindWan"] == round(1000 * tp / 100 - 500, 1)


def test_partial_degradation_blocks():
    out = target_overview(_runner({}, {}, fail_on="dm_dp_api_sales_target"), CTX)
    assert out["annual"]["available"] is False              # 目标查询挂→annual 降级
    # months/centers 目标侧同样依赖目标表→一并降级属可接受；projection 依赖 annual→null
    assert out["projection"] is None or out["projection"].get("available") is False
    assert out["months"]["available"] is False              # 目标表挂→months 一并降级
    assert out["centers"]["available"] is False             # centers 同降级、合计→null
    assert out["centersTotalBehindWan"] is None
