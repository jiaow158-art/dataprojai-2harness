# 仓库库存 / 全类型库存

## 快速参考

- **仓库库存 API 表**：`dm.dm_dp_api_warehouse_stock`（16,929 行，9 列）
- **全类型库存表**：`dm.dm_wm_all_type_stock_t`（144,395 行，81 列）
- **业务含义**：
  - API 表：面向 FineReport 的库存快照，按仓库类型+财务类别+物料汇总
  - 全类型表：包含所有库存类型（可用、冻结、质检、在途等）的宽表

## dm_dp_api_warehouse_stock

| 字段 | 含义 |
|---|---|
| warehouse_type | 仓库类型 |
| fin_cate | 财务类别 |
| dimension | 规格 |
| material_num | 物料号 |
| material_name | 物料名称 |
| stock_area | 库存面积（平米） |
| sales_center_code | 销售中心编码 |
| sales_center | 销售中心名称 |
| dw_last_update_date | 最后更新日期 |

## dm_wm_all_type_stock_t

核心字段（共 81 列）：

| 字段 | 含义 |
|---|---|
| material_id / material_num / material_name | 物料 ID / 编码 / 名称 |
| external_matl_group_code | 外部物料组编码 |
| matl_group_code | 物料组编码 |
| matl_group1_code~5_code / matl_group1~5_name | 物料组 1-5 级编码/名称 |
| product_channel_code / product_channel_name | 产品渠道 |
| product_stage2 | 产品二级阶段 |
| product_level_code / product_level_code1~6 | 产品级别编码 |
| brand_name | 品牌名称 |
| size_unit / length_1 / width / dimension | 规格 |
| factory_werks_id / factory_werks_code / factory_werks_name | 工厂 |
| inv_location / inv_location_name | 库存地点 |
| batch_num | 批次号 |
| wbs_element / long_wbs_element | WBS 要素 |
| cust_id / cust_num / cust_name | 客户 |
| supplier_or_creditor_id / supplier_or_creditor_num / supplier_or_creditor_name | 供应商/债权人 |
| product_area_id / product_area_code / product_area_name | 产区 |
| production_date | 生产日期 |
| first_promote_date | 首次促销日期 |
| promote_reason_code / promote_reason | 促销原因 |
| clearance_reason_code / clearance_reason | 清理原因 |
| obsol_date | 淘汰日期 |

**库存数量字段**：`total_inventory_quantity`（总库存），`available_inventory_quantity`（可用），`project_inventory_quantity`（项目），`qc_inventory_quantity`（质检），`frozen_inventory_quantity`（冻结），`reserve_inventory_quantity`（预留），`prepar_inventory_quantity`（准备），`projectqc_inventory_quantity`，`profrozen_inventory_quantity`，`proreserve_inventory_quantity`，`proprepar_inventory_quantity`，`available_proinventory_quantity`，`all_stock_quantity`，`other_stock_quantity`

**库存面积字段**（同上结构，后缀 `_area`）：`total_inventory_area`，`available_inventory_area`，`project_inventory_area`，`qc_inventory_area`，`frozen_inventory_area`，`reserve_inventory_area`，`prepar_inventory_area`

## 陷阱

1. `dm_dp_api_warehouse_stock` 是定期刷新的快照表（看 `dw_last_update_date`），不是实时库存
2. 全类型库存表包含 82 个工厂、15 个渠道的数据，查询必须带工厂或渠道过滤
3. 库存面积和数量的单位可能不一致（有的按片/箱，有的按平米），取数时注意 `dimension` 或 `size_unit`

## 常见查询模式

### 某仓库类型库存概览
```sql
SELECT warehouse_type, fin_cate, COUNT(DISTINCT material_num) as sku_cnt,
       SUM(stock_area) as total_area
FROM dm.dm_dp_api_warehouse_stock
GROUP BY warehouse_type, fin_cate
ORDER BY total_area DESC;
```

### 按工厂+渠道查全类型库存
```sql
SELECT factory_werks_code, factory_werks_name,
       product_channel_name, brand_name,
       COUNT(DISTINCT material_num) as sku_cnt
FROM dm.dm_wm_all_type_stock_t
GROUP BY factory_werks_code, factory_werks_name,
         product_channel_name, brand_name
ORDER BY sku_cnt DESC;
```

## 交叉引用

- 库存账龄明细 → [stock-accage.md](stock-accage.md)
- 出入库明细 → [inout-stock.md](inout-stock.md)
