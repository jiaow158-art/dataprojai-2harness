# 逾期监控 / 回款明细

## 快速参考

| 场景 | DWS 表 | 行数 | 列数 | 时间字段 |
|------|--------|------|------|----------|
| 逾期监控 | `dm.dm_ar_overdue_receivables_t` | 3,133,955 | 32 | ed_mon (YYYYMM) |
| 回款明细 | `dwrfin.dwr_ar_collection_detail_f` | 12,873,369 | 31 | year + month |
| 回款(月汇总) | `dm.dm_ar_return_payment_t` | 1,792,544 | 21 | calmonth (YYYYMM) |

## dm_ar_overdue_receivables_t 字段

| 字段 | 含义 |
|------|------|
| ed_mon | 统计月份 (YYYYMM) |
| comp_code | 公司代码 |
| c_num / c_name | 客户编号/名称 |
| sales_grp / sales_grp___t | 销售组 |
| lev2_name ~ lev6_name | 层级2~6 名称 |
| wbs_num | WBS 编号 |
| ysye | 应收余额 |
| yqe | 逾期额 |
| spje | 审批金额 |
| yqsp | 逾期审批 |
| zysjz | 应收账款净值 |
| bf_zysjz_1 | 应收账款净值(备1) |
| zyspjjz | 应收审批净值 |
| bf_zyspjjz_1 | 应收审批净值(备1) |
| yqe_yc | 逾期额预测 |
| yqsp_yc | 逾期审批预测 |
| zddk | 最大贷款额 |
| bhszyywsr_j11/j12 | 不含税主营业务收入 J11/J12 |
| ys_j12/j13 | 应收 J12/J13 |
| yqhk | 逾期回款 |
| wyqhk | 未逾期回款 |
| sphk | 审批回款 |
| is_ignore | 忽略标志 |
| dw_last_update_date | 最后更新 |

## dwr_ar_collection_detail_f 字段

| 字段 | 含义 |
|------|------|
| year | 年份 |
| month | 月份 |
| comp_code / comp_name | 公司代码/名称 |
| general_ledger_account / _desc | 总账科目/描述 |
| special_general_ledger | 特别总账标志 |
| cust_code / cust_name | 客户编号/名称 |
| wbs | WBS 要素 |
| sales_group_master_file | 销售组主档案 |
| sales_group_cust_master | 客户销售组主档案 |
| business_person | 业务员 |
| posting_date | 过账日期 (timestamp) |
| voucher_date | 凭证日期 (timestamp) |
| voucher_code / voucher_item | 凭证号/行项目 |
| voucher_type | 凭证类型 |
| clear_date / clear_voucher | 清账日期/凭证 |
| **all_collection_amt** | 全部回款金额（含未匹配） |
| **collection_amt** | 已匹配回款金额 |
| **cash_collection_amt** | 现金回款 |
| **non_cash_collection_amt** | 非现金回款 |
| **non_confirm_amt** | 未确认回款 |
| **send_amt** | 发送金额 |
| **return_collection_amt** | 退货回款 |
| **non_house_collection_amt** | 非房产回款 |
| non_calculate_collection_amt | 不计入回款 |
| cust_group_code | 客户组 |
| dw_last_update_date | 最后更新 |

## dm_ar_return_payment_t 字段

| 字段 | 含义 |
|------|------|
| calmonth | 会计期间 (YYYYMM) |
| comp_code / comp_code___t | 公司 |
| debitor / debitor___t | 客户 |
| sales_grp / sales_grp___t | 销售组 |
| wbs_elemt / wbs_elemt___t | WBS 要素 |
| zhkje | 总回款金额 |
| zhkje_dadz | 档案单证回款 |
| zhkje_wqrx | 未确认回款 |
| zhkje_wqsc | 未清市场回款 |
| zhkje_wqyc | 未清预测回款 |
| zhkje_yqsc | 逾期市场回款 |
| zhkje_yqyc | 逾期预测回款 |
| sp_gl_ind | 特别总账标志 |
| db_cr_ind | 借/贷方标志 |
| zydfsp | 重要对方审批 |

## 常见查询模式

### 逾期客户排名
```sql
SELECT c_name, sales_grp___t,
       ysye as balance, yqe as overdue,
       ROUND(yqe / NULLIF(ysye, 0) * 100, 2) as overdue_pct
FROM dm.dm_ar_overdue_receivables_t
WHERE ed_mon = '202606'
  AND yqe > 0
ORDER BY yqe DESC
LIMIT 20;
```

### 回款月度趋势
```sql
SELECT year, month,
       SUM(all_collection_amt) as total_collection,
       SUM(collection_amt) as matched,
       SUM(cash_collection_amt) as cash,
       ROUND(SUM(collection_amt) / NULLIF(SUM(all_collection_amt), 0) * 100, 2) as match_rate
FROM dwrfin.dwr_ar_collection_detail_f
WHERE year = '2026'
GROUP BY year, month
ORDER BY year, month;
```

### 按客户回款 Top N
```sql
SELECT cust_code, cust_name,
       SUM(all_collection_amt) as total,
       SUM(collection_amt) as matched,
       SUM(non_confirm_amt) as unconfirmed
FROM dwrfin.dwr_ar_collection_detail_f
WHERE year = '2026' AND month = '2026-06'
GROUP BY cust_code, cust_name
ORDER BY total DESC
LIMIT 20;
```

### 回款按回款方式分类
```sql
SELECT SUM(cash_collection_amt) as cash,
       SUM(non_cash_collection_amt) as non_cash,
       SUM(return_collection_amt) as return_amt,
       SUM(non_house_collection_amt) as non_house
FROM dwrfin.dwr_ar_collection_detail_f
WHERE year = '2026' AND month = '2026-06';
```

## 陷阱

1. **回款多口径**：`collection_amt`（已匹配）≠ `all_collection_amt`（全量），默认用 `collection_amt`
2. **collection_detail_f 是大表**（1287万行）：必须带 year+month 过滤
3. **逾期表含预测**：`yqe_yc` / `yqsp_yc` 是预测数据，`ed_mon` 可能含未来月份
4. **is_ignore**：逾期表中 `is_ignore=1` 的行需要排除
5. **回款匹配率**：`non_confirm_amt` 高说明回款未及时匹配到发票，需关注
6. **跨表客户字段命名差异**：`dm_ar_overdue_receivables_t.c_num` = `dwr_ar_*_f.cust_code`（同一 SAP 客户编号，不同表字段名不同）。跨表 JOIN 客户时用 `c_num = cust_code` 关联
7. **逾期表月份字段**：列名是 `ed_mon`（不是 `edition_mon`），格式 YYYYMM 如 `'202606'`
