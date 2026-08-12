# 问数 Web 服务 MVP — 设计文档

> 创建日期：2026-06-16
> 状态：待审阅
> 目标读者：项目维护者、未来参与构建的开发者
> 关联文档：`docs/technical-framework.md`、`CLAUDE.md`

---

## 1. 背景与目标

### 1.1 背景

现有 `dataproj` 项目是面向 GaussDB DWS 数据仓库的自服务问数 Skills 框架，包含 4 个已建域：

| 域 | Knowledge Skill | Analyst Skill |
|----|-----------------|---------------|
| fin-cost | `skills/fin-cost-knowledge/` | `skills/fin-cost-analyst/` |
| inventory | `skills/inventory-knowledge/` | `skills/inventory-analyst/` |
| ar | `skills/ar-knowledge/` | `skills/ar-analyst/` |
| sales-performance | `skills/sales-performance-knowledge/` | `skills/sales-performance-analyst/` |

每域有成对的 Knowledge（路由 + references）+ Analyst（6 步工作流）。`eval_dataset.json` 30 场景通过率 96.8%。

但目前这套 Skills **只能在 Claude Code CLI 里运行**，5-10 个 C-level 用户无法直接使用 CLI。需要一个 Web 入口。

### 1.2 目标（v0.1 MVP）

让 5-10 个 C-level 用户通过浏览器（`http://内网IP:8000`）自然语言提问，得到：

1. Markdown 格式的分析结论（含同比/归因/风险提示）
2. 深色主题的 HTML 交互式报告（**复用** `skills/report-generator/`）

覆盖范围：**仅 4 个已建域**。未覆盖域（AP/GL/HR/采购等 18 个）按现有规则提示用户「该领域尚未建设」。

### 1.3 非目标（v0.1 明确不做）

- ❌ 登录 / 认证 / 权限矩阵（内网 IP 直接访问，所有用户看全量数据）
- ❌ 历史记录持久化（内存 session 即可）
- ❌ 多用户隔离 / 配额管理 / 反馈闭环
- ❌ 监控 / 成本统计
- ❌ HTTPS / 域名 / nginx 反向代理
- ❌ 移动端适配（先 PC 浏览器）
- ❌ 多模型路由 / 模型热切换

### 1.4 演进路径（不在 v0.1 实现，但架构预留）

| 版本 | 功能 |
|------|------|
| v0.2 | AD/LDAP 登录 + 权限矩阵（按 `node_desc` 隔离事业部） |
| v0.3 | PostgreSQL 历史持久化 + 监控（Prometheus + Grafana） |
| v0.4 | 订阅推送（每周/月自动跑预设问题，邮件/IM 通知） |
| v0.5 | 多模型路由（高价值问题用 GLM-4.6，日常用 DeepSeek-V4-Pro） |

**架构原则**：v0.1 的 LLM Adapter 和编排层要做到抽象充分，v0.2-v0.5 增量功能不重写核心。

---

## 2. 用户场景与闭环流程

### 2.1 典型用户画像

某陶瓷制造企业 C-level（5-10 人）：

- 总经理 / 副总经理
- 财经平台总监
- 销售总公司总经理
- 各事业部总经理（有跨域查询需求者）

使用频次：每人每周 2-3 次，每次 1-3 个问题。

### 2.2 典型问题（来自 eval_dataset.json 真实样本）

| 域 | 问题样本 |
|----|---------|
| sales-performance | 东西事业部 2026 年 Q1 销售达成率？为什么未达成？ |
| ar | 截至 2026 年 5 月应收账款账龄分布？哪些客户超期最严重？ |
| inventory | 2026 年库存资金占压同比变化？哪些工厂库龄最长？ |
| fin-cost | 2026 年财经平台费用预算执行情况？哪些科目超支？ |

### 2.3 闭环流程

