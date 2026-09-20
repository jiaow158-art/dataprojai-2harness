# 问数 Web 服务 MVP — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有 Skills 框架暴露为内网 Web 聊天服务，5-10 个 C-level 用户通过浏览器自然语言问数。

**Architecture:** FastAPI 后端 + Vue3 CDN 单页 + Skills 编排层（Python 实现6步工作流）+ DeepSeek-V4-Pro 强模型 + 现有 MCP server 和 report-generator 零改动复用。

**Tech Stack:** Python 3.9, FastAPI, uvicorn, httpx, Vue3 CDN, marked.js, DeepSeek-V4-Pro API, 现有 psycopg2/dws_mcp_server.py

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `.env.example` | 新建 | API key 模板 |
| `webapp/` | 新建 | 所有新增代码的根目录 |
| `webapp/main.py` | 新建 | FastAPI 入口 + lifespan + 路由注册 |
| `webapp/session.py` | 新建 | 内存会话管理 |
| `webapp/routes/ask.py` | 新建 | POST /ask 接口 + GET /static/* |
| `webapp/orchestrator/loader.py` | 新建 | Skills 启动加载 |
| `webapp/orchestrator/router.py` | 新建 | LLM 域路由 |
| `webapp/orchestrator/workflow.py` | 新建 | 6 步工作流编排 |
| `webapp/orchestrator/reviewer.py` | 新建 | 第 6 步对抗审查 |
| `webapp/llm/base.py` | 新建 | LLMClient 抽象接口 |
| `webapp/llm/deepseek.py` | 新建 | DeepSeek-V4-Pro 实现 |
| `webapp/mcp/client.py` | 新建 | Python MCP stdio 客户端 |
| `webapp/render.py` | 新建 | Report Renderer（封装 build_report.py 逻辑）|
| `webapp/static/index.html` | 新建 | 前端单页 |
| `webapp/static/reports/` | 新建 | 生成的 HTML 报告落盘目录 |
| `build_report.py` | 修改 | 抽取可复用函数 |
| `.gitignore` | 修改 | 添加 .env, static/reports/ |
| `requirements.txt` | 新建 | Python 依赖 |

---

## 阶段 0：项目初始化（Day 1-2）

### Task 1: 创建目录结构 + 依赖管理

**Files:**
- Create: `webapp/__init__.py`
- Create: `webapp/main.py` (骨架)
- Create: `webapp/routes/__init__.py`
- Create: `webapp/orchestrator/__init__.py`
- Create: `webapp/llm/__init__.py`
- Create: `webapp/mcp/__init__.py`
- Create: `webapp/static/.gitkeep`
- Create: `webapp/static/reports/.gitkeep`
- Create: `requirements.txt`
- Create: `.env.example`
- Modify: `.gitignore`

- [ ] **Step 1: 创建所有空文件和目录**

```bash
mkdir -p D:/dataproj/webapp/routes
mkdir -p D:/dataproj/webapp/orchestrator
mkdir -p D:/dataproj/webapp/llm
mkdir -p D:/dataproj/webapp/mcp
mkdir -p D:/dataproj/webapp/static
mkdir -p D:/dataproj/webapp/static/reports
```

- [ ] **Step 2: 写 `__init__.py` 文件**

每个目录下创建空的 `__init__.py`：

```bash
touch D:/dataproj/webapp/__init__.py
touch D:/dataproj/webapp/routes/__init__.py
touch D:/dataproj/webapp/orchestrator/__init__.py
touch D:/dataproj/webapp/llm/__init__.py
touch D:/dataproj/webapp/mcp/__init__.py
touch D:/dataproj/webapp/static/reports/.gitkeep
```

- [ ] **Step 3: 写 `.env.example`**

```bash
# DeepSeek API（必填）
DEEPSEEK_API_KEY=sk-your-key-here

# DWS 数据库（覆盖 MCP server 默认值，可选）
DWS_HOST=121.37.200.214
DWS_PORT=8000
DWS_DBNAME=DP_DWS
DWS_USER=aiuser
DWS_PASSWORD=
```

- [ ] **Step 4: 写 `requirements.txt`**

```
fastapi>=0.100.0
uvicorn[standard]>=0.23.0
httpx>=0.24.0
python-dotenv>=1.0.0
pandas>=1.3.0
psycopg2-binary>=2.9.0
```

- [ ] **Step 5: 更新 `.gitignore`**

在当前 `.gitignore` 末尾追加：

```bash
# 问数 Web 服务
.env
webapp/static/reports/*.html
__pycache__/
```

- [ ] **Step 6: 创建 `.env` 文件，设置 DEEPSEEK_API_KEY**

从用户提供的 key 手动创建，或在 bash 里创建：

```bash
cd D:/dataproj
cp .env.example .env
# 然后在 .env 里填入真实的 DEEPSEEK_API_KEY=<你的key，勿写进任何文件>
```

**验证**：`ls webapp/*/` 显示所有 `__init__.py` 存在；`pip install -r requirements.txt` 无错。

---

## 阶段 1：基础设施（Day 2-5）

### Task 2: 实现 MCP Client

**Files:**
- Create: `webapp/mcp/client.py`
- Create: `webapp/mcp/test_client.py`

- [ ] **Step 1: 写测试 — test_run_query_basic**

```python
# webapp/mcp/test_client.py
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

import pytest
import json
from webapp.mcp.client import DWSMcpClient


@pytest.fixture
async def client():
    c = DWSMcpClient("D:/dataproj/dws_mcp_server.py")
    await c.start()
    yield c
    await c.stop()


@pytest.mark.asyncio
async def test_run_query_basic(client):
    """最简单的 SELECT 返回数据"""
    rows, status = await client.run_query("SELECT 1 AS n")
    assert len(rows) == 1
    assert rows[0]["n"] == 1
    assert "OK" in status


@pytest.mark.asyncio
async def test_run_query_auto_limit(client):
    """不带 LIMIT 自动加 200"""
    rows, _ = await client.run_query("SELECT * FROM dm.dm_fact_finance_cost_f WHERE period = '202601'")
    assert len(rows) <= 200


@pytest.mark.asyncio
async def test_describe_table(client):
    """获取表结构"""
    cols = await client.describe_table("dm.dm_fact_finance_cost_f")
    assert isinstance(cols, list)
    assert len(cols) > 5
    assert "column_name" in cols[0]


@pytest.mark.asyncio
async def test_search_tables(client):
    """搜索表"""
    tables = await client.search_tables("cost")
    assert isinstance(tables, list)
    assert len(tables) > 0


@pytest.mark.asyncio
async def test_list_tables(client):
    result = await client.list_tables()
    assert isinstance(result, list)
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd D:/dataproj && python -m pytest webapp/mcp/test_client.py -v 2>&1 | tail -5
```

期望：全部 FAIL（`DWSMcpClient` 未定义）。

- [ ] **Step 3: 实现 `DWSMcpClient`**

```python
# webapp/mcp/client.py
"""MCP stdio JSON-RPC 客户端，管理 dws_mcp_server.py 子进程。"""
from __future__ import annotations
import json
import subprocess
import asyncio
import sys
from pathlib import Path
from typing import Any


class MCPError(Exception):
    pass


class DWSMcpClient:
    """Python MCP stdio 客户端。

    启动 dws_mcp_server.py 子进程，通过 stdin/stdout JSON-RPC 通信。
    所有方法都会 raise_on_error（返回 error 则抛 MCPError）。
    """

    def __init__(self, server_path: str | Path, python: str | None = None):
        self.server_path = Path(server_path)
        self.python = python or sys.executable
        self._proc: subprocess.Popen | None = None
        self._request_id = 0

    async def start(self):
        self._proc = subprocess.Popen(
            [self.python, str(self.server_path)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        # MCP initialize handshake
        resp = await self._rpc("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "dws-webapp", "version": "0.1.0"},
        })
        if "error" in resp:
            raise MCPError(f"Initialize failed: {resp['error']}")

    async def stop(self):
        if self._proc and self._proc.poll() is None:
            self._proc.stdin.close()
            self._proc.terminate()
            self._proc.wait(timeout=5)

    async def _rpc(self, method: str, params: dict | None = None) -> dict[str, Any]:
        self._request_id += 1
        req = {
            "jsonrpc": "2.0",
            "id": self._request_id,
            "method": method,
            "params": params or {},
        }
        raw = json.dumps(req, ensure_ascii=False)
        self._proc.stdin.write(raw + "\n")
        self._proc.stdin.flush()
        line = await asyncio.get_event_loop().run_in_executor(
            None, self._proc.stdout.readline
        )
        resp = json.loads(line)
        if "error" in resp:
            raise MCPError(resp["error"].get("message", str(resp["error"])))
        return resp

    # -- 高级封装 --

    async def run_query(self, sql: str) -> tuple[list[dict], str]:
        """执行 SELECT，返回 (rows, status)。status 如 "OK (42 rows, 120ms)"。"""
        resp = await self._rpc("tools/call", {
            "name": "run_query",
            "arguments": {"sql": sql},
        })
        content = resp.get("result", {}).get("content", [])
        if content and isinstance(content[0], dict):
            text = content[0].get("text", "{}")
            import re
            # 解析 MCP 返回的 JSON
            try:
                data = json.loads(text)
            except json.JSONDecodeError:
                data = {"error": text}
            if "error" in data:
                raise MCPError(data["error"])
            return data.get("rows", []), data.get("status", "")
        return [], ""

    @staticmethod
    async def _call_tool(self, name: str, **kwargs) -> list[dict]:
        resp = await self._rpc("tools/call", {
            "name": name,
            "arguments": kwargs,
        })
        content = resp.get("result", {}).get("content", [])
        if content and isinstance(content[0], dict):
            text = content[0].get("text", "{}")
            data = json.loads(text)
            if "error" in data:
                raise MCPError(data["error"])
            if name == "run_query":
                return data.get("rows", []), data.get("status", "")
            return data
        return resp

    async def describe_table(self, table_name: str) -> list[dict]:
        data = await self._rpc("tools/call", {
            "name": "describe_table",
            "arguments": {"table_name": table_name},
        })
        return self._parse_result(data)

    async def search_tables(self, keyword: str) -> list[dict]:
        data = await self._rpc("tools/call", {
            "name": "search_tables",
            "arguments": {"keyword": keyword},
        })
        return self._parse_result(data)

    async def list_tables(self, schema_name: str | None = None) -> list[dict]:
        args = {}
        if schema_name:
            args["schema_name"] = schema_name
        data = await self._rpc("tools/call", {
            "name": "list_tables",
            "arguments": args,
        })
        return self._parse_result(data)

    def _parse_result(self, data: dict) -> Any:
        content = data.get("result", {}).get("content", [])
        if content and isinstance(content[0], dict):
            text = content[0].get("text", "{}")
            return json.loads(text)
        return data
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd D:/dataproj && python -m pytest webapp/mcp/test_client.py -v
```

期望：5 个测试 PASS（start 通过后所有 tool 方法可用）。

- [ ] **Step 5: 问题排查**

如果 MCP server 的 JSON-RPC 返回格式与预期不同，先手动测一下 MCP server 的 stdin/stdout 格式：

```python
# 临时测试脚本
import subprocess, json
p = subprocess.Popen(
    ["python", "D:/dataproj/dws_mcp_server.py"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    text=True, bufsize=1,
)
p.stdin.write(json.dumps({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}) + "\n")
p.stdin.flush()
print("line:", p.stdout.readline())
p.stdin.write(json.dumps({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"run_query","arguments":{"sql":"SELECT 1 AS n"}}}) + "\n")
p.stdin.flush()
print("line:", p.stdout.readline())
p.terminate()
```

根据实际返回格式调整 `_parse_result` 和 `run_query` 的解析逻辑。MCP server 返回格式应为：
```json
{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"[{\"rows\": [...]}]"}]}}
```

--- 这是关键任务：MCP Client 是所有后续工作的基础，必须跑通 ---

### Task 3: 实现 LLM Adapter 抽象接口 + Mock

**Files:**
- Create: `webapp/llm/base.py`
- Create: `webapp/llm/test_base.py`

- [ ] **Step 1: 写 LLMClient 抽象接口**

```python
# webapp/llm/base.py
"""LLM Adapter 抽象接口。所有模型实现继承此类。"""
from __future__ import annotations
from abc import ABC, abstractmethod
from typing import Protocol, runtime_checkable
from dataclasses import dataclass, field


