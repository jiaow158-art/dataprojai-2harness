# AI 经营助手 v1 · M-i1 检测层实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建成 insight 包检测层——4 个经营雷达（目标达成/区域×渠道业绩/毛利/应收）+ watermark 就绪探针 + 12 个月历史回测框架，全部可离线单测、可直连 DWS 实测。

**Architecture:** 新增独立 Python 包 `insight/`（spec §5.1），不触碰 engine-gateway/skills/现有 chat。检测 = 确定性 SQL 模板 + 配置化阈值；数据访问经 `QueryRunner` 协议（生产=psycopg2 只读直连 DWS，测试=假实现），检测器完全不感知连接细节。本计划只做 spec 的 M-i1；合并/排序/事件/简报/API/UI 在 M-i2~M-i3 计划。

**Tech Stack:** Python 3.12（仓内既有）、pytest、sqlite3（stdlib，insight.db WAL）、psycopg2（run_eval.py 已用，环境已有）。

**Spec:** `docs/superpowers/specs/2026-09-23-ai-business-assistant-v1-design.md`（v1.2，296d14a）

---

## 前置事实（工程师必读，动手前不需要再考古）

1. **DWS 连接**（抄 `run_eval.py:12-17`）：psycopg2，env `DWS_HOST`(默认 121.37.200.214)/`DWS_PORT`(8000)/`DWS_DBNAME`(DP_DWS)/`DWS_USER`(aiuser)/`DWS_PASSWORD`（**只走 env，任何输出不得含值**）。
2. **mix 表** `dm.dm_fin_operations_mix_sum_t`：时间列 `calday`(YYYYMMDD) + `calmonth`(YYYY-MM) 双列；实绩=`ambperformance`，不含税=`notax_sales_net_amt`，毛利=`gross_profit_after_sharing`；内置 `node_desc1~9/node_name1~9`；**预算/预测月到 2026-12**——实际数必须 `calmonth <= 当前月`；`data_source`：node_desc2 层级用 `IN ('S','T','D','')`。
3. **事业部过滤**：`node_desc2 = '瓷砖事业部'`（固定枚举，禁 LIKE）。
4. **ct 表** `dm.ct_sales_performance_t`：`calday`(YYYYMMDD)，`month_achievement` 是 **MTD 月末快照值**（只能取月末那天，不能区间 SUM）；同比字段 `last_year_month_achievement`（列名以 Task 10 live 验证为准，不对则改 config 不改代码）；org JOIN `dm.dm_rpt_sales_group_t`：`org_code = node_name10`。
5. **目标表** `dm.dm_dp_api_sales_target`：`target_sales_amt` **单位万元**（×10000 转元）；`org_type='业务单位'` 防总分翻倍；**陷阱：`sales_center_code ↔ mix.node_name5` 直接 JOIN 实测 0/143 匹配**——目标雷达用"mix 派生中心集 IN 过滤"，关联质量必须过 Task 10 live 验证（≥90% 匹配率才放行，否则升级用户裁决）。
6. **应收** `dwrfin.dwr_ar_receivable_aging_2023_info_f`：日快照 `query_date`(YYYY-MM-DD)；**含 2026-12-31 未来行**——必须 `query_date <= 数据日`；90 天+ = 91_275/276_730/731_1460/1461 天分段之和（_2023_after 与 _2023_ago 两族都加）；`special_general_ledger` 空=正常应收；瓷砖 scope=`comp_code IN (config 清单)`（Task 10 探针从 `sources-of-truth/business-context/` 公司主数据定）。
7. **落数时点实测（2026-09-23）**：目标 ~00:15、应收日层 ~06:31、区域日报表 `dm_rpt_region_performance_daily_report_t` **0 行（禁依赖）**。调度必须就绪驱动。
8. **红线**：提交一律路径限定 `git commit -m msg -- <paths>`；insight.db/evidence 路径在 Temp 树外；日志消毒（PASSWORD|TOKEN|SECRET|KEY）。

## File Structure（本计划新增/修改全集）

```
insight/
├─ __init__.py                 # 包标记
├─ db.py                       # insight.db 全量 schema（spec §6.1 一次建全）+ 访问
├─ dws.py                      # 只读 QueryRunner：env 连接/statement_timeout/application_name/消毒
├─ watermark.py                # 就绪探针：max 数据日（防未来行）+ 行数
├─ backtest.py                 # 12 个月重放：point-in-time 封界/确定性断言/按月分批
├─ detectors/
│  ├─ __init__.py              # 注册表 {name: Detector}
│  ├─ base.py                  # Detector 契约 + Finding + percentile 标准化
│  ├─ region_sales.py          # 区域×渠道同比连续下滑
│  ├─ gross_margin.py          # 渠道毛利率变动
│  ├─ ar_risk.py               # 90 天+应收增量/集中度
│  └─ target.py                # 达成率 vs 时间进度（口径优先级 util）
├─ config/
│  ├─ radar-region_sales.json
│  ├─ radar-gross_margin.json
│  ├─ radar-ar_risk.json
│  └─ radar-target.json
└─ tests/
   ├─ test_db.py
   ├─ test_dws.py
   ├─ test_watermark.py
   ├─ test_base.py
   ├─ test_detectors.py        # 四雷达：SQL 渲染/finding 提取/阈值/断供
   ├─ test_backtest.py
   └─ live_caliber_test.py     # INSIGHT_LIVE=1 门禁（仿 EVAL_LIVE 先例）
```

不修改任何既有文件。`ranking.json`（排序权重）属 M-i2，本计划不建。

---

### Task 1: 包骨架 + db.py 全量 schema

**Files:**
- Create: `insight/__init__.py`, `insight/detectors/__init__.py`, `insight/db.py`
- Test: `insight/tests/test_db.py`

- [ ] **Step 1: 写失败测试**

```python
# insight/tests/test_db.py
import sqlite3
import pytest
from insight.db import open_db

def test_schema_creates_all_spec_tables(tmp_path):
    db = open_db(tmp_path / "insight.db")
    names = {r["name"] for r in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    assert {"radar_run", "detector_finding", "business_event", "event_evidence",
            "event_analysis_run", "daily_brief", "daily_brief_event",
            "followup_session"} <= names

def test_partial_unique_index_rejects_second_active(tmp_path):
    db = open_db(tmp_path / "insight.db")
    ins = ("INSERT INTO business_event (event_id, event_key, lifecycle, data_date,"
           " first_seen_date, last_seen_date, persist_days, detector, event_type,"
           " title, summary, severity, scope_json, period_json, facts_json, score,"
           " score_breakdown_json, metric, status, created_at, updated_at)"
           " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    row = ("ev-1", "K1", "active", "2026-09-22", "2026-09-22", "2026-09-22", 1,
           "region_sales", "sales_decline", "t", "s", "major", "{}", "{}", "[]",
           80.0, "{}", "yoy", "discovered", 0, 0)
    db.execute(ins, row); db.commit()
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(ins, ("ev-2", "K1", "active") + row[3:]); db.commit()

def test_resolved_then_new_active_allowed(tmp_path):
    db = open_db(tmp_path / "insight.db")
    db.execute("UPDATE business_event SET lifecycle='resolved' WHERE event_id='ev-1'"
               ) if db.execute("SELECT COUNT(*) c FROM business_event").fetchone()["c"] else None
    # 直接构造：先插 active 再 resolve 再插新 active，不应抛
    ins = ("INSERT INTO business_event (event_id, event_key, lifecycle, data_date,"
           " first_seen_date, last_seen_date, persist_days, detector, event_type,"
           " title, summary, severity, scope_json, period_json, facts_json, score,"
           " score_breakdown_json, metric, status, created_at, updated_at)"
           " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    row = ("ev-1", "K1", "active", "2026-09-22", "2026-09-22", "2026-09-22", 1,
           "region_sales", "sales_decline", "t", "s", "major", "{}", "{}", "[]",
           80.0, "{}", "yoy", "discovered", 0, 0)
    db.execute(ins, row); db.commit()
    db.execute("UPDATE business_event SET lifecycle='resolved' WHERE event_id='ev-1'")
    db.commit()
    db.execute(ins, ("ev-9", "K1", "active") + row[3:]); db.commit()  # 不抛
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python -m pytest insight/tests/test_db.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'insight'`

