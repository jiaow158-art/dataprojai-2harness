# 目标管理页（M-i7）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 spec `docs/superpowers/specs/2026-10-02-insight-target-management-design.md`（v1.0）落地目标管理页：一个 DWS 聚合端点 + 独立页面（年度总览/线性年化外推/月度达成/组织欠进度拆解/一键追问）。

**Architecture:** 新 `insight/target_report.py`（纯函数、runner 注入）→ `TrendService.target_overview(as_of)`（缓存+局部降级）→ api 路由 `/api/insight/target-overview` → BFF 一条代理 → web `TargetManagementPage` + view `"targets"` + Sidebar 第三导航项。

**Tech Stack:** Python stdlib / React+Vite+TS+Tailwind v4（纯 SVG 环与条形，零新依赖）。

---

## 前置事实（写计划时对实码盘点）

1. **两仓**：T1/T2 在 `D:\dataprojai-2harness`；T3/T4 在 `D:\dataplat-ui`；T5 运维主会话。提交路径限定。
2. **radar-target.json params**：`progress_basis="workday"`、`progress_curve=null`、`center_set_month_lag=1`——centers CTE 的前置月=as_of 上月（`shift_month(as_of,-1).strftime("%Y-%m")`）。
3. **复用点**：
   - `insight/detectors/target.py`：`TREND_ACTUAL_SQL`/`TREND_TARGET_SQL`（BU 级月度实绩/目标）、`time_progress_pct(as_of,basis,curve)`（月度工作日进度）
   - `insight/health.py` `_target_block`（annual 口径）与 `TargetDetector().trend()` 的 meta（cum_actual_wan/cum_target_wan）
   - `insight/trend_service.py`：`TrendService`（`_run_with_conn_retry`/缓存/锁）
   - `insight/api_main.py`：health-score 路由旁加新分支（`service` None → 503 DWS_UNAVAILABLE）
   - web：`Sidebar.tsx` NavItem（M-i6.1 已建）、`App.tsx` view 联合、`apiInsightFollowup`、HealthPanel 的 Ring 组件形态
4. **口径锁定（spec §3）**：annual 与 health `_target_block` 完全同源（D-t6）；欠进度额=`目标×时间进度%−实绩`；恢复潜力=`max(0,(上年同期日均−当前日均)×剩余自然日)`；占比分母只计落后者；目标 0/NULL→null 不造。
5. **测试基线**：insight 175+8 skip；dataplat-ui server 83；web=build 零错误。
6. mix 表列：`calmonth`(YYYY-MM)/`calday`(YYYYMMDD)/`node_name5`(中心码)/`ambperformance`；目标表：`stat_month`(YYYY-MM)/`sales_center_code`/`target_sales_amt`（**单位万元**，×10000 转元——与 target.py TREND_TARGET_SQL 一致）；名称映射 `dm_rpt_sales_group_t`（`node_name5`→`MAX(node_desc5)`，`node_desc2='瓷砖事业部'`）。
7. **as_of 语义**：端点用 `date.today()-1`（与 health-score 同）；annual 的实绩侧 `calday<=as_of` MTD 封顶同雷达。
8. epoch/单位：金额一律万元（round 1 位小数）随响应；百分比 round 1 位。

---

## Task 1: insight/target_report.py（harness）

**Files:**
- Create: `insight/target_report.py`
- Test: `insight/tests/test_target_report.py`

- [ ] **Step 1: 失败测试**（完整文件；runner 分派按 SQL 特征串——实现里让每条 SQL 自带可识别注释或特征列名）

