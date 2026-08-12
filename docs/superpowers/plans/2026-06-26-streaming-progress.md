# Streaming Progress（流式分析过程展示）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `/ask` 接口改成 SSE 流式，6 步分析过程实时推送，前端展示步骤清单 + 已用时间，让用户不再干等 60-90s。

**Architecture:** 后端 `AnalystWorkflow.run_full_streaming` 改 async generator，每步 yield 状态 event；FastAPI `StreamingResponse(media_type="text/event-stream")` 透传；前端 `fetch` + `ReadableStream` + `TextDecoder` 解析 SSE 帧，实时更新 `StepList` 组件。原 `run_full` 保留为 thin wrapper（P1/P1.5 测试不破）。

**Tech Stack:** Python 3.9（约束：所有 .py 文件必须有 `from __future__ import annotations`），FastAPI StreamingResponse，pytest + pytest-asyncio，vanilla JS（fetch ReadableStream），无新依赖。

---

## 验收标准（Task 6 全部跑完必须满足）

| 维度 | 基线 | 目标 |
|---|---|---|
| pytest 全套 | 28/28 pass（不含 audit_logger 的 hardcoded-date flaky） | ≥32/32 pass（新增 4 个 streaming 测试） |
| 前端手测：6 步逐个切换 | 不适用 | 4 个验证问题全部正确展示 |
| `/generate_report` 接口 | 可用 | 不变（向后兼容） |
| `report_url` 默认值 | null（已改） | null（不变） |

## 不做（spec §3 已明确）

- 不流式 LLM token（step5 INTERPRET 仍整段返回）
- 不做客户端断线重连
- 不引 `sse-starlette` / `httpx-sse`，纯手写 SSE
- 不改 report-generator / audit / count_preflight 业务逻辑
- 不动 router 错域 / needs_confirmation 早返逻辑（保持非流式 JSON）
- 不做 StepList 折叠动画 / 暂停按钮

---

## File Structure

**Modified:**
- `webapp/orchestrator/workflow.py` — Task 1 加 `run_full_streaming` + helpers + 改 `run_full` 为 thin wrapper；Task 2 加 `_step4_with_self_heal_event`；Task 3 加 `_step6_with_retry_event`
- `webapp/main.py` — Task 4 改 `/ask` 为 StreamingResponse + 加 `_format_sse` + `AskResponse.row_count` 字段
- `webapp/static/index.html` — Task 5 改 `ask()` 为 fetch ReadableStream + 加 StepList 组件 + watchdog

**Created:**
- `webapp/tests/test_workflow_streaming.py` — Task 1/2/3 新增 streaming 单测
- `webapp/tests/test_main_streaming.py` — Task 4 新增 `_format_sse` 单测
- `docs/superpowers/acceptance/2026-06-26-streaming-progress-acceptance.md` — Task 6 验收报告

---

## Task 1: 加 `run_full_streaming` + happy/no_data 测试 + `run_full` thin wrapper

**Files:**
- Modify: `webapp/orchestrator/workflow.py:1-12`（imports 加 `import time`）
- Modify: `webapp/orchestrator/workflow.py:104-115`（`WorkflowResult` 之前加 helpers）
- Modify: `webapp/orchestrator/workflow.py:270-319`（`AnalystWorkflow.run_full` 之前插入 `run_full_streaming`，`run_full` 改 thin wrapper）
- Create: `webapp/tests/test_workflow_streaming.py`

**目标**：建立 streaming generator 骨架。Step 4 的 NoDataError 已经被 try/except 捕获；step 4 自愈 / step 6 重试路径暂时沿用现有逻辑（不 yield sub event），Task 2/3 再加。

- [ ] **Step 1: 写 happy path 测试（先写测试再写实现 — TDD）**

Create `webapp/tests/test_workflow_streaming.py`:

```python
"""Tests for run_full_streaming — async generator yielding SSE-ready events."""
from __future__ import annotations

import pytest
from webapp.llm.base import MockLLMClient
from webapp.orchestrator.loader import SkillsLoader
from webapp.orchestrator.workflow import AnalystWorkflow, _step_event, _error_event, _now_ms
from webapp.orchestrator.reviewer import Reviewer
from webapp.tests.conftest import MockMcpClient

SKILLS_DIR = "D:/dataproj/skills"


@pytest.fixture
def loader():
    return SkillsLoader(SKILLS_DIR)


@pytest.fixture
def mcp_happy():
    """MCP mock where COUNT returns 100 and data returns one row with valid 3e9 value."""
    return MockMcpClient(
        query_results={"COUNT(*)": [{"cnt": 100}]},
        default_rows=[{"actual": 3_000_000_000}],
    )


@pytest.mark.asyncio
async def test_run_full_streaming_happy_path_yields_six_running_six_done_then_complete(loader, mcp_happy):
    """Happy path: 6 running + 6 done + 1 complete, no error/sub events."""
    llm_responses = [
        # step1+2 (merged)
        '{"metric":"业绩","dimensions":[],"time_range":"2026-05","scope":"集团","key_entities":[],"ambiguities":[],"table":"dm.dm_fin_operations_mix_sum_t","reason":"默认主表"}',
        # step3
        "```sql\nSELECT SUM(ambperformance) as actual FROM dm.dm_fin_operations_mix_sum_t WHERE calmonth = '2026-05'\n```",
        # step5
        '{"tldr":["销售额正常"],"kpis":[{"label":"销售额","value":3000000000,"unit":"元","yoy":null,"mom":null,"target":null,"rank":null,"direction":"neutral"}]}',
        # step6 review
        '{"passed":true,"issues":[],"suggestion":""}',
    ]
    llm = MockLLMClient(responses=llm_responses)
    wf = AnalystWorkflow(loader, llm, mcp_happy)
    reviewer = Reviewer(llm)

    events = []
    async for ev in wf.run_full_streaming("本月集团业绩", "sales-performance", reviewer):
        events.append(ev)

    running = [e for e in events if e.get("kind") == "step" and e.get("status") == "running"]
    done = [e for e in events if e.get("kind") == "step" and e.get("status") == "done"]
    complete = [e for e in events if e.get("kind") == "complete"]
    errors = [e for e in events if e.get("kind") == "error"]
    subs = [e for e in events if e.get("kind") == "sub"]

    assert len(running) == 6, f"expected 6 running, got {len(running)}: {[e['step'] for e in running]}"
    assert len(done) == 6, f"expected 6 done, got {len(done)}"
    assert len(complete) == 1, f"expected 1 complete, got {len(complete)}"
    assert len(errors) == 0, f"expected no error events, got {errors}"
    assert len(subs) == 0, f"expected no sub events in happy path, got {subs}"

    expected_order = ["1+2", "3", "4", "5", "5.5", "6"]
    actual_running_order = [e["step"] for e in running]
    assert actual_running_order == expected_order, f"step order wrong: {actual_running_order}"

    # complete event must carry a WorkflowResult instance
    assert hasattr(complete[0]["result"], "analysis"), "complete event must carry WorkflowResult"
    assert complete[0]["result"].magnitude_warnings == []


@pytest.mark.asyncio
async def test_run_full_streaming_yields_no_data_error_when_count_zero(loader):
    """When COUNT preflight returns 0, streaming yields step 4 error + no_data error event."""
    mcp = MockMcpClient(
        query_results={"COUNT(*)": [{"cnt": 0}]},
        default_rows=[{"sum_x": None}],
    )
    llm_responses = [
        # step1+2
        '{"metric":"业绩","dimensions":[],"time_range":"2099-01","scope":"集团","key_entities":[],"ambiguities":[],"table":"dm.dm_fin_operations_mix_sum_t","reason":"默认主表"}',
        # step3
        "```sql\nSELECT SUM(ambperformance) FROM dm.dm_fin_operations_mix_sum_t WHERE calmonth = '2099-01'\n```",
    ]
    llm = MockLLMClient(responses=llm_responses)
    wf = AnalystWorkflow(loader, llm, mcp)
    reviewer = Reviewer(llm)

    events = []
    async for ev in wf.run_full_streaming("2099年1月业绩", "sales-performance", reviewer):
        events.append(ev)

    done_steps = [e["step"] for e in events if e.get("kind") == "step" and e.get("status") == "done"]
    error_steps = [e["step"] for e in events if e.get("kind") == "step" and e.get("status") == "error"]
    error_events = [e for e in events if e.get("kind") == "error"]
    complete = [e for e in events if e.get("kind") == "complete"]

    assert done_steps == ["1+2", "3"], f"only 1+2 and 3 should done, got {done_steps}"
    assert error_steps == ["4"], f"only step 4 should error, got {error_steps}"
    assert len(error_events) == 1
    assert error_events[0]["type"] == "no_data"
    assert error_events[0]["step"] == "4"
    assert len(complete) == 0, "must not emit complete on no_data"


def test_helpers_produce_expected_event_shapes():
    """_step_event and _error_event must produce SSE-ready dicts."""
    ev = _step_event("1+2", "running", started_at=1719398400000)
    assert ev["kind"] == "step"
    assert ev["step"] == "1+2"
    assert ev["name"] == "understand_and_select"
    assert ev["label"] == "理解问题 + 选表"
    assert ev["status"] == "running"
    assert ev["started_at"] == 1719398400000
    assert ev["duration_ms"] == 0

    ev2 = _step_event("3", "done", started_at=100, duration_ms=8200)
    assert ev2["duration_ms"] == 8200

    err = _error_event("no_data", "4", "COUNT preflight returned 0")
    assert err == {"kind": "error", "type": "no_data", "step": "4", "message": "COUNT preflight returned 0"}


def test_now_ms_is_int_milliseconds():
    """_now_ms must return int (JSON serializable)."""
    v = _now_ms()
    assert isinstance(v, int)
    assert v > 1700000000000  # current era timestamp
```