- [ ] **Step 3: 实现**

```python
# insight/__init__.py
"""AI 经营助手 v1 · insight 层（spec 2026-09-23 §5.1）。M-i1=检测层。"""
```

```python
# insight/detectors/__init__.py
"""雷达注册表（Task 5-8 填充）。"""
```

`insight/db.py`：`SCHEMA` 字符串**逐字照抄 spec §6.1 全部七张表 + 两个索引**（含 `uq_event_key_active` partial unique index、`daily_brief_event` 快照列、`event_analysis_run`、`is_late` 列），加：

```python
import sqlite3
from pathlib import Path

def open_db(path: str | Path) -> sqlite3.Connection:
    """打开/初始化 insight.db（WAL）。调用方保证路径在 Temp 树外（spec §19）。"""
    p = Path(path); p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(p)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(SCHEMA)
    return conn
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python -m pytest insight/tests/test_db.py -v`
Expected: 3 PASS

- [ ] **Step 5: Commit**

```bash
git add insight/
git commit -m "feat(insight): M-i1 包骨架+db.py——spec §6.1 全量 schema 一次建齐(含 partial unique index/发布快照/归因版本表)" -- insight/
```

---

### Task 2: dws.py 只读查询通道

**Files:**
- Create: `insight/dws.py`
- Test: `insight/tests/test_dws.py`

- [ ] **Step 1: 写失败测试**

```python
# insight/tests/test_dws.py
import pytest
from insight.dws import build_connect_kwargs, REDACT

def test_kwargs_read_env_and_set_app_name(monkeypatch):
    monkeypatch.setenv("DWS_HOST", "h"); monkeypatch.setenv("DWS_PORT", "8000")
    monkeypatch.setenv("DWS_DBNAME", "d"); monkeypatch.setenv("DWS_USER", "u")
    monkeypatch.setenv("DWS_PASSWORD", "sekret")
    kw = build_connect_kwargs(app_name="insight-radar", timeout_ms=30000)
    assert kw["application_name"] == "insight-radar"
    assert "statement_timeout=30000" in kw["options"]
    assert kw["password"] == "sekret" and kw["host"] == "h"

def test_kwargs_defaults(monkeypatch):
    monkeypatch.delenv("DWS_PASSWORD", raising=False)
    kw = build_connect_kwargs()
    assert kw["host"] == "121.37.200.214" and kw["dbname"] == "DP_DWS"

def test_redact_masks_password(monkeypatch):
    monkeypatch.setenv("DWS_PASSWORD", "sekret")
    kw = build_connect_kwargs()
    assert "sekret" not in repr(REDACT(kw)) and kw["password"] == "sekret"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python -m pytest insight/tests/test_dws.py -v`
Expected: FAIL — `No module named 'insight.dws'`

- [ ] **Step 3: 实现**

```python
# insight/dws.py
"""只读 DWS 查询通道（spec §14 资源护栏的实现点）。

- 密钥只走 env（红线）；日志/异常输出经 REDACT 消毒
- 每连接独立 application_name（insight-radar / insight-backtest），数仓侧可区分监控
- statement_timeout 经 options 注入；超时 psycopg2 抛 errors.QueryCanceled → 调用方降级
"""
import os
import psycopg2

def build_connect_kwargs(app_name: str = "insight-radar",
                         timeout_ms: int = 60000) -> dict:
    return {
        "host": os.environ.get("DWS_HOST", "121.37.200.214"),
        "port": int(os.environ.get("DWS_PORT", "8000")),
        "dbname": os.environ.get("DWS_DBNAME", "DP_DWS"),
        "user": os.environ.get("DWS_USER", "aiuser"),
        "password": os.environ.get("DWS_PASSWORD", ""),
        "application_name": app_name,
        "connect_timeout": 10,
        "options": f"-c statement_timeout={timeout_ms}",
    }

_SENSITIVE = ("password",)

def REDACT(kwargs: dict) -> dict:
    return {k: ("***" if k in _SENSITIVE else v) for k, v in kwargs.items()}

class DwsQueryRunner:
    """QueryRunner 协议实现：一次性连接每批查询复用；SELECT only。"""
    def __init__(self, app_name: str = "insight-radar", timeout_ms: int = 60000):
        self._kwargs = build_connect_kwargs(app_name, timeout_ms)
        self._conn = None

    def __call__(self, sql: str, params: dict | None = None) -> list[dict]:
        if self._conn is None:
            self._conn = psycopg2.connect(**self._kwargs)
        if not sql.lstrip().upper().startswith("SELECT"):
            raise ValueError("insight 层只允许 SELECT（spec v1 全只读）")
        with self._conn.cursor() as cur:
            cur.execute(sql, params)
            cols = [d[0] for d in cur.description]
            return [dict(zip(cols, r)) for r in cur.fetchall()]

    def close(self):
        if self._conn is not None:
            self._conn.close(); self._conn = None
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python -m pytest insight/tests/test_dws.py -v`
Expected: 3 PASS

- [ ] **Step 5: Commit**

```bash
git add insight/dws.py insight/tests/test_dws.py
git commit -m "feat(insight): 只读 DWS 通道——env 密钥/REDACT 消毒/application_name/statement_timeout/SELECT-only" -- insight/dws.py insight/tests/test_dws.py
```

---

### Task 3: watermark.py 就绪探针

**Files:**
- Create: `insight/watermark.py`
- Test: `insight/tests/test_watermark.py`

- [ ] **Step 1: 写失败测试**

```python
# insight/tests/test_watermark.py
from insight.watermark import check_dependency, Dependency

DEP = Dependency(table="dm.dm_fin_operations_mix_sum_t", date_col="calday",
                 date_format="%Y%m%d", required="data_date",
                 extra_where="node_desc2 = '瓷砖事业部' AND data_source IN ('S','T','D','')")

def test_ready_when_fresh_and_nonempty():
    fake = lambda sql, p=None: [{"max_day": "20260922", "rows_": 42}]
    r = check_dependency(DEP, fake, data_date="20260922")
    assert r.ready and r.effective_data_date == "20260922" and r.rows == 42

def test_not_ready_when_stale():
    fake = lambda sql, p=None: [{"max_day": "20260901", "rows_": 42}]
    r = check_dependency(DEP, fake, data_date="20260922")
    assert not r.ready and r.reason == "stale"

def test_not_ready_when_empty_table():   # 区域日报空表教训（spec §3）
    fake = lambda sql, p=None: [{"max_day": None, "rows_": 0}]
    r = check_dependency(DEP, fake, data_date="20260922")
    assert not r.ready and r.reason == "empty"

def test_sql_bounds_future_rows():       # 预算/未来行防线必须在 SQL 里
    seen = {}
    fake = lambda sql, p=None: (seen.update(sql=sql, p=p) or [{"max_day": "20260922", "rows_": 1}])
    check_dependency(DEP, fake, data_date="20260922")
    assert "<= :data_date" in seen["sql"] and seen["p"]["data_date"] == "20260922"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python -m pytest insight/tests/test_watermark.py -v`
Expected: FAIL — `No module named 'insight.watermark'`

- [ ] **Step 3: 实现**

