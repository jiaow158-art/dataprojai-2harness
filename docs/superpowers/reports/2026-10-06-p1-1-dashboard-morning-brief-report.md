# P1-1 「今日经营关注」高管首页产品化 — 实施报告（2026-10-06）

spec：`docs/superpowers/specs/2026-10-06-p1-1-dashboard-morning-brief.md`（用户 15 节需求 + 批准计划）。
范围：dataplat-ui 7 文件（2ff8123 实现 + 8722581 review 修复），纯前端展示层。零改动：detector/event model/ranking/insight API 语义/gateway/skills/ChatView/followup/其他四页/cockpit 原语。

## 验收 17 条对账

| # | 标准 | 证据 |
|---|---|---|
| 1 | Hero 无「观察中」 | DOM 断言 heroHasWatching=false |
| 2 | Hero 突出 N 件 | 「有 **3** 件经营事项值得你关注」N=text-3xl ck-primary（DOM 正则命中） |
| 3 | 0~3 布局合法 | 三列 grid 不补卡；零态：ready→「今日暂无重大经营事项需要特别关注」+四雷达完成 hint，not_ready→「部分经营数据尚未就绪」 |
| 4 | 无 trend 无空图区 | 条件渲染 `series.some(cur/prev!=null)`，空序列整块消失（与 MiniTrendChart 空态互斥取反） |
| 5 | 卡高明显下降 | **硬数据：509→415(-18.5%) / 489→415(-15.1%) / 461→391(-15.2%)** @1366/1440/1920 |
| 6 | AI/事实语义分离 | attributionSummary 仅 `attributionStatus==="done"` 渲染（服务端对非 done 回退检测层事实句——曾致"AI 念事实"，已断路） |
| 7 | 不编造归因 | 非固定状态行即服务端 done 摘要；pending/running→分析中、degraded→详见详情、failed→AI问数引导 |
| 8 | 经营健康度→经营概览 | 三分支（正常/加载/降级）全改名 |
| 9 | 无 0-100 分 | 概览无分（popover 健康分（参考）为遗留允许项） |
| 10 | 目标仅事实 | 达成率/实际 36.39 亿/年度目标 47.82 亿/时间进度；零预测字样 |
| 11 | 其他关注事项 | 新标题+副题「仍在持续关注，但未进入今日重点」 |
| 12 | 无 score/距发布线 | DOM 断言 noScoreLeak=true（`距上榜|分 \d+` 零命中） |
| 13 | 可跳事件中心 | >5 条时「查看全部 →」→ App setView("events") |
| 14 | 金额高管友好 | `fmtWanSmart`（>=1亿→亿 2 位小数；负值同规则）；仅本页 UI 数字，API 原值不动 |
| 15 | 三宽度无横滚 | overflowX=0（1366/1440/1920） |
| 16 | 链路零退化 | 查看详情/AI问数/followup 编排零 diff（review 逐行核过 App.tsx） |
| 17 | API 语义不变 | types.ts/api.ts/后端零 diff |

## review（对抗）结论与处置

PASS-with-nits。修复 3 项（8722581）：①hero not_ready 文案回归「数据未就绪——今日简报未定稿，不代表无异常」且与 N 行共存（原实现复用零事件句致同屏重复+压制 N 行）②fmtWanSmart 负值亿化（Math.abs 门）③洞察框去同色 no-op 边框。nit 4 并入①；nit 5（eventCount vs events.length 信任差异）遗留观察，同冻结 payload 无回归。

## 产品发现（沉淀）

- **attribution_summary 服务端语义**：done=(parsed).summary；**非 done 一律回退 ev.summary（检测层事实句）**——任何 UI 想区分"事实 vs AI 观点"必须以 attribution_status==="done" 为门。卡片级 executive summary 无 API 缺口；degraded 的 AI 原文（answer_md）只在 event_analysis_run 表，daily payload 不带（记为潜在 P1.x 需求，未擅自加接口）。
- Hero 卡片区起点 y=143→192（hero 变高换第一视觉），1366×768 首卡 bottom=607 全入屏，1080p 首屏容纳 Hero+Top3+经营概览+其他关注事项开头——30 秒浏览路径成立。

## 取证

截图 `D:\dataplat-ui\screenshots-p0\p1-1\`（24 张三宽度 + 1440-dashboard-final）；探针 `scripts/p0/card-height.mjs`（改造前后同探针）、`p1-assert.mjs`（DOM 断言）。
