# M2-T8 对接契约固化（自建 UI 方向）

> 背景：用户裁定 **不用 claudecodeui，自建 UI**（独立仓 dataplat-ui，v1 = 最小问数体验）。
> 本文档取代 M1 报告"claudecodeui 对接清单"节，是 **网关 ↔ UI BFF 的唯一对接契约**。
> 事实源 = `engine-gateway/src/server/http.ts` + `src/orchestrator/task-runner.ts`（本文件与其冲突时以代码为准，改契约须双改）。

## 1. 拓扑与信任边界

```
浏览器（React SPA，cookie 会话）
   ▼ 只信 cookie
UI BFF（Node/Express，dataplat-ui 仓）
   ├─ 账号表（SQLite+bcrypt）→ 登录态
   ├─ 注入 Authorization: Bearer <AUTH_TOKEN> + X-User: <登录名> → 转发网关
   └─ 报告静态服务（属主校验）
   ▼ 内网服务边界
engine-gateway（本仓）→ dsh → DWS
```

- **网关凭证（AUTH_TOKEN）只存在于 BFF 进程 env**，浏览器永不可见。
- **X-User 是网关唯一身份来源**（spec §6.3）：body 内 `user` 字段即使携带也被忽略；缺 X-User → 400。BFF 从登录态生成，绝不信浏览器直传。
- `/api/health` 免鉴权（探活只暴露队列水位，无任务数据）。

## 2. 端点契约

### POST /api/tasks — 提问（创建任务）

请求头：`Authorization: Bearer <token>`、`X-User: <登录名>`、`Content-Type: application/json`

请求体（≤1MB）：

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| `question` | string | 是 | 问题全文（trim 后非空） |
| `session_id` | string | 否 | 缺省 = 首次提问，服务端开新逻辑会话并在响应回显 |
| `client_submission_id` | string | 否 | 幂等键（见 §5） |
| `scope_group` | string | 否 | 数据账号分组（预留，v1 不用） |

响应：

- `201 {run_id, session_id}` —— **幂等重放时同样 201**，`run_id` 是原任务，`session_id` 回读原任务值（不是请求侧回显——响应丢失重试场景 body 不带 session_id，回显会开出幽灵会话）。
- `400 BAD_REQUEST`（缺 X-User / question 缺失 / 类型错 / JSON 非法）
- `401 UNAUTHORIZED`（Bearer 错）
- `413`（body 超 1MB）
- `429 RATE_LIMIT`（全局队列满 **或** 该 user 超 QPM——两种都是这个码，message 区分）

### GET /api/tasks/:run_id — 任务状态

响应 `200`（字段白名单，无 error_message——stderr 红线，审计走库）：

```json
{ "run_id": "...", "session_id": "...", "status": "queued|running|succeeded|failed|cancelled",
  "stage": "...", "attempt": 2, "error_code": "TIMEOUT|ENGINE_ERROR|CONFIG|REPORT_CHECK|CLEANUP_RECOVERY_REQUIRED|null",
  "created_at": "...", "recovery_required": true }
```

- `recovery_required` 是**可选字段**：仅 Linux isolated 且当前确实处于 cleanup `recovery_required`
  时出现且为 `true`；off/Windows/正常任务的响应 JSON 形状不变。它不等同于任务终态，终态仍以
  `status` 为准。
- `404 NOT_FOUND`；`403 FORBIDDEN`（任务属主≠X-User——BFF 透传即可，同账号多标签页不受影响）。

### GET /api/tasks/:run_id/events — SSE 事件流（§4）

### GET /api/health — 探活（免鉴权）

`200 {ok: true, queue_depth: N, running: M}`

## 3. 生命周期与状态机

```
queued ──→ running ──→ succeeded | failed | cancelled
```

- 同 session 内任务**严格串行**（后到的排队，前序终态才轮到它）——UI 无需也无法干预顺序。
- `attempt` >1 且出现 `stage: repairing` = 服务端故障恢复中（对用户可展示"恢复中"，结果语义不变）。
- Linux isolated 的 cleanup hold 进入 `recovery_required` 时，任务状态不一定改变：可能仍为
  `running`（等待人工清理确认），也可能已有真实 `failed`/`cancelled` 业务终态。该状态不是任务
  状态机的新终态，SSE 通过 §4.1 的 code-only error 通知；禁止自动重试或直接改库放行。
- `recovered: true` 的 done = 本任务经历过接管重试（UI 可加角标，非必须）。
- 单任务预算默认 1800s（TASK_BUDGET_S），超时终态 failed/`TIMEOUT`。

