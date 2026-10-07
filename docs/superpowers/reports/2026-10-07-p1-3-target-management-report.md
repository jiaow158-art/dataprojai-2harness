# P1-3 目标管理产品化 — 实施报告（2026-10-07）

spec：`docs/superpowers/specs/2026-10-07-p1-3-target-management-productization.md`（用户 15 节需求 + 批准计划 + 裁定 1-5）。
范围：dataplat-ui 2 文件（1362efa 实现 + d8ad72a review 修复），纯前端。零改动：types/api/后端/ChatView/其他页。

## 验收 15 条对账（全部通过）

| # | 标准 | 证据 |
|---|---|---|
| 1-2 | KPI Strip 六卡 | md:grid-cols-6；值全为 payload 直读+确定性算术；review 逐行 |
| 3 | 零预测 | grep 预计/外推/年化/恢复潜力/projection/yoyPct/recoveryWan = 0（字段留而不读） |
| 4 | 累计双线真实历史 | 前端 running Σ；**当月点=月目标×月工作日进度（裁定2 同口径）**；线止于当月；目标/实际断线各自 latch 不造 0 |
| 5 | 诚实降级 | months 降级/序列<2/当月 timePct 缺/目标序列中断 各有专门降级文案；图例注明当月口径 |
| 6-7 | 缺口来源真实 | L3=服务端 behindWan/behindSharePct/合计（**进度缺口贡献 Top5**，裁定3 正名）；区域维度零渲染，口径注脚披露缺失维度 |
| 8 | 月度表明细 | 6 列（同比删）；完整月 领先/落后；**当月差额=MTD实际−月目标×月工作日进度（裁定4，逐位对拍 -4,919.3万 ✓）** |
| 9-10 | 真实事件+跳详情 | target_gap 过滤自 active 端点；fetch 失败≠空（「事件数据暂不可用」）；点击→详情，detailSource+"targets" 侧栏高亮目标管理、返回回目标页 |
| 11-12 | AI 复用六步法 | App askSeed（P1-2 既有）零改动；问句只注真实值+距年度目标措辞+事件 id 附注；annual 降级 disabled+数据未就绪（裁定5）；无新 Agent/无前端 SQL |
| 13 | 金额高管格式 | fmtWanSmart（≥1亿→亿 2 位；<1亿→万 1 位——用户 §三规则）；Y 轴 0 刻度特例 |
| 14 | 三宽度无横滚 | 探针 overflowX=0 ×3 |
| 15 | 零退化 | App 仅 2 hunks；P1-2 region onAsk/askSeed 原路径 byte-identical |

## 数字对拍（playwright 探针，UI vs payload 公式）

- KPI **距年度目标 缺口 11.34 亿** = targetWan−actualWan ✓
- 图终点 **当前进度缺口 7.51 亿** = Σ完整月目标+当月目标×18.2% − Σ实际（同口径）✓ —— 两数并存且语义严格分离（裁定1/2）
- 当月行差额 −4,919.3万 = 3,594.9 − 46,781.4×18.2% ✓
- Top5：粤东 4,765.1万 / 华东 4,422.9万 / 西南 2,610.7万 / 赣皖 2,497.2万 / 粤西 1,822.9万（=behindWan 降序）；合计 2.17亿；另有 1 中心超前（严格 <0 计数）

## review 与修复

对抗 review **PASS-with-nits**（15/15 + 红线全过），6 findings 修 6（d8ad72a）：分段染色（带色随每段实际vs目标符号）/事件错误态≠空/超前严格<0/目标断线 latch/轴 0 标签/Ring 旧注释。Info 级 1 项接受（超额完成文案在 1366 六列下可能换行，仅在实际超目标时可达）。

## 数据缺口（报告，未擅动）

区域/渠道/产品维度目标缺（D-r2 族）→ 缺口贡献只做组织维度并脚注披露；months 无未来月（累计线天然无外推空间）；payload projection/recoveryWan/yoyPct 继续留而不读。

## 沉淀

- **三个"缺口"三种口径并存且各自命名**：距年度目标（整月目标−实际，KPI）/ 当前进度缺口（月工作日同口径，图终点）/ 进度缺口贡献（年日进度欠进度，Top5）——UI 严禁互相换算或混称
- months[].timePct=月工作日进度、centers[].timePct=年日进度、annual.timePct=年日自然日——三个"时间进度"三种口径，已在 UI 各标注
- Σ(1..当月整月目标)=annual.targetWan 逐位成立（核对过），KPI 与图天然闭环

## 取证

截图 `D:\dataplat-ui\screenshots-p0\p1-3\`（3 宽度）；探针 `scripts/p0/p13-verify.mjs`（数字对拍）、`p13-text.mjs`（DOM 文本）、`p13-final.mjs`（终验）。生产已随 build 生效。
