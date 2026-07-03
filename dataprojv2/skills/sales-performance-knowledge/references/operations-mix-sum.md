# 经营混合汇总表 — dm_fin_operations_mix_sum_t

## 表概览

| 属性 | 值 |
|------|-----|
| Schema | `dm` |
| 表名 | `dm_fin_operations_mix_sum_t` |
| 粒度 | 日 × 物料 × 客户 × 销售组 × 渠道 |
| 行数 | 9,029,412 |
| 时间范围 | 2022-01 ~ 2026-12（含预算/预测月份） |
| 更新频率 | 每日 |
| 数据量级 | 瓷砖事业部月约 22.7 万行，达成额 ~5 亿 |

**定位**：业绩域的**主事实表**，相当于费用域的 `dm_fact_finance_cost_f`、应收域的 `dm_ar_analysis_rpt_f`。内置 `node_desc1~9` + `node_name1~9`，绝大多数查询无需 JOIN 组织表。

## 维度列

### 组织维度（内置，无需 JOIN！）

| 列名 | 说明 | 示例 |
|------|------|------|
| `node_desc1~9` | 1~9级组织描述 | `东鹏集团`, `瓷砖事业部` |
| `node_name1~9` | 1~9级组织编码 | `H99000000`, `H11000001` |
| `sales_grp` | 销售组编码 | `JG1` |

### 渠道维度

| 列名 | 说明 | 示例 |
|------|------|------|
| `integrate_channel` | 综合渠道编码 | `GD01`, `GD02`, `GD03` |
| `integrate_channel__t` | 综合渠道描述 | `零售渠道`, `整装头部`, `工程渠道` |
| `integrate_channel2` | 二级渠道编码 | `GD04`, `GG01` ~ `GG08` |
| `integrate_channel2__t` | 二级渠道描述 | `特惠品`, `N品类产品`, `瓷砖产品`, `大包专供产品`, `非设计师产品`, `零售产品`, `设计师专供产品` |
| `distr_chan` | 分销渠道编码 | `01`~`10` |
| `distr_chan__t` | 分销渠道描述 | `经销`, `零售`, `工程`, `电商`, `家装`, `设计师`, `乡镇或流通` |

**渠道描述权威来源**：一级渠道直接用 `integrate_channel__t`（内置）。二级渠道描述可参考 `integrate_channel2__t` 或 JOIN `upload.upload_business_analysis_channel_t`（`integrate_channel2 = channel_code` AND `channel_type = '整合渠道2'`），详见 [channel-dimension.md](channel-dimension.md)。

**三套渠道体系**：Mix 表有 `integrate_channel`(整合渠道1,3值,销售导向)、`integrate_channel2`(整合渠道2,7值,产品导向)、`distr_chan`(分销渠道,7值,SAP原始口径)。用户说"渠道"时需确认指哪个，详见 metrics.md 渠道决策树。

### 产品维度

| 列名 | 说明 | 去重数(月) |
|------|------|-----------|
| `category` / `category_name` | 品类编码/名称 | 42 |
| `product_brand_code` / `product_brand_name` | 产品品牌 | 43 |
| `product_line` | 产品线 | 6 |
| `product_series_name` | 产品系列 | 12 |
| `matl_group_code` / `matl_group_name` | 物料组 | — |
| `product_level_code/name` ~ `product_level3_code/name` | 产品层级1~3 | — |
| `material_num` / `material_name` | 物料编码/名称 | 6,232 |
| `prod_property` / `prod_property_name` | 产品属性 | — |
| `external_matl_group_code/name` | 外部物料组 | — |
| `faces_name` / `color_name` | 表面/颜色 | — |

### 客户维度

| 列名 | 说明 | 去重数(月) |
|------|------|-----------|
| `customer` | 客户编码 | 2,510 |
| `cust_name` | 客户名称 | 2,487 |
| `cust_group_code` / `cust_group_name` | 客户分组 | 30 |
| `cust_mkt_segmentation_name` | 客户市场细分 | — |

### 区域/其他维度

| 列名 | 说明 |
|------|------|
| `region_code` / `region_province_name` | 区域编码/省份 |
| `works_category` | 工程类别 |
| `dimension` | 维度（115个值） |
| `data_source` | 数据来源（见下方） |

## 核心指标列

### 收入/达成

| 列名 | 说明 | 预算字段 | 预测字段 |
|------|------|---------|---------|
| `ambperformance` | AMB业绩（含税达成额）**← 主指标** | `ambperformance_ys` | `ambperformance_yc` |
| `notax_sales_net_amt` | 不含税销售净额 | `notax_sales_net_amt_ys` | — |
| `deal_price_total` | 成交价总额 | — | — |

