# insight/health.py
"""经营健康度（spec §5，裁定 D-c1/D-c2）：确定性映射，分数=公式+输入+因子全可查。

三环各一次查询回 cur+prev 两期（无 per-ring 循环查库）；库存=未接入诚实态；
target 复用 TargetDetector.trend 的 meta。因子 config/health.json（台账纪律）。
任一环查询异常 → 该环 available:false+reason，其余照常（局部降级，不炸整卡）。"""
import json
from pathlib import Path

from .detectors.ar_risk import _NAT90
from .detectors.region_sales import RegionSalesDetector
from .detectors.target import TargetDetector
from .replay_ctx import ReplayContext

CONFIG = json.loads((Path(__file__).parent / "config" / "health.json")
                    .read_text(encoding="utf-8"))

SALES_SQL = f"""
SELECT to_char(to_date(p.calday, 'YYYYMMDD'), 'YYYY-MM') AS month,
       SUM(p.month_achievement) AS cur_amt,
       SUM(p.{RegionSalesDetector().cfg['params']['ly_field']}) AS ly_amt
FROM dm.ct_sales_performance_t p
JOIN dm.dm_rpt_sales_group_t s
  ON p.org_code = s.node_name10 AND s.node_desc2 = '瓷砖事业部'
WHERE p.calday = ANY(%(month_ends)s)
  AND p.calday <= %(as_of_calday)s
GROUP BY 1 ORDER BY 1
"""

MARGIN_SQL = """
SELECT calmonth AS month,
       SUM(gross_profit_after_sharing) AS gp,
       SUM(notax_sales_net_amt) AS net_amt
FROM dm.dm_fin_operations_mix_sum_t
WHERE calmonth = ANY(%(ym)s)
  AND calmonth <= %(cur_ym)s
  AND node_desc2 = '瓷砖事业部'
  AND data_source IN ('S','T','D','')
GROUP BY 1 ORDER BY 1
"""

AR_SQL = f"""
SELECT calmonth,
       SUM({_NAT90}) AS nat90,
       SUM(receivables_am) AS total
FROM dm.dm_ar_analysis_rpt_f
WHERE calmonth IN (%(cur_ym)s, %(prev_ym)s)
  AND calmonth <= %(cur_ym)s
  AND node_desc2 = '瓷砖事业部'
  AND (special_general_ledger IS NULL OR special_general_ledger = '')
GROUP BY 1
"""


def _clip(x: float) -> float:
    return min(100.0, max(0.0, x))


def _sales_ring(run, ctx) -> dict:
    k = CONFIG["sales"]["factor"]
    rows = run(SALES_SQL, {"month_ends": [e.strftime("%Y%m%d")
                                          for e in ctx.completed_month_ends(2)],
                           "as_of_calday": ctx.calday()})
    if len(rows) < 2 or any(r["ly_amt"] in (None, 0) or r["cur_amt"] is None for r in rows[-2:]):
        return {"available": False, "reason": "完整月同比数据不足"}
    prev, cur = rows[-2], rows[-1]
    yoy_prev = (prev["cur_amt"] - prev["ly_amt"]) / prev["ly_amt"] * 100
    yoy_cur = (cur["cur_amt"] - cur["ly_amt"]) / cur["ly_amt"] * 100
    s_prev = max(0.0, round(100 - _clip(-yoy_prev) * k, 1))
    s_cur = max(0.0, round(100 - _clip(-yoy_cur) * k, 1))
    return {"available": True, "score": s_cur, "mom_delta": round(s_cur - s_prev, 1),
            "formula": f"100 − 完整自然月同比降幅(pt) × {k}",
            "inputs": {"yoy_pct": round(yoy_cur, 1), "month": cur["month"]}}


def _margin_ring(run, ctx) -> dict:
    k = CONFIG["margin"]["factor"]
    rows = run(MARGIN_SQL, {"ym": [e.strftime("%Y-%m") for e in ctx.completed_month_ends(3)],
                            "cur_ym": ctx.ym()})
    gmp = [r["gp"] / r["net_amt"] * 100 for r in rows
           if r["gp"] is not None and r["net_amt"]]
    if len(gmp) < 3:
        return {"available": False, "reason": "完整月毛利率数据不足"}
    d1, d2 = round(gmp[1] - gmp[0], 1), round(gmp[2] - gmp[1], 1)   # 上月环比 / 当月环比
    s = lambda d: max(0.0, round(100 - _clip(-d) * k, 1))
    return {"available": True, "score": s(d2), "mom_delta": round(s(d2) - s(d1), 1),
            "formula": f"100 − 毛利率环比降幅(pt) × {k}",
            "inputs": {"delta_pct": d2, "month": rows[-1]["month"]}}


def _ar_ring(run, ctx) -> dict:
    rows = {r["calmonth"]: r for r in run(AR_SQL, {"cur_ym": ctx.ym(),
                                                   "prev_ym": ctx.prev_month_ym()})}
    cur, prev = rows.get(ctx.ym()), rows.get(ctx.prev_month_ym())
    if not cur or not prev or not (cur["total"] or 0) or not (prev["total"] or 0):
        return {"available": False, "reason": "当月/上月应收快照缺失"}
    share = lambda r: r["nat90"] / r["total"] * 100
    s_cur, s_prev = round(share(cur), 1), round(share(prev), 1)
    sc, sp = max(0.0, round(100 - s_cur, 1)), max(0.0, round(100 - s_prev, 1))
    return {"available": True, "score": sc,
            "mom_delta": round(sc - sp, 1),
            "formula": "100 − nat90 占应收余额比例(%)",
            "inputs": {"nat90_share_pct": s_cur, "month": ctx.ym()}}


def _target_block(run, ctx) -> dict | None:
    t = TargetDetector().trend(run, ctx, "瓷砖事业部|ALL")
    meta = t.get("meta", {})
    if not meta.get("cum_target_wan"):
        return None
    last = t["series"][-1]
    return {"year": ctx.as_of.year, "achieve_pct": last["cur"],
            "actual_wan": meta["cum_actual_wan"], "annual_target_wan": meta["cum_target_wan"],
            "time_pct": last["prev"]}


def compute(run, ctx: ReplayContext) -> dict:
    """三环+库存+目标。环级 try/except 局部降级（spec §4.2）。"""
    rings, builders = [], {"sales": _sales_ring, "margin": _margin_ring, "ar": _ar_ring}
    labels = {"sales": "销售健康度", "margin": "毛利健康度", "ar": "应收健康度"}
    for key in ("sales", "margin", "ar"):
        try:
            ring = builders[key](run, ctx)
        except Exception as e:
            ring = {"available": False, "reason": repr(e)[:120]}
        rings.append({"key": key, "label": labels[key], **ring})
    rings.append({"key": "inventory", "label": "库存健康度",
                  "available": False, "reason": CONFIG["inventory_reason"]})
    target = None
    try:
        target = _target_block(run, ctx)
    except Exception:
        target = None
    return {"as_of": ctx.as_of.isoformat(), "rings": rings, "target": target}
