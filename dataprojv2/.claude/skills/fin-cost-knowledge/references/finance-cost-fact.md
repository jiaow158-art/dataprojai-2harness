# 财务费用事实表

## 快速参考

- **DWS 表名**：`dm.dm_fact_finance_cost_f`
- **业务含义**：面向 FineReport 报表的费用宽表，整合成本中心、科目、销售组层级、功能范围、费用项目。费用分析的首选表。
- **实体粒度**：一行 = 一条费用记录在月份 + 成本中心 + 科目 + 销售组层级上的聚合
- **列数**：93 列
- **数据量**：267 万行（2021-01 ~ 2027-12），月均 ~4 万行
- **脚本位置**：`DM/DM_CT/PJob_DM_FACT_FINANCE_COST_F.txt`
- **可查询**：是（aiuser 有 SELECT 权限）

## 核心维度字段

| 字段 | 说明 |
|---|---|
| month | 月份 YYYY-MM |
| functional_scope | 功能范围编码 |
| config_name | 功能范围名称 |
| cost_center | 成本中心编码 |
| cost_center_describe | 成本中心描述 |
| cost_center_type | 成本中心类型 |
| cost_center_type_desc | 成本中心类型描述 |
| acc_acount | 总账科目（10 位 LPAD 格式） |
| gl_account_desc | 总账科目描述 |
| sales_grp_code | 销售组编码 |
| node_desc1 ~ node_desc9 | 1-9 级销售组织描述 |
| node_name1 ~ node_name9 | 1-9 级节点名称 |
| cost_center_code_1 ~ 15 | 成本中心 1-15 级编码 |
| cost_center_name_1 ~ 15 | 成本中心 1-15 级名称 |
| comp_code | 公司编码 |
| comp_desc | 公司描述 |
| expense_type_name | 费用项目名称 |
| budget_gl_account | 预算总账科目 |
| budget_gl_account_desc | 预算总账科目描述 |
| wbs_top_level | WBS 顶层 |
| wbs_top_level_desc | WBS 顶层描述 |

## 金额字段（numeric 类型）

| 字段 | 含义 | 口径说明 |
|---|---|---|
| amount | 金额 | 当期实际 |
| budget_cost | 预算成本 | |
| forecast_cost | 预测成本 | |
| accrual_amount | 预提金额 | |
| reversal_amount | 冲销金额 | |
| actual_reimb_amount | 实际报销金额 | |
| period_expense | 期间费用 | |
| operating_expense | 运营费用 | |
| manual_adjust_amt | 手工调整金额 | |
| sum_amt | 合计金额 | |

## 同比字段（ly_ = last year）

| 字段 | 含义 |
|---|---|
| ly_amount | 去年同期金额 |
| ly_accrual_amount | 去年同期预提 |
| ly_reversal_amount | 去年同期冲销 |
| ly_actual_reimb_amount | 去年同期实际报销 |
| ly_period_expense | 去年同期期间费用 |
| ly_operating_expense | 去年同期运营费用 |
| ly_manual_adjust_amt | 去年同期手工调整 |
| ly_sum_amt | 去年同期合计 |

## 预测/预算字段（_ys = 预算, _yc = 预测）

| 字段 | 含义 |
|---|---|
| period_expense_ys | 期间费用-预算 |
| operating_expense_ys | 运营费用-预算 |
| period_expense_yc | 期间费用-预测 |
| operating_expense_yc | 运营费用-预测 |
| ly_period_expense_ys / yc | 去年同期预算/预测 |
| ly_operating_expense_ys / yc | 去年同期运营预算/预测 |

## 功能范围分布

| 编码 | 名称推测 | 数据量（2025-01 起） |
|---|---|---|
| 5501 | 管理费用/销售费用 | 432,929 |
| 5502 | 销售费用/研发费用 | 266,148 |
| 4105 | 制造费用 | 174,107 |
| 4110 | (待确认) | 77,614 |
| 5504 | (待确认) | 65,027 |
| 1010 | 物流成本 | 51,054 |
| 5503 | (待确认) | 4,392 |
| 4101 | 生产成本 | 1,058 |

## 变更历史

| 日期 | 变更 | 负责人 |
|---|---|---|
| 2025/12/31 | 创建 | DP_15000571 |
| 2026/01/20 | 公司描述改用 DWRDIM.DWR_DIM_COMPANY_D | DP_15000571 |
| 2026/02/04 | 新增费用项目、项目描述字段 | DP_15000571 |
| 2026/03/16 | 排除制造费用过度科目 | DP_15000571 |
| 2026/03/25 | 价值链分类和成本中心组织层级调整 | DP_15000571 |
| 2026/04/13 | 预测与预算的总账科目描述取最新 | DP_15000571 |

## 常见查询模式

### 按功能范围汇总月度费用
```sql
SELECT month, config_name,
       SUM(amount) as total_amount,
       SUM(budget_cost) as total_budget
FROM dm.dm_fact_finance_cost_f
WHERE month BETWEEN '2025-01' AND '2026-12'
GROUP BY month, config_name
ORDER BY month, config_name;
```

### 按成本中心 + 科目下钻
```sql
SELECT cost_center, cost_center_describe,
       acc_acount, gl_account_desc,
       SUM(amount) as total
FROM dm.dm_fact_finance_cost_f
WHERE month = '2026-06' AND functional_scope = '4105'
  AND acc_acount NOT IN ('0041011040', '0041011030', '0061507000')
GROUP BY cost_center, cost_center_describe,
         acc_acount, gl_account_desc
ORDER BY total DESC
LIMIT 50;
```

### 预算 vs 实际对比
```sql
SELECT month,
       SUM(amount) as actual,
       SUM(budget_cost) as budget,
       SUM(amount) - SUM(budget_cost) as gap
FROM dm.dm_fact_finance_cost_f
WHERE month >= '2026-01'
GROUP BY month
ORDER BY month;
```

### 同比分析（利用 ly_ 字段直接计算）
```sql
SELECT month,
       SUM(amount) as current,
       SUM(ly_amount) as last_year,
       CASE WHEN SUM(ly_amount) > 0
            THEN ROUND((SUM(amount) - SUM(ly_amount)) / SUM(ly_amount) * 100, 2)
            ELSE NULL END as yoy_pct
FROM dm.dm_fact_finance_cost_f
WHERE month >= '2026-01'
GROUP BY month
ORDER BY month;
```

## 陷阱

1. **全量更新**：TRUNCATE + INSERT，每次执行数据完全重建
2. **科目 LPAD**：`acc_acount` 已经是 10 位字符串，直接匹配即可，不需要手动 LPAD
3. **未来数据**：表中有 2027-06 以后的数据，是预测/预算数据，实际费用截止到当前月份
4. **制造费用过度科目**：2026/03/16 之后已自动排除 `0041011040`、`0041011030`、`0061507000`
5. **功能范围 5501/5502**：占比最大的两个功能范围，需要确认具体业务含义（可能是管理/销售费用）

## 权限说明

- dm schema：aiuser 有完全 SELECT 权限
- dwrfin schema：aiuser 已授权 SELECT（2026-06-06 开通）
- dwifin schema：aiuser 有 SELECT 权限（成本中心主数据）
