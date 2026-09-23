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
