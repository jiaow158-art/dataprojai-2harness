# insight/detectors/gross_margin.py
"""毛利雷达：mix 渠道级毛利率 完整月环比（毛利=分成后毛利/不含税净额）。"""
from ..replay_ctx import ReplayContext
from .base import DetectResult, Finding, load_config, percentile_score

SQL = """
SELECT integrate_channel AS channel,
       SUM(CASE WHEN calmonth = %(cur_ym)s THEN gross_profit_after_sharing END) AS gp,
       SUM(CASE WHEN calmonth = %(cur_ym)s THEN notax_sales_net_amt END) AS net_amt,
       SUM(CASE WHEN calmonth = %(prev_ym)s THEN gross_profit_after_sharing END) AS prev_gp,
       SUM(CASE WHEN calmonth = %(prev_ym)s THEN notax_sales_net_amt END) AS prev_net_amt
FROM dm.dm_fin_operations_mix_sum_t
WHERE calmonth IN (%(cur_ym)s, %(prev_ym)s)
  AND calmonth <= %(cur_ym)s
  AND node_desc2 = '瓷砖事业部'
  AND data_source IN ('S','T','D','')
GROUP BY 1
"""

TREND_SQL = """
SELECT calmonth AS month,
       SUM(gross_profit_after_sharing) AS gp,
       SUM(notax_sales_net_amt) AS net_amt
FROM dm.dm_fin_operations_mix_sum_t
WHERE calmonth = ANY(%(ym)s)
  AND calmonth <= %(cur_ym)s
  AND node_desc2 = '瓷砖事业部'
  AND data_source IN ('S','T','D','')
  AND integrate_channel = %(channel)s
GROUP BY 1 ORDER BY 1
"""

class GrossMarginDetector:
    def __init__(self, cfg: dict | None = None):
        self.cfg = cfg or load_config("gross_margin")

    @classmethod
    def for_test(cls):
        return cls(load_config("gross_margin"))

    def check_watermark(self, run, ctx: ReplayContext):
        from ..watermark import Dependency, check_dependency
        return [check_dependency(Dependency(**d), run, ctx) for d in self.cfg["deps"]]

    def detect(self, run, ctx: ReplayContext) -> DetectResult:
        p = self.cfg["params"]
        ends = ctx.completed_month_ends(2)                 # [prev, cur]
        cur_ym, prev_ym = ends[1].strftime("%Y-%m"), ends[0].strftime("%Y-%m")
        rows = run(SQL, {"cur_ym": cur_ym, "prev_ym": prev_ym})
        findings = []
        for r in rows:
            if r["gp"] is None or r["net_amt"] in (None, 0) \
                    or r["prev_gp"] is None or r["prev_net_amt"] in (None, 0):
                continue
            gmp = r["gp"] / r["net_amt"] * 100
            prev_gmp = r["prev_gp"] / r["prev_net_amt"] * 100
            delta_pct = round(gmp - prev_gmp, 1)
            delta_wan = abs(r["gp"] - r["prev_gp"]) / 10000
            if delta_pct <= p["delta_threshold_pct"] and r["gp"] / 10000 >= p["min_gp_wan"]:
                findings.append(Finding(
                    detector=self.cfg["name"], data_date=ctx.as_of.isoformat(),
                    dim_keys={"anchor_type": "org_channel",
                              "anchor_id": f"瓷砖事业部|{r['channel']}",
                              "channel": r["channel"]},
                    metrics={"delta_pct": delta_pct, "gmp_pct": round(gmp, 1),
                             "prev_gmp_pct": round(prev_gmp, 1),
                             "abs_delta_wan": round(delta_wan)},
                    norm_score=percentile_score(delta_wan, self.cfg["norm"]["baseline_wan"])))
        return DetectResult(self.cfg["name"], "ok", findings=findings)

    def trend(self, run, ctx: ReplayContext, anchor_id: str, months: int = 12) -> dict:
        """渠道月度毛利率序列（spec §4.1 kind=month_single）。net=0/None → cur=None。"""
        _, _, ch = anchor_id.partition("|")
        ends = ctx.completed_month_ends(months)
        rows = run(TREND_SQL, {"ym": [e.strftime("%Y-%m") for e in ends],
                               "cur_ym": ctx.ym(), "channel": ch})
        return {"detector": self.cfg["name"], "anchor_id": anchor_id, "unit": "%",
                "kind": "month_single",
                "series": [{"month": r["month"], "cur": (
                                round(r["gp"] / r["net_amt"] * 100, 1)
                                if r["gp"] is not None and r["net_amt"] else None),
                            "prev": None} for r in rows]}
