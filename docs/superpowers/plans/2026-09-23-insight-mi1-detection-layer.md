# AI 经营助手 v1 · M-i1 检测层实现计划（v2，修订版）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建成 insight 包检测层——4 个经营雷达（目标达成/区域×渠道业绩/毛利/应收）+ watermark 就绪探针 + 历史回测框架，全部可离线单测、可直连 DWS 实测。

**Architecture:** 新增独立 Python 包 `insight/`（spec §5.1；本版新增 `replay_ctx.py` 一个文件，落实 canonical date 裁定）。检测 = 确定性 SQL 模板 + 配置化阈值；数据访问经 `QueryRunner` 协议（生产=psycopg2 只读直连，**session 级 read-only + SQL 白名单双层防护**，测试=假实现）。本计划只做 M-i1；merge/ranking/事件/简报/API/UI 属 M-i2/M-i3。

**Tech Stack:** Python 3.12、pytest、sqlite3（stdlib，insight.db WAL）、psycopg2（run_eval.py 已用）。

**Spec:** `docs/superpowers/specs/2026-09-23-ai-business-assistant-v1-design.md`（v1.2）
**修订记录:** v2 = 用户 17 项工程复审回填（占位符统一/双层只读/timeout 实测/canonical date/point-in-time 全参守卫/exact-retrospective/AR 数学与快照/Target NULL-0/完整自然月/删伪 month-batch/M-i1-M-i2 出口分家）；v2.1 = 执行期勘误（以提交为准：T1 open_db 幂等化 00d0be6；T3 shift_month 日保留+月末钳位语义 9d366e5；T4 watermark parse 纳入防御域+%Y-%m 月粒度比较防假 stale——代码已修，正文未逐处回写；T5 percentile 公式与自测矛盾→严格小于÷(n-1)+钳位100 f012e46；T6 NULL cur 守卫+两闸钉测；T10 fixture 金额抬生产量级——正文已回写）

---

## 前置事实（工程师必读）

1. **DWS 连接**（抄 `run_eval.py:12-17`）：psycopg2，env `DWS_HOST`(121.37.200.214)/`DWS_PORT`(8000)/`DWS_DBNAME`(DP_DWS)/`DWS_USER`(aiuser)/`DWS_PASSWORD`（**只走 env，任何输出不得含值**）。
2. **SQL 参数占位符**：全层统一 psycopg2 原生 named 格式 `%(name)s`（含 `%(month_ends)s` 列表 → ARRAY）。SQL 模板必须可直接交给 `cur.execute(sql, params)`，**不实现任何"→ %()s"转换器**。
3. **canonical date（裁定 #5/#6/#7）**：系统内部统一 `datetime.date`（逻辑等价 YYYY-MM-DD）。模块间**禁止**传 YYYYMMDD / YYYY-MM-DD / YYYY-MM 混合字符串；各表日期参数由 `ReplayContext`/`Dependency` 按 `date_format` 派生。任何日期边界比较先回到 date 对象。
4. **mix 表** `dm.dm_fin_operations_mix_sum_t`：`calday`(YYYYMMDD)+`calmonth`(YYYY-MM)；实绩=`ambperformance`，不含税=`notax_sales_net_amt`，毛利=`gross_profit_after_sharing`；内置 `node_desc1~9/node_name1~9`；预算/预测月到 2026-12 → 实际数过滤 `calmonth <= 当前参数月`；`data_source IN ('S','T','D','')`；事业部=`node_desc2 = '瓷砖事业部'`（固定枚举禁 LIKE）。
5. **ct 表** `dm.ct_sales_performance_t`：`calday`(YYYYMMDD)；`month_achievement` 是 **MTD 快照值，只能取月末那天**；同比字段 `last_year_month_achievement`（Task 11 live 验证，不对则改 config `params.ly_field`）；org JOIN `dm.dm_rpt_sales_group_t`：`org_code = node_name10`。
6. **目标表** `dm.dm_dp_api_sales_target`：`target_sales_amt` **万元**（×10000）；`org_type='业务单位'` 防翻倍；陷阱：`sales_center_code ↔ mix.node_name5` 直接 JOIN 实测 0/143——走"mix 派生中心集 IN 过滤"，覆盖率 Task 11 live 验证 ≥90%。
7. **应收** `dwrfin.dwr_ar_receivable_aging_2023_info_f`：日快照 `query_date`；含 2026-12-31 未来行 → 必须 `query_date <= as_of`；90 天+ = 91_275/276_730/731_1460/1461 分段 ×(_2023_after + _2023_ago)；`special_general_ledger` 空=正常；scope=`comp_code IN (config 清单)`。
8. **口径裁定（#14）**：region_sales 只做**连续 N 个完整自然月**同比下滑——仅统计已结束自然月、每月只取真实月末快照、当前未结束月不参与；周/旬放后续版本。gross_margin 同理取最近两个完整自然月对比。
9. **回测分级（#8）**：`point_in_time_mode`——region_sales/gross_margin/ar_risk = `exact`（日/月快照历史可按当时恢复）；target = `retrospective`（目标表只保留当前记录，历史调整不可恢复，只能事后模拟）。回测产物逐行携带该标记，报告不统一宣称"严格 point-in-time"。
10. **落数时点实测（2026-09-23）**：目标 ~00:15、应收日层 ~06:31、`dm_rpt_region_performance_daily_report_t` 0 行（禁依赖）。
11. **红线**：提交路径限定 `git commit -m msg -- <paths>`；insight.db 路径在 Temp 树外；日志消毒（PASSWORD|TOKEN|SECRET|KEY）；v1 全只读。

## File Structure（本计划新增全集；不修改任何既有文件）

```
insight/
├─ __init__.py
├─ db.py                # spec §6.1 全量 schema 一次建齐 + 访问
├─ dws.py               # 只读通道：session read-only + SQL 白名单 + timeout + 异常恢复
├─ replay_ctx.py        # canonical date 上下文（ReplayContext：参数派生/日历工具）
├─ watermark.py         # 就绪探针（Dependency 自带格式转换）
├─ backtest.py          # 历史重放：值解析式 point-in-time 守卫/确定性/exact-retrospective
├─ detectors/
│  ├─ __init__.py       # 注册表
│  ├─ base.py           # Finding/DetectResult/load_config/percentile
│  ├─ region_sales.py   # 完整自然月同比连续下滑（exact）
│  ├─ gross_margin.py   # 渠道毛利率 完整月环比（exact）
│  ├─ ar_risk.py        # 90天+ 双侧最新快照增量/集中度（exact）
│  └─ target.py         # 达成率 vs 时间进度（retrospective；NULL≠0）
├─ config/
│  ├─ radar-region_sales.json   ├─ radar-gross_margin.json
│  ├─ radar-ar_risk.json        └─ radar-target.json
└─ tests/
   ├─ test_db.py  test_dws.py  test_replay_ctx.py  test_watermark.py
   ├─ test_base.py  test_detectors.py  test_progress.py  test_backtest.py
   └─ live_caliber_test.py      # INSIGHT_LIVE=1 门禁
```

`ranking.json`、worker/api/brief/merge_rank/attribution 属 M-i2。**全计划唯一允许占位** = `radar-ar_risk.json` 的 `comp_codes`（Task 11 live gate 强制回填）。

---

### Task 1: 包骨架 + db.py 全量 schema

（内容与 v1 版 Task 1 完全一致——schema 抄 spec §6.1 全部七表两索引，`open_db` WAL 初始化；3 个测试：全表存在 / partial unique index 拒绝第二个 active / resolve 后允许新 active。执行者按 v1 版 Task 1 的测试代码与实现照做，此处不重复。）

- [ ] Step 1-4: 按 v1 Task 1 测试（3 条）→ 实现 → `python -m pytest insight/tests/test_db.py -v` 全 PASS
- [ ] Step 5: Commit
```bash
git add insight/
git commit -m "feat(insight): M-i1 包骨架+db.py——spec §6.1 全量 schema(含 partial unique index/发布快照/归因版本表)" -- insight/
```

---

### Task 2: dws.py 只读通道（双层防护 + 异常恢复）

**Files:** Create `insight/dws.py`；Test `insight/tests/test_dws.py`

- [ ] **Step 1: 写失败测试**

