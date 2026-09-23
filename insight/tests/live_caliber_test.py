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
    # 本库锁死 read-only GUC，实测验证的是账号授权墙；零行 UPDATE 非只读会静默成功
    from insight.dws import build_connect_kwargs
    conn = psycopg2.connect(**build_connect_kwargs(app_name="insight-livecheck"))
    try:
        with pytest.raises(psycopg2.errors.InsufficientPrivilege):
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
        "comp_codes 未回填：读 sources-of-truth/business-context/ 公司主数据，" \
        "列出瓷砖事业部分公司 comp_code 写入 radar-ar_risk.json 后重跑"

def test_mix_actual_rows_current_month(run):
    rows = run("""SELECT COUNT(*) AS c FROM dm.dm_fin_operations_mix_sum_t
                  WHERE calmonth = to_char(current_date, 'YYYY-MM')
                    AND node_desc2 = '瓷砖事业部' AND data_source IN ('S','T','D','')""")
    assert rows[0]["c"] > 0, "当月瓷砖实绩 0 行——检查 data_source/事业部枚举"


def test_ar_sgl_filter_matches_rows(run):       # ★ T8 Critical 级防复发：过滤形态必须非 0 行
    rows = run("""
      SELECT COUNT(*) AS c FROM dwrfin.dwr_ar_receivable_aging_2023_info_f
      WHERE (special_general_ledger IS NULL OR special_general_ledger = '')
        AND query_date = (SELECT MAX(query_date)
                          FROM dwrfin.dwr_ar_receivable_aging_2023_info_f
                          WHERE query_date <= to_char(current_date, 'YYYY-MM-DD'))""")
    assert rows[0]["c"] > 0, "sgl 正常口径过滤 0 行——过滤形态又坏了（Oracle A 兼容 ''≡NULL）"

def test_ar_snapshot_integrity(run):            # ★ 半载快照检测（06:31 批载中不可信当日数）
    rows = run("""
      WITH snaps AS (
        SELECT query_date, COUNT(*) AS c
        FROM dwrfin.dwr_ar_receivable_aging_2023_info_f
        WHERE query_date <= to_char(current_date, 'YYYY-MM-DD')
          AND (special_general_ledger IS NULL OR special_general_ledger = '')
        GROUP BY 1 ORDER BY 1 DESC LIMIT 2)
      SELECT MIN(c) AS lo, MAX(c) AS hi FROM snaps""")
    r = rows[0]
    assert r["lo"] and r["hi"] and r["lo"] >= r["hi"] * 0.5, \
        f"最新快照行数 {r['lo']} 不足上一份 {r['hi']} 的 50%——疑似批载中/半载，当日 ar 数不可信"

def test_mix_null_channel_share_low(run):       # ★ T7 minor：NULL 渠道占比探针
    # FILTER (WHERE ...) 本 GaussDB 不支持（实测 syntax error）→ SUM(CASE) 等价便携写法
    rows = run("""
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN integrate_channel IS NULL THEN 1 ELSE 0 END) AS null_ch
      FROM dm.dm_fin_operations_mix_sum_t
      WHERE calmonth = to_char(current_date, 'YYYY-MM')
        AND node_desc2 = '瓷砖事业部' AND data_source IN ('S','T','D','')""")
    r = rows[0]
    share = (r["null_ch"] or 0) / r["total"] if r["total"] else 0
    assert share < 0.1, f"NULL 渠道占比 {share:.1%} 异常——gross_margin 锚会聚成 瓷砖事业部|None 巨桶"