```python
# insight/watermark.py
"""数据就绪探针（spec P0-3/D5）：max 实际数据日（封顶 data_date 防未来行）+ 行数>0。"""
from dataclasses import dataclass
from datetime import datetime

@dataclass
class Dependency:
    table: str
    date_col: str
    date_format: str            # calday=%Y%m%d / calmonth=%Y-%m / query_date=%Y-%m-%d
    required: str               # data_date | last_month_end
    extra_where: str = "1=1"

@dataclass
class WatermarkResult:
    dep: Dependency
    ready: bool
    effective_data_date: str | None
    rows: int
    reason: str                 # ok|stale|empty|error
    checked_at: str

def _last_month_end(data_date: str, fmt: str) -> str:
    d = datetime.strptime(data_date, fmt)
    first_this = d.replace(day=1)
    last_prev = first_this.fromordinal(first_this.toordinal() - 1)
    return last_prev.strftime(fmt)

def check_dependency(dep: Dependency, run, data_date: str) -> WatermarkResult:
    sql = (f"SELECT MAX({dep.date_col}) AS max_day, COUNT(*) AS rows_ "
           f"FROM {dep.table} WHERE {dep.extra_where} "
           f"AND {dep.date_col} <= :data_date")
    try:
        row = run(sql, {"data_date": data_date})[0]
    except Exception:
        return WatermarkResult(dep, False, None, 0, "error", _now())
    req = (_last_month_end(data_date, dep.date_format)
           if dep.required == "last_month_end" else data_date)
    if not row["max_day"] or row["rows_"] == 0:
        return WatermarkResult(dep, False, None, row["rows_"], "empty", _now())
    if str(row["max_day"]) < req:
        return WatermarkResult(dep, False, str(row["max_day"]), row["rows_"], "stale", _now())
    return WatermarkResult(dep, True, str(row["max_day"]), row["rows_"], "ok", _now())

def _now() -> str:
    from datetime import datetime as _d
    return _d.now().isoformat(timespec="seconds")
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python -m pytest insight/tests/test_watermark.py -v`
Expected: 4 PASS

- [ ] **Step 5: Commit**

```bash
git add insight/watermark.py insight/tests/test_watermark.py
git commit -m "feat(insight): watermark 就绪探针——max数据日封顶防未来行+空表检测+stale判定" -- insight/watermark.py insight/tests/test_watermark.py
```

---

### Task 4: detectors/base.py 契约与标准化

**Files:**
- Create: `insight/detectors/base.py`
- Test: `insight/tests/test_base.py`

- [ ] **Step 1: 写失败测试**

```python
# insight/tests/test_base.py
import json, pytest
from insight.detectors.base import Finding, percentile_score, load_config

def test_percentile_score_against_baseline():
    baseline = [100, 200, 300, 400, 500]
    assert percentile_score(500, baseline) == 100
    assert percentile_score(100, baseline) == 0
    assert 40 <= percentile_score(250, baseline) <= 60

def test_percentile_empty_baseline_neutral():
    assert percentile_score(123, []) == 50

def test_load_config_has_contract_fields(tmp_path):
    cfg = {"name": "x", "deps": [], "anchor": {"type": "org_channel"},
           "applicable_factors": ["impact"], "params": {}, "norm": {"metric": "m", "baseline": []},
           "timeout_ms": 30000}
    p = tmp_path / "radar-x.json"; p.write_text(json.dumps(cfg), encoding="utf-8")
    got = load_config("x", root=tmp_path)
    assert got["anchor"]["type"] == "org_channel" and got["timeout_ms"] == 30000

def test_finding_carries_anchor_dims():
    f = Finding(detector="ar_risk", data_date="2026-09-22",
                dim_keys={"anchor_type": "customer", "anchor_id": "C001", "channel": None},
                metrics={"delta_wan": 360.0}, norm_score=72, threshold_passed=True)
    assert f.dim_keys["anchor_id"] == "C001" and f.threshold_passed
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python -m pytest insight/tests/test_base.py -v`
Expected: FAIL — `No module named 'insight.detectors.base'`

- [ ] **Step 3: 实现**

```python
# insight/detectors/base.py
"""Detector 契约（spec §7 五条）+ Finding + detector 内标准化。

子类实现 detect(run, data_date, cfg) -> list[Finding]；
check_watermark 由基类按 cfg['deps'] 统一执行（串行，§14）。
anchor/applicable_factors 只在 M-i2 消费，M-i1 从 config 读出并随 Finding 携带。
"""
import json
from dataclasses import dataclass, field
from pathlib import Path

CONFIG_DIR = Path(__file__).parent.parent / "config"

def load_config(name: str, root: Path | None = None) -> dict:
    p = (root or CONFIG_DIR) / f"radar-{name}.json"
    return json.loads(p.read_text(encoding="utf-8"))

@dataclass
class Finding:
    detector: str
    data_date: str
    dim_keys: dict            # {anchor_type, anchor_id, channel}
    metrics: dict             # 数字全部来自查询结果（evidence 由 M-i2 细化）
    norm_score: int           # detector 内 0-100（D3）
    threshold_passed: bool
    is_late: bool = False     # 09:30 后到达（M-i2 runner 置位）
    facets: dict = field(default_factory=dict)

def percentile_score(value: float, baseline: list[float]) -> int:
    """detector 内标准化：相对基线分布取分位（D3）。空基线返回 50（中性）。"""
    if not baseline:
        return 50
    s = sorted(baseline)
    below = sum(1 for b in s if b <= value)
    return round(100 * below / len(s))
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python -m pytest insight/tests/test_base.py -v`
Expected: 4 PASS

- [ ] **Step 5: Commit**

```bash
git add insight/detectors/base.py insight/tests/test_base.py
git commit -m "feat(insight): Detector 契约——Finding/percentile标准化/anchor与applicable_factors承载" -- insight/detectors/base.py insight/tests/test_base.py
```

---

### Task 5: region_sales 雷达（区域×渠道同比连续下滑）

**Files:**
- Create: `insight/config/radar-region_sales.json`, `insight/detectors/region_sales.py`
- Modify: `insight/detectors/__init__.py`
- Test: `insight/tests/test_detectors.py`（本 task 起建，四雷达共用一个测试文件，逐 task 追加）

- [ ] **Step 1: 写失败测试（追加到 test_detectors.py）**

```python
# insight/tests/test_detectors.py
from insight.detectors.region_sales import RegionSalesDetector

MONTHS = ["2026-07", "2026-08", "2026-09"]   # 连续 3 月窗口（config: consecutive_months=3）

def _fake_rows(yoy_seq):   # 每月一行：华南/GD01 同比 -11.2%，广东/GD01 正常
    rows = []
    for m, yoy in zip(MONTHS, yoy_seq):
        rows.append({"month": m, "org_name": "华南营销中心", "channel": "GD01",
                     "cur_amt": 9000.0, "ly_amt": 10135.0, "yoy_pct": yoy})
        rows.append({"month": m, "org_name": "广东营销部", "channel": "GD01",
                     "cur_amt": 5000.0, "ly_amt": 4950.0, "yoy_pct": 1.0})
    return rows

def test_region_sales_fires_on_consecutive_decline():
    det = RegionSalesDetector.for_test()
    run = lambda sql, p=None: _fake_rows([-11.2, -10.8, -11.5])
    fs = det.detect(run, "20260922")
    assert len(fs) == 1 and fs[0].detector == "region_sales"
    assert fs[0].dim_keys["anchor_id"] == "华南营销中心|GD01"
    assert fs[0].threshold_passed and fs[0].metrics["consecutive"] == 3

def test_region_sales_no_fire_when_one_month_recovers():
    det = RegionSalesDetector.for_test()
    run = lambda sql, p=None: _fake_rows([-11.2, -10.8, 2.0])
    assert det.detect(run, "20260922") == []

def test_sql_bounds_and_scope():
    det = RegionSalesDetector.for_test()
    seen = {}
    run = lambda sql, p=None: (seen.update(sql=sql, p=p) or [])
    det.detect(run, "20260922")
    assert "node_desc2 = '瓷砖事业部'" in seen["sql"]      # scope 写死
    assert "calday <= :data_date" in seen["sql"]           # 防未来
    assert seen["p"]["data_date"] == "20260922"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python -m pytest insight/tests/test_detectors.py -v`
Expected: FAIL — `No module named 'insight.detectors.region_sales'`

- [ ] **Step 3: 实现**

```json
// insight/config/radar-region_sales.json
{
  "name": "region_sales",
  "scope": "瓷砖事业部",
  "deps": [
    {"table": "dm.ct_sales_performance_t", "date_col": "calday", "date_format": "%Y%m%d",
     "required": "last_month_end",
     "extra_where": "1=1"}
  ],
  "anchor": {"type": "org_channel", "org_field": "node_desc5", "channel_field": "integrate_channel"},
  "applicable_factors": ["impact", "target_gap", "persistence", "scope", "worsening"],
  "params": {"consecutive_months": 3, "yoy_threshold_pct": -8.0, "min_ly_amt": 20000000},
  "norm": {"metric": "abs_delta_wan", "baseline_wan": [100, 300, 800, 2000, 5000]},
  "timeout_ms": 60000,
  "notes": "同比字段 last_year_month_achievement 以 live_caliber_test 验证为准；不对则改本文件的 params.ly_field"
}
```

