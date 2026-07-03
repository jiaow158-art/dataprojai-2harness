# 坏账减值 / 票据资金成本 / 周转天数

## 快速参考

| 场景 | DWS 表 | 行数 | 列数 | 时间字段 |
|------|--------|------|------|----------|
| 坏账减值 | `dwrfin.dwr_ar_credit_devalue_f` | 5,575,285 | 129 | query_date (YYYY-MM-DD) |
| 票据资金成本 | `dwrfin.dwr_ar_commercial_bill_capital_cost_f` | 1,566,703 | 20 | month (YYYY-MM) |
| 应收周转 | `dwrfin.dwr_ar_receivable_turnover_days_f` | 484 | 4 | calmonth (YYYYMM) |

## dwr_ar_credit_devalue_f 字段

### 核心维度
| 字段 | 含义 |
|------|------|
| query_date | 查询日期 (YYYY-MM-DD，带连字符) |
| comp_code | 公司 |
| cust_code / cust_name | 客户编号/名称 |
| cust_class_name | 客户分类（决定计提比例） |
| sales_group_master_file / wbs | 销售组 / WBS |
| special_general_ledger / general_ledger_account | 特别总账 / 科目 |
| currency | 币种 |
| business_department | 业务部门 |

### 应收/逾期总览
| 字段 | 含义 |
|------|------|
| local_currency_balance_sum | 本币应收余额 |
| receivable_balance_sum | 应收余额（另一个口径） |
| overdue_receivables | 逾期总额 |
| n_overdue_receivables | 未逾期总额 |
| overdue_receivables_sum | 逾期合计 |

### 减值金额 (overdue_*_amt) 和计提比例 (overdue_*_ratio)

按应收账龄（月口径）：
| 金额字段 | 比例字段 | 含义 |
|----------|----------|------|
| overdue_1_month_amt | overdue_1_month_ratio | 逾期1个月内 |
| overdue_1plus_month_amt | overdue_1plus_month_ratio | 逾期1月以上 |
| overdue_1_90_amt | overdue_1_90_ratio | 1-90天 |
| overdue_91_275_amt | overdue_91_275_ratio | 91-275天 |
| overdue_276_730_amt | overdue_276_730_ratio | 276-730天 |
| overdue_731_1460_amt | overdue_731_1460_ratio | 731-1460天 |
| overdue_1461_amt | overdue_1461_ratio | 1461天以上 |

按未逾期（n_overdue_*）：
| 金额字段 | 比例字段 | 含义 |
|----------|----------|------|
| n_overdue_0_365_amt | n_overdue_0_365_ratio | 0-365天 |
| n_overdue_366_730_amt | n_overdue_366_730_ratio | 366-730天 |
| n_overdue_731_1095_amt | n_overdue_731_1095_ratio | 731-1095天 |
| n_overdue_1096_1460_amt | n_overdue_1096_1460_ratio | 1096-1460天 |
| n_overdue_1461_amt | n_overdue_1461_ratio | 1461天以上 |

### 自然账龄 (natural_receivables_*)
| 字段 | 含义 |
|------|------|
| natural_receivables_1_90 / _91_180 / _181_275 / _276_365 / _366_730 / _731_1095 / _1095_1460 / _1461 | 自然账龄分段 |

### 应收逾清 (natoverd_receivables_*)
| 字段 | 含义 |
|------|------|
| natoverd_receivables_1_90 / _91_180 / _181_365 / _366_730 / _731_1095 / _1095_1460 / _1461 | 应收逾清分段 |

### n_natoverd_* （6口径细分）
每个自然逾期段下有 `_1`~`_6` 六个子口径，如 `n_natoverd_0_90_1` ~ `n_natoverd_0_90_6`

### 合同回款链路
| 字段 | 含义 |
|------|------|
| contract_amount | 合同金额 |
| progress_payment_ratio | 进度款比例 |
| settlement_payment_ratio | 结算款比例 |
| retention_money_ratio | 质保金比例 |
| progress_pmt | 进度款 |
| settlement_pmt | 结算款 |
| retention | 质保金 |
| customer_guarantee | 客户保证金 |
| amt_after_adv | 预付款后金额 |
| phase_payment_var | 阶段付款差异 |

---

## 常见查询模式

### 减值按账龄分段汇总
```sql
SELECT query_date,
       SUM(overdue_1_90_amt) as d_0_90,
       SUM(overdue_91_275_amt) as d_91_275,
       SUM(overdue_276_730_amt) as d_276_730,
       SUM(overdue_731_1460_amt) as d_731_1460,
       SUM(overdue_1461_amt) as d_1461_plus,
       SUM(overdue_1_90_amt + overdue_91_275_amt + overdue_276_730_amt
           + overdue_731_1460_amt + overdue_1461_amt) as total_devalue
FROM dwrfin.dwr_ar_credit_devalue_f
WHERE query_date = '2026-06-08'
GROUP BY query_date;
```

### 按客户分类减值汇总
```sql
SELECT cust_class_name,
       COUNT(DISTINCT cust_code) as cust_cnt,
       SUM(local_currency_balance_sum) as balance,
       SUM(overdue_receivables) as overdue,
       SUM(overdue_1461_amt) as d_4yr_plus,
       ROUND(AVG(overdue_1461_ratio), 2) as avg_1461_ratio
FROM dwrfin.dwr_ar_credit_devalue_f
WHERE query_date = '2026-06-08'
GROUP BY cust_class_name
ORDER BY balance DESC;
```

### 应收周转天数
⚠️ **此表数据仅到 2022-12，已停更 3 年+**。查询时间窗口必须 ≤ 2022-12。
```sql
SELECT calmonth, dept, zzts as turnover_days
FROM dwrfin.dwr_ar_receivable_turnover_days_f
WHERE calmonth >= '202201'
ORDER BY calmonth, dept;
```

## 陷阱

1. **`_sp` 后缀字段**：`natoverd_receivables_*_sp` 和 `n_natoverd_*_sp` 是审批/特殊口径，默认不用
2. **6个子口径**：`n_natoverd_*_1` 到 `_6` 是递延的细分，用于精细化减值计提
3. **比例 vs 金额**：`overdue_*_ratio` 是计提比例（小数），`overdue_*_amt` 是计提金额
4. **credit_devalue_f 129列**：列数最多但很多是交叉维度（3种账龄 × 2种逾期 × 6种子口径）
5. **turnover_days_f 行数极少**（484行）：是预计算的高层汇总表，不能做明细分析
6. **commercial_bill_capital_cost_f**：票据资金成本表，month 字段格式 `'2026-06'`
