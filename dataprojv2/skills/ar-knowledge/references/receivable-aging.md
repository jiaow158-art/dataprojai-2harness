# 应收账龄分析 (Aging)

## 快速参考

| 属性 | dwr_ar_receivable_aging_2023_info_f (推荐) | dm_ar_receivable_accage_t |
|------|------------------------------------------|---------------------------|
| Schema | dwrfin | dm |
| 粒度 | 客户+科目+特别总账+WBS | 公司+客户+销售组+WBS |
| 列数 | 82 | 45 |
| 行数 | 13,406,776 | 1,620,234 |
| 时间字段 | `query_date` (YYYY-MM-DD) | `edition_date` (YYYYMMDD) |
| 余额字段 | `local_currency_balance_sum` | `zysye` (总应收余额) |
| 逾期字段 | `overdue_receivables`, `overdue_receivables_2023_after`, `overdue_receivables_2023_ago` | `zyq` (总逾期) |

## dwr_ar_receivable_aging_2023_info_f 字段

### 核心维度
| 字段 | 含义 |
|------|------|
| query_date | 查询日期 (YYYY-MM-DD，带连字符) |
| comp_code | 公司代码 |
| cust_code / cust_name | 客户编号/名称 |
| sales_group_master_file | 销售组（DWR层） |
| wbs / wbs_sales_group | WBS 要素 / WBS 销售组 |
| special_general_ledger | 特别总账标志（空=正常） |
| general_ledger_account | 总账科目 |
| currency | 币种 |

### 余额/回款
| 字段 | 含义 |
|------|------|
| local_currency_balance_sum | 本币应收余额 (总) |
| repay_amt | 回款金额 |
| overdue_receivables | 逾期应收 (总) |
| n_overdue_receivables | 未逾期应收 (总) |

### 账龄分段 — 2023前 (_2023_ago)
| 字段 | 含义 |
|------|------|
| overdue_receivables_2023_ago | 2023前逾期总额 |
| overdue_receivables_1_90_day_2023_ago | 1-90天 |
| overdue_receivables_1_30_day_2023_ago | 1-30天 |
| overdue_receivables_31_60_day_2023_ago | 31-60天 |
| overdue_receivables_61_90_day_2023_ago | 61-90天 |
| overdue_receivables_91_275_day_2023_ago | 91-275天 |
| overdue_receivables_276_730_day_2023_ago | 276-730天 |
| overdue_receivables_731_1460_day_2023_ago | 731-1460天 |
| overdue_receivables_1461_day_2023_ago | 1461天以上 |

### 账龄分段 — 2023后 (_2023_after)
| 字段 | 含义 |
|------|------|
| overdue_receivables_2023_after | 2023后逾期总额 |
| overdue_receivables_1_90_day_2023_after | 1-90天 |
| overdue_receivables_91_275_day_2023_after | 91-275天 |
| overdue_receivables_276_730_day_2023_after | 276-730天 |
| overdue_receivables_276_365_day_2023_after | 276-365天 (细分) |
| overdue_receivables_366_730_day_2023_after | 366-730天 (细分) |
| overdue_receivables_731_1460_day_2023_after | 731-1460天 |
| overdue_receivables_1461_day_2023_after | 1461天以上 |

### 未逾期分段 (n_overdue_receivables_*)
| 字段 | 含义 |
|------|------|
| n_overdue_receivables | 未逾期总额 |
| n_overdue_receivables_0_365_day | 0-365天 |
| n_overdue_receivables_0_30_day | 0-30天 |
| n_overdue_receivables_31_60_day ~ _331_365_day | 每月细分 |
| n_overdue_receivables_366_730_day ~ _1461_day | 超年分段 |

### 其他维度
| 字段 | 含义 |
|------|------|
| business_department | 业务部门 |
| is_overdue_cust | 是否逾期客户 |
| cust_group_code | 客户组代码 |
| so_group_code | 销售订单组 |
| sales_emp_code | 销售员编码 |
| sales_group_cust_file | 客户销售组档案 |
| before_year_receivables | 年初应收 |
| after_year_receivables | 年末应收 |
| dw_last_update_date | 最后更新日期 |

## dm_ar_receivable_accage_t 字段

### 核心维度
| 字段 | 含义 |
|------|------|
| edition_date | 快照日期 (YYYYMMDD) |
| comp_code / comp_code___t | 公司代码/名称 |
| debitor / debitor___t | 客户编号/名称 |
| sales_grp / sales_grp___t | 销售组代码/名称 |
| wbs_elemt / wbs_elemt___t | WBS 要素代码/名称 |

### 余额/逾期
| 字段 | 含义 |
|------|------|
| zysye | 总应收余额 |
| zyq | 总逾期 |
| zdqyj | 总到期押金 |

