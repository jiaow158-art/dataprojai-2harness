# dsh 引擎接入 · M0 完整能力验证 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在最终受限环境中，用 dsh + deepseek-v4-flash 完整复现一份结果 >200 行的复杂报告（Skills→MCP→Python/Shell→HTML→多轮追问），产出隔离配置、依赖部署清单与 go/no-go 决策。

**Architecture:** 垂直切片式验证——不建网关（那是 M1），直接驱动 dsh headless。我们的代码（MCP 双通道、沙箱执行器、对比脚本）走 TDD 完整实现；dsh 侧集成（skill 格式、插件 API、会话机制）先做发现并记录进 findings 文件，再按记录的 API 对接。规范来源：`docs/superpowers/specs/2026-09-07-dsh-agent-engine-design.md`（v3）。

**Tech Stack:** dsh（DeepSeek Harness，服务器安装）、deepseek-v4-flash API、Python 3.12 + psycopg2 + pytest、Docker（Linux 沙箱隔离）、Bash。

**范围决策：** 本计划只覆盖 M0。M1（网关/任务恢复）、M2（回归）、M3/M4 的计划依赖 M0 的 spike 结论（skill 兼容结局、dsh 插件 API、隔离验证结果），在 M0 go/no-go 后另出。

**运行环境约定：**
> **执行环境变更（2026-09-08，用户确认）：M0 全部任务先在本机 Windows 本地模拟执行，暂不部署服务器。** 原"服务器"字样的任务在本机执行：Linux 专属命令用本机等价物（Git Bash / Docker Desktop），差异记入 `m0/findings/`。沙箱隔离若无 Docker Desktop 则降级并在 REPORT.md 记录风险。
- **本机** = Windows 工作副本 `D:\dataprojai-2harness`（Python: `C:\Users\Administrator\AppData\Local\Programs\Python\Python312\python.exe`，pytest 9.1.1 可用）
- **服务器** = Linux（claudecodeui 同机，仓库路径 `/home/dp-user/dataprojv2`，DWS 与 DeepSeek API 均可达）。服务器侧任务的产出经 git push/pull 与本机同步
- dsh 的实际 CLI 参数/配置格式/插件 API 尚未实测——凡涉及处，任务内含**发现步骤**（确切命令 + 把实测结果记入 `m0/findings/dsh-api.md`），后续步骤按记录值实施。**禁止凭猜测编写 dsh 调用**

---

## Phase A — 基线与环境

### Task 1: 服务器环境盘点

**Files:**
- Create: `m0/findings/environment.md`（服务器上创建，回传仓库）
- Create: `m0/findings/`（目录）

- [ ] **Step 1: 服务器执行盘点命令并记录**

```bash
ssh <服务器>   # 用户凭证由使用者持有
cd /home/dp-user/dataprojv2
mkdir -p m0/findings
{
  echo "# 服务器环境盘点 ($(date +%F))"
  echo "- OS: $(cat /etc/os-release | head -1)"
  echo "- Docker: $(docker --version 2>&1 || echo 'NOT INSTALLED')"
  echo "- Docker 权限: $(docker ps >/dev/null 2>&1 && echo OK || echo 'NO PERMISSION (需用户组或 sudo)')"
  echo "- Node: $(node --version 2>&1 || echo 'NOT INSTALLED')"
  echo "- npm: $(npm --version 2>&1 || echo 'NOT INSTALLED')"
  echo "- Python3: $(python3 --version 2>&1)"
  echo "- 磁盘剩余: $(df -h /home | tail -1)"
  echo "- 内存: $(free -h | head -2 | tail -1)"
  echo "- 出网-DeepSeek API: $(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://api.deepseek.com/ || echo FAIL)"
  echo "- 出网-npm registry: $(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://registry.npmjs.org/ || echo FAIL)"
} > m0/findings/environment.md
cat m0/findings/environment.md
```

Expected: 全部条目有值。**若 Docker 不可用** → 记录缺失，Task 11 前由用户决定安装 Docker 或启用备选（受限用户+清洗环境，隔离强度降级，需写入 REPORT.md 风险节）。

- [ ] **Step 2: 提交**

```bash
git add m0/findings/environment.md && git commit -m "chore(m0): 服务器环境盘点"
```

---

### Task 2: 安装 dsh、记录 API 发现、配置密钥（需用户参与）

**Files:**
- Create: `m0/findings/dsh-api.md`
- 服务器 env 文件 `/home/dp-user/.dsh-env`（不进仓库）

- [ ] **Step 1: 从官方源获取并执行安装**

```bash
# 官方仓库 README 含安装命令（npm 全局包或安装脚本）
# https://github.com/deepseek-ai/awesome-deepseek-agent → DeepSeek Harness 条目 → 官方仓库
# 在服务器执行 README 中的安装命令，然后：
dsh --version 2>&1 | tee -a /home/dp-user/dataprojv2/m0/findings/dsh-api.md
```

- [ ] **Step 2: 发现并记录 dsh 的四个 API 面**

对下面每一项：运行 `dsh --help`（及子命令 help）、查阅官方文档，把**实测到的**确切用法记入 `m0/findings/dsh-api.md`：

```markdown
# dsh API 发现记录
## 1. headless/编程调用
- 命令/SDK 入口：<实测填写：如 dsh run --headless --json …>
- 事件流输出格式与示例：<粘贴一次真实调用的前 20 行输出>
## 2. skill 插件
- skill 目录约定与清单文件名/字段：<实测填写>
- 最小可加载 skill 的目录树：<实测填写>
## 3. MCP server 注册
- stdio server 注册的配置文件路径与字段：<实测填写>
- 环境变量注入方式：<实测填写>
## 4. 自定义工具插件
- 工具插件的最小代码样例（官方示例链接 + 本地复刻路径）：<实测填写>
## 5. 多轮会话
- headless 模式下延续会话的机制（resume/session id）：<实测填写>
```

