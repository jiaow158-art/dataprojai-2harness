# P1-2 区域作战地图产品化（dataplat-ui 仓）

## Context

P1-1 已收口。本轮把区域页从"同比热力图"升级为作战入口：全国态势 → 重点区域 → 区域画像 → 关联真实事件 → 一键进 AI问数六步法。**纯前端**：不动 detector/event model/ranking/API 语义/gateway/skills/ChatView/六步法/其他页/AppShell/Sidebar/Design System。

## 一、现状数据映射（§二答案，已核实）

| 指标 | 来源 | 状态 |
|---|---|---|
| 1 全国销售额 | `national.ytdWan` | ✓ |
| 2 全国同比 | `national.yoyPct`（双年同窗） | ✓ |
| 3 毛利率 | `national.grossMarginPct` + `regions[].grossMarginPct`（窗内毛利和÷净销售和） | ✓ 全国+七区 |
| 4 全国目标达成率 | `national.achievePct`（M-i7 target 同源注入） | ✓ 仅全国 |
| 5 区域销售额 | `regions[].ytdWan` | ✓ |
| 6 区域同比 | `regions[].yoyPct` + 服务端 `level` | ✓ |
| 7 区域毛利率 | `regions[].grossMarginPct` | ✓ |
| 8 **区域目标达成率** | **无——D-r2 结构性缺口**（目标表无省份维度，mix 预算列只在无省汇总行） | ✗ 缺 |
| 9 区域映射 | server `config/region-map.json` 权威 + ChinaMap 内 `REGION_PROVINCES` UI 副本；org 粒度=运营中心（node_desc5），**大区非组织实体、无 org_code** | ✓ |
| 10 区域关联事件 | `regionEvents{region:[{event_id,title,severity,score,org}]}` top5——**真实事件**（无合成预警，现状已合规） | ✓（facts/status 需联表） |
| 11 下级组织能力 | `provinces[]`（省级销售/同比；无省级毛利率）；中心粒度=regionEvents 关联域 | 部分 |
| 12 followup/AI问数上下文 | App `followupSeed{sessionId,question}`→ChatView autoAsk（**必须已存在会话**）；BFF followup 流程=建会话→种问题（生产验证过） | ✓ 可复用 |

**当前颜色规则**：服务端 `level`（decline ≤-8 / watch <0 / growth ≥0，D-r1 业务校准）→ ChinaMap `LEVEL_STYLE` 红橙绿。

## 二、数据缺口清单（报告，本轮不造不改）

1. **区域目标达成率**：缺（D-r2）→ 指标切换器只有 3 项真实可用（销售额/同比增速/毛利率）；达成率只在全国 KPI 卡。不造假列。
2. **regionEvents 无关键事实/当前状态**：与 `GET /api/insight/events?state=active` 按 event_id **前端联表**补 summary/persist_days/attribution_status（两 API 均现有；联表 miss 的行诚实只显标题）。
3. **跳事件中心带区域筛选**：不支持——EventCenter 的 org 筛选是中心粒度≠大区、文本搜索前缀不可靠（粤东∈华南但不含"华南"字样）→ v1 跳转**不带筛选**（页面画像内已列该区 top 事件）。
4. **省级毛利率**：缺（不影响本轮，无省级下钻）。
5. **大区 org_code**：不存在——问句注入 region_name+事实+event_id（§七上下文里 org 粒度天然是中心）。

## 三、设计

### 1. 指标切换器（§三/§四/§五）——新页面级状态 `metric: "amt"|"yoy"|"gm"`
地图卡片头部三段切换（销售额/同比增速/毛利率），驱动三处联动：
- **地图颜色**（按指标独立语义，规模/表现/风险三分）：
  - 销售额：**规模连续蓝阶**（按 ytdWan 排序三档 蓝400/蓝200/蓝100）——legend「**规模较高/中等/较低**」+ 标注「**仅代表规模，不代表经营好坏**」（裁定1.3）
  - 同比增速：沿用服务端 level 红橙绿（唯一业务校准过的表现色）
  - 毛利率：**值序中性阶**（蓝灰→蓝三档，**无风险阈值不染红绿**）——legend「**相对较高/中间水平/相对较低**」+ 注明「**当前仅为区域相对分布，不代表风险评级**」（裁定1.4）；null→灰 unknown
- **地图气泡标签**：第二行随指标（亿 / 带符号% / %）
- **右侧排名**：排序键=当前指标；列= #/区域/当前指标值 + 一个辅助值（销售额与毛利率模式辅=同比，同比模式辅=销售额）——不超过两个数值列
- 切换保持 selectedRegion（独立状态）

### 2. ChinaMap 改造（§十二交互）
- props 增 `metric`、`fillOf(region)`（或传 metric+rows 由内部算色阶）、`labelOf(row)`；`LEVEL_STYLE` 仅同比模式使用
- hover：省份/气泡 hover → 该大区全部省份 stroke 高亮 + **浮动 tooltip**（区名 + 当前指标值 + 同比——两个字段封顶）
- click：选区（已有）；**点击地图空白（九段线外背景 rect）→ onSelect(null) 取消选中**
- legend 随指标切换
- Taiwan/港澳维持灰不可点（现状）

