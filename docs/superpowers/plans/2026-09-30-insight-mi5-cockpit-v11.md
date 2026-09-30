# 驾驶舱 v1.1「信息密度升级」（M-i5）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 spec `docs/superpowers/specs/2026-09-30-insight-cockpit-v11-design.md`（v1.0.1）落地趋势 API、健康度、首页三件套改版、详情页补全、事件中心观察中——纯展示层增强，检测/排序/归因零改动。

**Architecture:** 4 雷达各新增 `trend()`（复用本雷达 SQL 表/谓词）→ `TrendService`（DwsQueryRunner + 进程内缓存）挂进 insight-api 4 个新端点 → BFF 4 条 GET 代理 → UI 新 3 组件 + 改 7 组件。健康度 `health.py` 确定性映射，因子进 `config/health.json`。

**Tech Stack:** Python stdlib（insight 包既有形态）/ Node 24 TS-strip（BFF）/ React+Vite+Tailwind v4（纯 SVG 图表，零新依赖）。

---

## 前置事实（写计划时对实码盘点，工程师必读）

1. **两仓分工**：T1-T7 在 `D:\dataprojai-2harness`（harness）；T8-T12 代码在 `D:\dataplat-ui`。提交必须路径限定；dataplat-ui 是独立 git 仓。
2. **`/api/insight/health` 已被占用**（api_main.py:140 是 pm2 存活检查）→ 新端点名 **`/api/insight/health-score`**。
3. **AR 表列名已实证**（describe 2026-09-30）：应收总余额=`receivables_am`；nat90 分段表达式复用 `ar_risk._NAT90`（7 段 COALESCE 之和）。
4. **anchor_id 形态**：region_sales=`"{org_name}|{channel}"`（如 `粤东运营中心|GD03`）；gross_margin=`"瓷砖事业部|{channel}"`；ar_risk=`"瓷砖|nat90"`；target=`"瓷砖事业部|ALL"`。事件 → anchor 的重建路径=该事件 data_date 的 detector_finding 按 `event_key_of` 匹配（api_main._event_detail 同款，见 api_main.py:68-72）。
5. **ctx 助手**（replay_ctx.py）：`calday()`→"YYYYMMDD"、`ym()`→"YYYY-MM"、`prev_month_ym()`、`completed_month_ends(n)`、`shift_month(date,n)`。mix/ar/target 表月份格式="YYYY-MM"，ct 表用 calday="YYYYMMDD"。
6. **雷达 cfg**：`insight/config/radar-*.json`；region_sales 的 ly 字段=params.`ly_field`；target 的 centers 前置月=params.`center_set_month_lag`。
7. **DwsQueryRunner**（dws.py:37）：`run(sql, params)` 可调用对象，SELECT/WITH 白名单，Decimal→float 已在边界处理；`app_name` 传 `"insight-trend"`。
8. **api_main 测试形态**（test_api.py:19-26）：`make_server(store.db, host="127.0.0.1", port=0)` + `urllib.request.urlopen`。
9. **BFF 测试形态**（server/test/insight.test.ts）：`startBff({insightUrl})` + `startMockGateway(handler)` + `request(port, method, path, {cookie})` + `login()`（helpers.ts）。
10. **UI 验证形态**：web 无单测，验证=`cd web && npm run build` 零错误；颜色纪律=蓝主操作/红橙只给真异常。
11. **测试基线**：harness insight 146+8 skip 全绿（`python -m pytest insight/ -q`）；dataplat-ui server `node --test` 82 绿。
12. **部署**：insight-api 目前 pm2 id=7 无 DWS env；trend/health-score 需要 DWS_PASSWORD（T7 接线，密码只走 env 不落日志）。
13. **eval 红线**：本迭代不碰 eval_dataset/judge/run_eval；验收时跑一轮确认零影响。

---

## Task 1: region_sales.trend()（harness）

**Files:**
- Modify: `insight/detectors/region_sales.py`
- Test: `insight/tests/test_detectors.py`（文件已存在，追加）

- [ ] **Step 1: 写失败测试**（追加到 test_detectors.py 末尾）

```python
# ---- M-i5 trend()：首页卡内嵌图与详情页趋势卡共用（spec §4.1 month_compare）----

def test_region_sales_trend_month_compare():
    det = RegionSalesDetector.for_test()
    seen = {}
    rows = [{"month": "2026-05", "cur_wan": 100.0, "prev_wan": 120.0},
            {"month": "2026-06", "cur_wan": 110.0, "prev_wan": None}]
    run = lambda sql, p=None: (seen.update(sql=sql, p=p) or rows)
    out = det.trend(run, CTX, "华南营销中心|GD01", months=4)
    assert out["kind"] == "month_compare" and out["unit"] == "万元"
    assert out["anchor_id"] == "华南营销中心|GD01"
    assert out["series"][0] == {"month": "2026-05", "cur": 100.0, "prev": 120.0}
    assert out["series"][1]["prev"] is None            # ly 缺→None，不造 0
    assert len(seen["p"]["month_ends"]) == 4           # 完整自然月末 ×4
    assert seen["p"]["org_name"] == "华南营销中心" and seen["p"]["channel"] == "GD01"
    assert seen["p"]["as_of_calday"] == "20260922"     # point-in-time 封顶
    assert "last_year_month_achievement" in seen["sql"]

def test_region_sales_trend_sql_reuses_detector_predicates():
    det = RegionSalesDetector()
    seen = {}
    run = lambda sql, p=None: (seen.update(sql=sql) or [])
    det.trend(run, CTX, "华南营销中心|GD01")
    # 口径=检测 SQL 同源（spec D-c3）：同表同 JOIN 同事业部谓词同渠道真列名
    assert "ct_sales_performance_t" in seen["sql"]
    assert "node_desc2 = '瓷砖事业部'" in seen["sql"]
    assert "integrate_channel_code = %(channel)s" in seen["sql"]
    assert "<= %(as_of_calday)s" in seen["sql"]
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python -m pytest insight/tests/test_detectors.py -k trend -q`
Expected: FAIL `AttributeError: ... has no attribute 'trend'`

- [ ] **Step 3: 实现**（region_sales.py 末尾追加；SQL 与检测 SQL 同源，仅聚合粒度不同）

```python
TREND_SQL = """
SELECT to_char(to_date(p.calday, 'YYYYMMDD'), 'YYYY-MM') AS month,
       SUM(p.month_achievement) / 10000 AS cur_wan,
       SUM(p.{ly_field}) / 10000 AS prev_wan
FROM dm.ct_sales_performance_t p
JOIN dm.dm_rpt_sales_group_t s
  ON p.org_code = s.node_name10 AND s.node_desc2 = '瓷砖事业部'
WHERE p.calday = ANY(%(month_ends)s)
  AND p.calday <= %(as_of_calday)s
  AND s.node_desc5 = %(org_name)s
  AND p.integrate_channel_code = %(channel)s
GROUP BY 1 ORDER BY 1
"""

def _trend(self, run, ctx: ReplayContext, anchor_id: str, months: int = 12) -> dict:
    """锚点月度序列（spec §4.1 kind=month_compare）——SQL 与 detect() 同表同谓词（D-c3，
    首页图与检测口径不得两张皮）。序列只含完整自然月；ly 缺→None 不造 0。"""
    org, _, ch = anchor_id.partition("|")
    ends = ctx.completed_month_ends(months)
    rows = run(TREND_SQL.format(ly_field=self.cfg["params"]["ly_field"]),
               {"month_ends": [e.strftime("%Y%m%d") for e in ends],
                "as_of_calday": ctx.calday(), "org_name": org, "channel": ch})
    return {"detector": self.cfg["name"], "anchor_id": anchor_id, "unit": "万元",
            "kind": "month_compare",
            "series": [{"month": r["month"], "cur": r["cur_wan"], "prev": r["prev_wan"]}
                       for r in rows]}

RegionSalesDetector.trend = _trend
```

> 注意：包内既有四雷达类的公开方法都是实例方法直写类体。为保持 diff 最小、不动类体，
> 此处用猴子补丁挂载是**不允许的**——请把 `_trend` 的 def 直接写进 `RegionSalesDetector`
> 类体内（缩进一级，命名 `trend`），并删除上面的挂载行。最终形态：

```python
class RegionSalesDetector:
    # ……既有代码不动……
    def trend(self, run, ctx: ReplayContext, anchor_id: str, months: int = 12) -> dict:
        org, _, ch = anchor_id.partition("|")
        ends = ctx.completed_month_ends(months)
        rows = run(TREND_SQL.format(ly_field=self.cfg["params"]["ly_field"]),
                   {"month_ends": [e.strftime("%Y%m%d") for e in ends],
                    "as_of_calday": ctx.calday(), "org_name": org, "channel": ch})
        return {"detector": self.cfg["name"], "anchor_id": anchor_id, "unit": "万元",
                "kind": "month_compare",
                "series": [{"month": r["month"], "cur": r["cur_wan"], "prev": r["prev_wan"]}
                           for r in rows]}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python -m pytest insight/tests/test_detectors.py -q`
Expected: 全 PASS（既有 + 新 2）

- [ ] **Step 5: 提交**

```bash
git add insight/detectors/region_sales.py insight/tests/test_detectors.py
git commit -m "feat(mi5): region_sales.trend——锚点月度同比序列(month_compare)，SQL与检测同源" -- insight/detectors/region_sales.py insight/tests/test_detectors.py
```

---

## Task 2: gross_margin.trend()（harness）

**Files:**
- Modify: `insight/detectors/gross_margin.py`
- Test: `insight/tests/test_detectors.py`

- [ ] **Step 1: 失败测试**（追加）

```python
from insight.detectors.gross_margin import GrossMarginDetector

def test_gross_margin_trend_month_single():
    det = GrossMarginDetector.for_test()
    seen = {}
    rows = [{"month": "2026-07", "gp": 800.0, "net_amt": 10000.0},
            {"month": "2026-08", "gp": 900.0, "net_amt": 12000.0}]  # 8%→7.5%
    run = lambda sql, p=None: (seen.update(sql=sql, p=p) or rows)
    out = det.trend(run, CTX, "瓷砖事业部|GD01", months=2)
    assert out["kind"] == "month_single" and out["unit"] == "%"
    assert out["series"][0] == {"month": "2026-07", "cur": 8.0, "prev": None}
    assert out["series"][1]["cur"] == 7.5
    assert seen["p"]["ym"] == ["2026-07", "2026-08"]        # 完整月 ym
    assert seen["p"]["channel"] == "GD01"
    assert "integrate_channel = %(channel)s" in seen["sql"]
    assert "data_source IN ('S','T','D','')" in seen["sql"]  # 与检测同谓词
```

