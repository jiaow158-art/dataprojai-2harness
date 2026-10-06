# 区域作战地图（M-i8）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 spec `docs/superpowers/specs/2026-10-06-insight-region-battle-map-design.md`（v1.0）落地区域作战地图页。资产已就绪（T0 完成：`scripts/build-china-map.py` + `dataplat-ui/web/src/assets/china-map.ts` 33 单位+九段线）。

**Architecture:** `insight/region_map.py`（同窗聚合+大区映射+事件关联，runner 注入）→ `TrendService.region_map` → `/api/insight/region-map` → BFF 代理 → `RegionBattleMapPage` + `ChinaMap` 渲染。

---

## 前置事实

1. **两仓**：T1/T2 harness；T3/T4 dataplat-ui；T5 主会话。提交路径限定。
2. **复用**：`target_report.py` 的 LY 封顶法（ly_as_of_calday=上年同日）；mix 谓词四件套（node_desc2/data_source/calday 封顶）；`TargetDetector().trend` 的 meta（全国达成率同源，D-r2）；`TrendService` 缓存/锁/全降级不缓存模式；api 路由模式；BFF 代理模式；Sidebar NavItem/App view 模式。
3. **config/region-map.json（T1 新建）**：`{"regions": {"华南": ["广东","广西","海南"], "华东": ["上海","江苏","浙江","安徽","福建","江西","山东"], "华中": ["湖南","湖北","河南"], "华北": ["北京","天津","河北","山西","内蒙古"], "西北": ["陕西","甘肃","宁夏","新疆","青海"], "西南": ["四川","重庆","云南","贵州","西藏"], "东北": ["辽宁","吉林","黑龙江"]}, "specialRegions": ["未分区", "海外"]}`。映射表外国内值→未分区并入 `unmappedProvinces` 披露；海外=表外非 NULL 值动态归类。
4. **查询设计（3 条有界查询，单 CASE WHEN 双年同窗）**：
   - Q1 省份双年同窗：`GROUP BY region_province_name`，`SUM(CASE WHEN calmonth LIKE 当年 THEN ambperformance END)` / LY 同窗（LY 用上年 ym 列表 + ly_as_of_calday 封顶）+ 毛利分子分母同法
   - Q2 大区趋势：`GROUP BY calmonth, region_province_name`（近 12 月，双列不必——趋势只当年+上年 12 个月窗口的实绩，不做同比）——注意成本，一次扫描
   - Q3 center×province 当月销售：`GROUP BY node_name5, region_province_name`（当月，center→regionSet 推导，供 regionEvents）
   - 全国达成率：复用 `TargetDetector().trend`（不重查目标）
5. mix 省名 38 值含 NULL 与海外城市（spec §2）；NULL → 未分区。
6. 测试基线：insight 186+8；server 84；web=build。
7. web 资产 API：`CHINA_PROVINCES`（name/adcode/path/centroid）、`NAME_LOOKUP`（短名+全名→adcode）、`NINE_DASH`、`VIEWBOX`。大区→省份归属用 NAME_LOOKUP 短名匹配（centroid 均为经纬换算后 SVG 坐标）。

---

## Task 1: insight/region_map.py + config（harness）

**Files:** Create `insight/config/region-map.json`、`insight/region_map.py`、`insight/tests/test_region_map.py`

要点（口径全部来自 spec §4，逐条落测试）：
- 同窗同比：当年 ym=1..as_of 月（当月 calday 封顶）vs 上年同 ym+上年同日封顶；分母 0/NULL→yoyPct null
- 大区映射/表外国内值→未分区+unmappedProvinces；海外=映射表外非 NULL（动态：region_province_name 非空且不在映射 values 且不是国内已知 31 名单——用"不在映射 values"即表外，含海外与未列国内）
- level 三档：decline(≤-8)/watch(<0)/growth(≥0)/unknown(null)，服务端判定
- grossMarginPct=分子和/分母和；regions 含未分区/海外行（UI 过滤，API 如实）
- regionTrend：近 12 自然月逐月实绩按大区（未分区/海外不入）；月序列补齐
- regionEvents：Q3 推 center→regionSet；事件 org ∈ 中心名集合→关联其 regionSet；org 不在（BU 级"瓷砖事业部"）→全区间；每区 top5 by score；输入事件列表由调用方注入（`events: list[dict]` 参数——从 db 读的职责留给端点层，聚合函数纯）
- national：ytdWan/lyWan/yoyPct/grossMarginPct（省份求和含未分区海外）+ achievePct（注入参数，端点层从 trend meta 取——聚合函数收 `achieve_pct` 入参）
- 局部降级：national/regions/provinces/trend/events 各自 try/except

