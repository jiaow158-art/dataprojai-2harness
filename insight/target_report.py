# insight/target_report.py
"""目标管理页聚合（spec 2026-10-02 §3，D-t1..D-t6）：annual 与 health._target_block 同源、
线性年化外推、月度 MTD、组织欠进度拆解。纯函数、runner 注入；金额万元 round 1。"""
import calendar

from .detectors.target import TargetDetector, time_progress_pct
from .replay_ctx import ReplayContext, shift_month

# BU 级当年逐月实绩（当月 calday 封顶=MTD；完整月自然全月）
ACTUAL_SQL = """
SELECT m.calmonth AS month, SUM(m.ambperformance)/10000 AS wan
FROM dm.dm_fin_operations_mix_sum_t m
WHERE m.calmonth = ANY(%(ym)s)
  AND m.calday <= %(as_of_calday)s
  AND m.node_desc2 = '瓷砖事业部'
  AND m.data_source IN ('S','T','D','')
GROUP BY m.calmonth
"""

# 上年同月实绩：LY 绑定名独立（ly_ym/ly_as_of_calday），calday 封"上年同日"=同窗对比
LY_ACTUAL_SQL = """
SELECT m.calmonth AS month, SUM(m.ambperformance)/10000 AS wan
FROM dm.dm_fin_operations_mix_sum_t m
WHERE m.calmonth = ANY(%(ly_ym)s)
  AND m.calday <= %(ly_as_of_calday)s
  AND m.node_desc2 = '瓷砖事业部'
  AND m.data_source IN ('S','T','D','')
GROUP BY m.calmonth
"""

# 逐月目标（target_sales_amt 单位万元，直出）
TARGET_SQL = """
SELECT t.stat_month AS month, SUM(t.target_sales_amt) AS wan
FROM dm.dm_dp_api_sales_target t
WHERE t.stat_month = ANY(%(ym)s)
  AND t.org_type = '业务单位'
GROUP BY t.stat_month
"""

# 中心级当年 YTD 实绩（当月 MTD 封顶，按 node_name5 聚合）
CENTER_ACTUAL_SQL = """
SELECT m.node_name5 AS center, SUM(m.ambperformance)/10000 AS wan
FROM dm.dm_fin_operations_mix_sum_t m
WHERE m.calmonth = ANY(%(ym)s)
  AND m.calday <= %(as_of_calday)s
  AND m.node_desc2 = '瓷砖事业部'
  AND m.data_source IN ('S','T','D','')
GROUP BY m.node_name5
"""

# 中心级上年同期实绩（封"上年同日"；LY 绑定名独立，不与当年共享键）
CENTER_LY_SQL = """
SELECT m.node_name5 AS center, SUM(m.ambperformance)/10000 AS wan
FROM dm.dm_fin_operations_mix_sum_t m
WHERE m.calmonth = ANY(%(ly_ym)s)
  AND m.calday <= %(ly_as_of_calday)s
  AND m.node_desc2 = '瓷砖事业部'
  AND m.data_source IN ('S','T','D','')
GROUP BY m.node_name5
"""

# 中心级目标：center 集=目标雷达同口径（centers CTE，前置月 lag 读 config 与雷达同源）；
# 名称 LEFT JOIN MAX(node_desc5)（D-t4 防树形重复，无映射 cname=NULL 回显码）
CENTER_TARGET_SQL = """
WITH centers AS (
  SELECT DISTINCT node_name5 AS center FROM dm.dm_fin_operations_mix_sum_t
  WHERE calmonth = %(center_set_month_ym)s
    AND node_desc2 = '瓷砖事业部'
    AND data_source IN ('S','T','D','')
), names AS (
  SELECT node_name5 AS center, MAX(node_desc5) AS cname
  FROM dm.dm_rpt_sales_group_t
  WHERE node_desc2 = '瓷砖事业部'
  GROUP BY node_name5
)
SELECT t.sales_center_code AS center, SUM(t.target_sales_amt) AS wan,
       MAX(n.cname) AS cname
FROM dm.dm_dp_api_sales_target t
LEFT JOIN names n ON n.center = t.sales_center_code
WHERE t.stat_month = ANY(%(ym)s)
  AND t.org_type = '业务单位'
  AND t.sales_center_code IN (SELECT center FROM centers)
GROUP BY t.sales_center_code
"""


