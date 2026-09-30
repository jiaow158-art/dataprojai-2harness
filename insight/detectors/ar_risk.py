# insight/detectors/ar_risk.py
"""应收风险雷达：自然账龄 90 天+ 应收 当月vs上月增量 + top5 集中度（anchor=customer）。

用户裁定 2026-09-24：数据源=dm.dm_ar_analysis_rpt_f（综合分析报表），node_desc2 直筛瓷砖。
当月为月内即时会计期间；缺当月/上月行 → not_ready，绝不以 0 代替。"""
from ..replay_ctx import ReplayContext, shift_month
from .base import DetectResult, Finding, load_config, percentile_score

_NAT90 = " + ".join(
    f"COALESCE({seg},0)" for seg in
    ("natural_receivables_91_180", "natural_receivables_181_275",
     "natural_receivables_276_365", "natural_receivables_366_730",
     "natural_receivables_731_1095", "natural_receivables_1095_1460",
     "natural_receivables_1461"))

PRESENCE_SQL = f"""
SELECT calmonth, COUNT(*) AS rows_
FROM dm.dm_ar_analysis_rpt_f
WHERE calmonth IN (%(cur_ym)s, %(prev_ym)s)
  AND calmonth <= %(cur_ym)s
  AND node_desc2 = '瓷砖事业部'
  AND (special_general_ledger IS NULL OR special_general_ledger = '')
GROUP BY 1
"""

DETAIL_SQL = f"""
SELECT cust_code, MAX(cust_name) AS cust_name,
       SUM(CASE WHEN calmonth = %(cur_ym)s THEN {_NAT90} END) / 10000 AS over90,
       SUM(CASE WHEN calmonth = %(prev_ym)s THEN {_NAT90} END) / 10000 AS prev_over90,
       SUM(CASE WHEN calmonth = %(cur_ym)s THEN COALESCE(overdue_receivables, 0) END) / 10000 AS overdue_cur
FROM dm.dm_ar_analysis_rpt_f
WHERE calmonth IN (%(cur_ym)s, %(prev_ym)s)
  AND calmonth <= %(cur_ym)s
  AND node_desc2 = '瓷砖事业部'
  AND (special_general_ledger IS NULL OR special_general_ledger = '')
GROUP BY 1
"""

TREND_SQL = f"""
SELECT calmonth AS month,
       SUM({_NAT90}) / 10000 AS nat90_wan
FROM dm.dm_ar_analysis_rpt_f
WHERE calmonth = ANY(%(ym)s)
  AND calmonth <= %(cur_ym)s
  AND node_desc2 = '瓷砖事业部'
  AND (special_general_ledger IS NULL OR special_general_ledger = '')
GROUP BY 1 ORDER BY 1
"""

class ArRiskDetector:
    def __init__(self, cfg: dict | None = None):
        self.cfg = cfg or load_config("ar_risk")

    @classmethod
    def for_test(cls):
        cfg = load_config("ar_risk")
        # 单测数据为玩具量级（total≈980 万），生产阈值（2000 万，待回测校准）会吞掉
        # 全部场景 → 测试构造路径降到 300，生产路径（load_config/构造注入）不受影响。
        cfg["params"]["delta_threshold_wan"] = 300
        return cls(cfg)

    def check_watermark(self, run, ctx: ReplayContext):
        from ..watermark import Dependency, check_dependency
        return [check_dependency(Dependency(**d), run, ctx) for d in self.cfg["deps"]]

    def detect(self, run, ctx: ReplayContext) -> DetectResult:
        p = self.cfg["params"]
        cur_ym, prev_ym = ctx.ym(), ctx.prev_month_ym()
        binds = {"cur_ym": cur_ym, "prev_ym": prev_ym}
        present = {r["calmonth"] for r in run(PRESENCE_SQL, binds)}
        if cur_ym not in present or prev_ym not in present:
            return DetectResult(self.cfg["name"], "not_ready",
                                note=f"期间缺数据：cur={cur_ym in present} prev={prev_ym in present}")
        rows = run(DETAIL_SQL, binds)
        deltas = []
        overdue_cur = 0.0
        for r in rows:
            if r["over90"] is None or r["prev_over90"] is None:
                continue                      # 单侧月缺失的客户跳过（非 0）
            overdue_cur += r["overdue_cur"] or 0
            d = round(r["over90"] - r["prev_over90"], 1)
            if d > 0:
                deltas.append((r, d))
        total = round(sum(d for _, d in deltas), 1)
        findings = []
        if total >= p["delta_threshold_wan"]:
            top = sorted(deltas, key=lambda x: (-x[1], x[0]["cust_code"]))[:5]
            share = round(sum(d for _, d in top) / total * 100)
            findings.append(Finding(
                detector=self.cfg["name"], data_date=ctx.as_of.isoformat(),
                dim_keys={"anchor_type": "customer", "anchor_id": "瓷砖|nat90", "channel": None},
                metrics={"delta_wan": total, "top5_share_pct": share,
                         "current_period": cur_ym, "previous_period": prev_ym,
                         "top_customers": [{"code": r["cust_code"], "name": r["cust_name"],
                                            "delta_wan": d} for r, d in top],
                         "abs_delta_wan": total,
                         "overdue_wan_cur": round(overdue_cur, 1)},   # facet：当月逾期合计
                norm_score=percentile_score(total, self.cfg["norm"]["baseline_wan"])))
        return DetectResult(self.cfg["name"], "ok", findings=findings)

    def trend(self, run, ctx: ReplayContext, anchor_id: str, months: int = 12) -> dict:
        """BU 级 nat90 月度余额序列（spec §4.1 kind=month_single）。窗口含当月即时快照
        （ar 与销售/毛利不同：detect 本身就用当月，趋势同语义）。anchor 仅保持签名一致。"""
        ym = [shift_month(ctx.as_of, -i).strftime("%Y-%m") for i in range(months - 1, -1, -1)]
        rows = run(TREND_SQL, {"ym": ym, "cur_ym": ctx.ym()})
        return {"detector": self.cfg["name"], "anchor_id": anchor_id, "unit": "万元",
                "kind": "month_single",
                "series": [{"month": r["month"], "cur": r["nat90_wan"], "prev": None}
                           for r in rows]}
