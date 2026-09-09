# dsh 引擎接入 · M1 服务化与恢复 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建 engine-gateway：把 M0 验证过的 dsh 受限执行栈封装为任务型服务（提交/排队/执行/恢复/事件流），可恢复故障下用户无需手动接续（spec §12 M1 放行条件）。

**Architecture:** Node/TypeScript 单服务 + SQLite 持久化 + 少量工作进程。DshBackend 以 M0 定型的 SDK JSON-RPC stdio 形态驱动 dsh（session_id 复用即多轮）；任务状态机落 SQLite（含事件重放日志与发布记录）；exec_script/MCP/沙箱/工具白名单全部复用 M0 工件，不重造。

**Tech Stack:** Node 24 + TypeScript（零框架优先：node:http + better-sqlite3）、dsh 0.1.2-rc.1（sdk profile）、SQLite、Docker（沙箱，复用 dataplat-script:m0）、pytest/vitest 风格单测（node:test）。

**范围决策：** 本计划覆盖 M1（spec §5/§9/§10 的网关侧）+ M1 前置三项（L1 口径沉淀 / L3 profile 脚本化 / L4 受限账号的集成位）。**不含**：claudecodeui 侧改造（A1 跨仓依赖——网关 API 即契约，其侧改动在服务器实施）、M2 评测、RLS。

**M0 实测结论如何塑造本计划（写计划时的既定事实）：**
- 多轮 = SDK session_id 复用（`dsh --profile sdk` JSON-RPC stdio；同 id 多次 `session/prompt` 落同一持久会话；`session.event` 通知流实时拿 turn/end）——DshBackend 直接采用
- dsh 工具白名单/插件 patch 经 bundle 生效；profile 配置目前手工 → 本计划 Task 2 脚本化
- workdir 必须在平台 Temp 树之外（workspace-write 硬编码豁免 os.tmpdir()）
- exec_script 首调因 write→exec 文件同步间隙必失败、重试即恢复 → Task 6 在插件加存在性等待，消掉 M0 观察到的 7 次浪费轮次
- MCP RESULT_DIR 与任务结果目录的衔接：网关为每任务建 results 子目录，MCP env 按任务注入

---

## 附录 A：四大机制的不变量与恢复矩阵（2026-09-09 用户审定后深化）

> 用户裁定：M1 的核心不是"让 dsh 回答问题"（M0 已证），而是 **Agent 跑几小时、出一次错、断一次连、挂一次进程之后，任务系统依然知道：谁在干什么、做到哪里、谁还有执行权、最后只产生一个结果**。以下四组不变量是 Task 4/5/7/9 的实现依据与验收标准。

**A.0 总原则**：所有真相在 SQLite（单库、单连接、WAL）；所有状态迁移都是**带围栏的条件写**；副作用安全靠"唯一命名 + 围栏发布"，而非"避免并发"。

### A.1 Lease 执行权

- **L1 唯一执行者**：任一时刻一个 run_id 至多一个有效执行者。每次获权 `attempt+1`；执行者的全部状态写（stage/status/event/heartbeat）都走围栏条件写 `WHERE run_id=? AND attempt=? AND lease_owner=?`——rowcount=0 即被围栏：立即 kill 自己的 dsh 进程树（连带 MCP 子进程与沙箱容器）并静默退出，不写任何补偿记录。
- **L2 心跳解耦**：租约 TTL（默认 90s）>> 心跳间隔（15s）；worker（Node 侧）活着就续租，与 dsh/模型是否静默无关——几小时的报告任务不会因模型长时间不出字而丢执行权。
- **启动自愈（单服务部署不变量）**：网关 boot 时 `UPDATE tasks SET lease_owner=NULL WHERE status='running'`——单服务部署下旧 worker 必死，强制过期是安全的。**多实例部署此假设失效，记为部署红线**。
- **围栏后旧 attempt 的副作用安全性（"最后只一个结果"的构造性保证）**：DWS 只读无害；result 文件名含 pid+时间戳（M0 已定型）天然不冲突；沙箱容器名带 `<run_id>-a<attempt>`（Task 6 落实）使接管者清理不会误杀新 attempt；报告发布唯一经 publications 围栏写入——四类副作用在双活窗口内全部安全。
- **Reaper**：pool 每轮扫描 running 且租约过期的任务，用同一条围栏条件 UPDATE 原子判定：cancel_requested → cancelled；attempt 达 MAX_REPAIR_ROUNDS 或过 deadline（created_at+TASK_BUDGET_S）→ failed/UNRECOVERABLE；否则回 queued（attempt 不动，下次 claim 时 +1）。