@dataclass
class ToolCall:
    """LLM 返回的工具调用"""
    id: str
    name: str
    arguments: dict

    @classmethod
    def from_dict(cls, d: dict) -> "ToolCall":
        args = d.get("function", {}).get("arguments", "{}")
        if isinstance(args, str):
            import json
            args = json.loads(args)
        return cls(id=d.get("id", ""), name=d.get("function", {}).get("name", ""), arguments=args)


@dataclass
class ChatResult:
    content: str
    tool_calls: list[ToolCall] = field(default_factory=list)

    def has_tool_calls(self) -> bool:
        return len(self.tool_calls) > 0


@dataclass
class ToolDef:
    """工具定义，传递给 LLM"""
    name: str
    description: str
    parameters: dict  # JSON Schema

    def to_openai(self) -> dict:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }


class LLMClient(ABC):
    """LLM 客户端抽象基类。新模型只需实现此类。"""

    @abstractmethod
    async def chat(
        self,
        system: str,
        user: str,
        temperature: float = 0.3,
        max_tokens: int = 4096,
    ) -> str:
        """纯文本对话，返回模型回复文本。"""
        ...

    @abstractmethod
    async def chat_with_tools(
        self,
        system: str,
        user: str,
        tools: list[ToolDef],
        temperature: float = 0.3,
    ) -> ChatResult:
        """带工具调用的对话，返回文本 + tool_calls。"""
        ...
```

- [ ] **Step 2: 写 MockLLMClient 用于其他模块的单元测试**

```python
# webapp/llm/base.py（追加在文件末尾）
class MockLLMClient(LLMClient):
    """Mock 实现，用于编排层单元测试。通过注入回答列表控制行为。"""

    def __init__(self, responses: list[str | ChatResult] | None = None):
        self.responses = responses or []
        self.calls: list[dict] = []  # 记录所有调用历史
        self._idx = 0

    async def chat(self, system: str, user: str, temperature: float = 0.3, max_tokens: int = 4096) -> str:
        self.calls.append({"method": "chat", "system": system[:200], "user": user[:200]})
        if self._idx < len(self.responses):
            resp = self.responses[self._idx]
            self._idx += 1
            if isinstance(resp, ChatResult):
                return resp.content
            return resp
        return '{"domain": "sales-performance", "confidence": 0.95}'

    async def chat_with_tools(
        self, system: str, user: str, tools: list[ToolDef], temperature: float = 0.3
    ) -> ChatResult:
        self.calls.append({"method": "chat_with_tools", "system": system[:200], "user": user[:200], "tools": [t.name for t in tools]})
        if self._idx < len(self.responses):
            resp = self.responses[self._idx]
            self._idx += 1
            if isinstance(resp, ChatResult):
                return resp
            return ChatResult(content=resp, tool_calls=[])
        return ChatResult(content='{"table": "dm.dm_fact_sales_performance_f"}', tool_calls=[])
```

- [ ] **Step 3: 写单元测试**

```python
# webapp/llm/test_base.py
import pytest
import json
from webapp.llm.base import LLMClient, MockLLMClient, ChatResult, ToolCall, ToolDef


class TestMockLLMClient:
    @pytest.mark.asyncio
    async def test_chat_returns_injected_response(self):
        client = MockLLMClient(responses=['{"domain": "fin-cost"}'])
        result = await client.chat("system", "user question")
        assert result == '{"domain": "fin-cost"}'

    @pytest.mark.asyncio
    async def test_chat_with_tools_no_tool_call(self):
        client = MockLLMClient(responses=[
            ChatResult(content="I don't need tools", tool_calls=[])
        ])
        result = await client.chat_with_tools("system", "user", [])
        assert result.content == "I don't need tools"
        assert not result.has_tool_calls()

    @pytest.mark.asyncio
    async def test_chat_with_tools_has_tool_call(self):
        tool_call = ToolCall(id="1", name="run_query", arguments={"sql": "SELECT 1"})
        client = MockLLMClient(responses=[
            ChatResult(content="", tool_calls=[tool_call])
        ])
        result = await client.chat_with_tools("system", "user", [
            ToolDef(name="run_query", description="run SQL", parameters={"type": "object", "properties": {"sql": {"type": "string"}}})
        ])
        assert result.has_tool_calls()
        assert result.tool_calls[0].name == "run_query"

    @pytest.mark.asyncio
    async def test_call_history(self):
        client = MockLLMClient(responses=["resp1", "resp2"])
        await client.chat("s1", "u1")
        await client.chat("s2", "u2")
        assert len(client.calls) == 2
        assert client.calls[0]["user"] == "u1"
        assert client.calls[1]["user"] == "u2"


class TestToolDef:
    def test_to_openai(self):
        t = ToolDef(name="f1", description="d1", parameters={
            "type": "object", "properties": {"x": {"type": "string"}}
        })
        oai = t.to_openai()
        assert oai["type"] == "function"
        assert oai["function"]["name"] == "f1"


class TestChatResult:
    def test_from_dict(self):
        d = {
            "id": "call_1",
            "function": {"name": "describe_table", "arguments": '{"table_name": "foo"}'},
        }
        tc = ToolCall.from_dict(d)
        assert tc.name == "describe_table"
        assert tc.arguments == {"table_name": "foo"}
```

- [ ] **Step 4: 运行测试**

```bash
cd D:/dataproj && python -m pytest webapp/llm/test_base.py -v
```

期望：全部 PASS。

---

### Task 4: 实现 DeepSeek-V4-Pro Client

**Files:**
- Create: `webapp/llm/deepseek.py`
- Create: `webapp/llm/test_deepseek.py`

- [ ] **Step 1: 写测试 — 真实 API 调用（需要 DEEPSEEK_API_KEY）**

```python
# webapp/llm/test_deepseek.py
import os
import pytest
import json
from dotenv import load_dotenv
load_dotenv()

from webapp.llm.base import ToolDef, ChatResult
from webapp.llm.deepseek import DeepSeekV4Client


@pytest.fixture
def client():
    return DeepSeekV4Client()


@pytest.mark.asyncio
async def test_chat_basic(client):
    """最简单的文本对话"""
    resp = await client.chat(
        system="你是助手，只回答JSON。",
        user='输出 {"greeting": "hello"}，只输出JSON。',
    )
    assert "greeting" in resp or "hello" in resp.lower()


@pytest.mark.asyncio
async def test_chat_with_tools(client):
    """工具调用：让模型调一个虚拟工具"""
    resp = await client.chat_with_tools(
        system="你可以调用 get_weather 工具获取天气。",
        user="北京今天天气怎么样？",
        tools=[
            ToolDef(
                name="get_weather",
                description="获取指定城市的天气",
                parameters={
                    "type": "object",
                    "properties": {"city": {"type": "string"}},
                    "required": ["city"],
                },
            )
        ],
    )
    # DeepSeek-V4-Pro 应该尝试调工具
    assert resp.content or resp.has_tool_calls()
    if resp.has_tool_calls():
        tc = resp.tool_calls[0]
        assert tc.name == "get_weather"
        assert "city" in tc.arguments


@pytest.mark.asyncio
async def test_json_recovery(client):
    """JSON 修复：故意给错格式让 LLM 修"""
    malformed = '{"domain": "sales-performance", "confidence": 0.95'  # 缺 }
    fixed = await client._recover_json(malformed)
    parsed = json.loads(fixed)
    assert parsed["domain"] == "sales-performance"
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd D:/dataproj && python -m pytest webapp/llm/test_deepseek.py -v
```

期望：全部 FAIL（`DeepSeekV4Client` 未定义）。

- [ ] **Step 3: 实现 DeepSeek-V4-Pro Client**

```python
# webapp/llm/deepseek.py
"""DeepSeek-V4-Pro LLM 客户端。兼容 OpenAI tool use 协议。"""
from __future__ import annotations
import json
import os
import httpx
from webapp.llm.base import LLMClient, ToolDef, ToolCall, ChatResult


class DeepSeekError(Exception):
    pass