- [ ] **Step 2: 确认失败**

Run: `python -m pytest insight/tests/test_detectors.py -k margin_trend -q`
Expected: FAIL `AttributeError`

- [ ] **Step 3: 实现**（gross_margin.py：模块级 TREND_SQL + 类体新增方法）

```python
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
```

类体内新增（与 detect 同表同谓词，D-c3）：

```python
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
```

- [ ] **Step 4: 通过** `python -m pytest insight/tests/test_detectors.py -q`

- [ ] **Step 5: 提交**

```bash
git add insight/detectors/gross_margin.py insight/tests/test_detectors.py
git commit -m "feat(mi5): gross_margin.trend——渠道月度毛利率序列(month_single)" -- insight/detectors/gross_margin.py insight/tests/test_detectors.py
```

---

## Task 3: ar_risk.trend()（harness）

**Files:**
- Modify: `insight/detectors/ar_risk.py`
- Test: `insight/tests/test_detectors.py`

- [ ] **Step 1: 失败测试**（追加）

```python
from insight.detectors.ar_risk import ArRiskDetector
from insight.replay_ctx import shift_month

def test_ar_risk_trend_includes_current_month():
    det = ArRiskDetector.for_test()
    seen = {}
    rows = [{"month": "2026-08", "nat90_wan": 79482.6},
            {"month": "2026-09", "nat90_wan": 81227.7}]
    run = lambda sql, p=None: (seen.update(sql=sql, p=p) or rows)
    out = det.trend(run, CTX, "瓷砖|nat90", months=2)
    assert out["kind"] == "month_single" and out["unit"] == "万元"
    assert out["series"][-1] == {"month": "2026-09", "cur": 81227.7, "prev": None}
    # ar 是月内即时快照：窗口含当月（与 detect 的 cur_ym 语义一致），与销售/毛利的"完整月"不同
    assert seen["p"]["ym"] == ["2026-08", "2026-09"]
    assert "special_general_ledger IS NULL OR special_general_ledger = ''" in seen["sql"]
    assert "receivables_am" not in seen["sql"]            # 趋势只有 nat90 序列；占比归 health
```

- [ ] **Step 2: 确认失败** `python -m pytest insight/tests/test_detectors.py -k ar_trend -q`

- [ ] **Step 3: 实现**（ar_risk.py 模块级 TREND_SQL——直接复用 `_NAT90`——+ 类体方法）

```python
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
```

```python
    def trend(self, run, ctx: ReplayContext, anchor_id: str, months: int = 12) -> dict:
        """BU 级 nat90 月度余额序列（spec §4.1 kind=month_single）。窗口含当月即时快照
        （ar 与销售/毛利不同：detect 本身就用当月，趋势同语义）。anchor 仅保持签名一致。"""
        ym = [shift_month(ctx.as_of, -i).strftime("%Y-%m") for i in range(months - 1, -1, -1)]
        rows = run(TREND_SQL, {"ym": ym, "cur_ym": ctx.ym()})
        return {"detector": self.cfg["name"], "anchor_id": anchor_id, "unit": "万元",
                "kind": "month_single",
                "series": [{"month": r["month"], "cur": r["nat90_wan"], "prev": None}
                           for r in rows]}
```

- [ ] **Step 4: 通过** `python -m pytest insight/tests/test_detectors.py -q`
- [ ] **Step 5: 提交**

```bash
git add insight/detectors/ar_risk.py insight/tests/test_detectors.py
git commit -m "feat(mi5): ar_risk.trend——nat90月度余额序列(含当月快照)" -- insight/detectors/ar_risk.py insight/tests/test_detectors.py
```

---

## Task 4: target.trend()（harness）

**Files:**
- Modify: `insight/detectors/target.py`
- Test: `insight/tests/test_detectors.py`

- [ ] **Step 1: 失败测试**（追加）

```python
from insight.detectors.target import TargetDetector

def test_target_trend_cumulative_dual():
    det = TargetDetector.for_test()
    seen = {}
    # CTX as_of=2026-09-22 → 年内 1..9 月；actual: 1月100万、2月累计250万…简化两行(1/9月)；
    # target: 1月200万、9月累计1800万
    def run(sql, p=None):
        seen["last"] = (sql, p)
        if "ambperformance" in sql:
            return [{"month": "2026-01", "actual_amt": 1000000.0},
                    {"month": "2026-09", "actual_amt": 8000000.0}]
        return [{"month": "2026-01", "target_amt": 2000000.0},
                {"month": "2026-09", "target_amt": 18000000.0}]
    out = det.trend(run, CTX, "瓷砖事业部|ALL")
    assert out["kind"] == "cumulative_dual" and out["unit"] == "%"
    assert len(out["series"]) == 9                            # 年内 1..9 月逐月
    s1, s9 = out["series"][0], out["series"][8]
    assert s1["cur"] == 50.0                                  # 100/200 万
    assert s9["cur"] == round(9000000.0 / 20000000.0 * 100, 1)  # 累计 900/2000 万
    assert 73.0 < s9["prev"] < 78.0                           # 9/22 的年日内占比
    assert s1["prev"] == round(31 / 365 * 100, 1)             # 1 月末=第 31 天
    assert out["meta"]["cum_actual_wan"] == 9000.0            # 供 health 目标环复用
    assert out["meta"]["cum_target_wan"] == 20000.0
    assert seen["last"][1]["as_of_calday"] == "20260922"      # point-in-time 封顶同 detect
    assert "org_type = '业务单位'" in seen["last"][0]          # 目标侧谓词同源
```

- [ ] **Step 2: 确认失败** `python -m pytest insight/tests/test_detectors.py -k target_trend -q`

- [ ] **Step 3: 实现**（target.py 模块级两条 TREND SQL + 类体方法；months 参数签名保留但目标环恒年内序列，忽略该参数——注释说明）

```python
TREND_ACTUAL_SQL = """
SELECT calmonth AS month, SUM(ambperformance) AS actual_amt
FROM dm.dm_fin_operations_mix_sum_t
WHERE calmonth = ANY(%(ym)s)
  AND calday <= %(as_of_calday)s
  AND node_desc2 = '瓷砖事业部'
  AND data_source IN ('S','T','D','')
GROUP BY 1 ORDER BY 1
"""

TREND_TARGET_SQL = """
WITH centers AS (
  SELECT DISTINCT node_name5 AS center
  FROM dm.dm_fin_operations_mix_sum_t
  WHERE calmonth = %(center_set_month_ym)s
    AND node_desc2 = '瓷砖事业部'
    AND data_source IN ('S','T','D','')
)
SELECT stat_month AS month, SUM(target_sales_amt) * 10000 AS target_amt
FROM dm.dm_dp_api_sales_target
WHERE stat_month = ANY(%(ym)s)
  AND stat_month <= %(cur_ym)s
  AND org_type = '业务单位'
  AND sales_center_code IN (SELECT center FROM centers)
GROUP BY 1 ORDER BY 1
"""
```

```python
    def trend(self, run, ctx: ReplayContext, anchor_id: str, months: int = 12) -> dict:
        """年内累计达成率 vs 年日内进度双线（spec §4.1 kind=cumulative_dual）。
        months 仅保持四雷达签名一致，恒为年初至 as_of 月。meta 带累计金额供 health 复用。"""
        y = ctx.as_of.year
        ym = [f"{y}-{m:02d}" for m in range(1, ctx.as_of.month + 1)]
        acts = {r["month"]: r["actual_amt"] for r in run(
            TREND_ACTUAL_SQL, {"ym": ym, "as_of_calday": ctx.calday()})}
        tgts = {r["month"]: r["target_amt"] for r in run(
            TREND_TARGET_SQL,
            {"ym": ym, "cur_ym": ctx.ym(),
             "center_set_month_ym": shift_month(
                 ctx.as_of, -self.cfg["params"]["center_set_month_lag"]).strftime("%Y-%m")})}
        days_in_year = 366 if calendar.isleap(y) else 365
        series, ca, ct = [], 0.0, 0.0
        for m in range(1, ctx.as_of.month + 1):
            key = f"{y}-{m:02d}"
            ca += acts.get(key) or 0.0
            ct += tgts.get(key) or 0.0
            if m == ctx.as_of.month:
                end = date(y, m, ctx.as_of.day)
            else:
                end = date(y, m, calendar.monthrange(y, m)[1])
            series.append({"month": key,
                           "cur": round(ca / ct * 100, 1) if ct else None,
                           "prev": round(end.timetuple().tm_yday / days_in_year * 100, 1)})
        return {"detector": self.cfg["name"], "anchor_id": anchor_id, "unit": "%",
                "kind": "cumulative_dual", "series": series,
                "meta": {"cum_actual_wan": round(ca / 10000, 1),
                         "cum_target_wan": round(ct / 10000, 1),
                         "as_of": ctx.as_of.isoformat()}}
```

- [ ] **Step 4: 通过** `python -m pytest insight/tests/test_detectors.py -q`
- [ ] **Step 5: 提交**

```bash
git add insight/detectors/target.py insight/tests/test_detectors.py
git commit -m "feat(mi5): target.trend——年内累计达成率vs年进度双线+累计金额meta" -- insight/detectors/target.py insight/tests/test_detectors.py
```

---

## Task 5: health.py 健康度 + config/health.json（harness）

**Files:**
- Create: `insight/health.py`
- Create: `insight/config/health.json`
- Test: `insight/tests/test_health.py`

- [ ] **Step 1: config/health.json**

```json
{
  "sales": {"factor": 2.0},
  "margin": {"factor": 10.0},
  "ar": {},
  "inventory_reason": "库存雷达未接入（需日汇总层）",
  "notes": "D-c2：因子是灰度期校准点——改动必须留台账 eval_results/insight-gray/（对齐 ranking.json 纪律），且不影响事件检测/榜单/D8 证据"
}
```

