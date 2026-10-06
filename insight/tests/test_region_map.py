# M-i8 区域作战地图聚合（spec 2026-10-06 §3/§4，D-r1~D-r6）：同窗同比数学 /
# 大区映射三档 / NULL 未分区 / 海外归类 / unmapped 披露 / 趋势补月 / 事件关联三态 / 局部降级
from datetime import date

from insight.replay_ctx import ReplayContext
from insight.region_map import region_map

CTX = ReplayContext(as_of=date(2026, 9, 22))   # 当年 1-8 完整月 + 9 月 MTD；上年同窗封 2025-09-22
SEVEN = ["华南", "华东", "华中", "华北", "西北", "西南", "东北"]


def _prov(prov, cur, ly, gp=None, net=None):
    """万元 → 元（Q1 返回元单位）。"""
    return {"prov": prov,
            "cur_amt": cur * 10000 if cur is not None else None,
            "ly_amt": ly * 10000 if ly is not None else None,
            "gp": gp * 10000 if gp is not None else None,
            "net_amt": net * 10000 if net is not None else None}


def _runner(provs=None, trend=None, cp=None, fail_on=None, params_log=None):
    def run(sql, params=None):
        marker = next((m for m in ("AS cur_amt", "AS trend_amt", "AS cp_amt") if m in sql), "?")
        if params_log is not None:
            params_log.append((marker, params))
        if fail_on and fail_on in sql:
            raise RuntimeError("dws down")
        if marker == "AS cur_amt":
            return [dict(r) for r in (provs or [])]
        if marker == "AS trend_amt":
            return [dict(r) for r in (trend or [])]
        if marker == "AS cp_amt":
            return [dict(r) for r in (cp or [])]
        return []
    return run


# —— 主 fixture（万元）：华南（广东+广西+海南，海南当年无销售）/ 华东（上海+江苏）/
# 未分区（NULL）/ 海外（越南，无上年）；毛利用"省份比率不同"证明分子和/分母和 ——
MAIN_PROVS = [
    _prov("广东", 10000.0, 8000.0, gp=2500.0, net=10000.0),
    _prov("广西", 2000.0, 2500.0, gp=300.0, net=1500.0),
    _prov("海南", None, 1000.0),
    _prov("上海", 5000.0, 4000.0, gp=1000.0, net=5000.0),
    _prov("江苏", 3000.0, 2000.0, gp=600.0, net=3000.0),
    _prov(None, 500.0, 400.0),
    _prov("越南", 100.0, None),
]


def test_same_window_math_and_national():
    log = []
    out = region_map(_runner(MAIN_PROVS, params_log=log), CTX, [], 75.9)
    # Q1 双年同窗绑定：当年 1..9 月封 20260922；上年同 ym 封上年同日 20250922（D-r4）
    q1 = next(p for m, p in log if m == "AS cur_amt")
    assert q1["ym"] == [f"2026-{m:02d}" for m in range(1, 10)]
    assert q1["ly_ym"] == [f"2025-{m:02d}" for m in range(1, 10)]
    assert q1["as_of_calday"] == "20260922" and q1["ly_as_of_calday"] == "20250922"
    assert out["asOf"] == "2026-09-22"
    assert out["window"] == "2026-01-01 ~ 2026-09-22（双年同窗）"
    n = out["national"]
    assert n["ytdWan"] == 20600.0                      # 含未分区 500 + 海外 100
    assert n["lyWan"] == 17900.0
    assert n["yoyPct"] == round(2700 / 17900 * 100, 1)          # 15.1
    assert n["grossMarginPct"] == round(4400 / 19500 * 100, 1)  # 分子和/分母和 → 22.6
    assert n["achievePct"] == 75.9                     # 注入参数原样透传（端点层取 trend meta）