```
管理层在浏览器输入 http://10.x.x.x:8000
    ↓
看到深色聊天页，首屏 4 个推荐问题（解决冷启动）
    ↓
输入："东西事业部 2026 年 Q1 销售达成情况"
    ↓
[FastAPI] POST /ask { session_id, question }
    ↓
[Router] LLM 判断: sales-performance 域 (置信度 0.92)
    ↓
[Loader] 已在启动时加载 sales-performance-knowledge/SKILL.md + references/
    ↓
[Workflow] 6 步:
  1. 问题理解 → 拆解为指标（达成率）+ 维度（事业部）+ 时间（2026 Q1）
  2. 表选择 → LLM 读 metrics.md 选 sales-performance 主事实表
  3. SQL 生成 → LLM 写 SELECT，校验日期格式
  4. MCP run_query → DWS 返回结果集
  5. 解读 → LLM 写分析（同比、归因、风险）
  6. 对抗审查 → 第二次 LLM 调用检查口径/数字/陷阱
    ↓
[Report Renderer] build_report.py → static/reports/{uuid}.html
    ↓
[Response] { markdown: "...", report_url: "/reports/{uuid}.html", trace: [...] }
    ↓
前端：Markdown 渲染 + iframe 嵌入报告 + 可展开 trace
```

---

## 3. 整体架构

```
┌──────────────────────────────────────────────────────────────┐
│  浏览器（C-level 电脑）                                        │
│   单页聊天 UI（Vue3 CDN，无构建步骤）                            │
│   - 深色主题（与 report-generator 视觉一致）                     │
│   - Markdown 渲染（marked.js）                                 │
│   - iframe 嵌入 HTML 报告                                       │
│   - 首屏 4 个推荐问题                                           │
└─────────────────────────┬────────────────────────────────────┘
                          │ HTTP（内网 IP，无 HTTPS）
                          ▼
┌──────────────────────────────────────────────────────────────┐
│  内网 Web 服务器（Python 3.9 + FastAPI + uvicorn）             │
│                                                               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Session Manager（内存 dict，TTL 2 小时）                │  │
│  └────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Skills 编排层（核心新代码，~1500 行）                    │  │
│  │   ├─ Loader：启动时读 skills/*/SKILL.md + references/    │  │
│  │   ├─ Router：LLM 路由 + 置信度阈值                       │  │
│  │   ├─ Workflow：Analyst 6 步                              │  │
│  │   └─ Reviewer：第 6 步对抗审查                            │  │
│  └────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  LLM Adapter（~400 行）                                  │  │
│  │   - LLMClient 抽象接口                                   │  │
│  │   - DeepSeekV4Client 实现（封装 tool use 协议）          │  │
│  │   - JSON 修复 / 重试 / 降级                              │  │
│  └────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  MCP Client（~250 行）                                   │  │
│  │   Python stdio JSON-RPC，启动 dws_mcp_server.py 子进程    │  │
│  │   暴露 run_query / describe_table / search_tables 等     │  │
│  └────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Report Renderer                                         │  │
│  │   直接 import build_report.py，调用 generate_report()    │  │
│  │   落盘到 static/reports/{uuid}.html                      │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────┬───────────────────────────────────┬────────────────┘
           │ HTTPS（专线/白名单）               │ 本地 stdio
           ▼                                   ▼
┌────────────────────────┐        ┌────────────────────────────┐
│  DeepSeek API          │        │  dws_mcp_server.py         │
│  模型: deepseek-v4-pro │        │  (现有，零改动)             │
│  通过环境变量注入 key   │        │  → DWS 121.37.200.214:8000 │
└────────────────────────┘        └────────────────────────────┘
```

**部署单元**：单台内网服务器一个 Python 进程，uvicorn `--workers 4` 应对并发。MVP 5-10 人足够。

---

## 4. 核心模块设计

### 4.1 前端：聊天页（2 天）

**单文件设计**：`static/index.html` 一个文件搞定，Vue3 CDN + marked.js + highlight.js，**无 npm/构建步骤**。

