# P0 驾驶舱 UI/UX 架构改造 — 实施报告（2026-10-06）

范围：dataplat-ui 仓前端壳/布局/展示层（spec 见 `2026-10-06-cockpit-p0-ui-refactor.md`）。
**零改动**：detector / event model / insight API 业务口径 / engine-gateway / skills / ChatView·SSE 链路 / api.ts / types.ts / server/**。

## 提交清单（dataplat-ui，全部路径限定）

| commit | 内容 |
|---|---|
| 95fe1e7 | T1 ck token（17 色 + shadow-ck）+ cockpit/ 12 公共组件 |
| 66a9918 | T2 双壳侧栏（legacy 字节不变 / cockpit 三组导航 / chat 返回驾驶舱）+ detailSource |
| 508bfd3 | T2b 详情高亮门控在 `view==="insights" && openEventId`（修侧栏钉死 bug） |
| 74ecf8f | T3 今日经营关注族 + P5 健康状态 chip + dashboard-* CSS 删净 |
| 50589b0 | T4 事件中心 + P6 七列表（colgroup 30/9/20/12/8/11/10） |
| 254e5b3 | T5 目标管理全宽 + P4 事实卡 + 区域作战地图（含 DegradedLine 去前缀） |
| 68dc23d | T6 我的关注改版 + 事件详情壳 + 终扫 |
| e4a3e35 | review nit：未知健康环键→未接入（原 正常 属软造数） |

review 结论 PASS-with-nits（红线/规范/逻辑漂移逐项核过，详见会话）；nit1 已修，nit2/3 属透明展示派生/既有结构，接受。

## 验证证据

- **build**：每任务 `tsc -b && vite build` 绿；生产静态随 dist 即时生效（app.ts express.static 逐请求读盘，无 pm2 restart）
- **截图取证**（`D:\dataplat-ui\screenshots-p0\`，playwright+系统Chrome）：
  - `before/` 24 张（3 宽度×8 视图，改造前）——三处 P0 痛点留档（侧栏混会话/目标管理右空白+趋势外推/11 列宽表）
  - `after/` 24 张 + 375px 1 张
  - `flagoff-after/`：flag-off 专项（临时账户 p0-flagoff，已禁用）——驾驶舱入口全无、legacy 侧栏无损
- **几何探针**（probe-width.mjs，硬数据）：五页 1366/1920 全部 `mainRight=视口宽`、`rightGap=32px`（=设计基线 padding）、`innerScroll=0` → P3 客观修复；视觉模型曾误报"右侧空白带"，实为 32px 设计留白
- **375px**：aside 收 72px，7 项导航+登出全可达、无横溢（标签换行=改造前同形态）
- **grep 门**：`dashboard-`=0；insights/ 内暗色 token（bg-base/text-ink-2/border-line/accent-soft/max-w-6xl）=0；TargetManagementPage 内 趋势外推/预计完成/预计缺口/恢复潜力/projection./recoveryWan=0；EventCenterPage 内 overflow-x-auto=0

## 用户裁定落地

1. 我的关注=第 7 入口（经营模块组内），全量改版 ✓
2. 系统设置=AdminView（管理设置组，isAdmin 门禁；非 admin 见 6 项）✓
3. 恢复潜力删除；API payload 未动（前端停读）✓
4. P5 阈值=60/80 色带等价原始值（销售 -20/-10pt、毛利 -4/-2pt、应收 >40/>20%），只活于 HealthPanel 局部函数，不回流业务 ✓

## 六边界落地

① P5 判定只读 available+inputs（score 仅 popover 参考）；输入缺失→未接入 ② 侧栏三组（经营模块/AI问数/管理设置）③ detailSource 高亮+按来源返回（含 508bfd3 门控）④ AppShell 唯一页面级滚动容器 ⑤ 缺口≤0→超额完成（Math.abs）⑥ 标题/关键事实 line-clamp-2 ✓

## 已知边界（接受）

- AdminView 内容保持暗色（P0 明确不动其内容；cockpit 壳包着暗色管理台）
- 375px cockpit 侧栏文字换行（改造前 flag-on 即此形态，移动端非本轮验收项）
- EventDetail 10 个子组件未重绘（本就属主导样式族，P1 可选）
- types.ts 留 projection/recoveryWan 字段不读（API 契约不动）

## 工具沉淀（dataplat-ui，不入库构建）

`scripts/p0/`：screenshot.mjs（API 登录+cookie 注入+按侧栏导航+横溢量化）、probe-width.mjs（内容占宽几何探针）、mobile-check.mjs；node_modules 已被根 .gitignore 覆盖。

## 交付后事件（2026-10-06 下午，用户报"销售模块乱码"）

- **根因链**：DWS 空闲连接中断（10053）→ health.py 以异常 repr 作 sales 环 reason → P5 未接入单元格把 reason 原样渲染成值行 → margin/ar 可用触发当日缓存钉死降级态。"乱码"=OperationalError 英文异常串。
- **修复**：①UI 消毒（dataplat-ui a19c2ac）——异常形态 reason → `数据暂不可用`，原文留 title 提示；②`pm2 restart insight-api` 清污染缓存换新连接。
- **验证**：DOM 无异常文本（playwright 断言）；sales 环恢复 available（yoy_pct -5.9）；DWS 直查对拍 `(501,837,287−533,029,812)/533,029,812 = -5.85%` ✓。上午缓存的 -16.2% 为 9 月行日中重述前快照（推算 cur 差约 5500 万，落数时点现象），两次显示都诚实。
- **加固已实施并上线（用户裁定"修"，同日）**：①环级连接自愈 `health._retry_if_conn_dropped`——异常且 `_conn` 已弃（10053 被 `_recover` 弃置）→ 重建重跑一次；连接仍在（语句超时）照抛，护栏语义不变（harness ba3d050）②异常致降级环带 `error` 标记（区别数据缺失型），health 缓存双条件=至少一环可用 且 无 error 环；UI 以 marker 为权威信号显示 数据暂不可用（dataplat-ui 35f4a48）。测试 +3（insight 200 passed +8 skipped 零回归）；review PASS-with-nits，其 finding 1（"不重试"用例假件误置 _conn=None、护栏分支零覆盖）已修（be8768c）。遗留 LOW 接受：硬断连期每环重试多一次 connect（有界 2×/环，BFF 5s 超时先断）；target 块单独失败仍可按日钉 None（既有行为，重试已降低概率）。部署：`pm2 restart insight-api`，线上三环 available、无 error 标记复验通过。