```python
# insight/tests/test_dws.py
import psycopg2
import pytest
from insight.dws import DwsQueryRunner, build_connect_kwargs

def test_kwargs_env_appname_readonly_timeout(monkeypatch):
    monkeypatch.setenv("DWS_HOST", "h"); monkeypatch.setenv("DWS_PORT", "8000")
    monkeypatch.setenv("DWS_DBNAME", "d"); monkeypatch.setenv("DWS_USER", "u")
    monkeypatch.setenv("DWS_PASSWORD", "sekret")
    kw = build_connect_kwargs(app_name="insight-radar", timeout_ms=30000)
    assert kw["application_name"] == "insight-radar"
    assert "statement_timeout=30000" in kw["options"]
    assert "default_transaction_read_only=on" in kw["options"]   # session 级只读
    assert kw["password"] == "sekret"

def test_guard_allows_select_and_with_select():
    assert DwsQueryRunner._guard("SELECT 1") is None
    assert DwsQueryRunner._guard("  with x as (select 1) select * from x") is None

@pytest.mark.parametrize("bad", [
    "INSERT INTO t VALUES (1)",
    "UPDATE t SET a=1",
    "DELETE FROM t",
    "MERGE INTO t USING s ON 1=1",
    "CREATE TABLE t (a int)",
    "DROP TABLE t",
    "ALTER TABLE t ADD COLUMN a int",
    "TRUNCATE TABLE t",
    "SHOW statement_timeout",                       # 验证 timeout 不靠 SHOW（裁定 #3）
    "GRANT SELECT ON t TO u",
    "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d",   # 数据改性 CTE
])
def test_guard_rejects_writes_and_show(bad):
    with pytest.raises(ValueError):
        DwsQueryRunner._guard(bad)

class _FakeCursor:
    def __init__(self, results, exc=None): self._r, self._exc = results, exc
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def execute(self, sql, params=None):
        if self._exc: raise self._exc
    def fetchall(self): return self._r
    @property
    def description(self): return [("x",)]

class _FakeConn:
    def __init__(self, results, exc=None):
        self._results, self._exc = results, exc
        self.rollbacks = 0; self.closed = 0; self.cursors = 0
    def cursor(self):
        self.cursors += 1; return _FakeCursor(self._results, self._exc)
    def rollback(self):
        self.rollbacks += 1
        if self.closed: raise psycopg2.OperationalError("conn closed")

def test_query_success_rolls_back_txn():          # 只读事务即查即清，不留悬挂
    conn = _FakeConn([(1,)])
    r = DwsQueryRunner.__new__(DwsQueryRunner)
    r._conn, r._kwargs = conn, {}
    assert r("SELECT 1") == [{"x": 1}] and conn.rollbacks == 1

def test_error_then_rollback_then_next_query_ok():  # 裁定 #4：aborted 恢复
    conn = _FakeConn(None, exc=psycopg2.errors.QueryCanceled())
    r = DwsQueryRunner.__new__(DwsQueryRunner)
    r._conn, r._kwargs = conn, {}
    with pytest.raises(psycopg2.errors.QueryCanceled):
        r("SELECT pg_sleep(3)")
    assert conn.rollbacks == 1                     # 恢复 transaction
    conn._exc = None; conn._results = [(1,)]       # 下一个 detector 查询不受污染
    assert r("SELECT 1") == [{"x": 1}]

def test_broken_connection_rebuilt(monkeypatch):   # 裁定 #4：连接失效重建
    calls = {"n": 0}
    def fake_connect(**kw): calls["n"] += 1; return _FakeConn([(1,)])
    monkeypatch.setattr(psycopg2, "connect", fake_connect)
    r = DwsQueryRunner(app_name="t")
    dead = _FakeConn([]); dead.closed = 1
    r._conn = dead
    assert r("SELECT 1") == [{"x": 1}] and calls["n"] == 1
```

- [ ] **Step 2: 确认失败** `python -m pytest insight/tests/test_dws.py -v` → FAIL（无模块）

- [ ] **Step 3: 实现**

```python
# insight/dws.py
"""只读 DWS 查询通道——DWS Resource Guardrail 的落地（spec §14，裁定 #2/#3/#4）。

双层防护：①session 级 default_transaction_read_only=on（真正的墙）
         ②SQL 白名单仅 SELECT / WITH...SELECT（含全句禁词扫描，拒绝 SHOW 与数据改性 CTE）
异常恢复：查询异常 → rollback 清 aborted；连接失效 → 置 None 下次重建。
某 detector 超时 → 自降级 unavailable → runner 恢复 → 下一个 detector 不受污染。
密钥只走 env；REDACT 供日志侧消毒。
"""
import os
import re
import psycopg2

_FORBIDDEN = re.compile(
    r"\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE|SHOW|GRANT|REVOKE|COPY|SET)\b",
    re.IGNORECASE)

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
        "options": (f"-c statement_timeout={timeout_ms} "
                    f"-c default_transaction_read_only=on"),
    }

def REDACT(kwargs: dict) -> dict:
    return {k: ("***" if k == "password" else v) for k, v in kwargs.items()}

class DwsQueryRunner:
    def __init__(self, app_name: str = "insight-radar", timeout_ms: int = 60000):
        self._kwargs = build_connect_kwargs(app_name, timeout_ms)
        self._conn = None

    @staticmethod
    def _guard(sql: str) -> None:
        s = sql.lstrip()
        if not (s[:6].upper() == "SELECT" or s[:4].upper() == "WITH"):
            raise ValueError(f"非只读语句（仅允许 SELECT / WITH...SELECT）：{s[:60]}")
        m = _FORBIDDEN.search(s)
        if m:
            raise ValueError(f"SQL 含禁用关键字 {m.group(1)}：{s[:60]}")

    def __call__(self, sql: str, params: dict | None = None) -> list[dict]:
        self._guard(sql)
        if self._conn is None or getattr(self._conn, "closed", 0):
            self._conn = psycopg2.connect(**self._kwargs)
        try:
            with self._conn.cursor() as cur:
                cur.execute(sql, params)
                cols = [d[0] for d in cur.description]
                return [dict(zip(cols, row)) for row in cur.fetchall()]
        finally:
            self._recover()

    def _recover(self) -> None:
        """查询后统一收尾：正常路径 rollback 立即结束只读事务；
        异常路径 rollback 清 aborted；rollback 自身失败 → 弃连接待重建。"""
        try:
            self._conn.rollback()
        except Exception:
            self._conn = None

    def close(self):
        if self._conn is not None:
            self._conn.close(); self._conn = None
```

- [ ] **Step 4: 确认通过** `python -m pytest insight/tests/test_dws.py -v` → 全 PASS
- [ ] **Step 5: Commit**
```bash
git add insight/dws.py insight/tests/test_dws.py
git commit -m "feat(insight): 只读通道——session read-only+SQL白名单双层/超时/aborted恢复/连接重建" -- insight/dws.py insight/tests/test_dws.py
```

---

### Task 3: replay_ctx.py canonical date 上下文

**Files:** Create `insight/replay_ctx.py`；Test `insight/tests/test_replay_ctx.py`

- [ ] **Step 1: 写失败测试**

```python
# insight/tests/test_replay_ctx.py
from datetime import date
from insight.replay_ctx import ReplayContext, month_end_of, shift_month

def test_param_derivation_formats():
    ctx = ReplayContext(as_of=date(2026, 9, 22))
    assert ctx.calday() == "20260922"        # mix/ct
    assert ctx.ym() == "2026-09"             # calmonth/stat_month
    assert ctx.iso() == "2026-09-22"         # aging query_date

def test_completed_month_ends_mid_month():   # 9-22 → 6/7/8 月（9 月未结束不参与）
    ctx = ReplayContext(as_of=date(2026, 9, 22))
    assert ctx.completed_month_ends(3) == [date(2026, 6, 30), date(2026, 7, 31),
                                           date(2026, 8, 31)]

def test_completed_month_ends_on_month_end():  # 9-30 当天 → 9 月视为已结束
    ctx = ReplayContext(as_of=date(2026, 9, 30))
    assert ctx.completed_month_ends(2) == [date(2026, 8, 31), date(2026, 9, 30)]

def test_calendar_helpers():
    assert month_end_of(date(2026, 2, 10)) == date(2026, 2, 28)
    assert shift_month(date(2026, 1, 15), -1) == date(2025, 12, 15)
    assert shift_month(date(2026, 12, 5), 1) == date(2027, 1, 5)
```

- [ ] **Step 2: 确认失败** → FAIL（无模块）
- [ ] **Step 3: 实现**

```python
# insight/replay_ctx.py
"""canonical date 上下文（裁定 #5/#6/#7）。

内部统一 datetime.date；一切查询日期参数由 ctx 派生（格式属于 Dependency/ctx，
不属于 Detector 身份）；日期比较只发生在 date 空间，禁止混合格式字符串字典序。
Backtest 用 ReplayContext(as_of=历史日) 重放，天然 point-in-time。
"""
from dataclasses import dataclass
from datetime import date, timedelta

def shift_month(d: date, delta: int) -> date:
    total = d.year * 12 + (d.month - 1) + delta
    y, m = divmod(total, 12)
    return date(y, m + 1, 1)

def month_end_of(d: date) -> date:
    return shift_month(d, 1) - timedelta(days=1)

@dataclass(frozen=True)
class ReplayContext:
    as_of: date

    def iso(self) -> str:   return self.as_of.isoformat()          # query_date
    def calday(self) -> str: return self.as_of.strftime("%Y%m%d")  # mix/ct calday
    def ym(self) -> str:    return self.as_of.strftime("%Y-%m")    # calmonth/stat_month
    def minus_days(self, days: int) -> date: return self.as_of - timedelta(days=days)
    def prev_month_ym(self) -> str:
        return shift_month(self.as_of, -1).strftime("%Y-%m")

    def completed_month_ends(self, n: int) -> list[date]:
        """截至 as_of 已结束的自然月月末，升序前 n 个（裁定 #8 完整自然月口径）。"""
        out: list[date] = []
        m = self.as_of.replace(day=1)
        while len(out) < n:
            end = month_end_of(m)
            if end <= self.as_of:
                out.append(end)
            m = shift_month(m, -1)
        return sorted(out)
```

- [ ] **Step 4: 确认通过** → 4 PASS
- [ ] **Step 5: Commit**
```bash
git add insight/replay_ctx.py insight/tests/test_replay_ctx.py
git commit -m "feat(insight): ReplayContext——canonical date/参数派生/完整自然月日历工具" -- insight/replay_ctx.py insight/tests/test_replay_ctx.py
```

---

### Task 4: watermark.py（Dependency 自带格式转换）

**Files:** Create `insight/watermark.py`；Test `insight/tests/test_watermark.py`

