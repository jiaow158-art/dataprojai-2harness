# P1-1 「今日经营关注」高管首页产品化改造（dataplat-ui 仓）

## Context

P0 壳层已冻结（AppShell/Sidebar/Design System 不再动）。本轮只优化今日经营关注页：把"三张事件卡页面"做成经营晨报——高管 30 秒内知道今天最重要的事、为什么、去哪看。**纯前端展示层重排**：不改 detector/event model/ranking/insight API 语义/gateway/skills/ChatView/followup 链路/其他四页。

## 一、现状字段 → 新 UI 数据映射（已核实，零接口新增）

| UI 元素 | 来源字段 | 状态 |
|---|---|---|
| Top 0-3 事件 | `GET /api/insight/daily` → `InsightDaily.events[]`（服务端冻结快照） | ✓ |
| severity | `event.severity`（major/minor） | ✓ |
| event_type | `event.eventType`（sales_decline/margin_drop/ar_overdue/target_gap） | ✓ |
| persistDays | `event.persistDays` | ✓ |
| facts | `event.facts[{label,value}]`（服务端字符串） | ✓ |
| trend | 逐事件 `apiInsightTrend(eventId)` → `InsightTrend{kind,series,unit}` | ✓ |
| AI 洞察 | `event.attributionStatus` + `event.attributionSummary` | ✓（语义见下） |
| 观察中/未上榜 | `apiInsightActiveEvents()` → `!publishedToday` 过滤（含 scoreGap/score，新 UI 弃用） | ✓ |
| 经营概览原始值 | health-score rings `inputs.yoy_pct/delta_pct/nat90_share_pct` + available/error | ✓（P0 已做） |
| 年度目标进度 | health-score `target{achieve_pct,actual_wan,annual_target_wan,time_pct}` | ✓ |
| freshness | `daily.dataDate/briefDate/dataFreshness.{overall,radars[]}` | ✓ |

**attribution_summary 语义（api_main.py:55 ← attribution.py:219）**：done=(parsed).summary（LLM 执行摘要，=详情页 executiveSummary 同源）；**degraded/failed/pending 一律回退 ev.summary（检测层事实句）**——当前卡片无差别渲染它，就是"AI 洞察念事实"的根因。

### API 缺口结论（无阻断）

- 卡片级 executive summary：done 态的 attributionSummary 即执行摘要，**无缺口**。
- degraded 态的 AI 原文（answer_md）只在 event_analysis_run 表，daily payload 不带 → 前端不可得。按裁定显示状态行（非原因、非编造）：degraded → 「AI归因分析降级完成，详见事件详情」。
- 目标偏差 chip 计数：`events.filter(e=>e.eventType==="target_gap").length`（与 severity chip 跨维度重叠，符合裁定意图）。

## 二、模块设计

### 1. Hero（删 PageHeader 用法，页内局部 JSX）
```
今日经营关注                    [数据日 X · 简报 Y]  ← DataFreshness meta，体系不动
截至 {briefDate}{stale ? （最近一期已发布简报）: ""}
有 {N} 件经营事项值得你关注       ← N=text-3xl ck-primary 强调；N=0 时整句换空态文案
[重大异常 n][一般异常 n][目标偏差 n]   ← StatusTag danger/warning/info
```
- **删「观察中」chip**（维度混用）
- not_ready 时副行「数据未就绪——今日简报未定稿，不代表无异常」保留
- 未就绪雷达 notice 横幅（DataFreshness notice）保留在 hero 下

### 2. 零事件态（BusinessEventList 委托给页面）
- `overall!=="ready"` → 大字「部分经营数据尚未就绪」+ 现有 radar notice
- 否则 → 「今日暂无重大经营事项需要特别关注」+ hint：radars 全 ready →「四雷达检测均已完成」（EmptyState）

### 3. 事件卡压缩 15-20%（BusinessEventCard）
结构：`01 [严重程度 chip][持续第N天]` / 标题 `text-base line-clamp-2` / 核心事实一句=`event.summary` `text-xs line-clamp-1`（这是"发生了什么"）/ trend **条件渲染**（trend 且 series 非空才渲染，`height={88}`；空序列整块消失，不残留"暂无趋势序列"80px 空区）/ facts `slice(0,2)` 两列 / AI 洞察 / 单主按钮 查看详情（PrimaryButton sm）。
- **AI 洞察语义分离**（禁止前端编原因）：
  - `attributionStatus==="done" && attributionSummary` → 蓝底 AI 洞察框（line-clamp-3）——系统怎么看
  - pending/running → 灰行「AI归因分析中」
  - degraded → 灰行「AI归因分析降级完成，详见事件详情」
  - failed → 灰行「自动归因暂未完成，可进入 AI问数继续分析」