- [ ] **Step 2: 失败测试** `insight/tests/test_health.py`

```python
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
    p = compute(_runner(sales=_sales_rows(-11.2, -8.0)), CTX)
    r = _ring(p, "sales")
    assert r["score"] == 100 - round(0 + 11.2 * 2, 1) * 1 or True  # 占位见下——用精确断言：
    assert r["score"] == 77.6                        # 100 − clip(11.2)×2
    assert r["mom_delta"] == round((100 - 8.0 * 2) - (100 - 11.2 * 2), 1)   # +6.4
    assert r["inputs"]["yoy_pct"] == -11.2 and r["inputs"]["month"] == "2026-08"
    assert "× 2.0" in r["formula"]


def test_sales_ring_caps_at_100_when_growing():
    p = compute(_runner(sales=_sales_rows(3.0, -2.0)), CTX)
    assert _ring(p, "sales")["score"] == 100.0       # 同比为正→封顶


def test_margin_ring_formula():
    p = compute(_runner(margins=_margin_rows(900, 850, 800)), CTX)  # 环比 -0.5pct
    r = _ring(p, "margin")
    assert r["score"] == 95.0                        # 100 − 0.5×10
    assert r["mom_delta"] == 5.0                     # 上月环比 +0.5→100；100−95=5
    assert r["inputs"]["delta_pct"] == -0.5


def test_ar_ring_share_formula():
    p = compute(_runner(ar=_ar_rows(38.0, 35.0)), CTX)
    r = _ring(p, "ar")
    assert r["score"] == 62.0                        # 100 − 38%
    assert r["mom_delta"] == 3.0                     # 65→62
    assert r["inputs"]["nat90_share_pct"] == 38.0


def test_partial_degradation_one_ring_down():
    p = compute(_runner(sales=_sales_rows(-5, -5), fail_on="gross_profit"), CTX)
    assert _ring(p, "sales")["available"] is True
    m = _ring(p, "margin")
    assert m["available"] is False and "dws down" in m["reason"]


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
    assert t["achieve_pct"] == 78.1 and t["time_pct"] == p["rings"] and False or True  # 删占位：
```

> **写测试时注意**：上面最后一条我留了两处占位（`or True` / `and False or True`）——这是计划
> 演示形态，实际写入时删掉占位行，并补 time_pct 精确断言：
> `assert t["time_pct"] == round(265 / 365 * 100, 1)`（2026-09-22 是第 265 天，target 环
> 时间进度=年日内占比，与 trend 序列 prev 同定义）。同理第一条 sales 断言只保留
> `assert r["score"] == 77.6` 一行。

- [ ] **Step 3: 跑测试确认失败** `python -m pytest insight/tests/test_health.py -q` → ModuleNotFoundError

- [ ] **Step 4: 实现 insight/health.py**

```python
# insight/health.py
"""经营健康度（spec §5，裁定 D-c1/D-c2）：确定性映射，分数=公式+输入+因子全可查。

三环各一次查询回 cur+prev 两期（无 per-ring 循环查库）；库存=未接入诚实态；
target 复用 TargetDetector.trend 的 meta。因子 config/health.json（台账纪律）。
任一环查询异常 → 该环 available:false+reason，其余照常（局部降级，不炸整卡）。"""
import json
from datetime import date
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
    scores = []
    for r in rows[-2:]:
        yoy = (r["cur_amt"] - r["ly_amt"]) / r["ly_amt"] * 100
        scores.append(round(100 - _clip(-yoy) * k, 1))
        if r is rows[-1]:
            last_yoy, last_m = round(yoy, 1), r["month"]
    return {"available": True, "score": scores[1], "mom_delta": round(scores[1] - scores[0], 1),
            "formula": f"100 − 完整自然月同比降幅(pt) × {k}",
            "inputs": {"yoy_pct": last_yoy, "month": last_m}}


def _margin_ring(run, ctx) -> dict:
    k = CONFIG["margin"]["factor"]
    rows = run(MARGIN_SQL, {"ym": [e.strftime("%Y-%m") for e in ctx.completed_month_ends(3)],
                            "cur_ym": ctx.ym()})
    gmp = [r["gp"] / r["net_amt"] * 100 for r in rows
           if r["gp"] is not None and r["net_amt"]]
    if len(gmp) < 3:
        return {"available": False, "reason": "完整月毛利率数据不足"}
    d1, d2 = round(gmp[1] - gmp[0], 1), round(gmp[2] - gmp[1], 1)   # 上月环比 / 当月环比
    s = lambda d: round(100 - _clip(-d) * k, 1)
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
    return {"available": True, "score": round(100 - s_cur, 1),
            "mom_delta": round((100 - s_cur) - (100 - s_prev), 1),
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
```

> `SALES_SQL` 里 `RegionSalesDetector()` 在 import 时实例化会读 config——没问题（load_config
> 只读 json）。若嫌 import 期副作用，可改为 `load_config("region_sales")["params"]["ly_field"]`，
> 二选一，实现者定。

- [ ] **Step 5: 通过** `python -m pytest insight/tests/test_health.py -q`
- [ ] **Step 6: 全量回归** `python -m pytest insight/ -q`（148+ 预期全绿）
- [ ] **Step 7: 提交**

```bash
git add insight/health.py insight/config/health.json insight/tests/test_health.py
git commit -m "feat(mi5): 健康度确定性映射health.py——三环+库存未接入+目标环,因子health.json台账纪律" -- insight/health.py insight/config/health.json insight/tests/test_health.py
```

---

## Task 6: TrendService + api_main 四端点 + daily/detail 扩展（harness）

**Files:**
- Create: `insight/trend_service.py`
- Modify: `insight/api_main.py`
- Test: `insight/tests/test_api.py`（追加）

- [ ] **Step 1: 失败测试**（追加到 test_api.py；沿用既有 make_server+urlopen 模式。种子用直插 SQL，参照 test_gray_report 的种子写法）

```python
# ---- M-i5：trend/health-score/related/active 四端点 ----
import json as _json

from insight.api_main import make_server
from insight.trend_service import TrendService


def _seed_event(s):
    """1 个 region_sales 事件 + 其 finding（anchor 华南|GD01）+ 当日榜。"""
    s.db.execute(
        "INSERT INTO business_event (event_id,event_key,lifecycle,data_date,first_seen_date,"
        "last_seen_date,persist_days,detector,event_type,title,summary,severity,scope_json,"
        "period_json,facts_json,score,score_breakdown_json,metric,status,attribution_status,"
        "attribution_summary,created_at,updated_at) VALUES"
        "('ev-t1','k-t1','active','2026-09-22','2026-09-21','2026-09-22',2,'region_sales',"
        "'sales_decline','t','s','minor','{\"范围\":\"瓷砖事业部\",\"组织节点\":\"华南营销中心\"}',"
        "'{\"类型\":\"月\"}','[]',50.7,'{}','m','analyzed','done','归因摘要',0,0)")
    s.db.execute(
        "INSERT INTO detector_finding (finding_id,data_date,detector,dim_keys_json,metrics_json,"
        "norm_score,threshold_passed,is_late) VALUES"
        "('f-t1','2026-09-22','region_sales','{\"anchor_type\":\"org_channel\","
        "\"anchor_id\":\"华南营销中心|GD01\",\"channel\":\"GD01\"}','{}',50,1,0)")
    s.db.execute(
        "INSERT INTO daily_brief VALUES ('2026-09-23','瓷砖事业部','final',0,0,1,'{}',0)")
    s.db.execute(
        "INSERT INTO daily_brief_event VALUES ('2026-09-23','ev-t1',1,50.7,'minor','t','s','[]',"
        "'sales_decline',2,'2026-09-21','active',0)")
    s.db.commit()


def _fake_runner_factory(calls):
    def run(sql, params=None):
        calls.append(sql[:40])
        if "ct_sales_performance_t" in sql:
            return [{"month": "2026-08", "cur_wan": 100.0, "prev_wan": 120.0}]
        if "dm_ar_analysis_rpt_f" in sql:
            return [{"calmonth": "2026-09", "nat90": 3800.0, "total": 10000.0},
                    {"calmonth": "2026-08", "nat90": 3500.0, "total": 10000.0}]
        return []
    return run


def test_trend_endpoint_with_cache_and_validation(tmp_path):
    from insight.db import open_db
    s = open_db(tmp_path / "t.db")
    _seed_event(s)
    calls = []
    srv = make_server(s, host="127.0.0.1", port=0,
                      trend_runner=_fake_runner_factory(calls))
    port = srv.server_address[1]
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/insight/events/ev-t1/trend", timeout=5) as r:
            body = json.loads(r.read())
        assert body["kind"] == "month_compare" and body["series"][0]["cur"] == 100.0
        n1 = len(calls)
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/insight/events/ev-t1/trend", timeout=5) as r:
            json.loads(r.read())
        assert len(calls) == n1                       # 缓存命中：runner 不再被调
        # months 越界 → 400
        try:
            urllib.request.urlopen(
                f"http://127.0.0.1:{port}/api/insight/events/ev-t1/trend?months=25", timeout=5)
            assert False
        except urllib.error.HTTPError as e:
            assert e.code == 400
        # 事件不存在 → 404
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/api/insight/events/ev-nope/trend", timeout=5)
            assert False
        except urllib.error.HTTPError as e:
            assert e.code == 404
    finally:
        srv.server_close()


def test_health_score_endpoint_and_no_dws_503(tmp_path):
    from insight.db import open_db
    s = open_db(tmp_path / "t2.db")
    calls = []
    srv = make_server(s, host="127.0.0.1", port=0,
                      trend_runner=_fake_runner_factory(calls))
    port = srv.server_address[1]
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/insight/health-score", timeout=5) as r:
            body = json.loads(r.read())
        keys = [x["key"] for x in body["rings"]]
        assert keys == ["sales", "margin", "ar", "inventory"]
        ar = next(x for x in body["rings"] if x["key"] == "ar")
        assert ar["available"] is True and ar["score"] == 62.0
        inv = next(x for x in body["rings"] if x["key"] == "inventory")
        assert inv["available"] is False
    finally:
        srv.server_close()
    # 无 DWS（trend_runner=None）→ 503 DWS_UNAVAILABLE，db 端点不受影响
    srv2 = make_server(s, host="127.0.0.1", port=0)
    port2 = srv2.server_address[1]
    try:
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port2}/api/insight/health-score", timeout=5)
            assert False
        except urllib.error.HTTPError as e:
            assert e.code == 503
        with urllib.request.urlopen(f"http://127.0.0.1:{port2}/api/insight/events?state=active", timeout=5) as r:
            assert json.loads(r.read())["events"][0]["event_id"] == "ev-t1"
    finally:
        srv2.server_close()


def test_related_and_active_endpoints(tmp_path):
    from insight.db import open_db
    s = open_db(tmp_path / "t3.db")
    _seed_event(s)
    # 第二个同类型同区域事件
    s.db.execute(
        "INSERT INTO business_event (event_id,event_key,lifecycle,data_date,first_seen_date,"
        "last_seen_date,persist_days,detector,event_type,title,summary,severity,scope_json,"
        "period_json,facts_json,score,score_breakdown_json,metric,status,attribution_status,"
        "created_at,updated_at) VALUES"
        "('ev-t2','k-t2','active','2026-09-22','2026-09-22','2026-09-22',1,'region_sales',"
        "'sales_decline','t2','s','minor','{\"范围\":\"瓷砖事业部\",\"组织节点\":\"华南营销中心\"}',"
        "'{\"类型\":\"月\"}','[]',40.0,'{}','m','discovered','pending',0,0)")
    s.db.commit()
    srv = make_server(s, host="127.0.0.1", port=0)
    port = srv.server_address[1]
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/insight/events/ev-t1/related", timeout=5) as r:
            rel = json.loads(r.read())
        assert [e["event_id"] for e in rel["sameType"]] == ["ev-t2"]
        assert [e["event_id"] for e in rel["sameRegion"]] == ["ev-t2"]
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/insight/events?state=active", timeout=5) as r:
            act = json.loads(r.read())
        ev1 = next(e for e in act["events"] if e["event_id"] == "ev-t1")
        ev2 = next(e for e in act["events"] if e["event_id"] == "ev-t2")
        assert ev1["publishedToday"] is True and ev1["rankToday"] == 1
        assert ev2["publishedToday"] is False
        assert ev2["scoreGap"] == round(40.0 - 55, 1)          # publish_min_score=55
    finally:
        srv.server_close()


def test_daily_payload_extended_fields(tmp_path):
    from insight.db import open_db
    s = open_db(tmp_path / "t4.db")
    _seed_event(s)
    srv = make_server(s, host="127.0.0.1", port=0)
    port = srv.server_address[1]
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/insight/daily?date=2026-09-23", timeout=5) as r:
            body = json.loads(r.read())
        assert body["dataDate"] == "2026-09-22"                # brief_date-1
        assert body["events"][0]["attributionSummary"] == "归因摘要"
        assert body["events"][0]["attributionStatus"] == "done"
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/insight/events/ev-t1", timeout=5) as r:
            d = json.loads(r.read())
        assert d["event"]["resolved_at"] is None
        assert d["attribution"]["generatedAt"] is None
    finally:
        srv.server_close()
```