class DeepSeekV4Client(LLMClient):
    BASE_URL = "https://api.deepseek.com/v1"
    MODEL = "deepseek-chat"  # DeepSeek-V4-Pro 的实际 API model name

    def __init__(self, api_key: str | None = None, base_url: str | None = None):
        self.api_key = api_key or os.environ["DEEPSEEK_API_KEY"]
        self.base_url = base_url or self.BASE_URL
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            timeout=httpx.Timeout(120.0, connect=10.0),
        )

    async def chat(
        self, system: str, user: str, temperature: float = 0.3, max_tokens: int = 4096
    ) -> str:
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]
        result = await self._call_api(messages, temperature, max_tokens, tools=None)
        return result.content

    async def chat_with_tools(
        self, system: str, user: str, tools: list[ToolDef], temperature: float = 0.3
    ) -> ChatResult:
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]
        return await self._call_api(
            messages, temperature, max_tokens=4096,
            tools=[t.to_openai() for t in tools],
        )

    async def _call_api(
        self, messages: list[dict], temperature: float, max_tokens: int, tools: list[dict] | None
    ) -> ChatResult:
        payload = {
            "model": self.MODEL,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"

        for attempt in range(3):
            try:
                resp = await self._client.post("/chat/completions", json=payload)
                if resp.status_code == 429:
                    import asyncio
                    wait = 2 ** attempt
                    await asyncio.sleep(wait)
                    continue
                if resp.status_code >= 400:
                    raise DeepSeekError(f"API error {resp.status_code}: {resp.text[:500]}")
                data = resp.json()
                return self._parse_response(data)
            except httpx.TimeoutException:
                if attempt == 2:
                    raise
                await asyncio.sleep(2 ** attempt)
        raise DeepSeekError("Max retries exceeded")

    @staticmethod
    def _parse_response(data: dict) -> ChatResult:
        choice = data["choices"][0]
        msg = choice.get("message", {})
        content = msg.get("content") or ""
        tool_calls = []
        if msg.get("tool_calls"):
            for tc in msg["tool_calls"]:
                tool_calls.append(ToolCall.from_dict(tc))
        return ChatResult(content=content, tool_calls=tool_calls)

    async def _recover_json(self, malformed: str) -> str:
        """让 LLM 修复格式错误的 JSON。最多一次尝试。"""
        result = await self.chat(
            system="修复以下 JSON 字符串，只输出修复后的完整 JSON，不要额外文字。",
            user=malformed,
            temperature=0,
        )
        # 提取 JSON 块（可能被 ``` 包裹）
        result = result.strip()
        if result.startswith("```"):
            result = result.split("```")[1]
            if result.startswith("json"):
                result = result[4:]
        return result.strip()

    async def close(self):
        await self._client.aclose()
```

**注意**：`self.MODEL = "deepseek-chat"` — DeepSeek API 的 model 参数值。如果用户用的是 `deepseek-v4-pro` 这个名称，根据 DeepSeek API 文档确认实际 model identifier。如果返回 model 错误，改为正确的 ID。

- [ ] **Step 4: 运行测试**

```bash
cd D:/dataproj && python -m pytest webapp/llm/test_deepseek.py -v
```

期望：3 个测试 PASS。如果 `test_json_recovery` 被跳过，说明它需要先跑 `test_chat_basic`。

- [ ] **Step 5: 如果 model ID 不对 — 调试**

```bash
cd D:/dataproj && python -c "
from dotenv import load_dotenv; load_dotenv()
import httpx, os, asyncio
async def main():
    client = httpx.AsyncClient(headers={'Authorization': f'Bearer {os.environ[\"DEEPSEEK_API_KEY\"]}'}, timeout=30)
    # 先试 deepseek-chat
    for model in ['deepseek-chat', 'deepseek-v4-pro', 'deepseek-reasoner']:
        r = await client.post('https://api.deepseek.com/v1/chat/completions', json={'model':model,'messages':[{'role':'user','content':'hi'}]})
        print(f'{model}: {r.status_code} - {r.text[:100]}')
    await client.aclose()
asyncio.run(main())
"
```

根据输出来选正确的 model ID，更新 `deepseek.py` 里 `MODEL` 值。

---

## 阶段 2：Skills 编排层（Day 6-12）

### Task 5: 实现 Skills Loader

**Files:**
- Create: `webapp/orchestrator/loader.py`
- Create: `webapp/orchestrator/test_loader.py`

- [ ] **Step 1: 写测试**

```python
# webapp/orchestrator/test_loader.py
import pytest
from pathlib import Path
from webapp.orchestrator.loader import SkillsLoader, DomainSkills


SKILLS_DIR = Path("D:/dataproj/skills")


class TestSkillsLoader:
    @pytest.fixture
    def loader(self):
        return SkillsLoader(SKILLS_DIR)

    def test_loads_all_4_domains(self, loader):
        assert len(loader.skills) == 4
        assert "fin-cost" in loader.skills
        assert "inventory" in loader.skills
        assert "ar" in loader.skills
        assert "sales-performance" in loader.skills

    def test_knowledge_md_loaded(self, loader):
        for domain in loader.skills:
            assert len(loader.skills[domain].knowledge_md) > 100

    def test_analyst_md_loaded(self, loader):
        for domain in loader.skills:
            assert len(loader.skills[domain].analyst_md) > 100

    def test_references_loaded(self, loader):
        fc = loader.skills["fin-cost"]
        assert "metrics.md" in fc.knowledge_refs
        assert len(fc.knowledge_refs["metrics.md"]) > 50

    def test_unknown_domain_raises(self, loader):
        with pytest.raises(KeyError):
            _ = loader.skills["nonexistent"]

    def test_get_domain_list(self, loader):
        domains = loader.get_domain_list()
        assert "fin-cost" in domains
        assert "inventory" in domains


class TestDomainSkills:
    def test_full_context(self, loader):
        """验证 get_full_context() 返回可用的 system prompt"""
        fc = loader.skills["fin-cost"]
        ctx = fc.get_full_context()
        assert "fin-cost" in ctx.lower() or "费用" in ctx or "成本" in ctx
        assert len(ctx) > 500
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd D:/dataproj && python -m pytest webapp/orchestrator/test_loader.py -v
```

- [ ] **Step 3: 实现 Loader**

```python
# webapp/orchestrator/loader.py
"""启动时加载所有 Skills 到内存。"""
from __future__ import annotations
from pathlib import Path
from dataclasses import dataclass, field


@dataclass
class DomainSkills:
    domain: str
    knowledge_md: str        # SKILL.md  of {domain}-knowledge
    analyst_md: str           # SKILL.md  of {domain}-analyst
    knowledge_refs: dict[str, str] = field(default_factory=dict)  # filename → content

    def get_full_context(self) -> str:
        """组装该域的全部上下文（system prompt）。"""
        parts = [self.knowledge_md]
        for name, content in self.knowledge_refs.items():
            parts.append(f"\n---\n## {name}\n{content}")
        parts.append(self.analyst_md)
        return "\n\n".join(parts)

    def get_knowledge_context(self) -> str:
        """仅知识上下文（用于 Router）。"""
        return self.knowledge_md[:3000]  # 路由只需前 3000 字符，足够判断域


class SkillsLoader:
    DOMAINS = ["fin-cost", "inventory", "ar", "sales-performance"]

    def __init__(self, skills_dir: str | Path):
        self.skills_dir = Path(skills_dir)
        self.skills: dict[str, DomainSkills] = {}
        self._load_all()

    def _load_all(self):
        for domain in self.DOMAINS:
            knowledge_dir = self.skills_dir / f"{domain}-knowledge"
            analyst_dir = self.skills_dir / f"{domain}-analyst"

            knowledge_md = (knowledge_dir / "SKILL.md").read_text(encoding="utf-8")
            analyst_md = (analyst_dir / "SKILL.md").read_text(encoding="utf-8")

            # 加载 references/
            refs = {}
            refs_dir = knowledge_dir / "references"
            if refs_dir.exists():
                for f in sorted(refs_dir.glob("*.md")):
                    refs[f.name] = f.read_text(encoding="utf-8")

            self.skills[domain] = DomainSkills(
                domain=domain,
                knowledge_md=knowledge_md,
                analyst_md=analyst_md,
                knowledge_refs=refs,
            )

    def get_domain_list(self) -> list[str]:
        return list(self.skills.keys())

    def get(self, domain: str) -> DomainSkills:
        if domain not in self.skills:
            raise KeyError(f"Unknown domain: {domain}. Available: {self.get_domain_list()}")
        return self.skills[domain]
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd D:/dataproj && python -m pytest webapp/orchestrator/test_loader.py -v
```

期望：6 个测试全部 PASS。

---

### Task 6: 实现 Skills Router

**Files:**
- Create: `webapp/orchestrator/router.py`
- Create: `webapp/orchestrator/test_router.py`

- [ ] **Step 1: 写测试**

```python
# webapp/orchestrator/test_router.py
import pytest
from webapp.llm.base import MockLLMClient
from webapp.orchestrator.loader import SkillsLoader
from webapp.orchestrator.router import SkillsRouter, RouteResult


SKILLS_DIR = "D:/dataproj/skills"

VALID_JSON_SALES = '{"domain": "sales-performance", "confidence": 0.92, "reason": "users asks about sales achievement rate"}'
VALID_JSON_INVENTORY = '{"domain": "inventory", "confidence": 0.85, "reason": "user asks about stock aging"}'
UNKNOWN_JSON = '{"domain": "unknown", "confidence": 0.4, "reason": "not in any covered domain"}'
LOW_CONF_JSON = '{"domain": "fin-cost", "confidence": 0.55, "reason": "might be about cost"}'
MALFORMED_JSON = '{"domain": "fin-cost", "confidence": 0.8'  # 缺 }


@pytest.fixture
def loader():
    return SkillsLoader(SKILLS_DIR)


@pytest.fixture
def mock_llm():
    return MockLLMClient()


class TestSkillsRouter:
    @pytest.mark.asyncio
    async def test_router_high_confidence(self, loader, mock_llm):
        mock_llm.responses = [VALID_JSON_SALES]
        router = SkillsRouter(loader, mock_llm)
        result = await router.route("上月销售达成情况")
        assert result.domain == "sales-performance"
        assert result.confidence == 0.92
        assert result.needs_confirmation is False

    @pytest.mark.asyncio
    async def test_router_low_confidence_needs_confirmation(self, loader, mock_llm):
        mock_llm.responses = [LOW_CONF_JSON]
        router = SkillsRouter(loader, mock_llm)
        result = await router.route("some vague question")
        assert result.needs_confirmation is True
        assert result.candidates  # 应该有备选域

    @pytest.mark.asyncio
    async def test_router_unknown_domain(self, loader, mock_llm):
        mock_llm.responses = [UNKNOWN_JSON]
        router = SkillsRouter(loader, mock_llm)
        result = await router.route("帮我查一下HR部门的员工数量")
        assert result.domain == "unknown"
        assert result.needs_confirmation is True

    @pytest.mark.asyncio
    async def test_router_json_recovery(self, loader, mock_llm):
        """JSON 格式错误时 LLM 修复"""
        mock_llm.responses = [
            MALFORMED_JSON,  # 第一次返回错误 JSON
            '{"domain": "fin-cost", "confidence": 0.8, "reason": "corrected"}',  # 修复后
        ]
        router = SkillsRouter(loader, mock_llm)
        result = await router.route("费用分析问题")
        assert result.domain == "fin-cost"
        assert result.confidence == 0.8

    @pytest.mark.asyncio
    async def test_router_uses_knowledge_context(self, loader, mock_llm):
        mock_llm.responses = [VALID_JSON_INVENTORY]
        router = SkillsRouter(loader, mock_llm)
        await router.route("库龄分析")
        call = mock_llm.calls[0]
        # 确认 system prompt 里包含了各域的知识摘要
        assert "fin-cost" in call["system"].lower() or "费用" in call["system"]
```

- [ ] **Step 2: 实现 Router**

```python
# webapp/orchestrator/router.py
"""Skills Router：用 LLM 判断用户问题归属哪个业务域。"""
from __future__ import annotations
import json
from dataclasses import dataclass, field
from webapp.llm.base import LLMClient, MockLLMClient
from webapp.orchestrator.loader import SkillsLoader, DomainSkills


@dataclass
class RouteResult:
    domain: str
    confidence: float
    reason: str = ""
    needs_confirmation: bool = False
    candidates: list[str] = field(default_factory=list)


ROUTER_SYSTEM_PROMPT = """你是数据问数系统的路由器。判断用户问题归属哪个业务域。

可用业务域：
{domain_summaries}

输出纯JSON（不要markdown包裹）：
{{
  "domain": "fin-cost|inventory|ar|sales-performance|unknown",
  "confidence": 0.0-1.0,
  "reason": "判断依据"
}}

规则：
- 如果问题明确属于某个域，confidence >= 0.7
- 如果模糊但最可能属于某域，0.5 <= confidence < 0.7
- 如果完全不属于以上4个域，输出 "unknown"，confidence < 0.5
- reason 用中文简述"""

CONFIDENCE_THRESHOLD = 0.7


class SkillsRouter:
    def __init__(self, loader: SkillsLoader, llm: LLMClient):
        self.loader = loader
        self.llm = llm
        self._domain_summaries = self._build_domain_summaries()

    def _build_domain_summaries(self) -> str:
        lines = []
        for domain in self.loader.DOMAINS:
            ds = self.loader.skills[domain]
            # 取 knowledge_md 前 500 字符作为域摘要
            summary = ds.knowledge_md[:500]
            lines.append(f"- {domain}: {summary}")
        return "\n".join(lines)

    async def route(self, question: str) -> RouteResult:
        system = ROUTER_SYSTEM_PROMPT.format(domain_summaries=self._domain_summaries)
        raw = await self.llm.chat(system=system, user=question, temperature=0.1)

        parsed = self._safe_parse(raw)
        if parsed is None:
            # JSON 解析失败，让 LLM 修一次
            if hasattr(self.llm, '_recover_json'):
                fixed = await self.llm._recover_json(raw)
                parsed = self._safe_parse(fixed)

        if parsed is None:
            return RouteResult(domain="unknown", confidence=0, reason="JSON parse failed", needs_confirmation=True)

        domain = parsed.get("domain", "unknown")
        confidence = float(parsed.get("confidence", 0))
        reason = parsed.get("reason", "")

        if domain not in self.loader.DOMAINS and domain != "unknown":
            domain = "unknown"

        needs_conf = confidence < CONFIDENCE_THRESHOLD or domain == "unknown"

        return RouteResult(
            domain=domain,
            confidence=confidence,
            reason=reason,
            needs_confirmation=needs_conf,
            candidates=self._get_candidates(domain) if needs_conf else [],
        )

    def _get_candidates(self, best: str) -> list[str]:
        """返回备选域列表（除 best 外的前 2 个）"""
        return [d for d in self.loader.DOMAINS if d != best][:2]

    @staticmethod
    def _safe_parse(raw: str) -> dict | None:
        raw = raw.strip()
        # 去 markdown 包裹
        if raw.startswith("```"):
            parts = raw.split("```")
            raw = parts[1] if len(parts) > 1 else parts[0]
            if raw.startswith("json"):
                raw = raw[4:]
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return None
```

- [ ] **Step 3: 运行测试**

```bash
cd D:/dataproj && python -m pytest webapp/orchestrator/test_router.py -v
```

期望：5 个测试全部 PASS。

---

### Task 7: 实现 Workflow — Step 1（问题理解）

**Files:**
- Create: `webapp/orchestrator/workflow.py` (部分)
- Create: `webapp/orchestrator/test_workflow.py` (部分)

- [ ] **Step 1: 写 Workflow 框架 + Step 1 测试**

```python
# webapp/orchestrator/test_workflow.py（本 task 用部分）
import pytest
import json
from webapp.llm.base import MockLLMClient, ChatResult, ToolCall
from webapp.orchestrator.loader import SkillsLoader
from webapp.orchestrator.workflow import AnalystWorkflow


SKILLS_DIR = "D:/dataproj/skills"

UNDERSTAND_RESULT = """{
  "metric": "销售达成率",
  "dimensions": ["事业部"],
  "time_range": "2026-Q1",
  "scope": "东西事业部",
  "key_entities": ["销售达成率", "预算目标", "实际业绩"],
  "ambiguities": ["'东西事业部'需要映射到node_desc"]
}"""

TABLE_SELECT_RESULT = """{"table": "dm.dm_fact_sales_performance_f", "reason": "销售业绩主事实表，含达成率、预算、实际字段"}"""


@pytest.fixture
def loader():
    return SkillsLoader(SKILLS_DIR)


@pytest.fixture
def mock_llm():
    return MockLLMClient()


@pytest.fixture
def mock_mcp():
    class MockMCP:
        async def run_query(self, sql):
            return [
                {"node_desc2": "东西事业部", "period": "202601", "actual": 5000000, "budget": 6000000},
            ], "OK (1 rows)"

        async def describe_table(self, name):
            return [
                {"column_name": "period", "data_type": "character varying"},
                {"column_name": "actual_amount", "data_type": "numeric"},
                {"column_name": "budget_amount", "data_type": "numeric"},
            ]
    return MockMCP()


class TestWorkflowStep1:
    @pytest.mark.asyncio
    async def test_step1_understand(self, loader, mock_llm, mock_mcp):
        mock_llm.responses = [UNDERSTAND_RESULT, TABLE_SELECT_RESULT]
        wf = AnalystWorkflow(loader, mock_llm, mock_mcp)
        parse = await wf.step1_understand("东西事业部Q1销售达成", "sales-performance")
        assert parse["metric"] == "销售达成率"
        assert "事业部" in parse["dimensions"]
        assert "2026-Q1" in parse["time_range"]
```

- [ ] **Step 2: 实现 Workflow 框架 + Step 1**

```python
# webapp/orchestrator/workflow.py
"""Analyst 6 步工作流编排。"""
from __future__ import annotations
import json
import re
from dataclasses import dataclass, field
from webapp.llm.base import LLMClient
from webapp.orchestrator.loader import SkillsLoader, DomainSkills


UNDERSTAND_PROMPT = """分析用户的自然语言问题，提取结构化信息。

输出纯JSON：
{
  "metric": "用户关心的指标（中文名）",
  "dimensions": ["维度1", "维度2"],
  "time_range": "时间范围（如 2026-Q1, 2026-01~2026-05）",
  "scope": "分析范围（事业部/公司/全集团等）",
  "key_entities": ["关键业务实体"],
  "ambiguities": ["可能的歧义"]
}
"""


class AnalystWorkflow:
    def __init__(self, loader: SkillsLoader, llm: LLMClient, mcp):
        self.loader = loader
        self.llm = llm
        self.mcp = mcp

    async def run(self, question: str, domain: str) -> dict:
        """完整 6 步工作流，返回结果 dict。"""
        skills = self.loader.get(domain)
        trace = []

        # Step 1: 问题理解
        parse = await self.step1_understand(question, domain)
        trace.append({"step": "understand", "result": parse})

        # Step 2-6 在后续 task 中实现
        # ...

        return {"parse": parse, "trace": trace}

    async def step1_understand(self, question: str, domain: str) -> dict:
        system = self.loader.get(domain).knowledge_md[:2000] + "\n\n" + UNDERSTAND_PROMPT
        raw = await self.llm.chat(system=system, user=question, temperature=0.1)
        return self._parse_json(raw, default={"metric": question, "dimensions": [], "time_range": "", "scope": ""})

    @staticmethod
    def _parse_json(raw: str, default: dict | None = None) -> dict:
        raw = raw.strip()
        if raw.startswith("```"):
            parts = raw.split("```")
            raw = parts[1] if len(parts) > 1 else parts[0]
            if raw.startswith("json"):
                raw = raw[4:]
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return default or {}

    @staticmethod
    def _extract_sql(text: str) -> str:
        """从 LLM 输出中提取 SQL。"""
        # 优先 ```sql ... ``` 包裹
        m = re.search(r'```sql\s*(.*?)```', text, re.DOTALL | re.IGNORECASE)
        if m:
            return m.group(1).strip()
        # 其次 SELECT 开头的连续行
        lines = text.split("\n")
        sql_lines = []
        for line in lines:
            if sql_lines or line.strip().upper().startswith("SELECT"):
                sql_lines.append(line)
            elif sql_lines and not line.strip():
                break
        if sql_lines:
            return "\n".join(sql_lines).strip()
        return text.strip()
```

- [ ] **Step 3: 运行 Step 1 测试**

```bash
cd D:/dataproj && python -m pytest webapp/orchestrator/test_workflow.py::TestWorkflowStep1 -v
```

期望：PASS。

---

### Task 8: 实现 Workflow — Step 2-3（表选择 + SQL 生成）

- [ ] **Step 1: 补充测试 — Step 2 + 3**

```python
# webapp/orchestrator/test_workflow.py（追加）
class TestWorkflowStep2_3:
    @pytest.mark.asyncio
    async def test_step2_table_select(self, loader, mock_llm, mock_mcp):
        mock_llm.responses = [TABLE_SELECT_RESULT]
        wf = AnalystWorkflow(loader, mock_llm, mock_mcp)
        tbl = await wf.step2_select_table(
            parse={"metric": "销售达成率", "dimensions": ["事业部"]},
            domain="sales-performance",
        )
        assert "dm_fact_sales_performance_f" in tbl["table"]

    @pytest.mark.asyncio
    async def test_step3_sql_generation(self, loader, mock_llm, mock_mcp):
        sql_response = ChatResult(
            content="",
            tool_calls=[
                ToolCall(id="1", name="describe_table", arguments={"table_name": "dm.dm_fact_sales_performance_f"})
            ],
        )
        sql_response2 = ChatResult(
            content='```sql\nSELECT node_desc2, SUM(actual_amount) AS actual FROM dm.dm_fact_sales_performance_f WHERE period BETWEEN 202601 AND 202603 GROUP BY node_desc2\n```',
            tool_calls=[],
        )
        mock_llm.responses = [sql_response, sql_response2]
        wf = AnalystWorkflow(loader, mock_llm, mock_mcp)

        tbl = {"table": "dm.dm_fact_sales_performance_f"}
        sql = await wf.step3_generate_sql(
            question="东西事业部Q1销售达成",
            parse={"metric": "销售达成率", "dimensions": ["事业部"], "time_range": "2026-Q1"},
            table_choice=tbl,
            domain="sales-performance",
        )
        assert "dm_fact_sales_performance_f" in sql
        assert "SELECT" in sql.upper()
```

- [ ] **Step 2: 实现 Step 2 + 3**

```python
# webapp/orchestrator/workflow.py（追加到 AnalystWorkflow 类中）

TABLE_SELECT_PROMPT = """根据问题选择正确的数据表。

可用表（来自 {domain} 域的 metrics.md）：
{metrics_summary}

输出纯JSON：
{{"table": "schema.table_name", "reason": "选表理由"}}
"""

SQL_GEN_PROMPT = """你是 SQL 专家。为以下分析生成 SQL。

{domain_knowledge}

表结构由 describe_table 工具提供。

关键规则：
1. 只用 SELECT，禁止 INSERT/UPDATE/DELETE
2. 大表（>10M行）必须加时间过滤
3. 注意日期格式：{date_formats}
4. 避免 _wjh_, _bak, _tmp 后缀表
5. node_desc 字段用于组织过滤
6. LIMIT 放在最后
"""


async def step2_select_table(self, parse: dict, domain: str) -> dict:
    skills = self.loader.get(domain)
    metrics = skills.knowledge_refs.get("metrics.md", skills.knowledge_md[:3000])
    system = TABLE_SELECT_PROMPT.format(domain=domain, metrics_summary=metrics[:3000])
    raw = await self.llm.chat(system=system, user=str(parse), temperature=0.1)
    return self._parse_json(raw, default={"table": "", "reason": ""})


async def step3_generate_sql(self, question: str, parse: dict, table_choice: dict, domain: str) -> str:
    skills = self.loader.get(domain)
    system = SQL_GEN_PROMPT.format(
        domain_knowledge=skills.get_full_context()[:8000],
        date_formats="YYYYMM (如 202601), YYYYMMDD (如 20260101), 参见 metrics.md",
    )
    # 第一轮：可能调 describe_table
    result = await self.llm.chat_with_tools(
        system=system,
        user=f"问题：{question}\n分析拆解：{parse}\n选择表：{table_choice}\n请生成SQL。",
        tools=[self._describe_table_tool_def()],
        temperature=0.1,
    )
    if result.has_tool_calls():
        # 执行工具调用
        tool_results = []
        for tc in result.tool_calls:
            if tc.name == "describe_table":
                cols = await self.mcp.describe_table(tc.arguments["table_name"])
                tool_results.append(f"describe_table({tc.arguments['table_name']}): {json.dumps(cols, ensure_ascii=False)}")
        # 第二轮：带表结构信息生成 SQL
        result = await self.llm.chat_with_tools(
            system=system + "\n\n表结构信息：\n" + "\n".join(tool_results),
            user=f"问题：{question}\n现在请生成SQL。",
            tools=[],
            temperature=0.1,
        )
    sql = self._extract_sql(result.content)
    return sql


def _describe_table_tool_def(self):
    from webapp.llm.base import ToolDef
    return ToolDef(
        name="describe_table",
        description="获取表的列定义",
        parameters={
            "type": "object",
            "properties": {
                "table_name": {"type": "string", "description": "schema.table_name 格式"}
            },
            "required": ["table_name"],
        },
    )
```

- [ ] **Step 3: 运行测试**

```bash
cd D:/dataproj && python -m pytest webapp/orchestrator/test_workflow.py::TestWorkflowStep2_3 -v
```

期望：2 个测试 PASS。

---

### Task 9: 实现 Workflow — Step 4-5（MCP 执行 + 解读）

- [ ] **Step 1: 补充测试 — Step 4 + 5**

```python
# webapp/orchestrator/test_workflow.py（追加）
INTERPRET_RESULT = """## 东西事业部 2026 Q1 销售达成分析

**结论**：达成率 83.3%，未达标。预算600万，实际500万，缺口100万。

**原因分析**：
- 2月实际仅150万（预算200万），主要受春节影响
- 3月有所回升但未弥补缺口
"""


class TestWorkflowStep4_5:
    @pytest.mark.asyncio
    async def test_step4_execute(self, loader, mock_llm, mock_mcp):
        wf = AnalystWorkflow(loader, mock_llm, mock_mcp)
        data, status = await wf.step4_execute("SELECT node_desc2, SUM(actual_amount) FROM dm.dm_fact_sales_performance_f WHERE period BETWEEN 202601 AND 202603 GROUP BY node_desc2")
        assert len(data) > 0
        assert "OK" in status

    @pytest.mark.asyncio
    async def test_step4_execute_sql_error_retry(self, loader, mock_llm, mock_mcp):
        """SQL 报错时让 LLM 修一次"""
        mock_llm.responses = ["SELECT node_desc2, SUM(actual_amount) FROM dm.dm_fact_sales_performance_f WHERE period BETWEEN 202601 AND 202603 GROUP BY node_desc2"]

        class ErrorMCP:
            call_count = 0
            async def run_query(self, sql):
                self.call_count += 1
                if self.call_count == 1:
                    return [], "ERROR: column 'actual_amount' does not exist"
                return [{"a": 1}], "OK (1 rows)"

        wf = AnalystWorkflow(loader, mock_llm, ErrorMCP())
        data, status = await wf.step4_execute("SELECT bad_column FROM t")
        assert ErrorMCP().call_count == 2  # 重试了一次
        assert "OK" in status

    @pytest.mark.asyncio
    async def test_step5_interpret(self, loader, mock_llm, mock_mcp):
        mock_llm.responses = [INTERPRET_RESULT]
        wf = AnalystWorkflow(loader, mock_llm, mock_mcp)
        analysis = await wf.step5_interpret(
            question="东西事业部Q1销售达成",
            domain="sales-performance",
            sql="SELECT ...",
            data=[{"node_desc2": "东西事业部", "actual": 5000000, "budget": 6000000}],
            parse={"metric": "销售达成率"},
        )
        assert "达成" in analysis
        assert "83.3%" in analysis or "缺口" in analysis
```

- [ ] **Step 2: 实现 Step 4 + 5**

```python
# webapp/orchestrator/workflow.py（追加到 AnalystWorkflow 类中）

INTERPRET_PROMPT = """你是数据分析师。根据数据查询结果，撰写分析报告。

报告要求：
1. 先给结论（一句话）
2. 关键数字用表格或列表展示
3. 分析原因和趋势
4. 指出风险或机会
5. 用中文，专业但易懂（目标读者是C-level）

问题：{question}
SQL：{sql}
数据（前20行）：
{data}

请直接输出Markdown格式的分析报告。"""


async def step4_execute(self, sql: str) -> tuple[list[dict], str]:
    """执行 SQL，失败时让 LLM 修一次。"""
    try:
        rows, status = await self.mcp.run_query(sql)
        if "ERROR" in status.upper():
            # 让 LLM 修复 SQL
            fixed = await self.llm.chat(
                system="修复以下SQL错误。只输出修复后的SQL，不要额外文字。",
                user=f"SQL：{sql}\n错误：{status}",
                temperature=0,
            )
            fixed_sql = self._extract_sql(fixed)
            return await self.mcp.run_query(fixed_sql)
        return rows, status
    except Exception as e:
        # 最后一次尝试修复
        fixed = await self.llm.chat(
            system="修复以下SQL错误。只输出修复后的SQL。",
            user=f"SQL：{sql}\n错误：{str(e)}",
            temperature=0,
        )
        fixed_sql = self._extract_sql(fixed)
        return await self.mcp.run_query(fixed_sql)


async def step5_interpret(self, question: str, domain: str, sql: str, data: list[dict], parse: dict) -> str:
    skills = self.loader.get(domain)
    # 只取前 20 行数据
    sample = data[:20]
    data_str = json.dumps(sample, ensure_ascii=False, indent=2)
    system = skills.analyst_md[:2000] + "\n\n" + INTERPRET_PROMPT
    return await self.llm.chat(
        system=system,
        user=f"问题：{question}\nSQL：{sql}\n数据：\n{data_str}",
        temperature=0.3,
        max_tokens=4096,
    )
```

- [ ] **Step 3: 运行测试**

```bash
cd D:/dataproj && python -m pytest webapp/orchestrator/test_workflow.py::TestWorkflowStep4_5 -v
```

期望：3 个测试 PASS。

---

### Task 10: 实现 Reviewer（Step 6 对抗审查）

**Files:**
- Create: `webapp/orchestrator/reviewer.py`
- Create: `webapp/orchestrator/test_reviewer.py`

- [ ] **Step 1: 写测试**

```python
# webapp/orchestrator/test_reviewer.py
import pytest
import json
from webapp.llm.base import MockLLMClient
from webapp.orchestrator.reviewer import Reviewer, ReviewResult


PASS_REVIEW = """{"passed": true, "issues": [], "suggestion": ""}"""
FAIL_REVIEW = """{"passed": false, "issues": ["日期格式错误：使用了 YYYY-MM 但该表使用 YYYYMM"], "suggestion": "将 period 条件改为 period BETWEEN 202601 AND 202603"}"""


class TestReviewer:
    @pytest.fixture
    def reviewer(self):
        return Reviewer(MockLLMClient())

    @pytest.mark.asyncio
    async def test_review_passes(self, reviewer):
        reviewer.llm.responses = [PASS_REVIEW]
        result = await reviewer.review(
            question="东西事业部Q1销售达成",
            sql="SELECT ... FROM dm.dm_fact_sales_performance_f WHERE period BETWEEN 202601 AND 202603",
            data=[{"actual": 5000000}],
            analysis="达成率83.3%，未达标。",
        )
        assert result.passed is True
        assert len(result.issues) == 0

    @pytest.mark.asyncio
    async def test_review_fails(self, reviewer):
        reviewer.llm.responses = [FAIL_REVIEW]
        result = await reviewer.review(
            question="东西事业部Q1销售达成",
            sql="SELECT ... WHERE period BETWEEN '2026-01' AND '2026-03'",
            data=[{"actual": 5000000}],
            analysis="达成率83.3%。",
        )
        assert result.passed is False
        assert len(result.issues) > 0
        assert "日期" in result.issues[0]
```

- [ ] **Step 2: 实现 Reviewer**

```python
# webapp/orchestrator/reviewer.py
"""第 6 步：对抗审查。+6% 准确率的关键。"""
from __future__ import annotations
import json
from dataclasses import dataclass, field
from webapp.llm.base import LLMClient


@dataclass
class ReviewResult:
    passed: bool
    issues: list[str] = field(default_factory=list)
    suggestion: str = ""


REVIEW_PROMPT = """你是对抗审查员。严格审查以下分析是否有问题。

审查清单：
1. **日期格式**：SQL 中的日期格式是否匹配表定义？（YYYYMM vs YYYY-MM-DD vs YYYY-MM）
2. **字段名称**：是否误用了别名？cust_code vs debitor, material vs material_num, plant vs factory_werks_code
3. **备份表陷阱**：是否用了 _wjh_, _bak, _tmp, _01, _close, _2024 后缀表？MUST NOT USE
4. **大表时间过滤**：>10M 行的表是否漏了时间 WHERE？
5. **org 过滤**：跨域查询是否漏了 node_desc 过滤？
6. **数字合理性**：达成率 0-200%？账龄非负？增长率不荒谬？
7. **口径一致性**：累计值 vs 当月值？含税 vs 不含税？

审查对象：
- 问题：{question}
- SQL：{sql}
- 数据（前 5 行）：{data_preview}
- 分析结论：{analysis}

输出纯JSON：
{{
  "passed": true|false,
  "issues": ["问题描述1", "问题描述2"],
  "suggestion": "修复建议（如有）"
}}

如果 passed=false，suggestion 必须给出可操作的修复建议。"""


class Reviewer:
    def __init__(self, llm: LLMClient):
        self.llm = llm

    async def review(
        self, question: str, sql: str, data: list[dict], analysis: str
    ) -> ReviewResult:
        data_preview = json.dumps(data[:5], ensure_ascii=False, indent=2)
        system = REVIEW_PROMPT.format(
            question=question,
            sql=sql,
            data_preview=data_preview,
            analysis=analysis[:3000],
        )
        raw = await self.llm.chat(system=system, user="请审查。", temperature=0.1)

        parsed = self._parse_json(raw)
        if parsed is None:
            return ReviewResult(passed=True, issues=["审查器JSON解析失败，跳过审查"], suggestion="")

        return ReviewResult(
            passed=parsed.get("passed", True),
            issues=parsed.get("issues", []),
            suggestion=parsed.get("suggestion", ""),
        )

    @staticmethod
    def _parse_json(raw: str) -> dict | None:
        raw = raw.strip()
        if raw.startswith("```"):
            parts = raw.split("```")
            raw = parts[1] if len(parts) > 1 else parts[0]
            if raw.startswith("json"):
                raw = raw[4:]
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return None
```

- [ ] **Step 3: 运行测试**

```bash
cd D:/dataproj && python -m pytest webapp/orchestrator/test_reviewer.py -v
```

期望：2 个测试 PASS。

---

### Task 11: 连通完整 Workflow（`run()` 方法）

- [ ] **Step 1: 补充端到端测试**

```python
# webapp/orchestrator/test_workflow.py（追加）
class TestFullWorkflow:
    @pytest.mark.asyncio
    async def test_full_workflow_mock(self, loader, mock_llm, mock_mcp):
        """完整 6 步流程端到端（全 Mock）"""
        mock_llm.responses = [
            UNDERSTAND_RESULT,           # Step 1
            TABLE_SELECT_RESULT,          # Step 2
            ChatResult(content="", tool_calls=[
                ToolCall(id="1", name="describe_table", arguments={"table_name": "dm.dm_fact_sales_performance_f"})
            ]),                           # Step 3 - tool call
            ChatResult(content='```sql\nSELECT node_desc2, SUM(actual_amount) FROM dm.dm_fact_sales_performance_f WHERE period BETWEEN 202601 AND 202603 GROUP BY node_desc2\n```', tool_calls=[]),  # Step 3 - SQL
            INTERPRET_RESULT,             # Step 5
            PASS_REVIEW,                  # Step 6
        ]
        wf = AnalystWorkflow(loader, mock_llm, mock_mcp)
        reviewer = __import__("webapp.orchestrator.reviewer", fromlist=["Reviewer"]).Reviewer(mock_llm)
        mock_llm._idx = 0  # reset
        mock_llm.responses = mock_llm.responses  # 保持原列表

        result = await wf.run_full(
            question="东西事业部Q1销售达成",
            domain="sales-performance",
            reviewer=reviewer,
        )
        assert "analysis" in result
        assert "review" in result
        assert "sql" in result
        assert len(result["trace"]) >= 5
```

- [ ] **Step 2: 实现 `run_full()`**

```python
# webapp/orchestrator/workflow.py（追加到 AnalystWorkflow 类中）
@dataclass
class WorkflowResult:
    analysis: str
    sql: str
    data: list[dict]
    review: "ReviewResult"
    report_data: dict
    trace: list[dict]


async def run_full(self, question: str, domain: str, reviewer) -> WorkflowResult:
    trace = []

    # Step 1
    parse = await self.step1_understand(question, domain)
    trace.append({"step": 1, "name": "understand", "result": parse})

    # Step 2
    table_choice = await self.step2_select_table(parse, domain)
    trace.append({"step": 2, "name": "select_table", "result": table_choice})

    # Step 3
    sql = await self.step3_generate_sql(question, parse, table_choice, domain)
    trace.append({"step": 3, "name": "generate_sql", "result": sql})

    # Step 4
    data, status = await self.step4_execute(sql)
    trace.append({"step": 4, "name": "execute", "status": status, "rows": len(data)})

    # Step 5
    analysis = await self.step5_interpret(question, domain, sql, data, parse)
    trace.append({"step": 5, "name": "interpret"})

    # Step 6
    review = await reviewer.review(question, sql, data, analysis)
    trace.append({"step": 6, "name": "review", "passed": review.passed, "issues": review.issues})

    # 如果审查未通过且 issues 少，尝试修一次
    if not review.passed and len(review.issues) <= 2:
        fixed = await self.llm.chat(
            system=f"根据审查意见修复分析。审查问题：{review.issues}\n修复建议：{review.suggestion}\n\n请输出修复后的Markdown分析报告。",
            user=f"原始分析：\n{analysis}",
            temperature=0.1,
        )
        analysis = fixed
        # 再审一次
        review = await reviewer.review(question, sql, data, analysis)
        trace.append({"step": 6.1, "name": "review_retry", "passed": review.passed})

    report_data = {
        "question": question,
        "domain": domain,
        "parse": parse,
        "table": table_choice,
        "analysis": analysis,
        "sql": sql,
        "data": data,
        "review": {"passed": review.passed, "issues": review.issues},
    }

    return WorkflowResult(
        analysis=analysis,
        sql=sql,
        data=data,
        review=review,
        report_data=report_data,
        trace=trace,
    )
```

- [ ] **Step 3: 运行测试**

```bash
cd D:/dataproj && python -m pytest webapp/orchestrator/test_workflow.py::TestFullWorkflow -v
```

期望：PASS。

---

## 阶段 3：FastAPI + 前端（Day 13-17）

### Task 12: 实现 FastAPI 后端 + Session Manager

**Files:**
- Create: `webapp/session.py`
- Create: `webapp/routes/ask.py`
- Modify: `webapp/main.py`

- [ ] **Step 1: 实现 Session Manager**

```python
# webapp/session.py
"""内存会话管理。v0.1 用 dict，v0.2 换 Redis。"""
from __future__ import annotations
import time
import uuid
from dataclasses import dataclass, field
from collections import OrderedDict


@dataclass
class Message:
    role: str  # "user" | "assistant"
    content: str
    timestamp: float = field(default_factory=time.time)


@dataclass
class Session:
    session_id: str
    created_at: float = field(default_factory=time.time)
    messages: list[Message] = field(default_factory=list)
    last_active: float = field(default_factory=time.time)

    def add_message(self, role: str, content: str):
        self.messages.append(Message(role=role, content=content))
        self.last_active = time.time()
        # 只保留最近 20 条
        if len(self.messages) > 20:
            self.messages = self.messages[-20:]

    def get_history(self, n: int = 10) -> list[dict]:
        return [{"role": m.role, "content": m.content} for m in self.messages[-n:]]


class SessionManager:
    def __init__(self, ttl_seconds: int = 7200):
        self._sessions: OrderedDict[str, Session] = OrderedDict()
        self.ttl = ttl_seconds

    def create(self) -> Session:
        sid = uuid.uuid4().hex[:12]
        s = Session(session_id=sid)
        self._sessions[sid] = s
        self._evict_expired()
        return s

    def get(self, session_id: str) -> Session | None:
        self._evict_expired()
        s = self._sessions.get(session_id)
        if s:
            s.last_active = time.time()
        return s

    def get_or_create(self, session_id: str | None) -> Session:
        if session_id:
            s = self.get(session_id)
            if s:
                return s
        return self.create()

    def _evict_expired(self):
        now = time.time()
        expired = [k for k, v in self._sessions.items() if now - v.last_active > self.ttl]
        for k in expired:
            del self._sessions[k]
```

- [ ] **Step 2: 实现 POST /ask 路由**

```python
# webapp/routes/ask.py
"""POST /ask 路由：核心问答接口。"""
from __future__ import annotations
from fastapi import APIRouter, Request, HTTPException
from pydantic import BaseModel
from webapp.session import SessionManager
from webapp.orchestrator.loader import SkillsLoader
from webapp.orchestrator.router import SkillsRouter
from webapp.orchestrator.workflow import AnalystWorkflow, WorkflowResult
from webapp.orchestrator.reviewer import Reviewer

router = APIRouter()


class AskRequest(BaseModel):
    session_id: str | None = None
    question: str


class AskResponse(BaseModel):
    session_id: str
    domain: str
    confidence: float
    markdown: str
    sql: str
    review_passed: bool
    report_url: str | None = None
    trace: list[dict] = []
    needs_confirmation: bool = False
    message: str = ""


def create_ask_router(
    session_mgr: SessionManager,
    loader: SkillsLoader,
    llm,  # LLMClient
    mcp,  # DWSMcpClient
    router: SkillsRouter,
    render_report,  # function
) -> APIRouter:

    @router.post("/ask", response_model=AskResponse)
    async def ask(req: AskRequest):
        session = session_mgr.get_or_create(req.session_id)

        # 路由
        route = await router.route(req.question)
        if route.domain == "unknown":
            return AskResponse(
                session_id=session.session_id,
                domain="unknown",
                confidence=route.confidence,
                markdown="",
                sql="",
                review_passed=True,
                needs_confirmation=True,
                message=f"该问题不在已覆盖的业务域内。当前支持：{', '.join(loader.get_domain_list())}。如需扩展，请联系数据团队建设相应领域 Skill。",
                trace=[{"step": "router", "result": {"domain": "unknown"}}],
            )

        if route.needs_confirmation:
            return AskResponse(
                session_id=session.session_id,
                domain=route.domain,
                confidence=route.confidence,
                markdown="",
                sql="",
                review_passed=True,
                needs_confirmation=True,
                message=f"您的问题可能属于 **{route.domain}** 域（置信度 {route.confidence:.0%}）。备选：{', '.join(route.candidates)}。如果不对，请重新描述。",
                trace=[{"step": "router", "result": {"domain": route.domain, "confidence": route.confidence}}],
            )

        # 工作流
        wf = AnalystWorkflow(loader, llm, mcp)
        reviewer = Reviewer(llm)

        try:
            result = await wf.run_full(req.question, route.domain, reviewer)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"分析失败：{str(e)}")

        # 报告
        report_url = None
        try:
            report_url = await render_report(result)
        except Exception:
            pass  # 报告渲染失败不阻断分析结果返回

        # 会话记录
        session.add_message("user", req.question)
        session.add_message("assistant", result.analysis)

        return AskResponse(
            session_id=session.session_id,
            domain=route.domain,
            confidence=route.confidence,
            markdown=result.analysis,
            sql=result.sql,
            review_passed=result.review.passed,
            report_url=report_url,
            trace=[t for t in result.trace],
        )

    return router
