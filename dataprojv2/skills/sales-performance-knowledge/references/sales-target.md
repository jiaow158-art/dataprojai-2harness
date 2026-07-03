# 销售目标表 — dm_dp_api_sales_target

## 表概览

| 属性 | 值 |
|------|-----|
| Schema | `dm` |
| 表名 | `dm_dp_api_sales_target` |
| 粒度 | 月 × 销售中心 × 渠道 × 销售部门 × 销售区域 × 组织类型 |
| 列数 | 14 |
| 用途 | 月度销售目标，用于达成率计算 |
| 金额单位 | **万元**（`target_sales_amt` 单位是万元，不是元） |

## 列定义

| 列名 | 类型 | 说明 | 示例 |
|------|------|------|------|
| `stat_year` | varchar | 统计年份 | `2026` |
| `stat_month` | varchar | 统计月份，格式 YYYY-MM | `2026-05` |
| `stat_month_ym` | varchar | 月份（另一格式） | — |
| `sales_center_code` | varchar | 销售中心编码，关联 Mix 表 `node_name5` | `H05230632` |
| `sales_center` | varchar | 销售中心名称 | `战略工程营销中心` |
| `integrate_channel` | varchar | 渠道编码 | `GD01`, `GD02`, `GD03` |
| `sales_dep_code` | varchar | 销售部门编码（`org_type='营销部'` 时有值） | `H06230645` |
| `sales_dep` | varchar | 销售部门名称 | `零售一部` |
| `sales_region_code` | varchar | 销售区域编码（通常为 NULL） | — |
| `sales_region` | varchar | 销售区域名称（通常为 NULL） | — |
| `target_sales_amt` | numeric | **目标销售额（万元）** | `7233`（=0.72亿） |
| `n_target_amount` | numeric | N目标金额（通常为 0，未启用） | — |
| `org_type` | varchar | **组织类型**：`业务单位`=中心汇总 / `营销部`=部门明细 | `业务单位` |
| `dw_last_update_date` | varchar | 最后更新日期 | — |

## org_type — 关键维度

**这是防止达成率计算翻倍的最关键字段。**

| org_type 值 | 含义 | 用途 |
|------------|------|------|
| `业务单位` | 销售中心×渠道级汇总目标 | 计算中心级达成率用这个 |
| `营销部` | 按销售部门拆分的明细目标 | 下钻到部门级时用这个 |

**验证**：同一 `sales_center_code + integrate_channel` 下，`业务单位.target = SUM(营销部.target)`。
**陷阱**：不过滤 org_type 直接 SUM 会导致金额翻倍。

## 与 Mix 表的关联

```
dm_fin_operations_mix_sum_t.node_name5 = dm_dp_api_sales_target.sales_center_code
AND integrate_channel = integrate_channel
```

两个关联键缺一不可。仅按渠道 JOIN 会造成笛卡尔积。

## 标准查询模式

### 模式 A：单月目标（按渠道汇总）

```sql
SELECT integrate_channel,
       SUM(target_sales_amt) as target_wan
FROM dm.dm_dp_api_sales_target
WHERE stat_year = '2026' AND stat_month = '2026-05'
  AND org_type = '业务单位'            -- 取中心级汇总，不含部门明细
GROUP BY integrate_channel
ORDER BY target_wan DESC;
```

### 模式 B：全年目标汇总

```sql
SELECT sales_center, SUM(target_sales_amt) as year_target_wan
FROM dm.dm_dp_api_sales_target
WHERE stat_year = '2026'
  AND org_type = '业务单位'
GROUP BY sales_center
ORDER BY year_target_wan DESC;
```

### 模式 C：达成率 — Mix 表（推荐）

```sql
WITH target_agg AS (
  SELECT sales_center_code, integrate_channel,
         SUM(target_sales_amt) * 10000 as target_yuan  -- 万元→元
  FROM dm.dm_dp_api_sales_target
  WHERE stat_year = '2026' AND stat_month = '2026-05'
    AND org_type = '业务单位'
  GROUP BY sales_center_code, integrate_channel
)
SELECT m.integrate_channel, m.integrate_channel__t,
       SUM(m.ambperformance) as actual,
       SUM(t.target_yuan) as target,
       SUM(m.ambperformance) / NULLIF(SUM(t.target_yuan), 0) * 100 as rate
FROM dm.dm_fin_operations_mix_sum_t m
LEFT JOIN target_agg t
  ON m.node_name5 = t.sales_center_code
  AND m.integrate_channel = t.integrate_channel
WHERE m.calmonth = '2026-05' AND m.node_desc2 = '瓷砖事业部'
  AND m.integrate_channel IS NOT NULL
GROUP BY m.integrate_channel, m.integrate_channel__t
ORDER BY actual DESC;
```

### 模式 D：达成率 — 业绩表

```sql
WITH target_agg AS (
  SELECT sales_center_code, integrate_channel,
         SUM(target_sales_amt) * 10000 as target_yuan
  FROM dm.dm_dp_api_sales_target
  WHERE stat_year = '2026' AND stat_month = '2026-05'
    AND org_type = '业务单位'
  GROUP BY sales_center_code, integrate_channel
)
SELECT t.sales_center_code, m.integrate_channel,
       SUM(p.month_achievement) as actual,
       MAX(t.target_yuan) as target,
       SUM(p.month_achievement) / NULLIF(MAX(t.target_yuan), 0) * 100 as rate
FROM dm.ct_sales_performance_t p
JOIN dm.dm_rpt_sales_group_t s ON p.org_code = s.node_name10
LEFT JOIN target_agg t
  ON s.node_name5 = t.sales_center_code
  AND p.integrate_channel_code = t.integrate_channel
WHERE p.calday = '20260531' AND s.node_desc2 = '瓷砖事业部'
GROUP BY t.sales_center_code, m.integrate_channel
ORDER BY rate DESC;
```

## 已知陷阱

1. **未来月份有数据**：全年目标年初导入，`stat_month = '2026-12'` 已存在，务必 `stat_month <= 当前月`。
2. **org_type 必须过滤**：`业务单位` 和 `营销部` 是总分关系，不过滤会导致金额翻倍。中心级查询用 `org_type = '业务单位'`。
3. **金额单位是万元**：`target_sales_amt` 单位是万元（不是元）。与 Mix 表（元）或业绩表（元）JOIN 时需 `* 10000` 转换。
4. **与 Mix 表的关联键**：`node_name5 = sales_center_code`（不是 `sales_grp` 或 `node_name4`），已验证匹配。
5. **n_target_amount 未启用**：大部分行值为 0。
6. **sales_region 通常为 NULL**：目标基本不按区域分解，按部门（`sales_dep_code`）分解。