### A.2 Session 串行

- **S1 串行不变量**：同 session 内前一任务到达终态前，后一任务不可 running——listRunnable 过滤与 reap 回队路径都必须满足（后一任务的等待者能看到 queued 状态而非死等）。
- **S2 历史事实源在网关**：attempt>0 或跨进程恢复时，注入**本会话全部已成功任务**的（问题 + 最终回答摘要 + result_ref 清单）+ **失败任务的问题文本**（模型知道问过什么、结果不可信）。网关事件表是历史唯一事实源，**不依赖 dsh 进程内会话记忆**——这使网关重启后恢复不赌 dsh 的行为。
- **S3 开放问题（Task 5 前置 spike，必须先测再写）**：dsh SDK 同 sessionId **跨进程重启**是否从 session.jsonl.zstd 恢复历史？无论结论如何 S2 的网关侧注入都实施——spike 结论只决定注入的冗余度（dsh 侧若自恢复则注入可精简为 result 清单；若不恢复则需含回答摘要）。禁止臆测，实测记录进 m0/findings/dsh-api.md §5。

### A.3 幂等

- **提交层**：client_submission_id 唯一约束；并发重复提交的 INSERT 冲突在同一事务内 catch 并 SELECT 返回原 run_id。
- **结果层（恰好一次发布）**：发布顺序强制 = 先写 publications、后翻 status=succeeded；两步之间崩溃由恢复路径先查 publications 兜底 → 崩溃安全的单次发布。publications 主键 run_id，INSERT OR IGNORE。
- **事件层**：seq 由单 SQLite 连接同步事务内 `MAX(seq)+1` 分配（better-sqlite3 同步调用天然原子单调）；SSE 重放 = listEvents(afterSeq)，客户端按 seq 去重。
- **取消与完成竞态**：终态写入是围栏条件写，先到先得，败者写被拒，done 事件 status 以胜者为准。cancel 请求只置 `cancel_requested` 标志（无执行权者不直接写终态），由 lease 持有者在下一个事件边界或 reaper 在租约过期时落地。

### A.4 恢复矩阵（谁发现 × 动作 × 去向）——Task 7 实现与 Task 9 验收的对照表

| 故障 | 发现者 | 动作 | 去向 |
|---|---|---|---|
| dsh 子进程死亡（API 持续故障/崩溃） | worker（exit 事件） | attempt<MAX 且未过 deadline → 新 attempt：同 session、注入已有 result_ref 清单（**不重查数**，spec §9"复用已保存查询结果"）；超限 | failed/UNRECOVERABLE |
| 网关进程死亡 | boot 自愈（A.1 L2'） | 强制过期全部 running 租约 → queued → 走恢复路径 | succeeded/failed（保历史） |
| worker 停滞（lease 过期被接管） | 新执行者/reaper | 旧执行者下一次写被围栏 → kill 自身进程树退出 | 双活窗口副作用安全（A.1） |
| 发布后崩溃（publications 已写、status 未翻） | 恢复路径第一步 | 读 publications → 直接置 succeeded，**不重跑** | succeeded |
| cancel 与完成同时到达 | 围栏终态写 | 先到先得，败者被拒 | 单一终态 + done.status=胜者 |
| 凭据无效/权限不足 | worker（错误分类识别） | 不走 attempt（重试无意义） | failed/CONFIG |

- **MAX_REPAIR_ROUNDS 语义** = 基础设施故障的 attempt 总上限（默认 3）；模型会话内自纠（M0 实证 7 次）发生在单个 attempt 内部，不占 attempt。
- **TASK_BUDGET_S** = 跨 attempt 总预算；`deadline` 列首次 claim 时固化，claim 与 heartbeat 时检查。