```python
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
    """actuals/targets: {month: 万元}; center_*: {center: 万元}（center 集从 targets 键推）。"""
    ly_actuals = ly_actuals or {}
    center_actuals = center_actuals or {}
    center_targets = center_targets or {}
    center_ly = center_ly or {}

    def run(sql, params=None):
        if seen is not None:
            seen.append(sql[:48])
        if fail_on and fail_on in sql:
            raise RuntimeError("dws down")
        if "GROUP BY m.calmonth" in sql or "AS month, SUM(a.ambperformance)" in sql:
            return [{"month": m, "wan": v} for m, v in actuals.items()]
        if "dm_dp_api_sales_target" in sql and "sales_center_code" not in sql:
            return [{"month": m, "wan": v} for m, v in targets.items()]
        if "node_name5 AS center" in sql and "calmonth = ANY" in sql and "2025" not in str(params):
            return [{"center": c, "wan": v} for c, v in center_actuals.items()]
        if "node_name5 AS center" in sql and "ly" in sql.lower():
            return [{"center": c, "wan": v} for c, v in center_ly.items()]
        if "sales_center_code" in sql:
            return [{"center": c, "wan": v} for c, v in center_targets.items()]
        if "LY" in sql or "ly_months" in str(params) or _ly(str(params.get("ym", "2026-01"))) in sql:
            return [{"month": m, "wan": v} for m, v in ly_actuals.items()]
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


def test_centers_behind_share_and_recovery():
    # 两个中心：A 落后（目标1000 实绩500）、B 超前（目标1000 实绩1100）
    ca, ct = {"A": 500.0, "B": 1100.0}, {"A": 1000.0, "B": 1000.0}
    cly = {"A": 3000.0}   # A 上年同期 3000 万 → 日均高 → 有恢复潜力；B 无上年→0
    cs = target_overview(_runner({"2026-09": 1600.0}, {"2026-09": 2000.0},
                                 center_actuals=ca, center_targets=ct, center_ly=cly), CTX)
    centers = cs["centers"]
    a = next(c for c in centers if c["centerCode"] == "A")
    tp = round(265 / 365 * 100, 1)
    assert a["behindWan"] == round(1000 * tp / 100 - 500, 1)
    assert a["behindSharePct"] == 100.0                     # 分母只计落后者（B 超前不计）
    assert a["recoveryWan"] == round(max(0, 3000 / 265 - 1600 / 265) * (365 - 265), 1)
    b = next(c for c in centers if c["centerCode"] == "B")
    assert b["behindWan"] < 0 and b["recoveryWan"] == 0.0    # 超前带负号；上年缺→0
    assert cs["centersTotalBehindWan"] == round(1000 * tp / 100 - 500, 1)


def test_partial_degradation_blocks():
    out = target_overview(_runner({}, {}, fail_on="dm_dp_api_sales_target"), CTX)
    assert out["annual"]["available"] is False              # 目标查询挂→annual 降级
    # months/centers 目标侧同样依赖目标表→一并降级属可接受；projection 依赖 annual→null
    assert out["projection"] is None or out["projection"].get("available") is False
```

（fixture 数值如有窗口手算误差，**以公式为准配平断言**，语义不得变；配平写报告。runner 分派串以实现的真实 SQL 为准调整——先写实现骨架再回头钉分派串是允许的，但断言不得弱化。）

- [ ] **Step 2: 确认失败** `python -m pytest insight/tests/test_target_report.py -q` → ModuleNotFoundError
- [ ] **Step 3: 实现**（结构参考；SQL 全部复用雷达谓词形态）

```python
# insight/target_report.py
"""目标管理页聚合（spec 2026-10-02 §3，D-t1..D-t6）：annual 与 health._target_block 同源、
线性年化外推、月度 MTD、组织欠进度拆解。纯函数、runner 注入；金额万元 round 1。"""
from datetime import date

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

TARGET_SQL = """
SELECT t.stat_month AS month, SUM(t.target_sales_amt) AS wan
FROM dm.dm_dp_api_sales_target t
WHERE t.stat_month = ANY(%(ym)s) AND t.org_type = '业务单位'
GROUP BY t.stat_month
"""

LY_ACTUAL_SQL = ACTUAL_SQL   # 同形，params 换上年 ym（calday 封顶对完整月无影响；当年 9 月 MTD 对上年同日封顶=同窗对比）

CENTER_ACTUAL_SQL = """
SELECT m.node_name5 AS center, SUM(m.ambperformance)/10000 AS wan
FROM dm.dm_fin_operations_mix_sum_t m
WHERE m.calmonth = ANY(%(ym)s)
  AND m.calday <= %(as_of_calday)s
  AND m.node_desc2 = '瓷砖事业部'
  AND m.data_source IN ('S','T','D','')
GROUP BY m.node_name5
"""

CENTER_LY_SQL = CENTER_ACTUAL_SQL   # params 换上年 ym + 上年 as_of 封顶（%(ly_as_of_calday)s）

CENTER_TARGET_SQL = """
WITH centers AS (
  SELECT DISTINCT node_name5 AS center FROM dm.dm_fin_operations_mix_sum_t
  WHERE calmonth = %(center_set_month_ym)s AND node_desc2 = '瓷砖事业部'
    AND data_source IN ('S','T','D','')
), names AS (
  SELECT node_name5 AS center, MAX(node_desc5) AS cname
  FROM dm.dm_rpt_sales_group_t WHERE node_desc2 = '瓷砖事业部' GROUP BY node_name5
)
SELECT t.sales_center_code AS center, SUM(t.target_sales_amt) AS wan,
       MAX(n.cname) AS cname
FROM dm.dm_dp_api_sales_target t
LEFT JOIN names n ON n.center = t.sales_center_code
WHERE t.stat_month = ANY(%(ym)s) AND t.org_type = '业务单位'
  AND t.sales_center_code IN (SELECT center FROM centers)
GROUP BY t.sales_center_code
"""
```