- [ ] **Step 2: 跑测试确认 fail**

Run: `cd D:/dataproj && C:/Users/Administrator/AppData/Local/Programs/Python/Python39/python.exe -m pytest webapp/tests/test_workflow_streaming.py -v`

Expected: 4 FAIL（`ImportError: cannot import name 'run_full_streaming'` or `'_step_event'`）— 因为 helpers 和方法还没加。

- [ ] **Step 3: 在 workflow.py 加 `import time`**

Modify `webapp/orchestrator/workflow.py` 行 1-12。当前：

```python
"""6-step Analyst workflow orchestration."""
from __future__ import annotations
import json
import re
import datetime
from dataclasses import dataclass, field
from webapp.llm.base import LLMClient, ToolDef
from webapp.orchestrator.loader import SkillsLoader
from webapp.orchestrator.reviewer import Reviewer, ReviewResult
from webapp.orchestrator.count_preflight import count_preflight, NoDataError
from webapp.orchestrator.kpi_card import KpiCard, parse_llm_kpi_output
from webapp.orchestrator.magnitude_check import check_magnitude
```

改为（加 `import time`）：

```python
"""6-step Analyst workflow orchestration."""
from __future__ import annotations
import json
import re
import time
import datetime
from dataclasses import dataclass, field
from webapp.llm.base import LLMClient, ToolDef
from webapp.orchestrator.loader import SkillsLoader
from webapp.orchestrator.reviewer import Reviewer, ReviewResult
from webapp.orchestrator.count_preflight import count_preflight, NoDataError
from webapp.orchestrator.kpi_card import KpiCard, parse_llm_kpi_output
from webapp.orchestrator.magnitude_check import check_magnitude
```

- [ ] **Step 4: 加 module-level helpers + `_STEP_META`**

在 `webapp/orchestrator/workflow.py` 找到 `@dataclass class WorkflowResult:`（约 line 107），在它之前插入：

```python
# -- Streaming helpers (used by run_full_streaming) --

def _now_ms() -> int:
    """Current time as int milliseconds. JSON-serializable, suitable for SSE 'started_at'."""
    return int(time.time() * 1000)


_STEP_META = {
    "1+2": ("understand_and_select", "理解问题 + 选表"),
    "3":   ("generate_sql", "生成 SQL"),
    "4":   ("execute", "执行查询"),
    "5":   ("interpret", "解读结果"),
    "5.5": ("magnitude_check", "量级检查"),
    "6":   ("review", "审核分析"),
}


def _step_event(step: str, status: str, started_at: int, duration_ms: int = 0, error: str = "") -> dict:
    """Build a 'step' event dict for SSE."""
    name, label = _STEP_META[step]
    ev = {
        "kind": "step",
        "step": step,
        "name": name,
        "label": label,
        "status": status,
        "started_at": started_at,
        "duration_ms": duration_ms,
    }
    if error:
        ev["error"] = error
    return ev


def _sub_event(parent_step: str, name: str, label: str, status: str) -> dict:
    """Build a 'sub' event dict for SSE (used for SQL self-heal / review retry)."""
    return {"kind": "sub", "parent_step": parent_step, "name": name, "label": label, "status": status}


def _error_event(type_: str, step: str, message: str) -> dict:
    """Build a flow-level 'error' event dict for SSE."""
    return {"kind": "error", "type": type_, "step": step, "message": message}


```

- [ ] **Step 5: 加 `AnalystWorkflow.run_full_streaming` 方法**

在 `webapp/orchestrator/workflow.py` 找到 `async def run_full(self, question: str, domain: str, reviewer: Reviewer, history: list[dict] | None = None) -> WorkflowResult:`（约 line 272），在它**之前**插入新方法：

```python
    # -- Streaming pipeline (yields SSE-ready events) --
    async def run_full_streaming(
        self, question: str, domain: str, reviewer: Reviewer,
        history: list[dict] | None = None
    ):
        """Async generator yielding SSE-ready event dicts.

        Event kinds:
          - 'step'    : status running/done/error for one of the 6 main steps
          - 'sub'     : exception path (SQL self-heal, review retry) — Task 2/3 adds these
          - 'error'   : flow-level error (no_data, exception)
          - 'complete': success, carries 'result' = WorkflowResult instance

        Terminal: emits exactly one 'error' or one 'complete' before returning.
        """
        try:
            # step 1+2 (understand + table select, merged)
            t0 = _now_ms()
            yield _step_event("1+2", "running", t0)
            parse, table, used12 = await self.step1_understand_and_select(question, domain, history=history)
            yield _step_event("1+2", "done", t0, _now_ms() - t0)

            # step 3 (SQL gen)
            t0 = _now_ms()
            yield _step_event("3", "running", t0)
            sql, used3 = await self.step3_generate_sql(question, parse, table, domain)
            yield _step_event("3", "done", t0, _now_ms() - t0)

            # step 4 (execute) — Task 2 will swap to _step4_with_self_heal_event for sub events
            t0 = _now_ms()
            yield _step_event("4", "running", t0)
            try:
                data, status = await self.step4_execute(sql)
            except NoDataError as e:
                yield _step_event("4", "error", t0, _now_ms() - t0, str(e))
                yield _error_event("no_data", "4", str(e))
                return
            yield _step_event("4", "done", t0, _now_ms() - t0)

            # step 5 (interpret)
            t0 = _now_ms()
            yield _step_event("5", "running", t0)
            analysis, kpi_card = await self.step5_interpret(question, sql, data, parse)
            yield _step_event("5", "done", t0, _now_ms() - t0)

            # step 5.5 (magnitude check)
            t0 = _now_ms()
            yield _step_event("5.5", "running", t0)
            magnitude_warnings: list[str] = []
            if kpi_card:
                magnitude_warnings = check_magnitude(domain, kpi_card)
            yield _step_event("5.5", "done", t0, _now_ms() - t0)

            # step 6 (review) — Task 3 will swap to _step6_with_retry_event for sub events
            t0 = _now_ms()
            yield _step_event("6", "running", t0)
            review, review_used = await reviewer.review(question, sql, data, analysis, self.mcp)
            if not review.passed and len(review.issues) <= 2:
                fixed = await self.llm.chat(
                    system=f"根据审查意见修复分析。问题：{review.issues}\n建议：{review.suggestion}\n输出修复后的Markdown。",
                    user=f"原始：\n{analysis}",
                    temperature=0.1,
                )
                analysis = fixed
                review, _ = await reviewer.review(question, sql, data, analysis, self.mcp)
            yield _step_event("6", "done", t0, _now_ms() - t0)

            result = WorkflowResult(
                analysis=analysis, sql=sql, data=data, review=review,
                kpi_card=kpi_card,
                magnitude_warnings=magnitude_warnings,
                trace=[],
            )
            yield {"kind": "complete", "result": result}

        except Exception as e:
            yield _error_event("exception", "", f"{type(e).__name__}: {e}"[:300])
            return

```

- [ ] **Step 6: 把 `run_full` 改成 thin wrapper**

`webapp/orchestrator/workflow.py` 当前的 `run_full` 方法（约 line 272-319，包含 step1_understand_and_select / step3_generate_sql / step4_execute / step5_interpret / magnitude_check / reviewer.review / review_retry 一大段）。**完全替换**为：

```python
    # -- Full pipeline (thin wrapper around run_full_streaming for backwards compat) --
    async def run_full(self, question: str, domain: str, reviewer: Reviewer, history: list[dict] | None = None) -> WorkflowResult:
        """Synchronous facade over run_full_streaming. P1/P1.5 tests use this."""
        async for ev in self.run_full_streaming(question, domain, reviewer, history):
            kind = ev["kind"]
            if kind == "complete":
                return ev["result"]
            if kind == "error":
                if ev["type"] == "no_data":
                    raise NoDataError(ev["message"])
                raise RuntimeError(ev["message"])
        raise RuntimeError("run_full_streaming ended without complete/error")
```