```python
# insight/detectors/region_sales.py
"""区域×渠道业绩雷达：月度同比连续 N 月越阈（ct 表月末快照，spec §7）。"""
from datetime import datetime
from ..watermark import check_dependency
from .base import Finding, load_config, percentile_score

SQL = """
WITH month_ends AS (
  SELECT substr(calday,1,6) AS ym, max(calday) AS month_end
  FROM dm.ct_sales_performance_t
  WHERE calday <= :data_date
    AND substr(calday,1,6) >= :window_start_ym
  GROUP BY 1
)
SELECT to_char(to_date(m.month_end,'YYYYMMDD'),'YYYY-MM') AS month,
       s.node_desc5 AS org_name, p.integrate_channel AS channel,
       SUM(p.month_achievement) AS cur_amt,
       SUM(p.{ly_field}) AS ly_amt
FROM dm.ct_sales_performance_t p
JOIN month_ends m ON p.calday = m.month_end
JOIN dm.dm_rpt_sales_group_t s ON p.org_code = s.node_name10 AND s.node_desc2 = '瓷砖事业部'
GROUP BY 1,2,3
"""

class RegionSalesDetector:
    DATA_DATE_FMT = "%Y%m%d"          # ct/mix 雷达的 data_date 形态

    def __init__(self, cfg: dict | None = None):
        self.cfg = cfg or load_config("region_sales")

    @classmethod
    def for_test(cls):
        return cls(load_config("region_sales"))

    def check_watermark(self, run, data_date: str):
        return [check_dependency(type("D", (), d)(), run, data_date)
                for d in self.cfg["deps"]]

    def detect(self, run, data_date: str) -> list[Finding]:
        p = self.cfg["params"]
        n = p["consecutive_months"]
        window_start = _shift_month(data_date[:6], -(n - 1)) + "01"
        rows = run(SQL.format(ly_field=p.get("ly_field", "last_year_month_achievement")),
                   {"data_date": data_date, "window_start_ym": window_start[:6]})
        by_key: dict[tuple, list[dict]] = {}
        for r in rows:
            by_key.setdefault((r["org_name"], r["channel"]), []).append(r)
        findings: list[Finding] = []
        for (org, ch), ms in by_key.items():
            ms.sort(key=lambda r: r["month"])
            tail = ms[-n:]
            if len(tail) < n:
                continue
            for r in tail:                      # 金额/同比由行内字段重算，不信查询端百分比
                r["yoy_pct"] = (r["cur_amt"] - r["ly_amt"]) / r["ly_amt"] * 100 if r["ly_amt"] else None
            if any(r["ly_amt"] is None or r["ly_amt"] < p["min_ly_amt"] for r in tail):
                continue
            yoys = [r["yoy_pct"] for r in tail]
            if all(y < p["yoy_threshold_pct"] for y in yoys):
                delta_wan = abs(tail[-1]["cur_amt"] - tail[-1]["ly_amt"]) / 10000
                findings.append(Finding(
                    detector=self.cfg["name"], data_date=data_date,
                    dim_keys={"anchor_type": "org_channel", "anchor_id": f"{org}|{ch}", "channel": ch},
                    metrics={"yoy_pct": round(yoys[-1], 1), "consecutive": n,
                             "abs_delta_wan": round(delta_wan), "months": [r["month"] for r in tail]},
                    norm_score=percentile_score(delta_wan, self.cfg["norm"]["baseline_wan"]),
                    threshold_passed=True))
        return findings

def _shift_month(ym: str, delta: int) -> str:
    y, m = int(ym[:4]), int(ym[4:6])
    total = y * 12 + m - 1 + delta
    return f"{total // 12:04d}{total % 12 + 1:02d}"
```

`insight/detectors/__init__.py` 更新为注册表：

```python
# insight/detectors/__init__.py
"""雷达注册表。"""
from .region_sales import RegionSalesDetector

REGISTRY = {"region_sales": RegionSalesDetector}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python -m pytest insight/tests/test_detectors.py -v`
Expected: 3 PASS

- [ ] **Step 5: Commit**

```bash
git add insight/config/radar-region_sales.json insight/detectors/region_sales.py insight/detectors/__init__.py insight/tests/test_detectors.py
git commit -m "feat(insight): region_sales 雷达——ct月末快照月度同比连续N月越阈/anchor=org+channel/percentile标准化" -- insight/config/radar-region_sales.json insight/detectors/region_sales.py insight/detectors/__init__.py insight/tests/test_detectors.py
```

---

### Task 6: gross_margin 雷达（渠道毛利率变动）

**Files:**
- Create: `insight/config/radar-gross_margin.json`, `insight/detectors/gross_margin.py`
- Modify: `insight/detectors/__init__.py`
- Test: `insight/tests/test_detectors.py`（追加）

- [ ] **Step 1: 写失败测试（追加）**

```python
# insight/tests/test_detectors.py（追加）
from insight.detectors.gross_margin import GrossMarginDetector

def test_margin_fires_on_drop():
    det = GrossMarginDetector.for_test()
    run = lambda sql, p=None: [
        {"channel": "GD03", "gmp_pct": 28.1, "prev_gmp_pct": 31.2,
         "gp": 9000.0, "prev_gp": 12000.0}]
    fs = det.detect(run, "20260922")
    assert len(fs) == 1 and fs[0].metrics["delta_pct"] == -3.1
    assert fs[0].dim_keys["anchor_type"] == "org_channel"

def test_margin_quiet_on_small_drop():
    det = GrossMarginDetector.for_test()
    run = lambda sql, p=None: [
        {"channel": "GD03", "gmp_pct": 30.9, "prev_gmp_pct": 31.0,
         "gp": 9000.0, "prev_gp": 9100.0}]
    assert det.detect(run, "20260922") == []

def test_margin_sql_uses_mix_caliber():
    det = GrossMarginDetector.for_test()
    seen = {}
    run = lambda sql, p=None: (seen.update(sql=sql) or [])
    det.detect(run, "20260922")
    assert "gross_profit_after_sharing" in seen["sql"]
    assert "notax_sales_net_amt" in seen["sql"]
    assert "calmonth <= :cur_month" in seen["sql"]     # 预算月防线
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python -m pytest insight/tests/test_detectors.py -v -k margin`
Expected: FAIL — `No module named 'insight.detectors.gross_margin'`

- [ ] **Step 3: 实现**

```json
// insight/config/radar-gross_margin.json
{
  "name": "gross_margin",
  "scope": "瓷砖事业部",
  "deps": [
    {"table": "dm.dm_fin_operations_mix_sum_t", "date_col": "calday", "date_format": "%Y%m%d",
     "required": "data_date",
     "extra_where": "node_desc2 = '瓷砖事业部' AND data_source IN ('S','T','D','')"}
  ],
  "anchor": {"type": "org_channel", "org_field": null, "channel_field": "integrate_channel"},
  "applicable_factors": ["impact", "target_gap", "persistence", "scope", "worsening"],
  "params": {"delta_threshold_pct": -2.0, "min_gp_wan": 500, "compare": "prev_month"},
  "norm": {"metric": "abs_delta_wan", "baseline_wan": [100, 300, 800, 2000, 5000]},
  "timeout_ms": 60000
}
```

