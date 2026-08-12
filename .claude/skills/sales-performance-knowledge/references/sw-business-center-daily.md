# 卫浴商用中心双计业绩表 — dm_sw_business_center_achievement_daily_t

## 表概览

| 属性 | 值 |
|------|-----|
| Schema | `dm` |
| 表名 | `dm_sw_business_center_achievement_daily_t` |
| 列数 | 13 |
| 用途 | **卫浴事业部商用中心双计业绩日报**，按大区×业务类型汇总日/月/年业绩和成本 |
| 时间字段 | `calday` (YYYYMMDD)，日级增量刷新 |
| 更新方式 | `DELETE WHERE calday = '${PERIOD_ID_D}'` + INSERT |
| 数据来源 | `dm_sw_business_center_achievement_daily_F`（中间事实表）+ `upload_sw_commercial_target_t`（目标表） |
| DWS同步 | `PJob_DWS_DM_SW_BUSINESS_CENTER_ACHIEVEMENT_DAILY_T.txt` |
| 适用事业部 | **仅卫浴事业部**（`node_name4 = 'H03230613'`） |

## 列定义

### 维度列

| 列名 | 类型 | 说明 |
|------|------|------|
| `region` | varchar(500) | **销售大区**，来自 `dm_rpt_sales_group_t.node_desc5`（`node_name4='H03230613'`下的5个大区） |
| `business_type` | varchar(500) | **业务类型**：`直营KA` / `工程经销商` / `运营中心` / `1+N` / `未分类` |

### 日/月/年业绩

| 列名 | 单位 | 说明 |
|------|------|------|
| `achievement_day` | 万元 | 当日含税达成额 |
| `achievement_month` | 万元 | 月累计含税达成额 |
| `achievement_year` | 万元 | 年累计含税达成额 |

### 同比业绩

| 列名 | 单位 | 说明 |
|------|------|------|
| `achievement_last_year_month` | 万元 | 去年同月达成额 |
| `achievement_last_year` | 万元 | 去年年累计达成额 |

### 收入/成本

| 列名 | 单位 | 说明 |
|------|------|------|
| `no_tax_month` | 万元 | 月累计不含税收入 |
| `no_tax_year` | 万元 | 年累计不含税收入 |
| `sales_cost_month` | 万元 | 月累计销售成本 |
| `sales_cost_year` | 万元 | 年累计销售成本 |

### 元数据

| 列名 | 说明 |
|------|------|
| `calday` | 数据日期 (YYYYMMDD) |
| `dw_last_update_date` | 同步时间 |

## ETL 流程

```
dm.dm_sw_business_center_achievement_daily_F (中间事实表, 已按region+business_type预聚合)
  ↓ GROUP BY region, business_type
  ↓ HAVING: achievement_year != 0 OR achievement_last_year != 0
  ↓
CROSS JOIN 标题矩阵:
  region_title (5个大区) × business_type_title (直营KA/工程经销商/运营中心)
  + '1+N' / '未分类' 兜底
  ↓
RIGHT JOIN dataresult → 所有标题组合均出现（即使无数据）
  ↓
upload.upload_sw_commercial_target_t (目标表, stat_month匹配)
```

### 标题矩阵（固定显示）

```sql
-- 5个大区（来自组织表 node_name4='H03230613'）
region: node_desc5 WHERE node_name5 IN ('H05230627','H05230628','H05230629','H05230630','H05250102')

-- 3种业务类型
business_type: '直营KA' (seq=1), '工程经销商' (seq=2), '运营中心' (seq=3)

-- 兜底类型
'1+N' (seq=998), '未分类' (seq=999)
```

### 排序规则

```sql
ORDER BY 
  CASE WHEN region LIKE '%大区%' THEN 1 ELSE 2 END,  -- 大区在前
  seq,                                                -- 业务类型按seq
  SUM(achievement_month) OVER (PARTITION BY region) DESC  -- 月业绩高的大区在前
```

## 与瓷砖部门/区域日报的对比

| 维度 | 卫浴商用中心 | 瓷砖部门日报 | 瓷砖区域日报 |
|------|-----------|-----------|-----------|
| 组织层级 | 大区×业务类型（2级） | 6级（系统→大区→运营中心→营销部→线组→客户） | 同左 |
| 渠道分类 | 直营KA/工程经销商/运营中心 | 零售/工程/大包/设计师 | 同左 |
| 产品分类 | 无 | 715/超大板/918/高值等 | 无 |
| 排名 | 无 | 6种排名 | 2种排名 |
| 列数 | 13 | 58 | 25 |
| 事业部 | 卫浴 | 瓷砖 | 瓷砖 |

## 已知陷阱

1. **金额单位是万元**：所有指标已聚合为万元
2. **仅卫浴事业部**：`node_name4 = 'H03230613'`（卫浴商用中心组织节点）
3. **RIGHT JOIN 保证全矩阵**：即使某大区+业务类型无数据，也会输出一行（数值为NULL/0）
4. **无排名**：与瓷砖部门/区域日报不同，该表不计算达成率排名
5. **目标表独立**：使用 `upload_sw_commercial_target_t`，不是瓷砖的 `upload_Sales_performance_target_pus`
6. **上游中间表**：数据来自 `dm_sw_business_center_achievement_daily_F`（中间事实表），该表ETL脚本未归档
7. **双计含义**：商用中心业绩采用双计口径（可能同时在原大区和商用中心计算）
8. **旧业务类型注释**：ETL中"新签约平台"业务类型已注释掉，当前仅3种活跃类型