- [ ] **Step 7: 跑新测试确认 pass**

Run: `cd D:/dataproj && C:/Users/Administrator/AppData/Local/Programs/Python/Python39/python.exe -m pytest webapp/tests/test_workflow_streaming.py -v`

Expected: 4 PASS

- [ ] **Step 8: 跑 P1 测试确认 `run_full` thin wrapper 不破**

Run: `cd D:/dataproj && C:/Users/Administrator/AppData/Local/Programs/Python/Python39/python.exe -m pytest webapp/tests/test_workflow_p1.py webapp/tests/test_workflow_p1_5.py -v`

Expected: 9 PASS（P1 的 4 个 + P1.5 的 5 个）

如果 `test_run_full_includes_magnitude_warnings` fail：检查 streaming method 是否正确调用了 `check_magnitude(domain, kpi_card)` 并把结果放到 `WorkflowResult.magnitude_warnings`。

- [ ] **Step 9: 跑全套 pytest 确认无回归**

Run: `cd D:/dataproj && C:/Users/Administrator/AppData/Local/Programs/Python/Python39/python.exe -m pytest webapp/tests/ --ignore=webapp/tests/test_audit_logger.py -q`

Expected: 32 passed（基线 28 + Task 1 新增 4）

- [ ] **Step 10: Checkpoint** — streaming 骨架 + happy/no_data 测试完成

---

## Task 2: 加 `_step4_with_self_heal_event` + 集成 sub events

**Files:**
- Modify: `webapp/orchestrator/workflow.py`（加新方法 `_step4_with_self_heal_event`，在 `run_full_streaming` 内替换 `self.step4_execute(sql)` 调用）
- Modify: `webapp/tests/test_workflow_streaming.py`（追加 self-heal 测试）

**目标**：把 step4 内部的 SQL 自愈路径提取出来，当自愈触发时 yield `sub` event。

- [ ] **Step 1: 写测试（TDD）**

在 `webapp/tests/test_workflow_streaming.py` 末尾追加：

```python


class _ErrorFirstMcpClient(MockMcpClient):
    """MCP mock where first non-COUNT run_query returns ERROR, then delegates to parent."""
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._first_real_call = True

    async def run_query(self, sql: str):
        self.queries_run.append(sql)
        if "COUNT(*)" in sql.upper():
            return [{"cnt": 100}], "OK (1 row)"
        if self._first_real_call:
            self._first_real_call = False
            return [], "ERROR: column bad_col does not exist"
        return self.default_rows, f"OK ({len(self.default_rows)} rows)"


@pytest.mark.asyncio
async def test_step4_with_self_heal_yields_sub_events(loader):
    """When first run_query returns ERROR, _step4_with_self_heal_event yields sql_self_heal sub events."""
    mcp = _ErrorFirstMcpClient(
        describe_results={
            "dm.dm_fin_operations_mix_sum_t": [
                {"column_name": "calmonth", "data_type": "character varying", "column_comment": ""},
                {"column_name": "ambperformance", "data_type": "numeric", "column_comment": ""},
            ]
        },
        default_rows=[{"actual": 100}],
    )
    llm = MockLLMClient(responses=[
        # self-heal fix SQL
        "```sql\nSELECT SUM(ambperformance) as actual FROM dm.dm_fin_operations_mix_sum_t WHERE calmonth = '2026-05'\n```",
    ])
    wf = AnalystWorkflow(loader, llm, mcp)

    sub_events = []
    final_value = None
    gen = wf._step4_with_self_heal_event(
        "SELECT bad_col FROM dm.dm_fin_operations_mix_sum_t WHERE calmonth = '2026-05'"
    )
    while True:
        try:
            ev = await gen.__anext__()
            sub_events.append(ev)
        except StopAsyncIteration as stop:
            final_value = stop.value
            break

    assert final_value is not None, "must return (rows, status)"
    rows, status = final_value
    assert len(rows) == 1
    assert "ERROR" not in status.upper()

    assert len(sub_events) == 2, f"expected 2 sub events (running+done), got {sub_events}"
    assert sub_events[0]["kind"] == "sub"
    assert sub_events[0]["parent_step"] == "4"
    assert sub_events[0]["name"] == "sql_self_heal"
    assert sub_events[0]["status"] == "running"
    assert sub_events[1]["status"] == "done"


@pytest.mark.asyncio
async def test_run_full_streaming_propagates_step4_sub_events(loader):
    """run_full_streaming must re-yield sub events from step4 to caller."""
    mcp = _ErrorFirstMcpClient(
        describe_results={
            "dm.dm_fin_operations_mix_sum_t": [
                {"column_name": "calmonth", "data_type": "character varying", "column_comment": ""},
                {"column_name": "ambperformance", "data_type": "numeric", "column_comment": ""},
                {"column_name": "node_desc2", "data_type": "character varying", "column_comment": ""},
            ]
        },
        default_rows=[{"actual": 3_000_000_000}],
    )
    llm_responses = [
        # step1+2
        '{"metric":"业绩","dimensions":[],"time_range":"2026-05","scope":"集团","key_entities":[],"ambiguities":[],"table":"dm.dm_fin_operations_mix_sum_t","reason":"默认主表"}',
        # step3 (bad SQL triggering self-heal)
        "```sql\nSELECT bad_col FROM dm.dm_fin_operations_mix_sum_t WHERE calmonth = '2026-05'\n```",
        # step4 self-heal fix
        "```sql\nSELECT SUM(ambperformance) as actual FROM dm.dm_fin_operations_mix_sum_t WHERE calmonth = '2026-05'\n```",
        # step5
        '{"tldr":["销售额正常"],"kpis":[{"label":"销售额","value":3000000000,"unit":"元","yoy":null,"mom":null,"target":null,"rank":null,"direction":"neutral"}]}',
        # step6 review
        '{"passed":true,"issues":[],"suggestion":""}',
    ]
    llm = MockLLMClient(responses=llm_responses)
    wf = AnalystWorkflow(loader, llm, mcp)
    reviewer = Reviewer(llm)

    events = []
    async for ev in wf.run_full_streaming("本月集团业绩", "sales-performance", reviewer):
        events.append(ev)

    sub_events = [e for e in events if e.get("kind") == "sub"]
    assert len(sub_events) == 2
    assert all(e["name"] == "sql_self_heal" for e in sub_events)
    assert sub_events[0]["status"] == "running"
    assert sub_events[1]["status"] == "done"

    complete = [e for e in events if e.get("kind") == "complete"]
    assert len(complete) == 1
```

- [ ] **Step 2: 跑测试确认 fail**

Run: `cd D:/dataproj && C:/Users/Administrator/AppData/Local/Programs/Python/Python39/python.exe -m pytest webapp/tests/test_workflow_streaming.py::test_step4_with_self_heal_yields_sub_events webapp/tests/test_workflow_streaming.py::test_run_full_streaming_propagates_step4_sub_events -v`

Expected: 2 FAIL（`AttributeError: _step4_with_self_heal_event` 方法不存在）

- [ ] **Step 3: 加 `_step4_with_self_heal_event` 方法**

在 `webapp/orchestrator/workflow.py` 找到 `async def step4_execute(self, sql: str) -> tuple[list[dict], str]:`（约 line 224）。在它的 docstring 行 `# -- Step 4: Execute (with COUNT preflight to catch ME2) --` 之后、`step4_execute` 之前，插入新方法：

```python
    async def _step4_with_self_heal_event(self, sql: str):
        """Async generator wrapping step4 with SSE sub events for self-heal path.

        Yields 'sub' events when status contains ERROR (LLM fix path).
        Returns (rows, status) via StopAsyncIteration.value.
        Raises NoDataError when COUNT preflight returns 0 (same as step4_execute).
        """
        base_count = await count_preflight(self.mcp, sql)
        if base_count == 0:
            raise NoDataError(
                f"COUNT preflight returned 0 — filter matches no rows. "
                f"Check time range and WHERE conditions. SQL preview: {sql[:200]}"
            )

        rows, status = await self.mcp.run_query(sql)
        if "ERROR" not in status.upper():
            return rows, status

        # Self-heal path: yield sub events
        yield _sub_event("4", "sql_self_heal", "SQL 报错，自愈中", "running")

        extra_schemas = ""
        mentioned = set(re.findall(r'[\w]+\.[\w]+', f"{sql}\n{status}"))
        for t in mentioned:
            try:
                cols = await self.mcp.describe_table(t)
                if cols:
                    names = [(c["column_name"], c["data_type"]) for c in cols[:60]]
                    extra_schemas += f"\n表 {t}：{json.dumps(names, ensure_ascii=False)}"
            except Exception:
                pass

        fixed = await self.llm.chat(
            system="修复以下SQL错误。只用列出的表，参考给定的列清单。不要JOIN。直接输出修复后的SQL，不要额外文字。" + extra_schemas,
            user=f"SQL：{sql}\n错误：{status}",
            temperature=0,
        )
        rows2, status2 = await self.mcp.run_query(_extract_sql(fixed))

        yield _sub_event("4", "sql_self_heal", "SQL 自愈完成", "done")
        return rows2, status2

```