## Phase A — M1 前置与地基

### Task 1: ar-knowledge 应收口径沉淀（L1，知识库维护）

**Files:**
- Modify: `skills/ar-knowledge/references/metrics.md`（追加口径节）
- Modify: `skills/ar-knowledge/SKILL.md`（若需在正文路由提示中提及）

- [ ] **Step 1: 从 T14/T15 取证材料提取口径事实**

来源：`m0/verify/run_m0_e2e.md`（应收差异节）、`m0/verify/truncation_check.md`（金样口径 SQL vs dsh 自洽口径 SQL，含 result_ref 文件）、金样 `m0/golden/metrics.json` 指标 3 的 sql。整理两组事实：
1. 金样口径：dwr 应收账龄表 + 6 科目白名单 + 正余额过滤 → 33.63 亿/68.4%
2. 自洽口径：dm_ar_analysis_rpt_f 交叉验证 → 18.11 亿/80.0%（dsh 采用并在 limitations 声明）

- [ ] **Step 2: 写入 metrics.md 新节"应收余额与逾期率口径"**

内容要素（用知识库现有文档的表格风格）：两个口径各自的表/过滤条件/SQL 骨架/适用场景/已知分歧与建议（明确"生成经营分析报告时默认用自洽口径并声明"或按业务裁定——**若两者业务含义不同需在文档里讲清楚何时用哪个**，不确定处标注"待业务确认"而不是替业务拍板）；mix 表 calmonth='S' 脏数据陷阱一并写入（T14 模型自发排除的事实）。

- [ ] **Step 3: 验证**

对 metrics.md 新节里的每个 SQL 骨架用 mcp__dws__run_query 实跑一次确认可执行且数值与文档一致（33.63/18.11 两个数都要复现）。

- [ ] **Step 4: 提交**

```bash
git add skills/ar-knowledge/
git commit -m "docs(skill): ar-knowledge沉淀应收口径分歧与mix表陷阱(M0遗留L1)" -- skills/ar-knowledge/
```

---

### Task 2: dsh profile 配置脚本化（L3）

**Files:**
- Create: `engine-gateway/scripts/setup-dsh-profile.mjs`
- Create: `engine-gateway/scripts/profile-template/`（三段 patch 模板 + package.json 模板）

- [ ] **Step 1: 把 T16 记录 §8 的手工流程脚本化**

脚本职责（幂等，可重复跑）：
1. 读模板渲染 `~/.dsh/profiles/<name>/`（package.json + cordis.patch.yml 三段：mcp-dws 注册 / m0-exec-script bundle / 五工具禁用+customSkillDirs）
2. 本地 link 插件（pnpm install，等价 T13 的 `dsh plugin add` 产物但可重现）
3. 自检：`dsh --profile <name> --dump-config` 断言五个工具 disabled + exec_script + mcp__dws__* 在列（断言失败非零退出）
4. 支持 `--profile headless|sdk` 两个目标（M1 网关用 sdk；headless 保留给手工调试）

密钥红线：模板里 MCP env 用 `!!js process.env.DWS_PASSWORD` 表达式（T9 定型），值不落任何文件。

- [ ] **Step 2: 验证**

`node engine-gateway/scripts/setup-dsh-profile.mjs --profile sdk` 从零跑两遍（幂等性），第二遍后 dump-config 断言仍全过；再起一次 SDK 会话冒烟（initialize → 一条 prompt → turn/end）。

- [ ] **Step 3: 提交**

```bash
git add engine-gateway/scripts/
git commit -m "feat(m1): dsh profile配置脚本化—三段patch模板+幂等安装+自检断言(L3)" -- engine-gateway/scripts/
```

---

### Task 3: 受限只读 DB 账号集成位（L4 集成侧）

**Files:**
- Create: `engine-gateway/src/config/db-accounts.ts`（账号映射表，含 aiuser 兜底）

