# 流式分析过程展示（Streaming Progress）— 设计文档

> 日期：2026-06-26
> 状态：设计已与用户确认，待实施
> 关联：`webapp/orchestrator/workflow.py`、`webapp/main.py`、`webapp/static/index.html`

## 1. 背景

C-Level 业绩问数系统当前 `/ask` 接口是同步 POST JSON：前端发请求 → 后端跑完 6 步 workflow → 一次性返回。实测平均延迟 64s，最长 90s。

用户痛点：**干等 60-90s 没反馈**，无法判断是否卡住、还要等多久、当前在做什么。

## 2. 目标

把 6 步分析过程**实时推送**给前端，竖排显示每步状态 + 已用时间，让用户看到「正在切换」的反馈。

**成功标准**：
- 首次 step running event 在 1s 内到达（感知延迟低）
- 每个 step 状态变更后 100ms 内前端可见
- 不破坏 Phase 1 / 1.5 已有功能（pytest 28/28、NoDataError 0/10、KPI 卡 10/10）
- 不引入新依赖

## 3. 非目标

- 不流式 LLM token（step5 INTERPRET 仍整段返回）
- 不做客户端断线重连
- 不引 `sse-starlette` / `httpx-sse`，纯手写 SSE
- 不改 report-generator / audit / count_preflight 业务逻辑
- 不动 router 错域 / needs_confirmation 早返逻辑（保持非流式 JSON）
- 不做 StepList 折叠动画 / 暂停按钮

## 4. 架构

```
Frontend (fetch + ReadableStream + TextDecoder)
        ↓  POST /ask  (media_type: text/event-stream)
FastAPI StreamingResponse
        ↓
async for ev in workflow.run_full_streaming(...):
    yield _format_sse(ev)
        ↓
AnalystWorkflow.run_full_streaming()   ← NEW async generator
  - step 开始 yield {kind:"step", status:"running", started_at}
  - step 结束 yield {kind:"step", status:"done"|"error", duration_ms}
  - 异常路径 yield {kind:"sub", name:"sql_self_heal"|"review_retry"}
  - 流程级错 yield {kind:"error", type:"no_data"|"exception"}
  - 全部成功 yield {kind:"complete", payload: <AskResponse dict>}
```

**关键决策**：
- 直接替换 `/ask` 为流式（内部 demo，无外部 API 兼容约束）
- 原 `run_full` 保留为 thin wrapper 调 `run_full_streaming`，保 P1.5 测试不破
- session/audit/render_report 调用时机移到 generator 内部（complete event 之前）

## 5. SSE event 协议

每帧格式（标准 SSE）：
```
event: <kind>
data: <JSON>

```
（帧间空行分隔）

### 5.1 `event: step`（主步骤状态）
```json
{
  "step": "1+2",
  "name": "understand_and_select",
  "label": "理解问题 + 选表",
  "status": "running" | "done" | "error",
  "started_at": 1719398400000,
  "duration_ms": 8200,
  "error": "可选错误描述"
}
```

主步骤序列：
| step | name | label |
|---|---|---|
| 1+2 | understand_and_select | 理解问题 + 选表 |
| 3 | generate_sql | 生成 SQL |
| 4 | execute | 执行查询 |
| 5 | interpret | 解读结果 |
| 5.5 | magnitude_check | 量级检查 |
| 6 | review | 审核分析 |

### 5.2 `event: sub`（异常重试子步骤）
```json
{
  "parent_step": 4,
  "name": "sql_self_heal",
  "label": "SQL 报错，自愈中",
  "status": "running" | "done"
}
```

仅两种 sub：
- `parent_step=4, name=sql_self_heal` — step4 检测到 SQL ERROR 触发自愈时
- `parent_step=6, name=review_retry` — step6 不通过触发重试时

### 5.3 `event: error`（流程级错误）
```json
{
  "type": "no_data" | "exception",
  "step": "4",
  "message": "COUNT preflight returned 0 ..."
}
```

### 5.4 `event: complete`（最终完整响应）
```
data: 与原 /ask AskResponse 同结构 JSON
```

字段：`session_id / turn_id / domain / confidence / markdown / sql / review_passed / kpi_card / magnitude_warnings / data_freshness / report_url(null) / trace`

`trace` 字段保留（兼容），但前端 SSE 流期间已实时展示步骤，trace 仅供事后审计。

## 6. 组件改动

### 6.1 `webapp/orchestrator/workflow.py`