测试 fixture：省份双年数（同窗手算）、NULL 省归未分区、海外值归类、level 边界（-8.0/-7.9/0）、unmapped 披露、趋势补月、事件关联三态（中心命中/BU 级全区间/中心无当月销售不关联）、降级。

提交：`feat(mi8): region_map聚合——同窗同比/大区映射三档/趋势/事件关联`

## Task 2: TrendService.region_map + 端点（harness）

- `TrendService.region_map(as_of)`：锁+重试+缓存 key=("region_map", iso)；national+regions 双块全降级不缓存
- 端点：`/api/insight/region-map`——聚合函数的 events 入参从 ro db 读（active 事件 org/score/title/severity，照 _event_center 的查询形态）；achieve_pct 从 `TargetDetector().trend` meta（D-r2 同源）；503/缓存/全降级测试
- 提交：`feat(mi8): /api/insight/region-map端点——缓存/全降级不缓存/503`

## Task 3: BFF 代理 + 测试（dataplat-ui）

- insight.ts 加 `r.get("/region-map", gate, ...)`；测试同既有模式
- 提交：`feat(mi8): BFF region-map代理(flag门禁)`

## Task 4: ChinaMap + RegionBattleMapPage + 接线（dataplat-ui）

**Files:** types.ts/api.ts/App.tsx/Sidebar.tsx + Create `ChinaMap.tsx`、`RegionBattleMapPage.tsx`

- types：RegionMapPayload 族（national/regions/provinces/regionTrend/regionEvents/unmappedProvinces，camelCase 对齐 T1 响应）
- **ChinaMap.tsx**：纯 SVG——`CHINA_PROVINCES.map` 渲染 path（fill=所属大区 level 色：decline #ef4444 系/watch #f97316 系/growth #10b981 系/unknown 灰；未分区海外不在图）；省份 hover 高亮（stroke 加深）；大区气泡=该区省份 centroid 均值锚点（圆角白底标签：区名/销售额亿/同比%）；点击大区任意省份→onSelectRegion；NINE_DASH 淡色描；图例三档
- **RegionBattleMapPage.tsx**（spec §6 结构）：
  - 5 统计卡（窄卡同事件中心；达成率卡与 M-i7 同源说明小字）
  - 左 ChinaMap（选中区 selectedRegion state：默认 null=全国）
  - 右栏：区域排名（tab 销售额/同比；国内七区行+未分区海外灰行尾；行点击=选区）+ 重点预警（selectedRegion 过滤 regionEvents；事件卡：severity 色/标题/org/分数/查看详情→onOpenEvent）
  - 底部三块：区域趋势（近12月多线 SVG，选中区线加粗高亮）/ 省区表现分布（selectedRegion 过滤 Top10 条形+同比着色）/ 重点作战区域三卡（同比最深三国内区卡：销售/同比/毛利+查看详情=选区）
  - props `{ onOpenEvent }`；App view `"regions"` + Sidebar 第四项 NavItem「区域作战地图」（activeView==="regions"；我的关注顺移第五）
- build 零错误 + server 测试绿
- 提交：`feat(mi8): 区域作战地图页——真地图着色/区域排名/预警联动/趋势/省分布/作战三卡`

## Task 5: 总验收 + 部署（主会话）

- 双仓全量 + `pm2 restart insight-api dataplat-ui` + pm2 save
- 冒烟：`/api/insight/region-map` 200；national.ytdWan **与 /api/insight/target-overview annual.actualWan 逐位一致**（同窗一致性断言）；广东居省首；regions 含未分区行；regionEvents 非空（粤东事件关联华南）；UI 四块渲染+点击联动
- runbook §M-i8 三行 + 记忆更新

## Self-Review

1. Spec 覆盖：§3 映射=T1 config；§4 口径=T1（逐条测试）；§4 缓存=T2；§5 资产=T0 已完成+T4 渲染；§6=T4；§8 冒烟一致断言=T5。无缺口。
2. 类型一致性：聚合函数签名 `region_map(run, ctx, events, achieve_pct)`（T1）→ 端点组装（T2）；`RegionMapPayload` 与 T1 响应 camelCase 对齐。
3. 已知裁量：regionTrend 双年与否（定：只当年+近12月窗口实绩，不做同比线）；regions 排序（销售额降序，未分区海外恒尾行）。
