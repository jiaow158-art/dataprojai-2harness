# 销售业绩目标填报表 — upload_ct_sales_performance_target_t

## 表概览

| 属性 | 值 |
|------|-----|
| Schema | `upload` |
| 表名 | `upload_ct_sales_performance_target_t` |
| 列数 | 17 |
| 用途 | **dm_dp_api_sales_target 的核心上游**，按销售组×整合渠道×月度填报10种口径目标 |
| 更新频率 | 低频（年初填报，月度调整） |
| 使用者 | `PJob_DWS_DM_DP_API_SALES_TARGET` → `dm_dp_api_sales_target` |

## 列定义

### 维度列

| 列名 | 类型 | 说明 |
|------|------|------|
| `id` | integer | PK，自增 |
| `stat_month` | varchar(20) | 统计月，格式 `yyyy-MM` |
| `sales_group` | varchar(500) | 销售组编码，关联 `dm_dp_api_sales_group_struct.sales_grp` |
| `integrate_channel` | varchar(50) | 整合渠道（整合渠道1），GD01/GD02/GD03 |
| `data_source` | varchar(20) | 数据来源标记 |

### 10种口径目标值

| 列名 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `target` | numeric | 0 | **KPI口径目标**（主目标） |
| `target_1n` | numeric | 0 | **1+N产品目标** |
| `target_gd04` | numeric | 0 | **特惠品目标** |
| `target_high_value` | numeric | 0 | **高值产品目标** |
| `target_package` | numeric | 0 | **中小大包目标** |
| `target_word_impression` | numeric | 0 | **世界印象目标** |
| `target_fc` | numeric | — | **辅材目标** |
| `target_qjcp` | numeric | — | **旗舰产品目标** |
| `target_1w` | numeric | — | **IW产品目标** |
| `zz_new_target` | numeric | — | **整装新品目标** |

### 元数据

| 列名 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `fr_delete` | integer | 0 | 软删除标记 |
| `dw_last_update_date` | timestamp | now() | 最后更新日期 |

## 数据流向

```
upload.upload_ct_sales_performance_target_t (填报原始数据)
  ↓ JOIN dm.dm_dp_api_sales_group_struct (销售组→组织映射)
  ↓ 过滤 fr_delete=0, sales_group NOT IN ('ZB04','ZK01')
  ↓ 聚合到3个层级: 销区级 / 营销部级 / 业务单位级
  ↓
dm.dm_dp_api_sales_target (最终目标: target_sales_amt = target - target_1n)
```

## ETL 关键逻辑

```sql
-- 聚合到销区级
SELECT 
    substring(t1.stat_month,1,4) AS stat_year, t1.stat_month,
    t2.sales_center_code, t2.sales_center, t1.integrate_channel,
    t2.sales_dep_code, t2.sales_dep, t2.sales_region_code, t2.sales_region,
    SUM(COALESCE(target,0)) AS target_sales_amt,
    SUM(COALESCE(target_1n,0)) AS n_target_amount
FROM upload.upload_ct_sales_performance_target_t t1
JOIN dm.dm_dp_api_sales_group_struct t2 ON t1.sales_group = t2.sales_grp
WHERE fr_delete = 0 AND t1.sales_group NOT IN ('ZB04','ZK01')
GROUP BY ...

-- 最终口径：净目标 = KPI目标 - 1+N目标
COALESCE(target_sales_amt,0) - COALESCE(n_target_amount,0) AS target_sales_amt
```

## 已知陷阱

1. **金额单位是万元**：与 Mix 表差 10000 倍
2. **净目标口径**：最终 `target_sales_amt = target - target_1n`
3. **排除的销售组**：`ZB04` 和 `ZK01` 被硬编码排除
4. **fr_delete**：必须过滤 `fr_delete = 0`
5. **24年数据来源不同**：24年从预算表取，25年起从本表取
6. **8种子目标未在API目标表体现**：仅 KPI 和 1+N 参与计算
7. **组织类型总分重复**：同一数据以3种粒度输出，查询时用 `org_type` 区分
