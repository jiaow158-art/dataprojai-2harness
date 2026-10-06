# P0 UI/UX Architecture Refactor — 经营驾驶舱统一壳层（dataplat-ui 仓）

## Context

M-i5~M-i8 四页面（今日经营关注/经营事件中心/目标管理/区域作战地图）逐版堆出后：驾驶舱仍套 Chat 壳（左侧常显历史会话）、四页面四套样式（3 套页面背景/5 种卡片/4 种主按钮/六档圆角全出现）、目标管理只用半屏（根因：四页 flex 子项全缺 `flex-1 min-w-0`，宽度退化为 fit-content）、页面含未验证预测值（线性年化/恢复潜力）与健康分数字（71/15.5）、事件表 11 列横向滚动。本轮**只改前端壳/布局/展示层**——不动 detector、event model、insight API 业务口径、engine-gateway、skills、chat 链路、types.ts/api.ts。完成后交截图 + Self-Review，不自动进 P1。

## 用户裁定（2026-10-06，终局）

1. **我的关注**保留入口（侧栏按 经营模块/AI问数/管理设置 分组呈现，不执着扁平编号），同批改版（现为暗色 token 系统，全量改样式）
2. **系统设置** = 现有 AdminView（六 tab），仅 isAdmin 可见；AdminView 内容不动（接受暗色边界）
3. **恢复潜力 recoveryWan 一并删除**（外推值全禁）；中心表保留 实绩/目标/达成率/时间进度/欠进度额；API payload 不动，UI 停渲染
4. **P5 状态阈值**沿用现色带 60/80 等价原始阈值，纯展示层映射，**不回流任何业务判定**

## 设计

### Token 层（index.css `@theme` 追加，暗色 token 原样保留给 chat/admin）

```
--color-ck-bg:#f5f8fc  --color-ck-card:#fff  --color-ck-card-soft:#f7fafd
--color-ck-line:#dbe4ef  --color-ck-line-strong:#c2d0e2
--color-ck-ink:#14294b  --color-ck-ink-2:#3f4f66  --color-ck-ink-3:#7c8ba1
--color-ck-primary:#1667d9  --color-ck-primary-hover:#0f56ba  --color-ck-primary-soft:#eaf2fb
--color-ck-success:#0e9f6e/soft  --color-ck-warning:#b87316/soft  --color-ck-danger:#d64b4b/soft
--shadow-ck: 0 1px 2px rgb(20 41 75 / .05)
```

基线映射：bg→`bg-ck-bg`；padding→AppShell `px-6 lg:px-8`；gap→`gap-5`；radius→`rounded-xl`；H1→`text-[28px]`；节标题→`text-lg`；正文 `text-sm`；辅助 `text-xs`；主按钮 `h-9`。severity 无独立 token（major→danger、minor→warning，经 StatusTag tone）。
迁移完成后**删除** `.dashboard-surface/.dashboard-glass/.dashboard-enter/-delay-*`（含 keyframes 与专属 reduced-motion 行；保留通用 scroll-behavior 守卫）；移动端 `#root > div > aside` 块**字节不动**；新增 `.ck-scroll` 亮色滚动条作用域。入场动画删除不替换。

### 新组件（`web/src/components/cockpit/`，12 文件，className 糖级别）