### 成本/利润

| 列名 | 说明 | 预算字段 |
|------|------|---------|
| `act_cost_sum_amt` | 实际成本汇总 | `act_cost_sum_amt_ys` |
| `actual_cost_exclude_logistics` | 不含物流实际成本 | — |
| `gross_profit_after_sharing` | 分摊后毛利 | — |
| `a_overall_profit_amt` | 整体利润 | — |
| `amb_profit_amt` | AMB利润 | — |
| `standard_price_a` | 标准价格 | `standard_price_a_ys` |
| `amb_internal_price` | AMB内部价格 | `amb_internal_price_ys` |

### 面积/数量

| 列名 | 说明 | 预算字段 |
|------|------|---------|
| `zxsmj` | 销售面积(㎡) — **标准口径，常规查询用这个** | — |
| `zxssl` | 销售数量 — **标准口径，常规查询用这个** | — |
| `s_zxsmj` | 销售面积(㎡) — 用于计算成交单价 | `s_zxsmj_ys` |
| `s_zxssl` | 销售数量 — 用于计算成交单价 | `s_zxssl_ys` |

### SAP 原始字段

| 列名 | 说明 |
|------|------|
| `zfdje` | 返点金额 |
| `zsyjf` | 商业折扣 |
| `zytjf` | 业态折扣 |

## data_source 说明

| 值 | 说明 |
|----|------|
| `S` | SAP 源数据 |
| `D` | 重算 |
| `T` | 调整值 |
| `U` | 事业部内部交易 |
| `W` | 卫浴费全资成本调整值 |
| `''` | 空值（部分数据未标记来源） |

**组织层级过滤规则**：
- 集团 / 第二层级事业部（`node_desc2`）→ `data_source IN ('S', 'T', 'D', '')`
- 其他组织层级 → `data_source IN ('', 'S', 'T', 'D', 'U')`
- 用户未指定组织 → 询问用户取什么 data_source

## 标准查询模式

### 模式 A：月度达成趋势 + 同比（需JOIN业绩表取last_year）

```sql
SELECT m.calmonth,
       SUM(m.ambperformance) as actual,
       SUM(p.last_year_month_achievement) as ly
FROM dm.dm_fin_operations_mix_sum_t m
LEFT JOIN (
  SELECT LEFT(calday,6) as mon, SUM(month_achievement) as last_year_month_achievement
  FROM dm.ct_sales_performance_t
  WHERE calday IN ('20250131','20250228','20250331','20250430','20250531')
  GROUP BY LEFT(calday,6)
) p ON RIGHT(m.calmonth,2) = RIGHT(p.mon,2)
WHERE m.calmonth BETWEEN '2026-01' AND '2026-05'
  AND m.node_desc2 = '瓷砖事业部'
  AND m.data_source IN ('S', 'T', 'D', '')
GROUP BY m.calmonth
ORDER BY m.calmonth;
```

**注意**：Mix 表没有 `last_year_*` 字段，同比仍需关联 `ct_sales_performance_t`。

### 模式 B：按渠道达成（最简写法）

```sql
SELECT integrate_channel, integrate_channel__t,
       SUM(ambperformance) as actual
FROM dm.dm_fin_operations_mix_sum_t
WHERE calmonth = '2026-05'
  AND node_desc2 = '瓷砖事业部'
  AND data_source IN ('S', 'T', 'D', '')
GROUP BY integrate_channel, integrate_channel__t
ORDER BY actual DESC;
```

### 模式 C：按产品品牌 Top N

```sql
SELECT product_brand_name,
       SUM(ambperformance) as actual,
       SUM(notax_sales_net_amt) as notax,
       SUM(s_zxsmj) as area
FROM dm.dm_fin_operations_mix_sum_t
WHERE calmonth = '2026-05'
  AND node_desc2 = '瓷砖事业部'
  AND data_source IN ('S', 'T', 'D', '')
GROUP BY product_brand_name
ORDER BY actual DESC
LIMIT 20;
```

### 模式 D：按客户 Top N

```sql
SELECT customer, cust_name,
       SUM(ambperformance) as actual
FROM dm.dm_fin_operations_mix_sum_t
WHERE calmonth = '2026-05'
  AND node_desc2 = '瓷砖事业部'
  AND data_source IN ('S', 'T', 'D', '')
GROUP BY customer, cust_name
ORDER BY actual DESC
LIMIT 20;
```

### 模式 E：预算 vs 实际