**每项必须来自实测输出或官方文档原文，不得转述猜测。** 后续 Phase C/D 的任务引用本文件的记录值。

- [ ] **Step 3: 用户获取 DeepSeek API key 并配置（需用户参与）**

```bash
# 用户在 DeepSeek 开放平台注册并创建 API key（含 deepseek-v4-flash 访问权限）
cat > /home/dp-user/.dsh-env <<'EOF'
export DSH_API_KEY=<用户填入>
export DSH_MODEL=deepseek-v4-flash
EOF
chmod 600 /home/dp-user/.dsh-env
# 验证（预期返回模型列表或成功响应码）：
source /home/dp-user/.dsh-env && curl -s https://api.deepseek.com/models -H "Authorization: Bearer $DSH_API_KEY" | head -5
```

Expected: 返回含 `deepseek-v4-flash` 的模型列表。`.dsh-env` 不进 git（`.gitignore` 追加 `m0/findings/` 中的密钥类内容不需要——密钥只在服务器 env 文件）。

- [ ] **Step 4: 提交 findings（不含密钥）**

```bash
git add m0/findings/dsh-api.md && git commit -m "docs(m0): dsh API 实测发现记录"
```

---

### Task 3: 选定金样报告并固化基线（需用户参与）

**Files:**
- Create: `m0/golden/report.html`（现役正确产物）
- Create: `m0/golden/trace.md`（生成轨迹与依赖盘点）
- Create: `m0/golden/metrics.json`（关键指标及其 SQL）
- Create: `m0/env-manifest.md`（依赖部署清单初版）

说明：eval_dataset.json 的 71 个场景均无报告类场景，金样须人工选定。

- [ ] **Step 1: 用户指定一份"最复杂、近期正确生成过"的报告（结果 >200 行）**

候选特征：跨多月/多组织、含 TOP 榜与趋势图、数据行数 >200。记录选定理由于 `m0/golden/trace.md` 开头。

- [ ] **Step 2: 取得现役产物与轨迹**

若历史产物仍在（claudecodeui 服务器上的报告目录），复制到 `m0/golden/report.html`；否则用当前 Claude 引擎重新生成一次。轨迹记录写入 `m0/golden/trace.md`，至少包含：

```markdown
# 金样报告轨迹
## 问题原文：<用户当初的提问>
## 会话中触发的 skill：<列出，如 inventory-knowledge → inventory-analyst → report-generator>
## 执行的 SQL：<按序粘贴（从会话历史取）>
## 调用的脚本/资源：
- skills/report-generator/scripts/build.py（如使用）
- skills/report-generator/scripts/validate_report.py（如使用）
- skills/report-generator/templates/{report-shell.html, echarts.min.js}
- 其他实际引用的文件
## 产物：<report.html 的行数与大小>
```

- [ ] **Step 3: 抽取 3~5 个关键指标 → `m0/golden/metrics.json`**

每个指标 = 名称 + 取数 SQL + 人类可读期望值。数值真相永远以**同 SQL 重跑**为准（防数据漂移），此文件是 M0 Task 15 的对比输入：

```json
{
  "report_question": "<问题原文>",
  "metrics": [
    {"name": "库存跌价总额", "sql": "SELECT SUM(...) FROM dm... WHERE <与报告完全相同的过滤口径>", "expect_hint": "报告中该数字的含义说明"},
    {"name": "TOP1 SKU 金额", "sql": "SELECT ... ORDER BY ... LIMIT 1", "expect_hint": "..."},
    {"name": "数据明细行数", "sql": "SELECT COUNT(*) FROM <报告明细对应的同口径查询>", "expect_hint": "应 >200，验证不截断"}
  ]
}
```

- [ ] **Step 4: 产出依赖部署清单 `m0/env-manifest.md`**

从轨迹中的脚本与资源盘点（读 `skills/report-generator/scripts/build.py`、`validate_report.py` 的 import 与文件引用、`report-shell.html` 的字体/资源引用）：

```markdown
# 受控执行环境依赖清单（v1，来自金样轨迹）
- Python 3.12
- pip 包：<从 build.py/validate_report.py 的 import 汇总，如 json/schema/…；标准库单独标注>
- 本地资产：templates/report-shell.html、templates/echarts.min.js、references/report-schema.json
- 字体：<report-shell.html 中 font-family 实际用到的系统字体>
- 命令：<bash/python3 等实际调用>
- 目录：技能资产只读路径、结果文件路径、工作目录
```

- [ ] **Step 5: 提交**

```bash
git add m0/golden/ m0/env-manifest.md && git commit -m "test(m0): 固化金样报告与依赖清单"
```

---

## Phase B — MCP 结果双通道（本机 TDD）

### Task 4: 双通道失败测试

**Files:**
- Create: `tests/test_dual_channel.py`
- Create: `tests/__init__.py`（空文件）

改造目标（spec D13/8.2）：`RESULT_DIR` 配置后，`run_query` 执行**无自动 LIMIT 的原 SQL**，完整结果落盘（≤`RESULT_DATA_BUDGET_ROWS`），模型只收 ≤`RESULT_PREVIEW_ROWS` 预览 + 引用元数据；超预算置 `truncated=true` 并给重聚合指引；`RESULT_DIR` 为空时保持旧行为（自动 LIMIT 200 + 顶 500）。

- [ ] **Step 1: 写测试**