**视觉风格**：深色主题，复用 `skills/report-generator/templates/report-shell.html` 的配色变量（`#0d1117` 背景 / `#58a6ff` 主色 / `#7ee787` 强调）。

**首屏推荐问题**（解决冷启动）：

```
┌─────────────────────────────────────────┐
│  智能问数                       深色主题  │
├─────────────────────────────────────────┤
│                                          │
│  你可以问我：                             │
│  ┌─────────────────────────────────┐    │
│  │ 东西事业部 2026 Q1 销售达成情况？│    │  ← 4 个推荐问题
│  └─────────────────────────────────┘    │     点击直接填入输入框
│  ┌─────────────────────────────────┐    │
│  │ 5 月应收账龄分布？超期客户？     │    │
│  └─────────────────────────────────┘    │
│  ┌─────────────────────────────────┐    │
│  │ 库存资金占压同比变化？           │    │
│  └─────────────────────────────────┘    │
│  ┌─────────────────────────────────┐    │
│  │ 财经平台费用预算执行情况？       │    │
│  └─────────────────────────────────┘    │
│                                          │
│  [输入框] 输入你的问题...        [发送]  │
│                                          │
└─────────────────────────────────────────┘
```

**回答区布局**（一问一答）：

```
┌─ 用户 ──────────────────────────────────┐
│ 东西事业部 2026 Q1 销售达成情况？         │
└──────────────────────────────────────────┘

┌─ 助手 ───────────────────────────────────┐
│ ## 东西事业部 2026 Q1 销售达成分析        │
│                                          │
│ **结论**：达成率 87%，未达成主要因...     │
│                                          │
│ ▶ 查看交互式报告（点击展开 iframe）        │
│ ┌──────────────────────────────────────┐ │
│ │ [iframe: 报告内容]                    │ │
│ └──────────────────────────────────────┘ │
│                                          │
│ ▼ 查看推理过程（trace，可选展开）          │
│ - 路由：sales-performance (置信度 0.92)   │
│ - SQL：SELECT ...                        │
│ - 审查：通过                              │
└──────────────────────────────────────────┘
```

### 4.2 FastAPI 后端（1 天）

**目录结构**：

```
dataproj/
├── webapp/                      # 新增
│   ├── main.py                  # FastAPI 入口
│   ├── routes/
│   │   └── ask.py
│   ├── orchestrator/            # Skills 编排层
│   │   ├── loader.py
│   │   ├── router.py
│   │   ├── workflow.py
│   │   └── reviewer.py
│   ├── llm/                     # LLM Adapter
│   │   ├── base.py              # LLMClient 抽象
│   │   └── deepseek.py          # DeepSeekV4Client
│   ├── mcp/                     # MCP Client
│   │   └── client.py
│   ├── session.py               # 内存会话管理
│   └── static/
│       ├── index.html
│       └── reports/             # 生成的 HTML 报告
└── ...
```

**关键接口**：

```python
# main.py
@app.post("/ask")
async def ask(req: AskRequest) -> AskResponse:
    session = session_manager.get_or_create(req.session_id)
    result = await orchestrator.run(session, req.question)
    return AskResponse(
        markdown=result.markdown,
        report_url=result.report_url,
        trace=result.trace,
    )
```

**启动方式**：

```bash
# 加载 .env（含 DEEPSEEK_API_KEY）
uvicorn webapp.main:app --host 0.0.0.0 --port 8000 --workers 1
# MVP 阶段单 worker，因为内存 session 不跨进程；v0.2 加 Redis 后可多 worker
```

### 4.3 Skills 编排层（7-10 天，最关键）

这是 v0.1 最大的新代码块。**目标**：把 Claude Code 在 Skill 框架下做的事，用 Python 重新实现一遍。

#### 4.3.1 Loader（启动加载，0.5 天）

启动时一次性加载所有 Skills 到内存：