- [ ] **Step 1: 实现账号选择逻辑（纯函数 + 单测）**

```typescript
// 权限组 → DB 账号映射（spec §7 底线 2：运行账号与管理账号分开）
// 当前仅一个组：default → DWS_RUN_* env（未设时回退 aiuser 并在日志标 WARN）
export interface DbAccount { user: string; passwordEnv: string; note: string }
const ACCOUNTS: Record<string, DbAccount> = {
  default: { user: process.env.DWS_RUN_USER ?? "aiuser", passwordEnv: "DWS_RUN_PASSWORD", note: "受限只读运行账号；未建时回退 aiuser（WARN）" },
};
export function resolveDbAccount(scopeGroup: string): DbAccount { /* ... */ }
```
单测（node:test）：default 命中、未知组抛错、env 未设回退+WARN 标记。**DBA 建账号是用户侧行动项**——本任务只做集成位与回退逻辑，REPORT 跟踪到 M3 前完成切换。

- [ ] **Step 2: 提交**

```bash
git add engine-gateway/src/config/
git commit -m "feat(m1): DB账号映射与回退逻辑(L4集成位)" -- engine-gateway/src/config/
```

---

## Phase B — 网关核心（TDD）

### Task 4: 任务模型与 SQLite 持久层

**Files:**
- Create: `engine-gateway/src/store/schema.sql`
- Create: `engine-gateway/src/store/task-store.ts`
- Test: `engine-gateway/src/store/task-store.test.ts`

- [ ] **Step 1: schema（迁移式，v1）**

```sql
CREATE TABLE IF NOT EXISTS tasks (
  run_id TEXT PRIMARY KEY,             -- 任务ID（服务端生成）
  client_submission_id TEXT,           -- 幂等键（可空）
  session_id TEXT NOT NULL,            -- 逻辑对话（spec D14 三层模型）
  user TEXT NOT NULL, scope_group TEXT NOT NULL DEFAULT 'default',
  question TEXT NOT NULL,
  status TEXT NOT NULL,                -- queued|running|succeeded|failed|cancelled
  stage TEXT,                          -- queued|analyzing|querying|script_running|report_checking|repairing|publishing
  attempt INTEGER NOT NULL DEFAULT 0,  -- 执行尝试编号（D15 接管规则）
  lease_owner TEXT, lease_expires_at INTEGER,  -- 执行租约（A.1：owner+attempt 围栏）
  cancel_requested INTEGER NOT NULL DEFAULT 0, -- 取消标志（A.3：无执行权者只置标志）
  deadline INTEGER,                    -- created_at+TASK_BUDGET_S，首次 claim 固化（A.4）
  error_code TEXT, error_message TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(client_submission_id)
);
CREATE TABLE IF NOT EXISTS events (    -- 事件重放日志（递增编号，SSE 断线续传）
  run_id TEXT NOT NULL, seq INTEGER NOT NULL,
  type TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(run_id, seq)
);
CREATE TABLE IF NOT EXISTS publications (  -- 报告发布记录（恢复先查，防重复发布）
  run_id TEXT PRIMARY KEY, report_path TEXT NOT NULL, published_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
```

- [ ] **Step 2: task-store 接口与实现（node:test TDD：先写测试）**

接口（全部围栏条件写，见附录 A）：`createTask`（幂等：同 client_submission_id 返回原 run_id）、`getTask`、`fencedWrite`（内部：UPDATE ... WHERE run_id=? AND attempt=? AND lease_owner=?，rowcount=0 即失权信号）、`updateStage/status`（经 fencedWrite）、`appendEvent`（seq=MAX(seq)+1 同步事务分配，经 fencedWrite）、`listEvents(runId, afterSeq)`、`recordPublication`（INSERT OR IGNORE——二次发布静默拒绝并返回既有记录）、`claimLease(runId, workerId, ttlMs)`（原子 UPDATE ... WHERE lease 过期或无主 AND status='queued'，成功时 attempt+1、deadline 固化，返回是否获权——A.1 核心）、`heartbeat`（经 fencedWrite 续租）、`requestCancel`（只置 cancel_requested 标志，A.3）、`reapExpired`（附录 A.1 Reaper：围栏条件 UPDATE 原子判定 cancel/超限/回队）、`listRunnable`（queued 且同 session 无 running——A.2 S1，含 reap 回队路径满足）。