> test_api.py 头部已有 `import json`/`urllib.request` 用什么名就沿用（实现者看文件头，
> 保持一致——上面按 `json.loads` / `urllib.request.urlopen` 书写，若文件已用别名则统一）。

- [ ] **Step 2: 确认失败** `python -m pytest insight/tests/test_api.py -k "trend or health_score or related or active or extended" -q` → ImportError（trend_service 不存在）/ AssertionError

- [ ] **Step 3: 实现 insight/trend_service.py**

```python
# insight/trend_service.py
"""trend/health-score 的 DWS 编排（M-i5）：事件→锚点→detector.trend，进程内缓存。

缓存 key=(用途, detector, anchor, as_of, months)；as_of（数据日）变更自然失效，
无 TTL 定时器；进程重启即冷。调用方保证 runner 是串行使用（api 线程池下每请求
独占 runner → TrendService 持锁串行化，防并发打 DWS——spec §7）。"""
import json
import threading
from datetime import date

from .detectors import REGISTRY
from .health import compute
from .merge_rank import event_key_of
from .replay_ctx import ReplayContext


class TrendService:
    def __init__(self, runner):
        self.runner = runner
        self._cache: dict = {}
        self._lock = threading.Lock()      # ThreadingHTTPServer 多线程→DWS 查询串行

    def trend_for_event(self, db, event_id: str, months: int = 12) -> dict | None:
        ev = db.execute("SELECT event_id, event_key, detector, data_date"
                        " FROM business_event WHERE event_id=?", (event_id,)).fetchone()
        if not ev:
            return None
        anchor = ""
        for r in db.execute("SELECT dim_keys_json FROM detector_finding"
                            " WHERE data_date=? ORDER BY finding_id", (ev["data_date"],)):
            dk = json.loads(r["dim_keys_json"])
            if event_key_of({"dim_keys": dk}) == ev["event_key"]:
                anchor = dk.get("anchor_id", "")
                break
        key = ("trend", ev["detector"], anchor, ev["data_date"], months)
        if key not in self._cache:
            with self._lock:
                if key not in self._cache:   # double-check：并发同 key 只查一次
                    ctx = ReplayContext(as_of=date.fromisoformat(ev["data_date"]))
                    self._cache[key] = REGISTRY[ev["detector"]]().trend(
                        self.runner, ctx, anchor, months)
        return self._cache[key]

    def health(self, as_of: date) -> dict:
        key = ("health", as_of.isoformat())
        if key not in self._cache:
            with self._lock:
                if key not in self._cache:
                    self._cache[key] = compute(self.runner, ReplayContext(as_of=as_of))
        return self._cache[key]
```

- [ ] **Step 4: 修改 api_main.py**（四处，全部 additive）

4a. import 区追加：

```python
from datetime import timedelta
from .trend_service import TrendService
```

4b. 模块级正则区追加：

```python
_EVENT_TREND_RE = re.compile(r"^/api/insight/events/([A-Za-z0-9\-]+)/trend$")
_EVENT_RELATED_RE = re.compile(r"^/api/insight/events/([A-Za-z0-9\-]+)/related$")
```

4c. `_daily_payload`：`cur_by_id` 查询列扩展（api_main.py:33-35）改为：

```python
    cur_by_id = {r["event_id"]: r for r in
                 _rows(db, "SELECT event_id, status, event_key, metric,"
                       " attribution_summary, attribution_status FROM business_event"
                       " WHERE event_id IN (SELECT event_id FROM daily_brief_event"
                       " WHERE brief_date=?)", (brief_date,))}
```

`evs.append({...})`（api_main.py:40-50）在 `"status": cur.get("status", "discovered"),` 行后追加两行：

```python
                    "attributionSummary": cur.get("attribution_summary"),
                    "attributionStatus": cur.get("attribution_status", "pending"),
```

返回 dict（api_main.py:51-54）首行后加 `"dataDate": (date.fromisoformat(brief_date) - timedelta(days=1)).isoformat() if brief else None,`

4d. `_event_detail`：event 字段元组（api_main.py:75-79）追加 `"resolved_at"`；attribution dict 追加 `"generatedAt": ev["attribution_generated_at"],`

4e. `make_server` 签名改 `def make_server(db, host="127.0.0.1", port=58095, trend_runner=None):`，Handler 外构造 `service = TrendService(trend_runner) if trend_runner else None`；db-only 的 related/active 直接闭包函数：

```python
    def _related(db, event_id: str) -> dict | None:
        ev = db.execute("SELECT event_id, event_type, scope_json FROM business_event"
                        " WHERE event_id=?", (event_id,)).fetchone()
        if not ev:
            return None
        org = json.loads(ev["scope_json"]).get("组织节点")
        same_type, same_region = [], []
        for r in db.execute("SELECT event_id, event_type, scope_json, title, severity,"
                            " data_date, created_at FROM business_event"
                            " WHERE event_id<>? ORDER BY created_at DESC LIMIT 100",
                            (event_id,)):
            if r["event_id"] == ev["event_id"]:
                continue
            item = {"event_id": r["event_id"], "title": r["title"],
                    "severity": r["severity"], "data_date": r["data_date"],
                    "created_at": r["created_at"]}
            if r["event_type"] == ev["event_type"] and len(same_type) < 5:
                same_type.append(item)
            if org and json.loads(r["scope_json"]).get("组织节点") == org and len(same_region) < 5:
                same_region.append(item)
        return {"event_id": event_id, "sameType": same_type, "sameRegion": same_region}

    def _active_events(db) -> dict:
        from .merge_rank import RANKING
        latest = (db.execute("SELECT MAX(brief_date) b FROM daily_brief").fetchone()["b"]) or ""
        pub = {r["event_id"]: r["rank"] for r in
               _rows(db, "SELECT event_id, rank FROM daily_brief_event WHERE brief_date=?",
                     (latest,))}
        out = []
        for r in _rows(db, "SELECT event_id, detector, event_type, title, summary, severity,"
                           " score, persist_days, first_seen_date, lifecycle,"
                           " attribution_status, updated_at FROM business_event"
                           " WHERE lifecycle='active' ORDER BY score DESC"):
            out.append({**r, "publishedToday": r["event_id"] in pub,
                        "rankToday": pub.get(r["event_id"]),
                        "scoreGap": round(r["score"] - RANKING["publish_min_score"], 1)})
        return {"briefDate": latest, "publishMinScore": RANKING["publish_min_score"],
                "events": out}
```

4f. `do_GET` 路由链：在 `elif (m := _EVENT_ID_RE.match(u.path)):` **之前**插入（防 `/events` 前缀歧义，虽然正则带 `$` 其实无冲突，前置更稳）：