## 4. SSE 语义（D15 断线重连）

帧格式：

```
id: <seq>              ← 正常事件为任务内单调 seq（events 表 PK）；§4.1 的 recovery 通知为保留区合成游标
event: <type>          ← 六类词表见 §6
data: <json>

: ping                 ← 心跳注释行，每 15s（不是事件，解析时跳过 : 开头行）
```

- **重连双通道**：`Last-Event-ID: <seq>` 头（EventSource 自动带）优先，`?after=<seq>` 查询参兜底。重连后服务端先**全量补发** `seq > after` 的历史事件，再进入实时推送——**不重不漏，客户端无需去重**（按 seq 天然连续）。
- 正常终态：`done` 事件发出后**服务端主动关流**。
- 异常终态（reaper 收尾，无 done 事件）：流静默结束——客户端以 `GET /api/tasks/:id` 的 `status` 兜底判终态。
- **浏览器原生 EventSource 不能设自定义头** → BFF 必须代理 SSE 端点（登录态换 X-User 后透传），不能让浏览器直连网关。代理时禁用响应缓冲（nginx `proxy_buffering off` 同理），心跳行可助中间层保活。

### 4.1 Linux isolated：cleanup `recovery_required` 通知

仅在 cleanup hold 模式（显式 `linux_isolated`）启用；Windows/off 分支不读 `cleanup_holds`，行为与旧版完全一致。

- 当当前 attempt 的持久化 hold 为 `recovery_required` 时，服务端在已重放事件之后发送一条
  `event: error`，payload 固定为 `{"code":"CLEANUP_RECOVERY_REQUIRED","run_id":"<id>"}`
  （code-only，无 message/路径/审计详情），随后主动关流。
- 通知的 SSE id 是**保留区合成游标**，不是 events 表 seq：

```text
id = 1_000_000_000 + 通知时的真实 lastSeq     （保留区 [1_000_000_000, 1_999_999_999]）
```

  - 真实事件 seq 必须远低于 `1_000_000_000`；越界属协议损坏。
  - EventSource 自动重连带 `Last-Event-ID`（或 `?after=`）回到网关时：
    - 任务**仍**处于 `recovery_required` → **HTTP 204**，终止自动重连；
    - hold 已解除/人工恢复 → 服务端从合成 id **还原真实 lastSeq**，继续补发 `seq > lastSeq`
      的真实事件，不会因为合成值高于全部真实 seq 而漏事件。
  - 204 只用于“合成游标 + 当前确实 recovery”的组合；普通高 seq、非合成游标、已解除 hold
    一律不得返回 204。服务端绝不通过无条件 204 隐藏已恢复任务的真实状态。
  - 保留区之外、超过真实 seq 上限的游标视为协议损坏：cleanup 模式从 seq 0 重放（宁可重复，
    不丢事件），不会把该值当作合成标记。
- 客户端**不得**把保留区 id 当普通 seq 计算、加一或落成业务游标；客户端若重建全新 EventSource，
  可不带 Last-Event-ID（从 seq 0 全量重放），也可透传旧合成 id 由网关还原断点。
- 若真实事件 seq 已进入保留区（协议损坏），网关拒绝编码合成 id，记录服务端错误并直接收尾
  关流；不发送无法安全重连的合成通知，不抛未捕获异常。GET 仍可通过 `recovery_required`
  观察恢复状态，任务状态不被改写。
- 若任务已有真实的业务 `done`（如 cleanup 证据失败导致的 `failed`/`cancelled`），该 done 原样
  保留，recovery error 在其后补发；绝不改写为 `succeeded`，也不伪造 done。旧客户端若在 done
  后立即关流，仍可用 `GET /api/tasks/:run_id` 的 `status` + 可选 `recovery_required=true`
  识别“业务终态 + 仍需资源恢复”并存。
- 服务端不修改任务状态、不触发自动重试。任务行可能仍为 `running`（例如 boot/reaper 恢复），
  `GET` 会返回 `error_code: "CLEANUP_RECOVERY_REQUIRED"` 与 `recovery_required:true`；也可能
  已是真实 `failed`/`cancelled`，但 hold 仍等待人工清理确认。
- **客户端兼容要求**：新 UI/BFF 必须按 `CLEANUP_RECOVERY_REQUIRED` 映射“任务中断，等待恢复”
  文案，并允许 error payload 不含 `message`；旧客户端应至少将其识别为 `error`，不得当作成功。
  BFF 必须保留 SSE `id:` 帧、透传 `Last-Event-ID`，并把 204 作为正常停止信号而不是自行重连。

