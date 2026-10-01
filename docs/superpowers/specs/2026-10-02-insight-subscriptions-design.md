# 经营关注与通知中心 v1 设计 spec

| 项 | 内容 |
|---|---|
| 状态 | 原型已确认，待实施 |
| 范围 | 事件、区域/组织、业务域、指标关注；匹配事件；通知中心 |
| 原则 | 旁路增量，不改变现有问数逻辑、skill、检测、排序、归因或既有 API |

## 1. 用户体验

新增“我的关注”页面，延续驾驶舱视觉语言，包含：

- 新增关注：事件、区域/组织、业务域、指标
- 已关注列表：启用/停用、类型、名称、创建时间
- 关注动态：新事件、严重程度升级、事件解除
- 未读数量与“全部标为已读”
- 关注匹配概览

右上角通知铃铛可复用同一通知数据源，首期页面内展示通知列表；不改现有 AI 问数页面。

## 2. 数据模型

新增独立 SQLite 表，不修改 `business_event` 及问数任务表。

### `insight_subscription`

```text
id TEXT PRIMARY KEY
user_id TEXT NOT NULL
kind TEXT NOT NULL              -- event | region | domain | metric
value TEXT NOT NULL
label TEXT NOT NULL
enabled INTEGER NOT NULL DEFAULT 1
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
UNIQUE(user_id, kind, value)
```

### `insight_notification`

```text
id TEXT PRIMARY KEY
user_id TEXT NOT NULL
event_id TEXT
kind TEXT NOT NULL              -- created | escalated | resolved
title TEXT NOT NULL
summary TEXT NOT NULL
severity TEXT
created_at TEXT NOT NULL
read_at TEXT
UNIQUE(user_id, event_id, kind)
```

通知是用户视角的投递记录，事件仍是唯一事实源。通知生成失败不得阻塞事件落库。

## 3. 匹配规则

- `event`：`value == business_event.event_id`
- `region`：匹配事件 `scope_json` 中的组织节点
- `domain`：匹配事件 `event_type` 对应的业务域映射
- `metric`：首期匹配已有事件类型/指标键，不创建第二套指标字典

匹配接口只读现有事件数据与用户关注记录，不重新执行 DWS 查询，不调用 LLM。

## 4. API

统一新增 `/api/insight/*` 路由，用户身份使用现有可信身份上下文。

```text
GET    /api/insight/subscriptions
POST   /api/insight/subscriptions
DELETE /api/insight/subscriptions/:id
GET    /api/insight/subscriptions/matches
GET    /api/insight/notifications
POST   /api/insight/notifications/:id/read
POST   /api/insight/notifications/read-all
```

创建请求：

```json
{"kind":"region","value":"华南运营中心","label":"华南运营中心"}
```

约束：

- `kind` 必须为四种枚举之一
- `value` 非空且长度受限
- 同一用户重复关注返回幂等成功或明确冲突，不产生重复记录
- 删除/停用只能影响当前用户自己的记录
- 无效事件/区域/业务域/指标返回 400
- 通知列表支持 `unread_only` 和分页参数

## 5. 事件生命周期与通知

关注系统不改变这些现有状态：

- 事件生命周期 `active/resolved`
- AI 分析状态 `pending/running/done/degraded/failed`
- 检测阈值、排序权重、归因结果

新增事件通知触发点挂在已有事件写入之后；升级、解除由已有事件前后状态差异产生。通知写入采用幂等键 `(user_id, event_id, kind)`。通知生成异常仅记录日志，不影响事件流水线。

## 6. 隔离与开关

- `engine-gateway/`：零改动
- `skills/`：零改动
- 既有问数、SSE、报告 API：零改动
- 既有事件 API 响应：零改动
- 新页面与新路由使用独立 feature flag
- 新增表与现有事件表分离
- 所有新查询使用参数化 SQL 和用户过滤

## 7. 测试与验收

必须覆盖：

1. 四种关注类型的创建、查询、停用、删除
2. 重复关注幂等与非法对象校验
3. 用户隔离
4. 事件/区域/业务域/指标匹配
5. 新建、升级、解除三类通知的幂等生成
6. 未读、单条已读、全部已读
7. 现有 insight API 回归
8. `engine-gateway`、skills 和现有问数评测零改动/零退化

原型文件：`关注中心原型.html`。原型交互不连接真实 API，仅用于确认信息架构和视觉方向。

