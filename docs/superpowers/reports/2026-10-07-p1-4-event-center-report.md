# P1-4 经营事件中心产品化 — 实施报告（2026-10-07）

spec：`docs/superpowers/specs/2026-10-07-p1-4-event-center-productization.md`（用户 19 节需求 + 批准计划 + 裁定 1-5）。
范围：dataplat-ui 单文件（160b730 实现 + ccac3d4 review 修复），纯前端。零改动：EventCenterCharts/EventCenterView/App/types/api/后端。

## 验收 16 条对账

| # | 标准 | 证据 |
|---|---|---|
| 1 | 总控台非台账 | 态势五卡：进行中 6 / 重大异常 0（当前进行中）/ 近7日新增 0（**10-07 当日新增 +0**，asOf 绑定）/ 持续最久 9 天（含事件标题）/ 已解除 3（近30日解除 3 条）——探针五值与 payload 算术全对拍 |
| 2 | 筛选两层 | L1=搜索+日期+快捷分段+更多筛选⌄；L2 折叠含全部 6 项控件（能力零删除）；**快捷重大=active∧major 固定语义**（探针：点击后 0 行=重大·进行中 0）；L2 改 life/sev → 快捷回全部（单向同步） |
| 3 | 7 列 | colgroup 29/9/20/12/8/11/11（review 修宽后） |
| 4 | lifecycle/attribution 分离 | 两层 StatusTag，attribution 带 `AI · ` 前缀（探针 ✓） |
| 5 | late 仅 Badge | 标题格内，不入状态列 |
| 6 | 查看详情不折行 | nowrap + 列宽修复：1366 实测按钮右缘 992 ≤ 卡片边框 994（修复前 1002>993） |
| 7 | persist_days 可读 | font-medium + title 口径说明，无阈值无红黄绿 |
| 8 | 近30摘要真实 | 新增 9/已解除 3（服务端 count）/ **平均解除周期 2.0 天（persist_days 均值同口径，裁定4）**/ 当前持续 6 件（**时点**分标，裁定5）；集中日已删 |
| 9 | 类型=真实 4 型 | 服务端分布直出 |
| 10 | 生命周期图仅两态 | donut 未动（进行中 67%/已解除 33%） |
| 11 | 动态不伪造 | 真·时间线保留（发现/归因/解除三类真实时间戳，12→15 条） |
| 12 | 内部信息零暴露 | grep score/scoreGap/rankToday/publishMinScore/集中日/今日 = 0 |
| 13 | 详情跳转 | detailSource="events" 原路径零 diff |
| 14 | AI 复用 | follow()/apiInsightFollowup/onFollowed byte-identical |
| 15 | 三宽度无横滚 | overflowX=0 ×3 |
| 16 | 零退化 | 单文件 diff |

**裁定1 落地**：truncated=true 时——KPI 条下轻提示「部分统计基于最近 500 条已加载事件」+ 四张客户端计算卡（重大/近7日/持续最久/平均周期）逐卡 sub 注明；服务端 summary/distribution 本身即截断集口径照常展示。当前生产 9 条未触发，代码路径经 review 构造性验证。

## 排序（§十四）

默认=服务端序（first_seen DESC=最近发现，按引用返回不重排）；「持续最久」=纯字段排序（persist_days desc, first_seen tie-break），容器 tooltip 注明「字段排序（非经营优先级）」。探针：切换后首行持续 9 天=max ✓。

## review 与修复

对抗 review **PASS-with-nits**（16/16+裁定全过），修 3 项（ccac3d4）：近7日缺截断注（裁定1 补齐）/操作列 1366 溢出卡片边框 10px（colgroup 29/11+px-2，实测收回）/持续最久 0 天边界（无进行中→「—」）。接受 2 项：快捷覆盖时 L2 显示滞后（裁定3 规定的单向同步语义，注释在案）；asOf 空串防御（服务端契约保证+TS 必填，与既有约定一致）。

## 数据缺口（报告）

analysis_id/最新分析引用：列表载荷无（仅详情端点）——本轮未需要；逐雷达落数日：载荷仅 asOf。两者均未阻塞。

## 取证

截图 `D:\dataplat-ui\screenshots-p0\p1-4\`（3 宽度 × 默认/筛选展开/持续最久序，共 9 张）；探针 `scripts/p0/p14-verify.mjs`（五值对拍+快捷+排序+nowrap）、`p14-ctx.mjs`（"已解除 90"乌龙定位——实为事件标题「90天以上应收明显增加」）、`p14-final.mjs`/`p14-fit.mjs`（终验）。生产已随 build 生效。