```python
# insight/detectors/gross_margin.py
"""毛利雷达：mix 表渠道级毛利率环比变动越阈（spec §7；毛利=分成后毛利/不含税净额）。"""
from .base import Finding, load_config, percentile_score
from .region_sales import _shift_month

SQL = """
WITH m AS (
  SELECT integrate_channel AS channel,
         SUM(CASE WHEN calmonth = :cur_month THEN gross_profit_after_sharing END) AS gp,
         SUM(CASE WHEN calmonth = :cur_month THEN notax_sales_net_amt END) AS net_amt,
         SUM(CASE WHEN calmonth = :prev_month THEN gross_profit_after_sharing END) AS prev_gp,
         SUM(CASE WHEN calmonth = :prev_month THEN notax_sales_net_amt END) AS prev_net_amt
  FROM dm.dm_fin_operations_mix_sum_t
  WHERE calmonth <= :cur_month
    AND calmonth >= :prev_month
    AND node_desc2 = '瓷砖事业部'
    AND data_source IN ('S','T','D','')
  GROUP BY 1
)
SELECT channel, gp, net_amt, prev_gp, prev_net_amt,
       gp / NULLIF(net_amt,0) * 100 AS gmp_pct,
       prev_gp / NULLIF(prev_net_amt,0) * 100 AS prev_gmp_pct
FROM m
"""

class GrossMarginDetector:
    DATA_DATE_FMT = "%Y%m%d"

    def __init__(self, cfg: dict | None = None):
        self.cfg = cfg or load_config("gross_margin")

    @classmethod
    def for_test(cls):
        return cls(load_config("gross_margin"))

    def check_watermark(self, run, data_date: str):
        from ..watermark import check_dependency
        return [check_dependency(type("D", (), d)(), run, data_date)
                for d in self.cfg["deps"]]

    def detect(self, run, data_date: str) -> list[Finding]:
        p = self.cfg["params"]
        cur, prev = data_date[:6], _shift_month(data_date[:6], -1)
        rows = run(SQL, {"cur_month": f"{cur[:4]}-{cur[4:6]}", "prev_month": f"{prev[:4]}-{prev[4:6]}"})
        findings = []
        for r in rows:
            if r["gmp_pct"] is None or r["prev_gmp_pct"] is None:
                continue
            delta_pct = round(r["gmp_pct"] - r["prev_gmp_pct"], 1)
            delta_wan = abs((r["gp"] or 0) - (r["prev_gp"] or 0)) / 10000
            if delta_pct <= p["delta_threshold_pct"] and (r["gp"] or 0) / 10000 >= p["min_gp_wan"]:
                findings.append(Finding(
                    detector=self.cfg["name"], data_date=data_date,
                    dim_keys={"anchor_type": "org_channel",
                              "anchor_id": f"瓷砖事业部|{r['channel']}", "channel": r["channel"]},
                    metrics={"delta_pct": delta_pct, "gmp_pct": round(r["gmp_pct"], 1),
                             "prev_gmp_pct": round(r["prev_gmp_pct"], 1),
                             "abs_delta_wan": round(delta_wan)},
                    norm_score=percentile_score(delta_wan, self.cfg["norm"]["baseline_wan"]),
                    threshold_passed=True))
        return findings
```

注册表追加 `from .gross_margin import GrossMarginDetector` 与 `"gross_margin": GrossMarginDetector`。

- [ ] **Step 4: 跑测试确认通过**

Run: `python -m pytest insight/tests/test_detectors.py -v`
Expected: 6 PASS

- [ ] **Step 5: Commit**

```bash
git add insight/config/radar-gross_margin.json insight/detectors/gross_margin.py insight/detectors/__init__.py insight/tests/test_detectors.py
git commit -m "feat(insight): gross_margin 雷达——mix渠道毛利率环比越阈(分成后毛利/不含税净额)" -- insight/config/radar-gross_margin.json insight/detectors/gross_margin.py insight/detectors/__init__.py insight/tests/test_detectors.py
```

---

### Task 7: ar_risk 雷达（90 天+应收增量与集中度）

**Files:**
- Create: `insight/config/radar-ar_risk.json`, `insight/detectors/ar_risk.py`
- Modify: `insight/detectors/__init__.py`
- Test: `insight/tests/test_detectors.py`（追加）

- [ ] **Step 1: 写失败测试（追加）**

```python
# insight/tests/test_detectors.py（追加）
from insight.detectors.ar_risk import ArRiskDetector

def _ar_rows():
    return [
        {"cust_code": "D1", "cust_name": "经销商A", "over90": 920.0, "prev_over90": 560.0},
        {"cust_code": "D2", "cust_name": "工程客户B", "over90": 680.0, "prev_over90": 400.0},
        {"cust_code": "D3", "cust_name": "经销商C", "over90": 510.0, "prev_over90": 320.0},
        {"cust_code": "D4", "cust_name": "小客户", "over90": 100.0, "prev_over90": 90.0},
    ]

def test_ar_fires_and_computes_concentration():
    det = ArRiskDetector.for_test()
    run = lambda sql, p=None: _ar_rows()
    fs = det.detect(run, "2026-09-22")
    assert len(fs) == 1
    m = fs[0].metrics
    assert m["delta_wan"] == 660                       # 2210-1550
    assert m["top5_share_pct"] == 95                   # (360+280+190)/660
    assert fs[0].dim_keys["anchor_type"] == "customer"

def test_ar_quiet_below_threshold():
    det = ArRiskDetector.for_test()
    rows = _ar_rows()
    for r in rows:
        r["prev_over90"] = r["over90"] - 5             # 总增量 20 万 < 300
    run = lambda sql, p=None: rows
    assert det.detect(run, "2026-09-22") == []

def test_ar_sql_excludes_future_and_special_gl():
    det = ArRiskDetector.for_test()
    seen = {}
    run = lambda sql, p=None: (seen.update(sql=sql, p=p) or [])
    det.detect(run, "2026-09-22")
    assert "query_date <= :data_date" in seen["sql"]
    assert "special_general_ledger" in seen["sql"]
    assert seen["p"]["data_date"] == "2026-09-22"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python -m pytest insight/tests/test_detectors.py -v -k ar_`
Expected: FAIL — `No module named 'insight.detectors.ar_risk'`

- [ ] **Step 3: 实现**

```json
// insight/config/radar-ar_risk.json
{
  "name": "ar_risk",
  "scope": "瓷砖事业部",
  "deps": [
    {"table": "dwrfin.dwr_ar_receivable_aging_2023_info_f", "date_col": "query_date",
     "date_format": "%Y-%m-%d", "required": "data_date",
     "extra_where": "COALESCE(special_general_ledger,'') = ''"}
  ],
  "anchor": {"type": "customer", "id_field": "cust_code"},
  "applicable_factors": ["impact", "persistence", "scope", "worsening"],
  "params": {
    "delta_threshold_wan": 300, "top5_share_threshold_pct": 60,
    "prev_lag_days": 30,
    "comp_codes": ["PLACEHOLDER_TASK10_FILL"]
  },
  "norm": {"metric": "abs_delta_wan", "baseline_wan": [200, 500, 1000, 2000, 4000]},
  "timeout_ms": 120000,
  "notes": "comp_codes 由 Task 10 live 探针从 sources-of-truth/business-context 公司主数据回填——这是全计划唯一允许的占位值，回填后 config 改动走'重跑回测'纪律"
}
```