def test_regions_mapping_order_share_margin():
    out = region_map(_runner(MAIN_PROVS), CTX, [], None)
    rs = out["regions"]
    assert [r["region"] for r in rs] == ["华南", "华东", "未分区", "海外"]  # 七区降序+特殊恒尾
    huanan, huadong, unmap, oversea = rs
    assert huanan["ytdWan"] == 12000.0 and huanan["lyWan"] == 11500.0
    assert huanan["yoyPct"] == round(500 / 11500 * 100, 1)      # 4.3 → growth
    assert huanan["sharePct"] == round(12000 / 20600 * 100, 1)  # 58.3
    assert huanan["grossMarginPct"] == round(2800 / 11500 * 100, 1)  # 24.3，非 25/20 比率平均
    assert huanan["level"] == "growth"
    assert huadong["yoyPct"] == round(2000 / 6000 * 100, 1) and huadong["level"] == "growth"
    assert unmap["ytdWan"] == 500.0 and unmap["grossMarginPct"] is None  # 无毛利数据→null
    assert oversea["yoyPct"] is None and oversea["level"] == "unknown"   # 上年 0/NULL→null


def test_provinces_rows_null_and_overseas():
    out = region_map(_runner(MAIN_PROVS), CTX, [], None)
    ps = out["provinces"]
    assert [p["prov"] for p in ps] == ["广东", "上海", "江苏", "广西", "海南", "越南", "未分区"]
    assert ps[0] == {"prov": "广东", "region": "华南", "ytdWan": 10000.0,
                     "lyWan": 8000.0, "yoyPct": 25.0}
    hainan = ps[4]                                    # 当年无销售：0 万 + yoy -100（只护分母）
    assert hainan["ytdWan"] == 0.0 and hainan["yoyPct"] == -100.0
    yuenan = ps[5]                                    # 海外=表外非 NULL 动态归类
    assert yuenan["region"] == "海外" and yuenan["lyWan"] == 0.0 and yuenan["yoyPct"] is None
    assert ps[6]["prov"] == "未分区" and ps[6]["region"] == "未分区"  # NULL 组标签回显
    assert out["unmappedProvinces"] == []


def test_level_boundaries():
    provs = [_prov(p, c, l) for p, c, l in
             [("北京", 9200.0, 10000.0),   # yoy=-8.0 → decline（≤-8，与 region_sales 雷达阈值一致）
              ("陕西", 9210.0, 10000.0),   # yoy=-7.9 → watch
              ("辽宁", 500.0, 500.0),      # yoy=0.0 → growth（≥0）
              ("上海", 100.0, None)]]      # yoy null → unknown
    levels = {r["region"]: r["level"] for r in region_map(_runner(provs), CTX, [], None)["regions"]}
    assert levels == {"华北": "decline", "西北": "watch", "东北": "growth", "华东": "unknown"}


def test_unmapped_domestic_disclosed():
    provs = [_prov("广东", 1000.0, None),
             _prov("广东省", 300.0, None),   # 带省后缀变体 → 表外国内 → 未分区+披露
             _prov("台湾", 200.0, None),      # 国内 31 图外兜底 → 未分区+披露
             _prov("越南", 100.0, None)]      # 海外城市 → 海外，不进披露
    out = region_map(_runner(provs), CTX, [], None)
    assert out["unmappedProvinces"] == ["广东省", "台湾"]        # 按金额降序
    assert [r["region"] for r in out["regions"]] == ["华南", "未分区", "海外"]
    assert next(r for r in out["regions"] if r["region"] == "未分区")["ytdWan"] == 500.0
    prov_rows = {(p["prov"], p["region"]) for p in out["provinces"]}
    assert ("广东省", "未分区") in prov_rows and ("越南", "海外") in prov_rows


def test_region_trend_fills_months():
    trend = [{"month": "2026-08", "prov": "广东", "trend_amt": 31000 * 10000},
             {"month": "2026-09", "prov": "广东", "trend_amt": 15000 * 10000},
             {"month": "2026-08", "prov": "上海", "trend_amt": 5000 * 10000},
             {"month": "2026-08", "prov": None, "trend_amt": 9999 * 10000},   # 未分区不入
             {"month": "2026-07", "prov": "越南", "trend_amt": 8888 * 10000}]  # 海外不入
    log = []
    out = region_map(_runner(trend=trend, params_log=log), CTX, [], None)
    q2 = next(p for m, p in log if m == "AS trend_amt")
    assert q2["trend_ym"][0] == "2025-10" and q2["trend_ym"][-1] == "2026-09"
    t = out["regionTrend"]
    assert t["months"] == [f"2025-{m:02d}" for m in range(10, 13)] + \
                          [f"2026-{m:02d}" for m in range(1, 10)]   # 近 12 自然月含当月 MTD
    assert list(t["series"].keys()) == SEVEN                        # 七区全框架，未分区海外不入
    huanan = {e["month"]: e["wan"] for e in t["series"]["华南"]}
    assert huanan["2026-08"] == 31000.0 and huanan["2026-09"] == 15000.0
    assert huanan["2025-10"] == 0.0                                 # 缺月补 0
    assert all(e["wan"] == 0.0 for e in t["series"]["西北"])
    assert len(t["series"]["华东"]) == 12