- [ ] **Step 1: 写失败测试**

```python
# insight/tests/test_watermark.py
from datetime import date
from insight.watermark import Dependency, check_dependency
from insight.replay_ctx import ReplayContext

DEP = Dependency(table="dm.dm_fin_operations_mix_sum_t", date_col="calday",
                 date_format="%Y%m%d", required="data_date",
                 extra_where="node_desc2 = '瓷砖事业部' AND data_source IN ('S','T','D','')")
CTX = ReplayContext(as_of=date(2026, 9, 22))

def test_ready_when_fresh_and_nonempty():
    fake = lambda sql, p=None: [{"max_day": "20260922", "rows_": 42}]
    r = check_dependency(DEP, fake, CTX)
    assert r.ready and r.effective_data_date == date(2026, 9, 22) and r.rows == 42

def test_not_ready_when_stale():
    fake = lambda sql, p=None: [{"max_day": "20260901", "rows_": 42}]
    r = check_dependency(DEP, fake, CTX)
    assert not r.ready and r.reason == "stale"

def test_not_ready_when_empty_table():
    fake = lambda sql, p=None: [{"max_day": None, "rows_": 0}]
    r = check_dependency(DEP, fake, CTX)
    assert not r.ready and r.reason == "empty"

def test_sql_uses_psycopg2_placeholder_and_binds_calday():
    seen = {}
    fake = lambda sql, p=None: (seen.update(sql=sql, p=p) or [{"max_day": "20260922", "rows_": 1}])
    check_dependency(DEP, fake, CTX)
    assert "<= %(data_date)s" in seen["sql"]
    assert seen["p"] == {"data_date": "20260922"}          # Dependency 自己转格式

def test_iso_dependency_binds_iso():
    dep = Dependency(table="dwrfin.dwr_ar_receivable_aging_2023_info_f",
                     date_col="query_date", date_format="%Y-%m-%d", required="data_date")
    seen = {}
    fake = lambda sql, p=None: (seen.update(p=p) or [{"max_day": "2026-09-22", "rows_": 1}])
    check_dependency(dep, fake, CTX)
    assert seen["p"] == {"data_date": "2026-09-22"}
```

- [ ] **Step 2: 确认失败** → FAIL
- [ ] **Step 3: 实现**

```python
# insight/watermark.py
from dataclasses import dataclass
from datetime import date, datetime
from .replay_ctx import month_end_of, shift_month

@dataclass
class Dependency:
    table: str
    date_col: str
    date_format: str            # %Y%m%d | %Y-%m-%d | %Y-%m
    required: str               # data_date | last_month_end
    extra_where: str = "1=1"

    def fmt(self, d: date) -> str:
        return d.strftime(self.date_format)

    def parse(self, s) -> date | None:
        if s is None:
            return None
        return datetime.strptime(str(s), self.date_format).date()

@dataclass
class WatermarkResult:
    dep: "Dependency"
    ready: bool
    effective_data_date: date | None
    rows: int
    reason: str                 # ok | stale | empty | error
    checked_at: str

def check_dependency(dep: Dependency, run, ctx: ReplayContext) -> WatermarkResult:
    from datetime import datetime as _d
    now = _d.now().isoformat(timespec="seconds")
    sql = (f"SELECT MAX({dep.date_col}) AS max_day, COUNT(*) AS rows_ "
           f"FROM {dep.table} WHERE {dep.extra_where} "
           f"AND {dep.date_col} <= %(data_date)s")
    bound = dep.fmt(ctx.as_of)
    try:
        row = run(sql, {"data_date": bound})[0]
    except Exception:
        return WatermarkResult(dep, False, None, 0, "error", now)
    max_day = dep.parse(row["max_day"])
    if max_day is None or row["rows_"] == 0:
        return WatermarkResult(dep, False, None, row["rows_"], "empty", now)
    if dep.required == "last_month_end":
        req = month_end_of(shift_month(ctx.as_of, -1))
    else:
        req = ctx.as_of
    if max_day < req:
        return WatermarkResult(dep, False, max_day, row["rows_"], "stale", now)
    return WatermarkResult(dep, True, max_day, row["rows_"], "ok", now)
```

- [ ] **Step 4: 确认通过** → 5 PASS
- [ ] **Step 5: Commit**
```bash
git add insight/watermark.py insight/tests/test_watermark.py
git commit -m "feat(insight): watermark——Dependency自带格式转换/psycopg2占位符/date空间比较" -- insight/watermark.py insight/tests/test_watermark.py
```

---

### Task 5: detectors/base.py（Finding / DetectResult / 契约收紧）

**Files:** Create `insight/detectors/base.py`；Test `insight/tests/test_base.py`

- [ ] **Step 1: 写失败测试**

```python
# insight/tests/test_base.py
import json
from insight.detectors.base import Finding, DetectResult, percentile_score, load_config

def test_percentile_score_against_baseline():
    baseline = [100, 200, 300, 400, 500]
    assert percentile_score(500, baseline) == 100
    assert percentile_score(100, baseline) == 0
    assert 40 <= percentile_score(250, baseline) <= 60

def test_percentile_empty_baseline_neutral():
    assert percentile_score(123, []) == 50

def test_load_config_contract_fields(tmp_path):
    cfg = {"name": "x", "deps": [], "anchor": {"type": "org_channel"},
           "applicable_factors": ["impact"], "params": {}, "norm": {"metric": "m", "baseline": []},
           "timeout_ms": 30000, "backtest": {"point_in_time_mode": "exact"}}
    (tmp_path / "radar-x.json").write_text(json.dumps(cfg), encoding="utf-8")
    got = load_config("x", root=tmp_path)
    assert got["backtest"]["point_in_time_mode"] == "exact"

def test_detect_result_default_is_ok_empty():        # 裁定 #12：findings 只含越阈
    r = DetectResult(detector="x", status="ok")
    assert r.findings == [] and r.note == ""
```

- [ ] **Step 2: 确认失败** → FAIL
- [ ] **Step 3: 实现**

```python
# insight/detectors/base.py
"""Detector 契约（spec §7 + 裁定 #12）：detect(run, ctx) 只返回越阈 Finding；
未越阈中间计算不进 findings 主数据流（diagnostics 未来另设，不混入）。"""
import json
from dataclasses import dataclass, field
from pathlib import Path
from ..replay_ctx import ReplayContext

CONFIG_DIR = Path(__file__).parent.parent / "config"

def load_config(name: str, root: Path | None = None) -> dict:
    return json.loads(((root or CONFIG_DIR) / f"radar-{name}.json")
                      .read_text(encoding="utf-8"))

@dataclass
class Finding:
    detector: str
    data_date: str            # ctx.as_of.isoformat()（canonical 输出形态）
    dim_keys: dict            # {anchor_type, anchor_id, channel}
    metrics: dict
    norm_score: int
    threshold_passed: bool = True   # 契约收紧后恒 True（detect 只产越阈）
    is_late: bool = False
    facets: dict = field(default_factory=dict)

@dataclass
class DetectResult:
    detector: str
    status: str               # ok | not_ready | insufficient_history
    note: str = ""
    findings: list = field(default_factory=list)

def percentile_score(value: float, baseline: list[float]) -> int:
    if not baseline:
        return 50
    s = sorted(baseline)
    return round(100 * sum(1 for b in s if b <= value) / len(s))
```

- [ ] **Step 4: 确认通过** → 4 PASS
- [ ] **Step 5: Commit**
```bash
git add insight/detectors/base.py insight/tests/test_base.py
git commit -m "feat(insight): base契约——Finding恒越阈/DetectResult状态机/percentile标准化" -- insight/detectors/base.py insight/tests/test_base.py
```

---

### Task 6: region_sales 雷达（完整自然月口径，exact）

**Files:** Create `insight/config/radar-region_sales.json`、`insight/detectors/region_sales.py`；Modify `insight/detectors/__init__.py`；Test `insight/tests/test_detectors.py`

- [ ] **Step 1: 写失败测试**

```python
# insight/tests/test_detectors.py
from datetime import date
from insight.replay_ctx import ReplayContext
from insight.detectors.region_sales import RegionSalesDetector

CTX = ReplayContext(as_of=date(2026, 9, 22))          # 完整月窗口=6/7/8 月

def _rows(yoy_seq):                                    # keys: 华南/GD01 + 广东/GD01(正常)
    rows = []
    for (y, m), yoy in zip([(2026, 6), (2026, 7), (2026, 8)], yoy_seq):
        rows.append({"month": f"{y}-{m:02d}", "org_name": "华南营销中心", "channel": "GD01",
                     "cur_amt": 9000.0, "ly_amt": 10135.0})
        rows.append({"month": f"{y}-{m:02d}", "org_name": "广东营销部", "channel": "GD01",
                     "cur_amt": 5000.0, "ly_amt": 4950.0})
    return rows

def test_fires_on_three_complete_months_decline():
    det = RegionSalesDetector.for_test()
    run = lambda sql, p=None: _rows([-11.2, -10.8, -11.5])
    res = det.detect(run, CTX)
    assert res.status == "ok" and len(res.findings) == 1
    f = res.findings[0]
    assert f.dim_keys["anchor_id"] == "华南营销中心|GD01"
    assert f.metrics["consecutive"] == 3 and f.metrics["months"] == ["2026-06", "2026-07", "2026-08"]
    assert f.threshold_passed is True

def test_quiet_when_one_month_recovers():
    det = RegionSalesDetector.for_test()
    run = lambda sql, p=None: _rows([-11.2, -10.8, 2.0])
    res = det.detect(run, CTX)
    assert res.status == "ok" and res.findings == []

def test_sql_complete_month_binds():
    det = RegionSalesDetector.for_test()
    seen = {}
    run = lambda sql, p=None: (seen.update(sql=sql, p=p) or [])
    det.detect(run, CTX)
    assert seen["p"]["month_ends"] == ["20260630", "20260731", "20260831"]  # 9 月不在
    assert seen["p"]["as_of_calday"] == "20260922"
    assert "ANY(%(month_ends)s)" in seen["sql"]
    assert "<= %(as_of_calday)s" in seen["sql"]                              # 防未来
    assert "node_desc2 = '瓷砖事业部'" in seen["sql"]
    assert ":data_date" not in seen["sql"]                                   # 无旧占位符
```