- **AppShell** `{children}`：`main.ck-scroll.flex.min-w-0.flex-1.flex-col.bg-ck-bg` > 滚动容器 > `flex w-full flex-col gap-5 px-6 pb-10 pt-8 lg:px-8`。**修 P3**（每页包一层）。sidebar 保持 App 根 div 的 `aside` 兄弟——不裹侧栏。**唯一页面级纵向滚动容器就是 AppShell 这一层**——页面根/SectionCard 不得再出现 `h-full overflow-y-auto` 页面级 scroller（组件内固定高度小滚动区如时间线 max-h 不受限）
- **PageHeader** `{title, subtitle?, meta?, children?}`：H1 28px + 右侧 meta（DataFreshness）+ children 芯片行，直接坐页面底
- **SectionCard** `{title?, extra?, padding?: "md"|"none", className?, children}`：`rounded-xl border-ck-line bg-ck-card shadow-ck`；padding=none 给表格卡（标题行 px-5 pt-4，body 通铺）
- **KpiCard** `{label, value, valueClassName?, sub?, subClassName?}`：p-4，label xs ink-3，value xl semibold
- **StatusTag** `{tone: success|warning|danger|neutral|info, dot?, size?: sm|md, title?}`：`rounded-full px-2 py-0.5` 软底强字
- **FilterBar** `{children, count?}` + 导出 `filterControlClass`（input/select 统一）
- **DataFreshness** `{asOf?, briefDate?, notice?}`：meta 态（数据日/简报日 xs 行）与 notice 态（amber 降级横幅）
- **EmptyState** `{text, hint?}`；**PrimaryButton/SecondaryButton**（extends ButtonHTMLAttributes，`size?: sm|md`，md=h-9）；**Ring** `{value, color?, className?}`（合并两份私有复制）；**DegradedLine** `{reason}`（合并两份）
- `severityStyle` 仍由 BusinessEventCard 导出（左色条用）

### 侧栏双壳（单文件 Sidebar.tsx 内部分支，App.tsx 仅加 `onChat` prop）

```
mode = !insightsEnabled ? "legacy" : activeView === "chat" ? "chat" : "cockpit"
```

- **legacy（flag off）**：现渲染路径原样——输出字节级不变
- **cockpit**（view ∈ insights/events/subscriptions/targets/regions/admin，或详情打开中）：品牌头（原 hex 不动）→ **三组导航**（小节标签 + NavItem，沿用现侧栏"AI 问数"分节标签样式）：
  - **经营模块**：今日经营关注 / 经营事件中心 / 目标管理 / 区域作战地图 / 我的关注
  - **AI问数**：AI问数（onClick=onChat，永不高亮）
  - **管理设置**：系统设置（isAdmin 门禁，active = admin 视图；组随 admin 显隐）
  → **空 flex-1 占位 div**（喂移动端 `div:nth-last-child(2)` 选择器，见风险）→ 用户 footer+登出。NavItem 亮色重绘：active `bg-ck-primary-soft font-medium text-ck-ink`+4px 条 `bg-ck-primary`。无新建会话/会话列表/管理后台按钮/域申请 footer
  - **详情页高亮跟来源**（sourceView）：App 新增 `detailSource` 状态；`onOpenEvent(id, src)` 由 Dashboard(=insights)/EventCenter(=events)/RegionMap(=regions) 三处调用点传入；`openEventId` 非空时 Sidebar 收到的 activeView 用 detailSource，返回(onBack)时 `setView(detailSource)` 回来源页；详情内嵌 related 跳转沿用当前 source
- **chat**：品牌头 → **返回驾驶舱**（NavItem 样式带 ←，onClick=onInsights）→ 新建会话 → 会话列表（现有 JSX 原样，重命名/删除/busy/error 全保留）→ 管理后台(admin) → 域申请 footer → 用户 footer → DomainRequestModal

### P5 HealthPanel 状态映射（组件内局部函数，展示层专用）

```
sales  inputs.yoy_pct        <-20 异常 | <-10 关注 | else 正常
margin inputs.delta_pct      <-4 异常  | <-2 关注  | else 正常
ar     inputs.nat90_share_pct >40 异常 | >20 关注 | else 正常
未接入(neutral) = !r.available 或 该环所需原始输入(inputs.*)缺失（无法判断→未接入，不猜；库存永久）
```

**判定只读 `available` + `inputs`，不读 `score`**（score 依赖删除；popover 里可继续展示 score 作参考，但不参与状态判定）。

chip 附支撑原始值（`关注 · 同比 -16.2%`；margin `毛利环比 -x.xpt`；ar `90天+占比 xx.x%`）；点击 popover 保留（formula+inputs）；mom_delta 保留；**目标环（achieve_pct 事实数据）原样保留**（共享 Ring）。阈值只活在此函数，禁止导出进业务。

### P4 目标管理