```python
class SkillsLoader:
    def __init__(self, skills_dir: Path):
        self.skills: dict[str, DomainSkills] = {}
        for domain in ["fin-cost", "inventory", "ar", "sales-performance"]:
            self.skills[domain] = DomainSkills(
                knowledge_md=(skills_dir / f"{domain}-knowledge/SKILL.md").read_text(),
                knowledge_refs=self._load_references(skills_dir / f"{domain}-knowledge/references/"),
                analyst_md=(skills_dir / f"{domain}-analyst/SKILL.md").read_text(),
            )

    def _load_references(self, refs_dir: Path) -> dict[str, str]:
        # metrics.md, data-lineage.md, table-refs.md, ...
        return {f.name: f.read_text() for f in refs_dir.glob("*.md")}
```

加载时机：FastAPI `lifespan` 启动事件，单例。**热加载留 v0.2**。

#### 4.3.2 Router（LLM 路由，1.5 天）

判断用户问题归属哪个域。**关键设计**：用一次轻量 LLM 调用做分类。

```python
ROUTER_PROMPT = """
你是数据问数系统的路由器。判断用户问题归属哪个业务域。

业务域：
- fin-cost：财务费用、成本中心、毛利、预算、费用报销、差旅费
- inventory：库存数量、库龄、出入库、库存周转、安全库存、在途库存
- ar：应收账龄、逾期应收、回款率、坏账减值、客户信用
- sales-performance：销售达成率、目标完成、销售收入、销售面积、同比环比

用户问题：{question}

输出 JSON：
{
  "domain": "fin-cost|inventory|ar|sales-performance|unknown",
  "confidence": 0.0-1.0,
  "reason": "判断依据"
}

如果问题不属于以上 4 个域，输出 "unknown"。
"""
```

**置信度阈值**：

- `confidence >= 0.7`：直接路由
- `confidence < 0.7`：返回前 2 个候选域让用户二次确认
- `domain == "unknown"`：返回「该领域尚未建设」提示

#### 4.3.3 Workflow（6 步工作流，4-5 天）

把 Analyst SKILL.md 的 6 步翻译成代码。每步一次 LLM 调用，工具调用通过 LLM Adapter。

```python
class AnalystWorkflow:
    async def run(self, question: str, skills: DomainSkills, session: Session) -> AnalysisResult:
        # Step 1: 问题理解
        parse = await self._llm.chat(
            system=skills.knowledge_md + UNDERSTAND_PROMPT,
            user=question,
        )
        # → { metric, dimensions, time_range, scope, ... }

        # Step 2: 表选择
        table_choice = await self._llm.chat(
            system=skills.knowledge_refs["metrics.md"] + TABLE_SELECT_PROMPT,
            user=str(parse),
        )
        # → { table, key_columns, filters }

        # Step 3: SQL 生成
        sql_result = await self._llm.chat_with_tools(
            system=skills.knowledge_md + skills.knowledge_refs["table-refs.md"],
            user=f"为以下分析生成 SQL：{table_choice}",
            tools=[self.mcp.describe_table_tool, self.mcp.search_tables_tool],
        )
        sql = self._extract_sql(sql_result)

        # Step 4: 执行（MCP）
        try:
            data = await self.mcp.run_query(sql)
        except Exception as e:
            # 降级：让 LLM 修 SQL 重试一次
            sql = await self._llm.repair_sql(sql, str(e))
            data = await self.mcp.run_query(sql)

        # Step 5: 解读
        analysis = await self._llm.chat(
            system=skills.analyst_md + INTERPRET_PROMPT,
            user=f"问题：{question}\nSQL：{sql}\n数据：{data.to_markdown()}",
        )

        # Step 6: 对抗审查
        review = await self.reviewer.review(question, sql, data, analysis)

        return AnalysisResult(
            markdown=analysis,
            sql=sql,
            data=data,
            review=review,
            trace=[...],
        )
```

**核心抽象**：每一步是 `async def`，可独立测试（用 `eval_dataset.json` 做回归）。

