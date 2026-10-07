# P1-4 经营事件中心产品化（dataplat-ui 仓）

## Context

P1-3 已收口。把事件中心从"后台事件台账"升级为**经营问题总控台**，回答七问（还有多少没解决/最严重/持续最久/新问题/已解决/缺归因/优先看哪几个）。**纯前端**：不改 detector/event model/lifecycle 语义/ranking/API 语义/gateway/skills/ChatView/其他三页/AppShell/Sidebar。

## 一、数据能力审计（§二 答案，payload=/events?state=all）

| 字段 | 状态 |
|---|---|
| event_id/event_key/event_type/severity/title/summary/facts/lifecycle/first_seen/last_seen/persist_days/resolved_at/attribution_status/late/score/org(channel)/created_at/attribution_generated_at | ✓ 全部在列（EventCenterEvent） |
| **analysis_id / latest analysis** | ✗ 列表载荷无（仅详情端点）——本轮不需要，报告缺口 |
| brief_date / effective_data_date | 部分：载荷仅 `asOf`（全库最新简报日），无逐雷达落数日 |
| 列表范围 | **active + resolved 全量**（business_event 全表，500 截断+truncated 标记） |
| KPI 来源 | 服务端 summary（近30 vs 前30 窗口 + delta，D-e5 唯一权威） |
| 趋势图来源 | 服务端 trend（30 点=按 first_seen 的新发事件日计数） |
| **近期动态真实性** | ✓ **已是真·状态变化时间线**：created_at 发现 / attribution_generated_at 归因完成·降级·失败 / resolved_at 解除，三类真实时间戳（M-i6.1 U5），无伪造；"持续第 N 天"不进线（正确） |
| 表格排序来源 | 服务端 `ORDER BY first_seen_date DESC, event_id`（api_main.py:168）=**最近发现字段序**（非业务优先级）；score 在行内但列表不按 score 排 |

**能力结论**：今日/近7日新增可由 first_seen_date 与 asOf 做确定性日期算术 ✓；"持续异常阈值"类 KPI 无业务阈值 → 用**持续最久 N 天**（极值事实，不造阈值）替代。

## 二、设计

### 1. KPI Strip：态势五卡（§三，替换现有五张分类计数卡）
| 卡 | 值 | 来源 |
|---|---|---|
| 进行中 | N | 服务端 lifecycleDistribution.active（全量口径=截断集，服务端权威） |
| 重大异常 | N（sub：当前进行中） | 客户端 count(active∧major)，**truncated 时 sub 加「基于最近500条」** |
| 近7日新增 | N（sub：**{asOf MM-DD} 当日新增 +N**——与 asOf 绑定，不假设自然日今天，裁定2） | 客户端 first_seen_date ≥ asOf−6 确定性日期算术 |
| 持续最久 | N 天（sub：{对应事件标题截断}） | max(persist_days | active)，truncated 同上注明 |
| 已解除 | N（sub：近30日解除 {summary.resolved.count} 条） | 服务端 lifecycleDistribution.resolved + summary |

**truncated 统一安全处理（裁定1）**：`data.truncated=true` 时——KPI 条下显一条轻提示「部分统计基于最近 500 条已加载事件」；所有依赖完整列表的客户端统计（重大·进行中/近7日/持续最久/平均解除周期）逐卡 sub 注明；服务端 summary/distribution 本身即截断集口径（api_main 注释防线），照常展示不改口。
30 日窗口与较上期 delta 不丢——移入「近30天经营摘要」卡（见 4）。目标偏差类型保留在筛选与类型分布（不占 KPI 位）。

### 2. 筛选两层（§四，能力零删除）
- **第一层常显**：搜索框 / 日期范围 from~to / **快捷状态分段**（全部 · 进行中 · 已解除 · 重大异常）→ **「重大异常」固定语义=active AND major（与 KPI 卡同口径，裁定3）**；进行中/已解除映射 life；单选互斥，组合需求走更多筛选 / 「更多筛选 ⌄」toggle
- **第二层折叠**（默认收起）：严重程度 / 事件类型 / AI分析状态 / 区域·组织 / 晚到 checkbox——**高级层允许自由组合 life×sev**（裁定3）
- 快捷状态与第二层重叠项联动：第二层改动 life/sev 时快捷分段回到「全部」（避免双源打架，单向同步注释）