### 3. 区域经营画像（§六）——选中态右栏顶部新增 `RegionProfileCard`（页内局部组件，**两区块**：经营表现事实 / 关联经营事件，裁定1.6）
```
华南区域                      [返回全国]
─ 经营表现事实 ─────────────────
销售额 7.6 亿   同比 -22.7%   毛利率 28.4%
（轻量说明行：区域目标达成率暂未接入——不作为与真实 KPI 同级的卡片，裁定1.2）
─ 关联经营事件 3 条 ─────────────
  · 事件标题（severity chip）        ● 进行中 / 分析完成
    关键事实一句（联表 summary）
  （≤3 条真实事件；0 条 → 「当前区域暂无关联经营事件」）
  >3 → 进入经营事件中心 →（跳转不带筛选，文案不暗示区域筛选已生效，裁定1.1）
[查看区域详情]  [让AI分析该区域]
```
- 查看区域详情 = 平滑滚动到下方已联动的 区域趋势/省分布（不新建大模块，§六允许）
- 未选中态（默认，§十三）：右栏= 全国排名 + 关联经营事件（全部大区去重并集，现状行为的延续）

### 4. 让AI分析该区域（§七，核心）
**完全复用现有问数链路，零新 Agent/零前端 SQL/零网关绕开**：
- RegionBattleMapPage 新 prop `onAsk(question: string)`；问句在页内拼装（最小上下文：region_name、当前指标、销售额/同比/毛利率事实、关联 event_id+标题、asOf）。**首问不强制渠道/组织/客户/产品全查**——交由现有六步法先识别贡献最大的下钻方向再继续（裁定1.5）：
  `请分析{region}区域当前经营表现：年初至今销售额 {x} 亿、同比 {y}%、毛利率 {z}%。请先识别同比与毛利变化中贡献最大的下钻方向，再沿该方向深入分析原因。`（关联事件存在时附 `可参考关联经营事件：{title}（event_id …）`）
- App 新 handler（唯一 App 改动）：`apiCreateSession()` → `refreshSessions()` → `setActiveId(s.id)` → `setFollowupSeed({sessionId: s.id, question})` → `setView("chat")` —— 与生产验证过的 followup 编排同构（ChatView autoAsk 要求已存在会话，预建会话即满足；`view.forId===sessionId` 就绪后自动发送）
- 已知小 wart：预建会话标题为默认「新会话」（BFF followup 的标题服务是事件绑定路径，不属本轮）；六步法由 sales-performance 域知识接管

### 5. KPI/预警区展示语义（§九/§十）
- 卡5 「重点关注区域数」→ 「**同比下滑区域**」值 `n / 7`（n=level∈{decline,watch} 数，即同比<0；regions 降级仍显"—"不伪装无风险）；sub「同比增速为负」
- AlertCard 更名「**关联经营事件**」（·全部大区/·华南）；**meta 删 `分数 {score}`**（不暴露内部排序）；内容已是真实事件零合成；0 条显「当前区域暂无关联经营事件」
- 「双年同窗」措辞退出主标题（KPI2 sub 改「vs 上年同期」，window 串进 title tooltip；§十四）

### 6. 金额（§十五）
页内已统一 `fmtYi`（亿 1 位小数，36.4 亿形态）——保持；不引入万/亿混排。

### 7. 不扩 BI（§十一）
底部三卡（12月趋势/省分布/作战卡）保留现有联动行为，不加新图表。

## 四、文件清单

| 文件 | 改动 |
|---|---|
| `RegionBattleMapPage.tsx` | metric 状态+切换器、RankCard 指标化、AlertCard 改名去分数、RegionProfileCard（局部）、KPI 卡5 重定义、onAsk/onOpenEventCenter 接线、active-events 联表 |
| `ChinaMap.tsx` | 指标驱动色阶/标签/legend、hover tooltip+大区高亮、空白点击取消 |
| `App.tsx` | onAsk handler（建会话+种子，同 followup 编排）一行级接线 |
| types.ts / api.ts / 后端 | **零改动** |

## 五、验收方案（§十七 17 条）

1. build 绿 + 对抗 review（17 条逐项+红线：无合成预警/无前端 SQL/无新 Agent/阈值未回流）
2. playwright 交互探针：切换三指标 → 断言地图色 class/排名首行随指标变；点击华南 → 画像出现且四指标含达成率"—"；点击空白 → 取消；指标切换后选中保持；「让AI分析」→ chat 页自动发问（断言首问文本与会话创建）；1366/1440/1920 overflowX=0
3. 截图 `screenshots-p0/p1-2/`（3 宽度 × 全国态/选中态/各指标）
4. grep：无「重点关注区域数」/无「分数 」泄漏/无预警合成文案
5. 零退化：事件中心/首页/AI问数 手动冒烟（followup 原路径不动）
6. 留档 harness spec+report；不自动进 P1-3