#### 4.3.4 Reviewer（对抗审查，1.5 天）

第 6 步对抗审查是 +6% 准确率的关键。**复用现有 Analyst SKILL.md 里定义的审查清单**：

```python
REVIEW_PROMPT = """
你是对抗审查员。请严格检查以下分析是否有问题。

检查清单（来自 Analyst SKILL.md）：
1. 日期格式陷阱：是否用错了 YYYYMM vs YYYY-MM-DD？
2. 字段双命名：cust_code vs debitor，material vs material_num？
3. 备份表陷阱：是否误用了 _wjh_/_bak/_tmp 后缀表？
4. 大表未限时间：>10M 行表是否漏了时间过滤？
5. node_desc 误用：跨域查询是否漏了 org 过滤？
6. 数字合理性：达成率是否在 0-200%？账龄是否非负？

分析对象：
- 问题：{question}
- SQL：{sql}
- 数据：{data}
- 结论：{analysis}

输出 JSON：
{
  "passed": true|false,
  "issues": ["问题1", "问题2", ...],
  "suggestion": "如有问题，给出修复建议"
}
"""
```

**审查失败处理**：

- 1-2 个 issues：自动让 LLM 修一次，再过一次审查
- 3+ 个 issues 或修两次仍失败：在最终输出里加 ⚠️ 警示

### 4.4 LLM Adapter：DeepSeek-V4-Pro（2 天）

#### 4.4.1 抽象接口

```python
# webapp/llm/base.py
class LLMClient(Protocol):
    async def chat(self, system: str, user: str, temperature: float = 0.3) -> str: ...
    async def chat_with_tools(
        self, system: str, user: str, tools: list[Tool]
    ) -> ToolCallResult: ...
```

**预留扩展**：v0.5 加 GLM-4.6 / Qwen-Max 时，只是新增 `GLMClient` / `QwenClient` 类。

#### 4.4.2 DeepSeek 实现

```python
# webapp/llm/deepseek.py
class DeepSeekV4Client:
    def __init__(self):
        self.api_key = os.getenv("DEEPSEEK_API_KEY")  # 从 .env 注入
        self.base_url = "https://api.deepseek.com/v1"
        self.model = "deepseek-v4-pro"

    async def chat(self, system, user, temperature=0.3) -> str:
        # 标准 messages 调用
        ...

    async def chat_with_tools(self, system, user, tools) -> ToolCallResult:
        # DeepSeek 兼容 OpenAI tool use 协议
        response = await self._call(...)
        if response.tool_calls:
            return await self._handle_tool_calls(response, tools)
        return ToolCallResult(content=response.content, tool_calls=[])
```

#### 4.4.3 DeepSeek 风险缓解

DeepSeek-V4-Pro 的 tool use 稳定性弱于 GLM/Qwen。三层缓解：

1. **JSON 修复**：tool call 参数解析失败时，让 LLM 自己修一次
   ```python
   async def _parse_tool_args(self, raw: str) -> dict:
       try:
           return json.loads(raw)
       except json.JSONDecodeError:
           fixed = await self._llm.chat(
               system="修复以下 JSON，只输出修复后的 JSON",
               user=raw,
           )
           return json.loads(fixed)
   ```

2. **重试机制**：tool use 整体失败重试 2 次

3. **降级路径**：3 次失败后降级为纯 prompt（把 tool 描述写进 system prompt，让 LLM 用纯文本输出「我想调 describe_table('xxx')」，代码解析后执行）

### 4.5 MCP Client（1-2 天）

Python 实现 MCP stdio JSON-RPC 协议，调现有 `dws_mcp_server.py`。