```python
                elif u.path == "/api/insight/events":
                    if (q.get("state") or ["active"])[0] == "active":
                        body, code = _active_events(ro), 200
                    else:
                        body, code = {"error": "BAD_STATE"}, 400
                elif (m := _EVENT_TREND_RE.match(u.path)):
                    if not service:
                        body, code = {"error": "DWS_UNAVAILABLE"}, 503
                    else:
                        try:
                            months = int((q.get("months") or ["12"])[0])
                            if not 1 <= months <= 24:
                                raise ValueError
                        except ValueError:
                            body, code = {"error": "BAD_MONTHS"}, 400
                        else:
                            t = service.trend_for_event(ro, m.group(1), months)
                            body, code = (t, 200) if t else ({"error": "NOT_FOUND"}, 404)
                elif (m := _EVENT_RELATED_RE.match(u.path)):
                    rel = _related(ro, m.group(1))
                    body, code = (rel, 200) if rel else ({"error": "NOT_FOUND"}, 404)
                elif u.path == "/api/insight/health-score":
                    if not service:
                        body, code = {"error": "DWS_UNAVAILABLE"}, 503
                    else:
                        body, code = service.health(
                            date.today() - timedelta(days=1)), 200
```

注意：`/api/insight/health` 存活检查分支（api_main.py:140）**保持不动**。

4g. `main()`（api_main.py:159-166）：构造 runner 传 make_server：

```python
def main():
    import os
    path = os.environ["INSIGHT_DB_PATH"]
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)   # 只读（红线）
    db.row_factory = sqlite3.Row
    port = int(os.environ.get("INSIGHT_PORT", "58095"))
    from .dws import DwsQueryRunner
    runner = (DwsQueryRunner(app_name="insight-trend", timeout_ms=30000)
              if os.environ.get("DWS_PASSWORD") else None)
    print(f"insight-api listening 127.0.0.1:{port} dws={'on' if runner else 'off'}")
    make_server(db, port=port, trend_runner=runner).serve_forever()
```

- [ ] **Step 5: 通过** `python -m pytest insight/tests/test_api.py -q`（既有 + 新 4）
- [ ] **Step 6: 全量** `python -m pytest insight/ -q`
- [ ] **Step 7: 提交**

```bash
git add insight/trend_service.py insight/api_main.py insight/tests/test_api.py
git commit -m "feat(mi5): insight-api四端点——trend(缓存+months校验)/health-score(无DWS 503)/related/active+daily归因摘要与数据日/detail补resolved_at" -- insight/trend_service.py insight/api_main.py insight/tests/test_api.py
```

---

## Task 7: 部署接线 + runbook + live 冒烟（harness，运维）

**Files:**
- Modify: `insight/PIPELINE_RUNBOOK.md`
- Modify: `D:\m0-sessions\prod\ecosystem.config.cjs`（生产 pm2 定义，非仓内）

- [ ] **Step 1: ecosystem.config.cjs 给 insight-api 增 DWS env**

读 `D:\m0-sessions\prod\ecosystem.config.cjs`，找到 insight-api 进程块（或新增块），env 补齐（**密码不写进任何输出/日志**——从既有 insight-worker 块复制 DWS_* 五项）：

```js
env: {
  INSIGHT_DB_PATH: "D:\\m0-sessions\\prod\\insight\\insight.db",
  INSIGHT_PORT: "58095",
  PYTHONUTF8: "1",
  DWS_HOST: "121.37.200.214", DWS_PORT: "8000", DWS_DBNAME: "DP_DWS",
  DWS_USER: "aiuser", DWS_PASSWORD: "<与 insight-worker 相同，从其 env 块复制>",
}
```

若 insight-api 不在 ecosystem 文件里（当时是 `pm2 start` 裸起的），把它补成正式块（script: `python -m insight.api_main`，cwd: `D:\dataprojai-2harness`，name: `insight-api`），后续 `pm2 resurrect` 才能自愈。

- [ ] **Step 2: 重启并验证**

```bash
cd /d/m0-sessions/prod
pm2 startOrReload ecosystem.config.cjs --update-env
sleep 2
curl -s http://127.0.0.1:58095/api/insight/health                 # {"ok": true, "db": "open"}
curl -s "http://127.0.0.1:58095/api/insight/events?state=active" | head -c 300   # db-only，应 200
curl -s "http://127.0.0.1:58095/api/insight/health-score" | head -c 500          # 真查 DWS，三环应 available:true
curl -s "http://127.0.0.1:58095/api/insight/events/ev-f31805a5958a/trend" | head -c 500
pm2 save
```

Expected: health ok；active 200 含事件；health-score 三环 available:true 且分数 0-100；trend 返回 kind=month_compare 或 target 的 cumulative_dual、series 长度 ≥6。任一 DWS 端点 503 → 查 pm2 logs insight-api（env 未带上）。

- [ ] **Step 3: runbook 追加**（PIPELINE_RUNBOOK.md 末尾新节）

```markdown
## §M-i5 趋势/健康度端点（2026-09-30）

- insight-api 新增 4 端点：`/api/insight/health-score`、`/api/insight/events?state=active`、
  `/api/insight/events/:id/trend?months=12`（上限 24）、`/api/insight/events/:id/related`。
- trend/health-score **需要 DWS env**（DWS_PASSWORD 等，同 insight-worker）；缺 DWS_PASSWORD
  时进程照常起（db 端点正常），这两个端点 503 DWS_UNAVAILABLE——BFF 显示降级态不炸页。
- 缓存进程内（key 含数据日，as_of 变更自然失效）；重启即冷。
- 健康度因子：`insight/config/health.json`——改动留台账 eval_results/insight-gray/（D-c2）。
- 冒烟：curl health-score 三环 available:true；curl 任一上榜事件 trend 有 series。
```

- [ ] **Step 4: 提交**（runbook）

```bash
git add insight/PIPELINE_RUNBOOK.md
git commit -m "docs(mi5): runbook补M-i5四端点/DWS env前置/缓存语义/因子台账" -- insight/PIPELINE_RUNBOOK.md
```

---

## Task 8: BFF insight.ts 四代理 + 测试（dataplat-ui）

**Files:**
- Modify: `server/src/insight.ts`（在既有 `r.get("/timeline", ...)` 后追加）
- Test: `server/test/insight.test.ts`（追加）

- [ ] **Step 1: 失败测试**（insight.test.ts 追加）

```typescript
test("M-i5 四新端点代理与门禁", async () => {
  const insight = await startMockGateway((req, res) => {
    const json = (b: unknown) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(b));
    };
    if (req.url === "/api/insight/health-score") return json({ as_of: "2026-09-29", rings: [], target: null });
    if (req.url === "/api/insight/events?state=active") return json({ briefDate: "2026-09-30", events: [] });
    if (req.url === "/api/insight/events/ev-1/trend?months=12") return json({ kind: "month_compare", series: [] });
    if (req.url === "/api/insight/events/ev-1/related") return json({ sameType: [], sameRegion: [] });
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "NOT_FOUND" }));
  });
  const bff = await startBff({ insightUrl: insight.url });
  try {
    bff.store.upsertUser("u1", hashPw("pw"));
    const li = await login(bff.port, "u1", "pw");
    await t_assert_gate_and_proxy(bff.port, li.sid, insight);
  } finally {
    await bff.close();
    await insight.close();
  }
});

async function t_assert_gate_and_proxy(port: number, sid: string, insight: { requests: Array<{ url: string }> }) {
  const paths = [
    "/api/insight/health-score",
    "/api/insight/events?state=active",
    "/api/insight/events/ev-1/trend?months=12",
    "/api/insight/events/ev-1/related",
  ];
  for (const p of paths) {
    const r403 = await request(port, "GET", p, { cookie: `sid=${sid}` });
    assert.equal(r403.status, 403);            // 未开 flag 全部 FLAG_OFF
    assert.equal(r403.body.error.code, "FLAG_OFF");
  }
}
```

（实现者注意：上面拆了个辅助函数导致 flag 开后半段断言缺失——**按第三个既有测试的写法组织**：
单个 test 内先 403 断言 → `bff.store.setFlag("u1","insight_cockpit",true)` → 逐路径 200 断言
body 关键字段 + `insight.requests.some(q => q.url === "<上游路径>")`。最终以你写出的完整
断言为准，不要留半截辅助函数。）

- [ ] **Step 2: 确认失败** `cd server && npm test`（新测试 404/断言失败）
- [ ] **Step 3: 实现**（insight.ts，timeline 路由后追加四条）

```typescript
  r.get("/events", gate, (req, res) => {
    void proxy(res, `/api/insight/events${req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""}`);
  });
  r.get("/events/:id/trend", gate, (req, res) => {
    void proxy(res, `/api/insight/events/${encodeURIComponent(req.params.id)}/trend${req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""}`);
  });
  r.get("/events/:id/related", gate, (req, res) => {
    void proxy(res, `/api/insight/events/${encodeURIComponent(req.params.id)}/related`);
  });
  r.get("/health-score", gate, (req, res) => {
    void proxy(res, "/api/insight/health-score");
  });
```

- [ ] **Step 4: 通过** `cd server && npm test`（82 + 新 1 全绿）
- [ ] **Step 5: 提交**

```bash
git add server/src/insight.ts server/test/insight.test.ts
git commit -m "feat(mi5): BFF四代理——health-score/events列表/trend/related(flag门禁复用)"
```

---

## Task 9: 前端类型 + API 函数 + MiniTrendChart（dataplat-ui）

**Files:**
- Modify: `web/src/types.ts`（InsightFollowupResult 后追加）
- Modify: `web/src/api.ts`（insight 节追加）
- Create: `web/src/components/insights/MiniTrendChart.tsx`

- [ ] **Step 1: types.ts 追加**

```typescript
export type InsightTrendKind = "month_compare" | "month_single" | "cumulative_dual";
export interface InsightTrendPoint { month: string; cur: number | null; prev: number | null; }
export interface InsightTrend {
  detector: string; anchor_id: string; unit: string; kind: InsightTrendKind;
  series: InsightTrendPoint[];
  meta?: { cum_actual_wan?: number; cum_target_wan?: number; as_of?: string };
}
export interface InsightHealthRing {
  key: string; label: string; available?: boolean;
  score?: number; mom_delta?: number; formula?: string; reason?: string;
  inputs?: Record<string, unknown>;
}
export interface InsightHealthScore {
  as_of: string;
  rings: InsightHealthRing[];
  target: { year: number; achieve_pct: number; actual_wan: number;
            annual_target_wan: number; time_pct: number } | null;
}
export interface InsightActiveEvent {
  event_id: string; detector: string; event_type: string; title: string;
  summary: string; severity: "major" | "minor"; score: number; persist_days: number;
  first_seen_date: string; lifecycle: string; attribution_status: string;
  publishedToday: boolean; rankToday: number | null; scoreGap: number;
}
export interface InsightRelatedEvent {
  event_id: string; title: string; severity: "major" | "minor";
  data_date: string; created_at: number;
}
export interface InsightRelated { sameType: InsightRelatedEvent[]; sameRegion: InsightRelatedEvent[]; }
```

