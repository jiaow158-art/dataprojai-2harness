import os
import psycopg2, json

PROJ_DIR = os.path.dirname(os.path.abspath(__file__))

conn = psycopg2.connect(
    host=os.environ.get('DWS_HOST', '121.37.200.214'),
    port=int(os.environ.get('DWS_PORT', '8000')),
    dbname=os.environ.get('DWS_DBNAME', 'DP_DWS'),
    user=os.environ.get('DWS_USER', 'aiuser'),
    password=os.environ.get('DWS_PASSWORD', ''),
    connect_timeout=15)
conn.set_client_encoding('UTF8')
cur = conn.cursor()

cur.execute("""
    SELECT table_schema, table_name FROM information_schema.tables
    WHERE table_schema IN ('dm','dwrfin') AND table_type='BASE TABLE'
    AND table_name NOT LIKE '%_bak%' AND table_name NOT LIKE '%_tmp%'
    AND table_name NOT LIKE '%_test%' AND table_name NOT LIKE '%_202%'
    ORDER BY table_schema, table_name
""")
tables = [(r[0], r[1]) for r in cur.fetchall()]

categories = {
    '财务-费用成本': ['cost', 'expense', 'reimburse', 'travel', 'trvapp', 'budget',
                      'gl_account', 'ledger', 'contract', 'occupy'],
    '财务-应收': ['receivable', 'ar_', 'collection', 'credit', 'devalue', 'bill_aging'],
    '财务-应付': ['payable', 'ap_', 'supplier_trans'],
    '财务-总账': ['gl_', 'account_vouch', 'general_ledger', 'voucher'],
    '财务-税务': ['tax', 'invoice'],
    '财务-利润': ['profit', 'gross_margin', 'ambv2', 'income', 'operat_profit'],
    '财务-资产': ['asset', 'fixed', 'depreciat', 'amortiz'],
    '财务-资金': ['capital', 'fund', 'cash', 'bank'],
    '销售-订单': ['sales_order', 'so_fzl', 'order_det', 'order_stat', 'order_plan', 'sale_order'],
    '销售-发货': ['delivery', 'ship', 'dispatch', 'deliver', 'no_deliver'],
    '销售-目标': ['target', 'forecast', 'achievement', 'perform'],
    '销售-渠道客户': ['channel', 'retail', 'store', 'dealer', 'customer', 'cust_'],
    '库存-仓储': ['inventory', 'stock', 'warehouse', 'wm_', 'storage', 'transit', 'prepare_stock'],
    '库存-出入库': ['inout', 'outstock', 'instock', 'out_in'],
    '采购-供应链': ['purchase', 'pur_', 'supplier', 'procure', 'pam_'],
    '制造-生产': ['factory', 'prodc', 'bom', 'schedule', 'energy'],
    '质量': ['quality', 'defect', 'inspection', 'fleeing'],
    '物流-TMS': ['tms', 'transport', 'logistics', 'tra_', 'reservation', 'scan'],
    '人事-HR': ['hr_', 'emp', 'employee', 'dept', 'organiz', 'perf', 'ases'],
    '流程-审批': ['wf_', 'approval', 'flow', 'request', 'consuming'],
    '主数据-维度': ['dim_', 'general_config', 'level_structure', 'company_d', 'date_d'],
    'CRM': ['crm', 'dmt_', 'cust_stat', 'cust_info'],
}

cat_map = {}
for schema, name in tables:
    nl = name.lower()
    best_cat = None
    best_score = 0
    for cat, patterns in categories.items():
        score = sum(1 for p in patterns if p in nl)
        if score > best_score:
            best_score = score
            best_cat = cat
    if best_cat is None:
        best_cat = '其他'
    if best_cat not in cat_map:
        cat_map[best_cat] = []
    cat_map[best_cat].append(f'{schema}.{name}')

results = []
for cat in sorted(cat_map.keys()):
    items = cat_map[cat]
    schemas = list(set(x.split('.')[0] for x in items))
    results.append({
        'domain': cat,
        'count': len(items),
        'schemas': schemas,
        'samples': items[:10],
    })

with open(os.path.join(PROJ_DIR, 'domain_categories.json'), 'w', encoding='utf-8') as f:
    json.dump(results, f, ensure_ascii=False, indent=2)

for c in results:
    schemas_str = ', '.join(c['schemas'])
    print(f"{c['domain']:20s} {c['count']:>5} tables  ({schemas_str})")
    for s in c['samples'][:5]:
        print(f'  - {s}')
    if c['count'] > 5:
        remaining = c['count'] - 5
        print(f'  ... +{remaining} more')
    print()

conn.close()
print('Done. Results also in domain_categories.json')