（注意：CENTER_LY 的上年封顶参数——LY 窗口用"上年同日"封顶保持同窗对比：`ly_as_of_calday = as_of 替换年份`；实现时两份 SQL 分开写，别共享同一 params 键。）

```python
def target_overview(run, ctx: ReplayContext) -> dict:
    y = ctx.as_of.year
    days_in_year = 366 if (y % 4 == 0 and (y % 100 != 0 or y % 400 == 0)) else 365
    doy = ctx.as_of.timetuple().tm_yday
    ym = [f"{y}-{m:02d}" for m in range(1, ctx.as_of.month + 1)]
    ly_ym = [f"{y-1}-{m:02d}" for m in range(1, ctx.as_of.month + 1)]
    binds = {"ym": ym, "ly_ym": ly_ym, "as_of_calday": ctx.calday(),
             "ly_as_of_calday": ctx.calday().replace(str(y), str(y-1), 1),
             "center_set_month_ym": shift_month(ctx.as_of, -1).strftime("%Y-%m")}
    ...  # 逐块 try/except（annual/projection/months/centers），块内按 spec 公式；
         # annual 复用 TargetDetector().trend 的 meta（cur/prev 序列与 cum 金额）——
         # D-t6 同源：调 trend 而非重写查询
```

（实现者注意 annual 的 timePct=trend 序列末点 prev（年日内自然日）；months 当月行附 `timePct`（月度工作日，`time_progress_pct(ctx.as_of,"workday",None)`）供 UI 标"进行中"语境；centers 的 timePct 用年日进度（与 behindWan 公式一致）。）

- [ ] **Step 4:** `python -m pytest insight/tests/test_target_report.py -q` 全绿
- [ ] **Step 5:** `python -m pytest insight/ -q` 全绿
- [ ] **Step 6: 提交** `feat(mi7): target_report——annual同源/线性年化/月度MTD/中心欠进度与恢复潜力`

---

## Task 2: TrendService.target_overview + api 路由（harness）

**Files:**
- Modify: `insight/trend_service.py`、`insight/api_main.py`
- Test: `insight/tests/test_api.py`

- [ ] **Step 1: 失败测试**：fake runner（复用 T1 分派形态）→ `/api/insight/target-overview` 200 且 annual.achievePct 数值核算；二次请求 runner 调用数不变（缓存）；`annual+months+centers 全 available:false → 不缓存`（下次重查）；`trend_runner=None → 503 DWS_UNAVAILABLE`
- [ ] **Step 2: 实现**：
  - `TrendService.target_overview(as_of)`：key=("target_overview", iso)；锁内 `_run_with_conn_retry(lambda: target_overview(runner, ReplayContext(as_of)))`；**全降级（三块均非 available/None）不落缓存**（同 health 规则）
  - api_main：`elif u.path == "/api/insight/target-overview":` 分支（service None→503；否则 `service.target_overview(date.today()-timedelta(days=1))`）
- [ ] **Step 3:** 全绿 → 提交 `feat(mi7): /api/insight/target-overview端点——缓存/全降级不缓存/无DWS 503`

---

## Task 3: BFF 代理 + 测试（dataplat-ui）

**Files:**
- Modify: `server/src/insight.ts`、`server/test/insight.test.ts`

- [ ] **Step 1:** 测试：mock handler 加 `/api/insight/target-overview` 分支 → flag 关 403 / 开 200 透传 + 上游 URL 断言（复用既有四端点测试的组织）
- [ ] **Step 2:** 实现：既有四代理旁加 `r.get("/target-overview", gate, ...)` 一条
- [ ] **Step 3:** `cd server && npm test` 84 绿 → 提交 `feat(mi7): BFF target-overview代理(flag门禁)`

---

## Task 4: TargetManagementPage + 接线（dataplat-ui）

**Files:**
- Modify: `web/src/types.ts`、`web/src/api.ts`、`web/src/App.tsx`、`web/src/components/Sidebar.tsx`
- Create: `web/src/components/insights/TargetManagementPage.tsx`

- [ ] **Step 1: types.ts**（EventCenter 族后）：