- [ ] **Step 2: 确认失败** → FAIL
- [ ] **Step 3: 实现**

```json
// insight/config/radar-region_sales.json
{
  "name": "region_sales",
  "scope": "瓷砖事业部",
  "deps": [
    {"table": "dm.ct_sales_performance_t", "date_col": "calday", "date_format": "%Y%m%d",
     "required": "last_month_end", "extra_where": "1=1"}
  ],
  "anchor": {"type": "org_channel", "org_field": "node_desc5", "channel_field": "integrate_channel"},
  "applicable_factors": ["impact", "target_gap", "persistence", "scope", "worsening"],
  "params": {"consecutive_months": 3, "yoy_threshold_pct": -8.0,
             "min_ly_amt": 20000000, "ly_field": "last_year_month_achievement"},
  "norm": {"metric": "abs_delta_wan", "baseline_wan": [100, 300, 800, 2000, 5000]},
  "backtest": {"point_in_time_mode": "exact"},
  "timeout_ms": 60000,
  "notes": "完整自然月口径（裁定#14）：仅统计已结束自然月的真实月末快照；当前月/周/旬不参与，周旬=后续版本"
}
```

```python
# insight/detectors/region_sales.py
"""区域×渠道业绩雷达：连续 N 个完整自然月同比下滑（裁定 #14；ct 月末快照 exact）。"""
from datetime import date
from ..replay_ctx import ReplayContext
from .base import DetectResult, Finding, load_config, percentile_score

SQL = """
SELECT to_char(to_date(p.calday, 'YYYYMMDD'), 'YYYY-MM') AS month,
       s.node_desc5 AS org_name, p.integrate_channel AS channel,
       SUM(p.month_achievement) AS cur_amt,
       SUM(p.{ly_field}) AS ly_amt
FROM dm.ct_sales_performance_t p
JOIN dm.dm_rpt_sales_group_t s
  ON p.org_code = s.node_name10 AND s.node_desc2 = '瓷砖事业部'
WHERE p.calday = ANY(%(month_ends)s)
  AND p.calday <= %(as_of_calday)s
GROUP BY 1, 2, 3
"""

class RegionSalesDetector:
    def __init__(self, cfg: dict | None = None):
        self.cfg = cfg or load_config("region_sales")

    @classmethod
    def for_test(cls):
        return cls(load_config("region_sales"))

    def check_watermark(self, run, ctx: ReplayContext):
        from ..watermark import Dependency, check_dependency
        return [check_dependency(Dependency(**d), run, ctx) for d in self.cfg["deps"]]

    def detect(self, run, ctx: ReplayContext) -> DetectResult:
        p = self.cfg["params"]
        n = p["consecutive_months"]
        ends = ctx.completed_month_ends(n)
        rows = run(SQL.format(ly_field=p["ly_field"]),
                   {"month_ends": [e.strftime("%Y%m%d") for e in ends],
                    "as_of_calday": ctx.calday()})
        expected = [e.strftime("%Y-%m") for e in ends]
        by_key: dict[tuple, dict[str, dict]] = {}
        for r in rows:
            by_key.setdefault((r["org_name"], r["channel"]), {})[r["month"]] = r
        findings: list[Finding] = []
        for (org, ch), months in by_key.items():
            if sorted(months) != expected:            # 缺任一完整月 → 不构成"连续"
                continue
            seq = [months[m] for m in expected]
            if any((r["ly_amt"] or 0) < p["min_ly_amt"] for r in seq):
                continue
            yoys = [(r["cur_amt"] - r["ly_amt"]) / r["ly_amt"] * 100 for r in seq]
            if all(y < p["yoy_threshold_pct"] for y in yoys):
                delta_wan = abs(seq[-1]["cur_amt"] - seq[-1]["ly_amt"]) / 10000
                findings.append(Finding(
                    detector=self.cfg["name"], data_date=ctx.as_of.isoformat(),
                    dim_keys={"anchor_type": "org_channel",
                              "anchor_id": f"{org}|{ch}", "channel": ch},
                    metrics={"yoy_pct": round(yoys[-1], 1), "consecutive": n,
                             "abs_delta_wan": round(delta_wan), "months": expected},
                    norm_score=percentile_score(delta_wan, self.cfg["norm"]["baseline_wan"])))
        return DetectResult(self.cfg["name"], "ok", findings=findings)
```

`insight/detectors/__init__.py`：注册表模式（后续 task 逐个追加）：

```python
# insight/detectors/__init__.py
"""雷达注册表。"""
from .region_sales import RegionSalesDetector

REGISTRY = {"region_sales": RegionSalesDetector}
```

- [ ] **Step 4: 确认通过** → 3 PASS
- [ ] **Step 5: Commit**
```bash
git add insight/config/radar-region_sales.json insight/detectors/region_sales.py insight/detectors/__init__.py insight/tests/test_detectors.py
git commit -m "feat(insight): region_sales——连续完整自然月同比越阈(exact)/月末快照ANY绑定/psycopg2占位符" -- insight/config/radar-region_sales.json insight/detectors/region_sales.py insight/detectors/__init__.py insight/tests/test_detectors.py
```

---

### Task 7: gross_margin 雷达（最近两个完整自然月，exact）

**Files:** Create `insight/config/radar-gross_margin.json`、`insight/detectors/gross_margin.py`；Modify `insight/detectors/__init__.py`；Test 追加

- [ ] **Step 1: 写失败测试（追加）**

```python
# insight/tests/test_detectors.py（追加）
from insight.detectors.gross_margin import GrossMarginDetector

def test_margin_fires_on_drop():
    det = GrossMarginDetector.for_test()
    run = lambda sql, p=None: [{"channel": "GD03", "gmp_pct": 28.1, "prev_gmp_pct": 31.2,
                                "gp": 9000.0, "prev_gp": 12000.0}]
    res = det.detect(run, CTX)
    assert res.status == "ok" and len(res.findings) == 1
    assert res.findings[0].metrics["delta_pct"] == -3.1
    assert res.findings[0].dim_keys["anchor_type"] == "org_channel"

def test_margin_quiet_on_small_drop():
    det = GrossMarginDetector.for_test()
    run = lambda sql, p=None: [{"channel": "GD03", "gmp_pct": 30.9, "prev_gmp_pct": 31.0,
                                "gp": 9000.0, "prev_gp": 9100.0}]
    assert det.detect(run, CTX).findings == []

def test_margin_sql_complete_months_binds():
    det = GrossMarginDetector.for_test()
    seen = {}
    run = lambda sql, p=None: (seen.update(sql=sql, p=p) or [])
    det.detect(run, CTX)
    assert seen["p"]["cur_ym"] == "2026-08" and seen["p"]["prev_ym"] == "2026-07"
    assert "gross_profit_after_sharing" in seen["sql"]
    assert "notax_sales_net_amt" in seen["sql"]
    assert "calmonth <= %(cur_ym)s" in seen["sql"]          # 预算月防线
```

- [ ] **Step 2: 确认失败**（`-k margin`）→ FAIL
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
  "params": {"delta_threshold_pct": -2.0, "min_gp_wan": 500},
  "norm": {"metric": "abs_delta_wan", "baseline_wan": [100, 300, 800, 2000, 5000]},
  "backtest": {"point_in_time_mode": "exact"},
  "timeout_ms": 60000,
  "notes": "最近两个完整自然月对比（cur=最近已结束月）"
}
```

```python
# insight/detectors/gross_margin.py
"""毛利雷达：mix 渠道级毛利率 完整月环比（毛利=分成后毛利/不含税净额）。"""
from ..replay_ctx import ReplayContext
from .base import DetectResult, Finding, load_config, percentile_score

SQL = """
SELECT integrate_channel AS channel,
       SUM(CASE WHEN calmonth = %(cur_ym)s THEN gross_profit_after_sharing END) AS gp,
       SUM(CASE WHEN calmonth = %(cur_ym)s THEN notax_sales_net_amt END) AS net_amt,
       SUM(CASE WHEN calmonth = %(prev_ym)s THEN gross_profit_after_sharing END) AS prev_gp,
       SUM(CASE WHEN calmonth = %(prev_ym)s THEN notax_sales_net_amt END) AS prev_net_amt
FROM dm.dm_fin_operations_mix_sum_t
WHERE calmonth IN (%(cur_ym)s, %(prev_ym)s)
  AND calmonth <= %(cur_ym)s
  AND node_desc2 = '瓷砖事业部'
  AND data_source IN ('S','T','D','')
GROUP BY 1
"""