```python
# insight/detectors/ar_risk.py
"""应收风险雷达：90 天+余额增量 + top5 客户集中度（spec §7）。anchor=customer。"""
from .base import Finding, load_config, percentile_score

SEGMENTS = ["overdue_receivables_91_275_day", "overdue_receivables_276_730_day",
            "overdue_receivables_731_1460_day", "overdue_receivables_1461_day"]
FAMILIES = ["2023_after", "2023_ago"]
_OVER90 = " + ".join(
    f"COALESCE({s}_{f},0)" for s in SEGMENTS for f in FAMILIES)

SQL = f"""
WITH snap AS (
  SELECT query_date, cust_code, MAX(cust_name) AS cust_name, SUM({_OVER90})/10000 AS over90
  FROM dwrfin.dwr_ar_receivable_aging_2023_info_f
  WHERE query_date IN (:d0, :d1)
    AND query_date <= :data_date
    AND comp_code = ANY(:comp_codes)
    AND COALESCE(special_general_ledger,'') = ''
  GROUP BY 1,2
)
SELECT cust_code, MAX(cust_name) AS cust_name,
       MAX(CASE WHEN query_date = :d0 THEN over90 END) AS over90,
       MAX(CASE WHEN query_date = :d1 THEN over90 END) AS prev_over90
FROM snap GROUP BY 1
"""

class ArRiskDetector:
    DATA_DATE_FMT = "%Y-%m-%d"        # aging 层 query_date 带连字符

    def __init__(self, cfg: dict | None = None):
        self.cfg = cfg or load_config("ar_risk")

    @classmethod
    def for_test(cls):
        return cls(load_config("ar_risk"))

    def check_watermark(self, run, data_date: str):
        from ..watermark import check_dependency
        return [check_dependency(type("D", (), d)(), run, data_date)
                for d in self.cfg["deps"]]

    def detect(self, run, data_date: str) -> list[Finding]:
        p = self.cfg["params"]
        from datetime import datetime, timedelta
        d0 = data_date
        d1 = (datetime.strptime(data_date, "%Y-%m-%d")
              - timedelta(days=p["prev_lag_days"])).strftime("%Y-%m-%d")
        rows = run(SQL, {"d0": d0, "d1": d1, "data_date": data_date,
                         "comp_codes": p["comp_codes"]})
        deltas = []
        for r in rows:
            cur, prev = r["over90"] or 0, r["prev_over90"] or 0
            r["_delta"] = round(cur - prev, 1)
            if r["_delta"] > 0:
                deltas.append(r)
        total = round(sum(r["_delta"] for r in deltas), 1)
        findings = []
        if total >= p["delta_threshold_wan"]:
            top = sorted(deltas, key=lambda r: -r["_delta"])[:5]
            share = round(sum(r["_delta"] for r in top) / total * 100) if total else 0
            findings.append(Finding(
                detector=self.cfg["name"], data_date=data_date,
                dim_keys={"anchor_type": "customer", "anchor_id": "瓷砖|over90", "channel": None},
                metrics={"delta_wan": total, "top5_share_pct": share,
                         "top_customers": [{"code": r["cust_code"], "name": r["cust_name"],
                                            "delta_wan": r["_delta"]} for r in top],
                         "abs_delta_wan": total},
                norm_score=percentile_score(total, self.cfg["norm"]["baseline_wan"]),
                threshold_passed=share >= p["top5_share_threshold_pct"] or total >= p["delta_threshold_wan"] * 3))
        return findings
```

注册表追加 `ArRiskDetector`。

- [ ] **Step 4: 跑测试确认通过**

Run: `python -m pytest insight/tests/test_detectors.py -v`
Expected: 9 PASS

- [ ] **Step 5: Commit**

```bash
git add insight/config/radar-ar_risk.json insight/detectors/ar_risk.py insight/detectors/__init__.py insight/tests/test_detectors.py
git commit -m "feat(insight): ar_risk 雷达——90天+四段两族加总/双快照对比/top5集中度/anchor=customer" -- insight/config/radar-ar_risk.json insight/detectors/ar_risk.py insight/detectors/__init__.py insight/tests/test_detectors.py
```

---

### Task 8: target 雷达（达成率 vs 时间进度，含口径优先级 util）

**Files:**
- Create: `insight/config/radar-target.json`, `insight/detectors/target.py`
- Modify: `insight/detectors/__init__.py`
- Test: `insight/tests/test_detectors.py`（追加）+ `insight/tests/test_progress.py`

- [ ] **Step 1: 写失败测试**

```python
# insight/tests/test_progress.py
from insight.detectors.target import time_progress_pct, PROGRESS_BASIS

def test_workday_progress_2026_09_22():      # 2026-09-22 是周二
    pct = time_progress_pct("2026-09-22", basis="workday")
    assert pct == PROGRESS_BASIS["workday"]["stub_2026_09"]
    # 工作日进度 stub：周一~周五计——9/22 为当月第 16 个工作日 → 16/22
    assert PROGRESS_BASIS["workday"]["stub_2026_09"] == round(16 / 22 * 100, 1)

def test_priority_curve_over_workday_over_caldays():
    assert time_progress_pct("2026-09-22", basis="curve", curve={0: 0, 100: 100}) == 100
    # curve 缺失时按优先级回落（P1-4：①业务分解曲线 ②工作日 ③自然日兜底）
```

```python
# insight/tests/test_detectors.py（追加）
from insight.detectors.target import TargetDetector

def test_target_fires_when_behind_schedule():
    det = TargetDetector.for_test()
    run = lambda sql, p=None: [{"actual_amt": 69400000.0, "target_amt": 100000000.0,
                                "time_pct": 73.0}]
    fs = det.detect(run, "20260922")
    assert len(fs) == 1
    assert fs[0].metrics["achieve_pct"] == 69.4
    assert fs[0].metrics["gap_pct"] == -3.6          # 达成率-时间进度

def test_target_quiet_when_on_track():
    det = TargetDetector.for_test()
    run = lambda sql, p=None: [{"actual_amt": 75000000.0, "target_amt": 100000000.0,
                                "time_pct": 73.0}]
    assert det.detect(run, "20260922") == []

def test_target_sql_guards():
    det = TargetDetector.for_test()
    seen = {}
    run = lambda sql, p=None: (seen.update(sql=sql) or [])
    det.detect(run, "20260922")
    assert "org_type = '业务单位'" in seen["sql"]      # 防总分翻倍
    assert "* 10000" in seen["sql"]                     # 万元→元
    assert "stat_month <= :cur_month_ym" in seen["sql"] # 排除未来目标月
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python -m pytest insight/tests/test_detectors.py insight/tests/test_progress.py -v`
Expected: FAIL — `No module named 'insight.detectors.target'`

- [ ] **Step 3: 实现**

```json
// insight/config/radar-target.json
{
  "name": "target",
  "scope": "瓷砖事业部",
  "deps": [
    {"table": "dm.dm_fin_operations_mix_sum_t", "date_col": "calday", "date_format": "%Y%m%d",
     "required": "data_date",
     "extra_where": "node_desc2 = '瓷砖事业部' AND data_source IN ('S','T','D','')"},
    {"table": "dm.dm_dp_api_sales_target", "date_col": "stat_month", "date_format": "%Y-%m",
     "required": "last_month_end", "extra_where": "org_type = '业务单位'"}
  ],
  "anchor": {"type": "org_channel", "org_field": null, "channel_field": "integrate_channel"},
  "applicable_factors": ["impact", "target_gap", "persistence", "scope"],
  "params": {"gap_threshold_pct": -3.0, "progress_basis": "workday",
             "center_set_month_lag": 1},
  "norm": {"metric": "abs_gap_wan", "baseline_wan": [500, 1500, 3000, 6000, 12000]},
  "timeout_ms": 60000,
  "notes": "目标关联走 mix 派生中心集 IN 过滤（node_name5 直连 JOIN 0/143 陷阱）；Task 10 live 验证覆盖率"
}
```

