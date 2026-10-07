# P1-3 目标管理产品化（dataplat-ui 仓）

## Context

P1-2 已收口。本轮把目标页从"目标报表"升级为目标经营入口，回答六问：完成得怎样/领先还是落后/差多少/缺口来自哪/优先处理什么/能否直接进 AI 分析。**纯前端**：不动 detector/event model/ranking/API 语义/gateway/skills/ChatView/六步法/其他四页/AppShell/Sidebar/Design System。禁止一切预测/外推/评分。

## 一、数据能力矩阵（§二 18 项，已核实 payload=target-overview + 既有 events 端点）

| # | 数据 | 状态 |
|---|---|---|
| 1-4 | 年度目标/YTD 实际/达成率/时间进度 | ✓ `annual{targetWan,actualWan,achievePct,timePct,timeBasis}`（年日自然日口径） |
| 5-6 | 进度偏差/当前目标缺口 | ✓ P0 已定：客户端确定性算术（achievePct−timePct；targetWan−actualWan，≤0→超额完成） |
| 7-9 | 月度目标/实际/达成率 | ✓ `months[]{month,actualWan,targetWan,achievePct,yoyPct,isCurrent,timePct}` |
| 10-11 | **历史累计目标/实际序列** | ✓ **前端确定性累加**（§四明确允许）：months 仅含 1 月~当月（无未来月）→ 累计双线天然止于当月，**无外推空间**；核对过 Σ(1..10月目标)=478,211.5万=annual.targetWan 逐位一致，图终点缺口=KPI 缺口闭环 |
| 12-14 | 区域目标/实际/达成率 | ✗ **结构性缺口**（D-r2：目标表无省份维度）；region_map 的区域销售是 mix 同窗口径≠目标口径（ambperformance/target 表），**不混源** |
| 15 | 目标维度 | **组织（运营中心）✓** `centers[]{centerCode,centerName,actualWan,targetWan,achievePct,timePct,behindWan,behindSharePct}`（12 中心全量）；渠道 ✗；产品 ✗ |
| 16-17 | target_gap 事件 | ✓ `apiInsightActiveEvents()` 客户端过滤 `event_type==="target_gap"`（真实事件，含 title/severity/summary/persist_days/lifecycle/attribution_status/event_id） |
| 18 | AI问数复用入口 | ✓ **P1-2 的 App `askSeed` 已存在**（建会话→followupSeed→chat），本页只加 prop 接线 |

**缺口报告（不造数）**：区域/渠道/产品维度目标缺 → 缺口贡献只用**组织维度**（§六退化原则）；months 无未来月（对 §四反而是护栏）；payload 的 projection/recoveryWan 字段继续留而未读。

## 二、设计（§十 五层信息架构）

### L1 KPI Strip（§三，替换现有两张大卡）
`grid grid-cols-3 md:grid-cols-6 gap-3` 六张 KpiCard：**年度目标 47.82 亿 / 实际完成 36.39 亿 / 达成率 76.1% / 时间进度 76.2%（title=timeBasis）/ 进度偏差 ±x.xpt（正绿负红）/ 距年度目标**（targetWan−actualWan，>0 显「缺口 xx 亿」、≤0 显「超额完成」（P0 规则）；**命名=距年度目标（裁定1），与 L2 的进度缺口严格区分**）。金额一律 `fmtWanSmart`（复用 P1-1 insights/fmt.ts，亿 2 位）；Ring 环删除；GapFacts 卡删除（并入 strip）。annual 降级→整排 DegradedLine。PageHeader 右侧 **PrimaryButton「让AI分析目标差距」：仅 annual 可用时可用；降级时 disabled+「数据未就绪」提示（裁定5）**。

### L2 目标累计进度（§四，新局部组件 CumulativeProgressCard）——同口径（裁定2）
- 已核实 `months[].timePct`（仅当月行）= **月度工作日进度**（target_report.py:148 `time_progress_pct(as_of,"workday",None)`；10-05 实测 13.6%≈3/22 工作日 ✓）
- SectionCard title「目标累计进度」，SVG 双线：X=1月..当月；**累计目标=灰色虚线：完整月=整月目标 running Σ，当月点=月目标×timePct%（MTD 同口径应完成额，不拿整月目标对 MTD 实际）**；**累计实际=蓝色实线（running Σ actualWan，当月=MTD）**；终点标注「**当前进度缺口**」（同口径末点差，与 KPI「距年度目标」是两个数）；两线间浅色带（实际低于段红染/反超段绿染）；Y 轴 2-3 档亿刻度；图例注明「当月按月工作日进度同口径」
- 降级：months degraded→DegradedLine；当月 timePct 缺失→双线只画到最近完整月、当月另起 MTD 单点说明（不伪造）；<2 有效点→EmptyState；actualWan null 月断线
- **零预测**：线止于当月，不延长不外推