**新增方法**：
```python
async def run_full_streaming(
    self, question: str, domain: str, reviewer: Reviewer,
    history: list[dict] | None = None
) -> AsyncGenerator[dict, None]:
    """Yields SSE-ready events. Terminal events: 'error' or 'complete'."""
    STEP_LABELS = {
        "1+2": ("understand_and_select", "理解问题 + 选表"),
        "3":   ("generate_sql", "生成 SQL"),
        "4":   ("execute", "执行查询"),
        "5":   ("interpret", "解读结果"),
        "5.5": ("magnitude_check", "量级检查"),
        "6":   ("review", "审核分析"),
    }
    started = {}

    try:
        # step 1+2
        started_at = _now_ms()
        yield _step_event("1+2", "running", started_at)
        parse, table, used12 = await self.step1_understand_and_select(question, domain, history)
        yield _step_event("1+2", "done", started_at, _now_ms() - started_at)

        # step 3
        started_at = _now_ms()
        yield _step_event("3", "running", started_at)
        sql, used3 = await self.step3_generate_sql(question, parse, table, domain)
        yield _step_event("3", "done", started_at, _now_ms() - started_at)

        # step 4 (with sub: sql_self_heal on ERROR)
        started_at = _now_ms()
        yield _step_event("4", "running", started_at)
        try:
            data, status = await self._step4_with_self_heal_event(sql, yield_sub=True)
        except NoDataError as e:
            yield _step_event("4", "error", started_at, _now_ms() - started_at, str(e))
            yield _error_event("no_data", "4", str(e))
            return
        yield _step_event("4", "done", started_at, _now_ms() - started_at)

        # step 5
        started_at = _now_ms()
        yield _step_event("5", "running", started_at)
        analysis, kpi_card = await self.step5_interpret(question, sql, data, parse)
        yield _step_event("5", "done", started_at, _now_ms() - started_at)

        # step 5.5 magnitude
        started_at = _now_ms()
        yield _step_event("5.5", "running", started_at)
        magnitude_warnings = check_magnitude(domain, kpi_card) if kpi_card else []
        yield _step_event("5.5", "done", started_at, _now_ms() - started_at)

        # step 6 review (with sub: review_retry on retry)
        started_at = _now_ms()
        yield _step_event("6", "running", started_at)
        review, review_used, analysis, retry_triggered = await self._step6_with_retry_event(
            question, sql, data, analysis, reviewer
        )
        yield _step_event("6", "done", started_at, _now_ms() - started_at)

        # Build final result
        result = WorkflowResult(
            analysis=analysis, sql=sql, data=data, review=review,
            kpi_card=kpi_card, magnitude_warnings=magnitude_warnings,
            trace=[],  # not needed for streaming path
        )
        yield {"kind": "complete", "payload": _result_to_response_dict(result)}

    except Exception as e:
        yield _error_event("exception", "", str(e))
        return
```

**`_step4_with_self_heal_event`**（包装现有 step4_execute 的自愈路径）：
- 调 `count_preflight`，0 → raise NoDataError
- 调 `mcp.run_query`
- 若 status 含 ERROR：
  - yield sub running `sql_self_heal`
  - 调 LLM 修复 + 重试
  - yield sub done
- 返回 (rows, status)

**`_step6_with_retry_event`**（包装现有 review retry 路径）：
- 调 `reviewer.review`
- 不通过 + issues ≤ 2：
  - yield sub running `review_retry`
  - LLM 修复 + re-review
  - yield sub done
- 返回 (final_review, used, final_analysis, retry_triggered)

**原 `run_full` 保留**：
```python
async def run_full(self, question, domain, reviewer, history=None) -> WorkflowResult:
    async for ev in self.run_full_streaming(question, domain, reviewer, history):
        if ev["kind"] == "complete":
            return _response_dict_to_result(ev["payload"])
        if ev["kind"] == "error":
            if ev["type"] == "no_data":
                raise NoDataError(ev["message"])
            raise RuntimeError(ev["message"])
    raise RuntimeError("stream ended without complete/error")
```

### 6.2 `webapp/main.py`