- [ ] **Step 4: 在 `run_full_streaming` 里把 `step4_execute` 调用换成新方法**

`webapp/orchestrator/workflow.py` 的 `run_full_streaming` 方法里，找到这一段：

```python
            # step 4 (execute) — Task 2 will swap to _step4_with_self_heal_event for sub events
            t0 = _now_ms()
            yield _step_event("4", "running", t0)
            try:
                data, status = await self.step4_execute(sql)
            except NoDataError as e:
                yield _step_event("4", "error", t0, _now_ms() - t0, str(e))
                yield _error_event("no_data", "4", str(e))
                return
            yield _step_event("4", "done", t0, _now_ms() - t0)
```

替换为：

```python
            # step 4 (execute) — yields sub events for SQL self-heal path
            t0 = _now_ms()
            yield _step_event("4", "running", t0)
            try:
                gen = self._step4_with_self_heal_event(sql)
                data, status = None, ""
                while True:
                    try:
                        sub_ev = await gen.__anext__()
                        yield sub_ev
                    except StopAsyncIteration as stop:
                        if stop.value is not None:
                            data, status = stop.value
                        break
            except NoDataError as e:
                yield _step_event("4", "error", t0, _now_ms() - t0, str(e))
                yield _error_event("no_data", "4", str(e))
                return
            yield _step_event("4", "done", t0, _now_ms() - t0)
```

- [ ] **Step 5: 跑 Task 2 测试确认 pass**

Run: `cd D:/dataproj && C:/Users/Administrator/AppData/Local/Programs/Python/Python39/python.exe -m pytest webapp/tests/test_workflow_streaming.py -v`

Expected: 6 PASS（Task 1 的 4 + Task 2 的 2）

- [ ] **Step 6: 跑全套 pytest 确认无回归**

Run: `cd D:/dataproj && C:/Users/Administrator/AppData/Local/Programs/Python/Python39/python.exe -m pytest webapp/tests/ --ignore=webapp/tests/test_audit_logger.py -q`

Expected: 34 passed（32 + 2）

- [ ] **Step 7: Checkpoint** — step4 自愈 sub events 完成

---

## Task 3: 加 `_step6_with_retry_event` + 集成 sub events

**Files:**
- Modify: `webapp/orchestrator/workflow.py`（加新方法 `_step6_with_retry_event`，在 `run_full_streaming` 内替换 step 6 内联 retry 逻辑）
- Modify: `webapp/tests/test_workflow_streaming.py`（追加 retry 测试）

**目标**：把 step6 review 的 retry 路径提取出来，当 retry 触发时 yield `sub` event。

- [ ] **Step 1: 写测试（TDD）**

在 `webapp/tests/test_workflow_streaming.py` 末尾追加：

```python


@pytest.mark.asyncio
async def test_run_full_streaming_yields_review_retry_sub_events(loader):
    """When first review fails (≤2 issues), retry path yields review_retry sub events."""
    mcp = MockMcpClient(
        query_results={"COUNT(*)": [{"cnt": 100}]},
        default_rows=[{"actual": 3_000_000_000}],
    )
    llm_responses = [
        # step1+2
        '{"metric":"业绩","dimensions":[],"time_range":"2026-05","scope":"集团","key_entities":[],"ambiguities":[],"table":"dm.dm_fin_operations_mix_sum_t","reason":"默认主表"}',
        # step3
        "```sql\nSELECT SUM(ambperformance) as actual FROM dm.dm_fin_operations_mix_sum_t WHERE calmonth = '2026-05'\n```",
        # step5
        '{"tldr":["销售额正常"],"kpis":[{"label":"销售额","value":3000000000,"unit":"元","yoy":null,"mom":null,"target":null,"rank":null,"direction":"neutral"}]}',
        # step6 review 1 (fail with 1 issue)
        '{"passed":false,"issues":["结论缺少同比"],"suggestion":"加同比变化"}',
        # step6 retry fix (LLM rewrite of analysis)
        "本月销售额 30 亿元，达成良好。同比 +5%。",
        # step6 review 2 (pass)
        '{"passed":true,"issues":[],"suggestion":""}',
    ]
    llm = MockLLMClient(responses=llm_responses)
    wf = AnalystWorkflow(loader, llm, mcp)
    reviewer = Reviewer(llm)

    events = []
    async for ev in wf.run_full_streaming("本月集团业绩", "sales-performance", reviewer):
        events.append(ev)

    sub_events = [e for e in events if e.get("kind") == "sub"]
    assert len(sub_events) == 2, f"expected 2 sub events (running+done), got {sub_events}"
    assert sub_events[0]["name"] == "review_retry"
    assert sub_events[0]["parent_step"] == "6"
    assert sub_events[0]["status"] == "running"
    assert sub_events[1]["name"] == "review_retry"
    assert sub_events[1]["status"] == "done"

    complete = [e for e in events if e.get("kind") == "complete"]
    assert len(complete) == 1
    # final analysis must be the LLM-rewritten one (containing 同比)
    assert "同比" in complete[0]["result"].analysis


@pytest.mark.asyncio
async def test_run_full_streaming_no_sub_events_when_review_passes_first_try(loader):
    """Happy path: review passes first time, no retry, no sub events."""
    mcp = MockMcpClient(
        query_results={"COUNT(*)": [{"cnt": 100}]},
        default_rows=[{"actual": 3_000_000_000}],
    )
    llm_responses = [
        '{"metric":"业绩","dimensions":[],"time_range":"2026-05","scope":"集团","key_entities":[],"ambiguities":[],"table":"dm.dm_fin_operations_mix_sum_t","reason":"默认主表"}',
        "```sql\nSELECT SUM(ambperformance) as actual FROM dm.dm_fin_operations_mix_sum_t WHERE calmonth = '2026-05'\n```",
        '{"tldr":["销售额正常"],"kpis":[{"label":"销售额","value":3000000000,"unit":"元","yoy":null,"mom":null,"target":null,"rank":null,"direction":"neutral"}]}',
        '{"passed":true,"issues":[],"suggestion":""}',
    ]
    llm = MockLLMClient(responses=llm_responses)
    wf = AnalystWorkflow(loader, llm, mcp)
    reviewer = Reviewer(llm)

    events = []
    async for ev in wf.run_full_streaming("本月集团业绩", "sales-performance", reviewer):
        events.append(ev)

    sub_events = [e for e in events if e.get("kind") == "sub"]
    assert len(sub_events) == 0, f"happy path must not yield sub events, got {sub_events}"
```

- [ ] **Step 2: 跑测试确认 fail**

Run: `cd D:/dataproj && C:/Users/Administrator/AppData/Local/Programs/Python/Python39/python.exe -m pytest webapp/tests/test_workflow_streaming.py::test_run_full_streaming_yields_review_retry_sub_events -v`

Expected: FAIL（当前 run_full_streaming 不会 yield sub events on retry，因为没有 _step6_with_retry_event）

- [ ] **Step 3: 加 `_step6_with_retry_event` 方法**

在 `webapp/orchestrator/workflow.py` 找到 `async def step5_interpret(self, ...)`（约 line 257）。在它之后、`run_full_streaming` 之前，插入新方法：

```python
    async def _step6_with_retry_event(
        self,
        question: str, sql: str, data: list[dict],
        analysis: str, reviewer: Reviewer,
    ):
        """Async generator wrapping step6 review with SSE sub events for retry path.

        Yields 'sub' events when first review fails with ≤2 issues and LLM rewrite is attempted.
        Returns (final_review, final_analysis, retry_triggered) via StopAsyncIteration.value.
        """
        review, review_used = await reviewer.review(question, sql, data, analysis, self.mcp)
        if review.passed or len(review.issues) > 2:
            return review, analysis, False

        # Retry path: yield sub events
        yield _sub_event("6", "review_retry", "审核未通过，重试中", "running")
        fixed = await self.llm.chat(
            system=f"根据审查意见修复分析。问题：{review.issues}\n建议：{review.suggestion}\n输出修复后的Markdown。",
            user=f"原始：\n{analysis}",
            temperature=0.1,
        )
        final_analysis = fixed
        review, _ = await reviewer.review(question, sql, data, final_analysis, self.mcp)
        yield _sub_event("6", "review_retry", "审核重试完成", "done")
        return review, final_analysis, True

```