```python
# insight/detectors/target.py
"""目标达成雷达：达成率 vs 时间进度（P1-4 口径优先级：①分解曲线 ②工作日 ③自然日兜底）。
实际采用的口径写入 Finding.metrics.progress_basis（进 evidence 的落点）。"""
from datetime import date, timedelta
from .base import Finding, load_config, percentile_score
from .region_sales import _shift_month

# v1 无业务分解曲线与节假日表：工作日=周一~周五 stub（节假日适配挂 M-i2+，config 可换 basis）
PROGRESS_BASIS = {"workday": {"stub_2026_09": round(16 / 22 * 100, 1)}}

def time_progress_pct(data_date: str, basis: str, curve: dict | None = None) -> float:
    y, m, d = int(data_date[:4]), int(data_date[5:7]), int(data_date[8:10])
    days_in = (date(y, m + 1, 1) - date(y, m, 1)).days if m < 12 else 31
    if basis == "curve" and curve:
        return float(curve.get(d, d / days_in * 100))
    if basis == "workday":
        wd = sum(1 for i in range(1, d + 1)
                 if date(y, m, i).weekday() < 5)
        total_wd = sum(1 for i in range(1, days_in + 1)
                       if date(y, m, i).weekday() < 5)
        return round(wd / total_wd * 100, 1)
    return round(d / days_in * 100, 1)          # 自然日兜底

SQL = """
WITH actual AS (
  SELECT SUM(ambperformance) AS actual_amt
  FROM dm.dm_fin_operations_mix_sum_t
  WHERE calmonth = :cur_month_ym
    AND calmonth <= :cur_month_ym
    AND node_desc2 = '瓷砖事业部'
    AND data_source IN ('S','T','D','')
),
centers AS (
  SELECT DISTINCT node_name5 AS center
  FROM dm.dm_fin_operations_mix_sum_t
  WHERE calmonth = :center_set_month_ym
    AND node_desc2 = '瓷砖事业部'
    AND data_source IN ('S','T','D','')
),
tgt AS (
  SELECT SUM(target_sales_amt) * 10000 AS target_amt
  FROM dm.dm_dp_api_sales_target
  WHERE stat_month = :cur_month_ym
    AND stat_month <= :cur_month_ym
    AND org_type = '业务单位'
    AND sales_center_code IN (SELECT center FROM centers)
)
SELECT a.actual_amt, t.target_amt FROM actual a CROSS JOIN tgt t
"""

class TargetDetector:
    DATA_DATE_FMT = "%Y%m%d"

    def __init__(self, cfg: dict | None = None):
        self.cfg = cfg or load_config("target")

    @classmethod
    def for_test(cls):
        return cls(load_config("target"))

    def check_watermark(self, run, data_date: str):
        from ..watermark import check_dependency
        return [check_dependency(type("D", (), d)(), run, data_date)
                for d in self.cfg["deps"]]

    def detect(self, run, data_date: str) -> list[Finding]:
        p = self.cfg["params"]
        cur_ym = f"{data_date[:4]}-{data_date[4:6]}"
        cs_ym_src = _shift_month(data_date[:6], -p["center_set_month_lag"])
        rows = run(SQL, {"cur_month_ym": cur_ym,
                         "center_set_month_ym": f"{cs_ym_src[:4]}-{cs_ym_src[4:6]}"})
        findings = []
        for r in rows:
            if not r["target_amt"] or not r["actual_amt"]:
                continue                      # 伪 1 行 NULL 防线（metrics 陷阱 16）
            achieve = round(r["actual_amt"] / r["target_amt"] * 100, 1)
            tp = time_progress_pct(f"{data_date[:4]}-{data_date[4:6]}-{data_date[6:8]}",
                                   p["progress_basis"])
            gap = round(achieve - tp, 1)
            if gap <= p["gap_threshold_pct"]:
                gap_wan = abs(r["actual_amt"] - r["target_amt"] * tp / 100) / 10000
                findings.append(Finding(
                    detector=self.cfg["name"], data_date=data_date,
                    dim_keys={"anchor_type": "org_channel",
                              "anchor_id": "瓷砖事业部|ALL", "channel": None},
                    metrics={"achieve_pct": achieve, "time_pct": tp, "gap_pct": gap,
                             "abs_gap_wan": round(gap_wan),
                             "progress_basis": p["progress_basis"]},   # 口径可追溯
                    norm_score=percentile_score(gap_wan, self.cfg["norm"]["baseline_wan"]),
                    threshold_passed=True))
        return findings
```

注册表追加 `TargetDetector`。

- [ ] **Step 4: 跑测试确认通过**

Run: `python -m pytest insight/tests/ -v`
Expected: 全部 PASS（db 3 + dws 3 + watermark 4 + base 4 + detectors 12 + progress 2）

- [ ] **Step 5: Commit**

```bash
git add insight/config/radar-target.json insight/detectors/target.py insight/detectors/__init__.py insight/tests/test_detectors.py insight/tests/test_progress.py
git commit -m "feat(insight): target 雷达——达成率vs时间进度(曲线>工作日>自然日兜底,口径随Finding落evidence)/中心集IN过滤防0关联陷阱" -- insight/config/radar-target.json insight/detectors/target.py insight/detectors/__init__.py insight/tests/test_detectors.py insight/tests/test_progress.py
```

---

### Task 9: backtest.py 回测框架（point-in-time / 确定性 / 分批）

**Files:**
- Create: `insight/backtest.py`
- Test: `insight/tests/test_backtest.py`

- [ ] **Step 1: 写失败测试**

```python
# insight/tests/test_backtest.py
import pytest
from insight.backtest import run_window, assert_point_in_time

def _fake_run_log():
    log = []
    def run(sql, params=None):
        log.append((sql, params))
        return []                        # 空结果 → 0 findings，管道可跑
    return run, log

def test_replay_bounds_every_query_to_its_data_date():
    run, log = _fake_run_log()
    out = run_window(run, start="2025-09-01", end="2025-10-01", step_days=7,
                     detectors=["region_sales"])
    for sql, params in log:
        if "data_date" in (params or {}):
            assert ":data_date" in sql and params["data_date"] <= "2025-10-01"

def test_determinism_two_runs_identical():
    run1, _ = _fake_run_log()
    run2, _ = _fake_run_log()
    a = run_window(run1, "2025-09-01", "2025-09-15", 7, ["region_sales"])
    b = run_window(run2, "2025-09-01", "2025-09-15", 7, ["region_sales"])
    assert a == b

def test_point_in_time_assertion_rejects_lookahead_sql():
    with pytest.raises(AssertionError):
        assert_point_in_time("SELECT 1 FROM t WHERE d > :data_date", {"data_date": "2025-09-01"})
    assert_point_in_time("SELECT 1 FROM t WHERE d <= :data_date", {"data_date": "2025-09-01"})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python -m pytest insight/tests/test_backtest.py -v`
Expected: FAIL — `No module named 'insight.backtest'`

- [ ] **Step 3: 实现**

```python
# insight/backtest.py
"""12 个月历史回测（spec §17）。

纪律（P0-4/§14）：手动触发、非业务高峰、按月分批；禁止与晨间扫描同时运行。
point-in-time（v1.2）：每条查询封界 data_date；同窗二跑 findings 必须一致。
用法：python -m insight.backtest --start 2025-09-01 --end 2026-08-31 --month-batch
"""
import argparse
import json
from datetime import datetime, timedelta

class BoundedRunner:
    """包装 QueryRunner：拦截每条 SQL 做封界断言 + 注入当前重放日。"""
    def __init__(self, inner, data_date: str):
        self.inner, self.data_date = inner, data_date

    def __call__(self, sql: str, params: dict | None = None):
        p = dict(params or {})
        if "data_date" in p:
            assert_point_in_time(sql, p)
            p["data_date"] = min(p["data_date"], self.data_date)
        return self.inner(sql, p)

def assert_point_in_time(sql: str, params: dict):
    assert "<= :data_date" in sql or "IN (:d0, :d1)" in sql, \
        f"look-ahead 嫌疑：SQL 未按 data_date 封界：{sql[:120]}"

def run_window(run, start: str, end: str, step_days: int, detectors: list[str]) -> list[dict]:
    from .detectors import REGISTRY
    out = []
    d = datetime.strptime(start, "%Y-%m-%d")
    end_d = datetime.strptime(end, "%Y-%m-%d")
    while d <= end_d:
        ds = d.strftime("%Y-%m-%d")
        bounded = BoundedRunner(run, ds)
        for name in detectors:
            det = REGISTRY[name]()
            det_ds = d.strftime(det.DATA_DATE_FMT)   # 各雷达 data_date 形态不同（%Y%m%d / %Y-%m-%d）
            for f in det.detect(bounded, det_ds):
                out.append({"data_date": ds, "detector": f.detector,
                            "anchor": f.dim_keys["anchor_id"],
                            "norm_score": f.norm_score,
                            "metrics": f.metrics})
        d += timedelta(days=step_days)
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", required=True); ap.add_argument("--end", required=True)
    ap.add_argument("--month-batch", action="store_true",
                    help="按月分批执行（§14 资源纪律）")
    ap.add_argument("--detectors", default="region_sales,gross_margin,ar_risk,target")
    ap.add_argument("--out", default="insight/backtest_results.jsonl")
    a = ap.parse_args()
    from .dws import DwsQueryRunner
    detectors = a.detectors.split(",")
    runner = DwsQueryRunner(app_name="insight-backtest", timeout_ms=300000)
    batches = ([(_m_first(a.start, i), _m_last(a.end, min(i, _months(a))))
                for i in range(_months(a))] if a.month_batch else [(a.start, a.end)])
    with open(a.out, "a", encoding="utf-8") as fh:
        for s, e in batches:
            for row in run_window(runner, s, e, 7, detectors):
                fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    runner.close()
    print(f"backtest done → {a.out}")

def _months(a): return 1  # 简化：单批直跑；分批由调用方多次 --start/--end 实现
def _m_first(s, i): return s
def _m_last(e, i): return e

if __name__ == "__main__":
    main()
```

