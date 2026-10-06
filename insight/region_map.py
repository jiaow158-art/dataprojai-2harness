# insight/region_map.py
"""区域作战地图聚合（M-i8，spec 2026-10-06 §3/§4，D-r1~D-r6）。纯聚合：DWS 三条
有界查询经 run 注入；active 事件列表与全国达成率（M-i7 target 同源）由端点层注入，
本模块不碰 db。五块（national/regions/provinces/regionTrend/regionEvents）各自
try/except 局部降级；金额万元 round 1。

- 同窗同比（D-r4）：当年 1..as_of 月（当月 calday 封顶=MTD）vs 上年同 ym+上年同日
  封顶——与 target_report 的 LY 法一致；分母 0/NULL → yoyPct null
- 大区映射（D-r3）：config/region-map.json 权威；NULL→未分区；表外国内值（后缀
  变体/台港澳兜底）→未分区+unmappedProvinces 披露不静默吞；其余表外非 NULL→海外
- level（D-r1）：decline ≤-8 / watch (-8,0) / growth ≥0 / unknown null（服务端判定）
- grossMarginPct：窗内 gross_profit_after_sharing 之和 / notax_sales_net_amt 之和
- regionTrend：近 12 自然月逐月实绩（完整月全月、当月 MTD）按大区补齐；未分区/海外不入
- regionEvents（D-r5）：center×province 当月销售推 center→regionSet（node_desc5=
  中心名，与事件 org 同名域）；org 命中→其 regionSet（空集=不关联）；org 无命中
  （BU 级）→全部国内七区；每区按 score 降序 top5
"""
import json
from pathlib import Path

from .replay_ctx import ReplayContext, shift_month

_cfg = json.loads((Path(__file__).parent / "config" / "region-map.json")
                  .read_text(encoding="utf-8"))
REGION_OF_PROV: dict[str, str] = {p: r for r, ps in _cfg["regions"].items() for p in ps}
DOMESTIC_REGIONS: list[str] = list(_cfg["regions"].keys())
_DOMESTIC_SET = set(DOMESTIC_REGIONS)
UNMAPPED, OVERSEAS = _cfg["specialRegions"]                  # ["未分区", "海外"]

# 表外国内兜底：config 31 值之外仍属国内行政单位的值（台港澳；"广东省"式后缀变体）
_DOMESTIC_EXTRA = {"台湾", "香港", "澳门"}
_DOMESTIC_SUFFIXES = ("省", "市")

# Q1 省份双年同窗：一次扫描，CASE WHEN 分窗（外层 OR 谓词把扫描裁剪到两窗并集）
PROVINCE_SQL = """
SELECT m.region_province_name AS prov,
       SUM(CASE WHEN m.calmonth = ANY(%(ym)s) AND m.calday <= %(as_of_calday)s
                THEN m.ambperformance END) AS cur_amt,
       SUM(CASE WHEN m.calmonth = ANY(%(ly_ym)s) AND m.calday <= %(ly_as_of_calday)s
                THEN m.ambperformance END) AS ly_amt,
       SUM(CASE WHEN m.calmonth = ANY(%(ym)s) AND m.calday <= %(as_of_calday)s
                THEN m.gross_profit_after_sharing END) AS gp,
       SUM(CASE WHEN m.calmonth = ANY(%(ym)s) AND m.calday <= %(as_of_calday)s
                THEN m.notax_sales_net_amt END) AS net_amt
FROM dm.dm_fin_operations_mix_sum_t m
WHERE m.node_desc2 = '瓷砖事业部'
  AND m.data_source IN ('S','T','D','')
  AND ( (m.calmonth = ANY(%(ym)s) AND m.calday <= %(as_of_calday)s)
     OR (m.calmonth = ANY(%(ly_ym)s) AND m.calday <= %(ly_as_of_calday)s) )
GROUP BY m.region_province_name
"""

# Q2 大区×月趋势：近 12 自然月实绩（完整月全月、当月 calday 封顶=MTD；不做同比）
TREND_SQL = """
SELECT m.calmonth AS month, m.region_province_name AS prov,
       SUM(m.ambperformance) AS trend_amt
FROM dm.dm_fin_operations_mix_sum_t m
WHERE m.calmonth = ANY(%(trend_ym)s)
  AND m.calday <= %(as_of_calday)s
  AND m.node_desc2 = '瓷砖事业部'
  AND m.data_source IN ('S','T','D','')
GROUP BY 1, 2
"""