- [ ] **Step 4: 在 `run_full_streaming` 里把 step 6 内联 retry 换成新方法**

`webapp/orchestrator/workflow.py` 的 `run_full_streaming` 方法里，找到这一段：

```python
            # step 6 (review) — Task 3 will swap to _step6_with_retry_event for sub events
            t0 = _now_ms()
            yield _step_event("6", "running", t0)
            review, review_used = await reviewer.review(question, sql, data, analysis, self.mcp)
            if not review.passed and len(review.issues) <= 2:
                fixed = await self.llm.chat(
                    system=f"根据审查意见修复分析。问题：{review.issues}\n建议：{review.suggestion}\n输出修复后的Markdown。",
                    user=f"原始：\n{analysis}",
                    temperature=0.1,
                )
                analysis = fixed
                review, _ = await reviewer.review(question, sql, data, analysis, self.mcp)
            yield _step_event("6", "done", t0, _now_ms() - t0)
```

替换为：

```python
            # step 6 (review) — yields sub events for retry path
            t0 = _now_ms()
            yield _step_event("6", "running", t0)
            gen = self._step6_with_retry_event(question, sql, data, analysis, reviewer)
            review, analysis, _retry_triggered = None, analysis, False
            while True:
                try:
                    sub_ev = await gen.__anext__()
                    yield sub_ev
                except StopAsyncIteration as stop:
                    if stop.value is not None:
                        review, analysis, _retry_triggered = stop.value
                    break
            yield _step_event("6", "done", t0, _now_ms() - t0)
```

- [ ] **Step 5: 跑 Task 3 测试确认 pass**

Run: `cd D:/dataproj && C:/Users/Administrator/AppData/Local/Programs/Python/Python39/python.exe -m pytest webapp/tests/test_workflow_streaming.py -v`

Expected: 8 PASS（Task 1 的 4 + Task 2 的 2 + Task 3 的 2）

- [ ] **Step 6: 跑全套 pytest 确认无回归**

Run: `cd D:/dataproj && C:/Users/Administrator/AppData/Local/Programs/Python/Python39/python.exe -m pytest webapp/tests/ --ignore=webapp/tests/test_audit_logger.py -q`

Expected: 36 passed（34 + 2）

- [ ] **Step 7: Checkpoint** — step6 重试 sub events 完成

---

## Task 4: `/ask` 改 StreamingResponse + `_format_sse` + `row_count` 字段

**Files:**
- Modify: `webapp/main.py:42-55`（AskResponse 加 `row_count: int = 0`）
- Modify: `webapp/main.py:58-171`（`/ask` 改 StreamingResponse）
- Modify: `webapp/main.py`（加 `_format_sse` helper）
- Create: `webapp/tests/test_main_streaming.py`

**目标**：把 `/ask` 端点从普通 POST JSON 改为 SSE 流式响应；为前端提供 row_count 字段。Router 错域 / needs_confirmation 早返路径保留普通 JSON。

- [ ] **Step 1: 写 `_format_sse` 单测（TDD）**

Create `webapp/tests/test_main_streaming.py`:

```python
"""Tests for /ask SSE conversion in main.py."""
from __future__ import annotations

import json

from webapp.main import _format_sse


def test_format_sse_emits_event_line_and_data_line():
    ev = {"kind": "step", "step": "1+2", "status": "running"}
    out = _format_sse(ev)
    assert out.startswith("event: step\n")
    assert out.endswith("\n\n")
    data_line = [l for l in out.split("\n") if l.startswith("data: ")][0]
    payload = json.loads(data_line[len("data: "):])
    assert payload["step"] == "1+2"
    assert payload["status"] == "running"


def test_format_sse_strips_kind_from_data():
    ev = {"kind": "complete", "payload": {"markdown": "x"}}
    out = _format_sse(ev)
    assert "event: complete\n" in out
    data_line = [l for l in out.split("\n") if l.startswith("data: ")][0]
    payload = json.loads(data_line[len("data: "):])
    assert "kind" not in payload, "kind must not duplicate into data"
    assert payload["payload"]["markdown"] == "x"


def test_format_sse_handles_chinese_chars_without_escaping():
    ev = {"kind": "step", "step": "3", "label": "生成 SQL"}
    out = _format_sse(ev)
    assert "生成 SQL" in out  # ensure_ascii=False


def test_format_sse_does_not_mutate_input():
    ev = {"kind": "step", "step": "1+2", "status": "running"}
    _format_sse(ev)
    assert ev == {"kind": "step", "step": "1+2", "status": "running"}, "input must not be mutated"
```

- [ ] **Step 2: 跑测试确认 fail**

Run: `cd D:/dataproj && C:/Users/Administrator/AppData/Local/Programs/Python/Python39/python.exe -m pytest webapp/tests/test_main_streaming.py -v`

Expected: 4 FAIL（`ImportError: cannot import name '_format_sse'`）

- [ ] **Step 3: 给 `AskResponse` 加 `row_count` 字段**

`webapp/main.py` 当前 `class AskResponse(BaseModel):`（约 line 42-55）。在 `report_url: Optional[str] = None` 之后追加 `row_count: int = 0`。

修改前：

```python
class AskResponse(BaseModel):
    session_id: str
    turn_id: str = ""
    domain: str = ""
    confidence: float = 0
    markdown: str = ""
    sql: str = ""
    review_passed: bool = True
    kpi_card: Optional[dict] = None          # NEW
    magnitude_warnings: list[str] = []    # NEW
    data_freshness: Optional[dict] = None    # NEW: {"table": "...", "last_updated": "...", "lag_days": N}
    report_url: Optional[str] = None
    trace: list[dict] = []
    needs_confirmation: bool = False
    message: str = ""
```

修改后：

```python
class AskResponse(BaseModel):
    session_id: str
    turn_id: str = ""
    domain: str = ""
    confidence: float = 0
    markdown: str = ""
    sql: str = ""
    review_passed: bool = True
    row_count: int = 0                       # NEW: data row count for audit + UI display
    kpi_card: Optional[dict] = None
    magnitude_warnings: list[str] = []
    data_freshness: Optional[dict] = None
    report_url: Optional[str] = None
    trace: list[dict] = []
    needs_confirmation: bool = False
    message: str = ""
```

- [ ] **Step 4: 加 `_format_sse` helper**

在 `webapp/main.py` 找到 `async def _get_data_freshness(mcp, sql: str) -> dict | None:`（约 line 179）。在它**之前**插入：

```python
def _format_sse(ev: dict) -> str:
    """Format an event dict as an SSE frame: 'event: <kind>\\ndata: <json>\\n\\n'."""
    ev_copy = dict(ev)
    kind = ev_copy.pop("kind", "message")
    return f"event: {kind}\ndata: {json.dumps(ev_copy, ensure_ascii=False)}\n\n"


```

并在 `webapp/main.py` 顶部 imports 处加 `import json`（如果还没有）。

修改 `webapp/main.py:1-12` 当前：

```python
"""智能问数 Web 服务 MVP v0.1 — FastAPI entry point."""
from __future__ import annotations
import time
import uuid
from pathlib import Path
from contextlib import asynccontextmanager
from typing import Optional
from dotenv import load_dotenv
load_dotenv()
```

加 `import json`：

```python
"""智能问数 Web 服务 MVP v0.1 — FastAPI entry point."""
from __future__ import annotations
import json
import time
import uuid
from pathlib import Path
from contextlib import asynccontextmanager
from typing import Optional
from dotenv import load_dotenv
load_dotenv()
```

然后在 imports 区追加 `StreamingResponse`、`JSONResponse`：

当前：

```python
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
```

改为：

```python
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
```

- [ ] **Step 5: 把 `/ask` 改成 StreamingResponse**

`webapp/main.py` 当前的 `@app.post("/ask", response_model=AskResponse) async def ask(req: AskRequest):` 整段（约 line 58-171，包含 router 早返 + workflow.run_full + audit + AskResponse 返回）替换为：