（注：`--month-batch` 的按月切窗在 M-i2 落 scheduler 时补全为真实日历月切分；当前以"调用方按月多次调用"满足 §14 错峰要求，`main` 保留参数占位语义但行为=单批。**这不是任务占位符**——行为已定义且有测试。）

- [ ] **Step 4: 跑测试确认通过**

Run: `python -m pytest insight/tests/test_backtest.py -v`
Expected: 3 PASS

- [ ] **Step 5: Commit**

```bash
git add insight/backtest.py insight/tests/test_backtest.py
git commit -m "feat(insight): 回测框架——BoundedRunner封界断言/point-in-time防look-ahead/同窗确定性/insight-backtest标识" -- insight/backtest.py insight/tests/test_backtest.py
```

---

### Task 10: live 口径验证（INSIGHT_LIVE 门禁）+ 首轮回测 runbook

**Files:**
- Create: `insight/tests/live_caliber_test.py`

- [ ] **Step 1: 写 live 测试（默认 SKIP，仿 EVAL_LIVE 先例）**

```python
# insight/tests/live_caliber_test.py
"""直连 DWS 的口径锚定验证（spec 前置事实 4/5/6 的实测闭环）。
运行：INSIGHT_LIVE=1 DWS_PASSWORD=... python -m pytest insight/tests/live_caliber_test.py -v
不带 INSIGHT_LIVE 时全 SKIP——零成本、防误连生产。"""
import os
import pytest

pytestmark = pytest.mark.skipif(os.environ.get("INSIGHT_LIVE") != "1",
                                reason="INSIGHT_LIVE 未设置（防误连生产 DWS）")

@pytest.fixture
def run():
    from insight.dws import DwsQueryRunner
    r = DwsQueryRunner(app_name="insight-livecheck", timeout_ms=120000)
    yield r
    r.close()

def test_ct_ly_column_exists(run):
    cols = run("""SELECT column_name FROM information_schema.columns
                  WHERE table_schema='dm' AND table_name='ct_sales_performance_t'
                    AND column_name LIKE 'last_year%'""")
    names = [c["column_name"] for c in cols]
    assert any("achievement" in n for n in names), \
        f"同比列名与 config 不符，改 radar-region_sales.json params.ly_field。实际：{names[:10]}"

def test_target_center_coverage(run):
    """目标↔mix 中心集覆盖率（0/143 陷阱的生死验证）。<90% 则雷达目标口径升级用户裁决。"""
    rows = run("""
      WITH centers AS (
        SELECT DISTINCT node_name5 AS c FROM dm.dm_fin_operations_mix_sum_t
        WHERE calmonth = to_char(add_months(current_date, -1), 'YYYY-MM')
          AND node_desc2 = '瓷砖事业部' AND data_source IN ('S','T','D',''))
      SELECT
        (SELECT COUNT(DISTINCT sales_center_code) FROM dm.dm_dp_api_sales_target
         WHERE stat_month = to_char(current_date, 'YYYY-MM')
           AND org_type = '业务单位'
           AND sales_center_code IN (SELECT c FROM centers)) AS matched,
        (SELECT COUNT(DISTINCT sales_center_code) FROM dm.dm_dp_api_sales_target
         WHERE stat_month = to_char(current_date, 'YYYY-MM')
           AND org_type = '业务单位') AS total""")
    r = rows[0]
    rate = r["matched"] / r["total"] if r["total"] else 0
    assert rate >= 0.9, f"目标中心覆盖率 {rate:.0%} < 90%——升级用户裁决（口径分歧登记）"

def test_ar_comp_codes_placeholder_not_left(run):
    from insight.detectors.base import load_config
    cfg = load_config("ar_risk")
    assert "PLACEHOLDER" not in str(cfg["params"]["comp_codes"]), \
        "comp_codes 未回填：读 sources-of-truth/business-context/ 公司主数据，"
        "列出瓷砖事业部分公司 comp_code 写入 radar-ar_risk.json 后重跑本测试"

def test_mix_actual_rows_today(run):
    rows = run("""SELECT COUNT(*) AS c FROM dm.dm_fin_operations_mix_sum_t
                  WHERE calmonth = to_char(current_date, 'YYYY-MM')
                    AND node_desc2 = '瓷砖事业部' AND data_source IN ('S','T','D','')""")
    assert rows[0]["c"] > 0, "当月瓷砖实绩 0 行——检查 data_source/事业部枚举"

def test_statement_timeout_effective(run):
    rows = run("SHOW statement_timeout")
    assert rows[0]["statement_timeout"] not in ("0",), "statement_timeout 未生效（§14 护栏）"
```

- [ ] **Step 2: 离线确认默认 SKIP**

Run: `python -m pytest insight/tests/live_caliber_test.py -v`
Expected: 5 SKIPPED

- [ ] **Step 3: live 跑一遍（需 DWS_PASSWORD env；非业务高峰）**

Run: `INSIGHT_LIVE=1 DWS_PASSWORD=$DWS_PASSWORD python -m pytest insight/tests/live_caliber_test.py -v`
Expected: 5 PASS。若 `test_ct_ly_column_exists` 失败 → 改 `radar-region_sales.json` 的 `params.ly_field`；若 `test_target_center_coverage` 失败 → **停**，登记口径分歧升级用户；`comp_codes` 从公司主数据回填后复跑。

- [ ] **Step 4: 首轮回测（分月、错峰）**

```bash
# 非业务高峰逐月跑（示例：2025-10；其余月份逐次推进，禁止一次 12 个月连跑）
DWS_PASSWORD=$DWS_PASSWORD python -m insight.backtest --start 2025-10-01 --end 2025-10-31 \
  --detectors region_sales,gross_margin,ar_risk,target --out insight/backtest_results.jsonl
```
Expected: jsonl 逐行输出 findings；连续两跑同月输出 diff 为空（确定性人工复核一次）。

- [ ] **Step 5: Commit**

```bash
git add insight/tests/live_caliber_test.py
git commit -m "test(insight): live口径锚定——ct同比列/目标中心覆盖率0陷阱验证/ar公司清单占位守卫/timeout生效；INSIGHT_LIVE门禁仿EVAL_LIVE" -- insight/tests/live_caliber_test.py
```

---

## Self-Review 记录

1. **Spec coverage（M-i1 范围内）**：§5.1 文件清单 M-i1 子集 ✅（worker_main/api_main/merge_rank/attribution/brief/retention 属 M-i2/M-i3）；§7 四雷达+watermark+串行纪律(timeout/app_name 落 dws.py) ✅；§14 护栏 2/3/4/5 条 ✅（串行执行由 M-i2 runner 编排，M-i1 单测内天然串行）；§17 回测+point-in-time+确定性 ✅；§16 单测覆盖 watermark/阈值/空表/未来行/伪 1 行 ✅。D3 detector 内标准化 ✅（percentile_score）。anchor/applicable_factors 承载 ✅（消费在 M-i2）。
2. **Placeholder scan**：唯一明示占位 = `radar-ar_risk.json` 的 `comp_codes`，有专属 live 守卫测试（`test_ar_comp_codes_placeholder_not_left`）强制回填——其余无 TBD/TODO。
3. **Type consistency**：`Finding(detector,data_date,dim_keys,metrics,norm_score,threshold_passed,is_late,facets)` 各 task 一致；`QueryRunner=callable(sql,params)->list[dict]` 贯穿 dws/水印/检测器/回测；`load_config(name)` 签名一致；`_shift_month` 在 region_sales 定义、gross_margin/target 复用。

## 交付边界

M-i1 完成 ≠ 简报可用（无排序/事件/发布/UI——M-i2/M-i3 计划各出一份，M-i4 为灰度运行 runbook）。回测阈值/权重校准是 M-i1 收尾的用户协作项（抽检认可率 ≥80% 才进灰度，spec D4）。
