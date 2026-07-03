# 商业票据 / 资金成本 / 应收预测 / 风险等级

## 快速参考

| 场景 | DWS 表 | 行数 | 列数 | 时间字段 |
|------|--------|------|------|----------|
| 商业票据资金成本 | `dwrfin.dwr_ar_commercial_bill_capital_cost_f` | 1,566,703 | 20 | month (YYYY-MM) |
| 应收预测 | `dwrfin.dwr_ar_receivable_froecast_f` / `_result_f` | 174 | 17/13 | calmonth |
| 风险等级 | `dwrfin.dwr_ar_risk_level_f_t` | 98,068 | 17 | — |

## dwr_ar_commercial_bill_capital_cost_f 字段

| 字段 | 含义 |
|------|------|
| business_department | 业务部门 |
| capital_cost_type | 资金成本类型 |
| month | 月份 (YYYY-MM) |
| (其余 17 列需进一步确认) | |

## dwr_ar_receivable_froecast_f 字段

| 字段 | 含义 |
|------|------|
| calmonth | 会计期间 |
| dept | 部门 |
| no_overdue_payment_plan_amt | 未逾期付款计划金额 |
| (其余 14 列需进一步确认) | |

## dwr_ar_receivable_froecast_result_f 字段

| 字段 | 含义 |
|------|------|
| calmonth | 会计期间 |
| dept | 部门 |
| ys_yc | 应收预测 |
| (其余 10 列需进一步确认) | |

## dwr_ar_risk_level_f_t 字段

| 字段 | 含义 |
|------|------|
| comp_code | 公司 |
| cust_code | 客户 |
| wbs | WBS 要素 |
| (其余 14 列需进一步确认) | |

## dwr_ar_receivable_dereceived_reclassify_d 字段

| 字段 | 含义 |
|------|------|
| general_ledger_account / _desc | 总账科目/描述 |
| payment_classify_desc | 付款分类描述 |
| (其余 35 列需进一步确认) | 应收重分类明细 |

## 常见查询模式

### 票据资金成本按月汇总
```sql
SELECT month, capital_cost_type,
       COUNT(*) as cnt
FROM dwrfin.dwr_ar_commercial_bill_capital_cost_f
WHERE month >= '2026-01'
GROUP BY month, capital_cost_type
ORDER BY month;
```

### 应收预测按部门
⚠️ **此表数据仅到 2022-09，已停更 3 年+**。查询时间窗口必须 ≤ 2022-09。
```sql
SELECT calmonth, dept, ys_yc as forecast
FROM dwrfin.dwr_ar_receivable_froecast_result_f
WHERE calmonth >= '202201'
ORDER BY calmonth, dept;
```

## 陷阱

1. **预测表行数极少**（174行）：只在部门+月份粒度有预测数据
2. **commercial_bill_capital_cost_f 的部分字段**：需进一步 DWS 字段确认，当前文档覆盖核心时间/组织维度
3. **risk_level_f_t**：非时间序列表，查询不需要时间过滤但需带 comp_code/cust_code
4. **reclassify_d**：应收重分类，通常用于期末结账

## 交叉引用

- 应收账龄 → [receivable-aging.md](receivable-aging.md)
- 坏账减值 → [credit-devalue.md](credit-devalue.md)