```python
def _build_history(session, question: str):
    """Build LLM-ready history from session messages; None if empty session."""
    if not session.messages:
        return None
    return [{"role": m.role, "content": m.content} for m in session.messages[-6:]]


@app.post("/ask")
async def ask(req: AskRequest):
    """Stream analysis events back to client via SSE.

    Non-streaming JSON is returned only when:
      - router.domain == 'unknown' (unsupported domain)
      - router.needs_confirmation (low confidence)
      - NoDataError or exception during workflow (router yields error event then ends stream)
    """
    session = session_mgr.get_or_create(req.session_id)
    start_time = time.time()
    history = _build_history(session, req.question)
    is_followup = len(req.question.strip()) < 8

    route = await app.state.router.route(req.question, history=history if is_followup else None)

    # Router early-return paths — non-streaming JSON
    if route.domain == "unknown":
        latency = int((time.time() - start_time) * 1000)
        app.state.audit.log(
            session_id=session.session_id, question=req.question, domain="unknown",
            sql="", row_count=0, review_passed=False, latency_ms=latency,
            tldr="", model="deepseek-v4-pro", error="unsupported_domain",
        )
        return JSONResponse({
            "session_id": session.session_id,
            "needs_confirmation": True,
            "message": f"当前仅支持：{', '.join(app.state.loader.get_domain_list())}，暂不支持该问题领域。",
            "trace": [{"step": "router", "domain": "unknown"}],
        })

    if route.needs_confirmation:
        latency = int((time.time() - start_time) * 1000)
        app.state.audit.log(
            session_id=session.session_id, question=req.question, domain=route.domain,
            sql="", row_count=0, review_passed=False, latency_ms=latency,
            tldr="", model="deepseek-v4-pro", error="low_confidence_route",
            confidence=route.confidence,
        )
        return JSONResponse({
            "session_id": session.session_id,
            "domain": route.domain,
            "confidence": route.confidence,
            "needs_confirmation": True,
            "message": f"问题可能属于**{route.domain}**（置信度{route.confidence:.0%}）。备选：{', '.join(route.candidates)}。",
            "trace": [{"step": "router", "domain": route.domain, "confidence": route.confidence}],
        })

    # Main streaming path
    async def event_stream():
        try:
            wf = AnalystWorkflow(app.state.loader, app.state.llm, app.state.mcp)
            reviewer = Reviewer(app.state.llm)

            async for ev in wf.run_full_streaming(req.question, route.domain, reviewer, history):
                kind = ev.get("kind")
                if kind == "complete":
                    # Finalize: store result, audit, build full payload
                    result = ev["result"]
                    turn_id = uuid.uuid4().hex[:8]
                    session.store_result(turn_id, result)
                    session.add_message("user", req.question)
                    session.add_message("assistant", result.analysis)

                    data_freshness = await _get_data_freshness(app.state.mcp, result.sql)

                    latency = int((time.time() - start_time) * 1000)
                    tldr = result.kpi_card.tldr[0] if result.kpi_card and result.kpi_card.tldr else ""
                    app.state.audit.log(
                        session_id=session.session_id, question=req.question, domain=route.domain,
                        sql=result.sql, row_count=len(result.data),
                        review_passed=result.review.passed, latency_ms=latency,
                        tldr=tldr, model="deepseek-v4-pro",
                        magnitude_warnings=result.magnitude_warnings,
                    )

                    payload = {
                        "session_id": session.session_id,
                        "turn_id": turn_id,
                        "domain": route.domain,
                        "confidence": route.confidence,
                        "markdown": result.analysis,
                        "sql": result.sql,
                        "review_passed": result.review.passed,
                        "row_count": len(result.data),
                        "kpi_card": result.kpi_card.to_dict() if result.kpi_card else None,
                        "magnitude_warnings": result.magnitude_warnings,
                        "data_freshness": data_freshness,
                        "report_url": None,
                        "trace": [],
                    }
                    yield _format_sse({"kind": "complete", "payload": payload})
                else:
                    yield _format_sse(ev)
        except Exception as e:
            yield _format_sse({
                "kind": "error",
                "type": "exception",
                "step": "",
                "message": f"{type(e).__name__}: {e}"[:300],
            })

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # disable nginx proxy buffering
            "Connection": "keep-alive",
        },
    )
```

- [ ] **Step 6: 跑 `_format_sse` 单测确认 pass**

Run: `cd D:/dataproj && C:/Users/Administrator/AppData/Local/Programs/Python/Python39/python.exe -m pytest webapp/tests/test_main_streaming.py -v`

Expected: 4 PASS

- [ ] **Step 7: 启动 webapp，手动 curl 验证 SSE 响应**

启动 webapp（后台）：

```bash
cd D:/dataproj && C:/Users/Administrator/AppData/Local/Programs/Python/Python39/python.exe -m uvicorn webapp.main:app --host 127.0.0.1 --port 8002 --log-level warning &
```

Poll 直到 ready：

```bash
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 3
  curl -s --max-time 3 http://127.0.0.1:8002/domain | grep -q domains && echo "ready" && break
done
```

发请求验证 content-type：

```bash
curl -i -s -X POST http://127.0.0.1:8002/ask \
  -H "Content-Type: application/json" \
  -d '{"question":"本月集团业绩"}' \
  --max-time 5 2>&1 | head -20
```

Expected：HTTP response 第一行 `HTTP/1.1 200 OK`，headers 包含 `content-type: text/event-stream; charset=utf-8` 和 `x-accel-buffering: no`。Body 头部应该有 `event: step\ndata: {...}\n\n` 帧的开头（可能因 max-time 截断）。

- [ ] **Step 8: 关闭 webapp**

```bash
netstat -ano | grep ":8002.*LISTENING" | awk '{print $5}' | head -1 | xargs -I {} taskkill //F //PID {}
```

- [ ] **Step 9: 跑全套 pytest 确认无回归**

Run: `cd D:/dataproj && C:/Users/Administrator/AppData/Local/Programs/Python/Python39/python.exe -m pytest webapp/tests/ --ignore=webapp/tests/test_audit_logger.py -q`

Expected: 40 passed（36 + 4）

- [ ] **Step 10: Checkpoint** — `/ask` SSE 流式接口完成

---

## Task 5: 前端 `index.html` 改 fetch ReadableStream + StepList

**Files:**
- Modify: `webapp/static/index.html`（重写 `ask()` 方法、加 StepList 组件、加 watchdog、加 CSS）

**目标**：把当前 `fetch + await r.json()` 改成 `fetch + ReadableStream + TextDecoder` 实时解析 SSE 帧；显示步骤清单。

**注意**：现有 `index.html` 已经是 Linear 风暗色 SaaS 风（最近刚改），保留整体审美；只在 `loading-card` 位置加 StepList 组件，在 `ask()` 方法改实现，并保留 TL;DR/KPI/数据明细等所有现有功能。

- [ ] **Step 1: 改 `ask()` 方法为流式 + 加新方法**

在 `webapp/static/index.html` 找到 `methods: {` 后的 `async ask(text) { ... }` 整段（约当前 line 380-420 左右，含 try/catch/finally）。

替换原 `ask(text)` 方法（保留 `sendFeedback` 等其他方法不动）：

```javascript
    async ask(text) {
      const t = (typeof text === 'string' ? text : this.q).trim();
      if (!t || this.loading) return;
      this.q = '';
      this.loading = true;

      const item = {
        question: t,
        trace: [],
        status: 'running',
        markdown: '', kpi_card: null, magnitude_warnings: [],
        sql: '', review_passed: true, row_count: 0,
        session_id: null, turn_id: null,
        report_url: null, report_state: 'none',
        feedback: null, detail_open: false, sql_open: false,
        error_message: '',
      };
      this.history.push(item);
      this.startWatchdog(item);

      let reader = null;
      try {
        const resp = await fetch('/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: this.sessionId, question: t }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        if (!resp.body || !resp.body.getReader) throw new Error('浏览器不支持 ReadableStream');

        reader = resp.body.getReader();
        item._reader = reader;
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
        if (item.status === 'running') {
          item.status = 'error';
          item.error_message = '连接断开，未收到完整响应';
        }
      } catch (e) {
        item.status = 'error';
        item.error_message = e.message;
      } finally {
        this.loading = false;
        this.clearWatchdog(item);
        if (item._reader) {
          try { item._reader.releaseLock(); } catch (_) {}
          item._reader = null;
        }
      }
    },

    parseSSEFrame(frame) {
      const lines = frame.split('\n');
      let event = 'message';
      let data = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) event = line.slice(7).trim();
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      if (!data) return null;
      try {
        return { event, data: JSON.parse(data) };
      } catch (e) {
        console.warn('[SSE] bad JSON', data, e);
        return null;
      }
    },

    applyEvent(item, ev) {
      const { event, data } = ev;
      if (event === 'step') {
        const idx = item.trace.findIndex(s => s.step === data.step);
        if (idx >= 0) item.trace.splice(idx, 1, { ...item.trace[idx], ...data });
        else item.trace.push({ ...data, subs: [] });
      } else if (event === 'sub') {
        const parent = item.trace.find(s => s.step === data.parent_step);
        if (parent) {
          if (!parent.subs) parent.subs = [];
          const idx = parent.subs.findIndex(s => s.name === data.name);
          if (idx >= 0) parent.subs.splice(idx, 1, { ...parent.subs[idx], ...data });
          else parent.subs.push(data);
        }
      } else if (event === 'error') {
        item.status = 'error';
        item.error_message = data.message || '分析失败';
        item.error_type = data.type;
      } else if (event === 'complete') {
        const p = data.payload || {};
        item.markdown = p.markdown || '';
        item.kpi_card = p.kpi_card;
        item.magnitude_warnings = p.magnitude_warnings || [];
        item.sql = p.sql || '';
        item.review_passed = p.review_passed;
        item.row_count = p.row_count || 0;
        item.turn_id = p.turn_id;
        if (p.session_id) this.sessionId = p.session_id;
        if (p.report_url) {
          item.report_url = p.report_url;
          item.report_state = 'ready';
        }
        item.status = 'done';
      }
    },

    startWatchdog(item) {
      this.clearWatchdog(item);
      item._watchdog = setTimeout(() => {
        if (item.status === 'running') {
          item.status = 'error';
          item.error_message = '请求超时（90s），请稍后重试';
          if (item._reader) {
            try { item._reader.cancel(); } catch (_) {}
          }
        }
      }, 90000);
    },

    clearWatchdog(item) {
      if (item._watchdog) {
        clearTimeout(item._watchdog);
        item._watchdog = null;
      }
    },

    stepIcon(s) {
      if (s.status === 'done') return '✓';
      if (s.status === 'error') return '×';
      if (s.status === 'running') return '⏳';
      return '○';
    },

    stepTime(s) {
      if (s.status === 'done' && s.duration_ms != null) {
        return (s.duration_ms / 1000).toFixed(1) + 's';
      }
      if (s.status === 'running' && s.started_at) {
        const elapsed = Math.max(0, (Date.now() - s.started_at) / 1000);
        return elapsed.toFixed(0) + 's';
      }
      return '';
    },
```