```

- [ ] **Step 3: 实现 `webapp/main.py`**

```python
# webapp/main.py
"""问数 Web 服务 MVP — FastAPI 入口。"""
from __future__ import annotations
import os
from contextlib import asynccontextmanager
from pathlib import Path
from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

from webapp.session import SessionManager
from webapp.orchestrator.loader import SkillsLoader
from webapp.orchestrator.router import SkillsRouter
from webapp.orchestrator.workflow import AnalystWorkflow
from webapp.orchestrator.reviewer import Reviewer
from webapp.llm.deepseek import DeepSeekV4Client
from webapp.mcp.client import DWSMcpClient
from webapp.render import make_report_renderer

# 全局单例
session_mgr = SessionManager()
loader: SkillsLoader | None = None
llm: DeepSeekV4Client | None = None
mcp: DWSMcpClient | None = None
router: SkillsRouter | None = None
render_report = None

SKILLS_DIR = Path("D:/dataproj/skills")
MCP_SERVER = Path("D:/dataproj/dws_mcp_server.py")
STATIC_DIR = Path("D:/dataproj/webapp/static")


@asynccontextmanager
async def lifespan(app: FastAPI):
    global loader, llm, mcp, router, render_report
    print("[startup] Loading skills...")
    loader = SkillsLoader(SKILLS_DIR)
    print(f"[startup] Loaded {len(loader.skills)} domains: {loader.get_domain_list()}")

    print("[startup] Starting MCP client...")
    mcp = DWSMcpClient(MCP_SERVER)
    await mcp.start()
    print("[startup] MCP client ready")

    print("[startup] Creating LLM client...")
    llm = DeepSeekV4Client()
    print("[startup] LLM client ready")

    router = SkillsRouter(loader, llm)
    render_report = make_report_renderer(STATIC_DIR / "reports", Path("D:/dataproj"), loader)
    print("[startup] Server ready at http://0.0.0.0:8000")
    yield
    print("[shutdown] Stopping...")
    await llm.close()
    await mcp.stop()