```python
"""Dual-channel run_query tests: preview for model, full result to file (spec D13)."""
import json, os, sys
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import dws_mcp_server as srv


def _rows(n):
    return [{"sku": f"S{i}", "amt": i} for i in range(n)]


@pytest.fixture
def result_dir(tmp_path, monkeypatch):
    # 注意：RESULT_* 是模块导入时常量，必须 patch 模块属性而非环境变量
    monkeypatch.setattr(srv, "RESULT_DIR", str(tmp_path), raising=False)
    monkeypatch.setattr(srv, "RESULT_PREVIEW_ROWS", 200, raising=False)
    monkeypatch.setattr(srv, "RESULT_DATA_BUDGET_ROWS", 50000, raising=False)
    return tmp_path


def _parse(out):
    return json.loads(out)


def test_preview_limited_full_saved(result_dir, monkeypatch):
    monkeypatch.setattr(srv, "execute_bounded", lambda sql, budget: (_rows(800), False))
    resp = _parse(srv.tool_run_query(sql="SELECT sku, amt FROM t"))
    assert resp["status"] == "ok"
    assert resp["row_count"] == 800            # 实际行数
    assert len(resp["data"]) == 200            # 预览 ≤200
    assert resp["truncated"] is False
    assert resp["result_ref"]                  # 引用存在
    f = result_dir / f"{resp['result_ref']}.json"
    saved = json.loads(f.read_text(encoding="utf-8"))
    assert saved["row_count"] == 800           # 落盘完整
    assert saved["data"] == _rows(800)


def test_over_budget_truncated_no_file(result_dir, monkeypatch):
    monkeypatch.setattr(srv, "execute_bounded", lambda sql, budget: (_rows(60000), True))
    resp = _parse(srv.tool_run_query(sql="SELECT * FROM big"))
    assert resp["truncated"] is True
    assert "聚合" in resp["guidance"]
    assert list(result_dir.glob("*.json")) == []  # 截断数据不落盘


def test_no_autolimit_in_dual_mode(result_dir, monkeypatch):
    seen = {}
    def fake(sql, budget):
        seen["sql"], seen["budget"] = sql, budget
        return _rows(10), False
    monkeypatch.setattr(srv, "execute_bounded", fake)
    srv.tool_run_query(sql="SELECT * FROM t")
    assert "LIMIT" not in seen["sql"].upper()   # 双通道不偷改 SQL
    assert seen["budget"] == 50000


def test_legacy_mode_unchanged(monkeypatch):
    monkeypatch.setattr(srv, "RESULT_DIR", "", raising=False)
    seen = {}
    def fake_sync(sql, params=None):
        seen["sql"] = sql
        return _rows(600), "OK"
    monkeypatch.setattr(srv, "execute_sync", fake_sync)
    resp = _parse(srv.tool_run_query(sql="SELECT * FROM t"))
    assert seen["sql"].endswith("LIMIT 200")    # 旧行为保留
    assert len(resp["data"]) == 500             # 旧顶 500
    assert resp["row_count"] == 500


def test_write_guard_unchanged(result_dir):
    resp = _parse(srv.tool_run_query(sql="DELETE FROM t"))
    assert "error" in resp
```

- [ ] **Step 2: 运行确认失败**

Run（本机）: `python -m pytest tests/test_dual_channel.py -v`
Expected: FAIL/ERROR —— `AttributeError: module 'dws_mcp_server' has no attribute 'execute_bounded'`

- [ ] **Step 3: 提交失败测试**

```bash
git add tests/ && git commit -m "test(mcp): 双通道失败测试(预览/落盘/截断/旧行为)"
```

---

### Task 5: 实现双通道

**Files:**
- Modify: `dws_mcp_server.py`（头部配置区、新增 `execute_bounded`/`save_result`、重写 `tool_run_query`）

- [ ] **Step 1: 头部配置区追加（`DWS_QUERY_TIMEOUT` 行之后）**

```python
# --- Dual-channel result config (spec D13): preview for model, full set to file ---
RESULT_DIR = os.environ.get("RESULT_DIR", "")
RESULT_PREVIEW_ROWS = int(os.environ.get("RESULT_PREVIEW_ROWS", "200"))
RESULT_DATA_BUDGET_ROWS = int(os.environ.get("RESULT_DATA_BUDGET_ROWS", "50000"))
_RESULT_SEQ = 0
_CURSOR_SEQ = 0
```

- [ ] **Step 2: `execute_sync` 之后新增两个函数**

```python
def execute_bounded(sql, budget):
    """Execute SQL with server-side cursor, fetch at most budget+1 rows.
    Returns (rows, over_budget) — over_budget=True means result exceeds budget."""
    global _CURSOR_SEQ
    start = time.time()
    conn = None
    try:
        conn = get_conn()
        _CURSOR_SEQ += 1
        with conn.cursor(name=f"mcp_q{_CURSOR_SEQ}",
                         cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.itersize = 5000
            cur.execute(sql, None)
            fetched = cur.fetchmany(budget + 1)
        over = len(fetched) > budget
        rows = [dict(r) for r in fetched[:budget]]
        log_stderr(f"bounded query: {len(rows)} rows, over_budget={over}, "
                   f"{(time.time()-start)*1000:.0f}ms")
        return rows, over
    finally:
        if conn:
            conn.close()


def save_result(sql, rows):
    """Write full result set to RESULT_DIR. Returns metadata dict or None."""
    global _RESULT_SEQ
    if not RESULT_DIR or rows is None:
        return None
    os.makedirs(RESULT_DIR, exist_ok=True)
    _RESULT_SEQ += 1
    ref = f"r-{time.strftime('%Y%m%d%H%M%S')}-{_RESULT_SEQ}"
    path = os.path.join(RESULT_DIR, f"{ref}.json")
    payload = {
        "result_ref": ref,
        "sql": sql,
        "row_count": len(rows),
        "columns": list(rows[0].keys()) if rows else [],
        "data": rows,
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, default=str)
    return {"result_ref": ref, "path": path, "row_count": len(rows)}
```

