# 经营事件中心（Event Center）v1 设计 spec

| 项 | 内容 |
|---|---|
| 状态 | v1.0（2026-09-30 用户九条调整裁定回填完毕，待放行进计划） |
| 来源 | 用户原型图 `经营事件中心管理页.png`（仓根）+ 2026-09-30 对话九条数据语义裁定 |
| 上游 | `2026-09-23-ai-business-assistant-v1-design.md`（v1.2.4）/ `2026-09-30-insight-cockpit-v11-design.md`（v1.0.2） |
| 并行关系 | M-i4 灰度继续；M-i5 已上线。本迭代代号 **M-i6**，纯展示层+只读 API 扩展 |

## 1. 范围

**做**：经营事件中心独立页（侧栏新入口）——5 统计卡 / 筛选工具栏 / 事件表（11 列）/ 右侧三图卡（趋势/类型分布/生命周期分布）/ 底部近期动态；insight-api 事件列表端点扩展 `state=all` 并**服务端返回全部统计口径**。

**不做**（裁定 1/9 + 既有红线）：
- 事件类型仅 4 型（销售下滑/毛利下降/应收风险/目标缺口）——无 detector/数据源的类型（生产运行/成本波动/订单交付/市场推广/库存管理）不造
- 侧栏不露未实现页面（目标管理/区域作战地图/应收/SKU/系统设置）；全局搜索/通知铃铛不做
- engine-gateway / skills / 既有 chat 链路**零改动**；followup 复用既有编排（裁定 8），不建第二套分析逻辑

## 2. 数据语义（裁定 2/5——三概念分立，不得混用）

| 概念 | 枚举 | 展示位置 |
|---|---|---|
| **事件生命周期** `lifecycle` | `active`=进行中 / `resolved`=已解除 | 表"事件状态"列 + 生命周期环图（两段）+ 筛选器 |
| **AI 分析状态** `attribution_status` | `pending`=待分析 / `running`=分析中 / `done`=分析完成 / `degraded`=降级完成 / `failed`=分析失败 | 表"AI 分析状态"列 + 筛选器。**不进环图、不与生命周期合并** |
| **晚到** `late` | 布尔（该事件任一 detector_finding `is_late=1`，按 event_key 匹配派生） | 标题旁 Badge"晚到"+ 筛选开关。**不进任何状态枚举** |

## 3. API 契约（裁定 6——统计口径全在服务端，前端只展示）

`GET /api/insight/events?state=all`（BFF 既有代理透传，零改动）

```json
{
  "asOf": "2026-09-30",
  "summary": {
    "total":     {"count": 5, "prevCount": 0, "delta": null},
    "major":     {"count": 0, "prevCount": 0, "delta": null},
    "minor":     {"count": 5, "prevCount": 0, "delta": null},
    "targetGap": {"count": 1, "prevCount": 0, "delta": null},
    "resolved":  {"count": 0, "prevCount": 0, "delta": null}
  },
  "trend": { "days": 30, "points": [
      {"date": "2026-09-28", "total": 5, "major": 0, "minor": 5} ] },
  "eventTypeDistribution": [
      {"key": "sales_decline", "label": "销售下滑", "count": 3},
      {"key": "ar_overdue",    "label": "应收风险", "count": 1},
      {"key": "target_gap",    "label": "目标缺口", "count": 1} ],
  "lifecycleDistribution": [
      {"key": "active",   "label": "进行中", "count": 5},
      {"key": "resolved", "label": "已解除", "count": 0} ],
  "events": [ { "event_id": "ev-…", "title": "…", "summary": "…",
      "severity": "minor", "event_type": "sales_decline", "detector": "region_sales",
      "org": "粤东运营中心", "channel": "GD03",
      "facts": [{"label":"…","value":"…"}],
      "first_seen_date": "2026-09-28", "last_seen_date": "2026-09-29",
      "persist_days": 2, "score": 50.7,
      "lifecycle": "active", "resolved_at": null,
      "attribution_status": "pending", "late": false,
      "publishedToday": false, "rankToday": null, "scoreGap": -4.3 } ]
}
```

### 口径定义（服务端唯一权威）

- **统计卡**（裁定 3/7）：`total/major/minor/targetGap` 按 `first_seen_date` **近 30 天新发**；`resolved` 按 `resolved_at` 近 30 天解除。`prevCount`=前 30 天同口径；`delta`：
  - 前 30 天为 0 → `delta: null`（前端显示"—"，不造百分比）
  - 否则 `delta = round((count - prevCount) / prevCount * 100)`（整数百分比，正负号由前端上色）
  - 注意：count 本身可以为 0（近 30 天无新发）——0 也如实显示