app = FastAPI(title="智能问数", version="0.1.0", lifespan=lifespan)

app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

from webapp.routes.ask import create_ask_router
ask_router = create_ask_router(session_mgr, loader, llm, mcp, router, render_report)
# 注意：loader 等启动后才初始化，但 FastAPI 路由在启动前就注册了。
# 解决：把依赖注入放到 request 级别，或在 lifespan 后通过 app.state 访问。
# 见 Task 13 的依赖注入修复。

app.include_router(ask_router)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
```

**注意**：上面的路由注册有依赖注入时序问题。`loader`/`llm`/`mcp` 在 lifespan 启动后才赋值，但路由函数在模块加载时就创建了闭包引用。修复方案见 Task 14。

- [ ] **Step 4: 修复依赖注入**

把 `main.py` 改为：

```python
# webapp/main.py（关键修改）
# 把闭包引用改为通过 app.state 访问

from webapp.routes.ask import router as ask_router_module

app.include_router(ask_router_module)

@app.post("/ask")
async def ask_endpoint(req: AskRequest):
    return await _handle_ask(app, req)
```

暂不实现完整的 `/ask` —— 在 Task 13 里一起修复。

- [ ] **Step 5: 启动确认**

```bash
cd D:/dataproj && python -m uvicorn webapp.main:app --host 0.0.0.0 --port 8000
```

期望：启动日志显示 "Loaded 4 domains" "MCP client ready" "Server ready"，无报错退出。

访问 `http://localhost:8000/docs` 确认 FastAPI 自动生成的 API 文档可见。