```typescript
export interface TargetAnnual { achievePct: number; actualWan: number; targetWan: number; timePct: number; }
export interface TargetProjection { dailyWan: number; projectedWan: number; projectedGapWan: number; basis: string; }
export interface TargetMonthRow { month: string; actualWan: number | null; targetWan: number | null;
  achievePct: number | null; yoyPct: number | null; isCurrent: boolean; timePct?: number; }
export interface TargetCenterRow { centerCode: string; centerName: string | null; actualWan: number;
  targetWan: number; achievePct: number; timePct: number; behindWan: number;
  behindSharePct: number; recoveryWan: number; }
export interface TargetOverview { asOf: string; year: number;
  annual: TargetAnnual | { available: false; reason: string };
  projection: TargetProjection | null;
  months: TargetMonthRow[] | { available: false; reason: string };
  centers: TargetCenterRow[] | { available: false; reason: string }; centersTotalBehindWan: number | null; }
```

（实现侧若用统一 `available` 包装则前端类型跟着实现走，语义不变。）

- [ ] **Step 2: api.ts**：`apiInsightTargetOverview = () => api<TargetOverview>("GET", "/api/insight/target-overview");`
- [ ] **Step 3: TargetManagementPage**（结构按 spec §4）：
  - 年度卡：Ring（HealthPanel 同款纯 SVG 环，achievePct 钳 0-100，中心数字+%）+ 右侧三行数（实际/年度目标/时间进度）
  - 外推卡：`预计完成 {projectedWan}万` 大数字；`预计缺口 {projectedGapWan}万`（负值显示"预计超额 {abs}"并绿色）；basis 小字灰
  - 月度表：月份/实际/目标/达成率/同比/状态（isCurrent→"进行中"浅蓝行底+timePct 小字；完整月→"完成"灰字）；null→"—"
  - centers 表：中心（name ?? code）/实际/目标/达成率/时间进度/欠进度额（红正值/绿负"超前"）+行内水平条（宽=behindSharePct%，红）/恢复潜力（绿）；行点击不跳转（避免误触）——**页脚一键追问**：`apiInsightFollowup`（prompt="按当前趋势全年缺口多少？哪些中心有恢复潜力？"）→ onFollowed 既有链路
  - 页 props：`{ onFollowed }`（无 onOpenEvent）；标题行 `目标管理 ｜ {year} 年 · 数据日 {asOf}`
  - 降级块：available:false → 该卡灰底 reason 一行（不造数）；全 null/空数组空态文案
- [ ] **Step 4: App/Sidebar**：view 联合加 `"targets"`；渲染分支 `view === "targets" && insightsOn`（onFollowed 同构 handler）；Sidebar 经营导航区第三项 NavItem「目标管理」（activeView==="targets" 高亮，onClick=props.onTargets → App `setView("targets")`）
- [ ] **Step 5:** `cd web && npm run build` 零错误 + `cd server && npm test` 绿 → 提交 `feat(mi7): TargetManagementPage+侧栏第三导航——年度环/年化外推/月度表/欠进度条形/一键追问`

---

## Task 5: 总验收 + 部署（主会话）

- [ ] 双仓全量：`python -m pytest insight/ eval/ -q` / `npm test` / `npm run build`
- [ ] `pm2 restart insight-api`（T1/T2 改动）+ `pm2 save`；web dist 已由 build 产出
- [ ] 冒烟（BFF 登录态）：
  1. `/api/insight/target-overview` 200，annual.achievePct **与 /api/insight/health-score 的 target.achieve_pct 逐位相等**（D-t6 断言）
  2. centers 非空且 behindWan 有正有负；centersTotalBehindWan=Σ正behind 量级对拍
  3. projection 手算对拍一次（dailyWan×365）
  4. UI：admin-prod 刷新 → 侧栏第三项 → 页面四块渲染、一键追问跳 chat
- [ ] runbook §M-i7 三行（端点/缓存/降级）+ 提交

## Self-Review

1. **Spec 覆盖**：§3 四块口径=T1（公式逐条落测试）；§3 缓存/503=T2；§5 实现面=T2/T3/T4；§4 页面=T4；§6 冒烟的 D-t6 一致性断言=T5。无缺口。
2. **类型一致性**：`target_overview(run, ctx)`（T1）与 `TrendService.target_overview(as_of)`（T2）同名不同签名——注意 T2 内 import 别撞名（`from .target_report import target_overview as _report`）；TargetOverview 族与 T1 响应字段逐一对齐（camelCase）。
3. **占位**：T1 实现骨架的 `...` 段是结构参考，实现者必须展开为完整代码（分派串与真实 SQL 对齐）；测试 fixture 数值配平授权已注明。
