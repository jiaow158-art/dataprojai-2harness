# dataplat-ui v1 设计 spec（自建问数 UI）

> 日期：2026-09-18。brainstorm 四要素已定（最小问数体验 / 内置账号表 / React+Vite / 独立仓库），架构方案已获用户批准。
> 对接唯一契约：`dataprojai-2harness/docs/superpowers/reports/2026-09-16-m2-integration-check.md`（网关 API/SSE/幂等/事件词表）。

## 1. 定位与范围

替代 claudecodeui 成为问数系统唯一用户入口；v1 = **最小问数体验**，服务 M3 内部白名单试点：

**做**：登录 / 提问（对话流 SSE 实时过程+答案）/ 同会话追问 / 会话列表与切换 / 报告预览与下载 / 排队与失败状态可见。
**不做（记非目标）**：角色细粒度权限（M4+）、移动端适配、多语言、管理员 Web 界面（账号走 CLI）、会话分享、历史搜索。

## 2. 架构（三层，职责干净）

```
浏览器 React SPA（cookie 会话）
   ▼ 仅信 cookie
UI BFF（Express，本仓 server/）
   ├─ 账号表 users + 会话记账（SQLite, better-sqlite3）
   ├─ 登录/登出（bcryptjs + httpOnly cookie + 随机 token）
   ├─ 反代网关 /api/tasks*（注入 Bearer + X-User；SSE 无缓冲透传）
   └─ 报告静态服务（属主校验 + 路径遏制 + CSP）
   ▼ 内网
engine-gateway（零改动）→ dsh → DWS
```

- 网关 `AUTH_TOKEN` 只在 BFF 进程 env；浏览器永不可见。
- **BFF 必须代理 SSE**（EventSource 不能设自定义头），代理禁用响应缓冲。
- BFF 是 UI 域的数据记账方（会话标题、消息历史索引）；**任务/事件的事实源仍是网关**——BFF 重启丢记账不影响任务正确性，只影响历史回显（v1 接受，记 §8）。

## 3. 认证（内置账号表）

- `users(username PK, password_hash, created_at)`；bcryptjs（纯 JS，免 Windows 原生编译）。
- 账号由管理员 CLI 创建：`npm run admin:add <username>`（交互输密码，二次确认）。
- 登录成功发 cookie：`sid=<128bit 随机>`，httpOnly + SameSite=Lax + 7 天过期；`sessions(token, username, expires_at)` 服务端可吊销。
- 登出 = 删 sessions 行 + 清 cookie。所有 /api/*（除 /api/auth/login、/api/health）要求有效会话。

## 4. BFF API 面（浏览器所见）

| 端点 | 方法 | 语义 |
|---|---|---|
| `/api/auth/login` `/logout` | POST | 账号会话 |
| `/api/me` | GET | 当前用户（前端启动探测） |
| `/api/sessions` | GET / POST / PATCH / DELETE | UI 会话列表（BFF 记账表：标题=首问前 30 字，可重命名） |
| `/api/ask` | POST | `{question, session_id?}` → BFF 生成 `client_submission_id = <user>-<uuid>` 转发网关 → `{run_id, session_id}` |
| `/api/tasks/:id`（含 `/events`） | GET | 透传网关（SSE 无缓冲管道） |
| `/api/reports` | GET | `?run_id=` 属主校验后返回报告 HTML（预览）；`&download=1` 加 attachment |

## 5. 前端（React + Vite + TS + Tailwind）

两屏：登录页 / 主页（单页三区）：

- **左栏**：会话列表（新建/切换/重命名/删除=仅删记账，不动网关）
- **主区对话流**：用户问题 + 回答气泡（react-markdown + rehype-sanitize 白名单渲染）；**过程折叠条**实时驱动（stage → 文案映射、sql → "查询中…N 行"可展开看 SQL、report → 报告卡片：预览/下载）；attempt>1 显示"恢复中"角标
- **状态条**：排队中（GET /api/tasks 轮询兜底）/ 进行中计时 / 断线重连中（EventSource onerror 自动重连带 Last-Event-ID）/ 失败（error code + 「重试」= 新 submission_id 重发）

多轮追问 = `/api/ask` 带 session_id；历史注入是网关 D14 语义，前端零参与。

## 6. 安全（继承 spec §6.3 + 红队教训）

1. X-User 一律由 BFF 从登录态注入，不信任何前端载荷。
2. markdown/SQL 文本渲染走 sanitize 白名单（防存储型 XSS——红队 file_read 教训：引擎输出不可信）。
3. 报告属主校验：run_id → BFF 记账 user == 当前登录 user，且以该 user 身份 GET 网关任务（403 二次确认）后才读文件。
4. 报告路径遏制（resolve 后必须在 GATEWAY_REPORTS_DIR 内，防 `../`）；响应加 `Content-Security-Policy` + `X-Content-Type-Options: nosniff`；预览 iframe `sandbox="allow-scripts"`。
5. 登录失败统一慢响应（计数防爆破，v1 简单限速即可）。

## 7. 错误处理与状态映射

- 429 两种含义（队列满 / QPM 超）透传文案区分。
- done 后关流；流静默结束（reaper 终态）→ 前端 GET /api/tasks/:id 兜底判终态。
- 失败重试按钮：**网络层重试**（同 submission_id 原样重发，幂等返回原 run_id）与**真重跑**（新 submission_id）分开——UI 只暴露"重新提问"（新 id）。
- 网关不可达：BFF 502 + 前端"引擎维护中"态。

## 8. v1 已知限制（记录，不算缺陷）

- BFF 记账非事实源：BFF 宕机期间完成的任务，历史回显可能缺尾（任务与产物不受影响）。
- 会话删除只删 UI 记账；网关侧任务数据按网关自身策略保留。
- 单机部署（与网关同机文件系统访问报告目录）；服务器 Linux 化时改 env 即可（无 Windows 专有依赖）。

## 9. 技术栈与仓库

- 独立仓库 `dataplat-ui`（本地 `D:\dataplat-ui`，git init；部署目标与网关同机 Linux）。
- 前端：React 18 + Vite + TypeScript + Tailwind；原生 EventSource/fetch，无重状态库（v1 用局部状态 + 少量 context）。
- BFF：Node 24 + Express 5 + better-sqlite3（与网关同栈）+ bcryptjs；node:test 单测（风格对齐 engine-gateway）。
- 端口约定：BFF `58090`（env 可改），Vite dev `5173` proxy → BFF；`GATEWAY_URL` 默认 `http://127.0.0.1:58080`。

## 10. 验收（v1 完成定义）

1. BFF 单测全绿：登录/会话/属主校验/路径遏制/submission_id 规则/SSE 透传（mock 网关）。
2. E2E 对手动网关（manual-token 台）跑通一轮：登录 → 提问 → 实时过程 → 答案 → 追问 → 生成报告 → 预览/下载 → 断网重连续显。
3. 红线核查：浏览器 devtools 全程看不到网关 Bearer；他人 run_id 报告访问 403。