---

### Task 13: Report Renderer + /ask 接口连通

**Files:**
- Create: `webapp/render.py`
- Modify: `build_report.py`（抽取 `assemble_report()` 函数）
- Modify: `webapp/main.py`（修复依赖注入）

- [ ] **Step 1: 重构 `build_report.py` — 抽取 `assemble_report()` 函数**

在 `build_report.py` 末尾追加一个可复用函数：

```python
# build_report.py（文件末尾追加）
def assemble_report(report_data: dict, output_path: str, base_dir: str | None = None) -> str:
    """可复用接口：组装 report_data 为 HTML 报告，保存到 output_path。
    
    返回 output_path。
    
    report_data 格式（遵循 SKILL.md 规范）：
    {
        "title": "报告标题",
        "subtitle": "副标题",
        "kpis": [{"label": "KPI名", "value": "值", "change": "变化", "direction": "up|down|neutral"}],
        "insight": "洞察文本",
        "sections": [
            {
                "id": "tab_id", "tab": "标签名",
                "type": "chart-with-analysis|analysis-only|data-table",
                "chart": {"id": "chart-id", "title": "图表标题", "option": {...}},
                "analysis": "分析文本",
                "table": {"columns": [...], "rows": [...]}
            }
        ],
        "provenance": {"domain": "域", "sql": "SQL", "review": "审查结果"}
    }
    """
    _base = base_dir or os.path.dirname(os.path.abspath(__file__))
    templates_dir = os.path.join(_base, "skills", "report-generator", "templates")
    
    with open(os.path.join(templates_dir, "report-shell.html"), "r", encoding="utf-8") as f:
        template = f.read()
    with open(os.path.join(templates_dir, "echarts.min.js"), "r", encoding="utf-8") as f:
        echarts_lib = f.read()
    
    report_json_str = json.dumps(report_data, ensure_ascii=False)
    
    html = template.replace("{{ECHARTS_LIB}}", f"<script>{echarts_lib}</script>")
    html = html.replace("{{REPORT_JSON}}", report_json_str)
    html = html.replace("{{REPORT_TITLE}}", report_data.get("title", "分析报告"))
    
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(html)
    
    return output_path
```

