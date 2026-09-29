# AI 经营助手 v1 · M-i3 BFF 与驾驶舱 UI 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 M-i2 的 insight-api 变成产品——BFF 代理路由 + flag 灰度门禁 + followup 种子问题编排 + 前端驾驶舱两页（15 组件），现有 chat/管理零逻辑改动。

**Architecture:** 代码全部在 **`D:\dataplat-ui` 仓**执行（计划文档在本仓）；BFF 新增 `insight.ts` 路由模块（flag 门禁 + HTTP 代理 :58095，BFF 永不直读 insight.db——D6）；followup 审计落 BFF 记账库新表 `followup_log`（v1.2.4 勘误：原 spec §6.1 的 followup_session 表移 BFF 侧——UI 域便利数据归 BFF，对齐"任务/事件事实源在网关/insight"分工注释）；前端 view 状态加 `"insights"`（与 admin 同模式，无路由库）。

**Tech Stack:** BFF Node 24 TS strip + express + better-sqlite3（既有）；前端 React+Vite+TS+Tailwind（既有）；测试 `node --test test/*.test.ts`（既有 73 绿）。前端无测试框架——前端验证 = `npm run build` 零错误 + 人工 smoke 清单（诚实声明，不造假测试）。

**Spec:** `docs/superpowers/specs/2026-09-23-ai-business-assistant-v1-design.md` v1.2.3（§5.2/§11.2/§12/§13）；M-i1/M-i2 已关门。

---

## 前置事实（工程师必读，全部今日实码核对）

1. **执行仓**：所有代码提交在 `D:\dataplat-ui`（BFF=server/，前端=web/）；计划文档在 `D:\dataprojai-2harness`。两仓提交均路径限定。
2. **BFF 现状**：`createApp(store: BffStore, config: BffConfig)`（app.ts:113）；会话门禁 `app.use("/api", ...)`（app.ts:127）注入 `req.user`——**门禁后挂载的路由免费获得身份**；`BffConfig` 现有 gatewayUrl/authToken/reportsDir/staticDir/gwDbPath/harnessDir（加 `insightUrl?: string`）；错误唯一出口 `sendError(res, status, code, message)`（code 封闭集字面量）。index.ts env 接线在 :24-33。
3. **测试脚手架**（server/test/helpers.ts）：`startBff({gatewayUrl, reportsDir, staticDir, gwDbPath, harnessDir})`（本计划加 `insightUrl`）临时库+真监听端口；`request(port, method, path, {body, cookie})`；`login(port, user, pw)`；**`startMockGateway(handler)` 可直接当 mock insight-api 用**（捕获请求+可换行为）；`GATEWAY_TOKEN` 常量。跑法 `cd server && npm test`（node --test）。
4. **insight-api 契约**（M-i2 `api_main.py` 实码）：
   - `GET /api/insight/daily[?date=]` → `{briefDate, scope, dataFreshness:{overall:"ready|partial|not_ready", radars:[{detector,ready,detail}]}, eventCount, stale, events:[{eventId,eventKey,lifecycle,persistDays,title,summary,severity,eventType,metric,scope,period,facts:[{label,value}],score,status,createdAt}]}`
   - `GET /api/insight/events/:id` → `{event:{event_id,event_key,lifecycle,data_date,first_seen_date,persist_days,detector,event_type,title,summary,severity,scope_json,facts_json,score,status}, executiveSummary, facts, attribution:{status:"pending|done|degraded|failed",analysisId,summary,path:[{level,contribution}],findings:[{text,evidence}],waterfall:[{name,value}],entities:[{name,type,delta}],runId,reportPath}, evidence:[{finding_id,detector,metrics,norm_score,is_late}], suggestedActions:[], followupPrompts:[...]}`
   - `GET /api/insight/timeline?days=30` → `[{eventId,title,severity,dataDate,createdAt}]`；`GET /api/insight/health` → `{ok,...}`
5. **前端现状**：App.tsx view 状态 `"chat"|"admin"`（本计划加 `"insights"`）；Sidebar props 含 `isAdmin/onAdmin`（本计划加 `insightsEnabled/onInsights`）；ChatView props `{sessionId, sessionTitle, onFirstAsk, onSessionActivity}`，发送走 `apiAsk(question, sessionId ?? undefined)`（本计划加可选 `autoAsk`/`onAutoAskDone` 增量 props）；api.ts 模式 `api<T>(method, path, body?)` + `ApiError{status,code,message}`；admin 页面模式=components/admin/ 下每页一文件。**前端 Tailwind 类名风格直书**。
6. **视觉裁定**（spec §12.4）：白/浅灰/极浅蓝底（bg-slate-50/bg-white）、蓝色主操作（blue-600）、红橙只用于真异常（red-600=major/orange-500=minor）、大量留白、卡片 rounded-xl；禁深色大屏风。severity→色：major=red、minor=orange、target_gap 类型=blue。
7. **范围裁定**：目标管理/区域经营/应收风险/SKU效益 导航项 v1 占位禁用（"后续版本"）；TrendPanel v1 占位禁用（趋势序列 API 未建，M-i2 未含——下版本接 detector 时间序列）；admin 深色主题不动，insights 页面**浅色系**（用户裁定视觉）。
8. **红线**：现有 chat/SSE/报告/管理路由零逻辑改动（装配级追加除外）；BFF 不 import better-sqlite3 读 insight.db；浏览器无 token 概念；两仓提交路径限定；insight 不可达时错误码封闭集 `503 INSIGHT_UNAVAILABLE`。

## File Structure（D:\dataplat-ui 仓改动全集）

```
server/
├─ src/insight.ts            # 新：flag 门禁 + insight-api 代理 + followup 编排（express.Router）
├─ src/insight-flag-cli.ts    # 新：flag 管理 CLI（node src/insight-flag-cli.ts list|on|off <user>）
├─ src/app.ts                 # 改：BffConfig+insightUrl、import、app.use 挂载（≈5 行装配）
├─ src/index.ts               # 改：INSIGHT_URL env（1 行）
├─ src/schema.sql             # 改：尾部追加 user_flags / followup_log 两表
├─ src/db.ts                  # 改：BffStore 增 insightEnabled/getFlag/setFlag/createUiSessionByTitle?/
│                             #    insertFollowup 方法（复用既有 ui_sessions 建会话方法——见 T3）
├─ test/helpers.ts            # 改：startBff 增 insightUrl opt（1 行）
├─ test/insight.test.ts       # 新
├─ test/insight-followup.test.ts # 新
└─ test/insight-flag-cli.test.ts # 新
web/src/
├─ types.ts                   # 改：尾部追加 Insight* 类型
├─ api.ts                     # 改：尾部追加 6 个 insight 函数
├─ App.tsx                    # 改：view 加 insights、boot 探测 enabled、followup 状态、ChatView autoAsk（≈25 行）
├─ components/Sidebar.tsx     # 改：insights 入口（flag 开才渲染，≈8 行）
├─ components/ChatView.tsx    # 改：autoAsk 可选 prop（≈10 行）
└─ components/insights/       # 新：15 组件（T7 六个 + T8 九个）
```

---

### Task 1: BFF 数据层——user_flags 与 followup_log

**执行目录 `D:\dataplat-ui`。Files:** Modify `server/src/schema.sql`（尾部追加）、`server/src/db.ts`（BffStore 增方法）；Test `server/test/insight.test.ts`（新建，本任务先写数据层部分）

- [ ] **Step 1: 写失败测试**

