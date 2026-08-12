# 销售毛利分析

## 快速参考

- **业务含义**：按天/月/销售区域/运营中心/产品层次/渠道等维度，计算销售收入、成本、毛利额和毛利率，支持预算 vs 实际对比。
- **实体粒度**：一行 = 一个维度组合（天 + 销售区域 + 运营中心 + 产品 + 渠道 + 工厂）在一天上的毛利数据
- **目标表**：`DWRFIN.DWRFIN_COST_SALES_GROSS_PROFIT_D`

## 核心表

### DWRFIN.DWRFIN_COST_SALES_GROSS_PROFIT_D — 销售毛利日报

- **脚本位置**：`DWR/FIN/COST/PJob_DWS_DWRFIN_COST_SALES_GROSS_PROFIT_D.txt`
- **ETL 负责人**：linwei（创建），xiaolixian、zhouhaochang（多次维护）
- **更新方式**：按月份 DELETE + INSERT（覆盖当月）

### 主要维度

| 字段 | 含义 | 备注 |
|---|---|---|
| days | 天 | |
| months | 月份 | |
| node_desc2 | 二级部门 | |
| node_desc3 | 三级部门 | 销售组 |
| node_desc4 / sales_region | 销售区域 | |
| node_desc5 / operation_center | 运营中心 | |
| prod_hierarchys | 产品层次3 | |
| size_dim | 大小/量纲 | |
| zqdzh / integration_channel | 整合渠道 | |
| factory / factory_80_flag | 工厂 | |

### 预算指标

| 字段 | 含义 |
|---|---|
| budget_amt | 预算金额 |
| budget_use_point | 预算使用积分 |
| budget_accrual_point | 预算预提积分 |
| budget_notax_sales_net_amt | 预算不含税净额（管理口径） |
| budget_cost_a | 预算成本A |
| budget_gross_profit | 预算毛利额（标准A） |
| budget_sales_area | 预算销售面积 |
| budget_sales_qty | 预算销售数量 |
| budget_gross_margin | 预算毛利率 |

### 实际指标

| 字段 | 含义 |
|---|---|
| sales_amt | 销售金额 |
| use_point | 使用积分 |
| accrual_point_system | 预提积分（系统） |
| accrual_point_manual | 预提积分（手工） |
| notax_sales_net_amt | 不含税净额（管理口径） |
| actual_cost | 实际成本 |
| gross_profit | 毛利额 |
| gross_margin | 毛利率 |

### 关键维度字段（新增）

| 字段 | 含义 | 新增时间 |
|---|---|---|
| budget_standard_A_cost | 标A成本 | 2023/03/30 |
| budget_standard_A_gross_profit | 标A毛利 | 2023/03/30 |
| key_product | 重点产品 | 2023/03/30 |
| is_high_value | 是否高值 | 2023/03/31 |
| fr_text | 帆软文本 | 2023/03/31 |

## 关联维度

- `DM.DM_DIM_DATE_D` — 日期维度（天、月、年、同比日）
- 品类架构用销售组层级表（NODE_DESC1 ~ NODE_DESC9）

## 常见查询模式

### 某月毛利按销售区域汇总
```sql
SELECT sales_region, SUM(gross_profit) as total_gp, SUM(gross_margin) as avg_gm
FROM DWRFIN.DWRFIN_COST_SALES_GROSS_PROFIT_D
WHERE months = '2026-06'
GROUP BY sales_region;
```

### 预算 vs 实际毛利对比
```sql
SELECT months, sales_region,
       SUM(budget_gross_profit) as budget_gp,
       SUM(gross_profit) as actual_gp,
       SUM(gross_profit) - SUM(budget_gross_profit) as gap
FROM DWRFIN.DWRFIN_COST_SALES_GROSS_PROFIT_D
WHERE months >= '2026-01'
GROUP BY months, sales_region;
```

## 陷阱

1. **品类名称变更**：2023-04-17 陶艺品 → 辅料辅材（历史口径注意）
2. **品类架构**：2023-04-25 修改过架构，跨此时间点要确认口径
3. **标A成本/毛利**：2023-03-30 新增的字段，此前无数据
4. **预提分系统和手工**：两者口径不同，通常合计使用
5. **更新方式为月度覆盖**：DELETE + INSERT，注意增量取数的范围

## 交叉引用

- 费用明细 → [cost-comprehensive-subject.md](cost-comprehensive-subject.md)
- 费用事实表 → [finance-cost-fact.md](finance-cost-fact.md)