`/ask` 改造：
```python
@app.post("/ask")
async def ask(req: AskRequest):
    session = session_mgr.get_or_create(req.session_id)
    start_time = time.time()

    history = _build_history(session, req.question)
    route = await app.state.router.route(req.question, history=history if len(req.question.strip()) < 8 else None)

    # Router 错域 / 低置信 — 仍返回普通 JSON（不进流式）
    if route.domain == "unknown" or route.needs_confirmation:
        return JSONResponse(_build_router_response(session, route, start_time))

    async def event_stream():
        try:
            wf = AnalystWorkflow(app.state.loader, app.state.llm, app.state.mcp)
            reviewer = Reviewer(app.state.llm)
            complete_payload = None
            async for ev in wf.run_full_streaming(req.question, route.domain, reviewer, history):
                yield _format_sse(ev)
                if ev["kind"] == "complete":
                    complete_payload = ev["payload"]
                    # session/audit/render happens here
                    turn_id = uuid.uuid4().hex[:8]
                    session.store_result(turn_id, _payload_to_result(ev["payload"]))
                    session.add_message("user", req.question)
                    session.add_message("assistant", ev["payload"]["markdown"])
                    latency = int((time.time() - start_time) * 1000)
                    app.state.audit.log(
                        session_id=session.session_id, question=req.question,
                        domain=route.domain, sql=ev["payload"]["sql"],
                        row_count=0,  # not in payload, recompute if needed
                        review_passed=ev["payload"]["review_passed"],
                        latency_ms=latency,
                        tldr=ev["payload"]["kpi_card"]["tldr"][0] if ev["payload"].get("kpi_card", {}).get("tldr") else "",
                        model="deepseek-v4-pro",
                        magnitude_warnings=ev["payload"]["magnitude_warnings"],
                    )
                    complete_payload["session_id"] = session.session_id
                    complete_payload["turn_id"] = turn_id
                    # Re-yield updated complete (or emit a 'final' event with session_id/turn_id)
                    yield _format_sse({"kind": "complete", "payload": complete_payload})
        except Exception as e:
            yield _format_sse({"kind": "error", "type": "exception", "message": str(e)[:200]})

    return StreamingResponse(event_stream(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",  # disable proxy buffering
    })


def _format_sse(ev: dict) -> str:
    kind = ev.pop("kind")
    return f"event: {kind}\ndata: {json.dumps(ev, ensure_ascii=False)}\n\n"
```

**注意**：`complete_payload` 里附带 `row_count: int` 字段（即 `len(result.data)`），audit 日志直接读它；前端也用此字段显示返回行数。原 AskResponse 模型加 `row_count: int = 0` 字段（不破坏前端兼容）。

### 6.3 `webapp/static/index.html`

**`ask()` 方法重写**：
```js
async ask(text) {
  const t = (typeof text === 'string' ? text : this.q).trim();
  if (!t || this.loading) return;
  this.q = '';
  this.loading = true;

  const item = {
    question: t,
    trace: [],
    status: 'running',  // 'running' | 'done' | 'error'
    markdown: '', kpi_card: null, magnitude_warnings: [],
    sql: '', review_passed: true, turn_id: null,
    report_url: null, report_state: 'none',
    feedback: null, detail_open: false, sql_open: false,
  };
  this.history.push(item);
  this.startWatchdog(item);

  try {
    const resp = await fetch('/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: this.sessionId, question: t }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const frames = buf.split('\n\n');
      buf = frames.pop();
      for (const f of frames) {
        const ev = this.parseSSEFrame(f);
        if (ev) this.applyEvent(item, ev);
      }
    }
  } catch (e) {
    item.status = 'error';
    item.markdown = `**请求失败**: ${e.message}`;
  } finally {
    this.loading = false;
    this.clearWatchdog(item);
  }
}
```

**`applyEvent(item, ev)`**：
- `event: step` → 更新 item.trace 中对应 step（按 step 字段 find-or-push）
- `event: sub` → 在 parent_step 下找/加 sub item
- `event: error` → item.status='error'，item.errorMessage = ev.message
- `event: complete` → 合并 payload 字段（markdown/kpi_card/sql/turn_id/session_id/...）到 item，item.status='done'；存 sessionId

**`startWatchdog(item)`**：90s 内未 done → 强制 item.status='error'，item.markdown='请求超时，请稍后重试'。中断方式：把 `reader` 存到 `item._reader`，watchdog 触发时调 `item._reader.cancel()` 让 `await reader.read()` 立即返回 done；`ask()` 的 while 循环自然退出。`clearWatchdog(item)` 在 finally 里清 timeout。

**新模板 `<StepList>`**：
```html
<div class="step-list" v-if="item.status === 'running'">
  <div class="step-item" v-for="s in item.trace" :key="s.step || s.name"
       :class="s.status">
    <span class="step-icon">{{ stepIcon(s) }}</span>
    <span class="step-label">{{ s.label }}</span>
    <span class="step-time">{{ stepTime(s) }}</span>
  </div>
  <!-- 嵌套子步骤 -->
</div>
```