- [ ] **Step 2: api.ts 追加**（insight 节）

```typescript
export const apiInsightHealthScore = () => api<InsightHealthScore>("GET", "/api/insight/health-score");
export const apiInsightActiveEvents = () => api<{ briefDate: string; events: InsightActiveEvent[] }>("GET", "/api/insight/events?state=active");
export const apiInsightTrend = (eventId: string, months = 12) =>
  api<InsightTrend>("GET", `/api/insight/events/${encodeURIComponent(eventId)}/trend?months=${months}`);
export const apiInsightRelated = (eventId: string) =>
  api<InsightRelated>("GET", `/api/insight/events/${encodeURIComponent(eventId)}/related`);
```

（import type 行同步补 InsightTrend / InsightHealthScore / InsightActiveEvent / InsightRelated。）

- [ ] **Step 3: MiniTrendChart.tsx**（纯 SVG 四图型，无图表库）

```tsx
// M-i5 迷你趋势图（spec §4.1 kind 四型）。纯 SVG——卡片内嵌 120px 高、详情页趋势卡共用。
// 空序列/全 null → 空态文案（诚实，不画假线）。
import type { InsightTrend } from "../../types";

const W = 240, H = 120, PAD = 6;

export default function MiniTrendChart({
  trend, height, showLegend = false,
}: { trend: InsightTrend | null; height?: number; showLegend?: boolean }) {
  if (!trend || trend.series.length === 0 ||
      trend.series.every((p) => p.cur == null && p.prev == null)) {
    return <div className="flex h-[80px] items-center justify-center text-xs text-slate-300">暂无趋势序列</div>;
  }
  const n = trend.series.length;
  const vals = trend.series.flatMap((p) => [p.cur, p.prev]).filter((v): v is number => v != null);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = hi - lo || 1;
  const x = (i: number) => PAD + (i * (W - 2 * PAD)) / Math.max(n - 1, 1);
  const y = (v: number) => PAD + (1 - (v - lo) / span) * (H - 2 * PAD);
  const pts = (key: "cur" | "prev") =>
    trend!.series.map((p, i) => (p[key] == null ? null : `${x(i)},${y(p[key]!)}`))
      .reduce<string[][]>((acc, s) => (s ? [...acc.slice(0, -1), [...(acc[acc.length - 1] ?? []), s]]
                                         : [...acc, []]), [[]])
      .filter((seg) => seg.length > 1).map((seg) => seg.join(" "));
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: height ?? 120 }} role="img"
           aria-label={`${trend.anchor_id} 趋势`}>
        {trend.kind === "month_compare" && trend.series.map((p, i) => {
          const bw = (W - 2 * PAD) / n / 2.6;
          return p.cur == null && p.prev == null ? null : (
            <g key={p.month}>
              {p.prev != null && <rect x={x(i) - bw - 1} width={bw} fill="#bfdbfe"
                 y={y(p.prev)} height={Math.max(H - PAD - y(p.prev), 1)} />}
              {p.cur != null && <rect x={x(i) + 1} width={bw} fill="#2563eb"
                 y={y(p.cur)} height={Math.max(H - PAD - y(p.cur), 1)} />}
            </g>
          );
        })}
        {trend.kind === "month_single" && (
          <>
            <polygon fill="rgba(239,68,68,0.12)" clipPath="none"
              points={`${x(0)},${H - PAD} ${pts("cur").join(" ").replace(/ /g, " ")} ${x(n - 1)},${H - PAD}`}
              visibility={trend.detector === "ar_risk" ? "visible" : "hidden"} />
            <polyline fill="none" stroke={trend.detector === "ar_risk" ? "#ef4444" : "#2563eb"}
              strokeWidth="2" points={pts("cur").join(" ")} />
          </>
        )}
        {trend.kind === "cumulative_dual" && (
          <>
            <polyline fill="none" stroke="#94a3b8" strokeWidth="1.5" strokeDasharray="4 3" points={pts("prev").join(" ")} />
            <polyline fill="none" stroke="#2563eb" strokeWidth="2" points={pts("cur").join(" ")} />
          </>
        )}
      </svg>
      {showLegend && (
        <div className="mt-1 flex gap-3 text-[11px] text-slate-400">
          {trend.kind === "month_compare" && (<><span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-blue-200" />上年同期</span><span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-blue-600" />本期</span></>)}
          {trend.kind === "month_single" && <span>单位：{trend.unit}（{trend.series[0].month} ~ {trend.series[trend.series.length - 1].month}）</span>}
          {trend.kind === "cumulative_dual" && (<><span><i className="mr-1 inline-block h-0.5 w-3 bg-slate-400" />时间进度</span><span><i className="mr-1 inline-block h-0.5 w-3 bg-blue-600" />累计达成</span></>)}
        </div>
      )}
    </div>
  );
}
```

> `pts()` 里的 reduce 分段写法较绕（处理 null 断点）；若实现时不易读，可改成简单版：把
> null 点直接跳过连成一条线（序列来自月度聚合，实际断点极罕见），**但空序列/全 null 的
> 空态分支必须保留**。二选一，以可读性优先。

- [ ] **Step 4: build 验证** `cd web && npm run build` → 零错误（MiniTrendChart 暂无消费者，tsc noUnusedLocals 若报则先不导出消费，T10 接线）
- [ ] **Step 5: 提交**

```bash
git add web/src/types.ts web/src/api.ts web/src/components/insights/MiniTrendChart.tsx
git commit -m "feat(mi5): 前端类型/4个API函数/MiniTrendChart纯SVG四图型"
```

---

## Task 10: 首页改版（dataplat-ui）

**Files:**
- Modify: `web/src/components/insights/TodayAttentionHeader.tsx`
- Modify: `web/src/components/insights/BusinessEventCard.tsx`
- Modify: `web/src/components/insights/OperatingDashboardPage.tsx`
- Create: `web/src/components/insights/HealthPanel.tsx`

- [ ] **Step 1: TodayAttentionHeader 改版**（chips + 数据更新行；watching 由父级传入）

```tsx
import type { InsightDaily } from "../../types";

export default function TodayAttentionHeader({
  daily, watching,
}: { daily: InsightDaily | null; watching: number }) {
  const major = daily?.events.filter((e) => e.severity === "major").length ?? 0;
  const minor = daily?.events.filter((e) => e.severity === "minor").length ?? 0;
  return (
    <div className="px-8 pt-8 pb-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold text-slate-900">今日经营关注</h1>
        {daily && (
          <span className="text-xs text-slate-400">
            数据更新：{daily.briefDate} 简报 · 数据日 {daily.dataDate}
          </span>
        )}
      </div>
      <p className="mt-1 text-sm text-slate-500">
        {daily
          ? daily.dataFreshness.overall === "not_ready"
            ? "数据未就绪——今日简报未定稿，不代表无异常"
            : `截至 ${daily.briefDate}，发现 ${daily.eventCount} 件值得关注的经营事项${daily.stale ? "（当前为最近一期已发布简报）" : ""}`
          : "加载中…"}
      </p>
      <div className="mt-3 flex gap-2 text-xs">
        <span className="rounded-full bg-red-50 px-3 py-1 text-red-600">重大异常 {major}</span>
        <span className="rounded-full bg-orange-50 px-3 py-1 text-orange-500">一般异常 {minor}</span>
        <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-500">观察中 {watching}</span>
      </div>
    </div>
  );
}
```

（types.ts 的 `InsightDaily` 需补 `dataDate: string | null;` 与 events 的 `attributionSummary: string | null; attributionStatus: string;`——InsightDailyEvent 接口加两字段。）

- [ ] **Step 2: BusinessEventCard 加迷你图 + AI 洞察行**

```tsx
import { useEffect, useState } from "react";
import { ApiError, apiInsightTrend } from "../../api";
import type { InsightDailyEvent, InsightTrend } from "../../types";
import MiniTrendChart from "./MiniTrendChart";

export const severityStyle = (e: { severity: string }) =>
  e.severity === "major"
    ? { chip: "bg-red-50 text-red-600", bar: "bg-red-500" }
    : e.severity === "minor"
      ? { chip: "bg-orange-50 text-orange-500", bar: "bg-orange-400" }
      : { chip: "bg-blue-50 text-blue-600", bar: "bg-blue-500" };
const severityLabel = (e: InsightDailyEvent) =>
  e.eventType === "target_gap" ? "目标偏差" : e.severity === "major" ? "重大异常" : "一般异常";

export default function BusinessEventCard({
  event, rank, onOpen,
}: { event: InsightDailyEvent; rank: number; onOpen: (id: string) => void }) {
  const st = severityStyle(event);
  const [trend, setTrend] = useState<InsightTrend | null>(null);
  useEffect(() => {
    let alive = true;                                   // 卸载防泄漏
    apiInsightTrend(event.eventId).then((t) => alive && setTrend(t)).catch(() => {});
    return () => { alive = false; };
  }, [event.eventId]);
  const insight = event.attributionSummary?.trim() || null;
  return (
    <div className="relative overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-100">
      <div className={`absolute inset-y-0 left-0 w-1 ${st.bar}`} />
      <div className="p-5 pl-6">
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400">0{rank}</span>
          <span className={`rounded-full px-2 py-0.5 text-xs ${st.chip}`}>{severityLabel(event)}</span>
          {event.persistDays > 1 && (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">持续第 {event.persistDays} 天</span>
          )}
        </div>
        <h3 className="mt-2 text-base font-semibold text-slate-900">{event.title}</h3>
        <p className="mt-1 line-clamp-2 text-sm text-slate-500">{event.summary}</p>
        <div className="mt-3"><MiniTrendChart trend={trend} /></div>
        <div className="mt-3 flex flex-wrap gap-4">
          {event.facts.slice(0, 3).map((f) => (
            <div key={f.label}>
              <div className="text-xs text-slate-400">{f.label}</div>
              <div className="text-sm font-medium text-slate-800">{f.value}</div>
            </div>
          ))}
        </div>
        {insight && (
          <div className="mt-3 rounded-lg bg-blue-50/60 p-3">
            <div className="text-[11px] font-medium text-blue-500">AI 洞察</div>
            <p className="mt-1 line-clamp-3 text-xs text-slate-600">{insight}</p>
          </div>
        )}
        <button
          className="mt-4 rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
          onClick={() => onOpen(event.eventId)}
        >
          查看详情
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: HealthPanel 新组件**（四环 + 目标环 + 分数弹层）

```tsx
// M-i5 经营健康度卡（spec §5/§6）：确定性映射分数，点击看算式（D-c1"分数谁定的"）。
// 库存环=灰态未接入（诚实红线）；某环 available:false 显示原因行——不造分。
import { useEffect, useState } from "react";
import { apiInsightHealthScore } from "../../api";
import type { InsightHealthRing } from "../../types";

