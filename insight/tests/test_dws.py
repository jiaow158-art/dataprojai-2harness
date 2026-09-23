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

def test_kwargs_defaults(monkeypatch):
    monkeypatch.delenv("DWS_HOST", raising=False)
    kw = build_connect_kwargs()
    assert kw["host"] == "121.37.200.214" and kw["dbname"] == "DP_DWS"

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
