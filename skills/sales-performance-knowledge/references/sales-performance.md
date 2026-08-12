# 销售业绩主表 — ct_sales_performance_t

## 表概览

| 属性 | 值 |
|------|-----|
| Schema | `dm` |
| 表名 | `ct_sales_performance_t` |
| 粒度 | 日 × 客户 × org_code × 渠道 |
| 列数 | 222 |
| 行数 | 8,920,871 |
| 时间范围 | 2023-12-31 ~ 至今 |
| 更新频率 | 每日 |
| 数据量级 | 月达成额亿级（瓷砖事业部月约3-5亿） |

## 维度列

| 列名 | 类型 | 说明 | 示例 |
|------|------|------|------|
| `calday` | varchar | 日期，YYYYMMDD | `20260531` |
| `customer` | varchar | 客户编码 | `0000318427` |
| `org_code` | varchar | 组织编码（SAP短编码） | `ZJ7`, `B21`, `P52` |
| `integrate_channel_code` | varchar | 渠道编码 | `GD01`, `GD02`, `GD03` |
| `data_source` | varchar | 数据来源标记 | — |
| `double_count` | integer | 重复计数标记 | — |

## 核心指标列（通用）

### 月达成（month_*）

| 列名 | 说明 | 同比列 |
|------|------|--------|
| `month_achievement` | 月达成额（含税） | `last_year_month_achievement` |
| `month_notax` | 月不含税净额 | `last_year_month_notax` |
| `month_sales_area` | 月销售面积(㎡) | `last_year_month_sales_area` |
| `month_a_cost` | 月实际成本 | `last_year_month_a_cost` |
| `month_a_gross_profit` | 月实际毛利 | `last_year_month_a_gross_profit` |
| `month_stand_a_cost` | 月标准成本 | `last_year_month_stand_a_cost` |
| `month_stand_a_gross_profit` | 月标准毛利 | `last_year_month_stand_a_gross_profit` |
| `month_amb_cost` | 月AMB成本 | `last_year_month_amb_cost` |
| `month_amb_gross_profit` | 月AMB毛利 | `last_year_month_amb_gross_profit` |

### 季达成（quarter_*）

| 列名 | 说明 |
|------|------|
| `quarter_achievement` | 季达成额 |
| `quarter_notax` | 季不含税净额 |
| `quarter_sales_area` | 季销售面积 |
| `last_year_quarter_achievement` | 去年同季达成额 |

### 年达成（year_*）

| 列名 | 说明 |
|------|------|
| `year_achievement` | YTD年达成额 |
| `year_notax` | YTD不含税净额 |
| `year_sales_area` | YTD销售面积 |
| `last_year_achievement` | 去年全年/同期达成额 |

### 产品分类列（按前缀分组）

每组包含：`{prefix}_month_achievement`, `{prefix}_quarter_achievement`, `{prefix}_year_achievement` 及其 `last_year_*` / `last_period_*` 变体。

| 前缀 | 推测产品类别 | 典型指标数 |
|------|-------------|-----------|
| `high_value_` | 高值产品 | ~18 |
| `large_spec_` | 大规格产品 | ~18 |
| `package_` | 套餐 | ~18 |
| `n1_` | N1产品 | ~18 |
| `gd04_` | GD04渠道 | ~12 (sales_area) |
| `engineering_adjust_` | 工程调整 | ~18 |
| `share_warehouse_` | 共享仓 | ~18 |
| `other_adjust_` | 其他调整 | ~18 |
| `qjcp_` | QJCP产品 | ~6 |
| `iw_` | IW产品 | ~9 |
| `fc_` | FC产品 | ~9 |

### 其他字段

| 列名 | 说明 |
|------|------|
| `day_achievement` | 日达成额 |
| `week_avg_day_achievement` | 周日均 |
| `last_month_day_achievement` | 上月日均 |
| `dw_last_update_date` | DWS最后更新日期 |

## 标准查询模式

### 模式 A：月度达成 + 同比