```typescript
// server/test/insight.test.ts（Task 1 部分）
import { test } from "node:test";
import assert from "node:assert/strict";
import { startBff, hashPw } from "./helpers.ts";

test("user_flags 默认关闭，setFlag 幂等切换", async () => {
  const bff = await startBff();
  try {
    bff.store.upsertUser("u1", hashPw("pw"));
    assert.equal(bff.store.insightEnabled("u1"), false);      // 默认关
    bff.store.setFlag("u1", "insight_cockpit", true);
    assert.equal(bff.store.insightEnabled("u1"), true);
    bff.store.setFlag("u1", "insight_cockpit", true);          // 幂等
    assert.equal(bff.store.insightEnabled("u1"), true);
    bff.store.setFlag("u1", "insight_cockpit", false);
    assert.equal(bff.store.insightEnabled("u1"), false);
    assert.equal(bff.store.insightEnabled("nobody"), false);   // 未知用户=关
  } finally {
    await bff.close();
  }
});

test("followup_log 审计行写入并可查", async () => {
  const bff = await startBff();
  try {
    bff.store.upsertUser("u1", hashPw("pw"));
    bff.store.insertFollowup("fu-1", "u1", "ev-1", "us-1", "为什么下降？");
    const rows = bff.store.db
      .prepare("SELECT * FROM followup_log WHERE username=?")
      .all("u1") as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event_id, "ev-1");
    assert.equal(rows[0].ui_session_id, "us-1");
  } finally {
    await bff.close();
  }
});
```

（`upsertUser` 若 BffStore 现有名不同——以 db.ts 实际用户创建方法为准，报告并等价替换。）

- [ ] **Step 2: 确认失败** `cd server && npm test -- test/insight.test.ts` → FAIL（insightEnabled/setFlag/insertFollowup 不存在）

- [ ] **Step 3: 实现**

schema.sql 尾部追加：

```sql
CREATE TABLE IF NOT EXISTS user_flags (   -- M-i3 insight 灰度（spec §13）：flag 只控入口，不做数据权限
  username TEXT NOT NULL,
  flag TEXT NOT NULL,                     -- 'insight_cockpit'
  enabled INTEGER NOT NULL DEFAULT 0,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (username, flag)
);
CREATE TABLE IF NOT EXISTS followup_log ( -- 事件追问审计（v1.2.4：落 BFF 记账库，不进 insight.db）
  id TEXT PRIMARY KEY,                    -- fu-<uuid>
  username TEXT NOT NULL,                 -- 追问人（会话身份）
  event_id TEXT NOT NULL,                 -- insight 事件
  ui_session_id TEXT NOT NULL,            -- 种子会话
  prompt TEXT,                            -- 用户自定义意图（可空=默认分析）
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_followup_event ON followup_log(event_id, created_at);
```

db.ts BffStore 追加（对齐类内既有 prepare 风格）：

```typescript
  // ── M-i3 insight 灰度与追问审计 ──────────────────────────────────────────────

  private stmtSetFlag = this.db.prepare(
    `INSERT INTO user_flags (username, flag, enabled, granted_at) VALUES (?, 'insight_cockpit', ?, ?)
     ON CONFLICT (username, flag) DO UPDATE SET enabled=excluded.enabled, granted_at=excluded.granted_at`,
  );
  private stmtGetFlag = this.db.prepare(
    "SELECT enabled FROM user_flags WHERE username=? AND flag='insight_cockpit'",
  );

  insightEnabled(username: string): boolean {
    const row = this.stmtGetFlag.get(username) as { enabled: number } | undefined;
    return row?.enabled === 1;
  }

  setFlag(username: string, flag: string, enabled: boolean): void {
    if (flag !== "insight_cockpit") throw new Error(`unknown flag: ${flag}`);
    this.stmtSetFlag.run(username, enabled ? 1 : 0, Date.now());
  }

  insertFollowup(id: string, username: string, eventId: string, uiSessionId: string, prompt: string | null): void {
    this.db.prepare(
      "INSERT INTO followup_log (id, username, event_id, ui_session_id, prompt, created_at) VALUES (?,?,?,?,?,?)",
    ).run(id, username, eventId, uiSessionId, prompt, Date.now());
  }
```

（私有 prepare 若与类风格不符——若 BffStore 方法内联 prepare，则改为方法内 prepare，语义不变，报告即可。）

- [ ] **Step 4: 确认通过** → 2 PASS；全套 `npm test` 既有 73 + 2 全绿
- [ ] **Step 5: Commit**（在 D:\dataplat-ui！）
```bash
git add server/src/schema.sql server/src/db.ts server/test/insight.test.ts
git commit -m "feat(bff): user_flags灰度表+followup_log追问审计表——insightEnabled/setFlag/insertFollowup" -- server/src/schema.sql server/src/db.ts server/test/insight.test.ts
```

---

### Task 2: BFF insight.ts——flag 门禁与 insight-api 代理

**Files:** Create `server/src/insight.ts`；Test `server/test/insight.test.ts`（追加）；Modify `server/test/helpers.ts`（startBff 加 insightUrl opt）、`server/src/app.ts`（装配）、`server/src/index.ts`（env）

- [ ] **Step 1: 写失败测试（追加）**

```typescript
// server/test/insight.test.ts（追加）
import { startMockGateway } from "./helpers.ts";
import http from "node:http";

test("enabled/daily/events/timeline 代理与 flag 门禁", async (t) => {
  const insight = await startMockGateway((req, res) => {
    if (req.url === "/api/insight/daily") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ briefDate: "2026-09-29", eventCount: 1, events: [], dataFreshness: { overall: "ready", radars: [] }, stale: false, scope: "瓷砖事业部" }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "NOT_FOUND" }));
  });
  const bff = await startBff({ insightUrl: insight.url });
  try {
    bff.store.upsertUser("u1", hashPw("pw"));
    const li = await login(bff.port, "u1", "pw");

    await t.test("未开 flag → 全部 403 FLAG_OFF", async () => {
      const r = await request(bff.port, "GET", "/api/insight/daily", { cookie: li.sid });
      assert.equal(r.status, 403);
      assert.equal(r.body.error.code, "FLAG_OFF");
      const e = await request(bff.port, "GET", "/api/insight/enabled", { cookie: li.sid });
      assert.equal(e.status, 200);
      assert.deepEqual(e.body, { enabled: false });     // enabled 端点不受 flag 门禁
    });

    await t.test("开 flag → daily 代理透传", async () => {
      bff.store.setFlag("u1", "insight_cockpit", true);
      const r = await request(bff.port, "GET", "/api/insight/daily", { cookie: li.sid });
      assert.equal(r.status, 200);
      assert.equal(r.body.briefDate, "2026-09-29");
      assert.ok(insight.requests.some((q) => q.url === "/api/insight/daily"));
    });

    await t.test("insight 不可达 → 503 INSIGHT_UNAVAILABLE", async () => {
      const dead = await startBff({ insightUrl: "http://127.0.0.1:1" });
      try {
        dead.store.upsertUser("u2", hashPw("pw"));
        dead.store.setFlag("u2", "insight_cockpit", true);
        const l2 = await login(dead.port, "u2", "pw");
        const r = await request(dead.port, "GET", "/api/insight/daily", { cookie: l2.sid });
        assert.equal(r.status, 503);
        assert.equal(r.body.error.code, "INSIGHT_UNAVAILABLE");
      } finally {
        await dead.close();
      }
    });
  } finally {
    await bff.close();
    await insight.close();
  }
});
```

