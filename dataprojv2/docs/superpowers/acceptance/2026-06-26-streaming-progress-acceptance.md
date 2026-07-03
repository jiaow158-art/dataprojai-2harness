# Streaming Progress 验收报告

> 日期：2026-06-26
> 对比基线：Phase 1.5 spike（avg latency 64s、无进度反馈）
> 设计文档：`docs/superpowers/specs/2026-06-26-streaming-progress-design.md`
> 实施计划：`docs/superpowers/plans/2026-06-26-streaming-progress.md`

## 1. 改动摘要

| Task | 改动 | 文件 |
|---|---|---|
| 1 | `run_full_streaming` async generator + helpers + `run_full` thin wrapper | workflow.py |
| 2 | `_step4_with_self_heal_event` 提取，yield SQL 自愈 sub events | workflow.py |
| 3 | `_step6_with_retry_event` 提取，yield 审核重试 sub events | workflow.py |
| 4 | `/ask` 改 StreamingResponse + `_format_sse` + AskResponse.row_count | main.py |
| 5 | fetch ReadableStream + StepList 组件 + 90s watchdog | index.html |

## 2. 已知偏差

- **Python 3.9 async generator 限制**：plan 原计划用 `return value` + `StopAsyncIteration.value`，但 Python 3.9 实测为 `SyntaxError`。Task 2/3 改用 mutable holder 模式（`result_out: list`），所有调用点一致。
- **`item.data` 字段移除**：SSE complete 事件不携带原始 rows，前端 index.html 移除了「数据明细」展开块（C-Level 受众不需要原始行）。「返回 N 行」改用 `row_count` 字段。

## 3. 验收结果

### 3.1 自动化测试

- pytest: **40 passed**（基线 28 + streaming 8 + main 4）
- `test_audit_logger.py` 1 个失败与本改动无关（test 自身 hardcoded `2026-06-25.jsonl` 日期 bug）
- run_eval.py sales-performance: **25 passed / 25 total（100% accuracy）** passed

### 3.2 curl 烟测

| # | 场景 | 命令 | 实测 |
|---|---|---|---|
| 1 | 「本月集团业绩」 happy path | `curl -sN POST /ask` | ✅ `event: step` 帧数 **12**（6 running + 6 done），`event: complete` 1 帧到达，无 sub/error 事件；总耗时约 **54s**（17055+14493+723+10034+0+11784 ms）；domain sales-performance、confidence 0.95、row_count 1 |
| 2 | 「2099年1月集团业绩」NoData | 同上 | ✅ 触发 step 1+2 done、step 3 done、step 4 `running→error`，随后 1 个 `event: error`，`type: "no_data"`，`step: "4"`，无 complete 事件；COUNT preflight 0 行正确识别 |
| 3 | 「你好吗」router 错域 | `curl -i POST /ask` | ✅ HTTP 200，`content-type: application/json`（**非** text/event-stream），body `needs_confirmation: true`、`message` 字段含领域提示 |

### 3.3 浏览器手测（待用户验证）

| # | 场景 | 预期 | 实测 |
|---|---|---|---|
| 4 | 浏览器打开 index.html，输入「本月集团业绩？」 | StepList 6 步逐个切换，最终展开 KPI 卡 | 待用户验证 |
| 5 | 浏览器输入「2099年1月业绩」 | StepList 显示 step 4 × + 红色 error banner | 待用户验证 |
| 6 | 浏览器输入能触发 SQL 错的问题（如「丽适岩板本月达成率」） | 出现 sub item「⚠ SQL 报错，自愈中」，自愈后变灰色 | 待用户验证 |
| 7 | 浏览器发问中途关闭标签 | 后端不挂，后续请求正常 | 待用户验证 |

### 3.4 性能

- 首次 step running event 到达时间：≤1s（curl 实测客户端连接成功后即收到 step 1+2 running 帧）
- 每个 step 切换延迟：≤100ms（基本由 LLM 调用本身耗时主导；实测 done→下一步 running 在同一 TCP 包内）
- happy path 总耗时约 54s（基线 64s，未观察到 LLM 调用串行化造成的回归）
- 90s watchdog：curl 测试未触发；浏览器手测中如触发请记录

## 4. 不破坏项

- ✅ pytest 28→40 passed
- ✅ `/generate_report` 接口未变
- ✅ Session 缓存机制（last_results）不变
- ✅ Audit log 字段不变（row_count 仍写入）
- ✅ run_eval.py（使用 run_full thin wrapper）不回归（25/25 通过）

## 5. Followup

- LLM token-level streaming（step3/step5 流式吐字）— 独立 spike
- StepList 历史展开（看过去的提问各步耗时）— UX 增强
- 长耗时步骤自适应提示「这一步通常要 15s」
- `item.error_type` 已设置但未在 UI 显示，未来可用于错误分类标签
- `stepTime` running 状态不会每秒自动刷新，仅在事件到达时更新（可加 1s setInterval tick）

## 6. 结论

Streaming Progress 状态：**✅ 后端验收达标，浏览器手测待用户最终确认**

用户从「干等 60-90s 无反馈」变成「6 步实时切换 + 已用时间显示」，C-Level 体验显著改善。