class GrossMarginDetector:
    def __init__(self, cfg: dict | None = None):
        self.cfg = cfg or load_config("gross_margin")

    @classmethod
    def for_test(cls):
        return cls(load_config("gross_margin"))

    def check_watermark(self, run, ctx: ReplayContext):
        from ..watermark import Dependency, check_dependency
        return [check_dependency(Dependency(**d), run, ctx) for d in self.cfg["deps"]]

    def detect(self, run, ctx: ReplayContext) -> DetectResult:
        p = self.cfg["params"]
        ends = ctx.completed_month_ends(2)                 # [prev, cur]
        cur_ym, prev_ym = ends[1].strftime("%Y-%m"), ends[0].strftime("%Y-%m")
        rows = run(SQL, {"cur_ym": cur_ym, "prev_ym": prev_ym})
        findings = []
        for r in rows:
            if r["gp"] is None or r["net_amt"] in (None, 0) \
                    or r["prev_gp"] is None or r["prev_net_amt"] in (None, 0):
                continue
            gmp = r["gp"] / r["net_amt"] * 100
            prev_gmp = r["prev_gp"] / r["prev_net_amt"] * 100
            delta_pct = round(gmp - prev_gmp, 1)
            delta_wan = abs(r["gp"] - r["prev_gp"]) / 10000
            if delta_pct <= p["delta_threshold_pct"] and r["gp"] / 10000 >= p["min_gp_wan"]:
                findings.append(Finding(
                    detector=self.cfg["name"], data_date=ctx.as_of.isoformat(),
                    dim_keys={"anchor_type": "org_channel",
                              "anchor_id": f"瓷砖事业部|{r['channel']}",
                              "channel": r["channel"]},
                    metrics={"delta_pct": delta_pct, "gmp_pct": round(gmp, 1),
                             "prev_gmp_pct": round(prev_gmp, 1),
                             "abs_delta_wan": round(delta_wan)},
                    norm_score=percentile_score(delta_wan, self.cfg["norm"]["baseline_wan"])))
        return DetectResult(self.cfg["name"], "ok", findings=findings)
```

注册表追加 `from .gross_margin import GrossMarginDetector` / `"gross_margin": GrossMarginDetector`。

- [ ] **Step 4: 确认通过** → 6 PASS
- [ ] **Step 5: Commit**
```bash
git add insight/config/radar-gross_margin.json insight/detectors/gross_margin.py insight/detectors/__init__.py insight/tests/test_detectors.py
git commit -m "feat(insight): gross_margin——最近两个完整自然月毛利率环比(exact)/python侧计算比率" -- insight/config/radar-gross_margin.json insight/detectors/gross_margin.py insight/detectors/__init__.py insight/tests/test_detectors.py
```

---

### Task 8: ar_risk 雷达（双侧最新快照，exact）

**Files:** Create `insight/config/radar-ar_risk.json`、`insight/detectors/ar_risk.py`；Modify `insight/detectors/__init__.py`；Test 追加

- [ ] **Step 1: 写失败测试（追加）**

```python
# insight/tests/test_detectors.py（追加）
from insight.detectors.ar_risk import ArRiskDetector

AR_CTX = ReplayContext(as_of=date(2026, 9, 22))       # prev_bound = 2026-08-23

def _ar_rows():   # 7 个正增量客户：360/280/190/60/40/30/20 → 总 980，Top5=930 → 95%
    return [
        {"cust_code": "D1", "cust_name": "经销商A", "over90": 920.0, "prev_over90": 560.0},
        {"cust_code": "D2", "cust_name": "工程客户B", "over90": 680.0, "prev_over90": 400.0},
        {"cust_code": "D3", "cust_name": "经销商C", "over90": 510.0, "prev_over90": 320.0},
        {"cust_code": "D4", "cust_name": "客户D", "over90": 160.0, "prev_over90": 100.0},
        {"cust_code": "D5", "cust_name": "客户E", "over90": 140.0, "prev_over90": 100.0},
        {"cust_code": "D6", "cust_name": "客户F", "over90": 130.0, "prev_over90": 100.0},
        {"cust_code": "D7", "cust_name": "客户G", "over90": 120.0, "prev_over90": 100.0},
    ]

def _ar_run(snaps, detail_rows, log):
    def run(sql, params=None):
        log.append((sql, params))
        if "MAX(query_date)" in sql:
            return [{"snap": snaps.get(params["bound"])}]
        return detail_rows
    return run

def test_ar_math_total_and_top5_share():
    log = []
    run = _ar_run({"2026-09-22": "2026-09-22", "2026-08-23": "2026-08-23"}, _ar_rows(), log)
    res = ArRiskDetector.for_test().detect(run, AR_CTX)
    assert res.status == "ok" and len(res.findings) == 1
    m = res.findings[0].metrics
    assert m["delta_wan"] == 980                        # 360+280+190+60+40+30+20
    assert m["top5_share_pct"] == 95                    # (360+280+190+60+40)/980
    assert m["current_snapshot_date"] == "2026-09-22"
    assert m["previous_snapshot_date"] == "2026-08-23"

def test_ar_insufficient_history_not_zero():           # 裁定 #11：缺上期≠0
    log = []
    run = _ar_run({"2026-09-22": "2026-09-22", "2026-08-23": None}, _ar_rows(), log)
    res = ArRiskDetector.for_test().detect(run, AR_CTX)
    assert res.status == "insufficient_history" and res.findings == []
    assert "2026-08-23" in res.note
    assert not any("cust_code" in s for s, _ in log)    # 未做对比查询

def test_ar_sql_future_row_guard():
    log = []
    run = _ar_run({"2026-09-22": "2026-09-22", "2026-08-23": "2026-08-23"}, _ar_rows(), log)
    ArRiskDetector.for_test().detect(run, AR_CTX)
    detail_sql = next(s for s, _ in log if "cust_code" in s)
    assert "query_date <= %(as_of_iso)s" in detail_sql
    assert "special_general_ledger" in detail_sql
    snap_sql = next(s for s, _ in log if "MAX(query_date)" in s)
    assert "<= %(bound)s" in snap_sql
```

- [ ] **Step 2: 确认失败**（`-k ar_`）→ FAIL
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
  "params": {"delta_threshold_wan": 300, "top5_share_threshold_pct": 60,
             "prev_lag_days": 30, "comp_codes": ["PLACEHOLDER_TASK11_FILL"]},
  "norm": {"metric": "abs_delta_wan", "baseline_wan": [200, 500, 1000, 2000, 4000]},
  "backtest": {"point_in_time_mode": "exact"},
  "timeout_ms": 120000,
  "notes": "comp_codes=全计划唯一占位：Task 11 live gate 强制从 sources-of-truth/business-context 公司主数据回填，未回填不得进 M-i1 完成态"
}
```

```python
# insight/detectors/ar_risk.py
"""应收风险雷达：90 天+ 双侧最新快照增量 + top5 集中度（anchor=customer）。

裁定 #11：当前/对比快照各取 <= bound 的最新一份；找不到对比快照 →
insufficient_history，绝不以 0 代替（防巨额假新增）。"""
from datetime import date, datetime, timedelta
from ..replay_ctx import ReplayContext
from .base import DetectResult, Finding, load_config, percentile_score

_OVER90 = " + ".join(
    f"COALESCE({seg}_{fam},0)"
    for seg in ("overdue_receivables_91_275_day", "overdue_receivables_276_730_day",
                "overdue_receivables_731_1460_day", "overdue_receivables_1461_day")
    for fam in ("2023_after", "2023_ago"))

SNAP_SQL = f"""
SELECT MAX(query_date) AS snap
FROM dwrfin.dwr_ar_receivable_aging_2023_info_f
WHERE query_date <= %(bound)s
  AND comp_code = ANY(%(comp_codes)s)
  AND COALESCE(special_general_ledger,'') = ''
"""

DETAIL_SQL = f"""
WITH snap AS (
  SELECT query_date, cust_code, MAX(cust_name) AS cust_name,
         SUM({_OVER90}) / 10000 AS over90
  FROM dwrfin.dwr_ar_receivable_aging_2023_info_f
  WHERE query_date IN (%(cur_snap)s, %(prev_snap)s)
    AND query_date <= %(as_of_iso)s
    AND comp_code = ANY(%(comp_codes)s)
    AND COALESCE(special_general_ledger,'') = ''
  GROUP BY 1, 2
)
SELECT cust_code, MAX(cust_name) AS cust_name,
       MAX(CASE WHEN query_date = %(cur_snap)s THEN over90 END) AS over90,
       MAX(CASE WHEN query_date = %(prev_snap)s THEN over90 END) AS prev_over90
FROM snap GROUP BY 1
"""

def _as_date(v) -> date | None:
    if v is None:
        return None
    return v if isinstance(v, date) else datetime.strptime(str(v), "%Y-%m-%d").date()

class ArRiskDetector:
    def __init__(self, cfg: dict | None = None):
        self.cfg = cfg or load_config("ar_risk")

    @classmethod
    def for_test(cls):
        return cls(load_config("ar_risk"))

    def check_watermark(self, run, ctx: ReplayContext):
        from ..watermark import Dependency, check_dependency
        return [check_dependency(Dependency(**d), run, ctx) for d in self.cfg["deps"]]

    def detect(self, run, ctx: ReplayContext) -> DetectResult:
        p = self.cfg["params"]
        binds = {"comp_codes": p["comp_codes"]}
        cur_snap = _as_date(run(SNAP_SQL, {"bound": ctx.iso(), **binds})[0]["snap"])
        prev_bound = ctx.minus_days(p["prev_lag_days"]).isoformat()
        prev_snap = _as_date(run(SNAP_SQL, {"bound": prev_bound, **binds})[0]["snap"])
        if cur_snap is None or prev_snap is None or prev_snap >= cur_snap:
            return DetectResult(self.cfg["name"], "insufficient_history",
                                note=f"cur_snap={cur_snap} prev_snap={prev_snap}")
        rows = run(DETAIL_SQL, {"cur_snap": cur_snap.isoformat(),
                                "prev_snap": prev_snap.isoformat(),
                                "as_of_iso": ctx.iso(), **binds})
        deltas = []
        for r in rows:
            cur, prev = r["over90"], r["prev_over90"]
            if cur is None or prev is None:
                continue
            d = round(cur - prev, 1)
            if d > 0:
                deltas.append((r, d))
        total = round(sum(d for _, d in deltas), 1)
        findings = []
        if total >= p["delta_threshold_wan"]:
            top = sorted(deltas, key=lambda x: -x[1])[:5]
            share = round(sum(d for _, d in top) / total * 100)
            findings.append(Finding(
                detector=self.cfg["name"], data_date=ctx.as_of.isoformat(),
                dim_keys={"anchor_type": "customer", "anchor_id": "瓷砖|over90", "channel": None},
                metrics={"delta_wan": total, "top5_share_pct": share,
                         "current_snapshot_date": cur_snap.isoformat(),
                         "previous_snapshot_date": prev_snap.isoformat(),
                         "top_customers": [{"code": r["cust_code"], "name": r["cust_name"],
                                            "delta_wan": d} for r, d in top],
                         "abs_delta_wan": total},
                norm_score=percentile_score(total, self.cfg["norm"]["baseline_wan"])))
        return DetectResult(self.cfg["name"], "ok", findings=findings)
```

