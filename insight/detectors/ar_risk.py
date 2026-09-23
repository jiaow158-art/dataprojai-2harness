# insight/detectors/ar_risk.py
"""应收风险雷达：90 天+ 双侧最新快照增量 + top5 集中度（anchor=customer）。

裁定 #11：当前/对比快照各取 <= bound 的最新一份；找不到对比快照 →
insufficient_history，绝不以 0 代替（防巨额假新增）。"""
from datetime import date, datetime
from ..replay_ctx import ReplayContext
from .base import DetectResult, Finding, load_config, percentile_score

_OVER90 = " + ".join(
    f"COALESCE({seg}_{fam},0)"
    for seg in ("overdue_receivables_91_275_day", "overdue_receivables_276_730_day",
                "overdue_receivables_731_1460_day", "overdue_receivables_1461_day")
    for fam in ("2023_after", "2023_ago"))

SNAP_SQL = f"""
SELECT MAX(query_date) AS snap
FROM dwrfin.dwr_ar_receivable_aging_2023_info_f
WHERE query_date <= %(bound)s
  AND comp_code = ANY(%(comp_codes)s)
  AND (special_general_ledger IS NULL OR special_general_ledger = '')
"""

DETAIL_SQL = f"""
WITH snap AS (
  SELECT query_date, cust_code, MAX(cust_name) AS cust_name,
         SUM({_OVER90}) / 10000 AS over90
  FROM dwrfin.dwr_ar_receivable_aging_2023_info_f
  WHERE query_date IN (%(cur_snap)s, %(prev_snap)s)
    AND query_date <= %(as_of_iso)s
    AND comp_code = ANY(%(comp_codes)s)
    AND (special_general_ledger IS NULL OR special_general_ledger = '')
  GROUP BY 1, 2
)
SELECT cust_code, MAX(cust_name) AS cust_name,
       MAX(CASE WHEN query_date = %(cur_snap)s THEN over90 END) AS over90,
       MAX(CASE WHEN query_date = %(prev_snap)s THEN over90 END) AS prev_over90
FROM snap GROUP BY 1
"""

def _as_date(v) -> date | None:
    if v is None:
        return None
    if isinstance(v, datetime):     # datetime 是 date 子类，须先剥（防 isoformat 带 T00:00:00）
        return v.date()
    return v if isinstance(v, date) else datetime.strptime(str(v), "%Y-%m-%d").date()

class ArRiskDetector:
    def __init__(self, cfg: dict | None = None):
        self.cfg = cfg or load_config("ar_risk")

    @classmethod
    def for_test(cls):
        return cls(load_config("ar_risk"))

    def check_watermark(self, run, ctx: ReplayContext):
        from ..watermark import Dependency, check_dependency
        return [check_dependency(Dependency(**d), run, ctx) for d in self.cfg["deps"]]

    def detect(self, run, ctx: ReplayContext) -> DetectResult:
        p = self.cfg["params"]
        binds = {"comp_codes": p["comp_codes"]}
        cur_snap = _as_date(run(SNAP_SQL, {"bound": ctx.iso(), **binds})[0]["snap"])
        prev_bound = ctx.minus_days(p["prev_lag_days"]).isoformat()
        prev_snap = _as_date(run(SNAP_SQL, {"bound": prev_bound, **binds})[0]["snap"])
        if cur_snap is None or prev_snap is None or prev_snap >= cur_snap:
            return DetectResult(self.cfg["name"], "insufficient_history",
                                note=f"cur_snap={cur_snap} prev_bound={prev_bound} prev_snap={prev_snap}")
        rows = run(DETAIL_SQL, {"cur_snap": cur_snap.isoformat(),
                                "prev_snap": prev_snap.isoformat(),
                                "as_of_iso": ctx.iso(), **binds})
        deltas = []
        for r in rows:
            cur, prev = r["over90"], r["prev_over90"]
            if cur is None or prev is None:
                continue
            d = round(cur - prev, 1)
            if d > 0:
                deltas.append((r, d))
        total = round(sum(d for _, d in deltas), 1)
        findings = []
        if total >= p["delta_threshold_wan"]:
            top = sorted(deltas, key=lambda x: (-x[1], x[0]["cust_code"]))[:5]  # tie-break 确定性
            share = round(sum(d for _, d in top) / total * 100)
            findings.append(Finding(
                detector=self.cfg["name"], data_date=ctx.as_of.isoformat(),
                dim_keys={"anchor_type": "customer", "anchor_id": "瓷砖|over90", "channel": None},
                metrics={"delta_wan": total, "top5_share_pct": share,
                         "current_snapshot_date": cur_snap.isoformat(),
                         "previous_snapshot_date": prev_snap.isoformat(),
                         "top_customers": [{"code": r["cust_code"], "name": r["cust_name"],
                                            "delta_wan": d} for r, d in top],
                         "abs_delta_wan": total},
                norm_score=percentile_score(total, self.cfg["norm"]["baseline_wan"])))
        return DetectResult(self.cfg["name"], "ok", findings=findings)