```sql
SELECT LEFT(calday, 6) as mon,
       SUM(month_achievement) as actual,
       SUM(last_year_month_achievement) as ly,
       (SUM(month_achievement) - SUM(last_year_month_achievement))
         / NULLIF(SUM(last_year_month_achievement), 0) * 100 as yoy_pct
FROM dm.ct_sales_performance_t
WHERE calday BETWEEN '20260101' AND '20260531'
GROUP BY LEFT(calday, 6)
ORDER BY mon;
```

### 模式 B：按渠道分解

```sql
SELECT integrate_channel_code,
       SUM(month_achievement) as actual,
       SUM(last_year_month_achievement) as ly
FROM dm.ct_sales_performance_t
WHERE calday = '20260531'
GROUP BY integrate_channel_code
ORDER BY actual DESC;
```

### 模式 C：按组织下钻（关联组织表）

```sql
SELECT s.node_desc2,
       SUM(p.month_achievement) as actual,
       SUM(p.last_year_month_achievement) as ly
FROM dm.ct_sales_performance_t p
JOIN dm.dm_rpt_sales_group_t s ON p.org_code = s.node_name10
WHERE p.calday = '20260531'
  AND s.node_desc2 = '瓷砖事业部'
GROUP BY s.node_desc2;
```

### 模式 D：达成率（关联目标表）

```sql
SELECT p.org_code,
       SUM(p.month_achievement) as actual,
       MAX(t.target_sales_amt) as target,
       SUM(p.month_achievement) / NULLIF(MAX(t.target_sales_amt), 0) * 100 as rate
FROM dm.ct_sales_performance_t p
LEFT JOIN dm.dm_dp_api_sales_target t
  ON p.org_code = t.sales_center_code
  AND p.integrate_channel_code = t.integrate_channel
  AND t.stat_year = '2026' AND t.stat_month = '2026-05'
WHERE p.calday = '20260531'
GROUP BY p.org_code
ORDER BY rate DESC;
```

### 模式 E：客户 Top N

```sql
SELECT customer,
       SUM(month_achievement) as total
FROM dm.ct_sales_performance_t
WHERE calday = '20260531'
GROUP BY customer
ORDER BY total DESC
LIMIT 20;
```

### 模式 F：高值产品达成

```sql
SELECT LEFT(calday, 6) as mon,
       SUM(high_value_month_achievement) as hv_actual,
       SUM(high_value_last_year_month_achievement) as hv_ly
FROM dm.ct_sales_performance_t
WHERE calday BETWEEN '20260101' AND '20260531'
GROUP BY LEFT(calday, 6)
ORDER BY mon;
```

## 已知陷阱

1. **日粒度聚合不能 SUM month_achievement**：`month_achievement` 是 MTD 值。取最新 `calday` 当天数据再聚合，或按 `calday` 按月取 `MAX`。
2. **org_code 不是 node_desc**：SAP 短编码(ZJ7/B21)，和 node_desc2 等中文名没有直接关系，必须 JOIN `dm_rpt_sales_group_t`，关联键 `org_code = node_name10`（不是 `node10`，`node10` 是序号）。
3. **渠道编码含义**：GD01=国内零售, GD02=整装头部, GD03=国内工程（来自 Mix 表 `integrate_channel__t`）。主表无 desc 字段，JOIN `upload.upload_business_analysis_channel_t` 获取渠道名称（`integrate_channel_code = channel_code`），详见 [channel-dimension.md](channel-dimension.md)。
4. **备份表众多**：`_bakYYYYMMDD` 后缀的约15张变体，只用 `ct_sales_performance_t`。
5. **customer 基数大**：10,876个客户，全量明细查询会很慢，聚合加 LIMIT。查客户名称 JOIN `dm.dm_dp_api_cust_general` ON `customer = cust_num`（匹配率 ~48%，去重），详见 [customer-master](../../sources-of-truth/business-context/customer-master.md)。
6. **产品分类列默认行为**：各前缀字段可能为0或NULL，需确认业务是否启用该分类。
7. **calday 格式**：字符串 YYYYMMDD，不是 DATE 类型。