注册表追加 `ArRiskDetector`。

- [ ] **Step 4: 确认通过** → 9 PASS
- [ ] **Step 5: Commit**
```bash
git add insight/config/radar-ar_risk.json insight/detectors/ar_risk.py insight/detectors/__init__.py insight/tests/test_detectors.py
git commit -m "feat(insight): ar_risk——双侧最新快照(缺上期=insufficient_history非0)/四段两族90天+/top5集中度/快照日期入metrics" -- insight/config/radar-ar_risk.json insight/detectors/ar_risk.py insight/detectors/__init__.py insight/tests/test_detectors.py
```

---

### Task 9: target 雷达（retrospective；NULL≠0；曲线插值规则）

**Files:** Create `insight/config/radar-target.json`、`insight/detectors/target.py`；Modify `insight/detectors/__init__.py`；Test `insight/tests/test_progress.py` + test_detectors.py 追加

- [ ] **Step 1: 写失败测试**

```python
# insight/tests/test_progress.py
from datetime import date
from insight.detectors.target import time_progress_pct

CURVE = {1: 2.5, 10: 31.0, 20: 66.0, 22: 73.0, 30: 100.0}   # day → progress_pct

def test_workday_progress_2026_09_22():                      # 16 个工作日 / 22 个 → 72.7
    assert time_progress_pct(date(2026, 9, 22), "workday") == 72.7

def test_natural_day_fallback():
    assert time_progress_pct(date(2026, 9, 22), "natural") == round(22 / 30 * 100, 1)

def test_curve_exact_hit():
    assert time_progress_pct(date(2026, 9, 22), "curve", CURVE) == 73.0

def test_curve_linear_interpolation():                       # day15：31 + (66-31)*5/10 = 48.5
    assert time_progress_pct(date(2026, 9, 15), "curve", CURVE) == 48.5

def test_curve_no_later_point_clamps_to_last():              # 曲线只到 day10 → 取 10.0
    assert time_progress_pct(date(2026, 9, 28), "curve", {1: 1.0, 10: 10.0}) == 10.0

def test_curve_missing_falls_back_to_basis():                # basis=curve 但无曲线 → 自然日兜底
    assert time_progress_pct(date(2026, 9, 22), "curve", None) == 73.3
```

```python
# insight/tests/test_detectors.py（追加）
from insight.detectors.target import TargetDetector

def test_target_fires_when_behind_schedule():    # 69.4 - 72.7 = -3.3 ≤ -3.0
    det = TargetDetector.for_test()
    run = lambda sql, p=None: [{"actual_amt": 69400000.0, "target_amt": 100000000.0}]
    res = det.detect(run, CTX)
    assert len(res.findings) == 1
    m = res.findings[0].metrics
    assert m["achieve_pct"] == 69.4 and m["gap_pct"] == -3.3
    assert m["progress_basis"] == "workday"

def test_target_quiet_when_on_track():           # 75.0 - 72.7 = +2.3
    det = TargetDetector.for_test()
    run = lambda sql, p=None: [{"actual_amt": 75000000.0, "target_amt": 100000000.0}]
    assert det.detect(run, CTX).findings == []

def test_target_null_is_missing_not_zero():      # 裁定 #13
    det = TargetDetector.for_test()
    run = lambda sql, p=None: [{"actual_amt": None, "target_amt": 100000000.0}]
    res = det.detect(run, CTX)
    assert res.findings == [] and "缺数据" in res.note

def test_target_actual_zero_is_severe_and_fires():   # 真实销售 0 = 重大异常，不许跳过
    det = TargetDetector.for_test()
    run = lambda sql, p=None: [{"actual_amt": 0.0, "target_amt": 100000000.0}]
    res = det.detect(run, CTX)
    assert len(res.findings) == 1 and res.findings[0].metrics["achieve_pct"] == 0.0

def test_target_sql_guards():
    det = TargetDetector.for_test()
    seen = {}
    run = lambda sql, p=None: (seen.update(sql=sql, p=p) or [])
    det.detect(run, CTX)
    assert "org_type = '业务单位'" in seen["sql"]        # 防总分翻倍
    assert "* 10000" in seen["sql"]                       # 万元→元
    assert "stat_month <= %(cur_month_ym)s" in seen["sql"]  # 排除未来目标月
    assert seen["p"]["cur_month_ym"] == "2026-09"
    assert seen["p"]["center_set_month_ym"] == "2026-08"
```

- [ ] **Step 2: 确认失败** → FAIL
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
  "anchor": {"type": "org_channel", "org_field": null, "channel_field": null},
  "applicable_factors": ["impact", "target_gap", "persistence", "scope"],
  "params": {"gap_threshold_pct": -3.0, "progress_basis": "workday",
             "progress_curve": null, "center_set_month_lag": 1},
  "norm": {"metric": "abs_gap_wan", "baseline_wan": [500, 1500, 3000, 6000, 12000]},
  "backtest": {"point_in_time_mode": "retrospective"},
  "timeout_ms": 60000,
  "notes": "retrospective：目标表只保留当前记录，历史调整不可恢复，回测为事后模拟（裁定#8）。达成率=当月MTD实绩/当月目标；时间进度优先级=曲线>工作日>自然日（裁定 P1-4）"
}
```

```python
# insight/detectors/target.py
"""目标达成雷达（retrospective）。裁定 #13：NULL=缺数据（跳过+note），0=真实业务值
（照常参与计算——真实销售为 0 是重大异常）。"""
import calendar
from datetime import date
from ..replay_ctx import ReplayContext
from .base import DetectResult, Finding, load_config, percentile_score

def time_progress_pct(as_of: date, basis: str, curve: dict | None = None) -> float:
    """时间进度（P1-4 优先级）。curve={day: pct}：精确命中取值，两点间线性插值，
    超出最后点取最后值；basis=curve 但无曲线 → 自然日兜底（显式规则，均有测试）。"""
    days_in = calendar.monthrange(as_of.year, as_of.month)[1]
    if basis == "curve" and curve:
        pts = sorted(curve.items())
        if as_of.day <= pts[0][0]:
            return round(pts[0][1], 1)
        for (d0, p0), (d1, p1) in zip(pts, pts[1:]):
            if d0 <= as_of.day <= d1:
                v = p0 + (p1 - p0) * (as_of.day - d0) / (d1 - d0)
                return round(v, 1)
        return round(pts[-1][1], 1)
    if basis == "workday":
        wd = sum(1 for i in range(1, as_of.day + 1)
                 if date(as_of.year, as_of.month, i).weekday() < 5)
        total_wd = sum(1 for i in range(1, days_in + 1)
                       if date(as_of.year, as_of.month, i).weekday() < 5)
        return round(wd / total_wd * 100, 1)
    return round(as_of.day / days_in * 100, 1)          # natural 兜底

SQL = """
WITH actual AS (
  SELECT SUM(ambperformance) AS actual_amt
  FROM dm.dm_fin_operations_mix_sum_t
  WHERE calmonth = %(cur_month_ym)s
    AND calmonth <= %(cur_month_ym)s
    AND node_desc2 = '瓷砖事业部'
    AND data_source IN ('S','T','D','')
),
centers AS (
  SELECT DISTINCT node_name5 AS center
  FROM dm.dm_fin_operations_mix_sum_t
  WHERE calmonth = %(center_set_month_ym)s
    AND node_desc2 = '瓷砖事业部'
    AND data_source IN ('S','T','D','')
),
tgt AS (
  SELECT SUM(target_sales_amt) * 10000 AS target_amt
  FROM dm.dm_dp_api_sales_target
  WHERE stat_month = %(cur_month_ym)s
    AND stat_month <= %(cur_month_ym)s
    AND org_type = '业务单位'
    AND sales_center_code IN (SELECT center FROM centers)
)
SELECT a.actual_amt, t.target_amt FROM actual a CROSS JOIN tgt t
"""

