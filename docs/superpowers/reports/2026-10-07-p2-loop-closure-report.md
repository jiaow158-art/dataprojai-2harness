# P2 驾驶舱闭环修复 — 实施报告（2026-10-07）

依据：闭环审计（`2026-10-07-cockpit-loop-audit.md`）+ 用户裁定（P2-a 优先/P2-b 三桥/B4·C 不做）。
提交：dataplat-ui `e1c688a`（P2-a overlay）+ `bd4745e`（P2-a review 修复）+ `f909a3d`（P2-b 三桥）+ `c2f60b1`（P2-b review 修复）。

## P2-a 详情 Overlay 化

**机制**：`openEventId` 成为 overlay 态——打开详情只设 id **不切 view**，来源页保持 mounted（筛选/选中/指标/滚动全保留）；详情以 `fixed inset-0 z-40 role=dialog` 全屏覆盖（模态阅读态，侧栏同时被覆盖，导航须先关详情）；关闭后零刷新（页面从未卸载）。detailSource 保留赋值（来源语义），侧栏高亮恒跟 view。嵌套跳转 `key={eventId}` 重挂载（滚动归顶）。不上提页面状态（App 仅新增 transient regionFocus）。

**三路关闭**：浏览器 Back（pushState on overlayOpen 布尔跳变 + popstate 关）/ ESC / 返回按钮（closeDetail 消费压栈条目——**守卫 `openEventId && history.state?.insightDetail`**，防刷新后 stale 标记幽灵 back，review finding 1 修复）。

**验收（用户六条+边界，全部实弹过）**：
- 事件中心搜索"下滑"4行 → 详情 → 返回：**"下滑"+4行保留**
- 持续最久排序 → 返回：排序保留（与华南+毛利率同机制，后者显式断言 pill 激活态）
- 区域 华南+毛利率 → 画像事件详情 → 返回：**华南+毛利率保留**
- 滚动位置：500→500（playwright 自动滚动会污染测量——须 DOM click 测）
- 首页/目标页往返正常；ESC/Back 关闭且不离开驾驶舱
- 回归：三路关闭新守卫下"下滑"三次存活；askSeed（目标→AI分析）链路正常

## P2-b 三座语境桥

| 桥 | 实现 | 实弹 |
|---|---|---|
| B1 概览·目标进度→目标管理 | HealthPanel 目标块头行「查看目标 →」→ App setView("targets") | ✓ 落地目标页 |
| B2 事件→区域地图 | EventCenterPage 附取 region-map，regionEvents **销售足迹反查**（禁标题模糊）；`regions.length===1` 才出「区域视角」；App regionFocus 一次性聚焦（不上提 selectedRegion） | **诚实 dormant**：当前 6 个关联事件全部跨 ≥4 区足迹（BU 级=7 区）→ 零链接=裁定的正确行为；单区足迹中心事件出现自然激活 |
| B3 target_gap→目标管理 | 行内「看目标」，仅 event_type 门控（不造目标筛选语义） | ✓ 1 链接落地 |

B4（donut 点击筛选）不做；C1（AI 会话标题"新会话"）按裁定暂缓。review PASS×2；P2-b finding 1（三桥 handler 键盘路径漏关 overlay）已修（c2f60b1）。

## 闭环复审（对照审计矩阵）

| 原断点 | 现状 |
|---|---|
| A1 事件中心往返丢筛选/排序 | ✅ 修复（实弹） |
| A2 区域地图往返丢选中/指标 | ✅ 修复（实弹） |
| B1/B3 桥 | ✅ 建成（实弹） |
| B2 桥 | ✅ 建成（数据门控 dormant，诚实） |
| C1/C2/C3 | 按裁定维持 |

**闭环叙事成立**：晨报发现 → 点入理解（overlay 不丢上下文）→ 跳区域/目标看结构 → AI 深挖（三入口）→ ESC/返回带原语境回列表继续下一条。

## 沉淀

- **overlay 保态的最小正确解**：不切 view + fixed 覆盖，零状态上提；`key={id}` 处理嵌套换事件
- **history 三角**：push-on-boolean / popstate-关 / close-消费，**消费必须守卫 `openEventId && state 标记`**（刷新后 state 存活而 React 态归零——stale 标记会让无条件 back() 幽灵整页刷新）
- **playwright click 会自动滚动污染滚动保持测量**——保态断言用 `element.click()`（DOM API）
- **D-r5 销售足迹关联的桥接后果**：中心普遍跨区销售 → 唯一大区事件稀少 → B2 链接天然稀疏（诚实>覆盖）

## 取证

截图 `D:\dataplat-ui\screenshots-p0\p2\`（3宽度×8视图 + overlay 态）；探针 `scripts/p0/p2a-accept*.mjs`（六条验收）、`p2a-regress2.mjs`（三路关闭保态）、`p2b-audit.mjs`（三桥）。生产已随 build 生效。