- [ ] **Step 3: 重写 `tool_run_query`（整函数替换）**

```python
def tool_run_query(**kwargs):
    sql = kwargs.get("sql", "").strip().rstrip(";")
    dangerous = ["insert", "update", "delete", "drop", "truncate", "create", "alter",
                 "grant", "revoke", "merge", "call", "execute"]
    low = sql.lower().strip()
    if any(low.startswith(kw) for kw in dangerous):
        return json.dumps({"error": "Write operation rejected. Only SELECT allowed."}, ensure_ascii=False)
    if not any(low.startswith(kw) for kw in ["select", "with", "describe", "show", "explain"]):
        return json.dumps({"error": "Only SELECT/DESCRIBE/SHOW/EXPLAIN/WITH allowed."}, ensure_ascii=False)

    # Dual-channel mode: no auto-LIMIT; full result to file, preview to model.
    if RESULT_DIR:
        rows, over_budget = execute_bounded(sql, RESULT_DATA_BUDGET_ROWS)
        if over_budget:
            preview = rows[:RESULT_PREVIEW_ROWS]
            return json.dumps({
                "status": "ok",
                "row_count": f"> {RESULT_DATA_BUDGET_ROWS}",
                "truncated": True,
                "guidance": (f"结果超过数据量预算 {RESULT_DATA_BUDGET_ROWS} 行，已截断且未保存。"
                             "请在 SQL 内重新聚合（GROUP BY/SUM），或按日期/组织分批查询。"
                             "不得以截断数据生成报告。"),
                "schema": list(rows[0].keys()) if rows else [],
                "data": preview,
            }, ensure_ascii=False, default=str)
        meta = save_result(sql, rows)
        preview = rows[:RESULT_PREVIEW_ROWS]
        return json.dumps({
            "status": "ok",
            "row_count": len(rows),
            "truncated": False,  # 完整结果已落盘，预览裁剪不构成数据截断（truncated 仅用于超预算未落盘分支）
            "result_ref": meta["result_ref"] if meta else None,
            "result_path": meta["path"] if meta else None,
            "schema": list(rows[0].keys()) if rows else [],
            "data": preview,
        }, ensure_ascii=False, default=str)

    # Legacy mode (RESULT_DIR unset): unchanged behavior.
    if "limit" not in low:
        sql += " LIMIT 200"
    rows, msg = execute_sync(sql)
    MAX_ROWS = 500
    truncated = len(rows) > MAX_ROWS
    if truncated:
        rows = rows[:MAX_ROWS]
    return json.dumps({
        "status": "ok" if not msg.startswith("ERROR") else "error",
        "message": msg,
        "row_count": len(rows),
        "truncated": truncated,
        "schema": list(rows[0].keys()) if rows else [],
        "data": rows,
    }, ensure_ascii=False, default=str)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python -m pytest tests/test_dual_channel.py -v`
Expected: 5 passed

- [ ] **Step 5: 提交**

```bash
git add dws_mcp_server.py && git commit -m "feat(mcp): run_query结果双通道—完整结果落盘/预览200行/超预算截断指引(D13)"
```

---

### Task 6: .mcp.json 路径修复 + NDJSON 烟测（本机，真连 DWS）

**Files:**
- Modify: `.mcp.json:7`（args 指向本仓库副本）

- [ ] **Step 1: 修正路径**

```json
"args": ["D:\\dataprojai-2harness\\dws_mcp_server.py"]
```

- [ ] **Step 2: NDJSON 烟测（双通道真实生效验证）**

```bash
mkdir -p /tmp/mcp_results   # Git Bash；PowerShell 用 $env:TEMP\mcp_results
DWS_PASSWORD=<凭据> RESULT_DIR=/tmp/mcp_results \
python - <<'EOF'
import json, subprocess, os
p = subprocess.Popen(["python", "dws_mcp_server.py"],
                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=os.environ.copy())
def send(obj):
    p.stdin.write((json.dumps(obj) + "\n").encode()); p.stdin.flush()
    return json.loads(p.stdout.buffer.readline())
send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
r = send({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
          "params": {"name": "run_query",
                     "arguments": {"sql": "SELECT * FROM dm.dm_fact_finance_cost_f LIMIT 5"}}})
body = json.loads(r["result"]["content"][0]["text"])
print("row_count:", body["row_count"], "| ref:", body.get("result_ref"))
assert body.get("result_ref"), "dual-channel not active"
EOF
ls /tmp/mcp_results/ | head -3   # 预期：出现 r-*.json
python -c "import json,glob; f=sorted(glob.glob('/tmp/mcp_results/r-*.json'))[-1]; print('saved rows:', json.load(open(f))['row_count'])"
```

Expected: 控制台 `row_count: 5 | ref: r-...`，结果目录有落盘文件且 `saved rows: 5`。

- [ ] **Step 3: 提交**

```bash
git add .mcp.json && git commit -m "fix(mcp): .mcp.json指向本仓库副本(原指向旧目录绝对路径)"
```

---

## Phase C — dsh 接入（服务器）

### Task 7: skill 加载 spike

**Files:**
- Create: `m0/spike/hello-skill/`（按 findings 记录的 dsh 格式）
- Modify: `m0/findings/dsh-api.md`（追加结论）