```sql
SELECT calmonth,
       SUM(ambperformance) as actual,
       SUM(ambperformance_ys) as budget,
       (SUM(ambperformance) - SUM(ambperformance_ys))
         / NULLIF(SUM(ambperformance_ys), 0) * 100 as variance_pct
FROM dm.dm_fin_operations_mix_sum_t
WHERE calmonth BETWEEN '2026-01' AND '2026-05'
  AND node_desc2 = '瓷砖事业部'
  AND data_source IN ('S', 'T', 'D', '')
GROUP BY calmonth
ORDER BY calmonth;
```

### 模式 F：区域达成分布

```sql
SELECT region_province_name,
       SUM(ambperformance) as actual
FROM dm.dm_fin_operations_mix_sum_t
WHERE calmonth = '2026-05'
  AND node_desc2 = '瓷砖事业部'
  AND data_source IN ('S', 'T', 'D', '')
GROUP BY region_province_name
ORDER BY actual DESC;
```

### 模式 G：达成率（关联目标表）

```sql
WITH target_agg AS (
  SELECT sales_center_code, integrate_channel,
         SUM(target_sales_amt) * 10000 as target_yuan  -- 万元→元
  FROM dm.dm_dp_api_sales_target
  WHERE stat_year = '2026' AND stat_month = '2026-05'
    AND org_type = '业务单位'             -- 关键！取中心级汇总，排除部门明细
  GROUP BY sales_center_code, integrate_channel
)
SELECT m.integrate_channel, m.integrate_channel__t,
       SUM(m.ambperformance) as actual,
       SUM(t.target_yuan) as target,
       SUM(m.ambperformance) / NULLIF(SUM(t.target_yuan), 0) * 100 as rate
FROM dm.dm_fin_operations_mix_sum_t m
LEFT JOIN target_agg t
  ON m.node_name5 = t.sales_center_code    -- org关联: node_name5
  AND m.integrate_channel = t.integrate_channel
WHERE m.calmonth = '2026-05'
  AND m.node_desc2 = '瓷砖事业部'
  AND m.data_source IN ('S', 'T', 'D', '')
  AND m.integrate_channel IS NOT NULL
GROUP BY m.integrate_channel, m.integrate_channel__t
ORDER BY actual DESC;
```

## 已知陷阱

1. **没有 `last_year_*` 字段**：Mix 表只含当期和预算/预测，同比必须回 `ct_sales_performance_t`。
2. **`data_source` 需过滤**：S=SAP/D=重算/T=调整值/U=事业部内部交易/W=卫浴费全资成本调整值。集团或 node_desc2 层级用 `IN ('S','T','D','')`，其他组织用 `IN ('','S','T','D','U')`。
3. **日粒度聚合**：同日有多个 calday 值（1~31号），按月查用 `calmonth` 不要用 `calday`。
4. **含未来预算月**：calmonth 范围到 2026-12，全年预算已导入。查实际数注意 `calmonth <= 当前月`。
5. **成本和毛利口径差异**：`act_cost_sum_amt` 含费用分摊，与 `ct_sales_performance_t.month_a_cost` 口径不同（差异 ~3.7%）。
6. **node_desc 可能为空**：部分行 node_desc 层级不完整（和 `dm_rpt_sales_group_t` 一样，不是所有组织填满 9 级）。
7. **渠道三套体系**：`integrate_channel`(零售渠道/整装头部/工程渠道)、`integrate_channel2`(特惠品/N品类产品/瓷砖产品等)、`distr_chan`(经销/零售/工程/电商/家装等)。详见 metrics.md 渠道决策树。
8. **面积/数量双字段**：`s_zxsmj`/`s_zxssl` 用于计算成交单价，`zxsmj`/`zxssl` 用于常规面积/数量查询。不可混用。
9. **`dimension` 字段名误导**：实际是产品物理规格（如 1500X750），不是数据建模的"维度"。
10. **`ambperformance` vs `deal_price_total`**：成交价总额比 AMB 业绩多 ~5%，含额外逻辑（用于计算成交单价），详见 ETL `PJob_DWS_DM_FIN_OPERATIONS_MIX_T`。

## 与 ct_sales_performance_t 的关系

| 场景 | 用 Mix 表 | 用业绩表 |
|------|----------|---------|
| 月度达成/趋势 | ✅ 默认 | 可（需 JOIN 组织表） |
| 同比增长 | ❌ 无此字段 | ✅ `last_year_*` |
| 预算/预测对比 | ✅ `_ys` / `_yc` | ❌ 无 |
| 产品分类（高值/大规格等） | ❌ 无预计算列 | ✅ `high_value_*` 等 |
| 客户/物料/品牌明细 | ✅ 物料级粒度 | ❌ 无物料维度 |
| 组织筛选 | ✅ 内置 node_desc | ❌ 需 JOIN |