测试用例至少覆盖（附录 A 验收）：幂等创建（含并发重复提交）；事件 seq 递增与 afterSeq 重放；双 worker 竞争 claimLease 只一胜；**围栏写**：worker B 接管后 worker A 的 heartbeat/updateStage 被拒（rowcount=0）；publication 二次记录被拒；同会话第二任务不进 listRunnable 直到首个终态；**Reaper 三分支**：租约过期+cancel_requested→cancelled、attempt 达上限→failed/UNRECOVERABLE、否则回 queued；cancel_requested 与围栏终态写的竞态先到先得。

- [ ] **Step 3: 跑测试 → 提交**

```bash
cd engine-gateway && npm test
git add engine-gateway/src/store/ && git commit -m "feat(m1): 任务模型与SQLite持久层—幂等/事件重放/租约/发布记录(TDD)" -- engine-gateway/src/store/
```

---

### Task 5: DshBackend（SDK JSON-RPC 驱动 + 事件归一化）

**Files:**
- Create: `engine-gateway/src/backends/dsh-backend.ts`
- Create: `engine-gateway/src/backends/dsh-events.ts`（归一化）
- Test: `engine-gateway/src/backends/dsh-backend.test.ts`

- [ ] **Step 0: S3 spike——dsh SDK 同 sessionId 跨进程重启是否恢复历史（必须先测再写）**

`dsh --profile sdk` 会话 A 问一题（拿到事实 X）→ 正常 shutdown → **新进程**同 sessionId 再问"我上一问问了什么"。三种结局都记录进 m0/findings/dsh-api.md §5 并定注入冗余度：完整恢复（回答含 X→注入可精简）/ 部分恢复 / 不恢复（→A.2 S2 全量注入必需）。**禁止臆测。**

- [ ] **Step 1: DshSdkClient（对 T16 60 行驱动客户端的产品化）**

- spawn `dsh --profile sdk`（cwd=任务 workdir，env 注入 M0_* 四变量 + DWS 凭据 + DEEPSEEK_API_KEY）
- JSON-RPC stdio：initialize → `session/prompt`（sessionId=逻辑会话的持久 id：`gw-<session_id>`）→ 订阅 `session.event` 通知 → `turn/end` resolve
- 超时与 cancel：prompt 级超时（TASK_BUDGET_S）发 SDK 取消（若无取消方法则 kill 子进程树——按 Step 0 spike 一并实测），进程死亡检测（exit 事件 → 拒绝 pending promise）
- **单测不打真 dsh**：mock 子进程（fake stdin/stdout 按协议回放预制事件序列——用 T16 会话的真实事件结构做 fixture）

- [ ] **Step 2: 事件归一化 dsh-events.ts**

dsh `session.event` → spec §5 规范事件映射（集中一处，脏活不出模块）：
- `turn/start`+step 类 → `stage`（含 repairing 判定：attempt>0 时）
- tool/call + tool/result 中 name=mcp__dws__run_query → `sql` 事件（payload 带 row_count/truncated/result_ref——从 tool/result 文本 JSON 提取）
- `assistant/message` 终文 → `answer`
- turn/end reason=completed → 内部完成信号；异常 reason → error 映射（超时/引擎错误分类）
- 单测：fixture 事件序列 → 断言归一化输出序列（含 sql 事件的 result_ref 提取）

- [ ] **Step 3: DshBackend 组装（实现 spec BackendProvider 接口）**

```typescript
interface BackendProvider { id: string; createSession(opts: SessionOpts): Promise<EngineSession> }
interface EngineSession {
  ask(question: string): AsyncIterable<RawEvent>;   // 归一化事件流
  cancel(): Promise<void>;
}
```
createSession 职责：建任务 workdir（Temp 树外：`<GW_WORKROOT>/<run_id>/workdir` 与 `<run_id>/results`）、写 MCP env（RESULT_DIR 指向任务 results 子目录——衔接 D13 双通道）、spawn SDK 客户端。ask() 每次发 prompt 并流式 yield 归一化事件；cancel() 杀进程树。