- [ ] **Step 1: 按 Task 2 记录的 skill 格式建最小技能**

内容要求（正文写死，用于验证路由与 references 读取）：

```markdown
---
<按 findings 第2节记录的 frontmatter 字段：name: hello-m0, description: M0验证用最小技能>
---
回答规则：当用户问题包含"hello-m0"时，必须先读取本技能 references/answer.md 并原样返回其中内容。
```

`references/answer.md` 内容：`M0-SKILL-OK-7f3a`（随机标记串，防模型编造）。

- [ ] **Step 2: dsh 会话验证**

按 findings 第 1 节的 headless 调用方式提问：`hello-m0 测试`。
Expected: 输出包含 `M0-SKILL-OK-7f3a`。不含 = 未真正读取 references（路由假阳性），排查后再继续。

- [ ] **Step 3: 用 inventory-knowledge 验证现有格式兼容性**

把 `skills/inventory-knowledge/` 按 findings 记录的清单方式注册给 dsh，提问一个路由测试问题（`2024年Q3瓷砖事业部库存跌价TOP10该查哪张表`）。
Expected：回答引用 inventory 域的表（如 `dm.dm_fin_stock_...`），说明 SKILL.md 正文被读取。把结论（直接兼容/需转换/需适配层）写入 findings 第 2 节末尾。

- [ ] **Step 4: 提交**

```bash
git add m0/spike/ m0/findings/dsh-api.md && git commit -m "test(m0): skill加载spike—hello技能+inventory域格式兼容结论"
```

---

### Task 8: （条件）skill 格式转换器

**触发条件：仅当 Task 7 结论为"需转换"时执行**；结论为"直接兼容"则本任务跳过并在 Task 17 报告中注明。

**Files:**
- Create: `tools/convert_skills.py`
- Test: `tests/test_convert_skills.py`

- [ ] **Step 1: 失败测试（以真实差异字段为准，下面按 frontmatter 字段名差异示例）**

```python
import sys, os, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from tools.convert_skills import convert_skill

def test_convert_preserves_body(tmp_path):
    src = tmp_path / "demo"; (src / "references").mkdir(parents=True)
    (src / "SKILL.md").write_text("---\nname: demo\ndescription: 测试\n---\n正文不可改动", encoding="utf-8")
    (src / "references" / "m.md").write_text("参考内容", encoding="utf-8")
    dst = tmp_path / "out"
    manifest = convert_skill(src, dst)
    body = (dst / manifest["entry"]).read_text(encoding="utf-8")
    assert "正文不可改动" in body            # 正文保真
    assert (dst / "references" / "m.md").read_text(encoding="utf-8") == "参考内容"
```

- [ ] **Step 2: 实现（按 findings 记录的目标格式字段映射）**

```python
"""Convert Claude-style skills/ to dsh skill format. Body content is copied verbatim;
only the manifest/frontmatter is remapped (recorded in m0/findings/dsh-api.md §2)."""
import shutil
from pathlib import Path

FIELD_MAP = {"name": "name", "description": "description"}  # 按 findings 实测更新

def convert_skill(src: Path, dst: Path) -> dict:
    dst.mkdir(parents=True, exist_ok=True)
    text = (src / "SKILL.md").read_text(encoding="utf-8")
    # 按 findings 记录的目标清单格式重排 frontmatter；正文原样保留
    if text.startswith("---"):
        _, fm, body = text.split("---", 2)
        fields = dict(l.split(":", 1) for l in fm.strip().splitlines() if ":" in l)
        mapped = {FIELD_MAP.get(k, k): v.strip() for k, v in fields.items()}
        new_text = "---\n" + "\n".join(f"{k}: {v}" for k, v in mapped.items()) + "\n---" + body
    else:
        new_text = text
    (dst / "SKILL.md").write_text(new_text, encoding="utf-8")
    if (src / "references").exists():
        shutil.copytree(src / "references", dst / "references", dirs_exist_ok=True)
    if (src / "templates").exists():
        shutil.copytree(src / "templates", dst / "templates", dirs_exist_ok=True)
    return {"entry": "SKILL.md"}
```

- [ ] **Step 3: 对 inventory-knowledge 全量转换并用 Task 7 Step 3 同题复验**
Run: `pytest tests/test_convert_skills.py -v` → pass；dsh 复验同 Task 7 Step 2/3 的 Expected。

- [ ] **Step 4: 提交**

```bash
git add tools/convert_skills.py tests/test_convert_skills.py && git commit -m "feat(m0): skill格式转换器(正文保真,仅映射清单)"
```

---

### Task 9: MCP 桥接 + 双通道在 dsh 下生效

**Files:**
- Modify: 服务器 `/home/dp-user/dataprojv2/.mcp.json`（或 findings 记录的 dsh 等价配置）
- Create: `m0/tests/mcp_bridge_check.md`（验证记录）

- [ ] **Step 1: 按 findings 第 3 节注册 stdio MCP server**

配置要点：command=服务器 python3 路径；args=`/home/dp-user/dataprojv2/dws_mcp_server.py`；env 注入 `DWS_HOST/PORT/DBNAME/USER/PASSWORD`（受限只读账号，若 DBA 尚未建好则暂用现账号并在 REPORT.md 记录为 M1 前置待办）+ `RESULT_DIR=/home/dp-user/dataprojv2/m0/results` + `RESULT_PREVIEW_ROWS=200`。

- [ ] **Step 2: 会话内验证 4 工具与双通道**

dsh 提问：`用 run_query 查询 dm schema 下表数量，然后用 describe_table 看 dm.dm_fact_finance_cost_f 的列`。
Expected: 回答含表数与列信息。然后直接验证落盘：