- [ ] **Step 2: 在模板里把现有 `loading-card` 改成 StepList（区分进行中 / 错误 / 完成）**

在 `webapp/static/index.html` 找到现有 `<div class="loading-card" v-if="loading">...</div>`（约当前 line 580 左右）。

把它替换为 StepList（支持进行中状态显示步骤、错误状态显示错误信息、完成状态由现有 `<div class="conversation">` 接管）：

```html
  <!-- 进行中：StepList -->
  <div class="conversation" v-for="(item, i) in history" :key="i" v-if="item.status === 'running'">
    <div class="question-row">
      <div class="question-bubble">{{ item.question }}</div>
    </div>
    <div class="answer">
      <div class="answer-body">
        <div class="step-list">
          <div class="step-item" v-for="s in item.trace" :key="s.step" :class="s.status">
            <span class="step-icon">{{ stepIcon(s) }}</span>
            <span class="step-label">{{ s.label }}</span>
            <span class="step-time">{{ stepTime(s) }}</span>
            <div class="sub-list" v-if="s.subs && s.subs.length">
              <div class="sub-item" v-for="sub in s.subs" :key="sub.name" :class="sub.status">
                <span class="sub-icon">⚠</span>
                <span class="sub-label">{{ sub.label }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- 错误：错误卡 -->
  <div class="conversation" v-for="(item, i) in history" :key="'err' + i" v-if="item.status === 'error'">
    <div class="question-row">
      <div class="question-bubble">{{ item.question }}</div>
    </div>
    <div class="answer has-error">
      <div class="answer-body">
        <div class="step-list" v-if="item.trace.length">
          <div class="step-item" v-for="s in item.trace" :key="s.step" :class="s.status">
            <span class="step-icon">{{ stepIcon(s) }}</span>
            <span class="step-label">{{ s.label }}</span>
            <span class="step-time">{{ stepTime(s) }}</span>
          </div>
        </div>
        <div class="error-banner">
          <span class="error-icon">⚠</span>
          <span>{{ item.error_message || '分析失败' }}</span>
        </div>
      </div>
    </div>
  </div>
```

**保留**现有的 `<div class="conversation" v-for="(item, i) in history" :key="i">` 那一段（即完整的 answer card），但加一个 `v-if="item.status === 'done'"` 条件，确保只有完成态才显示完整 answer card：

修改现有的：

```html
  <div class="conversation" v-for="(item, i) in history" :key="i">
```

改为：

```html
  <div class="conversation" v-for="(item, i) in history" :key="'done' + i" v-if="item.status === 'done'">
```

- [ ] **Step 3: 加 StepList / error-banner / sub-list CSS**

在 `webapp/static/index.html` 的 `<style>` 块里，找到 `.loading-card {` 之前，插入：

```css
  /* StepList */
  .step-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    font-family: var(--font);
  }
  .step-item {
    display: grid;
    grid-template-columns: 24px 1fr auto;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius);
    transition: background 0.2s ease;
  }
  .step-item.running { background: var(--accent-bg); }
  .step-item.done { color: var(--text-secondary); }
  .step-item.error { background: var(--danger-bg); color: var(--danger); }
  .step-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    font-size: 11px;
    font-weight: 700;
    background: var(--bg-elevated);
    color: var(--text-tertiary);
  }
  .step-item.running .step-icon {
    background: var(--accent);
    color: white;
    animation: pulse 1.4s ease-in-out infinite;
  }
  .step-item.done .step-icon {
    background: var(--success-bg);
    color: var(--success);
  }
  .step-item.error .step-icon {
    background: var(--danger-bg);
    color: var(--danger);
  }
  .step-label {
    font-size: 13px;
    font-weight: 500;
  }
  .step-item.running .step-label { color: var(--accent); }
  .step-item.done .step-label { color: var(--text-secondary); }
  .step-time {
    font-size: 11px;
    color: var(--text-tertiary);
    font-feature-settings: "tnum";
  }

  /* SubList (retry / self-heal) */
  .sub-list {
    grid-column: 2 / 4;
    margin-top: var(--space-1);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .sub-item {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: 12px;
    color: var(--warning);
    padding-left: var(--space-3);
    border-left: 2px solid var(--warning);
  }
  .sub-item.done { color: var(--text-secondary); border-left-color: var(--text-tertiary); }

  /* Error banner */
  .error-banner {
    margin-top: var(--space-3);
    padding: var(--space-3) var(--space-4);
    background: var(--danger-bg);
    border: 1px solid rgba(248, 113, 113, 0.3);
    border-radius: var(--radius);
    color: var(--danger);
    font-size: 13px;
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
  }
  .error-icon { flex-shrink: 0; }

```

- [ ] **Step 4: 浏览器手测**

启动 webapp（如果 Task 4 已关，重新启）：

```bash
cd D:/dataproj && C:/Users/Administrator/AppData/Local/Programs/Python/Python39/python.exe -m uvicorn webapp.main:app --host 127.0.0.1 --port 8002 --log-level warning &
```

打开浏览器：`http://127.0.0.1:8002/static/index.html`

逐项验证：
- 输入「本月集团业绩」按 Enter
- **预期**：右下出现 question 气泡 + 一个 answer 卡，里面 6 个 step 竖排，每行有 ✓/⏳/○ 图标 + 标签 + 计时
- 第一个 step 立刻变 ⏳ + 「已用 1s」计时
- 每过 ~10-15s 一个 step 切换到 ✓，下一个变 ⏳
- 全部完成（~60-90s）后，StepList 整体消失，TL;DR + KPI + 报告按钮展开

- [ ] **Step 5: 关闭 webapp**

```bash
netstat -ano | grep ":8002.*LISTENING" | awk '{print $5}' | head -1 | xargs -I {} taskkill //F //PID {}
```

- [ ] **Step 6: Checkpoint** — 前端流式接收 + StepList 完成（手测验证）

---

## Task 6: 4 问手测验收 + 写 acceptance doc + 全套回归

**Files:**
- Create: `docs/superpowers/acceptance/2026-06-26-streaming-progress-acceptance.md`

**目标**：跑 4 个场景的手测（正常 / NoData / SQL 自愈 / 中断），写 acceptance doc，确认全套 pytest 不回归。

- [ ] **Step 1: 启动 webapp**

```bash
cd D:/dataproj && C:/Users/Administrator/AppData/Local/Programs/Python/Python39/python.exe -m uvicorn webapp.main:app --host 127.0.0.1 --port 8002 --log-level warning &
```

Poll until ready:

```bash
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 3
  curl -s --max-time 3 http://127.0.0.1:8002/domain | grep -q domains && echo "ready" && break
done
```

- [ ] **Step 2: 手测场景 1 — 正常问**

浏览器打开 `http://127.0.0.1:8002/static/index.html`，输入「本月集团业绩？」按 Enter。

**预期**：
- 立刻出现 StepList，6 步竖排
- 第一个 step 立刻变 running（"理解问题 + 选表"），随后逐步切换
- 最终 step 全部 done，StepList 消失，TL;DR + KPI + 报告按钮展开
- 总耗时 ~60-90s

