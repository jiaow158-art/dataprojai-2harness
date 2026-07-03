# 业绩目标填报表 — upload_Sales_performance_target_pus

## 表概览

| 属性 | 值 |
|------|-----|
| Schema | `upload` |
| 表名 | `upload_Sales_performance_target_pus` |
| 列数 | 48 |
| 用途 | **瓷砖事业部部门/区域级月度目标的权威来源**，驱动部门业绩日报和区域业绩日报的目标达成率计算 |
| 更新频率 | 低频（年初填报全年12个月目标，月度调整） |
| 使用者 | `DM_RPT_CT_DEPARTMENT_SALES_PERFORMANCE_T`、`DM_RPT_REGION_PERFORMANCE_DAILY_REPORT_T` |

## 列定义

### 组织维度

| 列名 | 类型 | 说明 |
|------|------|------|
| `marketing_department` | text | **营销部**（上级组织），如"广佛运营中心"、"深圳子公司" |
| `regional_group` | text | **线组**（下级组织），如"广州组"、"佛山大包组" |
| `parent_level` | varchar(50) | 父级层级标记 |
| `channel` | varchar(50) | 渠道类型标记 |
| `name` | varchar(50) | 名称 |
| `type` | varchar(50) | 类型标记 |
| `bore` | text | **口径标记**（区分不同目标口径） |

### 目标值列——主目标（12个月）

| 列名 | 类型 | 说明 |
|------|------|------|
| `january_value` ~ `december_value` | numeric | 各月目标销售额（**万元**） |
| `all_year_value` | numeric | 全年合计目标 |

### 目标值列——N产品目标（12个月）

| 列名 | 类型 | 说明 |
|------|------|------|
| `N_january_value` ~ `N_december_value` | numeric | 各月1+N产品目标（万元） |

### 目标值列——高值产品目标（12个月）

| 列名 | 类型 | 说明 |
|------|------|------|
| `high_january_value` ~ `high_december_value` | numeric | 各月高值产品目标（万元） |

### 元数据

| 列名 | 类型 | 说明 |
|------|------|------|
| `分布列` | integer | 分布列（默认0） |
| `stat_year` | varchar(50) | 统计年度 |
| `年份` | varchar(20) | 年份（中文列名） |
| `dw_last_update_date` | timestamp | 最后更新日期 |

## 组织层级模型

用 `marketing_department` (营销部) 和 `regional_group` (线组) 定义两级组织目标体系：

```
营销部 (marketing_department) ← 上级
  └── 线组 (regional_group) ← 下级
```

### 组织类型判定（ETL中实现）

| 命名模式 | 组织类型 | ETL目标CTE |
|---------|---------|-----------|
| `%运营中心%` / `%子公司%` / `%市场中心%`（不含"渠道"） | **三级** | `三级月目标` |
| `%营销部%` / `%渠道%` / `%设计师业务%` | **四级** | `四级月目标` |
| `营销部 != 线组` 或 `线组 like '%设计师业务%'` | **五级** | `五级月目标` |

**关键规则**：
- `marketing_department = regional_group` → 上级自身目标（三级/四级）
- `marketing_department != regional_group` → 线组在下级的目标（五级）
- "大包市场部" 统一替换为 "大包市场中心"
- "设计师渠道" 统一替换为 "设计师业务"

## ETL 使用方式

### 目标拆解（unpivot 12个月列）

```sql
SELECT 
    replace(marketing_department, '设计师渠道', '设计师业务') AS 营销部,
    replace(regional_group, '设计师渠道', '设计师业务') AS 线组,
    unnest(string_to_array(
        COALESCE(january_value,'0') || ',' || COALESCE(february_value,'0') || ',' ||
        ... COALESCE(december_value,'0')), ',')) AS 目标,
    年份 || '-' || unnest(string_to_array('01,02,...,12', ',')) AS 月份
FROM upload.upload_Sales_performance_target_pus
```

### 达成率排名

```sql
-- 三级排名 = 月业绩 / 三级月目标
SELECT a.三级,
  ROW_NUMBER() OVER (
    ORDER BY CASE WHEN SUM(三级月目标)=0 THEN 0 
             ELSE SUM(月业绩)/SUM(三级月目标) END DESC
  ) AS 三级排名
FROM 业绩 a JOIN 三级月目标 b ON a.三级 = b.营销部
GROUP BY a.三级
```

## 与 dm_dp_api_sales_target 的区别

| 维度 | `upload_Sales_performance_target_pus` | `dm_dp_api_sales_target` |
|------|--------------------------------------|--------------------------|
| 组织层级 | 营销部→线组（2级） | 中心→营销部→销区（3级） |
| 子目标 | 含 1+N、高值 | 含 1+N、辅材、旗舰、IW、特惠品、大包、世界印象、整装新品 |
| 使用者 | 瓷砖部门/区域日报 | API 目标接口（全事业部） |
| 时间粒度 | 月（12列 unpivot） | 月（行级） |
| 金额单位 | **万元** | **万元** |

## 已知陷阱

1. **金额单位是万元**：与 Mix 表 `ambperformance`（元）差 10000 倍
2. **组织名称会变**：ETL 做名称替换（"大包市场部"→"大包市场中心"、"设计师渠道"→"设计师业务"）
3. **12列 unpivot**：不要直接 `SELECT january_value`，需按 ETL 模式做 unpivot
4. **仅瓷砖事业部**：卫浴有独立的 `upload_sw_region_pk_target_t`
5. **调整数**：部门业绩日报 ETL 有"调整数"逻辑（年度排名时加到年业绩上），区域日报无
6. **N产品和高值子目标**：列存在但当前 ETL 未消费