```bash
ls -la /home/dp-user/dataprojv2/m0/results/ | tail -3
# 结果文件 row_count 应与模型报告的 row_count 一致；模型输出中的 data 不得超过 200 行
```

- [ ] **Step 3: 把"模型可见行数 vs 落盘行数"对照记入 `m0/tests/mcp_bridge_check.md`，提交**

```bash
git add m0/tests/mcp_bridge_check.md && git commit -m "test(m0): MCP桥接+双通道在dsh下生效验证"
```

---

### Task 10: 模型接入 smoke（deepseek-v4-flash）

**Files:**
- Create: `m0/tests/model_smoke.md`

- [ ] **Step 1: 真实问数问题**

`source /home/dp-user/.dsh-env` 后以 dsh 提问（金样同域的一个简单问数问题，从 eval_dataset.json 任选该域一题的 question 原文）。
Expected: 回答含具体行数与结论；记录问题 ID、耗时、token 用量到 `m0/tests/model_smoke.md`。

- [ ] **Step 2: 提交**

```bash
git add m0/tests/model_smoke.md && git commit -m "test(m0): deepseek-v4-flash问数smoke"
```

---

## Phase D — 受控执行环境（服务器）

### Task 11: 沙箱执行器 + 脚本镜像

**Files:**
- Create: `m0/sandbox/run_in_sandbox.sh`
- Create: `m0/sandbox/Dockerfile`
- Create: `m0/sandbox/requirements.txt`（内容 = env-manifest 的 pip 包清单）

- [ ] **Step 1: requirements.txt（从 `m0/env-manifest.md` 的 pip 包节照抄）**

- [ ] **Step 2: Dockerfile**

```dockerfile
# 受控执行环境镜像：无凭据、无网络运行时注入（spec 6.2）
FROM python:3.12-slim
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt \
    && useradd -u 65534 -m scriptuser
# 字体按 env-manifest 安装，例如：
# RUN apt-get update && apt-get install -y --no-install-recommends fonts-noto-cjk && rm -rf /var/lib/apt/lists/*
USER 65534
WORKDIR /workdir
```

```bash
docker build -t dataplat-script:m0 m0/sandbox/
```

- [ ] **Step 3: run_in_sandbox.sh（完整实现，映射 spec 6.2 每一项）**

```bash
#!/usr/bin/env bash
# 受控执行：无网络(--network none)、rootfs只读(--read-only)、非root身份、
# 目录白名单(结果/资产只读, workdir可写)、资源上限(mem/cpu/pids)、超时清理(timeout+--rm)
set -euo pipefail
WORKDIR="$(cd "$1" && pwd)"; SCRIPT="$2"; shift 2
: "${RESULTS_DIR:?need RESULTS_DIR}"; : "${ASSETS_DIR:?need ASSETS_DIR}"
IMAGE="${SANDBOX_IMAGE:-dataplat-script:m0}"
MEM="${SANDBOX_MEM:-2g}"; CPUS="${SANDBOX_CPUS:-1}"
PIDS="${SANDBOX_PIDS:-64}"; TMO="${SANDBOX_TIMEOUT_S:-120}"

timeout --signal=KILL "${TMO}" docker run --rm \
  --network none \
  --read-only \
  --user 65534:65534 \
  --memory "${MEM}" --cpus "${CPUS}" --pids-limit "${PIDS}" \
  -v "${RESULTS_DIR}:/results:ro" \
  -v "${ASSETS_DIR}:/assets:ro" \
  -v "${WORKDIR}:/workdir" \
  -w /workdir \
  --env RESULT_PREVIEW_ROWS=200 \
  "${IMAGE}" python "/workdir/${SCRIPT}" "$@"
```

注意：容器内**不传任何 DWS_/DSH_ 变量**（凭据隔离）；`-v "${WORKDIR}:/workdir"` 为唯一可写路径。`chmod +x m0/sandbox/run_in_sandbox.sh`。

- [ ] **Step 4: 冒烟**

```bash
mkdir -p /tmp/wd /tmp/results
echo 'print("hello from sandbox"); import sys; print(sorted(k for k in os.environ if "DWS" in k or "DSH" in k)) or None' > /tmp/wd/t.py
sed -i '1i import os' /tmp/wd/t.py
RESULTS_DIR=/tmp/results ASSETS_DIR=/home/dp-user/dataprojv2/skills/report-generator \
  m0/sandbox/run_in_sandbox.sh /tmp/wd t.py
```

Expected: 输出 `hello from sandbox` 与**空列表**（无任何凭据变量）。

- [ ] **Step 5: 提交**

```bash
git add m0/sandbox/ && git commit -m "feat(m0): Docker受控执行环境—无网络/只读rootfs/目录白名单/资源上限(spec6.2)"
```

---

### Task 12: 沙箱红队微测试

**Files:**
- Create: `m0/tests/sandbox_redteam.sh`

- [ ] **Step 1: 四条对抗用例（每条都必须"被阻止"才算通过）**

