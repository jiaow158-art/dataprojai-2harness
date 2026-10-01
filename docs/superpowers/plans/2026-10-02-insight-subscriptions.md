# 经营关注与通知中心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变现有问数、skill、事件检测和既有 API 的前提下，新增事件/区域/业务域/指标关注与通知中心。

**Architecture:** 在 insight 旁路增加关注与通知存储、服务端匹配和 additive API；事件流水线仅以幂等 side effect 形式投递通知，失败不影响事件落库。前端新增 feature-flag 门控的“我的关注”页面，复用现有事件展示与可信用户上下文。

**Tech Stack:** Python stdlib HTTP API、SQLite、现有 insight.db、现有 dataplat-ui React/TypeScript、pytest、Node 测试。

---

### Task 1: 关注与通知数据层

**Files:**
- Modify: `insight/db.py`
- Create: `insight/subscriptions.py`
- Test: `insight/tests/test_subscriptions.py`

- [ ] **Step 1: Write failing tests** for table creation, four kinds, uniqueness, user isolation, enable/disable, and notification idempotency.
- [ ] **Step 2: Run** `python -m pytest insight/tests/test_subscriptions.py -q`; expect failures because the repository functions do not exist.
- [ ] **Step 3: Implement** SQLite schema/helpers with parameterized SQL and no changes to existing event tables.
- [ ] **Step 4: Run** the focused test and then `python -m pytest insight/tests -q`.
- [ ] **Step 5: Commit** `feat(insight): add isolated subscription and notification store`.

### Task 2: Subscription and notification API

**Files:**
- Modify: `insight/api_main.py`
- Test: `insight/tests/test_api.py`

- [ ] **Step 1: Add failing HTTP tests** for list/create/delete/matches, notification list/read/read-all, invalid kind, duplicate subscription, and cross-user isolation.
- [ ] **Step 2: Run** focused tests and verify expected route/behavior failures.
- [ ] **Step 3: Add only `/api/insight/subscriptions*` and `/api/insight/notifications*` routes; preserve every existing branch and response.
- [ ] **Step 4: Run** `python -m pytest insight/tests/test_api.py -q` and `python -m pytest insight/tests -q`.
- [ ] **Step 5: Commit** `feat(insight): expose subscription and notification APIs`.

### Task 3: Event matching and notification side effect

**Files:**
- Create: `insight/subscription_dispatch.py`
- Modify: the existing event persistence integration point only
- Test: `insight/tests/test_subscription_dispatch.py`

- [ ] **Step 1: Write failing tests** for event, region, domain, and metric matches; created/escalated/resolved notifications; idempotent reruns; and notification failure isolation.
- [ ] **Step 2: Run** the focused tests and confirm they fail for missing dispatcher behavior.
- [ ] **Step 3: Implement** pure matching plus a bounded notification writer; map domain/metric only to existing event types; never call DWS or LLM.
- [ ] **Step 4: Attach the dispatcher after existing event write/freeze succeeds, catching/logging errors without changing event status.
- [ ] **Step 5: Run** insight regression tests and the existing event pipeline tests.
- [ ] **Step 6: Commit** `feat(insight): dispatch subscription notifications from events`.

### Task 4: BFF additive proxy and feature flag

**Files:**
- Modify: `dataplat-ui/server/src/insight.ts`
- Modify: existing UI feature-flag module
- Test: `dataplat-ui/server/test/insight.test.ts`

- [ ] **Step 1: Add failing proxy tests** for all new GET/POST/DELETE routes and flag-off behavior.
- [ ] **Step 2: Run** the focused Node test and confirm failures.
- [ ] **Step 3: Add transparent proxy handlers; do not transform existing insight payloads.
- [ ] **Step 4: Gate the new page and routes with the existing insight flag mechanism.
- [ ] **Step 5: Run** server tests and TypeScript build.
- [ ] **Step 6: Commit** `feat(ui): proxy insight subscriptions and notifications`.

### Task 5: 我的关注页面

**Files:**
- Create: `dataplat-ui/web/src/components/insights/MySubscriptionsPage.tsx`
- Create: `dataplat-ui/web/src/components/insights/SubscriptionTypes.ts`
- Modify: existing app view registry and `Sidebar.tsx`
- Test: existing web test location for insight views

- [ ] **Step 1: Add failing component tests** for four-type creation, toggle, notification unread count, read-all, and flag-off absence.
- [ ] **Step 2: Run focused web tests and confirm failures.
- [ ] **Step 3: Implement the confirmed prototype layout using real API calls and loading/error/empty states.
- [ ] **Step 4: Preserve existing dashboard, event center, and AI问数 routes.
- [ ] **Step 5: Run web tests and build; manually smoke-test desktop and narrow viewport.
- [ ] **Step 6: Commit** `feat(ui): add my subscriptions and notification center`.

### Task 6: Full regression and isolation proof

**Files:**
- Modify: no production files unless test fixes are required
- Test: existing insight, eval, gateway, and UI suites

- [ ] **Step 1: Run** `python -m pytest insight/ eval/ -q`.
- [ ] **Step 2: Run** `cd engine-gateway; npm test`.
- [ ] **Step 3: Run** the dataplat-ui server/web tests and build.
- [ ] **Step 4: Verify** `git diff -- engine-gateway skills` is empty and existing insight endpoint snapshots are unchanged.
- [ ] **Step 5: Run** the 85-scenario evaluation when environment credentials are available; record result without changing thresholds or skills.
- [ ] **Step 6: Commit** `test: verify subscriptions are isolated from query path`.

