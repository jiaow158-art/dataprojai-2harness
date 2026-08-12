# 销售业绩轻量汇总表 — dm_so_org_perf_stat_t

## 表概览

| 属性 | 值 |
|------|-----|
| Schema | `dm` |
| 表名 | `dm_so_org_perf_stat_t` |
| 行数 | 17,017,750 |
| 粒度 | 月×日×客户×物料×WBS×渠道×销售组 |
| 时间字段 | `calmonth` (YYYY-MM), `calday` (YYYYMMDD) |
| 用途 | **业绩宽表 (`ct_sales_performance_t`) 的核心上游**，合并了阿米巴业绩表和利润表的数据 |
| 更新方式 | 月级增量：DELETE 按 calmonth 范围 + INSERT |
| 数据来源 | `dm_ambv2_zzt_xssr_t`（阿米巴业绩） + `dm_ambv2_profit_t`（阿米巴利润） |

## 列定义

### 维度列

| 列名 | 类型 | 说明 |
|------|------|------|
| `calmonth` | varchar(500) | 日历月（YYYY-MM） |
| `calday` | varchar(500) | 日历日（YYYYMMDD） |
| `customer` | varchar(500) | 客户编码 |
| `material` | varchar(500) | 物料编码 |
| `wbs` | varchar | WBS元素 |
| `distr_chan` | varchar(500) | 分销渠道编码 |
| `distr_chan_name` | varchar(500) | 分销渠道名称（关联 `dm_sdi_tvtwt_1001_t`） |
| `salesorg` | varchar(500) | 销售组织 |
| `integrate_channel` | varchar(500) | 整合渠道1编码 |
| `integrate_channel_name` | varchar(500) | 整合渠道1名称（关联 `upload_business_analysis_channel_t`） |
| `integrate_channel2` | varchar(50) | 整合渠道2编码 |
| `data_source` | varchar(500) | 系统来源（S/D/T/U/W） |
| `sales_grp` | varchar(500) | 销售组编码 |
| `commission_group` | varchar(500) | 佣金组（仅业绩分支有值，利润分支为空） |
| `bus_area` | varchar(500) | 业务范围 |
| `cust_group` | varchar(500) | 客户组 |
| `zsales_channel` | varchar(200) | 渠道（销售方），用于子母客编关联 |
| `clearance_reason` | varchar | 清仓原因/促销原因编码 |
| `clearance_reason_t` | varchar | 清仓原因/促销原因描述 |

### 业绩指标（来自 dm_ambv2_zzt_xssr_t）

| 列名 | 类型 | 说明 |
|------|------|------|
| `ambperformance` | numeric(38,10) | **业绩**（含税达成额） |
| `zxsmj` | numeric(38,10) | 销售面积 |
| `zsyjf` | numeric(38,10) | 使用积分 |
| `z_yjsgtzz` | numeric(38,10) | 手工调整值 |
| `performance_1n` | numeric(38,10) | 1+N业绩 |
| `zxssl` | numeric(38,10) | 销售数量 |

### 利润/成本指标（来自 dm_ambv2_profit_t）

| 列名 | 类型 | 说明 |
|------|------|------|
| `notax_sales_net_amt` | numeric(38,10) | **不含税收入** |
| `last_period_sum_price` | numeric(38,10) | 上期周期总价（含安装费） |
| `act_cost_sum_amt` | numeric(38,10) | 实际A成本（已扣除运费+装卸费） |
| `standard_price_a` | numeric(38,10) | 标A成本 |
| `this_month_gross_profit` | numeric(38,10) | **当月毛利额** = 不含税收入 - (上期周期总价 + 安装费) |
| `a_cost_gross_profit` | numeric(38,10) | A成本毛利额 = 不含税收入 - A成本 |
| `standard_a_gross_profit` | numeric(38,10) | 标A成本毛利额 = 不含税收入 - 标A成本 |
| `amb_gross_profit` | numeric(38,10) | 阿米巴毛利额 |
| `sales_area` | numeric(38,10) | 销售面积（利润表口径） |

### 费用明细

| 列名 | 类型 | 说明 |
|------|------|------|
| `zyywcb_zxf` | numeric(38,10) | 装卸费 |
| `zyywcb_yf` | numeric(38,10) | 运费 |
| `zcbtzz` | numeric(38,10) | 成本调整值 |
| `zzyywcb_azf` | numeric(38,10) | 安装费 |

### 元数据

| 列名 | 类型 | 说明 |
|------|------|------|
| `dw_last_update_date` | timestamp | 最后更新日期 |

## 数据来源与 ETL 逻辑

### 两路 UNION 合并

```
dm_ambv2_zzt_xssr_t (阿米巴销售输入)
  ├── 提供: ambperformance, zxsmj, zsyjf, performance_1n, zxssl
  ├── LEFT JOIN upload.upload_business_analysis_channel_t → integrate_channel_name
  └── LEFT JOIN dm.dm_sdi_tvtwt_1001_t → distr_chan_name

UNION ALL

dm_ambv2_profit_t (阿米巴利润)
  ├── 提供: notax_sales_net_amt, act_cost_sum_amt, standard_price_a
  ├── 提供: zyywcb_zxf, zyywcb_yf, zcbtzz, zzyywcb_azf
  ├── LEFT JOIN upload.upload_business_analysis_channel_t → integrate_channel_name
  └── LEFT JOIN dm.dm_sdi_tvtwt_1001_t → distr_chan_name
```

### 关键计算逻辑

```sql
-- A成本 = 实际成本 - 装卸费 - 运费 (2024-03-29起含安装费)
act_cost_sum_amt = act_cost_sum_amt - zyywcb_zxf - zyywcb_yf

-- 上期周期总价（用于计算当月毛利）
last_period_sum_price = last_period_sum_price + COALESCE(zzyywcb_azf, 0)

-- 当月毛利
this_month_gross_profit = notax_sales_net_amt - (last_period_sum_price + zzyywcb_azf)

-- A成本毛利
a_cost_gross_profit = notax_sales_net_amt - (act_cost_sum_amt - zyywcb_zxf - zyywcb_yf)

-- 标A毛利
standard_a_gross_profit = notax_sales_net_amt - standard_price_a
```

## 作为 ct_sales_performance_t 的上游

业绩宽表的 ETL（脚本1）直接从本表读取聚合数据：

```sql
-- ct_sales_performance_t 的主数据源
FROM dm.dm_so_org_Perf_stat_t a
-- 然后 JOIN 组织表、客户主数据、物料主数据做维度展开
LEFT JOIN DWRDIM.DWR_DIM_WBS_BASIS_INFO_F ...
LEFT JOIN dm.dm_rpt_zmaster_cus_t ...
LEFT JOIN dm.dm_md_sale_grp_reset_t ...
LEFT JOIN dwimd.dwi_md_data_material_general_t ...
```

## 已知陷阱

1. **commission_group 分支差异**：业绩分支有值，利润分支为空字符串 `''`，JOIN 时注意
2. **费用扣除**：A成本已扣除装卸费和运费，查询时不需要再减
3. **毛利口径三套**：当月毛利(基于上期周期价)、A成本毛利、标A成本毛利，三者公式不同
4. **增量更新**：DELETE 按 calmonth 范围，可按月重跑但不支持单日修正
5. **清仓原因**：2025-03-31 新增字段，早期数据为 NULL
6. **zsales_channel**：2024-04-01 新增，用于子母客编关联
7. **WBS 在 GROUP BY 中**：同一客户+物料可能在多个 WBS 下出现，聚合时注意
