# 费用明细 / 综合科目表

## 快速参考

- **DWS 表名**：`dwrfin.dwr_fin_cost_d_compre_subj_t`
- **业务含义**：核算各成本中心、WBS、销售订单的实际费用发生额，含 TMS 运费和 SAP 调整值。财务费用域最核心的单表。
- **实体粒度**：一行 = 一条费用记账行（凭证行项目）在特定科目 + 成本对象 + 期间上的聚合
- **列数**：45 列
- **脚本位置**：`DWR/FIN/COST/PJob_DWR_FIN_COST_D_COMPRE_SUBJ_T.txt`
- **最近变更**：2026-01-15 代码优化，2025-12-22 新增 `fin_voucher_ref`

## 核心字段

| DWS 字段 | 离线脚本对应 | 含义 | 注意事项 |
|---|---|---|---|
| year | GJAHR | 会计年度 | character varying，格式 YYYY |
| month | PERDE | 期间 | character varying，格式 YYYY-MM |
| voucher_date | BLDAT | 凭证日期 | timestamp |
| posting_date | BUDAT | 过账日期 | timestamp |
| fin_voucher_code | | 财务凭证号 | |
| fin_voucher_line_code | | 凭证行项目号 | |
| cost_center_code | KOSTL | 成本中心编码 | |
| cost_center_desc | | 成本中心描述 | |
| func_scope_code | | 功能范围编码 | |
| func_scope_name | | 功能范围名称 | |
| general_ledger_account | HKONT | 总账科目 | **科目 61602000 有特殊处理**，注意 LPAD 对齐 |
| general_ledger_account_desc | | 总账科目描述 | |
| sales_group_code | SALES_GRP | 销售组编码 | 2023-11-24 修正取值逻辑 |
| sales_group_desc | | 销售组描述 | |
| wbs | POSID | WBS 编码 | ACDOCA 表取值，2023/09/26 逻辑修改过 |
| wbs_desc | | WBS 描述 | |
| comp_code | | 公司编码 | |
| comp_desc | | 公司描述 | |
| sales_org_code | | 销售组织 | |
| channel_code | | 渠道编码 | |
| material_code | | 物料编码 | |
| material_desc | | 物料描述 | |
| cust_code | | 客户编码 | |
| cust_name | | 客户名称 | |
| supplier_code | | 供应商编码 | |
| supplier_name | | 供应商名称 | |
| qty | | 数量 | numeric |
| local_currency_amt | DMBTR | 本位币金额 | numeric，**最常用作费用金额** |
| manual_adjust_amt | | 手工调整金额 | numeric，2025-05-07 新增 SAP 调整值 |
| sum_amt | | 合计金额 | numeric |
| origin_currency_amt | | 原始币种金额 | numeric |
| profit_center_code | | 利润中心编码 | |
| profit_center_desc | | 利润中心描述 | |
| item_text | SGTXT | 行项目文本 | 2024-01-23 新增 |
| allocation | ZUONR | 分配 | 2024-01-23 新增 |
| doc_number | VBELN | 销售订单号 | 2025-03-05 新增 |
| bill_num | BELNR | 发票号 | 2025-03-05 新增 |
| fin_voucher_ref | | 凭证参考 | 2025-12-22 新增 |
| vkgrp_pa | | PA 销售组 | |
| dw_last_update_date | | DW 最后更新日期 | timestamp |

## 陷阱

1. **科目 61602000 特殊处理**：直接读成本中心主档取数据，不走默认逻辑。此规则在 2024-03-23 新增，2024-04-04 明确为最高优先级。该科目的 `general_ledger_account` 字段值需 LPAD 对齐。
2. **销售组编码历史问题**：2023-11-24 之前的数据取值有误，跨此时间点分析需注意口径一致性。
3. **增量条件变更**：2024-04-03 修改过增量读取条件。
4. **SAP 调整值**：2025-05-07 新增 `manual_adjust_amt` 字段，2025-06-02 改为取功能范围。历史期间无此数据。
5. **TMS 运费**：2025-03-05 新增读取 TMS 运费逻辑，此前无运费数据。
6. **DWS 中该表有多个备份**：`_260331_wjh`, `_20240326`, `_20260429` 等。查询时务必用主表名，不要用备份表。

## 常用查询模式

### 按成本中心 + 科目汇总当月费用
```sql
SELECT 
    cost_center_code, cost_center_desc,
    general_ledger_account, general_ledger_account_desc,
    SUM(local_currency_amt) as total_amount
FROM dwrfin.dwr_fin_cost_d_compre_subj_t
WHERE year = '2026' AND month = '06'
GROUP BY cost_center_code, cost_center_desc,
         general_ledger_account, general_ledger_account_desc
ORDER BY total_amount DESC;
```

### 按功能范围汇总费用趋势
```sql
SELECT year, month, func_scope_name,
       SUM(local_currency_amt) as total
FROM dwrfin.dwr_fin_cost_d_compre_subj_t
WHERE year >= '2025'
GROUP BY year, month, func_scope_name
ORDER BY year, month;
```

### 查询特定科目的费用明细
```sql
SELECT year, month, voucher_date, cost_center_code,
       cost_center_desc, general_ledger_account_desc,
       local_currency_amt, item_text, doc_number, bill_num
FROM dwrfin.dwr_fin_cost_d_compre_subj_t
WHERE general_ledger_account = '61602000'
  AND year = '2025'
ORDER BY year, month, voucher_date
LIMIT 100;
```

## 交叉引用

- DM 层费用事实表（更丰富维度）→ [finance-cost-fact.md](finance-cost-fact.md)
- 成本中心主数据 → [cost-center-master.md](cost-center-master.md)
- 成本要素/科目 → [cost-elements.md](cost-elements.md)
- 销售毛利 → [gross-profit.md](gross-profit.md)
- 数据血缘 → [data-lineage.md](data-lineage.md)