# Q3 中心×省份当月销售：推 center→regionSet。node_desc5=中心名（事件 org 同名域；
# node_name5 是 H05… 码，按码分组永远命不中中心名）
CENTER_PROV_SQL = """
SELECT m.node_desc5 AS center, m.region_province_name AS prov,
       SUM(m.ambperformance) AS cp_amt
FROM dm.dm_fin_operations_mix_sum_t m
WHERE m.calmonth = %(cur_ym)s
  AND m.calday <= %(as_of_calday)s
  AND m.node_desc2 = '瓷砖事业部'
  AND m.data_source IN ('S','T','D','')
GROUP BY 1, 2
"""


def _classify(prov):
    """→ (region, unmapped_domestic)。NULL/''→未分区；映射内→大区；后缀变体/
    台港澳兜底→(未分区, True) 披露；其余表外非 NULL→海外。"""
    if not prov:
        return UNMAPPED, False
    if prov in REGION_OF_PROV:
        return REGION_OF_PROV[prov], False
    for suf in _DOMESTIC_SUFFIXES:
        if prov.endswith(suf) and prov[: -len(suf)] in REGION_OF_PROV:
            return UNMAPPED, True
    if prov in _DOMESTIC_EXTRA:
        return UNMAPPED, True
    return OVERSEAS, False


def _level(yoy):
    if yoy is None:
        return "unknown"
    if yoy <= -8.0:                       # D-r1：阈值与 region_sales 雷达一致
        return "decline"
    return "watch" if yoy < 0 else "growth"


def _aggregate(rows):
    """Q1 行 → (大区聚合, 省份行素材, 表外国内披露)。金额单位元。"""
    agg = {r: {"cur": 0.0, "ly": 0.0, "gp": 0.0, "net": 0.0, "has_gp": False, "n": 0}
           for r in DOMESTIC_REGIONS + _cfg["specialRegions"]}
    provs, unmapped = [], []
    for row in rows:
        region, is_unmapped = _classify(row["prov"])
        g = agg[region]
        cur = row["cur_amt"] or 0.0
        ly_raw = row["ly_amt"]
        g["cur"] += cur
        g["ly"] += ly_raw or 0.0
        if row["gp"] is not None:                 # 毛利缺=不造 0（has_gp 门 null）
            g["gp"] += row["gp"]
            g["has_gp"] = True
        g["net"] += row["net_amt"] or 0.0
        g["n"] += 1
        provs.append({"prov": row["prov"], "region": region, "cur": cur,
                      "ly": ly_raw or 0.0, "ly_raw": ly_raw})
        if is_unmapped:
            unmapped.append((row["prov"], cur))
    return agg, provs, unmapped