显示规则：
- `status='running'` → ⏳（脉冲）+ 显示 `已用 {{elapsed}}s`（每秒刷新）
- `status='done'` → ✓ + 显示 `{{duration_ms/1000}}s`
- `status='error'` → × + 红色
- sub item → 缩进 + ⚠ + 黄色

完成后（item.status='done'）：StepList 整体淡化（opacity 0.5）但仍可见 3 秒，然后折叠为单行「✓ 分析完成 · 用时 Xs」+ 展开按钮（YAGNI：不做展开按钮，直接淡化保留即可）。

## 7. 错误处理矩阵

| 场景 | step 状态 | sub event | item 最终态 |
|---|---|---|---|
| 正常完成 | 全部 ✓ | 无 | 显示 answer card（TL;DR + KPI + 报告按钮） |
| NoDataError (step4) | 1+2 ✓ / 3 ✓ / 4 × | 无 | error 卡：「该筛选条件下无数据」 |
| SQL 自愈成功 | 4 ✓ | sub: sql_self_heal ✓ | 正常 answer card，StepList 留 ⚠ 标记 |
| 审核重试成功 | 全部 ✓ | sub: review_retry ✓ | 正常 answer card，StepList 留 ⚠ |
| 审核重试仍失败 | 6 ⚠ | sub: review_retry ⚠ | answer card 标红边（review_passed=false） |
| Router 错域 | — | — | 不进流式，保留 needs_confirmation 早返 |
| LLM 单次超时 | 卡 running | 无 | 90s watchdog 强制 error |
| 客户端断连 | — | — | generator 收 CancelledError 退出，不入 audit |

## 8. 测试策略

### 后端 pytest（新增）
1. **`test_workflow_streaming_happy_path`** — mock LLM/MCP，收集全部 event，断言 6 running + 6 done + 1 complete，无 error/sub
2. **`test_workflow_streaming_no_data`** — mock step4 抛 NoDataError，断言 1+2/3 done + 4 error + 1 error event，无 complete
3. **`test_workflow_streaming_review_retry`** — mock review 第一次不通过、重试通过，断言 sub review_retry 出现 1 次 + status 转 done
4. **`test_ask_streaming_endpoint`** — FastAPI TestClient POST /ask，断言 `content-type: text/event-stream`，按 `\n\n` split 后解析出 ≥7 帧（6 step + 1 complete）

### 兼容性
- 现有 `test_workflow_p1*.py` 5 个测试走 `run_full`（非 streaming），通过 thin wrapper 保持可用
- 现有 `test_kpi_card / magnitude_check / count_preflight / smoke` 不受影响

### 前端手测（写进 acceptance doc）
- 4 问验证：
  - 正常问（应展示 6 步逐个切换 + 完成）
  - 触发 NoDataError 的问（应展示 × step 4）
  - 触发 SQL 自愈的问（应展示 ⚠ sub）
  - 浏览器中途关闭（应不挂后端）

## 9. 兼容性 / 迁移

- `/generate_report` 接口完全不变
- `report-generator` skill 完全不变
- `SessionManager.Session.last_results` 缓存机制不变（complete event 后 store）
- audit log 字段不变
- AskResponse 字段不变（仅 turn_id 已有，trace 已有）

## 10. 风险

| 风险 | 缓解 |
|---|---|
| StreamingResponse 在 uvicorn 反代后被缓冲 | 加 `X-Accel-Buffering: no` header |
| 客户端断连后 generator 仍跑完浪费 LLM 调用 | generator 内每步 `await asyncio.sleep(0)` 让出，CancelledError 自然抛出 |
| 浏览器 EventSource 不支持 POST | 用 fetch + ReadableStream（已选），不用 EventSource |
| `run_full` thin wrapper 行为漂移 | wrapper 内部完整复用 streaming 路径，仅做 event → result 的转换 |
| 完整 AskResponse 在 complete event 时还需要 session_id/turn_id | complete event 在 generator 内 yield 之前先填好 session_id/turn_id |

## 11. 后续可演进

- LLM token-level streaming（step3 SQL / step5 INTERPRET 流式吐字）— 独立 spike
- StepList 历史展开（看过去的提问各步耗时）
- 长耗时步骤自动提示「这一步通常要 15s」