- [ ] **Step 4: 跑测试（mock fixture 全绿）→ 提交**

```bash
git add engine-gateway/src/backends/ && git commit -m "feat(m1): DshBackend—SDK驱动/事件归一化/cancel(TDD,mock fixture)" -- engine-gateway/src/backends/
```

---

### Task 6: exec_script 存在性等待（M0 遗留改进）

**Files:**
- Modify: `m0/dsh-plugin/exec-script/exec-script.ts`

- [ ] **Step 1: 修 write→exec 同步间隙**

在 exec_script 执行前对 script 路径做存在性等待：最多等 2s（50ms 间隔轮询），超时保持现有错误（文件不存在）不变。这消掉 M0 T14 观察到的"首调必失败重试即恢复"（7 次浪费轮次）。加单测：先 exec 不存在文件（仍报错），touch 后立即 exec（2s 内成功）。

- [ ] **Step 2: 红队回归 + 真会话冒烟**

`bash m0/tests/sandbox_redteam.sh` 必须 4/4；一次 headless 会话走 write→exec_script 连续操作（不再出现 127）。

- [ ] **Step 3: 提交**

```bash
git add m0/dsh-plugin/exec-script/exec-script.ts
git commit -m "fix(m0-plugin): exec_script存在性等待—消write→exec同步间隙首调失败" -- m0/dsh-plugin/exec-script/exec-script.ts
```

---

### Task 7: 任务编排器（流水线 + 阶段化恢复）

**Files:**
- Create: `engine-gateway/src/orchestrator/task-runner.ts`
- Test: `engine-gateway/src/orchestrator/task-runner.test.ts`

- [ ] **Step 1: TaskRunner 状态机（spec §5 流水线 + §9 恢复表；不变量与恢复矩阵见附录 A）**

职责（对单个 run_id）：
1. claimLease 获权（attempt+1、deadline 固化）→ stage=running；此后**一切状态写经 fencedWrite**（失权即 kill 自身 dsh 进程树并静默退出——A.1 L1）
2. **恢复入口**（attempt>0）：①先查 publications（已发布→直接置 succeeded，不重跑——A.4）；②注入历史（A.2 S2：本会话全部已成功任务的问题+回答摘要+result_ref 清单，失败任务仅问题文本）到新会话首条 prompt 前缀；③S3 spike 结论决定注入冗余度
3. 驱动 DshBackend.ask()：归一化事件 → appendEvent（围栏写）→ 同时喂 SSE 广播器；检查点=每个事件（无额外快照机制——事件表即保存点）
4. 阶段化重试（按附录 A.4 矩阵）：dsh 子进程死亡/网络类基础设施故障 → 新 attempt（同 session 续跑，注入已有 result_ref 清单，不重查数）；SQL/脚本错误 → 不占 attempt（模型会话内自纠，M0 实证）；凭据类 → 直接 failed/CONFIG 不重试；cancel_requested → 在事件边界落地 cancelled
5. 终态三分类（围栏条件写先到先得）+ done 事件带 status；**发布顺序 = 先 recordPublication 后翻 succeeded**（A.3 结果层）
6. 报告发布：产物从 workdir 拷贝到 `reports/<user>/`（发布检查：HTML 非空 + 无外链 CDN）→ recordPublication（幂等）；沙箱容器名含 `<run_id>-a<attempt>`（接管清理不误杀——A.1）

- [ ] **Step 2: 单测（mock Backend；用例覆盖附录 A.4 恢复矩阵每一行）**

正常完成流（事件全落库+done+发布顺序断言）；dsh 子进程死亡（A.4 行1：attempt<MAX 新 attempt 续跑注入 result_ref、超限 failed/UNRECOVERABLE）；网关重启恢复（行2：boot 自愈后 queued→恢复路径）；worker 停滞被接管（行3：旧 worker 围栏写被拒后 kill 自身进程树——用 mock 子进程断言 kill 调用）；发布后崩溃（行4：不重跑直接 succeeded）；cancel 与完成竞态（行5：先到先得单一终态）；凭据无效（行6：直接 failed/CONFIG 零 attempt 消耗）。

