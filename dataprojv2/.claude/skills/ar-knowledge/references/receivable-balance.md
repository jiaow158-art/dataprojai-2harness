# 应收余额 (Balance)

## 快速参考

| 属性 | dwr_ar_receivable_balance_f | dwr_ar_receivable_balance_currency_f |
|------|----------------------------|--------------------------------------|
| Schema | dwrfin | dwrfin |
| 粒度 | 客户+科目+WBS+月份 | 客户+科目+WBS+月份+币种 |
| 列数 | 18 | 15 |
| 行数 | 6,516,423 | 7,649,363 |
| 时间字段 | `year` + `month` | `year` + `month` |

## dwr_ar_receivable_balance_f 字段

| 字段 | 含义 |
|------|------|
| year | 年份 (YYYY) |
| month | 月份 (YYYY-MM) |
| comp_code | 公司代码 |
| cust_code / cust_name | 客户编号/名称 |
| sales_group_master_file | 销售组 |
| wbs / wbs_sales_group | WBS 要素 / WBS 销售组 |
| special_general_ledger | 特别总账标志 |
| general_ledger_account | 总账科目 |
| current_local_currency_balance | 当期本币余额 |
| currency | 币种 |
| local_currency_balance_sum | 本币余额合计 |
| business_department | 业务部门 |
| is_overdue_cust | 是否逾期客户 |
| cust_group_code | 客户组代码 |
| sales_emp_code | 销售员 |
| dw_last_update_date | 最后更新 |

## 与 dwr_ar_receivable_aging 的差异

| 特性 | balance_f | aging_f |
|------|-----------|---------|
| 账龄分段 | ❌ 没有 | ✅ 多段 |
| 逾期/未逾期区分 | ❌ 只有总余额 | ✅ 细到天 |
| 月份粒度 | ✅ year+month | ❌ query_date 快照 |
| 查询速度 | 快 | 中等 |

## 常见查询模式

### 月度应收趋势
```sql
SELECT year, month,
       COUNT(DISTINCT cust_code) as cust_cnt,
       SUM(local_currency_balance_sum) as total_balance,
       SUM(current_local_currency_balance) as current_balance
FROM dwrfin.dwr_ar_receivable_balance_f
WHERE year = '2026'
GROUP BY year, month
ORDER BY year, month;
```

### 按客户月度余额 Top N
```sql
SELECT cust_code, cust_name,
       SUM(local_currency_balance_sum) as balance
FROM dwrfin.dwr_ar_receivable_balance_f
WHERE year = '2026' AND month = '2026-06'
  AND (special_general_ledger IS NULL OR special_general_ledger = '')
GROUP BY cust_code, cust_name
ORDER BY balance DESC
LIMIT 20;
```

### 按公司+业务部门汇总
```sql
SELECT comp_code, business_department,
       COUNT(DISTINCT cust_code) as cust_cnt,
       SUM(local_currency_balance_sum) as balance
FROM dwrfin.dwr_ar_receivable_balance_f
WHERE year = '2026' AND month = '2026-06'
GROUP BY comp_code, business_department
ORDER BY balance DESC;
```

## 陷阱

1. **没有账龄分段**：balance_f 只给总余额，需要看账龄结构必须用 aging 表
2. **year + month 两个过滤条件**：缺 year 会跨年汇总，缺 month 会全年汇总
3. **month 格式**：`'2026-06'`（带连字符），不是 `'202606'`
4. 此表适合做趋势分析和余额快照对比，不适合做逾期分析