- [ ] **Step 2: 确认失败** → FAIL（/api/insight/* 404）

- [ ] **Step 3: 实现**

```typescript
// server/src/insight.ts
// M-i3 insight 路由（spec §11.2/§13）：flag 门禁（只控入口不做数据权限）+ insight-api 只读代理
// （D6：BFF 不直读 insight.db，只走 HTTP）+ followup 种子编排。
// insight 不可达 → 503 INSIGHT_UNAVAILABLE 封闭集；未开 flag → 403 FLAG_OFF（enabled 端点除外）。
import { Router, type Request, type Response, type NextFunction } from "express";
import { request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import type { BffStore } from "./db.ts";

const INSIGHT_TIMEOUT_MS = 5000;

function insightFetch(base: string, path: string): Promise<{ status: number; body: string }> {
  const u = new URL(base + path);
  return new Promise((resolve, reject) => {
    const rq = httpRequest(
      { hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: "GET", timeout: INSIGHT_TIMEOUT_MS },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    rq.on("timeout", () => rq.destroy(new Error("insight timeout")));
    rq.on("error", reject);
    rq.end();
  });
}

export function insightRouter(store: BffStore, insightUrl: string | undefined): Router {
  const r = Router();

  const gate = (req: Request, res: Response, next: NextFunction) => {
    if (!store.insightEnabled(req.user!)) {
      return res.status(403).json({ error: { code: "FLAG_OFF", message: "insight cockpit not enabled for this account" } });
    }
    next();
  };

  const proxy = async (res: Response, path: string) => {
    if (!insightUrl) return res.status(503).json({ error: { code: "INSIGHT_UNAVAILABLE", message: "INSIGHT_URL unset" } });
    try {
      const up = await insightFetch(insightUrl, path);
      res.status(up.status).type("json").send(up.body);
    } catch {
      res.status(503).json({ error: { code: "INSIGHT_UNAVAILABLE", message: "insight api unreachable" } });
    }
  };

  r.get("/enabled", (req, res) => {
    res.json({ enabled: store.insightEnabled(req.user!) });
  });
  r.get("/daily", gate, (req, res) => void proxy(res, `/api/insight/daily${req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""}`));
  r.get("/events/:id", gate, (req, res) => void proxy(res, `/api/insight/events/${encodeURIComponent(req.params.id)}`));
  r.get("/timeline", gate, (req, res) => void proxy(res, `/api/insight/timeline${req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""}`));

  // followup（Task 3 实现体，本任务先占 501 由 T3 替换——不，不留占位：T2/T3 同 PR 内完成，见 T3）
  r.post("/events/:id/followup", gate, async (req, res) => {
    void req; void res; // Task 3 填充
  });
  return r;
}
```

⚠️ 上面 followup 故意不完整——**Task 2 与 Task 3 在执行时作为一个连续单元**：T2 实现到 gate+proxy+enabled+daily+events+timeline（**不写 followup 路由**），T3 紧接着在同一文件补 followup。T2 的最终代码**不包含**上面最后 3 行 followup 占位（占位违反本计划 No-Placeholder 纪律，此处仅示意挂载顺序）。

app.ts 装配（门禁之后，与既有路由段并列，≈4 行）：

```typescript
import { insightRouter } from "./insight.ts";
// ……createApp 内、会话门禁 app.use("/api", ...) 之后：
  // ── M-i3 经营洞察（flag 门禁 + insight-api 代理；见 src/insight.ts）──────────────
  app.use("/api/insight", insightRouter(store, config.insightUrl));
```

BffConfig 加字段：`insightUrl?: string;`（注释：`env INSIGHT_URL，未设=insight 端点 503 INSIGHT_UNAVAILABLE`）。index.ts：`insightUrl: process.env.INSIGHT_URL || undefined,`。helpers.ts startBff opts 加 `insightUrl?: string` 并传入 createApp。

- [ ] **Step 4: 确认通过** → 本文件 5 PASS（2 数据层 + 3 代理）；全套全绿
- [ ] **Step 5: Commit**
```bash
git add server/src/insight.ts server/src/app.ts server/src/index.ts server/test/helpers.ts server/test/insight.test.ts
git commit -m "feat(bff): insight路由——flag门禁(FLAG_OFF)+insight-api只读代理(503 INSIGHT_UNAVAILABLE降级)/enabled/daily/events/timeline" -- server/src/insight.ts server/src/app.ts server/src/index.ts server/test/helpers.ts server/test/insight.test.ts
```

---

### Task 3: BFF followup——种子问题编排

**Files:** Modify `server/src/insight.ts`（补 followup 路由）；Test `server/test/insight-followup.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

```typescript
// server/test/insight-followup.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { startBff, startMockGateway, request, login, hashPw } from "./helpers.ts";

const DETAIL = {
  event: {
    event_id: "ev-1", title: "华南|GD01 业绩连续下滑", summary: "近3个完整月同比 -11.2%",
    metric: "yoy", severity: "major", scope_json: '{"范围":"瓷砖事业部","组织节点":"华南|GD01"}',
    period_json: '{"类型":"月"}', facts_json: '[{"label":"同比","value":"-11.2%"}]',
  },
  attribution: { status: "done", summary: "广东贡献 61%" },
  followupPrompts: ["为什么广东下降最明显？"],
};

test("followup 建种子会话+审计+返回种子问题", async () => {
  const insight = await startMockGateway((req, res) => {
    if (req.url === "/api/insight/events/ev-1") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(DETAIL));
      return;
    }
    res.writeHead(404).end();
  });
  const bff = await startBff({ insightUrl: insight.url });
  try {
    bff.store.upsertUser("u1", hashPw("pw"));
    bff.store.setFlag("u1", "insight_cockpit", true);
    const li = await login(bff.port, "u1", "pw");

    const r = await request(bff.port, "POST", "/api/insight/events/ev-1/followup", {
      cookie: li.sid,
      body: { prompt: "看重点门店明细" },
    });
    assert.equal(r.status, 200);
    assert.ok(r.body.uiSessionId);
    assert.ok(r.body.seedQuestion.includes("华南|GD01 业绩连续下滑"));
    assert.ok(r.body.seedQuestion.includes("看重点门店明细"));
    // 种子会话已建且标题=事件标题
    const sess = bff.store.db.prepare("SELECT * FROM ui_sessions WHERE id=?").get(r.body.uiSessionId) as Record<string, unknown>;
    assert.equal(sess.username, "u1");
    assert.equal(sess.title, "华南|GD01 业绩连续下滑");
    // 审计行
    const fu = bff.store.db.prepare("SELECT * FROM followup_log").all() as Array<Record<string, unknown>>;
    assert.equal(fu.length, 1);
    assert.equal(fu[0].event_id, "ev-1");
    assert.equal(fu[0].ui_session_id, r.body.uiSessionId);
    assert.equal(fu[0].prompt, "看重点门店明细");
  } finally {
    await bff.close();
    await insight.close();
  }
});

test("followup 无 prompt 用默认意图；事件不存在 404", async () => {
  const insight = await startMockGateway((req, res) => {
    if (req.url === "/api/insight/events/ev-1") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(DETAIL));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "NOT_FOUND" }));
  });
  const bff = await startBff({ insightUrl: insight.url });
  try {
    bff.store.upsertUser("u1", hashPw("pw"));
    bff.store.setFlag("u1", "insight_cockpit", true);
    const li = await login(bff.port, "u1", "pw");
    const r = await request(bff.port, "POST", "/api/insight/events/ev-1/followup", { cookie: li.sid, body: {} });
    assert.equal(r.status, 200);
    assert.ok(r.body.seedQuestion.includes("请基于以上事件背景做进一步分析"));
    const r404 = await request(bff.port, "POST", "/api/insight/events/ev-nope/followup", { cookie: li.sid, body: {} });
    assert.equal(r404.status, 404);
  } finally {
    await bff.close();
    await insight.close();
  }
});
```

- [ ] **Step 2: 确认失败** → FAIL（404/501）

- [ ] **Step 3: 实现（insight.ts 内）**

followup 需要 POST 通道——`insightFetch` 泛化为带 method/body（或将 detail 拉取写成独立小函数，实现者择一，保持超时/错误语义一致）。路由体：

```typescript
  r.post("/events/:id/followup", gate, async (req, res) => {
    if (!insightUrl) return res.status(503).json({ error: { code: "INSIGHT_UNAVAILABLE", message: "INSIGHT_URL unset" } });
    const prompt = typeof (req.body as { prompt?: unknown })?.prompt === "string" && (req.body as { prompt: string }).prompt.trim()
      ? (req.body as { prompt: string }).prompt.trim().slice(0, 500)
      : null;
    const eventId = req.params.id;
    let detail: {
      event?: { title?: string; summary?: string; metric?: string; scope_json?: string; period_json?: string; facts_json?: string };
      attribution?: { summary?: string; status?: string };
    };
    try {
      const up = await insightFetch(insightUrl, `/api/insight/events/${encodeURIComponent(eventId)}`);
      if (up.status === 404) return res.status(404).json({ error: { code: "NOT_FOUND", message: "event not found" } });
      if (up.status !== 200) throw new Error(`insight ${up.status}`);
      detail = JSON.parse(up.body);
    } catch {
      return res.status(503).json({ error: { code: "INSIGHT_UNAVAILABLE", message: "insight api unreachable" } });
    }
    const ev = detail.event ?? {};
    const facts: Array<{ label?: string; value?: string }> = JSON.parse(ev.facts_json ?? "[]");
    const scope = JSON.parse(ev.scope_json ?? "{}");
    const period = JSON.parse(ev.period_json ?? "{}");
    const seedQuestion = [
      "【经营事件背景（来自 AI 经营驾驶舱，数据已经确定性检测确认）】",
      `事件：${ev.title ?? eventId}`,
      `摘要：${ev.summary ?? ""}`,
      `指标：${ev.metric ?? ""}｜范围：${scope["范围"] ?? "瓷砖事业部"}｜涉及期间：${period["类型"] ?? "月"}`,
      `已确认事实：${facts.map((f) => `${f.label}=${f.value}`).join("；") || "（见摘要）"}`,
      `归因结论：${detail.attribution?.summary ?? "（归因生成中）"}`,
      "",
      prompt ?? "请基于以上事件背景做进一步分析。",
    ].join("\n");
    // 建 UI 会话（标题=事件标题，截 30 字对齐既有首问标题口径）
    const uiSessionId = store.createSessionWithTitle(req.user!, (ev.title ?? eventId).slice(0, 30));
    store.insertFollowup(`fu-${randomUUID().slice(0, 12)}`, req.user!, eventId, uiSessionId, prompt);
    res.status(200).json({ uiSessionId, seedQuestion, title: (ev.title ?? eventId).slice(0, 30) });
  });
```

`store.createSessionWithTitle(username, title)`：BffStore 若已有带标题建会话方法（ui_sessions 的 create + title）——复用；否则 db.ts 加一个（`INSERT INTO ui_sessions (id, username, title, created_at, updated_at) VALUES (?, ?, ?, now, now)`，id=`us-<uuid12>`，返回 id）。以 db.ts 实际为准，报告选择。

- [ ] **Step 4: 确认通过** → 2 PASS；全套全绿
- [ ] **Step 5: Commit**
```bash
git add server/src/insight.ts server/src/db.ts server/test/insight-followup.test.ts
git commit -m "feat(bff): followup种子编排——拉事件详情组种子问题/建UI会话(标题=事件)/followup_log审计/自定义intent 500字上限" -- server/src/insight.ts server/src/db.ts server/test/insight-followup.test.ts
```

---

### Task 4: BFF insight-flag-cli

**Files:** Create `server/src/insight-flag-cli.ts`；Test `server/test/insight-flag-cli.test.ts`

- [ ] **Step 1: 写失败测试**（对齐 admin-cli.test.ts 既有模式——临时库进程内调 main(args, store)？以 admin-cli.test.ts 的可测入口为准；若 admin-cli 无进程内入口，则用 child_process 执行并断言输出+库状态。**执行者先读 admin-cli.test.ts 选同款模式**，下面按进程内 main 形态写）

```typescript
// server/test/insight-flag-cli.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BffStore, initDb } from "../src/db.ts";
import { flagCliMain } from "../src/insight-flag-cli.ts";
import { hashPw } from "./helpers.ts";

function freshStore(): { store: BffStore; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "flagcli-"));
  const store = new BffStore(initDb(root));
  return { store, cleanup: () => { store.db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("flag CLI：list/on/off/未知用户提示", async () => {
  const { store, cleanup } = freshStore();
  try {
    store.upsertUser("boss", hashPw("pw"));
    await flagCliMain(["list"], store);
    await flagCliMain(["on", "boss"], store);
    assert.equal(store.insightEnabled("boss"), true);
    await flagCliMain(["off", "boss"], store);
    assert.equal(store.insightEnabled("boss"), false);
    await flagCliMain(["on", "ghost"], store);          // 未知用户：报错退出不炸库
    assert.equal(store.insightEnabled("ghost"), false);
  } finally {
    cleanup();
  }
});
```

- [ ] **Step 2: 确认失败** → FAIL（模块不存在）
- [ ] **Step 3: 实现**

```typescript
// server/src/insight-flag-cli.ts
// M-i3 灰度 CLI（spec §13）：node src/insight-flag-cli.ts list|on|off <username>
// 只动 user_flags（admin_audit 不记——flag 属产品灰度非账号管理；若要与 admin-cli 同留痕风格可后续加）。
import { BffStore, initDb } from "./db.ts";

export async function flagCliMain(args: string[], store: BffStore): Promise<number> {
  const [cmd, username] = args;
  if (cmd === "list") {
    const rows = store.db.prepare("SELECT username, enabled, granted_at FROM user_flags").all() as Array<Record<string, unknown>>;
    if (!rows.length) console.log("(no flags)");
    for (const r of rows) console.log(`${r.username}\t${r.enabled ? "on" : "off"}\t${new Date(Number(r.granted_at)).toISOString()}`);
    return 0;
  }
  if ((cmd === "on" || cmd === "off") && username) {
    const user = store.getUser(username);
    if (!user) { console.error(`user not found: ${username}`); return 1; }
    store.setFlag(username, "insight_cockpit", cmd === "on");
    console.log(`${username} insight_cockpit=${cmd}`);
    return 0;
  }
  console.error("usage: node src/insight-flag-cli.ts list | on <username> | off <username>");
  return 2;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/").split("/").pop()!)) {
  const root = process.env.DATA_DIR || "./data";
  const store = new BffStore(initDb(root));
  process.exit(await flagCliMain(process.argv.slice(2), store));
}
```

（直跑判定的写法以 admin-cli.ts 现有直跑判定为准等价替换；package.json scripts 加 `"insight:flag": "node src/insight-flag-cli.ts"`——该行属本任务文件。）

- [ ] **Step 4: 确认通过** → 1 PASS；全套全绿
- [ ] **Step 5: Commit**
```bash
git add server/src/insight-flag-cli.ts server/test/insight-flag-cli.test.ts server/package.json
git commit -m "feat(bff): insight灰度CLI——list/on/off+未知用户拒绝+npm run insight:flag" -- server/src/insight-flag-cli.ts server/test/insight-flag-cli.test.ts server/package.json
```

---

### Task 5: Web 类型与 API 客户端

**Files:** Modify `web/src/types.ts`（尾部追加）、`web/src/api.ts`（尾部追加）。**验证 = `cd web && npm run build` 零错误**（前端无测试框架——诚实声明；类型即契约校验）。

- [ ] **Step 1: types.ts 尾部追加**

```typescript
// ── M-i3 经营洞察（insight-api 契约镜像；事件对象为 insight.db 行原样 snake_case）──────
export interface InsightDailyEvent {
  eventId: string;
  eventKey: string | null;
  lifecycle: string;
  persistDays: number;
  title: string;
  summary: string;
  severity: "major" | "minor";
  eventType: string;
  metric: string | null;
  scope: Record<string, unknown>;
  period: Record<string, unknown>;
  facts: Array<{ label: string; value: string }>;
  score: number;
  status: string;
  createdAt: number;
}
export interface InsightDaily {
  briefDate: string;
  scope: string;
  dataFreshness: { overall: "ready" | "partial" | "not_ready"; radars: Array<{ detector: string; ready: boolean; detail: string }> };
  eventCount: number;
  stale: boolean;
  events: InsightDailyEvent[];
}
export interface InsightEventDetail {
  event: {
    event_id: string; event_key: string; lifecycle: string; data_date: string;
    first_seen_date: string; persist_days: number; detector: string; event_type: string;
    title: string; summary: string; severity: "major" | "minor"; scope_json: string;
    facts_json: string; score: number; status: string;
  };
  executiveSummary: string;
  facts: Array<{ label: string; value: string }>;
  attribution: {
    status: "pending" | "done" | "degraded" | "failed";
    analysisId: string | null;
    summary: string | null;
    path: Array<{ level: string; contribution: string }>;
    findings: Array<{ text: string; evidence: string }>;
    waterfall: Array<{ name: string; value: number }>;
    entities: Array<{ name: string; type: string; delta: string }>;
    runId: string | null;
    reportPath: string | null;
  };
  evidence: Array<{ finding_id: string; detector: string; metrics: Record<string, unknown>; norm_score: number; is_late: number }>;
  suggestedActions: string[];
  followupPrompts: string[];
}
export interface InsightTimelineItem {
  eventId: string; title: string; severity: "major" | "minor"; dataDate: string; createdAt: number;
}
export interface InsightFollowupResult {
  uiSessionId: string; seedQuestion: string; title: string;
}
```

- [ ] **Step 2: api.ts 尾部追加**

```typescript
// ── M-i3 经营洞察 ─────────────────────────────────────────────────────────────────
export const apiInsightEnabled = () => api<{ enabled: boolean }>("GET", "/api/insight/enabled");
export const apiInsightDaily = (date?: string) =>
  api<InsightDaily>("GET", `/api/insight/daily${date ? `?date=${encodeURIComponent(date)}` : ""}`);
export const apiInsightEvent = (id: string) =>
  api<InsightEventDetail>("GET", `/api/insight/events/${encodeURIComponent(id)}`);
export const apiInsightTimeline = (days = 30) =>
  api<InsightTimelineItem[]>("GET", `/api/insight/timeline?days=${days}`);
export const apiInsightFollowup = (eventId: string, prompt?: string) =>
  api<InsightFollowupResult>("POST", `/api/insight/events/${encodeURIComponent(eventId)}/followup`, prompt ? { prompt } : {});
```

（api.ts 头部 type import 列表加 InsightDaily/InsightEventDetail/InsightTimelineItem/InsightFollowupResult。）

- [ ] **Step 3: 验证** `cd web && npm run build` → 零错误
- [ ] **Step 4: Commit**
```bash
git add web/src/types.ts web/src/api.ts
git commit -m "feat(web): insight类型与API客户端——daily/detail/timeline/followup/enabled六函数" -- web/src/types.ts web/src/api.ts
```

---

### Task 6: 驾驶舱首页组件（6 个）

**Files:** Create `web/src/components/insights/`：`OperatingDashboardPage.tsx`、`TodayAttentionHeader.tsx`、`BusinessEventCard.tsx`、`BusinessEventList.tsx`、`BusinessEventTimeline.tsx`、`EventCenterView.tsx`。验证 = build 零错误。

- [ ] **Step 1: 实现组件**（完整代码；视觉=浅色系蓝主操作，severity 色 map 三处共用一个 util——放 BusinessEventCard 内导出）

```tsx
// web/src/components/insights/TodayAttentionHeader.tsx
import type { InsightDaily } from "../../types";

export default function TodayAttentionHeader({ daily }: { daily: InsightDaily | null }) {
  const major = daily?.events.filter((e) => e.severity === "major").length ?? 0;
  const minor = daily?.events.filter((e) => e.severity === "minor").length ?? 0;
  const gap = daily?.events.filter((e) => e.eventType === "target_gap").length ?? 0;
  return (
    <div className="px-8 pt-8 pb-4">
      <h1 className="text-xl font-semibold text-slate-900">今日经营关注</h1>
      <p className="mt-1 text-sm text-slate-500">
        {daily
          ? daily.dataFreshness.overall === "not_ready"
            ? "数据未就绪——今日简报未定稿，不代表无异常"
            : `截至 ${daily.briefDate}，发现 ${daily.eventCount} 件值得关注的经营事项${daily.stale ? "（当前为最近一期已发布简报）" : ""}`
          : "加载中…"}
      </p>
      <div className="mt-3 flex gap-2 text-xs">
        <span className="rounded-full bg-red-50 px-3 py-1 text-red-600">重大异常 {major}</span>
        <span className="rounded-full bg-orange-50 px-3 py-1 text-orange-500">一般异常 {minor}</span>
        <span className="rounded-full bg-blue-50 px-3 py-1 text-blue-600">目标偏差 {gap}</span>
      </div>
    </div>
  );
}
```

```tsx
// web/src/components/insights/BusinessEventCard.tsx
import type { InsightDailyEvent } from "../../types";

export const severityStyle = (e: { severity: string; eventType: string }) =>
  e.severity === "major"
    ? { chip: "bg-red-50 text-red-600", bar: "bg-red-500" }
    : e.severity === "minor"
      ? { chip: "bg-orange-50 text-orange-500", bar: "bg-orange-400" }
      : { chip: "bg-blue-50 text-blue-600", bar: "bg-blue-500" };
const severityLabel = (e: InsightDailyEvent) =>
  e.eventType === "target_gap" ? "目标偏差" : e.severity === "major" ? "重大异常" : "一般异常";

export default function BusinessEventCard({
  event, rank, onOpen,
}: { event: InsightDailyEvent; rank: number; onOpen: (id: string) => void }) {
  const st = severityStyle(event);
  return (
    <div className="relative overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-100">
      <div className={`absolute inset-y-0 left-0 w-1 ${st.bar}`} />
      <div className="p-5 pl-6">
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400">0{rank}</span>
          <span className={`rounded-full px-2 py-0.5 text-xs ${st.chip}`}>{severityLabel(event)}</span>
          {event.persistDays > 1 && (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">持续第 {event.persistDays} 天</span>
          )}
        </div>
        <h3 className="mt-2 text-base font-semibold text-slate-900">{event.title}</h3>
        <p className="mt-1 line-clamp-2 text-sm text-slate-500">{event.summary}</p>
        <div className="mt-3 flex flex-wrap gap-4">
          {event.facts.slice(0, 3).map((f) => (
            <div key={f.label}>
              <div className="text-xs text-slate-400">{f.label}</div>
              <div className="text-sm font-medium text-slate-800">{f.value}</div>
            </div>
          ))}
        </div>
        <button
          className="mt-4 rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
          onClick={() => onOpen(event.eventId)}
        >
          查看详情
        </button>
      </div>
    </div>
  );
}
```

```tsx
// web/src/components/insights/BusinessEventList.tsx
import type { InsightDailyEvent } from "../../types";
import BusinessEventCard from "./BusinessEventCard";

export default function BusinessEventList({
  events, onOpen,
}: { events: InsightDailyEvent[]; onOpen: (id: string) => void }) {
  if (!events.length) {
    return (
      <div className="rounded-xl bg-white p-8 text-center text-sm text-slate-400 ring-1 ring-slate-100">
        今日暂无重大经营异常
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      {events.map((e, i) => (
        <BusinessEventCard key={e.eventId} event={e} rank={i + 1} onOpen={onOpen} />
      ))}
    </div>
  );
}
```

```tsx
// web/src/components/insights/BusinessEventTimeline.tsx
import type { InsightTimelineItem } from "../../types";
import { severityStyle } from "./BusinessEventCard";

export default function BusinessEventTimeline({
  items, onOpen,
}: { items: InsightTimelineItem[]; onOpen: (id: string) => void }) {
  if (!items.length) return <div className="p-4 text-sm text-slate-400">近期无事件</div>;
  return (
    <ul className="divide-y divide-slate-100">
      {items.map((it) => {
        const st = severityStyle(it);
        return (
          <li key={it.eventId}>
            <button
              className="flex w-full items-center gap-3 px-2 py-2 text-left hover:bg-slate-50"
              onClick={() => onOpen(it.eventId)}
            >
              <span className={`h-2 w-2 shrink-0 rounded-full ${st.bar}`} />
              <span className="flex-1 truncate text-sm text-slate-700">{it.title}</span>
              <span className="shrink-0 text-xs text-slate-400">{it.dataDate}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
```

```tsx
// web/src/components/insights/EventCenterView.tsx（经营事件中心：全量时间线 + 简要统计）
import { useEffect, useState } from "react";
import { apiInsightTimeline } from "../../api";
import type { InsightTimelineItem } from "../../types";
import BusinessEventTimeline from "./BusinessEventTimeline";

export default function EventCenterView({ onOpen }: { onOpen: (id: string) => void }) {
  const [items, setItems] = useState<InsightTimelineItem[] | null>(null);
  useEffect(() => {
    apiInsightTimeline(90).then(setItems).catch(() => setItems([]));
  }, []);
  return (
    <div className="rounded-xl bg-white p-6 ring-1 ring-slate-100">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-slate-900">经营事件时间线（近 90 天）</h3>
        {items && <span className="text-xs text-slate-400">{items.length} 条</span>}
      </div>
      <div className="mt-2 max-h-80 overflow-y-auto">
        {items === null ? <div className="p-4 text-sm text-slate-400">加载中…</div> : <BusinessEventTimeline items={items} onOpen={onOpen} />}
      </div>
    </div>
  );
}
```

```tsx
// web/src/components/insights/OperatingDashboardPage.tsx（驾驶舱首页容器）
import { useEffect, useState } from "react";
import { apiInsightDaily } from "../../api";
import type { InsightDaily } from "../../types";
import TodayAttentionHeader from "./TodayAttentionHeader";
import BusinessEventList from "./BusinessEventList";
import EventCenterView from "./EventCenterView";

export default function OperatingDashboardPage({ onOpenEvent }: { onOpenEvent: (id: string) => void }) {
  const [daily, setDaily] = useState<InsightDaily | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    apiInsightDaily().then(setDaily).catch((e) => setErr(String(e instanceof Error ? e.message : e)));
  }, []);
  if (err) {
    return (
      <div className="p-8 text-sm text-slate-500">经营洞察暂不可用，AI 问数不受影响。<br />
        <span className="text-xs text-slate-400">{err}</span></div>
    );
  }
  return (
    <div className="h-full overflow-y-auto bg-slate-50">
      <TodayAttentionHeader daily={daily} />
      <div className="px-8">
        <BusinessEventList events={daily?.events ?? []} onOpen={onOpenEvent} />
        {daily && daily.dataFreshness.overall !== "ready" && daily.dataFreshness.radars.length > 0 && (
          <div className="mt-4 rounded-xl bg-amber-50 p-4 text-xs text-amber-700 ring-1 ring-amber-100">
            部分雷达数据未就绪：{daily.dataFreshness.radars.filter((r) => !r.ready).map((r) => r.detector).join("、")}
          </div>
        )}
      </div>
      <div className="mt-6 px-8 pb-8">
        <EventCenterView onOpen={onOpenEvent} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 验证** `cd web && npm run build` → 零错误
- [ ] **Step 3: Commit**
```bash
git add web/src/components/insights/
git commit -m "feat(web): 驾驶舱首页六组件——今日关注头部/事件卡(severity色系)/事件列表(空态=暂无异常)/时间线/事件中心/页面容器(not_ready诚实横幅)" -- web/src/components/insights/
```

---

### Task 7: 事件详情组件（9 个）

**Files:** Create `web/src/components/insights/`：`EventDetailPage.tsx`、`EventExecutiveSummary.tsx`、`EventFactCards.tsx`、`AttributionPath.tsx`、`AttributionWaterfall.tsx`、`TrendPanel.tsx`、`ImpactEntityTable.tsx`、`SuggestedActionsPanel.tsx`、`EventFollowupPanel.tsx`。验证 = build 零错误。

- [ ] **Step 1: 实现组件**

```tsx
// web/src/components/insights/EventExecutiveSummary.tsx
export default function EventExecutiveSummary({ summary, attributionStatus }: { summary: string; attributionStatus: string }) {
  return (
    <div className="rounded-xl bg-white p-6 ring-1 ring-slate-100">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">AI 执行摘要</h3>
        <span className="text-xs text-slate-400">
          {attributionStatus === "done" ? "已归因" : attributionStatus === "degraded" ? "归因降级（AI 原文）" : attributionStatus === "failed" ? "归因失败" : "归因生成中"}
        </span>
      </div>
      <p className="mt-3 text-sm leading-6 text-slate-700">{summary}</p>
    </div>
  );
}
```

```tsx
// web/src/components/insights/EventFactCards.tsx
export default function EventFactCards({ facts }: { facts: Array<{ label: string; value: string }> }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {facts.slice(0, 4).map((f) => (
        <div key={f.label} className="rounded-xl bg-white p-4 ring-1 ring-slate-100">
          <div className="text-xs text-slate-400">{f.label}</div>
          <div className="mt-1 text-lg font-semibold text-slate-900">{f.value}</div>
        </div>
      ))}
    </div>
  );
}
```

```tsx
// web/src/components/insights/AttributionPath.tsx
export default function AttributionPath({ path }: { path: Array<{ level: string; contribution: string }> }) {
  if (!path.length) return <div className="p-4 text-sm text-slate-400">归因路径待生成</div>;
  return (
    <ol className="space-y-2">
      {path.map((p, i) => (
        <li key={`${p.level}-${i}`} className="flex items-center gap-3 text-sm">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-50 text-xs text-blue-600">{i + 1}</span>
          <span className="font-medium text-slate-800">{p.level}</span>
          <span className="text-slate-500">贡献 {p.contribution}</span>
        </li>
      ))}
    </ol>
  );
}
```

```tsx
// web/src/components/insights/AttributionWaterfall.tsx
export default function AttributionWaterfall({ waterfall }: { waterfall: Array<{ name: string; value: number }> }) {
  if (waterfall.length < 2) return <div className="p-4 text-sm text-slate-400">瀑布图待归因生成</div>;
  const max = Math.max(...waterfall.map((w) => Math.abs(w.value)));
  return (
    <div className="space-y-1.5">
      {waterfall.map((w, i) => {
        const pct = Math.round((Math.abs(w.value) / max) * 100);
        const negative = w.value < 0;
        const isEnd = i === waterfall.length - 1;
        return (
          <div key={`${w.name}-${i}`} className="flex items-center gap-3 text-xs">
            <span className="w-24 shrink-0 truncate text-slate-600" title={w.name}>{w.name}</span>
            <div className="h-4 flex-1 rounded bg-slate-100">
              <div
                className={`h-4 rounded ${isEnd ? "bg-blue-500" : negative ? "bg-red-400" : "bg-emerald-400"}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className={`w-20 shrink-0 text-right ${negative ? "text-red-500" : "text-slate-700"}`}>
              {w.value.toLocaleString("zh-CN")}
            </span>
          </div>
        );
      })}
    </div>
  );
}
```

```tsx
// web/src/components/insights/TrendPanel.tsx（v1 占位禁用态：趋势序列 API 未建，后续版本接 detector 时间序列）
export default function TrendPanel() {
  return (
    <div className="rounded-xl bg-white p-6 ring-1 ring-slate-100">
      <h3 className="text-sm font-semibold text-slate-900">趋势变化</h3>
      <div className="mt-3 rounded-lg border border-dashed border-slate-200 p-6 text-center text-sm text-slate-400">
        趋势序列下版本接入（当前版本提供归因瀑布与影响对象）
      </div>
    </div>
  );
}
```

```tsx
// web/src/components/insights/ImpactEntityTable.tsx
import { useState } from "react";

export default function ImpactEntityTable({ entities }: { entities: Array<{ name: string; type: string; delta: string }> }) {
  const [showAll, setShowAll] = useState(false);
  if (!entities.length) return <div className="p-4 text-sm text-slate-400">重点影响对象待归因生成</div>;
  const rows = showAll ? entities : entities.slice(0, 5);
  return (
    <div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-slate-400">
            <th className="pb-2">名称</th><th className="pb-2">类型</th><th className="pb-2 text-right">变动</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((e) => (
            <tr key={e.name}>
              <td className="py-2 text-slate-800">{e.name}</td>
              <td className="py-2 text-slate-500">{e.type}</td>
              <td className={`py-2 text-right ${e.delta.trim().startsWith("-") ? "text-red-500" : "text-slate-700"}`}>{e.delta}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {entities.length > 5 && (
        <button className="mt-2 text-xs text-blue-600 hover:underline" onClick={() => setShowAll(!showAll)}>
          {showAll ? "收起" : `查看更多（共 ${entities.length}）`}
        </button>
      )}
    </div>
  );
}
```

```tsx
// web/src/components/insights/SuggestedActionsPanel.tsx（v1：API suggestedActions 恒空数组 → 呈现占位说明；决策辅助区与事实区视觉区隔=浅底+顶部标注）
export default function SuggestedActionsPanel({ actions }: { actions: string[] }) {
  return (
    <div className="rounded-xl bg-slate-100 p-5 ring-1 ring-slate-200">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-700">AI 建议动作</h3>
        <span className="rounded-full bg-white px-2 py-0.5 text-xs text-slate-400">决策辅助 · 仅供参考</span>
      </div>
      {actions.length ? (
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-slate-600">
          {actions.map((a, i) => <li key={i}>{a}</li>)}
        </ol>
      ) : (
        <p className="mt-3 text-sm text-slate-400">归因完成后可生成建议（当前版本仅呈现事实与归因，不自动派发任务）</p>
      )}
    </div>
  );
}
```

```tsx
// web/src/components/insights/EventFollowupPanel.tsx（快捷追问 → 走 BFF followup → 跳聊天自动发送）
import { useState } from "react";
import { ApiError, apiInsightFollowup } from "../../api";

export default function EventFollowupPanel({
  eventId, prompts, onFollowed,
}: { eventId: string; prompts: string[]; onFollowed: (r: { uiSessionId: string; seedQuestion: string }) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async (prompt?: string) => {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await apiInsightFollowup(eventId, prompt);
      onFollowed(r);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "追问创建失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rounded-xl bg-white p-6 ring-1 ring-slate-100">
      <h3 className="text-sm font-semibold text-slate-900">基于本事件继续问 AI</h3>
      <div className="mt-3 flex flex-wrap gap-2">
        {prompts.map((p) => (
          <button key={p} disabled={busy} onClick={() => void go(p)}
            className="rounded-full bg-blue-50 px-3 py-1.5 text-sm text-blue-600 hover:bg-blue-100 disabled:opacity-50">
            {p}
          </button>
        ))}
        <button disabled={busy} onClick={() => void go()}
          className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50">
          继续分析
        </button>
      </div>
      {err && <p className="mt-2 text-xs text-red-500">{err}</p>}
    </div>
  );
}
```

```tsx
// web/src/components/insights/EventDetailPage.tsx（详情容器：摘要先行；返回/头部元信息/摘要/事实/归因/趋势/对象/建议/追问）
import { useEffect, useState } from "react";
import { apiInsightEvent } from "../../api";
import type { InsightEventDetail } from "../../types";
import { severityStyle } from "./BusinessEventCard";
import EventExecutiveSummary from "./EventExecutiveSummary";
import EventFactCards from "./EventFactCards";
import AttributionPath from "./AttributionPath";
import AttributionWaterfall from "./AttributionWaterfall";
import TrendPanel from "./TrendPanel";
import ImpactEntityTable from "./ImpactEntityTable";
import SuggestedActionsPanel from "./SuggestedActionsPanel";
import EventFollowupPanel from "./EventFollowupPanel";

export default function EventDetailPage({
  eventId, onBack, onFollowed,
}: { eventId: string; onBack: () => void; onFollowed: (r: { uiSessionId: string; seedQuestion: string }) => void }) {
  const [d, setD] = useState<InsightEventDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    apiInsightEvent(eventId).then(setD).catch((e) => setErr(String(e instanceof Error ? e.message : e)));
  }, [eventId]);
  if (err) return <div className="p-8 text-sm text-slate-500">事件加载失败：{err}</div>;
  if (!d) return <div className="p-8 text-sm text-slate-400">加载中…</div>;
  const st = severityStyle(d.event);
  return (
    <div className="h-full overflow-y-auto bg-slate-50 p-8">
      <button className="text-sm text-blue-600 hover:underline" onClick={onBack}>← 返回今日经营关注</button>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2.5 py-0.5 text-xs ${st.chip}`}>
          {d.event.event_type === "target_gap" ? "目标偏差" : d.event.severity === "major" ? "重大异常" : "一般异常"}
        </span>
        {d.event.persist_days > 1 && (
          <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs text-slate-500">持续第 {d.event.persist_days} 天</span>
        )}
        <span className="text-xs text-slate-400">
          首现 {d.event.first_seen_date}｜数据日 {d.event.data_date}｜状态 {d.event.status === "analyzed" ? "分析完成" : "已发现"}
        </span>
      </div>
      <h2 className="mt-2 text-lg font-semibold text-slate-900">{d.event.title}</h2>
      <div className="mt-6 space-y-6">
        <EventExecutiveSummary summary={d.executiveSummary} attributionStatus={d.attribution.status} />
        <EventFactCards facts={d.facts} />
        <div className="rounded-xl bg-white p-6 ring-1 ring-slate-100">
          <h3 className="text-sm font-semibold text-slate-900">自动归因分析</h3>
          <div className="mt-4 grid grid-cols-1 gap-8 lg:grid-cols-2">
            <div><h4 className="mb-2 text-xs text-slate-400">下钻路径</h4><AttributionPath path={d.attribution.path} /></div>
            <div><h4 className="mb-2 text-xs text-slate-400">贡献瀑布</h4><AttributionWaterfall waterfall={d.attribution.waterfall} /></div>
          </div>
          {d.attribution.findings.length > 0 && (
            <div className="mt-4">
              <h4 className="mb-2 text-xs text-slate-400">关键发现（均附证据）</h4>
              <ul className="space-y-1 text-sm text-slate-700">
                {d.attribution.findings.map((f, i) => (
                  <li key={i}>· {f.text} <span className="text-xs text-slate-400">（{f.evidence}）</span></li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <TrendPanel />
          <div className="rounded-xl bg-white p-6 ring-1 ring-slate-100">
            <h3 className="text-sm font-semibold text-slate-900">重点影响对象</h3>
            <div className="mt-3"><ImpactEntityTable entities={d.attribution.entities} /></div>
          </div>
        </div>
        <SuggestedActionsPanel actions={d.suggestedActions} />
        <EventFollowupPanel eventId={eventId} prompts={d.followupPrompts} onFollowed={onFollowed} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 验证** `cd web && npm run build` → 零错误
- [ ] **Step 3: Commit**
```bash
git add web/src/components/insights/
git commit -m "feat(web): 事件详情九组件——执行摘要两态/事实卡/下钻路径/瀑布图/趋势占位/影响对象表/建议动作区隔/追问面板/详情容器(摘要先行)" -- web/src/components/insights/
```

---

### Task 8: 装配——App/Sidebar/ChatView(autoAsk) 与 spec 勘误

**Files:** Modify `web/src/App.tsx`、`web/src/components/Sidebar.tsx`、`web/src/components/ChatView.tsx`；本仓（dataprojai-2harness）改 spec（v1.2.4 勘误行）。验证 = web build 零错误 + server 全套绿。

- [ ] **Step 1: ChatView 增量 autoAsk**（追加 props 与一次性 effect，不动既有发送逻辑）：

```tsx
// ChatView.tsx —— props 类型加两个可选字段；组件内加一次性发送 effect：
export default function ChatView({ sessionId, sessionTitle, onFirstAsk, onSessionActivity, autoAsk, onAutoAskDone }: ChatViewProps) {
  // ……既有逻辑不动……
  const autoRef = useRef<string | null>(null);
  useEffect(() => {
    if (autoAsk && autoRef.current !== autoAsk && sessionId && !busy) {
      autoRef.current = autoAsk;
      void ask(autoAsk);            // 经既有 apiAsk 路径发送（约束：绝不第二套 Agent）
      onAutoAskDone?.();
    }
  }, [autoAsk, sessionId, busy]);   // busy/ask 以组件实际闭包名为准，等价接入
}
```

（`useRef`/`useEffect` 若未 import 则补；`ask` 为 ChatView 内既有发送函数名——以实码为准等价接入。）

- [ ] **Step 2: App.tsx 装配**：

```tsx
// view 类型："chat" | "admin" | "insights"
type View = "chat" | "admin" | "insights";
// Boot 增 insightsEnabled（进 ready 前探 /api/insight/enabled，失败=false）
// enter() 与 apiMe().then 里并行探测：apiInsightEnabled().then(r => setInsightsOn(r.enabled)).catch(() => {})
// 状态：
const [view, setView] = useState<View>("chat");
const [insightsOn, setInsightsOn] = useState(false);
const [openEventId, setOpenEventId] = useState<string | null>(null);
const [followupSeed, setFollowupSeed] = useState<{ sessionId: string; question: string } | null>(null);
// 登录后默认落地：insightsOn ? "insights" : "chat"
// Sidebar 增 props：insightsEnabled={insightsOn} onInsights={() => { setView("insights"); setOpenEventId(null); }}
// 主区渲染分支：
{view === "admin" ? (
  <AdminView … />
) : view === "insights" && insightsOn ? (
  openEventId ? (
    <EventDetailPage eventId={openEventId} onBack={() => setOpenEventId(null)}
      onFollowed={(r) => { setFollowupSeed({ sessionId: r.uiSessionId, question: r.seedQuestion });
                           setActiveId(r.uiSessionId); setView("chat"); void refreshSessions(); }} />
  ) : (
    <OperatingDashboardPage onOpenEvent={(id) => setOpenEventId(id)} />
  )
) : (
  <ChatView sessionId={active?.id ?? null} …
    autoAsk={followupSeed && followupSeed.sessionId === (active?.id ?? null) ? followupSeed.question : undefined}
    onAutoAskDone={() => setFollowupSeed(null)} />
)}
```

（以 App.tsx 实际结构等价落位；`apiInsightEnabled` 从 api.ts 引入；landing 逻辑=enter 成功后 `setView(insightsOn ? "insights" : "chat")`——注意 setState 时序，用探测结果变量而非闭包旧值。）

- [ ] **Step 3: Sidebar 入口**（nav 区，`insightsEnabled` 开才渲染，置于 AI问数/会话列表之上或 admin 入口旁——以实码布局等价落位）：

```tsx
{insightsEnabled && (
  <button
    className="…（与 onAdmin 按钮同类名）…"
    onClick={onInsights}
  >
    AI经营驾驶舱
  </button>
)}
```

- [ ] **Step 4: spec v1.2.4 勘误**（在 `D:\dataprojai-2harness` 仓，spec §11.2 followup 段后追加一行）：

> v1.2.4 勘误（2026-09-29）：followup_session 审计表落 **BFF 记账库**（表名 `followup_log`），不进 insight.db——对齐"任务/事件事实源在网关/insight，UI 域便利数据在 BFF"的既有分工；insight-api 保持纯只读。

- [ ] **Step 5: 验证** `cd web && npm run build` 零错误；`cd server && npm test` 全绿
- [ ] **Step 6: Commit（两仓各自路径限定）**
```bash
# dataplat-ui
git add web/src/App.tsx web/src/components/Sidebar.tsx web/src/components/ChatView.tsx
git commit -m "feat(web): 驾驶舱装配——view=insights(登录默认落地flag开)/Sidebar入口/ChatView autoAsk一次性种子发送/followup跳会话" -- web/src/App.tsx web/src/components/Sidebar.tsx web/src/components/ChatView.tsx
# dataprojai-2harness
git add docs/superpowers/specs/2026-09-23-ai-business-assistant-v1-design.md
git commit -m "docs(spec): v1.2.4勘误——followup审计落BFF记账库followup_log(insight-api保持纯只读)" -- docs/superpowers/specs/2026-09-23-ai-business-assistant-v1-design.md
```

---

### Task 9: 收尾——runbook UI 部署节与人工 smoke 清单

**Files:** Modify `insight/PIPELINE_RUNBOOK.md`（在 `D:\dataprojai-2harness` 仓）；Create `D:\dataplat-ui\INSIGHT_UI_SMOKE.md`

- [ ] **Step 1: PIPELINE_RUNBOOK.md 追加「UI 接入（M-i3）」节**：BFF env 增 `INSIGHT_URL`（缺省 http://127.0.0.1:58095）；灰度操作 `npm run insight:flag -- on <user>`；部署顺序 worker/api → BFF（INSIGHT_URL）→ 前端 build；验证 `/api/insight/health`。
- [ ] **Step 2: INSIGHT_UI_SMOKE.md**（人工验收清单，逐步可勾）：登录(flag off) → 无驾驶舱入口、chat 正常；`insight:flag on` 重登 → 默认落驾驶舱、数据截至/无异常态/事件卡三 severity 色/持续 N 天标签；点事件 → 详情各区块（摘要先行/事实/路径/瀑布/对象/建议区隔/追问）；点快捷追问 → 跳聊天自动发送种子问题、SSE 流式正常、会话标题=事件名；返回驾驶舱 → 时间线可点历史；关 flag 重登 → 回 chat 默认。每步注明"预期"。
- [ ] **Step 3: 全量回归**：server `npm test` 全绿（73+新增）；web build 零错误；`D:\dataprojai-2harness` 侧 `python -m pytest insight/tests/ eval/ -q` 全绿（零影响复核）。
- [ ] **Step 4: Commit（两仓）**
```bash
# dataplat-ui
git add INSIGHT_UI_SMOKE.md
git commit -m "docs: insight UI人工验收清单——flag开关/驾驶舱/详情/追问跳会话逐步预期" -- INSIGHT_UI_SMOKE.md
# dataprojai-2harness
git add insight/PIPELINE_RUNBOOK.md
git commit -m "docs(insight): runbook补UI接入节——INSIGHT_URL/insight:flag灰度/部署顺序/smoke入口" -- insight/PIPELINE_RUNBOOK.md
```

---

## Self-Review 记录

1. **Spec coverage**：§11.2 BFF 五端点（enabled/daily/events/timeline/followup——T2/T3）✅；§13 flag+三级放量入口（T1/T4/T8 落地）✅；§12.1 导航+Header+驾驶舱首页+右侧辅助（v1 遵循"不凑数"未建健康概览侧栏——**有意范围裁剪**：spec §12.2 允许"只显示状态"，v1 以 freshness 横幅替代侧栏，记录于此）✅；§12.2 事件卡（含唯一小图=瀑布图放详情；卡片 v1 无图——**范围裁剪记录**：spec 允许"至多一张"，0 张合规）✅；§12.3 详情页顺序（摘要先行→事实→归因→趋势/对象→建议→追问）✅；§12.4 视觉 ✅；§12.5 用户路径 ✅；followup 走现有 apiAsk（绝不第二套 Agent）✅；TrendPanel 占位禁用（趋势 API 未建——**显式裁剪**，非隐藏 TBD）✅；SuggestedActions 空态（v1 API 恒 []）✅。
2. **Placeholder scan**：无 TBD/TODO；TrendPanel/SuggestedActions/导航占位均为**产品裁剪的显式禁用态**（有文案有理由），非未完成实现；T2 中 followup 占位段已明确标注"执行时不写"（T2/T3 连续单元）。
3. **Type consistency**：`InsightDaily/InsightDailyEvent/InsightEventDetail/InsightTimelineItem/InsightFollowupResult` 贯穿 T5-T8；`severityStyle` 从 BusinessEventCard 导出供 Timeline/Detail 复用；BFF 端点路径与 M-i2 api_main 契约逐字对齐（daily/events/:id/timeline/health）；`store.insightEnabled/setFlag/insertFollowup/createSessionWithTitle` 签名在 T1/T3 一致。

## M-i3 Exit

1. BFF 五端点全绿（flag 门禁/代理降级/审计）
2. flag CLI 可用，默认全关
3. 驾驶舱两页 build 零错误、人工 smoke 清单通过（用户验收）
4. followup 种子会话经现有 chat 链路自动发送（SSE 正常）
5. 既有 chat/SSE/报告/管理测试零退化（73+ 既有全绿）
6. harness 侧 insight/eval 测试零影响
7. spec v1.2.4 勘误与 runbook UI 节落档