### L3 进度缺口贡献 Top 5（§五/§六/裁定3，替换「组织缺口拆解」表）
- 已核实 `centers[].behindWan` = **目标×年日进度% − 实绩**（target_report.py:163,174 服务端算，时间进度欠进度额）→ L3 正名「**进度缺口贡献 Top 5**」，直接用服务端字段：behindWan 降序 Top 5 横条（中心名+缺口亿+条宽=behindSharePct%），合计=centersTotalBehindWan；卡内口径注「目标×年日进度 − 实绩 · 组织维度」（title 展开）
- **不做** target−actual 客户端排序（那是「距年度目标」概念，已留在 KPI；两口径不混）
- 命名兜底：centerName null → 回显 centerCode（现状行为）

### L4 相关经营事件（§八，新）
- active 事件过滤 target_gap，≤3 条：标题（可点→onOpenEvent）/ severity chip / 关键事实一行（summary line-clamp-1）/ 持续 N 天 / 当前状态（lifecycle●+ATTR chip）
- 0 条 →「当前暂无目标偏差经营事件」；**绝不前端造事件**
- App 接线：`onOpenEvent` → `setDetailSource("targets")`（**detailSource 联合类型加 "targets"**，侧栏高亮目标管理；EventDetailPage 仍渲染于 insights 分支——机制同 P1-2 regions）

### L5 月度明细（§七/裁定4，降为明细）
列：**月份 / 月度目标 / 月度实际 / 达成率 / 差额 / 状态**（同比列移除——数据留 payload 不读）
- 完整月差额 = actualWan−targetWan（带符号亿，正绿负红）
- **当月差额 = MTD 同口径进度差额 = actualWan − targetWan×timePct%**（月工作日进度；cell 标「进度」角标 + title 注口径；timePct 缺失或无法确认→「—」+状态「进行中」）——绝不用 MTD实际−整月目标 冒充落后
- 状态：完整月 **领先/落后**（actual vs target，无阈值无红黄绿三级）；当月「进行中 + MTD 时间进度」；null→「—」
- 全表亿格式；SectionCard padding=none 保持

### 让AI分析目标差距（§九/裁定5）
- 复用 P1-2 `askSeed`（App 已有）：问句页内拼装，**只注真实值**：
  `请分析当前年度目标完成情况。当前实际完成 {actual亿}，年度目标 {target亿}，达成率 {rate}%，时间进度 {timeRate}%，距年度目标 {gap亿}。请按照现有六步分析法，优先识别对目标缺口贡献最大的维度，再继续下钻分析主要影响因素。` + 存在 target_gap 事件时附 `关联经营事件 event_id：{id…}`
- **annual 降级时按钮 disabled + 「数据未就绪」提示**（裁定5）
- 不规定下钻维度（六步法自选）；不新建 Agent/不前端 SQL

## 三、文件清单

| 文件 | 改动 |
|---|---|
| `web/src/components/insights/TargetManagementPage.tsx` | KPI Strip/累计双线图/缺口贡献 Top5/事件卡/月度明细改列/onAsk；删 Ring 卡、GapFacts 卡、组织缺口拆解表 |
| `web/src/App.tsx` | TargetManagementPage 传 `onAsk={(q)=>void askSeed(q)}` 与 `onOpenEvent`（detailSource 联合类型 + "targets"）——askSeed 函数已存在零新逻辑 |
| types.ts / api.ts / 后端 | **零改动** |

## 四、响应式（§十二）

- KPI strip：cols-3→md:cols-6（1366 每卡 ~164px，"47.82 亿" 不撑破；数值 text-xl）
- 图表 w-full（SVG viewBox 自适应）；TopN 横条弹性；月度表 6 列窄列无横滚
- 唯一纵向滚动仍是 AppShell

## 五、验收方案（§十四 15 条）

1. build 绿 → 对抗 review（15 条+红线：零预测字样 grep、不造事件、缺口只来自真实 target/actual、维度退化诚实标注）
2. playwright 探针：KPI strip 6 卡值与 payload 逐位对拍（「距年度目标」≠L2「当前进度缺口」两数并存且各自正确）；累计图 SVG 存在、当月点=目标×timePct 同口径、线止于当月；TopN 首行=behindWan 最大中心（进度口径）；月度表当月差额=MTD 进度差额；target_gap 事件真实（点击跳详情、侧栏高亮目标管理）；AI 按钮实弹发问（断言首问含真实数字）、降级态 disabled；1366/1440/1920 overflowX=0
3. 截图 `screenshots-p0/p1-3/`（3 宽度整页 + KPI strip 特写）
4. 零退化：其他四页+AI问数 冒烟（askSeed 复用路径不回归 P1-2）
5. 留档 harness spec+report；不自动进 P1-4
