# dataplat-ui v1 建仓实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 `docs/superpowers/specs/2026-09-18-dataplat-ui-v1-design.md` 建成 dataplat-ui 独立仓（本地 `D:\dataplat-ui`），交付最小问数体验：登录 → 提问（SSE 实时过程）→ 答案 → 追问 → 报告预览/下载，对手动网关 E2E 验收全绿。

**对接契约：** `dataprojai-2harness/docs/superpowers/reports/2026-09-16-m2-integration-check.md`（事件词表/幂等/SSE 语义——实现前必读，冲突以契约为准）。

**Tech Stack:** React 18 + Vite + TS + Tailwind（前端）；Node 24 + Express 5 + better-sqlite3 + bcryptjs（BFF）；node:test + vitest。

**红线（全程有效）：**
- 网关 AUTH_TOKEN 只进 BFF env，不进任何前端代码/网络响应
- markdown/SQL 渲染必须 sanitize 白名单；报告服务必须属主校验+路径遏制
- client_submission_id = `<user>-<uuid>`（契约 §5）
- 不改 engine-gateway（契约冻结；发现网关侧缺口 → 记录上报，不擅改）

---

### Task 1: 建仓骨架
- [ ] `D:\dataplat-ui` git init；目录 `server/`（BFF 源码+测试）、`web/`（Vite app）、`README.md`（启动方式/env 表）
- [ ] `web/`：Vite react-ts 模板 + Tailwind 接入 + dev proxy（5173→58090）
- [ ] `server/`：Express 骨架 + env 读取（GATEWAY_URL/AUTH_TOKEN/PORT/DATA_DIR/REPORTS_DIR）+ /api/health
- [ ] 验证：`npm run dev`（两端）起得来，/api/health 返回 ok → init commit

### Task 2: 账号与会话（BFF，TDD）
- [ ] `server/db.ts`：SQLite 初始化（users/sessions/ui_sessions/messages 记账表，WAL）
- [ ] 失败测试先行：login 成功/失败/慢响应限速、cookie 会话有效/过期/吊销、/api/me
- [ ] 实现 + 测试全绿；`npm run admin:add <user>` CLI（bcryptjs 哈希，交互输密码）
- [ ] 验证：curl 登录拿 cookie → 访问受保护端点 401/200 分支正确 → commit

### Task 3: 网关反代 + ask 提交（BFF，TDD）
- [ ] 失败测试先行（mock 上游）：`/api/ask` 注入 Bearer+X-User、submission_id 规则、429/400/401 透传、`/api/tasks/:id` GET 属主透传
- [ ] 实现：转发层（http.request 管道）；ask 后写 messages 记账行（run_id/session_id/question）
- [ ] 验证：测试全绿 + 对手动网关实发一问（真实链路冒烟，用测试账号）→ commit

### Task 4: SSE 代理（BFF，TDD）
- [ ] 失败测试先行（mock SSE 上游）：无缓冲透传、Last-Event-ID/?after= 透传、done 后随上游关流、上游断开时客户端可重连恢复
- [ ] 实现：`/api/tasks/:id/events` 流式管道（flushHeaders + chunk 透传，不聚合）
- [ ] 顺带记账：SSE 途经的 answer/report/done 摘要写 messages（历史回显数据源）
- [ ] 验证：测试全绿；curl -N 对手动网关收一路完整事件 → commit

### Task 5: 登录页 + 应用壳（前端）
- [ ] 登录屏（用户名/密码/错误提示/慢响应态）+ /api/me 启动探测 + 登出
- [ ] 主页三区骨架（左栏会话列表 / 主区对话流 / 底部输入框），Tailwind 深色主题对齐报告风格
- [ ] 会话 CRUD 接 ui_sessions（新建/切换/重命名/删除）
- [ ] 验证：手动走查登录→建会话→切会话不串内容 → commit

### Task 6: 对话流与 SSE 消费（前端核心）
- [ ] `/api/ask` 提交 → EventSource(`/api/tasks/:id/events`)；六类事件渲染：stage 文案映射 / sql 折叠条（行数+可展开 SQL）/ answer 气泡（react-markdown + rehype-sanitize）/ report 卡片 / error / done（计时+tokens）
- [ ] 状态条：排队（GET 轮询兜底）/ 进行中计时 / onerror→"重连中"（EventSource 自动重连带 Last-Event-ID）/ reaper 终态兜底
- [ ] 失败"重新提问"= 新 submission_id；追问带 session_id；attempt>1 "恢复中"角标
- [ ] 历史回显：切会话时从 messages 记账渲染既有问答
- [ ] 验证：对手动网关真实一轮（含追问）→ commit

### Task 7: 报告预览与下载（BFF+前端）
- [ ] BFF `/api/reports?run_id=`：属主校验（记账 user + 以该 user GET 网关任务二次确认）→ 路径遏制 → CSP/nosniff 头 → download 参数 attachment
- [ ] 失败测试先行：非属主 403、路径穿越拒绝、正常返回 HTML
- [ ] 前端报告卡片：新窗预览（sandbox iframe）+ 下载按钮
- [ ] 验证：测试全绿 + 真实报告预览/下载走查 → commit

### Task 8: E2E 验收 + 收尾
- [ ] 验收脚本 `server/test/e2e.manual.md`：起网关（manual env）→ 起本 UI → 走 spec §10 三条（含断网重连续显：devtools 断网 10s 恢复）
- [ ] 红线核查：浏览器网络面板全程无网关 Bearer；他人 run_id 报告 403（第二测试账号）
- [ ] README 补 env 表与部署说明（本地 Windows 先行，服务器 Linux 仅 env 差异）
- [ ] 全部勾完 → 最终 commit + 在 dataprojai-2harness 记验收报告指针

## 自审记录
1. **Spec 覆盖**：§2 架构→T1/T3/T4；§3 认证→T2；§4 API 面→T2/T3/T4/T7；§5 前端→T5/T6；§6 安全→T2/T3/T4/T7 分项落实；§7 错误处理→T6；§10 验收→T8。
2. **契约一致性**：submission_id 规则、SSE 代理必要性、done 关流/reaper 兜底、429 双义、报告属主——全部直接引自 T8 契约文档，无自创语义。
3. **占位符**：无 TBD；T6 前端验证依赖手动网关在跑（启动 env 在 ask.py 用法注释中）。