- **trend**：近 30 天逐日**新发**（first_seen_date 聚合），total/major/minor 三线；无新发的日期补零点（完整 30 点序列）
- **eventTypeDistribution / lifecycleDistribution**：**全量事件**（不限窗口，365 天留存全库），中心数=全量总数
- **events 列表**：全量按 `first_seen_date` 降序，硬上限 500 行（超出截断并在响应附 `"truncated": true`）；v1 筛选/分页在客户端（量级几十行），服务端筛选分页留后续版本
- `late` 派生：本事件任一 finding（按 event_key 匹配，同 `_event_detail` evidence 语义）`is_late=1`
- `org/channel`：解析 `scope_json` 的组织节点/渠道；解析失败为 null 不炸
- `publishedToday/rankToday/scoreGap`：与既有 `state=active` 响应同义（对最新 brief_date）
- `state=active` 既有响应**保持不变**（首页观察中分区消费，M-i5 契约冻结）

## 4. 页面结构（裁定 3/4/5）

```
经营事件中心
├─ 标题行：经营事件中心 ｜ 查看全部经营事件、状态与进展 ｜ 数据日 {asOf}
├─ 5 统计卡：全部事件/重大异常/一般异常/目标偏差/已解除（各带较上期 delta 或 "—"）
├─ 筛选工具栏：搜索（标题/组织/渠道/事件类型文案）｜日期范围（首次发现）｜
│              严重程度｜事件类型｜事件状态｜AI分析状态｜区域(组织节点)｜仅晚到开关
├─ 主体两栏：
│  ├─ 左（flex-1）：事件表（# / 事件标题[+晚到Badge] / 严重度 / 事件类型 / 影响范围 /
│  │               关键事实(首条) / 首次发现 / 持续天数 / 事件状态 / AI分析状态 /
│  │               操作[查看详情|继续分析]）
│  │   └─ 底部：近期事件动态（复用 BusinessEventTimeline）
│  └─ 右（w-96）：三图卡——事件趋势(近30天三线) / 事件类型分布(环,4型) /
│                 事件生命周期分布(环,进行中/已解除)
└─ 空态：无事件 → "暂无经营事件"（不凑数）
```

- 图表纯 SVG（MiniTrendChart/HealthPanel 同路线，新 mini 组件：多线趋势/两环图）
- 颜色纪律沿用：蓝主操作、红=重大/负向、橙=一般/晚到 Badge、绿=已解除正向
- "继续分析"：调既有 `POST /api/insight/events/:id/followup`（默认分析意图）→ App 既有 onFollowed 链路跳 chat——与详情页同一编排
- 侧栏：`经营事件中心` 入口插在"AI经营驾驶舱"旁（flag 门禁同 insights）；今日关注页底部既有事件时间线**保持不动**

## 5. 实现面（全部 additive）

| 层 | 改动 |
|---|---|
| insight-api | `_active_events` 旁新增 `_event_center(db)`（聚合+全量列表）；路由 `state=all` 分支；`state=active` 分支与响应冻结不动 |
| BFF | **零改动**（/api/insight/events 代理已透传任意 query）；仅补测试断言 state=all 透传 |
| web | types（EventCenterPayload 族）+ api 函数 + `EventCenterPage` 新页 + App 视图 `events` + Sidebar 入口 + 右栏三 mini 图组件 + 复用 BusinessEventTimeline/BusinessEventCard 色系 |

## 6. 测试

1. `_event_center`：多事件 fixture 断言 summary 窗口语义（近30/前30/分母0→null）、trend 补零点、分布全量口径、late 派生、org/channel 解析、500 截断标记
2. 路由：state=all 200 / state=active 响应字节不变（契约冻结回归）/ 未知 state 400
3. BFF：state=all 经代理透传（含 query）
4. web build 零错误；server 全量测试绿；insight 全量测试绿；eval 零影响（不碰 eval）
5. 生产冒烟：真实库 state=all 与 UI 数字对得上（抽 3 个数）

## 7. 决策记录

| # | 裁定（用户 2026-09-30） |
|---|---|
| D-e1 | 事件类型只做 4 型真实能力，无数据源不造 |
| D-e2 | lifecycle / attribution_status / is_late 三概念分立：两个独立表列+各自筛选，is_late 仅 Badge |
| D-e3 | 统计卡=全部/重大/一般/目标偏差/已解除；不做"观察中"（观察中仍只在今日关注页） |
| D-e4 | 环图只做生命周期两段；AI 分析状态不进环图 |
| D-e5 | 统计口径（summary/trend/distribution）服务端返回，前端只展示不计算 |
| D-e6 | "较上期"：新发按 first_seen_date、解除按 resolved_at、近30 vs 前30、分母 0 → "—" |
| D-e7 | followup 复用既有链路；侧栏只露已实现页面 |