```python
# webapp/mcp/client.py
class DWSMcpClient:
    def __init__(self, server_path: Path):
        self.process = subprocess.Popen(
            ["python", str(server_path)],
            stdin=PIPE, stdout=PIPE, stderr=PIPE,
        )
        self._handshake()

    async def run_query(self, sql: str) -> pd.DataFrame:
        result = await self._rpc("run_query", {"sql": sql})
        return pd.DataFrame(result["rows"])

    async def describe_table(self, name: str) -> dict: ...
    async def search_tables(self, keyword: str) -> list[str]: ...
```

**生命周期**：FastAPI 启动时开子进程，关闭时优雅退出。**复用现有 MCP server，零改动**。

### 4.6 Report Renderer（0.5 天）

直接 `import` 现有 `build_report.py`，**零新代码**：

```python
from build_report import generate_report  # 现有函数

def render_report(analysis: AnalysisResult) -> str:
    # 转成 report-generator 需要的 JSON 格式
    report_data = {
        "sections": [...],
        "kpis": [...],
        "insight": analysis.markdown,
        "provenance": {...},
    }
    html = generate_report(report_data)
    path = Path(f"static/reports/{uuid4()}.html")
    path.write_text(html)
    return f"/reports/{path.name}"
```

**严格遵循** CLAUDE.md 规定的 JSON 格式：`sections[] + kpis[] + insight + provenance`，不用旧版 `charts[]/table/trace`。

---

## 5. 关键技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 模型 | DeepSeek-V4-Pro | 用户指定；成本低；推理强 |
| Web 框架 | FastAPI + uvicorn | Python 生态、原生 async、文档自动生成 |
| 前端框架 | Vue3 CDN（无构建） | 单 HTML 文件、零工程化、改起来快 |
| 会话存储 | 内存 dict | MVP 5-10 人够用；v0.2 换 Redis 不改业务代码 |
| 部署 | 内网服务器 + uvicorn --workers 1 | 单 worker 因为内存 session；v0.2 加 Redis 后多 worker |
| Skills 加载 | 启动时全量加载进内存 | 4 个域总共 < 5MB；启动 < 1s |
| 历史记录 | 内存（TTL 2h） | v0.1 不持久化；v0.3 加 PostgreSQL |
| 前端 UI 风格 | 深色，复用 report-generator 配色 | 视觉一致；C-level 看起来「专业」 |
| 报告交付 | iframe 内嵌 | 单页体验；不跳转；可下载 |
| Trace 展示 | 可折叠展开 | C-level 默认不看；调试/审计需要 |

---

## 6. 风险与缓解

| 风险 | 影响 | 缓解 | 残余风险 |
|------|------|------|---------|
| DeepSeek-V4-Pro tool use 弱，6 步工作流断链 | 高 | 三层缓解（JSON 修复 / 重试 / 降级纯 prompt）；eval_dataset 30 场景做 CI 门禁 | 中 |
| Skills Router 误路由（如把 AR 问题路由到 inventory） | 中 | 置信度阈值 0.7；前 2 个候选让用户确认 | 低 |
| 单进程并发瓶颈 | 低 | uvicorn 单 worker；5-10 人并发问数概率低 | 低 |
| Skills 内容改了不同步 | 中 | CI 跑 eval_dataset.json，通过率门槛 90% | 低 |
| DWS 大表查询超时 | 中 | MCP 已 auto-LIMIT 200；编排层强制要求时间过滤 | 低 |
| 报告渲染失败 | 低 | 降级到纯 Markdown 展示 | 极低 |
| DeepSeek API 限流 | 低 | Adapter 加 429 重试 + 指数退避 | 低 |
| 内网到 DeepSeek API 网络中断 | 高 | 暂无（监控加 v0.3） | 中 |

---

## 7. 部署方案（分阶段）

### 阶段 1：开发机本机（第 1-2 周）

```bash
# 开发者本机
cd /d/dataproj
cp .env.example .env  # 填入 DEEPSEEK_API_KEY
python -m uvicorn webapp.main:app --host 0.0.0.0 --port 8000
```

开发者自己测，跑 `eval_dataset.json` 全量回归。

### 阶段 2：开发机 + 内网 IP（第 3 周）