```bash
#!/usr/bin/env bash
# 沙箱边界验证：四条全绿才允许进入 Phase E
set -u
WD=$(mktemp -d); RES=$(mktemp -d)
export RESULTS_DIR="$RES" ASSETS_DIR=/home/dp-user/dataprojv2/skills/report-generator
pass=0; fail=0
check() { if [ "$2" -ne 0 ]; then echo "[BLOCKED-OK] $1"; pass=$((pass+1)); else echo "[LEAK-FAIL] $1"; fail=$((fail+1)); fi }

# 1. 凭据不可见
cat > "$WD/t1.py" <<'EOF'
import os, sys
sys.exit(0 if [k for k in os.environ if k.startswith(("DWS_","DSH_"))] else 1)
EOF
m0/sandbox/run_in_sandbox.sh "$WD" t1.py >/dev/null 2>&1; check "凭据泄漏" $?

# 2. 网络不可达
cat > "$WD/t2.py" <<'EOF'
import socket, sys
try:
    socket.create_connection(("121.37.200.214", 8000), timeout=5); sys.exit(0)
except OSError:
    sys.exit(1)
EOF
m0/sandbox/run_in_sandbox.sh "$WD" t2.py >/dev/null 2>&1; check "网络外联" $?

# 3. 白名单外写入被拒（rootfs 只读）
cat > "$WD/t3.py" <<'EOF'
import sys
try:
    open("/etc/m0_probe", "w").write("x"); sys.exit(0)
except OSError:
    sys.exit(1)
EOF
m0/sandbox/run_in_sandbox.sh "$WD" t3.py >/dev/null 2>&1; check "越界写入" $?

# 4. 只读挂载不可写（/results）
cat > "$WD/t4.py" <<'EOF'
import sys
try:
    open("/results/m0_probe", "w").write("x"); sys.exit(0)
except OSError:
    sys.exit(1)
EOF
m0/sandbox/run_in_sandbox.sh "$WD" t4.py >/dev/null 2>&1; check "只读挂载写入" $?

echo "passed=$pass failed=$fail"
exit $fail
```

- [ ] **Step 2: 运行**

Run: `bash m0/tests/sandbox_redteam.sh`
Expected: `passed=4 failed=0`。任何 LEAK-FAIL → 修 run_in_sandbox.sh 后重跑，不得带病进入 Phase E。

- [ ] **Step 3: 提交**

```bash
git add m0/tests/sandbox_redteam.sh && git commit -m "test(m0): 沙箱红队微测试—凭据/网络/越界/只读四断言"
```

---

### Task 13: dsh 受控执行工具插件

**Files:**
- Create: `m0/dsh-plugin/exec-script/`（按 findings 第 4 节的插件结构）
- Create: `m0/tests/tool_loop_check.md`

- [ ] **Step 1: 按 findings 第 4 节实现 exec_script 工具**

工具契约（无论 dsh 插件 API 形态如何，包装逻辑一致）：

- 输入：`{"script": "<workdir 内相对路径>", "args": [...], "language": "python|bash"}`
- 行为：调 `m0/sandbox/run_in_sandbox.sh $WORKDIR <script>`；stdout/stderr 原样回传；退出码非 0 时标记 isError
- 模型侧可用的完整操作环 = 建/改脚本（dsh 自有文件写能力，限 workdir）→ exec_script 执行 → 读输出/错误 → 再改再执行 → 从 workdir 取产物

- [ ] **Step 2: 验证完整操作环（不是"能跑一段 Python"）**

dsh 会话下达：`在 workdir 写一个 t.py 读取 /assets/templates/ 下任意文件行数并输出，然后执行它`。
Expected（四项全满足记入 `m0/tests/tool_loop_check.md`）：
1. 模型成功创建/修改了 workdir 内脚本
2. 脚本能读 `/assets`（只读资产可达）
3. exec_script 返回了 stdout
4. 人为让脚本抛错（让模型改出 `1/0`），错误信息可读回传

- [ ] **Step 3: 提交**

```bash
git add m0/dsh-plugin/ m0/tests/tool_loop_check.md && git commit -m "feat(m0): dsh受控执行工具插件+完整操作环验证"
```

---

## Phase E — M0 放行验证（服务器）

### Task 14: 金样报告端到端复现

**Files:**
- Create: `m0/verify/compare_report.py`
- Create: `m0/verify/run_m0_e2e.md`（结果记录）

- [ ] **Step 1: 对比脚本**

```python
"""Compare dsh-produced report vs golden: structure + local assets + key numbers.
Numeric truth is always re-derived via metrics.json SQL (anti data drift)."""
import json, re, sys

def main(dsh_report, golden_report, metrics_json, fresh_truth):
    html = open(dsh_report, encoding="utf-8").read()
    golden = open(golden_report, encoding="utf-8").read()
    metrics = json.load(open(metrics_json, encoding="utf-8"))
    truth = json.load(open(fresh_truth, encoding="utf-8"))  # Task 15 Step 1 产出
    checks, fails = [], []
    def ck(name, ok): checks.append((name, ok)); fails.append(name) if not ok else None

    ck("产物非空且为HTML", html.strip().startswith("<") and len(html) > 5000)
    ck("echarts本地引用", "echarts.min.js" in html and "http://" not in re.sub(r"<!--.*?-->", "", html))
    ck("图表容器存在", html.count("echarts.init") >= 1)
    for m, t in zip(metrics["metrics"], truth):
        val = str(t["value"])
        ck(f"指标[{m['name']}]含真值{val}", val in html)
    print("\n".join(f"{'PASS' if ok else 'FAIL'}  {n}" for n, ok in checks))
    sys.exit(1 if fails else 0)

if __name__ == "__main__":
    main(*sys.argv[1:5])
```

- [ ] **Step 2: 受限环境全链路执行**

以金样的原始问题（`m0/golden/trace.md` 记录的"问题原文"）向 dsh 提问（skill、MCP、exec_script、沙箱全部就位），产物存 `m0/verify/report.html`。执行配置：`RESULT_DIR` 指向任务结果目录、`ASSETS_DIR` 指向 report-generator、沙箱镜像 `dataplat-script:m0`。记录耗时与全部 result_ref 到 `m0/verify/run_m0_e2e.md`。

- [ ] **Step 3: 提交**