- 删"趋势外推"卡（TargetManagementPage.tsx:89-112，projectedWan/projectedGapWan/basis）
- 同槽位换事实卡：**进度偏差** = achievePct − timePct（前端确定性算术，正绿负红）+ **当前目标缺口** = targetWan − actualWan——**缺口 ≤0（实绩已超目标）时显示"超额完成 |缺口| 万"（success 色），不显示负数缺口**；annual 卡（实际/目标/达成率/时间进度）保留
- 中心表删**恢复潜力**列（7→6 列，汇总行 colSpan 5、降级行 6）；behindWan/behindSharePct 保留

### P6 事件表（1366 无横向滚动）

`table-fixed w-full text-xs` + colgroup：事件 30 / 严重程度 9 / 关事实 20 / 影响范围 12 / 持续时间 8 / 当前状态 11 / 操作 10（%）。1366 算账：256 侧栏 → 内容 ~1044px。**事件标题与关键事实单元格用 `line-clamp-2`（两行截断+title），不许为消灭横滚改成单行 truncate**；其余窄列（影响范围等）单行 truncate。操作列纵向堆叠 查看详情(PrimaryButton sm) / 继续分析(文字链)。事件格结构：行1 标题(line-clamp-2)+晚到(StatusTag sm warning)；行2 `销售下滑 · 首次发现 09-30`。当前状态两层：`● 进行中/已解除`(StatusTag dot：active→info、resolved→success) + AI分析 chip（pending neutral/running info/done success/degraded warning/failed danger）。删 # 列。去掉 `overflow-x-auto`。

## 文件清单

**新增 12**：`web/src/components/cockpit/{AppShell,PageHeader,SectionCard,KpiCard,StatusTag,FilterBar,DataFreshness,EmptyState,PrimaryButton,SecondaryButton,Ring,DegradedLine}.tsx`（Buttons 可合一文件）