- [ ] **Step 3: 跑测试 → 提交**

```bash
git add engine-gateway/src/orchestrator/ && git commit -m "feat(m1): 任务编排器—流水线/阶段化恢复/幂等发布/终态三分类(TDD)" -- engine-gateway/src/orchestrator/
```

---

### Task 8: HTTP/SSE 服务层 + 排队与限流

**Files:**
- Create: `engine-gateway/src/server/http.ts`
- Create: `engine-gateway/src/server/worker-pool.ts`
- Test: `engine-gateway/src/server/http.test.ts`

- [ ] **Step 1: worker-pool（spec D7：提交/执行分离）**

并发上限 MAX_CONCURRENT_TASKS（默认 3）；loop：listRunnable → 有空位则 claimLease 并派 TaskRunner；无空位等待。同会话串行由 listRunnable 保证（Task 4）。

- [ ] **Step 2: HTTP 端点（node:http，spec §5）**

- `POST /api/tasks`：Bearer AUTH_TOKEN 校验 → createTask（幂等）→ 201 {run_id, session_id}；队列满 → 429 RATE_LIMIT
- `GET /api/tasks/:id`：属主校验（task.user === req.user）→ 状态 JSON
- `GET /api/tasks/:id/events`：SSE；`Last-Event-ID`+查询参数 afterSeq 双通道；服务端从 events 表重放后挂实时流；心跳注释行 15s
- `GET /api/health`：{ok, queue_depth, running}
- 限流：按 user 的 QPM（内存计数）+ 并发会话数
- **user 身份**：暂从 Authorization 侧信道取（`X-User` 头，claudecodeui 可信后端设置——spec §6.3：不信浏览器直传；网关与 claudecodeui 间的内网信任边界在 A1 对接时按其认证机制细化，先留接口）

- [ ] **Step 3: 集成测试（in-process：真 SQLite 内存库 + mock Backend）**

提交→排队→running→事件流（SSE 客户端收到 stage/sql/answer/done）；断线重连（记录 seq，重连带 Last-Event-ID 收到补发且不重复）；幂等重提交（同 client_submission_id 返回原 run_id）；限流 429；跨 user 访问 403。

- [ ] **Step 4: 提交**

```bash
git add engine-gateway/src/server/ && git commit -m "feat(m1): HTTP/SSE服务层+工作进程池+限流(TDD)" -- engine-gateway/src/server/
```

---

## Phase C — 端到端与放行

### Task 9: 真实 dsh 端到端（网关全链路）

**Files:**
- Create: `engine-gateway/test/e2e.test.ts`（标记 live，默认跳过：`E2E_LIVE=1` 才跑）
- Create: `engine-gateway/test/e2e-faults.md`（故障注入记录）

- [ ] **Step 1: live E2E 基线**

起网关（环境：DWS 凭据 + DEEPSEEK_API_KEY + GW_WORKROOT）→ HTTP 提交金样域的一个真实问题（inventory 简单题，eval 场景原文）→ SSE 收全套事件 → 终态 succeeded → 产物落位。记录耗时与事件数。

- [ ] **Step 2: 故障注入五发（spec §11.4 固定用例 + A.1 双活窗口）**

1. **提交响应丢失重试**：客户端不读响应重发同 client_submission_id → 断言同 run_id、无重复任务
2. **工作进程退出接管**：running 中 kill 网关进程（模拟）→ 重启 → 断言新 attempt 接管、无双实例（lease 机制）、任务最终 succeeded
3. **发布前后中断**：报告已 recordPublication 但任务未终态时重启 → 断言不重复发布、直接 succeeded
4. **SSE 断线重连**：中途断开 → 重连带 Last-Event-ID → 断言事件无丢失无重复（前端按 seq 去重语义）
5. **双活窗口（附录 A.1 构造性验证）**：人为冻结 worker A 心跳使其租约过期 → worker B 接管开跑 → 解冻 A：断言 A 的下一次状态写被围栏拒绝、A kill 自身进程树、最终**唯一**产物（publications 仅一条、reports/ 无第二副本、事件流无 A 的 attempt-1 重复段）