- [ ] **Step 2: 写 Report Renderer 封装**

```python
# webapp/render.py
"""Report Renderer：把工作流结果转成 HTML 报告。封装 build_report.assemble_report()。"""
from __future__ import annotations
import uuid
from pathlib import Path


def make_report_renderer(reports_dir: Path, project_root: Path, loader=None):
    import sys
    sys.path.insert(0, str(project_root))
    from build_report import assemble_report

    async def render(result) -> str:
        """从 WorkflowResult 生成报告 HTML，返回 /static/reports/{uuid}.html 的 URL 路径。"""
        rid = uuid.uuid4().hex[:8]
        filename = f"report_{rid}.html"
        filepath = reports_dir / filename

        # 构造 report-generator 兼容的 JSON
        report_data = {
            "title": f"问数分析: {result.report_data.get('question', '')[:50]}",
            "subtitle": f"域: {result.report_data.get('domain', '')} | SQL: {result.sql[:80]}...",
            "kpis": _extract_kpis(result),
            "insight": result.analysis,
            "sections": _make_sections(result),
            "provenance": {
                "domain": result.report_data.get("domain", ""),
                "sql": result.sql,
                "review": f"passed={result.review.passed}, issues={result.review.issues}",
            },
        }
        assemble_report(report_data, str(filepath), base_dir=str(project_root))
        return f"/static/reports/{filename}"

    def _extract_kpis(result) -> list[dict]:
        """从分析文本和数据中提取 KPI。"""
        # 简单实现：从 data 中取前 4 个数字字段
        kpis = []
        if result.data:
            row = result.data[0]
            numeric_keys = [k for k in row.keys() if isinstance(row[k], (int, float))]
            for k in numeric_keys[:4]:
                kpis.append({
                    "label": k,
                    "value": f"{row[k]:,.0f}" if isinstance(row[k], (int, float)) else str(row[k]),
                    "direction": "neutral",
                })
        return kpis

    def _make_sections(result) -> list[dict]:
        return [
            {
                "id": "analysis",
                "tab": "分析结论",
                "type": "analysis-only",
                "analysis": result.analysis,
            },
            {
                "id": "data",
                "tab": "数据明细",
                "type": "data-table",
                "table": {
                    "columns": list(result.data[0].keys()) if result.data else [],
                    "rows": [list(row.values()) for row in result.data[:50]],
                },
            },
        ]

    return render
```

- [ ] **Step 3: 修复 main.py 依赖注入**

```python
# webapp/main.py（最终版）
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager
from pathlib import Path
from dotenv import load_dotenv
load_dotenv()

from webapp.session import SessionManager
from webapp.orchestrator.loader import SkillsLoader
from webapp.llm.deepseek import DeepSeekV4Client
from webapp.mcp.client import DWSMcpClient

SKILLS_DIR = Path("D:/dataproj/skills")
MCP_SERVER = Path("D:/dataproj/dws_mcp_server.py")
STATIC_DIR = Path("D:/dataproj/webapp/static")

session_mgr = SessionManager()
app = FastAPI(title="智能问数", version="0.1.0")

# app.state 存储运行时单例
app.state.loader = None
app.state.llm = None
app.state.mcp = None
app.state.router = None
app.state.render_report = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    print("[startup] Loading skills...")
    app.state.loader = SkillsLoader(SKILLS_DIR)
    print(f"[startup] Loaded {len(app.state.loader.skills)} domains: {app.state.loader.get_domain_list()}")

    print("[startup] Starting MCP...")
    app.state.mcp = DWSMcpClient(MCP_SERVER)
    await app.state.mcp.start()

    print("[startup] Creating LLM...")
    app.state.llm = DeepSeekV4Client()

    from webapp.orchestrator.router import SkillsRouter
    app.state.router = SkillsRouter(app.state.loader, app.state.llm)

    from webapp.render import make_report_renderer
    app.state.render_report = make_report_renderer(
        STATIC_DIR / "reports", Path("D:/dataproj"), app.state.loader
    )

    print("[startup] Server ready at http://0.0.0.0:8000")
    yield
    print("[shutdown] Stopping...")
    await app.state.llm.close()
    await app.state.mcp.stop()

app.router.lifespan_context = lifespan


@app.post("/ask")
async def ask(req: AskRequest):
    """核心问答接口。"""
    from webapp.orchestrator.workflow import AnalystWorkflow
    from webapp.orchestrator.reviewer import Reviewer
    
    session = session_mgr.get_or_create(req.session_id)

    route = await app.state.router.route(req.question)
    if route.domain == "unknown":
        return AskResponse(
            session_id=session.session_id,
            domain="unknown", confidence=route.confidence,
            markdown="", sql="", review_passed=True,
            needs_confirmation=True,
            message=f"该问题不在已覆盖的业务域内。当前支持：{', '.join(app.state.loader.get_domain_list())}。",
        )

    if route.needs_confirmation:
        return AskResponse(
            session_id=session.session_id,
            domain=route.domain, confidence=route.confidence,
            markdown="", sql="", review_passed=True,
            needs_confirmation=True,
            message=f"问题可能属于**{route.domain}**（置信度{route.confidence:.0%}）。备选：{', '.join(route.candidates)}。",
        )

    wf = AnalystWorkflow(app.state.loader, app.state.llm, app.state.mcp)
    reviewer = Reviewer(app.state.llm)
    try:
        result = await wf.run_full(req.question, route.domain, reviewer)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"分析失败：{str(e)}")

    report_url = None
    try:
        report_url = await app.state.render_report(result)
    except Exception:
        pass

    session.add_message("user", req.question)
    session.add_message("assistant", result.analysis)

    return AskResponse(
        session_id=session.session_id,
        domain=route.domain, confidence=route.confidence,
        markdown=result.analysis, sql=result.sql,
        review_passed=result.review.passed,
        report_url=report_url,
        trace=result.trace,
    )


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
```

在文件顶部补充 import：

```python
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

class AskRequest(BaseModel):
    session_id: str | None = None
    question: str

class AskResponse(BaseModel):
    session_id: str
    domain: str
    confidence: float
    markdown: str
    sql: str
    review_passed: bool
    report_url: str | None = None
    trace: list = []
    needs_confirmation: bool = False
    message: str = ""
```

- [ ] **Step 4: 测试 /ask 接口**

启动服务后用 curl 测试：

```bash
cd D:/dataproj && python -m uvicorn webapp.main:app --host 0.0.0.0 --port 8000
```

另开终端：

```bash
curl -X POST http://localhost:8000/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "上月销售达成情况"}'
```

期望返回 JSON，含 `markdown`、`sql`、`report_url` 等字段。

---

### Task 14: 实现前端聊天页

**Files:**
- Create: `webapp/static/index.html`

