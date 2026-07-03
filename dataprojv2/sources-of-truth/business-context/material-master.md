# 物料主数据

## 数据源

- **DWS 表**：`dwrdim.dwr_dim_material_general_d`
- **更新频率**：SCD Type 2（`start_date` / `end_date`，`dw_last_update_date` 记录最后更新时间）
- **数据量**：360 万行，25.7 万唯一物料
- **用途**：跨领域物料基础信息——库存、费用、应收、销售等所有领域均需物料维度

## 核心字段

### 标识字段

| 字段 | 说明 |
|------|------|
| `material_num` | 物料编码（唯一业务键） |
| `material_name` | 物料名称 |
| `material_id` | 代理键 |

### 分类层级

| 字段 | 说明 | 唯一值数 |
|------|------|----------|
| `matl_group_code` / `matl_group_name` | 物料组（瓷砖/卫浴/原材料/…） | 18 |
| `matl_type_code` / `matl_type_name` | 物料类型（成品/原材料/…） | 9 |
| `product_group_code` / `product_group_name` | 产品组（瓷砖/卫浴/跨产品组/…） | 11 |
| `product_level_code` / `product_level_name` | 产品层级（最细粒度） | ~2,500 |
| `product_classify_code` / `product_classify_name` | 产品分类 | — |
| `product_position_code` / `product_position_name` | 产品定位 | — |
| `product_func_code` / `product_func_name` | 产品功能 | — |
| `product_specify_code` / `product_specify_name` | 产品规格 | — |

### 品牌与属性

| 字段 | 说明 | 唯一值数 |
|------|------|----------|
| `matl_brand` | 品牌（编码，如 A16） | 77 |
| `matl_origion` | 产地 | 68 |
| `matl_texture` | 材质 | 6 |
| `color_code` / `color_name` | 颜色 | — |
| `faces_code` / `faces_name` | 表面 | — |
| `new_product_code` / `new_product_name` | 新品标识 | — |

### 物理属性

| 字段 | 说明 |
|------|------|
| `length_1` | 长度 |
| `width` | 宽度 |
| `height` | 高度 |
| `gross_weight` | 毛重 |
| `net_weight` | 净重 |
| `size_unit` | 尺寸单位 |
| `weight_unit` | 重量单位 |
| `dimension` | 规格描述 |
| `total_shelf_life` | 保质期 |
| `batch_mngnt_require_flag` | 批次管理标记 |

### SCD 控制字段

| 字段 | 说明 |
|------|------|
| `del_flag` | 删除标记（`X` = 已删除） |
| `start_date` | 版本生效日期 |
| `end_date` | 版本失效日期 |
| `dw_last_update_date` | DWS 最后更新日期 |

## 与各域的关联方式

所有域的事实表中均有物料编码字段，直接 `WHERE` 或 `JOIN`：

```sql
-- 费用表
SELECT ... FROM dm.dm_fact_finance_cost_f WHERE material_code = 'xxx'
-- 库存表
SELECT ... FROM dm.dm_fin_stock_detail_accage_t_2023 WHERE material = 'xxx'
-- 应收表通过物料关联较少，通常不直接使用
```

关联物料主数据获取物料属性：

```sql
SELECT f.*, m.matl_group_name, m.matl_brand, m.product_group_name
FROM dm.dm_fact_finance_cost_f f
LEFT JOIN dwrdim.dwr_dim_material_general_d m
  ON f.material_code = m.material_num
  AND (m.del_flag IS NULL OR m.del_flag != 'X')
  AND m.start_date <= CURRENT_DATE
  AND (m.end_date IS NULL OR m.end_date > CURRENT_DATE)
WHERE f.month = '2026-06';
```

## 注意事项

- **SCD Type 2**：同一 `material_num` 可能有多条记录，取 `del_flag != 'X'` 且当前有效版本
- **material_num 可能重复**：由于 SCD，`material_id` 才是代理键
- **品牌编码 vs 品牌名称**：`matl_brand` 为编码，描述字段需用 `matl_group_name` 等
- **物料名称含规格**：`material_name` 通常包含尺寸/用途等描述性信息
