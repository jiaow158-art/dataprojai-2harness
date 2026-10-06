# P1-2 区域作战地图产品化 — 实施报告（2026-10-06）

spec：`docs/superpowers/specs/2026-10-06-p1-2-region-battle-map-productization.md`（用户 18 节需求 + 批准计划 + 裁定 1.1-1.6）。
范围：dataplat-ui 3 文件（ddc1ec6 实现 + 8881fc7 注释修正），纯前端。零改动：types/api/后端/ChatView/其他页/AppShell。

## 验收 17 条对账

| # | 标准 | 证据 |
|---|---|---|
| 1 | 真实指标切换 | 销售额/同比增速/毛利率三段切换（达成率缺口不造假项）；review PASS |
| 2 | 地图/标签/排名同步 | 单源驱动（页 METRICS 排名列值 + ChinaMap metricScale 填色图例同函数）；交互探针：三指标下排名首行各异（华东→西南→东北） |
| 3 | 规模≠风险 | amt 纯蓝阶；图例「规模较高/中等/较低」+「仅代表规模，不代表经营好坏」（裁定1.3） |
| 4 | 无毛利风险阈值 | gm 中性靛阶；「相对较高/中间水平/相对较低」+「仅为区域相对分布，不代表风险评级」（裁定1.4）；null→灰 |
| 5 | 点击出画像 | 探针六断言全过（华南区域/返回全国/两区块/轻量说明/AI按钮） |
| 6 | 画像真实字段 | 销售额 7.6亿 / 同比 -22.7% / 毛利率 27.2%；达成率=轻量说明行「区域目标达成率暂未接入」（裁定1.2，非同级卡片） |
| 7 | 真实关联事件 | regionEvents + active-events 前端联表（summary/lifecycle/ATTR）；join-miss 仅显标题 |
| 8 | 无事件不造预警 | 「当前区域暂无关联经营事件」；AlertCard→「关联经营事件」，内容本就全部真实 |
| 9 | AI 分析复用六步法 | App askSeed = apiCreateSession→refreshSessions→setActiveId→followupSeed→setView("chat")（与生产 followup 编排同构）；探针实弹：点击后 chat 页首问原文发出（含裁定1.5「请先识别…贡献最大的下钻方向」措辞） |
| 10 | 无新 Agent/前端 SQL | review grep 零命中；唯一新调用=apiInsightActiveEvents（既有） |
| 11 | 排名随指标 | METRICS[metric].sort；列=当前指标+一辅助值；score/距上榜零泄漏 |
| 12 | tooltip/hover/selected | 悬停大区描边高亮+fixed tooltip（区名+指标+同比≤3行）；点击选区；探针+目检实拍 tooltip |
| 13 | 切指标保持选中 | 探针 true |
| 14 | 日期统一 | 「双年同窗」退到 tooltip；主标题仅「数据日 asOf」单一表达 |
| 15 | 金额统一 | 全页亿 1 位小数（36.4 亿形态） |
| 16 | 三宽度无横滚 | overflowX=0（探针×3 宽度）+ review 宽度算术（1366 地图卡 706px > 头部 ~410px） |
| 17 | 零退化 | onOpenEvent/detailSource("regions")/BattleCard/省分布/趋势/App 其余流 byte-identical（review 逐 hunk） |

空白取消（AC12 附）：svg 首子透明 rect（fill=transparent 可命中指针）→ onSelect(null)——探针实测通过（首次探针失败是坐标点在右栏的乌龙）。

## 数据缺口（已报告，未擅动）

1. 区域目标达成率（D-r2 结构性）→ 切换器无此项；全国达成率在 KPI 卡
2. 事件中心带大区筛选跳转不可靠（org 筛选=中心粒度；粤东∈华南但不含"华南"字样）→ v1 文案「进入经营事件中心」不暗示筛选（裁定1.1）
3. 省级毛利率缺（无省级下钻，不影响）
4. 大区无 org_code（问句注入 region_name+事实+event_id）
5. 预建会话标题为默认「新会话」（BFF 标题服务是事件绑定路径；如需区域命名会话需 BFF 小改，留待裁定）

## review 与修复

对抗 review **PASS-with-nits**：17 条全过；修 finding 1（三分位注释 3/1/3→实际 3/2/2，8881fc7）；finding 2（tooltip 不跟滚动/无边缘钳制）接受留待下次触碰；finding 3/4 信息性（<720px 头部不换行、StrictMode 双取数既有模式）。

## 设计沉淀

- **六处同源**：切换器/排名排序/排名列/地图填色/气泡标签/图例全部由 `metric` 单态驱动（页 METRICS + ChinaMap metricScale 导出共享，杜绝"地图看同比排名按销售额"）
- **三分位确定性**：降序稳定排序，ceil(n/3) 高 / floor(n/3) 低 / 余中（7区=3/2/2），null 不入分位
- **D-r5 语义提醒**：区域关联事件按中心**销售足迹**（center×province）跨区归属——华南画像出现"华东运营中心"事件是设计而非 bug（该中心在华南省份有销售）
- 复用 askSeed 编排时 ChatView autoAsk 前置条件=已存在会话（followupSeed.sessionId 匹配 active.id）——预建会话是唯零 ChatView 改动的路径

## 取证

截图 `D:\dataplat-ui\screenshots-p0\p1-2\`（3 宽度 × default/selected/gm + 1440-ai-ask）；交互探针 `scripts/p0/p12-interact.mjs`、`p12-fix.mjs`、`p12-shots.mjs`。生产已随 build 生效。
