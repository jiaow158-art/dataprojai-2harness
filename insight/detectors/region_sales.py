# insight/detectors/region_sales.py
"""区域×渠道业绩雷达：连续 N 个完整自然月同比下滑（裁定 #14；ct 月末快照 exact）。"""
from ..replay_ctx import ReplayContext
from .base import DetectResult, Finding, load_config, percentile_score

SQL = """
SELECT to_char(to_date(p.calday, 'YYYYMMDD'), 'YYYY-MM') AS month,
       s.node_desc5 AS org_name, p.integrate_channel AS channel,
       SUM(p.month_achievement) AS cur_amt,
       SUM(p.{ly_field}) AS ly_amt
FROM dm.ct_sales_performance_t p
JOIN dm.dm_rpt_sales_group_t s
  ON p.org_code = s.node_name10 AND s.node_desc2 = '瓷砖事业部'
WHERE p.calday = ANY(%(month_ends)s)
  AND p.calday <= %(as_of_calday)s
GROUP BY 1, 2, 3
"""

class RegionSalesDetector:
    def __init__(self, cfg: dict | None = None):
        self.cfg = cfg or load_config("region_sales")

    @classmethod
    def for_test(cls):
        cfg = load_config("region_sales")
        # 单测数据为玩具量级（ly_amt≈1 万），生产规模门槛（2000 万）会吞掉全部场景 →
        # 测试构造路径禁用该门槛，生产路径（load_config/构造注入）不受影响。
        cfg["params"]["min_ly_amt"] = 0.0
        return cls(cfg)

    def check_watermark(self, run, ctx: ReplayContext):
        from ..watermark import Dependency, check_dependency
        return [check_dependency(Dependency(**d), run, ctx) for d in self.cfg["deps"]]

    def detect(self, run, ctx: ReplayContext) -> DetectResult:
        p = self.cfg["params"]
        n = p["consecutive_months"]
        ends = ctx.completed_month_ends(n)
        rows = run(SQL.format(ly_field=p["ly_field"]),
                   {"month_ends": [e.strftime("%Y%m%d") for e in ends],
                    "as_of_calday": ctx.calday()})
        expected = [e.strftime("%Y-%m") for e in ends]
        by_key: dict[tuple, dict[str, dict]] = {}
        for r in rows:
            by_key.setdefault((r["org_name"], r["channel"]), {})[r["month"]] = r
        findings: list[Finding] = []
        for (org, ch), months in by_key.items():
            if sorted(months) != expected:            # 缺任一完整月 → 不构成"连续"
                continue
            seq = [months[m] for m in expected]
            if any((r["ly_amt"] or 0) < p["min_ly_amt"] for r in seq):
                continue
            yoys = [(r["cur_amt"] - r["ly_amt"]) / r["ly_amt"] * 100 for r in seq]
            if all(y < p["yoy_threshold_pct"] for y in yoys):
                delta_wan = abs(seq[-1]["cur_amt"] - seq[-1]["ly_amt"]) / 10000
                findings.append(Finding(
                    detector=self.cfg["name"], data_date=ctx.as_of.isoformat(),
                    dim_keys={"anchor_type": "org_channel",
                              "anchor_id": f"{org}|{ch}", "channel": ch},
                    metrics={"yoy_pct": round(yoys[-1], 1), "consecutive": n,
                             "abs_delta_wan": round(delta_wan), "months": expected},
                    norm_score=percentile_score(delta_wan, self.cfg["norm"]["baseline_wan"])))
        return DetectResult(self.cfg["name"], "ok", findings=findings)