class TargetDetector:
    def __init__(self, cfg: dict | None = None):
        self.cfg = cfg or load_config("target")

    @classmethod
    def for_test(cls):
        return cls(load_config("target"))

    def check_watermark(self, run, ctx: ReplayContext):
        from ..watermark import Dependency, check_dependency
        return [check_dependency(Dependency(**d), run, ctx) for d in self.cfg["deps"]]

    def detect(self, run, ctx: ReplayContext) -> DetectResult:
        p = self.cfg["params"]
        from ..replay_ctx import shift_month
        rows = run(SQL, {"cur_month_ym": ctx.ym(),
                         "center_set_month_ym": shift_month(ctx.as_of, -p["center_set_month_lag"])
                         .strftime("%Y-%m")})
        r = rows[0]
        if r["actual_amt"] is None or r["target_amt"] is None:
            return DetectResult(self.cfg["name"], "ok", "缺数据：actual/target 为 NULL")
        if r["target_amt"] == 0:
            return DetectResult(self.cfg["name"], "ok", "数据异常：target_amt=0")
        achieve = round(r["actual_amt"] / r["target_amt"] * 100, 1)   # actual=0 → 0.0 照常
        tp = time_progress_pct(ctx.as_of, p["progress_basis"], p["progress_curve"])
        gap = round(achieve - tp, 1)
        findings = []
        if gap <= p["gap_threshold_pct"]:
            gap_wan = abs(r["actual_amt"] - r["target_amt"] * tp / 100) / 10000
            findings.append(Finding(
                detector=self.cfg["name"], data_date=ctx.as_of.isoformat(),
                dim_keys={"anchor_type": "org_channel",
                          "anchor_id": "瓷砖事业部|ALL", "channel": None},
                metrics={"achieve_pct": achieve, "time_pct": tp, "gap_pct": gap,
                         "abs_gap_wan": round(gap_wan),
                         "progress_basis": p["progress_basis"]},
                norm_score=percentile_score(gap_wan, self.cfg["norm"]["baseline_wan"])))
        return DetectResult(self.cfg["name"], "ok", findings=findings)
```

注册表追加 `TargetDetector`。

- [ ] **Step 4: 确认通过** `python -m pytest insight/tests/ -v` → 全 PASS
- [ ] **Step 5: Commit**
```bash
git add insight/config/radar-target.json insight/detectors/target.py insight/detectors/__init__.py insight/tests/test_detectors.py insight/tests/test_progress.py
git commit -m "feat(insight): target——NULL缺数据/0真实值两分/曲线插值规则显式/中心集IN防0关联/retrospective标记" -- insight/config/radar-target.json insight/detectors/target.py insight/detectors/__init__.py insight/tests/test_detectors.py insight/tests/test_progress.py
```

---

### Task 10: backtest.py（值解析式 point-in-time / 确定性 / exact-retrospective）

**Files:** Create `insight/backtest.py`；Test `insight/tests/test_backtest.py`

- [ ] **Step 1: 写失败测试**

```python
# insight/tests/test_backtest.py
from datetime import date
import pytest
from insight.backtest import assert_point_in_time, run_window

def _fake_run_log():
    log = []
    def run(sql, params=None):
        log.append((sql, params)); return []
    return run, log

def test_point_in_time_covers_all_date_like_params():    # 裁定 #7：不止 data_date
    as_of = date(2025, 9, 30)
    assert_point_in_time({"data_date": "20250901"}, as_of)          # ok
    assert_point_in_time({"cur_month_ym": "2025-09"}, as_of)        # ok（=月内）
    assert_point_in_time({"as_of_iso": "2025-09-30"}, as_of)        # ok
    with pytest.raises(AssertionError):
        assert_point_in_time({"cur_month_ym": "2025-10"}, as_of)    # 下个月 → 拒
    with pytest.raises(AssertionError):
        assert_point_in_time({"d1": "2025-10-05"}, as_of)
    assert_point_in_time({"limit": 5}, as_of)                       # 非日期参数不误伤
    assert_point_in_time({"comp_codes": ["X1"]}, as_of)

def test_replay_bounds_every_query_to_window_end():
    run, log = _fake_run_log()
    run_window(run, start=date(2025, 9, 1), end=date(2025, 9, 30), step_days=7,
               detectors=["region_sales"])
    for _, params in log:
        for v in params.values():
            s = str(v)
            if len(s) == 8 and s.isdigit():        # YYYYMMDD
                assert s <= "20250930"
            elif len(s) == 10 and s[4] == "-":
                assert s <= "2025-09-30"

def _fixture_run():     # 按 SQL 内容分派：region 三月连降 / target 落后 → 必产 findings
    def run(sql, params=None):
        if "ct_sales_performance_t" in sql:
            months = [f"{s[:4]}-{s[4:6]}" for s in params["month_ends"]]
            return [{"month": m, "org_name": "华南营销中心", "channel": "GD01",
                     "cur_amt": 26660000.0, "ly_amt": 30000000.0} for m in months]
            # v2.1 勘误：金额抬到生产量级（ly=3000万 ≥ min_ly_amt 2000万）——
            # 原玩具金额 10135 会被生产下限闸静默吞掉，determinism 测试假失败
        if "sales_target" in sql:
            return [{"actual_amt": 69400000.0, "target_amt": 100000000.0}]
        return []
    return run

def test_determinism_and_mode_tagging():
    a = run_window(_fixture_run(), date(2025, 9, 1), date(2025, 9, 15), 7,
                   ["region_sales", "target"])
    b = run_window(_fixture_run(), date(2025, 9, 1), date(2025, 9, 15), 7,
                   ["region_sales", "target"])
    assert a == b and a                             # 同窗二跑逐字段一致且非空
    modes = {r["detector"]: r["point_in_time_mode"] for r in a}
    assert modes.get("region_sales") == "exact"
    assert modes.get("target") == "retrospective"
```

- [ ] **Step 2: 确认失败** → FAIL
- [ ] **Step 3: 实现**

```python
# insight/backtest.py
"""历史重放（spec §17 + 裁定 #6/#7/#8）。

- point-in-time：值解析式守卫——任何"可解析为日期"的绑定参数（YYYYMMDD / YYYY-MM-DD /
  YYYY-MM）都必须 <= as_of（date 空间比较，杜绝混合格式字符串字典序）
- 确定性：同窗二跑 findings 逐字段一致（测试断言）
- 分级：每行携带 detector 的 point_in_time_mode（exact / retrospective）
- 执行纪律（§14）：手动触发、非业务高峰、调用方逐月调用（无 --month-batch，裁定 #16）
用法：python -m insight.backtest --start 2025-10-01 --end 2025-10-31
"""
import argparse
import json
from datetime import date, datetime, timedelta

from .detectors import REGISTRY
from .dws import DwsQueryRunner
from .replay_ctx import ReplayContext

_FORMATS = ("%Y%m%d", "%Y-%m-%d", "%Y-%m")

def _parse_date(v):
    if not isinstance(v, str):
        return None
    for f in _FORMATS:
        try:
            return datetime.strptime(v, f).date()
        except ValueError:
            continue
    return None

def assert_point_in_time(params: dict, as_of: date) -> None:
    for k, v in params.items():
        d = _parse_date(v)
        if d is not None and d > as_of:
            raise AssertionError(f"look-ahead：参数 {k}={v} 晚于 as_of {as_of}")

class BoundedRunner:
    def __init__(self, inner, as_of: date):
        self.inner, self.as_of = inner, as_of

    def __call__(self, sql: str, params: dict | None = None):
        p = dict(params or {})
        assert_point_in_time(p, self.as_of)
        return self.inner(sql, p)

def run_window(run, start: date, end: date, step_days: int, detectors: list[str]) -> list[dict]:
    out = []
    d = start
    while d <= end:
        ctx = ReplayContext(as_of=d)
        for name in detectors:
            det = REGISTRY[name]()
            res = det.detect(BoundedRunner(run, d), ctx)
            for f in res.findings:
                out.append({"data_date": f.data_date, "detector": f.detector,
                            "anchor": f.dim_keys["anchor_id"],
                            "norm_score": f.norm_score, "metrics": f.metrics,
                            "point_in_time_mode": det.cfg["backtest"]["point_in_time_mode"]})
        d += timedelta(days=step_days)
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", required=True, help="YYYY-MM-DD")
    ap.add_argument("--end", required=True, help="YYYY-MM-DD（含）")
    ap.add_argument("--detectors", default="region_sales,gross_margin,ar_risk,target")
    ap.add_argument("--out", default="insight/backtest_results.jsonl")
    a = ap.parse_args()
    start = date.fromisoformat(a.start); end = date.fromisoformat(a.end)
    runner = DwsQueryRunner(app_name="insight-backtest", timeout_ms=300000)
    try:
        with open(a.out, "a", encoding="utf-8") as fh:
            for row in run_window(runner, start, end, 7, a.detectors.split(",")):
                fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    finally:
        runner.close()
    print(f"backtest done → {a.out}")

if __name__ == "__main__":
    main()