- [ ] **Step 1: 写单页 HTML**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>智能问数</title>
<script src="https://unpkg.com/vue@3/dist/vue.global.prod.js"></script>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<style>
  :root {
    --bg-base: #0d1117;
    --bg-card: #161b22;
    --bg-input: #21262d;
    --border: #30363d;
    --text-primary: #c9d1d9;
    --text-secondary: #8b949e;
    --accent: #58a6ff;
    --accent-green: #7ee787;
    --accent-red: #f78166;
    --radius: 8px;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: var(--bg-base); color: var(--text-primary); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; height: 100vh; display: flex; flex-direction: column; }
  #app { display: flex; flex-direction: column; height: 100vh; max-width: 900px; margin: 0 auto; width: 100%; padding: 0 16px; }

  .header { padding: 16px 0; border-bottom: 1px solid var(--border); text-align: center; }
  .header h1 { font-size: 20px; color: var(--accent); }

  .chat-area { flex: 1; overflow-y: auto; padding: 16px 0; display: flex; flex-direction: column; gap: 16px; }

  .message { padding: 14px 18px; border-radius: var(--radius); max-width: 100%; line-height: 1.6; }
  .message.user { align-self: flex-end; background: var(--bg-card); border: 1px solid var(--border); }
  .message.assistant { background: var(--bg-card); border: 1px solid var(--border); }
  .message.assistant h2 { color: var(--accent); font-size: 16px; margin: 8px 0 4px; }
  .message.assistant h3 { color: var(--text-primary); font-size: 14px; margin: 6px 0 3px; }
  .message.assistant ul, .message.assistant ol { padding-left: 20px; }
  .message.assistant table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 13px; }
  .message.assistant th, .message.assistant td { border: 1px solid var(--border); padding: 6px 10px; text-align: left; }
  .message.assistant th { background: var(--bg-input); }
  .message.assistant code { background: var(--bg-input); padding: 2px 6px; border-radius: 4px; font-size: 12px; }
  .message.assistant pre { background: var(--bg-input); padding: 12px; border-radius: var(--radius); overflow-x: auto; margin: 8px 0; }
  .message.assistant strong { color: var(--accent-green); }
  .message.system { align-self: center; background: transparent; color: var(--text-secondary); font-size: 13px; border: none; }

  .suggestions { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px 0; justify-content: center; }
  .suggestion-btn { background: var(--bg-card); border: 1px solid var(--border); color: var(--text-primary); padding: 8px 16px; border-radius: 20px; cursor: pointer; font-size: 13px; transition: border-color 0.2s; }
  .suggestion-btn:hover { border-color: var(--accent); }

  .input-area { padding: 12px 0 20px; display: flex; gap: 8px; border-top: 1px solid var(--border); }
  .input-area input { flex: 1; background: var(--bg-input); border: 1px solid var(--border); color: var(--text-primary); padding: 10px 16px; border-radius: var(--radius); font-size: 14px; outline: none; }
  .input-area input:focus { border-color: var(--accent); }
  .input-area button { background: var(--accent); color: #fff; border: none; padding: 10px 20px; border-radius: var(--radius); cursor: pointer; font-size: 14px; font-weight: 600; }
  .input-area button:disabled { opacity: 0.5; cursor: not-allowed; }

  .loading { display: flex; gap: 6px; padding: 14px 18px; }
  .loading span { width: 8px; height: 8px; background: var(--accent); border-radius: 50%; animation: bounce 1.4s infinite ease-in-out both; }
  .loading span:nth-child(1) { animation-delay: -0.32s; }
  .loading span:nth-child(2) { animation-delay: -0.16s; }
  @keyframes bounce { 0%, 80%, 100% { transform: scale(0); } 40% { transform: scale(1); } }

  .report-iframe { width: 100%; height: 600px; border: 1px solid var(--border); border-radius: var(--radius); margin: 12px 0; }
  .trace-toggle { color: var(--text-secondary); cursor: pointer; font-size: 12px; margin-top: 8px; user-select: none; }
  .trace-content { background: var(--bg-input); padding: 10px; border-radius: var(--radius); font-size: 12px; margin-top: 6px; max-height: 300px; overflow-y: auto; white-space: pre-wrap; font-family: monospace; }
</style>
</head>
<body>
<div id="app">
  <div class="header"><h1>智能问数</h1></div>

  <div class="chat-area" ref="chatArea">
    <div class="message system">当前覆盖：销售业绩 · 库存仓储 · 应收账龄 · 财务费用</div>

    <div v-if="messages.length === 0" class="suggestions">
      <button class="suggestion-btn" v-for="q in suggestions" @click="ask(q)">{{ q }}</button>
    </div>

    <div v-for="(msg, i) in messages" :key="i" :class="'message ' + msg.role">
      <div v-if="msg.role === 'assistant'" v-html="renderMarkdown(msg.content)"></div>
      <div v-else>{{ msg.content }}</div>
      <div v-if="msg.reportUrl" style="margin-top:12px;">
        <strong style="color:var(--accent);cursor:pointer;" @click="msg.showReport = !msg.showReport">
          {{ msg.showReport ? '▼' : '▶' }} 交互式报告
        </strong>
        <iframe v-if="msg.showReport" :src="msg.reportUrl" class="report-iframe"></iframe>
      </div>
      <div v-if="msg.trace" class="trace-toggle" @click="msg.showTrace = !msg.showTrace">
        {{ msg.showTrace ? '▼' : '▶' }} 推理过程
      </div>
      <div v-if="msg.showTrace" class="trace-content">{{ JSON.stringify(msg.trace, null, 2) }}</div>
    </div>

    <div v-if="loading" class="loading"><span></span><span></span><span></span></div>
  </div>

  <div class="input-area">
    <input v-model="question" @keyup.enter="ask(question)" placeholder="输入你的问题..." :disabled="loading" />
    <button @click="ask(question)" :disabled="loading || !question.trim()">发送</button>
  </div>
</div>

<script>
const { createApp } = Vue;

createApp({
  data() {
    return {
      question: '',
      loading: false,
      sessionId: null,
      messages: [],
      suggestions: [
        '东西事业部 2026年Q1 销售达成情况？',
        '5月应收账款账龄分析？超期客户有哪些？',
        '库存资金占压同比变化？库龄最长工厂？',
        '财经平台费用预算执行情况？哪些科目超支？',
      ],
    };
  },
  methods: {
    async ask(q) {
      const text = (typeof q === 'string' ? q : this.question).trim();
      if (!text || this.loading) return;
      this.question = '';
      this.messages.push({ role: 'user', content: text });
      this.loading = true;
      this.$nextTick(() => this.scrollBottom());

      try {
        const resp = await fetch('/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: this.sessionId, question: text }),
        });
        const data = await resp.json();
        this.sessionId = data.session_id;

        if (data.needs_confirmation) {
          this.messages.push({ role: 'system', content: data.message });
        } else {
          this.messages.push({
            role: 'assistant',
            content: data.markdown,
            reportUrl: data.report_url,
            trace: data.trace,
            showReport: false,
            showTrace: false,
          });
        }
      } catch (e) {
        this.messages.push({ role: 'system', content: '请求失败：' + e.message });
      } finally {
        this.loading = false;
        this.$nextTick(() => this.scrollBottom());
      }
    },
    renderMarkdown(text) {
      if (!text) return '';
      return marked.parse(text);
    },
    scrollBottom() {
      const el = this.$refs.chatArea;
      if (el) el.scrollTop = el.scrollHeight;
    },
  },
}).mount('#app');
</script>
</body>
</html>
```

- [ ] **Step 2: 浏览器打开测试**

启动：

```bash
cd D:/dataproj && python -m uvicorn webapp.main:app --host 0.0.0.0 --port 8000
```

浏览器访问 `http://localhost:8000/static/index.html`

期望看到深色聊天页 + 4 个推荐问题 + 输入框可用。

---

## 阶段 4：联调 + 测试 + 部署（Day 18-20）

### Task 15: 端到端真实测试（4 个域）

- [ ] **Step 1: 测试 sales-performance 域**

在浏览器聊天页输入：
```
上月销售达成情况
```

期望：
- 路由到 sales-performance（control 查看推理过程）
- 生成 SQL 含 period 过滤
- 返回 Markdown 分析（含达成率%
- 审查通过
- 可展开 HTML 报告（iframe 可见）

- [ ] **Step 2: 测试 inventory 域**

```
库存资金占压情况？哪个工厂库龄最长？
```

期望：路由 inventory → SQL 含 dm_fin_stock_detail_accage 表 → 审查通过。

- [ ] **Step 3: 测试 ar 域**

```
当前应收账款账龄分布？
```

期望：路由 ar → SQL 含 ar_account_detail 表 → 审查通过 → 含逾期天数分析。

- [ ] **Step 4: 测试 fin-cost 域**

```
财经平台费用预算执行情况？
```

期望：路由 fin-cost → SQL 含 finance_cost 表 → 审查通过 → 含预算 vs 实际对比。

- [ ] **Step 5: 测试边界问题**

| 输入 | 预期行为 |
|------|---------|
| "帮我查HR员工数量" | router 返回 unknown，提示未覆盖 |
| "库存" | router 返回 low confidence，让用户确认 |
| 空输入 | 不应该发送 |
| 超长输入 (>500 字) | 正常处理（不 crash） |

- [ ] **Step 6: 如有失败，回 Task 7-11 修复**

工具调用错误：增加 SQL 修复重试次数
模型输出格式：修正 parse_json 逻辑
审查误判：调整审查阈值或增加重试

---

### Task 16: 本地部署 + 文档

- [ ] **Step 1: 写 README**

在 `webapp/` 下创建 `README.md`：

```bash
# 智能问数 Web 服务 MVP v0.1

## 环境要求
- Python 3.9+
- DWS 数据库可达

## 快速启动（3 步）

```bash
# 1. 安装依赖
pip install -r requirements.txt

# 2. 配置 API Key
cp .env.example .env
# 编辑 .env，填入 DEEPSEEK_API_KEY

# 3. 启动
cd D:/dataproj
python -m uvicorn webapp.main:app --host 0.0.0.0 --port 8000
```

浏览器打开 `http://localhost:8000/static/index.html`

## 可用领域
- 销售业绩 (sales-performance)
- 库存仓储 (inventory)
- 应收账款 (ar)
- 财务费用 (fin-cost)
```

- [ ] **Step 2: 端到端性能测试**

```bash
time curl -X POST http://localhost:8000/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "销售达成情况"}' | python -m json.tool | head -5
```

确认响应时间 < 60 秒。

- [ ] **Step 3: 内网部署**

在开发机上运行：

```bash
cd D:/dataproj
python -m uvicorn webapp.main:app --host 0.0.0.0 --port 8000
```

确认本机 IP 能被其他电脑访问：
```bash
ipconfig | grep "IPv4"
```

选一个 C-level 用户测试：浏览器打开 `http://<开发机IP>:8000/static/index.html`。

---

## 风险与回退

| 风险 | 回退方案 |
|------|---------|
| DeepSeek-V4-Pro tool use 完全不行 | 改用降级路径（Task 8 中 tool_choice="none" + prompt 注入） |
| MCP server 子进程通信不稳定 | 改用 HTTP wrapper（FastAPI 包装 MCP server） |
| 报告 HTML 生成失败 | 只返回 Markdown，report_url 留空 |
| Skills 改了编排层出错 | 回退到上一个 commit；CI 跑 eval 保护 |
| 某域 6 步工作流全程 fail | 单独 debug 该域，其他 3 域不受影响 |