每发：注入方式/观察/判定 PASS-FAIL 记入 e2e-faults.md。**五发全部 PASS = M1 放行条件"可恢复故障用户无需手动接续 + 只产生一个结果"的证明材料。**

- [ ] **Step 3: 提交**

```bash
git add engine-gateway/test/ && git commit -m "test(m1): live E2E+故障注入四发—幂等/接管/单次发布/断线续传" -- engine-gateway/test/
```

---

### Task 10: 并发冒烟（连续多批次混合画像）

**Files:**
- Create: `engine-gateway/test/soak.md`

- [ ] **Step 1: 混合批次（spec §10）**

脚本化 3 批 × 每批 4 任务（共 12）：混合简单问数（2）/复杂报告（1，可复用 T14 简化版提问）/多轮追问（1，三连问缩为两问）。池上限 3 → 验证排队可见（queued stage 事件）、不同 user 不串数据（各任务产物/事件独立）、单任务失败不拖垮池（注入一个必失败任务）、结束后 workdir/dsh 进程/Docker 容器/DB 连接全部清理（进程与容器清单前后对照）。

- [ ] **Step 2: 记录与提交**

队列深度曲线、各任务耗时分布、清理核验清单 → soak.md。

```bash
git add engine-gateway/test/soak.md && git commit -m "test(m1): 并发冒烟—混合批次/排队可见/隔离/资源清理" -- engine-gateway/test/soak.md
```

---

### Task 11: M1 报告与放行核对

**Files:**
- Create: `docs/superpowers/reports/2026-09-09-m1-report.md`

- [ ] **Step 1: 放行核对（spec §12 M1：出现可恢复故障时用户无需手动接续）**

| 条件 | 证据 |
|---|---|
| 故障注入四发全 PASS | Task 9 e2e-faults.md |
| 并发冒烟画像通过 | Task 10 soak.md |
| 单测全绿（store/backends/orchestrator/server） | npm test |
| 红队回归 4/4（Task 6 改动后） | sandbox_redteam.sh |
| L1/L3 完成、L4 集成位就绪 | Task 1/2/3 |

- [ ] **Step 2: 遗留与移交（claudecodeui 对接清单——A1 跨仓依赖的交接文档）**

网关 API 契约（端点/事件/SSE 语义/错误码）、部署要求（env 清单/GW_WORKROOT/沙箱镜像/profile 脚本）、claudecodeui 侧改造点（调用地址、断线重连、状态展示——按 spec §4"改动范围 M0 对接验证后确定"精神，这里给出对接验证步骤）。

- [ ] **Step 3: 提交 + 与用户过报告定 M2**

---

## 自审记录

1. **Spec 覆盖（M1 范围）**：§5 端点/三层会话/持久化/事件/配置 → T4/T5/T7/T8；§9 恢复表六行 → T7（进程死亡新 attempt/SQL 会话内自纠/断线重连 T8/T9/凭据停止重试 T7 终态）；D15 五行情景 → T4（幂等/lease/publication/seq）+T9（四发实证）；§10 排队/池/串行/清理 → T8/T10；§12 M1 放行 → T9/T11。L1→T1、L3→T2、L4→T3。claudecodeui 对接按 A1 留交接（T11 Step 2）。
2. **占位符扫描**：无 TBD；dsh SDK 取消机制一处标注"按 SDK 实测补"（T5 Step 1）——这是 M0 发现记录中未覆盖的缺口，实施时先实测再写，不允许臆测。
3. **类型一致性**：BackendProvider/EngineSession（T5）与 spec §5 接口一致；task-store 接口名在 T4/T7/T8 引用一致（createTask/claimLease/appendEvent/listRunnable/recordPublication）；规范事件六类贯穿 T5/T7/T8。
