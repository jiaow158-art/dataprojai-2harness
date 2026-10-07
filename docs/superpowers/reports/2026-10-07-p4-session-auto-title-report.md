# 会话自动标题（P4）— 实施报告（2026-10-07）

依据：用户指令 + 计划确认 + 裁定 a/b/c + 3 边界（spec：`2026-10-07-p4-session-auto-title.md`）。
提交：dataplat-ui `c8f1e64`（实现，14 文件）+ `fd9f9d9`（askSeed 接线修复——E 相位实弹即抓）。
部署：web build + pm2 restart dataplat-ui（DEEPSEEK_API_KEY 原已在 BFF env，零新增密钥）。

## 实现（形状回顾）

- `server/src/title.ts`（新）：DeepSeek 单轮 chat（deepseek-chat / max_tokens 48 / 8s 超时 / 单次不重试），system prompt 固化标题规则 + 模糊→SKIP；确定性 sanitizer（第一行/去前缀 Markdown 引号尾标点/24 字上限/SKIP→null）
- `ui_sessions.title_source`（default\|llm\|hint\|manual，存量行 settle manual 永不被动改写）；`autoTitleUiSession` SQL 守卫仅 default 可写且不动 updated_at；`renameUiSession` 置 manual 且不再 bump updated_at（裁定 b）
- ask 成功路径（网关 201 后）fire-and-forget 触发 + in-flight Set 去重（边界 3）；失败隔离 `.catch(noop)`
- 首问建会话初始「新会话」（裁定 a，替代旧 30 字前缀）；POST /api/sessions 带 title → hint；事件种子 → hint（裁定 c 维持事件标题现状）
- web：apiCreateSession(title?)；askSeed(question, titleHint)（区域 `{region}经营表现分析` / 目标 `年度目标差距分析`）；ask 受理后 +8s/+20s 两次延迟轻刷侧栏

## 单测（新增 20 例，全量 100 过）

清洗全路径 / 门控 / 一次性 / 模糊拒绝后重试 / 手动改名保护（含**在途生成 vs 改名并发序**：SQL 守卫 0 行）/ 失败隔离（生成器 reject → ask 201 不受影响）/ in-flight 去重 / hint 不触发 / autoTitle 与 rename 均不动 updated_at / **gwBody 恰三字段白名单（title 绝无字段可挂）**。测试脚手架 titleGen 注入且缺省不出网（防开发机 env key 真打 API）。

## 实弹验收（生产 :58090，6 次真实引擎问 + 1 次 API 级零烧）

| # | 项 | 结果 |
|---|---|---|
| 1 | 首问「我是想知道九月份集团业绩达成怎么样」 | **「9月集团业绩达成分析」——与用户示例逐字一致** |
| 2 | 「为什么华东最近三个月一直下滑」 | 「华东区域近三个月业绩下滑原因」（语义等价） |
| 3 | 首问「帮我看看」 | **保持「新会话」**——真实 LLM 正确按 SKIP 拒绝 |
| 4 | 同会话第二问「看一下90天以上应收情况」 | 「90天以上应收情况分析」（default 重试生成 ✓） |
| 5 | 手动改名「手动命名保留测试」后再问 | 标题不变（SQL 守卫生效 ✓） |
| 6 | 区域 askSeed（UI 点击 让AI分析该区域） | 即时「华南经营表现分析」（hint，无 LLM） |
| 7 | 目标 hint | API 级 `title_source:"hint"` 201 ✓ + 接线代码（web 接线 bug 被 E 相位当场抓住：App 边界单参 lambda 丢 titleHint，fd9f9d9 修复） |
| 8 | 失败隔离 | 单测覆盖（mock reject → 201 不受影响）；实弹无注入手段，如实报告 |
| 9 | 侧栏无刷新 | `window.__noReload` 标记存活 + 延迟轻刷后标题上 DOM，无整页刷新 |
| 10 | 持久化 | 刷新后 6 个语义标题全在（DB 行） |
| 11 | **标题不进模型上下文** | 结构（gwBody 三字段）+ 单测 + 运行时：三个 run 的网关侧 `task.question` 与用户原文**逐字一致**（含已改名会话——网关从未见过标题） |
| 12 | 不跳位 | 标题落库前后侧栏序列仅本会话文本位变化；纯 rename 前后 id 序列不变（实弹 API 级复验 ✓） |

探针教训两则：首轮 A3 断言把旧存量「新会话」（manual 来源）纳入替换预期——误报跳位，数据人工比对证伪后改断言为「仅首位变化」；audit/run/:runId 响应形状是 `{task,events,…}` 非 timeline（timeline 是 user/date 端点），探针找错键致 A4 首报 false，改读 `task.question` 后全过。

## 红线自查

`git grep` 实现零 `title` 进 gwBody 构造（app.ts:943-948 三字段白名单零改动）；title.ts Bearer 只进请求头；DEEPSEEK_API_KEY 值不出现在任何文件/日志/测试输出（探针走 DP_ADMIN_PW env 注入）。六步法/skills/gateway 推理零 diff。

## 已知边界

- 旧存量「新会话」会话（title_source=manual）不会被自动补标题——保守上线裁定，用户可手动改名
- 自动标题可回看即时性依赖 +8s/+20s 两次轻刷；LLM 慢于 20s 的边缘场景由下次任意会话活动刷新兜底
- 实弹无真·失败注入（不动生产 env）；失败面由单测全覆盖

## 取证

截图 `D:\dataplat-ui\screenshots-p0\p4-title\1440-final.png`；探针 `scripts/p0/p4-title.mjs`（相位门控可续跑）。