### 3. 问题清单微调（§五/§六/§七，P0-T4 已定骨架）
- 当前状态第二层加前缀：`AI · 分析完成`（lifecycle 与 attribution 分离不变，late 仍仅标题 Badge）
- 持续时间：数字 font-medium + title「持续天数=首次发现至今」；**无阈值不着色**（§六裁定：只加粗/标签，禁红黄绿）
- 操作列：查看详情 `whitespace-nowrap`（**永不折行**，主按钮）+ 继续分析 → 文字链
- 事件列两行/事实 line-clamp-2：已达标保持

### 4. 近30天经营摘要（§八/裁定4/5，重写 TrendSummaryCard → 卡组）
SectionCard「近30天经营摘要」四格，**窗口/时点显式分标**：
- 新增 {summary.total.count} 条（**近30天**；sub 较上期 delta，正负语义=新增多为坏）
- 已解除 {summary.resolved.count} 条（**近30天**；sub delta，解除多为好）
- 平均解除周期 {mean(persist_days | resolved_at∈近30日)} 天（**近30天**；**用既有 persist_days 与列表持续天数同口径，不重造 resolved_at−first_seen 差值口径**，裁定4；0 样本→—；truncated 注明）
- 当前持续 {lifecycleDistribution.active} 件（**当前时点**——卡内标注「时点」，与前三窗口指标区分，裁定5）
**删「集中日」**。服务端字段优先，客户端仅做列出的确定性算术（口径注脚标明）。

### 5. 排序（§十四）
- 默认=服务端序（最近发现）——**不包装成"优先级算法"**
- 表头右侧小 toggle：`排序：最近发现 | 持续最久`（持续最久=persist_days desc, first_seen desc tie-break——纯字段排序，标注「字段排序」tooltip）

### 6. 图表（§九/§十）
类型分布（4 真实 event_type 中文标签）与生命周期分布（仅 active/resolved 两态）保持——均已合规；total 基数沿用 events.length。

### 7. 近期动态（§十一）
**保留现有真·时间线**（三类真实时间戳），仅升级呈现：条目上限 12→15、发现/归因/解除分组色点已合规；不加"持续中"心搏条目（无真实数据，禁造）。标题「事件动态」。

### 8. 内部信息零暴露（§十五）
score/publishMinScore/scoreGap/rankToday 已不渲染（P0 起）；保持，grep 断言。

## 三、文件清单

| 文件 | 改动 |
|---|---|
| `web/src/components/insights/EventCenterPage.tsx` | KPI 五卡重定义/筛选两层/排序 toggle/近30摘要卡组/操作 nowrap/AI·前缀/持续强调 |
| `EventCenterCharts.tsx` | 大概率零改动（donuts 已合规）；如需微调仅限标题/配色对齐 |
| EventCenterView.tsx / App.tsx / types / api / 后端 | **零改动**（详情跳转 detailSource="events" 与返回逻辑 P0 已好，不动） |

## 四、响应式（§十六）

1366：KPI 五卡 md:grid-cols-5（~200px/卡）；筛选第一层 flex-wrap（快捷分段 ~300px+搜索 flex-1+日期 2×140px 可两行换行不横滚）；表 7 列 colgroup 沿用（操作 10%≈103px 容 nowrap 按钮 ~76px+余量）；第二层折叠默认收起减噪。唯一纵向滚动=AppShell。

## 五、验收方案（§十八 16 条）

1. build 绿 → 对抗 review（16 条+红线：无新增事件类型/无伪造 timeline/无内部 score 暴露/lifecycle 与 attribution 不混/late 仅 badge/纯字段排序不冒充优先级）
2. playwright 探针：KPI 五值与 payload 算术对拍（进行中/重大·进行中/近7日/持续最久/已解除）；当日新增标注为 asOf 日期；快捷「重大异常」→列表=active∧major；更多筛选展开→五项在位且 life×sev 可自由组合；排序切持续最久→首行 persist_days=max；近30摘要四值对拍（平均解除周期=persist_days 均值）；查看详情按钮 offsetWidth≤列宽（不折行）；1366/1440/1920 overflowX=0；truncated 提示文案存在性（构造性检查——当前生产 <500 条则 grep 代码路径）
3. grep：无 集中日/无 score·距发布线渲染/无新增事件类型 key
4. 零退化：详情跳转回事件中心（detailSource events）、followup 链路、其他三页冒烟
5. 截图 `screenshots-p0/p1-4/`（3 宽度 × 默认/筛选展开/持续最久序）
6. 留档 harness spec+report；不自动进 P2