def region_map(run, ctx: ReplayContext, events, achieve_pct) -> dict:
    y = ctx.as_of.year
    ym = [f"{y}-{m:02d}" for m in range(1, ctx.as_of.month + 1)]
    ly_ym = [f"{y - 1}-{m:02d}" for m in range(1, ctx.as_of.month + 1)]
    calday = ctx.calday()
    ly_calday = calday.replace(str(y), str(y - 1), 1)     # 上年同日封顶=同窗对比
    m0 = shift_month(ctx.as_of.replace(day=1), -11)
    months = [shift_month(m0, i).strftime("%Y-%m") for i in range(12)]

    out = {"asOf": ctx.as_of.isoformat(),
           "window": f"{y}-01-01 ~ {ctx.as_of.isoformat()}（双年同窗）",
           "national": {"available": False, "reason": "未执行"},
           "regions": {"available": False, "reason": "未执行"},
           "provinces": {"available": False, "reason": "未执行"},
           "unmappedProvinces": [],
           "regionTrend": {"available": False, "reason": "未执行"},
           "regionEvents": {"available": False, "reason": "未执行"}}

    # Q1 只跑一次；三块共享，失败原因带回各块的降级 reason
    rows, q1_err = None, None
    try:
        rows = run(PROVINCE_SQL,
                   {"ym": ym, "ly_ym": ly_ym, "as_of_calday": calday,
                    "ly_as_of_calday": ly_calday})
    except Exception as e:
        q1_err = repr(e)[:120]

    def _ready():
        if rows is None:
            raise RuntimeError(q1_err)
        return _aggregate(rows)

    # national（省份求和含未分区/海外）
    try:
        agg, _, _ = _ready()
        cur = sum(g["cur"] for g in agg.values())
        ly = sum(g["ly"] for g in agg.values())
        gp = sum(g["gp"] for g in agg.values())
        net = sum(g["net"] for g in agg.values())
        out["national"] = {
            "ytdWan": round(cur / 10000, 1), "lyWan": round(ly / 10000, 1),
            "yoyPct": round((cur - ly) / ly * 100, 1) if ly else None,
            "grossMarginPct": round(gp / net * 100, 1)
                              if (any(g["has_gp"] for g in agg.values()) and net) else None,
            "achievePct": achieve_pct}
    except Exception as e:
        out["national"] = {"available": False, "reason": repr(e)[:120]}

    # regions（七区按 ytdWan 降序，未分区/海外恒尾；无数据组不造行）
    try:
        agg, _, _ = _ready()
        tot = sum(g["cur"] for g in agg.values())
        rows_out = []
        for r in (sorted((r for r in DOMESTIC_REGIONS if agg[r]["n"]),
                         key=lambda r: (-agg[r]["cur"], r))
                  + [r for r in _cfg["specialRegions"] if agg[r]["n"]]):
            g = agg[r]
            yoy = round((g["cur"] - g["ly"]) / g["ly"] * 100, 1) if g["ly"] else None
            rows_out.append({"region": r,
                             "ytdWan": round(g["cur"] / 10000, 1),
                             "lyWan": round(g["ly"] / 10000, 1),
                             "yoyPct": yoy,
                             "sharePct": round(g["cur"] / tot * 100, 1) if tot else None,
                             "grossMarginPct": round(g["gp"] / g["net"] * 100, 1)
                                               if (g["has_gp"] and g["net"]) else None,
                             "level": _level(yoy)})
        out["regions"] = rows_out
    except Exception as e:
        out["regions"] = {"available": False, "reason": repr(e)[:120]}

    # provinces（省份行：国内降序在前，海外、未分区组行恒尾）+ 表外国内披露
    try:
        _, provs, unmapped = _ready()
        grp = {UNMAPPED: 2, OVERSEAS: 1}
        provs = sorted(provs, key=lambda p: (grp.get(p["region"], 0), -p["cur"], p["prov"] or ""))
        out["provinces"] = [{"prov": p["prov"] or UNMAPPED, "region": p["region"],
                             "ytdWan": round(p["cur"] / 10000, 1),
                             "lyWan": round(p["ly"] / 10000, 1),
                             "yoyPct": round((p["cur"] - p["ly"]) / p["ly"] * 100, 1)
                                       if p["ly_raw"] else None}
                            for p in provs]
        out["unmappedProvinces"] = [u[0] for u in sorted(unmapped, key=lambda u: (-u[1], u[0]))]
    except Exception as e:
        out["provinces"] = {"available": False, "reason": repr(e)[:120]}

    # regionTrend：近 12 自然月按大区补齐（缺月=0 实绩）；未分区/海外不入
    try:
        trows = run(TREND_SQL, {"trend_ym": months, "as_of_calday": calday})
        amt: dict[tuple[str, str], float] = {}
        for r in trows:
            region, _ = _classify(r["prov"])
            if region in _DOMESTIC_SET:
                k = (region, r["month"])
                amt[k] = amt.get(k, 0.0) + (r["trend_amt"] or 0.0)
        out["regionTrend"] = {
            "months": months,
            "series": {r: [{"month": m, "wan": round(amt.get((r, m), 0.0) / 10000, 1)}
                           for m in months]
                       for r in DOMESTIC_REGIONS}}
    except Exception as e:
        out["regionTrend"] = {"available": False, "reason": repr(e)[:120]}

    # regionEvents（D-r5）：Q3 推 center→regionSet；命中→其集合（空集=不关联，
    # 如中心当月只在未分区/海外有售）；org 无命中（BU 级）→全部国内七区
    try:
        crows = run(CENTER_PROV_SQL, {"cur_ym": ctx.ym(), "as_of_calday": calday})
        center_regions: dict[str, set] = {}
        for r in crows:
            regions = center_regions.setdefault(r["center"], set())
            region, _ = _classify(r["prov"])
            if r["cp_amt"] and region in _DOMESTIC_SET:
                regions.add(region)
        buckets = {r: [] for r in DOMESTIC_REGIONS}
        for ev in events or []:
            targets = center_regions.get(ev.get("org"))
            if targets is None:
                targets = _DOMESTIC_SET                     # BU 级 → 全部国内七区
            for r in targets:
                buckets[r].append({"event_id": ev.get("event_id"), "title": ev.get("title"),
                                   "severity": ev.get("severity"), "score": ev.get("score"),
                                   "org": ev.get("org")})
        for r in DOMESTIC_REGIONS:
            buckets[r].sort(key=lambda e: (-(e["score"] or 0.0), e["event_id"] or ""))
            buckets[r] = buckets[r][:5]
        out["regionEvents"] = buckets
    except Exception as e:
        out["regionEvents"] = {"available": False, "reason": repr(e)[:120]}

    return out