记录：实际耗时、是否所有 6 步都显示了、最终 KPI 是否正确。

- [ ] **Step 3: 手测场景 2 — NoDataError**

输入「2099年1月业绩」按 Enter。

**预期**：
- StepList 显示，step 1+2/3 done，step 4 显示红色 × error
- 显示 error-banner「COUNT preflight returned 0」
- 不显示 complete 的 answer card

- [ ] **Step 4: 手测场景 3 — SQL 自愈（依赖真实 LLM 触发，可能跳过）**

输入「丽适岩板本月达成率」按 Enter。

**预期（如果 LLM 第一次生成的 SQL 错误）**：
- StepList 显示，step 4 下方出现 sub item「⚠ SQL 报错，自愈中」
- 自愈完成后 sub item 变灰色「SQL 自愈完成」
- 流程继续到完成

**预期（如果 LLM 一次成功）**：正常完成，无 sub item（这是 OK 的）

记录：是否触发自愈。

- [ ] **Step 5: 手测场景 4 — 浏览器中断**

输入一个长问题（如「5 大事业部本月排名」），在 step 3 或 step 4 期间关闭浏览器标签。

**预期**：服务端日志显示 generator 收到 CancelledError 或 client disconnect，但不影响后续请求。重新打开浏览器仍能正常使用。

- [ ] **Step 6: 关闭 webapp**

```bash
netstat -ano | grep ":8002.*LISTENING" | awk '{print $5}' | head -1 | xargs -I {} taskkill //F //PID {}
```

- [ ] **Step 7: 写 acceptance doc**

Create `docs/superpowers/acceptance/2026-06-26-streaming-progress-acceptance.md`:

```markdown
# Streaming Progress 验收报告

> 日期：2026-06-26
> 对比基线：Phase 1.5 spike（avg latency 64s、无进度反馈）
> 设计文档：`docs/superpowers/specs/2026-06-26-streaming-progress-design.md`

## 1. 改动摘要

| Task | 改动 | 文件 |
|---|---|---|
| 1 | `run_full_streaming` async generator + helpers + `run_full` thin wrapper | workflow.py |
| 2 | `_step4_with_self_heal_event` 提取，yield SQL 自愈 sub events | workflow.py |
| 3 | `_step6_with_retry_event` 提取，yield 审核重试 sub events | workflow.py |
| 4 | `/ask` 改 StreamingResponse + `_format_sse` + AskResponse.row_count | main.py |
| 5 | fetch ReadableStream + StepList 组件 + 90s watchdog | index.html |

## 2. 验收结果

### 2.1 自动化测试

- pytest: **40 passed**（基线 28 + streaming 8 + main 4）
- `test_audit_logger.py` 1 个失败与本改动无关（test 自身 hardcoded `2026-06-25.jsonl` 日期 bug）

### 2.2 手测 4 场景

| # | 场景 | 预期 | 实测 |
|---|---|---|---|
| 1 | 「本月集团业绩？」 | 6 步逐个切换 → KPI 显示 | （实施时填） |
| 2 | 「2099年1月业绩」 | step 4 × + error banner | （实施时填） |
| 3 | 「丽适岩板本月达成率」 | 触发或不触发 SQL 自愈 sub | （实施时填） |
| 4 | 浏览器中断 | 后端不挂，下次正常 | （实施时填） |

### 2.3 性能

- 首次 step running event 到达时间：≤1s（基本是网络 + FastAPI 启动开销）
- 每个 step 切换延迟：≤100ms（LLM 调用本身耗时主导）
- 90s watchdog：未触发（实测 60-90s 内完成）

## 3. 不破坏项

- ✅ pytest 28→40 passed
- ✅ `/generate_report` 接口未变
- ✅ `report_url` 默认 null（前端按需触发）
- ✅ Session 缓存机制（last_results）不变
- ✅ Audit log 字段不变

## 4. Followup

- LLM token-level streaming（step3/step5 流式吐字）— 独立 spike
- StepList 历史展开（看过去的提问各步耗时）— UX 增强
- 长耗时步骤自适应提示「这一步通常要 15s」

## 5. 结论

Streaming Progress 状态：**✅ 全部达标**

用户从「干等 60-90s 无反馈」变成「6 步实时切换 + 已用时间显示」，C-Level 体验显著改善。
```

**注意**：场景 1-4 的「实测」列在实施时实际跑完后再填，**不要留下「（实施时填）」占位符**。如果某个场景无法触发（如场景 3 没触发自愈），如实写「未触发自愈，LLM 一次成功」。

- [ ] **Step 8: 最终全套回归**

```bash
cd D:/dataproj && C:/Users/Administrator/AppData/Local/Programs/Python/Python39/python.exe -m pytest webapp/tests/ --ignore=webapp/tests/test_audit_logger.py -q && C:/Users/Administrator/AppData/Local/Programs/Python/Python39/python.exe run_eval.py sales-performance
```

Expected: 40 pytest passed + 25 eval passed

- [ ] **Step 9: Checkpoint** — Streaming Progress 全部交付

---

## Self-Review

### Spec coverage 检查

| Spec 章节 | 对应 Task |
|---|---|
| §4 架构（generator → SSE → fetch） | Task 1, 4, 5 ✅ |
| §5.1 step event | Task 1 ✅ |
| §5.2 sub event (SQL self-heal) | Task 2 ✅ |
| §5.2 sub event (review retry) | Task 3 ✅ |
| §5.3 error event (no_data / exception) | Task 1 ✅ |
| §5.4 complete event | Task 4 ✅ |
| §6.1 workflow.py streaming + helpers | Task 1, 2, 3 ✅ |
| §6.2 main.py /ask + _format_sse + row_count | Task 4 ✅ |
| §6.3 index.html fetch + StepList + watchdog | Task 5 ✅ |
| §7 错误处理矩阵 | Task 1 (NoData), Task 2 (self-heal), Task 3 (retry), Task 5 (watchdog), Task 6 (router 早返保留) ✅ |
| §8 测试策略（4 个后端 pytest + 前端手测） | Task 1 (2), Task 2 (2), Task 3 (2), Task 4 (4) — 总 10 个新增 pytest，超 spec 的 4 个最低要求；Task 6 手测 4 场景 ✅ |

### Placeholder 扫描

- ❌ Task 6 Step 7 acceptance doc 有「（实施时填）」占位符 — **这是合规的**：spec 明确说实施时填实测数据。文档本身有明确指导「不要留下占位符」，实施者必须填实。
- ✅ 其他 Task 的所有 code/test/command 都是完整的。

### Type consistency 检查

- `run_full_streaming` 签名 `(self, question, domain, reviewer, history)` 与 `run_full` 完全一致 ✅
- `_step4_with_self_heal_event(sql)` 与 `_step6_with_retry_event(question, sql, data, analysis, reviewer)` 在 Task 2/3 测试和 run_full_streaming 调用点签名一致 ✅
- `_step_event(step, status, started_at, duration_ms=0, error="")` 在 Task 1 单测和 Task 2/3 调用点一致 ✅
- `_sub_event(parent_step, name, label, status)` 在 Task 1 定义 + Task 2/3 调用一致 ✅
- `_error_event(type_, step, message)` 在 Task 1 定义和调用一致 ✅
- AskResponse `row_count: int = 0` 在 Task 4 加，前端 Task 5 `item.row_count` 读取一致 ✅

### Ambiguity 检查

- Task 1 Step 5 的 streaming method 用了 `except NoDataError` — 该异常已从 `webapp.orchestrator.count_preflight` 导入（workflow.py 顶部 imports 已有）✅
- Task 2 `_ErrorFirstMcpClient` 在测试文件中作为 MockMcpClient 子类定义，构造函数接受 `describe_results=` 和 `default_rows=`，与 conftest.py MockMcpClient 签名一致 ✅
- Task 4 router 早返路径用 JSONResponse 而非 AskResponse 模型，字段集略简化（不包含所有 AskResponse 字段）— 这是有意的，前端只读 needs_confirmation 和 message 字段 ✅
- Task 5 现有 `loading-card` 模板需要被 StepList 替换 — Step 2 明确给出了新 HTML 和 v-if 修改，不留「酌情处理」空间 ✅

### Scope 检查

6 tasks，每个 6-10 步，每步 2-5 分钟。预计总实施时间 1-2 个工作日。Spike 性质，目标聚焦 P0（用户等得难受），不扩张到 token-level streaming 等后续 spike。

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-26-streaming-progress.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - 每个 Task 派发独立 subagent，Task 间留 review checkpoint，迭代快

**2. Inline Execution** - 在本会话内顺序执行 Task，多个 Task 一批后 pause for review