### 应收账龄分段 (ysyq = 已收已清)
| 字段 | 含义 |
|------|------|
| bf_2020_zl_ysyq_0_90_amt | 截止日前 0-90 天 |
| af_2020_zl_ysyq_0_90_amt | 截止日后 0-90 天 |
| bf_2020_zl_ysyq_91_275_amt | 截止日前 91-275 天 |
| af_2020_zl_ysyq_91_275_amt | 截止日后 91-275 天 |
| bf_2020_zl_ysyq_276_720_amt | 截止日前 276-720 天 |
| af_2020_zl_ysyq_276_720_amt | 截止日后 276-720 天 |
| bf_2020_zl_ysyq_721_1440_amt | 截止日前 721-1440 天 |
| af_2020_zl_ysyq_721_1440_amt | 截止日后 721-1440 天 |
| bf_2020_zl_ysyq_a_1441_amt | 截止日前 1441 天以上 |
| af_2020_zl_ysyq_a_1441_amt | 截止日后 1441 天以上 |
| ysyq_jc_amt | 应收账龄净差额 |

### 应收未清分段 (yswyq = 已收未清)
| 字段 | 含义 |
|------|------|
| bf_2020_zl_yswyq_0_365_amt | 截止日前 0-365 天 |
| af_2020_zl_yswyq_0_365_amt | 截止日后 0-365 天 |
| bf_2020_zl_yswyq_366_730_amt | 截止日前 366-730 天 |
| … | 类似分段 731-1095 / 1096-1460 / 1461+ |
| yswyq_jc_amt | 应收未清净差额 |

### 新细分段 (af_bf 1_90 等)
| 字段 | 含义 |
|------|------|
| af_2020_zl_yswyq_1_90_amt | 新增细分 1-90 天 (截止日后) |
| bf_2020_zl_yswyq_1_90_amt | 新增细分 1-90 天 (截止日前) |
| （类似 91_275 / 276_720 / 721_1440 / 1440+） | — |

## 常见查询模式

### 指定日期应收账龄总览
```sql
SELECT query_date,
       COUNT(DISTINCT cust_code) as cust_cnt,
       SUM(local_currency_balance_sum) as total_balance,
       SUM(overdue_receivables) as overdue_total,
       SUM(overdue_receivables_2023_after) as overdue_new,
       SUM(overdue_receivables_2023_ago) as overdue_old
FROM dwrfin.dwr_ar_receivable_aging_2023_info_f
WHERE query_date = '2026-06-08'
GROUP BY query_date;
```

### 按客户应收排名
```sql
SELECT cust_code, cust_name,
       SUM(local_currency_balance_sum) as balance,
       SUM(overdue_receivables) as overdue,
       ROUND(SUM(overdue_receivables) / NULLIF(SUM(local_currency_balance_sum), 0) * 100, 2) as overdue_pct
FROM dwrfin.dwr_ar_receivable_aging_2023_info_f
WHERE query_date = '2026-06-08'
  AND (special_general_ledger IS NULL OR special_general_ledger = '')
GROUP BY cust_code, cust_name
ORDER BY balance DESC
LIMIT 20;
```

### 按账龄分段汇总
```sql
SELECT
  SUM(overdue_receivables_1_90_day_2023_after) as d_0_90,
  SUM(overdue_receivables_91_275_day_2023_after) as d_91_275,
  SUM(overdue_receivables_276_730_day_2023_after) as d_276_730,
  SUM(overdue_receivables_731_1460_day_2023_after) as d_731_1460,
  SUM(overdue_receivables_1461_day_2023_after) as d_1461_plus
FROM dwrfin.dwr_ar_receivable_aging_2023_info_f
WHERE query_date = '2026-06-08';
```

### 特别总账排除 vs 包含
```sql
-- 仅正常应收
SELECT SUM(local_currency_balance_sum)
FROM dwrfin.dwr_ar_receivable_aging_2023_info_f
WHERE query_date = '2026-06-08'
  AND (special_general_ledger IS NULL OR special_general_ledger = '');

-- 含特别总账（预收款等）
SELECT special_general_ledger, SUM(local_currency_balance_sum)
FROM dwrfin.dwr_ar_receivable_aging_2023_info_f
WHERE query_date = '2026-06-08'
GROUP BY special_general_ledger;
```

## 陷阱

1. **优先使用 2023 新版**：`dwr_ar_receivable_aging_f` (31列) 是旧版，逾期只分5段。`_2023_info_f` (82列) 细得多
2. **query_date 格式**：YYYY-MM-DD，**带连字符**（实测 `'2026-06-08'`）。写成 YYYYMMDD 会返回空结果
3. **query_date 含未来日期快照**：表中存在 `query_date > CURRENT_DATE` 的预算/预测快照（如 `2026-12-31`，约 16.6 万行）。按 `MAX(query_date)` 取"最新"时会拿到未来数据，需用 `WHERE query_date <= CURRENT_DATE` 过滤
3. **特别总账**：`special_general_ledger` 空 = 正常应收。绝大多数分析场景需要排除特别总账
4. **is_overdue_cust**：此字段标识客户是否标记为逾期，不是所有客户都有逾期
5. **2023前/后口径差异**：两套字段的分段粒度和统计口径可能略有不同
6. **DM层 vs DWR层**：`dm_ar_receivable_accage_t` 是月度快照，`dwr_ar_receivable_aging_2023_info_f` 是更细粒度的明细

## 交叉引用

- 应收余额 → [receivable-balance.md](receivable-balance.md)
- 逾期监控 → [overdue-collection.md](overdue-collection.md)
- 坏账减值 → [credit-devalue.md](credit-devalue.md)
- 综合分析 → [ar-analysis-rpt.md](ar-analysis-rpt.md)