```bash
git add m0/verify/ && git commit -m "test(m0): 金样报告端到端复现+对比脚本"
```

---

### Task 15: >200 行不截断验证

**Files:**
- Create: `m0/verify/fresh_truth.json`
- Create: `m0/verify/truncation_check.md`

- [ ] **Step 1: 用 metrics.json 的 SQL 重导数值真相**

```bash
python3 - <<'EOF'
import json, os, psycopg2
metrics = json.load(open("m0/golden/metrics.json"))
conn = psycopg2.connect(host=os.environ["DWS_HOST"], port=os.environ["DWS_PORT"],
                        dbname=os.environ["DWS_DBNAME"], user=os.environ["DWS_USER"],
                        password=os.environ["DWS_PASSWORD"])
out = []
for m in metrics["metrics"]:
    with conn.cursor() as cur:
        cur.execute(m["sql"]); row = cur.fetchone()
    out.append({"name": m["name"], "value": row[0]})
json.dump(out, open("m0/verify/fresh_truth.json", "w"), ensure_ascii=False, default=str)
print(out)
EOF
```

- [ ] **Step 2: 跑对比（Task 14 脚本第 4 参数 = fresh_truth.json）**

```bash
python3 m0/verify/compare_report.py m0/verify/report.html m0/golden/report.html \
  m0/golden/metrics.json m0/verify/fresh_truth.json
```

Expected: 全 PASS。重点看"数据明细行数"指标：落盘 result_ref 的 `row_count` >200 且报告合计与完整数据一致（无 200 行静默截断）。结果记入 `m0/verify/truncation_check.md`。

- [ ] **Step 3: 提交**

```bash
git add m0/verify/ && git commit -m "test(m0): >200行不截断验证—同SQL重导真值对照"
```

---

### Task 16: 三连问多轮测试

**Files:**
- Create: `m0/verify/multiturn_check.md`

- [ ] **Step 1: 同一逻辑会话连发三问（按 findings 第 5 节的会话延续机制）**

```
Q1: 分析2024年Q3各事业部库存跌价准备金额
Q2: 增加去年同期对比
Q3: 保留刚才的口径，生成一份报告
```

- [ ] **Step 2: 断言（逐项核对后记入 multiturn_check.md）**

| 断言 | 核对方法 |
|---|---|
| Q2 的 SQL 含同期（去年/同比）条件 | 检查 Q2 执行的 SQL（result_ref 文件里的 sql 字段） |
| Q2 的组织维度与 Q1 一致（同为各事业部） | 同上 |
| Q3 未重新定义口径，复用 Q1/Q2 范围 | Q3 的回答/SQL 与前两问的时间/组织一致 |
| Q3 产出报告且数据引用前两问结果（而非重查全部） | Q3 期间新增 result_ref 数量明显少于 Q1（或脚本读取了已存结果文件） |
| 三问全程无用户干预 | 会话记录无人工修正 |

- [ ] **Step 3: 提交**

```bash
git add m0/verify/multiturn_check.md && git commit -m "test(m0): 三连问多轮—口径/组织/结果引用延续验证"
```

---

### Task 17: M0 报告与 go/no-go

**Files:**
- Create: `m0/REPORT.md`

- [ ] **Step 1: 汇总报告（模板）**

```markdown
# M0 完整能力验证报告
## 结论：GO / NO-GO（依据下方证据）
## 放行条件核对（spec §12 M0）
- [ ] 复杂报告全链路在最终受限环境复现（Task 14 记录）
- [ ] >200 行无静默截断（Task 15 记录）
- [ ] 三连问口径/结果引用延续（Task 16 记录）
- [ ] 沙箱红队 4/4（Task 12 记录）
- [ ] 不靠临时开放宿主机权限（全程仅用 spec 6.2 边界）
## 交付物
- 隔离配置最终形态：m0/sandbox/（Docker 参数逐项对应 spec 6.2）
- 依赖部署清单：m0/env-manifest.md（+ Dockerfile/requirements.txt）
- dsh API 实测记录：m0/findings/dsh-api.md
## 遗留问题（进入 M1 前处理）
- 受限只读 DB 账号是否已建（Task 9 记录）
- <执行中发现的其他问题>
## 决策建议
- <若 NO-GO：失败分类（表选错/口径错/能力缺口/工具缺口）与建议（加固知识库/换 v4-pro/补工具）>
```

- [ ] **Step 2: 与用户过报告，确定 go/no-go，提交**

```bash
git add m0/REPORT.md && git commit -m "docs(m0): M0验证报告与go/no-go决策"
```

---

## 自审记录（计划完成后填写）

1. **Spec 覆盖（M0 范围）**：§12 M0 四项放行条件 → Task 14/15/16/12+11；§6.2 隔离配置五要素（隔离方式/执行身份/挂载/资源/清理）→ Task 11 的 docker 参数逐项；§6.5 依赖盘点 → Task 3 Step 4 + Task 11 Step 2；§8.1 spike 三结局 → Task 7/8（条件任务）；§8.2 双通道+路径修复 → Task 4/5/6/9；§8.4 完整操作环 → Task 13；§D16 模型 → Task 2/10。覆盖无缺口。
2. **占位符扫描**：dsh 侧调用一律经由 findings 实测记录（Task 2 产出，后续任务引用），无"TBD/稍后实现"；金样数值经 metrics.json 数据驱动，无裸占位。
3. **类型一致性**：`execute_bounded`/`save_result`/`result_ref`/`RESULT_DIR` 族命名在 Task 4/5/9/14 中一致；`run_in_sandbox.sh` 签名（workdir, script, args…）在 Task 11/12/13 一致。