```

- [ ] **Step 4: 确认通过** → 3 PASS
- [ ] **Step 5: Commit**
```bash
git add insight/backtest.py insight/tests/test_backtest.py
git commit -m "feat(insight): backtest——值解析式point-in-time全参守卫/同窗确定性/逐行exact-retrospective标记/无伪month-batch" -- insight/backtest.py insight/tests/test_backtest.py
```

---

### Task 11: live 口径验证（INSIGHT_LIVE 门禁）+ 首轮回测 runbook

**Files:** Create `insight/tests/live_caliber_test.py`

- [ ] **Step 1: 写 live 测试（默认 SKIP）**

```python
# insight/tests/live_caliber_test.py
"""直连 DWS 的口径与防护实测（默认 SKIP，仿 EVAL_LIVE 先例）。
运行：INSIGHT_LIVE=1 DWS_PASSWORD=... python -m pytest insight/tests/live_caliber_test.py -v"""
import os
import psycopg2
import pytest

pytestmark = pytest.mark.skipif(os.environ.get("INSIGHT_LIVE") != "1",
                                reason="INSIGHT_LIVE 未设置（防误连生产 DWS）")

@pytest.fixture
def run():
    from insight.dws import DwsQueryRunner
    r = DwsQueryRunner(app_name="insight-livecheck", timeout_ms=120000)
    yield r
    r.close()

def test_session_really_readonly():      # 裁定 #2/#3：第一层墙的真实性
    from insight.dws import build_connect_kwargs
    conn = psycopg2.connect(**build_connect_kwargs(app_name="insight-livecheck"))
    try:
        with pytest.raises(psycopg2.Error):
            with conn.cursor() as cur:
                cur.execute("UPDATE dm.dm_dp_api_sales_target SET target_sales_amt = 1 "
                            "WHERE 1 = 0")     # 零行 UPDATE：非只读会静默成功
    finally:
        conn.close()

def test_statement_timeout_real_behavior():    # 裁定 #3：真超时，非 SHOW 配置值
    from insight.dws import DwsQueryRunner
    r = DwsQueryRunner(app_name="insight-livecheck", timeout_ms=800)
    try:
        with pytest.raises(psycopg2.errors.QueryCanceled):
            r("SELECT pg_sleep(3)")            # 只读、可控、必超时
        assert r("SELECT 1 AS ok")[0]["ok"] == 1   # 恢复后连接可用（aborted 已清）
    finally:
        r.close()

def test_ct_ly_column_exists(run):
    cols = run("""SELECT column_name FROM information_schema.columns
                  WHERE table_schema='dm' AND table_name='ct_sales_performance_t'
                    AND column_name LIKE 'last_year%'""")
    names = [c["column_name"] for c in cols]
    assert any("achievement" in n for n in names), \
        f"同比列名不符——改 radar-region_sales.json params.ly_field。实际：{names[:10]}"

def test_target_center_coverage(run):
    """目标↔mix 中心集覆盖率（0/143 陷阱生死验证）。<90% → 停，升级用户裁决。"""
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

def test_ar_comp_codes_filled(run):     # 裁定 #15：唯一占位强制回填
    from insight.detectors.base import load_config
    assert "PLACEHOLDER" not in str(load_config("ar_risk")["params"]["comp_codes"]), \
        "comp_codes 未回填：读 sources-of-truth/business-context/ 公司主数据，"
        "列出瓷砖事业部分公司 comp_code 写入 radar-ar_risk.json 后重跑"

def test_mix_actual_rows_current_month(run):
    rows = run("""SELECT COUNT(*) AS c FROM dm.dm_fin_operations_mix_sum_t
                  WHERE calmonth = to_char(current_date, 'YYYY-MM')
                    AND node_desc2 = '瓷砖事业部' AND data_source IN ('S','T','D','')""")
    assert rows[0]["c"] > 0, "当月瓷砖实绩 0 行——检查 data_source/事业部枚举"
```

- [ ] **Step 2: 离线确认默认 SKIP** → 6 SKIPPED
- [ ] **Step 3: live 跑通（非业务高峰）**

`INSIGHT_LIVE=1 DWS_PASSWORD=$DWS_PASSWORD python -m pytest insight/tests/live_caliber_test.py -v` → 6 PASS。失败处置：`test_ct_ly_column_exists` → 改 config `ly_field`；`test_target_center_coverage` → **停，登记口径分歧升级用户**；`comp_codes` → 回填后复跑。

- [ ] **Step 4: 首轮回测（人工逐月，裁定 #16）**

```bash
DWS_PASSWORD=$DWS_PASSWORD python -m insight.backtest --start 2025-10-01 --end 2025-10-31 \
  --out insight/backtest_results.jsonl
# 其余 11 个月逐月推进（每条命令一个自然月；禁止连跑 12 个月——§14 错峰纪律）
# 同月二跑 diff 校验确定性：两次输出 sort 后 diff 为空
```

- [ ] **Step 5: Commit**
```bash
git add insight/tests/live_caliber_test.py
git commit -m "test(insight): live口径实测——session只读零行UPDATE验证/timeout真实行为+恢复/ct同比列/目标中心覆盖率/comp_codes守卫" -- insight/tests/live_caliber_test.py
```

---

## M-i1 Exit（验收出口，11 条）

1. 四雷达确定性 SQL 全部完成（完整自然月口径）
2. 四雷达 live caliber 验证通过
3. `comp_codes` 唯一占位真实回填
4. watermark 空表/滞后/未来行防线通过
5. readonly / timeout / rollback / connection recovery 测试通过
6. 历史 detection replay 可稳定执行
7. 同一历史窗口重复执行 findings 确定性一致
8. 每个 detector threshold 完成第一轮校准（回测产物驱动，config 留变更台账）
9. point_in_time_mode exact / retrospective 状态明确（回测产物逐行携带）
10. 无新增代码影响现有 AI 问数链路（本计划零修改既有文件）
11. DWS 实测未发现 insight 查询对在线问数造成明显资源干扰（application_name 可观测）

**M-i2 Exit（另行出计划，职责与本计划彻底分家）**：merge compatibility / stable anchor 事件化 / event lifecycle / ranking / Top 0-3 / daily brief 快照 / 12 个月 Top3 回放 / 用户抽检"值得高管看"认可率 ≥80%。**M-i1 不负责 Top3 认可率**（裁定 #17）。

## Self-Review（17 项逐条结论）

| # | 检查项 | 结论 |
|---|---|---|
| 1 | SQL 占位符统一 psycopg2 原生 `%(x)s` | ✅ watermark/四雷达/backtest/测试断言全部 `%(x)s`；无转换器；测试显式断言 `":data_date" not in sql` |
| 2 | QueryRunner 仅 SELECT / WITH…SELECT，禁写与 SHOW | ✅ `_guard` 首词白名单 + 全句禁词正则；11 条负面用例含 SHOW 与数据改性 CTE |
| 3 | session 真正 readonly | ✅ 连接 options `default_transaction_read_only=on`；live 零行 UPDATE 必须抛错 |
| 4 | timeout 后 transaction/connection 可恢复 | ✅ `_recover` 统一收尾；单测覆盖 aborted→rollback→下一查询可用、连接失效→重建；live 真超时+恢复 |
| 5 | canonical date 统一 | ✅ `ReplayContext(as_of: date)` 全层唯一日期载体；detector 签名 `detect(run, ctx)` |
| 6 | dependency 格式由 Dependency 自转 | ✅ `Dependency.fmt/parse`；watermark 测试断言 calday/iso 两种绑定 |
| 7 | backtest 无混合格式字符串比较 | ✅ 唯一比较点 `assert_point_in_time` 先 `_parse_date` 回 date 空间 |
| 8 | point-in-time 覆盖月/日型参数 | ✅ 值解析式：`cur_month_ym`/`d1`/`as_of_iso` 等任何可解析日期参数全覆盖（测试含正反例） |
| 9 | exact / retrospective 区分 | ✅ config `backtest.point_in_time_mode`，回测逐行携带；target=retrospective 在 config notes 声明原因 |
| 10 | AR / Target 单测数学与实现一致 | ✅ AR 7 客户 980/95% 重算一致；Target 测试不再伪造 time_pct，期望值由实现同款公式推得（69.4-72.7=-3.3） |
| 11 | AR 缺上期快照不当 0 | ✅ 双侧 `MAX(query_date)` 最新快照；缺失 → `insufficient_history` + note，不发 finding；快照日期入 metrics |
| 12 | detect() 只返回越阈 Finding | ✅ 契约收紧：`Finding.threshold_passed` 恒 True，未越阈不构造；`DetectResult` 承载 status/note |
| 13 | Target actual=0 不误判空数据 | ✅ `is None` 与 `== 0` 两分；actual=0 → achieve 0.0 → 触发 finding（测试覆盖）；target=0 → note 数据异常 |
| 14 | region_sales 仅完整自然月月末快照 | ✅ `completed_month_ends`；当前月不参与（9-22 → 6/7/8 月，测试断言绑定值）；config/注释/runbook 统一措辞；周/旬移出 M-i1 |
| 15 | --month-batch 假实现已删 | ✅ 无该参数与 `_months/_m_first/_m_last`；runbook=人工逐月调用 |
| 16 | 除 comp_codes 外无 TBD/TODO/stub/占位 | ✅ 全文扫描：唯一占位=comp_codes（Task 11 守卫强制回填）；所有代码块均为正式版，无草稿/标废块 |
| 17 | M-i1 与 M-i2 验收职责分开 | ✅ M-i1 Exit 11 条不含 merge/ranking/Top3/认可率；M-i2 Exit 单列 |

## 交付边界

M-i1 完成 ≠ 简报可用（排序/事件/发布/UI 属 M-i2/M-i3 计划）。阈值第一轮校准由回测产物驱动（config 改动走"重跑回测+台账"纪律）。
