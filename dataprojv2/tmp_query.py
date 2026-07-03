import psycopg2, io, sys
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

conn = psycopg2.connect(host='121.37.200.214', port='8000', dbname='DP_DWS', user='aiuser', password='Dp123456')
cur = conn.cursor()

def fmt(n):
    if n is None: return '0'
    return f'{n:,.0f}'

def pct(a, b):
    if b is None or b == 0: return 'N/A'
    return f'{(a-b)/b*100:+.1f}%'

# 1. Mix table: Jan-Jun monthly actual + budget
print('=== 瓷砖事业部 2026上半年 月度达成+预算 ===')
cur.execute("""
SELECT calmonth,
       SUM(ambperformance) as actual,
       SUM(ambperformance_ys) as budget,
       SUM(notax_sales_net_amt) as notax,
       SUM(s_zxsmj) as area
FROM dm.dm_fin_operations_mix_sum_t
WHERE calmonth BETWEEN '2026-01' AND '2026-06'
  AND node_desc2 = '瓷砖事业部'
  AND data_source IN ('S', 'T', 'D', '')
GROUP BY calmonth
ORDER BY calmonth
""")
for r in cur.fetchall():
    print(f'{r[0]}: 达成={fmt(r[1])}  预算={fmt(r[2])}  偏差={pct(r[1], r[2])}  不含税={fmt(r[3])}  面积={fmt(r[4])}')

# 2. Performance table: YoY
print()
print('=== 业绩表 同比 ===')
cur.execute("""
SELECT LEFT(p.calday, 6) as mon,
       SUM(p.month_achievement) as actual,
       SUM(p.last_year_month_achievement) as ly
FROM dm.ct_sales_performance_t p
JOIN dm.dm_rpt_sales_group_t s ON p.org_code = s.node_name10
WHERE p.calday IN ('20260131','20260228','20260331','20260430','20260531','20260630')
  AND s.node_desc2 = '瓷砖事业部'
GROUP BY LEFT(p.calday, 6)
ORDER BY mon
""")
for r in cur.fetchall():
    yoy = (r[1] - r[2]) / r[2] * 100 if r[2] and r[2] != 0 else 0
    print(f'{r[0]}: 达成={fmt(r[1])}  去年={fmt(r[2])}  同比={yoy:+.1f}%')

# 3. Cumulative H1
print()
print('=== 上半年累计汇总 ===')
cur.execute("""
SELECT
  SUM(CASE WHEN calmonth <= '2026-05' THEN ambperformance ELSE 0 END) as h1_actual_may,
  SUM(CASE WHEN calmonth <= '2026-05' THEN ambperformance_ys ELSE 0 END) as h1_budget_may,
  SUM(CASE WHEN calmonth = '2026-06' THEN ambperformance ELSE 0 END) as jun_actual,
  SUM(CASE WHEN calmonth = '2026-06' THEN ambperformance_ys ELSE 0 END) as jun_budget
FROM dm.dm_fin_operations_mix_sum_t
WHERE calmonth BETWEEN '2026-01' AND '2026-06'
  AND node_desc2 = '瓷砖事业部'
  AND data_source IN ('S', 'T', 'D', '')
""")
r = cur.fetchone()
print(f'1-5月达成: {fmt(r[0])}  1-5月预算: {fmt(r[1])}  偏差: {pct(r[0], r[1])}')
print(f'6月(至今)达成: {fmt(r[2])}  6月预算: {fmt(r[3])}')

# 4. H1 target (from target table)
print()
print('=== 目标达成率 ===')
cur.execute("""
SELECT SUM(target_sales_amt) * 10000 as target_yuan
FROM dm.dm_dp_api_sales_target
WHERE stat_year = '2026'
  AND stat_month BETWEEN '2026-01' AND '2026-06'
  AND org_type = '业务单位'
  AND sales_center_code IN (
    SELECT DISTINCT node_name5 FROM dm.dm_fin_operations_mix_sum_t
    WHERE node_desc2 = '瓷砖事业部' AND calmonth = '2026-05'
  )
""")
r = cur.fetchone()
print(f'上半年目标(万元转元): {fmt(r[0])}')

# 5. Channel breakdown H1
print()
print('=== 渠道 1-6月 ===')
cur.execute("""
SELECT integrate_channel, integrate_channel__t,
       SUM(ambperformance) as actual,
       SUM(ambperformance_ys) as budget
FROM dm.dm_fin_operations_mix_sum_t
WHERE calmonth BETWEEN '2026-01' AND '2026-06'
  AND node_desc2 = '瓷砖事业部'
  AND data_source IN ('S', 'T', 'D', '')
  AND integrate_channel IN ('GD01','GD02','GD03')
GROUP BY integrate_channel, integrate_channel__t
ORDER BY actual DESC
""")
for r in cur.fetchall():
    print(f'{r[0]} {r[1]:8s}: 达成={fmt(r[2])}  预算={fmt(r[3])}  偏差={pct(r[2], r[3])}')

cur.close()
conn.close()