- 卡片不加 继续问AI（当前卡无 followup 入口，裁定"如已有才保留"；详情页入口不动）
- padding p-5→p-4、title text-lg→text-base、按钮 mt-4→mt-3

### 4. HealthPanel → 「经营概览」（§七/§八）
- SectionCard title 改「经营概览」（extra 截至 as_of 保留）
- 四域状态 chip + 支撑值不动（P0 裁定映射，阈值仅展示层）
- 目标块「2026 年目标进度」紧凑化：ring + 达成率大字 + 三行事实；金额走新 formatter

### 5. 金额 formatter（新增 `web/src/components/insights/fmt.ts`）
`fmtWanSmart(wan: number|null): string`——null→"—"；`>=10000` → `${(wan/10000).toFixed(2)} 亿`（363,922.5万→36.39 亿）；否则 `${wan.toLocaleString(...,{maximumFractionDigits:1})} 万`。仅用于本页 UI 拥有数字处（目标块 actual_wan/annual_target_wan）；事件 facts 是服务端字符串不动；RegionBattleMap 的局部 fmtYi 不动（不在本轮边界）。

### 6. 其他关注事项（EventCenterView 观察中区改造）
- 标题「其他关注事项」+ 副题「仍在持续关注，但未进入今日重点」；extra=`N 条`
- 行内：severity 色条 + 标题 truncate + 持续 N 天；**删 `分 {score}` 与 `距上榜 {scoreGap}`**（不暴露排序机制）
- `slice(0,5)`；`watching.length>5` 时底部「查看全部 →」文字链 → 经营事件中心（新 prop `onOpenEventCenter`，App 传 `setView("events")` 一行接线）
- 时间线卡（近90天）原样保留其下

### 7. 视觉层级（§十）
Top3（左 flex-1）> 每件事事实+AI > 经营概览（右 xl:w-80）> 其他关注事项+时间线（下方全宽）。现有布局骨架已如此，靠 hero 强调与卡片压缩实现层级，不加新容器。

## 三、文件清单

| 文件 | 改动 | 性质 |
|---|---|---|
| `web/src/components/insights/OperatingDashboardPage.tsx` | Hero/零态/chip 计数/onOpenEventCenter | 纯 UI |
| `web/src/components/insights/BusinessEventCard.tsx` | 密度+AI 语义分支+条件 trend+facts×2 | 纯 UI |
| `web/src/components/insights/BusinessEventList.tsx` | 空态委托 | 纯 UI |
| `web/src/components/insights/HealthPanel.tsx` | 改名经营概览+目标块紧凑+formatter | 纯 UI |
| `web/src/components/insights/EventCenterView.tsx` | 其他关注事项改造 | 纯 UI |
| `web/src/components/insights/fmt.ts` | 新增共享展示 formatter | 新增 |
| `web/src/App.tsx` | 传 `onOpenEventCenter` 一行 | 页面接线 |

types.ts/api.ts/后端零改动。

## 四、删除/合并旧 JSX

- PageHeader 在本页的用法（组件本身保留给其他页）
- Hero 的「观察中」StatusTag；watching 计算移除
- 卡片：`<div mt-3><MiniTrendChart/></div>` 无条件渲染（空态 80px）；facts 第 3 个；insight=`attributionSummary||null` 无状态分支
- EventCenterView 观察中行：score 列、scoreGap 列、旧标题「观察中（活跃未上榜，分数距发布线）」
- HealthPanel 旧标题「经营健康度」、目标块旧金额格式

## 五、响应式（§十二）

- 三列断点保持 `lg:grid-cols-3`（1366 内容 ~1046px → 每卡 ~335px：标题两行/facts 两列/AI clamp-3 均可容纳）
- 大数字：hero N 用 text-3xl；目标块亿化后字符串更短
- 唯一页面级滚动容器仍是 AppShell（不新增 overflow）

## 六、执行与验收

1. **实现前先量基线**：playwright 探针量当前首卡像素高度（`scripts/p0` 复用），改造后同探针对比——「高度明显下降」用硬数据
2. 单实现任务（7 文件一次落）→ build → 对抗 review（验收 17 条逐项+红线）→ 修复
3. 截图：1366/1440/1920 × dashboard（复用 screenshot.mjs，tag `p1-1`）+ 1080p 首屏完整性目检（Hero+Top3+概览核心同屏）
4. grep 断言：本页无「观察中」chip 文案/无 score/距上榜/无 0-100 分/无预测字样；「经营概览」在位
5. 链路冒烟：查看详情跳转、AI问数往返、flag-off 不受影响（本页 flag-on only）
6. 留档：harness docs/superpowers/ spec+report；不自动进 P1-2

## 红线复述

阈值不回流 detector/severity/ranking/event model；不造预测/健康分；AI 洞察只用真实 attribution 字段；AppShell/Sidebar/token 不动；其他四页不动。