def target_overview(run, ctx: ReplayContext) -> dict:
    y = ctx.as_of.year
    doy = ctx.as_of.timetuple().tm_yday
    days_in_year = 366 if calendar.isleap(y) else 365
    ym = [f"{y}-{m:02d}" for m in range(1, ctx.as_of.month + 1)]
    ly_ym = [f"{y - 1}-{m:02d}" for m in range(1, ctx.as_of.month + 1)]
    calday = ctx.calday()
    ly_calday = calday.replace(str(y), str(y - 1), 1)   # 上年同日封顶=同窗对比
    year_binds = {"ym": ym, "as_of_calday": calday}
    ly_binds = {"ly_ym": ly_ym, "ly_as_of_calday": ly_calday}

    out = {"asOf": ctx.as_of.isoformat(), "year": y,
           "annual": {"available": False, "reason": "未执行"}, "projection": None,
           "months": {"available": False, "reason": "未执行"},
           "centers": {"available": False, "reason": "未执行"},
           "centersTotalBehindWan": None}

    # annual（D-t6 同源：与 health._target_block 走同一 TargetDetector.trend，数字逐位一致）
    annual = None
    try:
        t = TargetDetector().trend(run, ctx, "瓷砖事业部|ALL")
        meta = t.get("meta", {})
        if not meta.get("cum_target_wan"):
            out["annual"] = {"available": False, "reason": "缺目标数据：cum_target_wan 为空"}
        else:
            last = t["series"][-1]
            annual = {"achievePct": last["cur"], "actualWan": meta["cum_actual_wan"],
                      "targetWan": meta["cum_target_wan"], "timePct": last["prev"],
                      "timeBasis": "年日内自然日占比"}
            out["annual"] = annual
    except Exception as e:
        out["annual"] = {"available": False, "reason": repr(e)[:120]}

    # projection（D-t1 确定性线性年化；依赖 annual，annual 不可用→null；公式随响应下发）
    if annual is not None:
        try:
            daily = annual["actualWan"] / doy
            projected = daily * days_in_year
            out["projection"] = {"dailyWan": round(daily, 1),
                                 "projectedWan": round(projected, 1),
                                 "projectedGapWan": round(annual["targetWan"] - projected, 1),
                                 "basis": "YTD 实绩 ÷ 年内已过自然日 × 全年自然日（线性年化）"}
        except Exception:
            out["projection"] = None

    # months（完整月=全月实绩；当月 MTD=calday 封顶；目标 0/NULL→null 不造；当月行附月度工作日进度）
    try:
        acts = {r["month"]: r["wan"] for r in run(ACTUAL_SQL, year_binds)}
        ly_acts = {r["month"]: r["wan"] for r in run(LY_ACTUAL_SQL, ly_binds)}
        tgts = {r["month"]: r["wan"] for r in run(TARGET_SQL, {"ym": ym})}
        rows = []
        for m in range(1, ctx.as_of.month + 1):
            key, ly_key = f"{y}-{m:02d}", f"{y - 1}-{m:02d}"
            a, t, p = acts.get(key), tgts.get(key), ly_acts.get(ly_key)
            row = {"month": key,
                   "actualWan": round(a, 1) if a is not None else None,
                   "targetWan": round(t, 1) if t is not None else None,
                   "achievePct": round(a / t * 100, 1) if (a is not None and t) else None,
                   "yoyPct": round((a - p) / p * 100, 1) if (a is not None and p) else None,
                   "isCurrent": m == ctx.as_of.month}
            if row["isCurrent"]:
                row["timePct"] = time_progress_pct(ctx.as_of, "workday", None)
            rows.append(row)
        out["months"] = rows
    except Exception as e:
        out["months"] = {"available": False, "reason": repr(e)[:120]}

    # centers（D-t2 欠进度额=目标×时间进度%−实绩，与雷达 abs_gap 同语义；占比分母只计落后者；
    # D-t3 恢复潜力=该中心(上年同期日均−当前日均)×剩余自然日，max0 截断；按欠进度额降序）
    try:
        lag = TargetDetector().cfg["params"]["center_set_month_lag"]   # 与 TREND_TARGET_SQL 同源
        center_binds = {"ym": ym,
                        "center_set_month_ym": shift_month(ctx.as_of, -lag).strftime("%Y-%m")}
        ca = {r["center"]: r["wan"] for r in run(CENTER_ACTUAL_SQL, year_binds)}
        cly = {r["center"]: r["wan"] for r in run(CENTER_LY_SQL, ly_binds)}
        trows = run(CENTER_TARGET_SQL, center_binds)
        tp = round(doy / days_in_year * 100, 1)   # 年日进度（behindWan 公式因子）
        rows = []
        for r in trows:
            code = r["center"]
            aw = ca.get(code) or 0.0
            tw = r["wan"] or 0.0
            ly_amt = cly.get(code)
            rows.append({"centerCode": code, "centerName": r.get("cname"),
                         "actualWan": round(aw, 1), "targetWan": round(tw, 1),
                         "achievePct": round(aw / tw * 100, 1) if tw else None,
                         "timePct": tp,
                         "behindWan": round(tw * tp / 100 - aw, 1),
                         "behindSharePct": 0.0,   # 先算 Σ落后者分母再回填占比
                         "recoveryWan": round(max(0.0, (ly_amt - aw) / doy)
                                              * (days_in_year - doy), 1)
                                         if ly_amt else 0.0})
        total_behind = round(sum(x["behindWan"] for x in rows if x["behindWan"] > 0), 1)
        for x in rows:
            if x["behindWan"] > 0 and total_behind:
                x["behindSharePct"] = round(x["behindWan"] / total_behind * 100, 1)
        rows.sort(key=lambda x: x["behindWan"], reverse=True)
        out["centers"] = rows
        out["centersTotalBehindWan"] = total_behind
    except Exception as e:
        out["centers"] = {"available": False, "reason": repr(e)[:120]}

    return out
