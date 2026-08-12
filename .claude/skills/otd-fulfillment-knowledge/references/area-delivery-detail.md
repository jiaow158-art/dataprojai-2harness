# dm_otd_area_delivery_detail_m — 产区交付明细月表

## 概述

| 属性 | 值 |
|---|---|
| Schema | dm |
| 行数 | ~662万 |
| 粒度 | 月 × 交付单行 × 物料 |
| 刷新 | 全量 INSERT OVERWRITE（Hive → GaussDB） |
| ETL | PJob_DM_OTD_AREA_DELIVERY_DETAIL_M.txt (88行) |
| 数据源 | DWI_WM_PRODSTOCK_OUT_IN_T + 8张关联表 |

## 核心定位

按月汇总视角的出库数据，按**产区+收货省份**维度切分。与其他表的关键差异：
- 仅**瓷砖事业部** + **瓷砖物料组**（ETL硬编码）
- 出库量含**正负方向**（S_SHKZG = 冲销为负值）
- 省份信息从 TMS签收单 或 客户主数据 获取

## ETL 关键过滤

| 条件 | 值 |
|---|---|
| 事业部 | 仅 `lev2_name = '瓷砖事业部'` |
| 物料组 | `matl_group_code = '1000010'` |
| 外部物料组 | `external_matl_group_code IN ('10010','10080')` |
| 移动类型 | `601, 602, 643, 644, 653, 654`（销售出库相关） |
| 记录类型 | `MDOC` |

## 列定义

### 主键/凭证

| 列名 | 类型 | 说明 |
|---|---|---|
| voucher_post_date | timestamp | 凭证过账日期 |
| material_vch_no_mblnr | varchar(32) | 物料凭证编号 |
| delivery_im | varchar(32) | 交货单号 |
| delivery_project | varchar(32) | 交货单行号 |

### 物料

| 列名 | 类型 | 说明 |
|---|---|---|
| material_num | varchar(32) | 物料编码 |
| material_name | varchar(256) | 物料名称 |
| dimension | varchar(32) | 规格 |
| product_level2_name | varchar(32) | 产品层级2名称 |
| product_level3_name | varchar(32) | 产品层级3名称 |
| batch_num | varchar(32) | 批次号（前2~3位→产区） |

### 销售关联

| 列名 | 类型 | 说明 |
|---|---|---|
| sale_order_num | varchar(32) | 销售订单号 → 关联 sales_order_det_t.vbeln |
| sale_order_item_num | varchar(32) | 销售订单行号 |

### 产区/地理

| 列名 | 类型 | 说明 |
|---|---|---|
| belong_area_code | varchar(32) | 所属产区编码（批次→产区映射，默认'GD'） |
| belong_area_name | varchar(32) | 所属产区名称（默认'广东基地'） |
| receiving_province | varchar(32) | 收货省份（TMS签收省份优先，否则客户主档省份） |

### 出库量/面积

| 列名 | 类型 | 说明 |
|---|---|---|
| sales_stock_out_qty | numeric | 销售出库数量（冲销为负值） |
| sales_stock_out_area | numeric | 销售出库面积 = 数量 × 长 × 宽 / 1000000 |
| dr_cr_id | varchar(32) | 借贷标识（S_SHKZG=冲销，出库量已做正负处理） |

### 维度

| 列名 | 类型 | 说明 |
|---|---|---|
| dis_channel_name | varchar(32) | 分销渠道名称 |
| op_partment | varchar(64) | 运营部门（优先销售组部门，否则组织层级） |

### 其他

| 列名 | 类型 | 说明 |
|---|---|---|
| stat_month | varchar(16) | 统计月份（YYYY-MM，substr(voucher_post_date,1,7)） |
| dw_last_update_date | timestamp | 数据同步时间 |

## 常用查询模式

### 产区月度出库汇总

```sql
SELECT stat_month, belong_area_name,
       SUM(sales_stock_out_qty) as total_qty,
       SUM(sales_stock_out_area) as total_area
FROM dm.dm_otd_area_delivery_detail_m
WHERE stat_month BETWEEN '2026-01' AND '2026-06'
GROUP BY stat_month, belong_area_name
ORDER BY stat_month, total_area DESC;
```

### 收货省份TOP

```sql
SELECT receiving_province,
       SUM(sales_stock_out_qty) as total_qty,
       SUM(sales_stock_out_area) as total_area
FROM dm.dm_otd_area_delivery_detail_m
WHERE stat_month = '2026-06'
GROUP BY receiving_province
ORDER BY total_area DESC
LIMIT 20;
```

### 产区×渠道交叉

```sql
SELECT belong_area_name, dis_channel_name,
       SUM(sales_stock_out_area) as total_area
FROM dm.dm_otd_area_delivery_detail_m
WHERE stat_month = '2026-06'
GROUP BY belong_area_name, dis_channel_name
ORDER BY total_area DESC;
```

## 已知陷阱

1. **仅瓷砖事业部！** 卫浴数据不在本表。ETL硬编码 `lev2_name = '瓷砖事业部'`
2. **仅瓷砖物料**：matl_group_code='1000010' + external_matl_group_code IN ('10010','10080')
3. **出库量可为负**（冲销/退货），汇总时大部分场景应取绝对值或过滤
4. **stat_month 是字符串** YYYY-MM 格式（如'2026-06'），用 BETWEEN 比较
5. **产区默认值**：批次匹配不到产区时填 'GD'/'广东基地'
6. **省份来源两条路径**：TMS签收省份（优先）> 客户主档省份。TMS匹配不到时才会fallback
7. **移动类型包含退货**：602/644/654 是退货移动类型，出库量已通过 dr_cr_id 做正负处理
8. **同物料可能多行**：同一订单物料在不同批次会有多行记录（不同批次的产区不同）