def test_region_events_association_three_states():
    cp = [{"center": "粤东运营中心", "prov": "广东", "cp_amt": 1000.0},
          {"center": "粤东运营中心", "prov": "福建", "cp_amt": 2000.0},
          {"center": "孤岛中心", "prov": None, "cp_amt": 500.0},      # 只未分区 → 空 regionSet
          {"center": "零销中心", "prov": "湖南", "cp_amt": 0.0}]       # 当月无销售 → 不构成关联
    events = [{"event_id": "e1", "org": "粤东运营中心", "score": 80.0,
               "title": "粤东下滑", "severity": "major"},
              {"event_id": "e2", "org": "瓷砖事业部", "score": 70.0,
               "title": "BU级", "severity": "minor"},
              {"event_id": "e3", "org": "孤岛中心", "score": 90.0,
               "title": "孤岛", "severity": "minor"},
              {"event_id": "e4", "org": "零销中心", "score": 85.0,
               "title": "零销", "severity": "minor"}]
    ev = region_map(_runner(cp=cp), CTX, events, None)["regionEvents"]
    assert list(ev.keys()) == SEVEN                                 # 框架=国内七区
    assert [e["event_id"] for e in ev["华南"]] == ["e1", "e2"]      # 中心命中 → 其 regionSet
    assert [e["event_id"] for e in ev["华东"]] == ["e1", "e2"]
    assert [e["event_id"] for e in ev["西北"]] == ["e2"]            # BU 级 → 全部国内七区
    assert not any(e["event_id"] in ("e3", "e4")
                   for evs in ev.values() for e in evs)             # 空 regionSet → 不关联


def test_region_events_top5_and_tiebreak():
    events = [{"event_id": f"t{i}", "org": "瓷砖事业部", "score": float(s),
               "title": "x", "severity": "minor"}
              for i, s in [(1, 10), (2, 20), (3, 30), ("3b", 30), (4, 40), (5, 50), (6, 60)]]
    ev = region_map(_runner(), CTX, events, None)["regionEvents"]
    assert [e["event_id"] for e in ev["华南"]] == ["t6", "t5", "t4", "t3", "t3b"]  # top5 分数降序、并列 id 升序
    card = ev["华南"][0]
    assert card == {"event_id": "t6", "title": "x", "severity": "minor",
                    "score": 60.0, "org": "瓷砖事业部"}


def test_partial_degradation_blocks():
    trend = [{"month": "2026-08", "prov": "广东", "trend_amt": 1000 * 10000}]
    cp = [{"center": "粤东运营中心", "prov": "广东", "cp_amt": 900.0}]
    # Q1 挂 → national/regions/provinces 三块各自降级（一次查询三块共享），披露表回空
    out = region_map(_runner(MAIN_PROVS, trend=trend, cp=cp, fail_on="AS cur_amt"), CTX, [], None)
    for k in ("national", "regions", "provinces"):
        assert out[k]["available"] is False and "dws down" in out[k]["reason"]
    assert out["unmappedProvinces"] == []
    assert len(out["regionTrend"]["months"]) == 12                          # 趋势块不受牵连
    assert "华南" in out["regionEvents"]
    # Q2 挂 → 仅趋势块降级
    out = region_map(_runner(MAIN_PROVS, trend=trend, cp=cp, fail_on="AS trend_amt"), CTX, [], None)
    assert out["regionTrend"]["available"] is False
    assert out["national"]["ytdWan"] == 20600.0
    assert out["national"]["achievePct"] is None                            # 注入 None 如实透传
    # Q3 挂 → 仅事件块降级
    out = region_map(_runner(MAIN_PROVS, trend=trend, cp=cp, fail_on="AS cp_amt"), CTX, [], None)
    assert out["regionEvents"]["available"] is False
    assert out["provinces"][0]["prov"] == "广东"
