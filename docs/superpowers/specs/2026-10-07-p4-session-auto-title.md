# 会话自动标题（P4）— 规格（2026-10-07）

用户指令 + 计划确认 + 裁定 a/b/c + 3 实现边界。仓库：dataplat-ui（BFF + web）。

## 目标与铁律

像 Codex 一样按首个有效问题自动生成简洁中文标题（8~18 字，风格规则固化进 system prompt）。
**session.title = presentation metadata only**：不进 system prompt / user message / conversation
history / gateway request / 六步法 / SQL 生成——后续对话上下文只依赖真实 conversation history。

## 裁定（2026-10-07 用户确认）

| # | 内容 |
|---|---|
| a | 生成失败/超时/模糊拒绝都保持「新会话」（不降级写首问 30 字前缀）；title_source 停留 default，后续有效问题允许再试——宁缺毋滥 |
| b | 手动 rename 与自动标题都不改会话活动排序时间（updated_at 只随真实会话活动变化）；标题异步落库不得导致 Sidebar 跳位 |
| c | 事件入口保持现有事件标题（不加「分析」不走 LLM）；区域入口 `{region}经营表现分析`；目标入口 `年度目标差距分析`（hint 来源）；仅普通用户首问走轻量 LLM |

## 边界（3 条）

1. title.ts 确定性 sanitizer：trim→只取第一行→去标题前缀/Markdown/首尾引号括号/尾部标点→24 字硬上限；清洗后空/SKIP/「新会话」/<2 字 → null
2. autoTitleUiSession 与 rename 都不动 updated_at（SQL 层面：不写该列）
3. 并发 ask 的 in-flight 去重：模块级 Set<sessionId>，同 default 会话至多一次在途标题请求（UI busy 锁外的并发兜底，不做状态机）

## 数据模型与守卫

- `ui_sessions.title_source TEXT NOT NULL`（default\|llm\|hint\|manual），schema.sql 新列 + 旧库幂等 ALTER（存量行随 DEFAULT settle manual——历史标题永不被动改写，保守上线）
- `autoTitleUiSession(id,title)` = `UPDATE … WHERE id=? AND title_source='default'`——SQL 级原子守卫（在途生成 vs 手动改名并发：先到者改 source，后到者 0 行）；不写 updated_at
- `renameUiSession` → SET title + title_source='manual'，不再 bump updated_at（裁定 b）

## 实现形状

- `server/src/title.ts`（新）：DeepSeek 单轮 chat（deepseek-chat，max_tokens 48，temp 0.3，8s 超时单次不重试，Bearer 只进请求头读 DEEPSEEK_API_KEY——BFF pm2 env 已有该 key，零新增密钥）；system prompt 固化标题规则与模糊→SKIP 约定
- `app.ts` /api/ask 成功路径（网关 201 后）fire-and-forget 触发：仅 title_source=default 且不在途；`.catch(noop)` 失败隔离；首问建会话初始「新会话」（裁定 a，替代旧 30 字前缀行为）
- `POST /api/sessions` 带 title → source=hint；`insight.ts` 事件种子 → hint
- web：`apiCreateSession(title?)`；`askSeed(question, titleHint?)`（区域/目标页构造语义标题传入）；ask 受理后 +8s/+20s 两次延迟轻刷侧栏（无刷新换标题；sessions 受控 diff + 标题不动 updated_at → 高亮/顺序天然稳定）
- gwBody 三字段白名单（question/client_submission_id/session_id）零改动——title 无字段可挂（结构隔离）

## 验收（用户 12 项 → 映射）

单测（20 例新增）：清洗/门控/一次性/模糊重试/手动保护（含在途并发序）/失败隔离/去重/hint/排序不变/网关体红线；全量 100 过。
实弹（5+1 问）：示例问×2、帮我看看→保持→二问重试、改名后再问不覆盖、区域 askSeed UI、目标 hint API 级；audit run question 原文比对（标题未混入网关上下文旁证）；持久化=天然 DB 行。
部署：web build + pm2 restart dataplat-ui（DEEPSEEK_API_KEY 已在 env）。