`http://<开发机内网IP>:8000` 给 5-10 个 C-level 试用。开发者电脑保持开机。

### 阶段 3：内网服务器（v0.2 启动时）

待 v0.1 验证完毕，找一台内网 Linux 服务器正式部署，配合 v0.2 加 AD/LDAP。

---

## 8. 验收标准

### 8.1 功能验收

- ✅ 4 个域各跑 5 个真实问题（共 20 个），准确率 ≥ 85%（17/20）
  - 用 `eval_dataset.json` 的 30 场景做 CI 门禁，通过率 ≥ 90%
- ✅ 端到端响应 P95 < 60 秒（含 SQL 执行 + 报告生成）
- ✅ 报告 HTML 在浏览器里能交互（图表、下钻）
- ✅ 推荐问题点击能直接填入并执行
- ✅ 路由置信度 < 0.7 时弹窗让用户二次确认

### 8.2 用户体验验收

- 5 个 C-level 试用 1 周
- 至少 3 人愿意继续使用（不强制 KPI，主观判断）
- 收集反馈形成 v0.2 待办

### 8.3 工程验收

- 编排层单元测试覆盖率 ≥ 70%
- LLM Adapter mock 测试通过
- 关键路径（路由 → SQL → MCP → 报告）集成测试通过
- README 含本地启动步骤（≤ 5 步）

---

## 9. 工作量估算

| 模块 | 人天 | 累计 |
|------|------|------|
| 前端聊天页 | 2 | 2 |
| FastAPI 后端骨架 | 1 | 3 |
| Skills Loader | 0.5 | 3.5 |
| Skills Router | 1.5 | 5 |
| Workflow 6 步 | 5 | 10 |
| Reviewer | 1.5 | 11.5 |
| LLM Adapter | 2 | 13.5 |
| MCP Client | 1.5 | 15 |
| Report Renderer 集成 | 0.5 | 15.5 |
| 部署 + 联调 | 2 | 17.5 |
| Eval 回归 + Bug 修 | 2.5 | 20 |

**总计：约 20 人天 = 4 周**（单人全职）。

---

## 10. 与现有架构的关系

| 现有资产 | v0.1 处理方式 |
|----------|--------------|
| `skills/*/SKILL.md` + `references/` | **100% 复用**，Loader 启动加载 |
| `dws_mcp_server.py` | **零改动**，作为子进程启动 |
| `build_report.py` + `report-generator/` | **零改动**，import 使用 |
| `eval_dataset.json` + `run_eval.py` | **零改动**，作为 CI 门禁 |
| `sources-of-truth/business-context/` | **零改动**，Knowledge Skill 会引用 |
| `huaweiclaude/` | 不动 |
| `CLAUDE.md` 规则 | 编排层强制遵循（日期格式、备份表过滤等） |

---

## 11. 开放问题（待 v0.2 处理）

1. **数据脱敏**：是否要把 DeepSeek 看到的数据脱敏？v0.1 不做（数据走加密通道到 DeepSeek 国内 API）。
2. **审计日志**：是否记录谁问了什么？v0.1 不做（无登录）；v0.2 加 AD 后做。
3. **成本控制**：DeepSeek 调用费用谁出？v0.1 不做监控，事后看账单。
4. **多轮对话**：用户能否基于上一轮结果追问？v0.1 做最简单的（session 内 LLM 看到历史 5 轮），复杂的（"上一个结果换个维度看"）留 v0.2。

---

## 附录 A：闭环保留接口

为了让 v0.2-v0.5 增量功能不重写核心，v0.1 在以下位置预留接口：

- `LLMClient` 抽象类：换模型不改编排层
- `Session` 抽象类：内存版换 Redis/PostgreSQL 版不改路由层
- `MCPClient` 抽象类：未来加更多 MCP server 不改编排层
- Workflow 每步独立 async 函数：未来加监控/追踪装饰器不改业务代码