function Ring({ value, color }: { value: number; color: string }) {
  const r = 26, c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 64 64" className="h-16 w-16">
      <circle cx="32" cy="32" r={r} fill="none" stroke="#e2e8f0" strokeWidth="6" />
      <circle cx="32" cy="32" r={r} fill="none" stroke={color} strokeWidth="6"
        strokeDasharray={`${(c * Math.min(value, 100)) / 100} ${c}`}
        strokeLinecap="round" transform="rotate(-90 32 32)" />
    </svg>
  );
}

const ringColor = (s: number) => (s < 60 ? "#ef4444" : s < 80 ? "#f97316" : "#2563eb");

export default function HealthPanel() {
  const [data, setData] = useState<Awaited<ReturnType<typeof apiInsightHealthScore>> | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    apiInsightHealthScore().then(setData).catch(() => setData(null));
  }, []);
  if (!data) {
    return (
      <div className="rounded-xl bg-white p-5 ring-1 ring-slate-100 text-sm text-slate-400">
        经营健康度加载中…
      </div>
    );
  }
  return (
    <div className="rounded-xl bg-white p-5 ring-1 ring-slate-100">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-slate-900">经营健康度</h3>
        <span className="text-[11px] text-slate-400">截至 {data.as_of}</span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        {data.rings.map((r) => (
          <button key={r.key} className="relative flex flex-col items-center rounded-lg p-2 hover:bg-slate-50"
                  onClick={() => setOpen(open === r.key ? null : r.key)}>
            {r.available && r.score != null ? (
              <>
                <Ring value={r.score} color={ringColor(r.score)} />
                <div className="absolute inset-x-0 top-7 text-center text-sm font-semibold text-slate-800">
                  {r.score}
                </div>
                <div className="text-[11px] text-slate-500">{r.label}</div>
                {r.mom_delta != null && (
                  <div className={`text-[10px] ${r.mom_delta >= 0 ? "text-emerald-600" : "text-red-500"}`}>
                    {r.mom_delta >= 0 ? "▲" : "▼"} 较上期 {Math.abs(r.mom_delta)}
                  </div>
                )}
              </>
            ) : (
              <div className="flex h-16 w-full flex-col items-center justify-center text-slate-300">
                <span className="text-xs">未接入</span>
              </div>
            )}
            {open === r.key && (
              <div className="absolute z-10 mt-2 w-56 rounded-lg bg-slate-900 p-3 text-left text-[11px] leading-relaxed text-slate-100 shadow-lg">
                <div className="font-medium text-white">{r.label}</div>
                <div className="mt-1">{r.available ? r.formula : r.reason}</div>
                {r.inputs && (
                  <div className="mt-1 text-slate-400">
                    输入：{Object.entries(r.inputs).map(([k, v]) => `${k}=${String(v)}`).join("，")}
                  </div>
                )}
              </div>
            )}
          </button>
        ))}
      </div>
      {data.target && (
        <div className="mt-4 rounded-lg bg-slate-50 p-3">
          <div className="text-xs text-slate-500">{data.target.year} 年目标进度</div>
          <div className="mt-1 flex items-center gap-3">
            <div className="relative">
              <Ring value={data.target.achieve_pct} color="#2563eb" />
              <div className="absolute inset-x-0 top-7 text-center text-xs font-semibold text-slate-800">
                {data.target.achieve_pct}%
              </div>
            </div>
            <div className="text-[11px] leading-relaxed text-slate-500">
              <div>实际 {data.target.actual_wan.toLocaleString()} 万</div>
              <div>年度目标 {data.target.annual_target_wan.toLocaleString()} 万</div>
              <div>时间进度 {data.target.time_pct}%</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: OperatingDashboardPage 改版**（卡片行 + 右列健康卡 + 观察中计数）

```tsx
import { useEffect, useState } from "react";
import { ApiError, apiInsightActiveEvents, apiInsightDaily } from "../../api";
import type { InsightActiveEvent, InsightDaily } from "../../types";
import TodayAttentionHeader from "./TodayAttentionHeader";
import BusinessEventList from "./BusinessEventList";
import EventCenterView from "./EventCenterView";
import HealthPanel from "./HealthPanel";

export default function OperatingDashboardPage({ onOpenEvent }: { onOpenEvent: (id: string) => void }) {
  const [daily, setDaily] = useState<InsightDaily | null>(null);
  const [active, setActive] = useState<InsightActiveEvent[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    apiInsightDaily().then(setDaily).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
    apiInsightActiveEvents().then((r) => setActive(r.events)).catch(() => setActive([]));
  }, []);
  const watching = (active?.filter((e) => !e.publishedToday).length) ?? 0;
  if (err) {
    return (
      <div className="p-8 text-sm text-slate-500">
        经营洞察暂不可用，AI 问数不受影响。
        <br />
        <span className="text-xs text-slate-400">{err}</span>
      </div>
    );
  }
  return (
    <div className="h-full overflow-y-auto bg-slate-50">
      <TodayAttentionHeader daily={daily} watching={watching} />
      <div className="flex flex-col gap-4 px-8 xl:flex-row">
        <div className="min-w-0 flex-1">
          <BusinessEventList events={daily?.events ?? []} onOpen={onOpenEvent} />
          {daily && daily.dataFreshness.overall !== "ready" && daily.dataFreshness.radars.length > 0 && (
            <div className="mt-4 rounded-xl bg-amber-50 p-4 text-xs text-amber-700 ring-1 ring-amber-100">
              部分雷达数据未就绪：{daily.dataFreshness.radars.filter((r) => !r.ready).map((r) => r.detector).join("、")}
            </div>
          )}
        </div>
        <div className="xl:w-80 xl:shrink-0"><HealthPanel /></div>
      </div>
      <div className="mt-6 px-8 pb-8">
        <EventCenterView onOpen={onOpenEvent} />
      </div>
    </div>
  );
}
```

- [ ] **Step 5: build** `cd web && npm run build` → 零错误
- [ ] **Step 6: 提交**

```bash
git add web/src/components/insights/TodayAttentionHeader.tsx web/src/components/insights/BusinessEventCard.tsx web/src/components/insights/OperatingDashboardPage.tsx web/src/components/insights/HealthPanel.tsx web/src/types.ts
git commit -m "feat(mi5): 首页三件套——chips+数据更新行/事件卡迷你图+AI洞察/健康度四环+目标环(分数可查算式)"
```

---

## Task 11: 详情页补全——趋势卡/状态流/相关事件（dataplat-ui）

**Files:**
- Modify: `web/src/components/insights/TrendPanel.tsx`（占位→真数据）
- Create: `web/src/components/insights/StatusFlowCard.tsx`
- Create: `web/src/components/insights/RelatedEventsCard.tsx`
- Modify: `web/src/components/insights/EventDetailPage.tsx`
- Modify: `web/src/App.tsx`（EventDetailPage 挂 onOpenEvent 一行）
- Modify: `web/src/types.ts`（InsightEventDetail 补 resolved_at/generatedAt，见下）

- [ ] **Step 1: types.ts InsightEventDetail 两处补字段**：`event` 对象内加 `resolved_at: number | null;`；`attribution` 内加 `generatedAt: number | null;`

- [ ] **Step 2: TrendPanel.tsx 全量重写**

```tsx
// M-i5 趋势卡（spec §4.1）：按事件锚点取月度序列；月份下拉（区域选择）v1.1 不做——单锚点。
import { useEffect, useState } from "react";
import { apiInsightTrend } from "../../api";
import type { InsightTrend } from "../../types";
import MiniTrendChart from "./MiniTrendChart";

export default function TrendPanel({ eventId }: { eventId: string }) {
  const [trend, setTrend] = useState<InsightTrend | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    apiInsightTrend(eventId).then((t) => alive && setTrend(t)).catch(() => alive && setFailed(true));
    return () => { alive = false; };
  }, [eventId]);
  const last = trend?.series.filter((p) => p.cur != null && p.prev != null).at(-1);
  const yoy = last && last.prev ? Math.round((last.cur! / last.prev - 1) * 1000) / 10 : null;
  return (
    <div className="rounded-xl bg-white p-6 ring-1 ring-slate-100">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-slate-900">趋势变化</h3>
        {yoy != null && (
          <span className={`text-xs font-medium ${yoy < 0 ? "text-red-500" : "text-emerald-600"}`}>
            最新期 {yoy > 0 ? "+" : ""}{yoy}%
          </span>
        )}
      </div>
      <div className="mt-3">
        {failed
          ? <div className="rounded-lg border border-dashed border-slate-200 p-6 text-center text-sm text-slate-400">趋势序列暂不可用（不影响归因与事实）</div>
          : <MiniTrendChart trend={trend} height={200} showLegend />}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: StatusFlowCard.tsx**（诚实四节点，D-c5）

```tsx
// M-i5 事件状态流（D-c5 诚实映射）：发现→归因(三态)→持续→已解除。不造"待跟进"（督办是 v4）。
import type { InsightEventDetail } from "../../types";

export default function StatusFlowCard({ d }: { d: InsightEventDetail }) {
  const attrState = d.attribution.status === "done" ? "归因完成"
    : d.attribution.status === "degraded" ? "归因降级"
    : d.attribution.status === "failed" ? "归因失败"
    : d.attribution.status === "running" ? "归因中" : "待归因";
  const nodes = [
    { label: "发现", sub: d.event.first_seen_date, on: true },
    { label: attrState, sub: d.attribution.generatedAt
        ? new Date(d.attribution.generatedAt * 1000).toLocaleDateString() : "", on: d.attribution.status !== "pending" },
    { label: `持续 ${d.event.persist_days} 天`, sub: "", on: d.event.lifecycle === "active" },
    { label: "已解除", sub: d.event.resolved_at
        ? new Date(d.event.resolved_at * 1000).toLocaleDateString() : "", on: d.event.lifecycle === "resolved" },
  ];
  return (
    <div className="rounded-xl bg-white p-5 ring-1 ring-slate-100">
      <h3 className="text-sm font-semibold text-slate-900">事件状态</h3>
      <div className="mt-4 flex items-start">
        {nodes.map((n, i) => (
          <div key={n.label} className="flex flex-1 items-start last:flex-none">
            <div className="flex flex-col items-center">
              <span className={`h-3 w-3 rounded-full ${n.on ? "bg-blue-600" : "bg-slate-200"}`} />
              <span className={`mt-1 whitespace-nowrap text-[11px] ${n.on ? "text-slate-700" : "text-slate-300"}`}>{n.label}</span>
              {n.sub && <span className="text-[10px] text-slate-400">{n.sub}</span>}
            </div>
            {i < nodes.length - 1 && (
              <div className={`mx-1 mt-1.5 h-0.5 flex-1 ${n.on ? "bg-blue-200" : "bg-slate-100"}`} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: RelatedEventsCard.tsx**（同类/同区域两 tab，D-c6）

```tsx
import { useEffect, useState } from "react";
import { apiInsightRelated } from "../../api";
import type { InsightRelated } from "../../types";

export default function RelatedEventsCard({
  eventId, onOpen,
}: { eventId: string; onOpen: (id: string) => void }) {
  const [rel, setRel] = useState<InsightRelated | null>(null);
  const [tab, setTab] = useState<"sameType" | "sameRegion">("sameType");
  useEffect(() => {
    let alive = true;
    apiInsightRelated(eventId).then((r) => alive && setRel(r)).catch(() => alive && setRel(null));
    return () => { alive = false; };
  }, [eventId]);
  const items = rel?.[tab] ?? [];
  return (
    <div className="rounded-xl bg-white p-6 ring-1 ring-slate-100">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-slate-900">相关经营事件</h3>
        <div className="flex gap-2 text-xs">
          <button className={tab === "sameType" ? "text-blue-600" : "text-slate-400"}
                  onClick={() => setTab("sameType")}>同类</button>
          <button className={tab === "sameRegion" ? "text-blue-600" : "text-slate-400"}
                  onClick={() => setTab("sameRegion")}>同区域</button>
        </div>
      </div>
      <div className="mt-3 flex flex-col gap-2">
        {items.length === 0 && <div className="text-xs text-slate-400">暂无相关事件</div>}
        {items.map((e) => (
          <button key={e.event_id} className="flex items-center justify-between rounded-lg px-3 py-2 text-left hover:bg-slate-50"
                  onClick={() => onOpen(e.event_id)}>
            <span className="truncate text-xs text-slate-700">{e.title}</span>
            <span className="ml-2 shrink-0 text-[11px] text-slate-400">{e.data_date}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: EventDetailPage 接线**（读现有文件后做三处 additive 改动）
  1. props 加 `onOpenEvent: (id: string) => void`；
  2. `<TrendPanel />` → `<TrendPanel eventId={eventId} />`；
  3. 组件树尾部（EventFollowupPanel 附近）挂 `<StatusFlowCard d={d} />` 与 `<RelatedEventsCard eventId={eventId} onOpen={onOpenEvent} />`（跟随现有布局节奏，右列或底部均可，与 SuggestedActionsPanel 灰底区视觉对齐）。

- [ ] **Step 6: App.tsx 一行**：`<EventDetailPage eventId={openEventId} onBack={...} onFollowed={...}` 加 `onOpenEvent={(id) => setOpenEventId(id)}`

- [ ] **Step 7: build** `cd web && npm run build` → 零错误
- [ ] **Step 8: 提交**

```bash
git add web/src/components/insights/TrendPanel.tsx web/src/components/insights/StatusFlowCard.tsx web/src/components/insights/RelatedEventsCard.tsx web/src/components/insights/EventDetailPage.tsx web/src/App.tsx web/src/types.ts
git commit -m "feat(mi5): 详情页补全——趋势卡真数据/状态流诚实四节点/相关事件同类同区域"
```

---

## Task 12: 事件中心观察中 + 总验收 + eval 复跑（dataplat-ui + harness）

**Files:**
- Modify: `web/src/components/insights/EventCenterView.tsx`

- [ ] **Step 1: EventCenterView 加"观察中"分区**

```tsx
import { useEffect, useState } from "react";
import { apiInsightActiveEvents, apiInsightTimeline } from "../../api";
import type { InsightActiveEvent, InsightTimelineItem } from "../../types";
import BusinessEventTimeline from "./BusinessEventTimeline";

export default function EventCenterView({ onOpen }: { onOpen: (id: string) => void }) {
  const [items, setItems] = useState<InsightTimelineItem[] | null>(null);
  const [active, setActive] = useState<InsightActiveEvent[] | null>(null);
  useEffect(() => {
    apiInsightTimeline(90).then(setItems).catch(() => setItems([]));
    apiInsightActiveEvents().then((r) => setActive(r.events)).catch(() => setActive([]));
  }, []);
  const watching = (active ?? []).filter((e) => !e.publishedToday);
  return (
    <div className="flex flex-col gap-4">
      {watching.length > 0 && (
        <div className="rounded-xl bg-white p-6 ring-1 ring-slate-100">
          <div className="flex items-baseline justify-between">
            <h3 className="text-sm font-semibold text-slate-900">
              观察中（active 未上榜，距发布线差值）
            </h3>
            <span className="text-xs text-slate-400">{watching.length} 条</span>
          </div>
          <div className="mt-2 flex flex-col divide-y divide-slate-50">
            {watching.map((e) => (
              <button key={e.event_id} className="flex items-center gap-3 py-2 text-left hover:bg-slate-50"
                      onClick={() => onOpen(e.event_id)}>
                <span className={`w-1 self-stretch rounded ${e.severity === "major" ? "bg-red-500" : "bg-orange-400"}`} />
                <span className="min-w-0 flex-1 truncate text-sm text-slate-700">{e.title}</span>
                <span className="shrink-0 text-xs text-slate-400">持续 {e.persist_days} 天</span>
                <span className="shrink-0 text-xs text-slate-500">分 {e.score}</span>
                <span className="shrink-0 text-[11px] text-slate-400">距上榜 {e.scoreGap}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="rounded-xl bg-white p-6 ring-1 ring-slate-100">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-semibold text-slate-900">经营事件时间线（近 90 天）</h3>
          {items && <span className="text-xs text-slate-400">{items.length} 条</span>}
        </div>
        <div className="mt-2 max-h-80 overflow-y-auto">
          {items === null ? <div className="p-4 text-sm text-slate-400">加载中…</div> : <BusinessEventTimeline items={items} onOpen={onOpen} />}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: build + 双仓全量回归**

```bash
cd /d/dataplat-ui/web && npm run build                       # 零错误
cd /d/dataplat-ui/server && npm test                         # 82+ 全绿
cd /d/dataprojai-2harness && python -m pytest insight/ -q    # 全绿
python -m pytest eval/ -q                                    # 判分器零影响
python run_eval.py                                           # 85 场景离线回归零退化
```

- [ ] **Step 3: 提交**

```bash
git add web/src/components/insights/EventCenterView.tsx
git commit -m "feat(mi5): 事件中心观察中分区——水面下事件透明化(分数/持续/距上榜差值)"
```

- [ ] **Step 4: 生产发布 + 人工验收**（admin-prod 刷新即可见，flag 已开）

```bash
cd /d/dataplat-ui/web && npm run build          # dist 即产物
cd /d/dataplat-ui/server && pm2 restart dataplat-ui   # 静态目录直读 dist，可不重启；保险起见
```

人工验收清单（对 spec §8.5）：
1. 首页：chips 三枚（含观察中 N）、事件卡有迷你图+AI 洞察行、右列健康四环（库存灰）+目标环
2. 点健康环分数 → 弹层显示公式与输入
3. 事件详情：趋势卡有图有图例、状态流四节点、相关事件两 tab 可点跳
4. 事件中心：观察中分区列出未上榜事件（今天应见 3 条 50.7 分区域业绩）
5. 抽 3 个数字对数：健康环分数 vs insight.db/直查 DWS；趋势图末月 vs 事件 facts
6. 网关/skills/eval 零改动确认：`git diff --stat` 两仓只含本计划文件

- [ ] **Step 5: 收尾提交**（若验收中有小修，路径限定提交；然后 harness 侧更新记忆由主会话负责）

---

## Self-Review 记录（写计划时自查）

1. **Spec 覆盖**：§4.1 trend×4=T1-T4；§4.2 health-score=T5/T6；§4.3 active=T6/T12；§4.4 related=T6/T11；§5 公式=T5；§6 组件=T9-T12 全部落位；§7 护栏=TrendService 锁+缓存（T6）；§8 测试=各任务内含+T12 eval 复跑；§9 零侵入=所有 Modify 只 additive。**无缺口**。
2. **占位符**：Task 5 测试里两处"or True"占位已显式标注删除指令；Task 8 测试半截辅助函数已标注按既有写法补全——执行者必须清理，review 时核对。
3. **类型一致性**：`trend(self, run, ctx, anchor_id, months=12)` 四雷达统一；`TrendService.trend_for_event(db, event_id, months)`/`health(as_of)`；API 字段 camelCase（attributionSummary/rankToday/scoreGap/publishedToday）与 types.ts 一致；`make_server(db, host, port, trend_runner=None)` 测试与 main 同签名。
4. **已知裁量点**（执行者可按实码微调，review 不算偏差）：MiniTrendChart `pts()` 分段简化；health.py SALES_SQL 的 ly_field 取法；EventDetailPage 三组件挂载位置。