**修改 15**：
| 文件 | 改动 |
|---|---|
| `web/src/index.css` | @theme 加 ck token + shadow；`.ck-scroll`；迁移完成后删 dashboard-* |
| `web/src/App.tsx` | 加 `onChat={() => setView("chat")}` 传 Sidebar；加 `detailSource` 状态，三个 `onOpenEvent` 调用点传来源（insights/events/regions），Sidebar activeView 在详情打开时用 detailSource，onBack 回 `setView(detailSource)`；followupSeed 编排不动 |
| `Sidebar.tsx` | 双壳分支（上述）+ 移动端选择器约束注释 |
| `insights/OperatingDashboardPage.tsx` | AppShell+PageHeader（吸收 TodayAttentionHeader，**删除该文件**）+StatusTag 芯片；右栏 xl:w-80 保持；freshness→DataFreshness |
| `insights/BusinessEventCard.tsx` | glass→ck 卡（保留左色条/trend/AI 洞察块）；CTA→PrimaryButton；chip→StatusTag |
| `insights/BusinessEventList.tsx` | gap-5；空态→EmptyState |
| `insights/EventCenterView.tsx` | 两卡→SectionCard |
| `insights/HealthPanel.tsx` | **P5** 状态 chip 化；panel→SectionCard；删私有 Ring |
| `insights/EventCenterPage.tsx` | AppShell/PageHeader/KpiCard×5/FilterBar/**P6 七列表**；近期事件动态→SectionCard |
| `insights/EventCenterCharts.tsx` | Donut 壳→SectionCard |
| `insights/TargetManagementPage.tsx` | AppShell(**P3")+PageHeader+**P4**；Ring/DegradedLine→共享；表格入 SectionCard padding=none |
| `insights/RegionBattleMapPage.tsx` | AppShell/PageHeader/KpiCard/SectionCard；rail `xl:w-[24rem]`→`xl:w-80`；BattleCard CTA→PrimaryButton sm |
| `insights/MySubscriptionsPage.tsx` | 全量改版 ck 体系（API 逻辑字节不动） |
| `insights/EventDetailPage.tsx` | AppShell+PageHeader（标题/芯片/返回）；内嵌卡→SectionCard；onOpenEvent/onBack 编排在 App 层带 sourceView |

**显式不动**：ChatView.tsx、admin/* 7 文件、LoginScreen、Markdown、api.ts、**types.ts**（projection/recoveryWan 字段留着不读，tsc 通过）、ChinaMap、MiniTrendChart、BusinessEventTimeline、EventDetail 其余 10 子件、`server/**` 全部。

## 任务拆分（子代理流水线，串行 6 任务，每任务 build 门禁+路径限定提交）

1. **T1 token+组件**：index.css ck token/.ck-scroll（暂不删 dashboard-*）+ cockpit/ 12 组件。验：build 过、无视觉变化（无人引用）
2. **T2 双壳侧栏**：Sidebar 分支 + App onChat + detailSource。验：flag-off 侧栏像素级不变；cockpit 三组导航（经营模块/AI问数/管理设置，系统设置 admin 可见且 admin 视图高亮）；AI问数→chat 模式+返回驾驶舱；会话新建/重命名/删除；从事件中心/区域地图打开详情时侧栏高亮来源页、返回回来源页；375px 折叠完好
3. **T3 今日经营关注族 + P5 + CSS 清理**：Dashboard/Card/List/EventCenterView/HealthPanel/Charts；删 TodayAttentionHeader 与 dashboard-* CSS。验：全宽渲染；状态 chip+原始值+popover+目标环；`grep -r "dashboard-" web/src` = 0
4. **T4 事件中心 + P6**。验：1366 无横向滚动；标题/关键事实两行 line-clamp；筛选/晚到有效；查看详情/继续分析（→chat 模式 autoAsk 正常发）
5. **T5 目标管理(P3+P4) + 区域作战地图**。验：全宽；DOM/截图无 趋势外推/预计完成/恢复潜力 字样；进度偏差与缺口数值=payload 算术；**超目标时缺口位显示"超额完成"非负数**；中心表 6 列汇总行对齐
6. **T6 我的关注改版 + 事件详情壳 + 终扫**。验：MySubscriptionsPage 内 `bg-base|text-ink|border-line|accent-soft` grep=0；全量冒烟+截图

每任务后跑 `cd web && npm run build`；完成后**整体 review（含 1366/1440/1920 布局核查）**再交付。

## 风险与对策

- **移动端选择器** `#root > div > aside ... div:nth-last-child(2)`：cockpit 模式 aside 子序必须 [品牌div, nav div, flex-1 占位div, footer div]——占位 div 吃掉隐藏规则，nav 不受影响；Sidebar 内加注释；媒体查询块字节不动
- **chat/SSE 回归向量零触碰**：ChatView、App followupSeed 编排(:120-126,143-148)、会话处理器、api.ts；chat 模式会话 JSX 原样复用
- **flag-off 平价**：legacy 分支=今日 JSX；侧栏硬编码 chrome（#f7faff/品牌 hex）三模式都保留，**不要**token 化（#f5f8fc≠#f7faff）
- **部署**：BFF `express.static` 逐请求读盘（app.ts:1121-1127）——web build 后**无需 pm2 restart**；curl index.html 核对新 hash 资产名即可
- TS：types.ts 未读字段不报错；编辑页清 unused imports

## 验证与交付

1. 每任务 build；T6 后全量冒烟（flag-on 十项：四页全宽/详情各入口进入且今日经营关注高亮/我的关注增删读/系统设置 admin 限定/七列表/目标页无外推/健康 chip/popover/继续分析→chat/375px；flag-off：侧栏与今日一致+chat SSE 往返）
2. **截图**：playwright(chromium) 脚本，1366/1440/1920 ×（四页+详情+我的关注+chat 模式侧栏+admin 视图），存 `D:\dataplat-ui\screenshots-p0\`；flag-off 侧栏与改造前截图对比
3. **Self-Review** 报告：逐条对照 P0 验收标准（驾驶舱无 Chat history/AI问数恢复会话列表/问数零退化/四页同一套组件/目标页无右空白/无预测字样/无健康分数字/1366 无横滚/1440·1920 正常/flag 行为不变/API 口径不变）
4. 留档：`docs/superpowers/specs/2026-10-06-cockpit-p0-ui-refactor.md`（本计划）+ reports 实施报告（harness 仓）