## 5. 幂等（A.3 提交层）

- `client_submission_id` 是 **tasks 表全表 UNIQUE，无 TTL，不分 user**。
- **BFF 生成规则（契约级要求）：`<user>-<uuid>`**——纯 uuid 跨用户碰撞概率极低但属未定义行为，加 user 段封闭命名空间。
- 语义：网络超时/响应丢失后**原样重发**（同 question + 同 submission_id）→ 返回原 run_id，不产生第二个任务。UI 的"重试提问"按钮若想真的重跑（而非网络层重试）→ 生成**新** submission_id。
- 事件层幂等由 seq 重放保证（§4），两层独立成立。

## 6. 事件词表（六类，冻结——扩展须改契约）

| event | payload | UI 用途 |
|---|---|---|
| `stage` | `{stage, text?, attempt?}` | 进度条/状态文案 |
| `sql` | `{sql, rows, truncated, result_ref?, elapsed_ms}` | 过程折叠条："查询中…N 行"；`result_ref` = 落盘结果文件名（D13 双通道，可下载明细） |
| `answer` | `{markdown}` | 最终回答正文（Markdown 渲染，**须白名单 sanitize**） |
| `report` | `{path}` | 报告产物相对路径（发布成功后才发） |
| `error` | `{code, message}`；§4.1 的 recovery 通知例外：仅 `{code, run_id}` | 失败原因（code 见 §2 GET 端点；recovery code-only 见 §4.1） |
| `done` | `{run_id, status, engine, elapsed_ms, tokens, recovered}` | 终态：关流 + 计费展示（tokens `{input, output, cache_read}` 或 null） |

`stage` 词表：`queued | analyzing | querying | script_running | report_checking | repairing | publishing`

建议文案映射（UI 侧自由）：analyzing=理解问题 / querying=查询数据 / script_running=运行脚本 / report_checking=生成报告 / repairing=恢复中 / publishing=发布报告。

## 7. 会话模型（D14）

- `session_id` = 逻辑会话（网关 SQLite 持久），同会话历史（问题+回答摘要+result_ref 清单）在**每次执行**时自动注入引擎——BFF/前端零参与。
- 追问 = 带 `session_id` 再 POST；跨进程重启/网关宕机恢复后历史不丢（事实源=事件表）。
- 会话列表/重命名等是 **UI 侧概念**，网关不管理会话元数据（BFF 自建表关联 session_id 即可）。

## 8. 报告访问

- `report` 事件的 `path` 指向网关 `GATEWAY_REPORTS_DIR` 下产物（按 session 归档）。
- 浏览器**不可直读网关盘**：BFF 提供 `/reports/...` 静态路由，**必须按任务属主校验**（从 run_id/session_id 反查 user，非登录用户本人的 403）。
- HTML 报告是引擎生成的不可信内容：BFF 静态服务加 `Content-Security-Policy` 响应头收紧，下载走 `Content-Disposition: attachment`。

## 9. 部署耦合清单（BFF 需要的环境/约定）

| 项 | 值/来源 |
|---|---|
| 网关地址 | `GATEWAY_URL`（BFF env，同机部署默认 127.0.0.1:GATEWAY_PORT） |
| 服务 token | `AUTH_TOKEN`（BFF env，与网关一致） |
| 报告根目录 | 与网关 `GATEWAY_REPORTS_DIR` 同机只读访问 |
| 健康检查 | BFF 探活页可透传 `/api/health`（免鉴权，不透任务数据） |

## 10. 复验记录（2026-09-18，M2-T8）

| 项 | 结果 |
|---|---|
| shot1 提交幂等（响应丢失重试 → 同 run_id 无第二行） | **PASS**（wall 101s，真 dsh/DeepSeek/DWS） |
| shot4 SSE 断线重连（Last-Event-ID → 不重不漏） | **PASS**（wall 66.5s；断在 seq 3，重连补发 3+21 事件，seq 连续无重复） |

运行方式：`cd engine-gateway && E2E_LIVE=1 E2E_SHOT=shotN node --test test/e2e.live.test.ts`（各 shot 自起临时网关，随机端口，独立 DB/工作树）。

**注意：必须串行跑**——shot 收尾的 `killAllEngineProcs` 按进程名全机扫杀 dsh（单发独占假设），并行跑会互相杀引擎（2026-09-18 实测教训：并行时 shot4 清理器杀掉 shot1 在跑的引擎、并把对方进程计为残留断言失败；shot1 靠租约恢复机制仍 PASS，shot4 串行重跑后 PASS）。
