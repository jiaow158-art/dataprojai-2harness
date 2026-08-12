# dm_otd_no_deliver_order_dtl — 未交付订单明细

## 概述

| 属性 | 值 |
|---|---|
| Schema | dm |
| 行数 | ~1,854（仅未交付订单，非常小） |
| 粒度 | WBS行号 × SAP订单行 |
| 刷新 | 全量 INSERT OVERWRITE（Hive → GaussDB） |
| ETL | PJob_DM_OTD_NO_DELIVER_ORDER_DTL.txt (99行) |
| 数据源 | SDI_SALE_ORDER_DTL_1007, SDI_SALE_ORDER_1007, SDI_ITEM_1007, SDI_CSM_CUSTOMER_1007 |

## 核心定位

这是 OTD 域**唯一专用于未交付分析的轻量表**。ETL 固定过滤条件使行数始终保持在千级，可全表扫描。

## ETL 过滤条件（决定数据范围的关键）

| 过滤条件 | 值 | 影响 |
|---|---|---|
| ORDER_TYPE | != '零售销售订单' | **零售未交付不在此表** |
| ACTUAL_NET_DEMAND_QTY | > 0 | 仅未交付数量>0 |
| CALCULATION_FLAG | = 0 | 正常计算行 |
| DETAIL_STATE | = 0 | 正常状态明细 |
| ORDER_PROGRESS_STATE | IN (6,7,8,9,10,11) | 生产进度6~11 |
| INV_ORG_ID | = 1 | 主体组织 |
| IS_PHANTOM | = 0 | 非虚拟数据 |

## 列定义

### 主键/关联

| 列名 | 类型 | 说明 |
|---|---|---|
| wbs_line_no | varchar(255) | WBS行号（唯一标识） |
| order_num | varchar(255) | SAP单号 → 关联 sales_order_det_t.vbeln |
| order_item_num | varchar(255) | SAP行号 → 关联 sales_order_det_t.posnr |

### 物料信息

| 列名 | 类型 | 说明 |
|---|---|---|
| material_num | varchar(255) | 物料编码 |
| prod_category | varchar(255) | 品类 |
| dimesion | varchar(255) | 规格 |
| unit_area | numeric | 单位面积 |

### 工厂/基地

| 列名 | 类型 | 说明 |
|---|---|---|
| factory_code | varchar(255) | 下单工厂 |
| product_area | varchar(255) | 基地 |
| inhouseoutsourcedflag | varchar(255) | 自制外协标识 |

### 组织信息（来自 dm_rpt_sale_grp_t）

| 列名 | 类型 | 说明 |
|---|---|---|
| sale_org | varchar(255) | 销售组织 |
| sale_dept | varchar(255) | 销售部门 |
| sale_group | varchar(255) | 销售组 |
| sale_lev3 | varchar(255) | 销售组织层级3 |
| sale_lev4 | varchar(255) | 销售组织层级4 |
| sale_lev5 | varchar(255) | 销售组织层级5 |
| sale_lev6 | varchar(255) | 销售组织层级6 |

### 客户/渠道

| 列名 | 类型 | 说明 |
|---|---|---|
| cust_name | varchar(255) | 客户名称（OSS客户） |
| chanel_code | varchar(255) | 渠道（OSS原始编码） |

### 时间

| 列名 | 类型 | 说明 |
|---|---|---|
| order_time | varchar(255) | 订单下单时间 |
| expect_date | varchar(255) | 客户交期 |

### 核心指标

| 列名 | 类型 | 说明 |
|---|---|---|
| nodeliver_qty_aps | numeric | **未交付数量**（APS实际净需求） |
| nodeliver_area_aps | numeric | **未交付面积**（nodeliver_qty × unit_area） |

### 其他

| 列名 | 类型 | 说明 |
|---|---|---|
| pernrname | varchar(255) | 计划单创建人 |
| del_flag | varchar(255) | 删除标识 |
| dw_last_update_date | timestamp | 最后更新时间 |

## 常用查询模式

### 未交付汇总（按组织层级3）

```sql
SELECT sale_lev3,
       COUNT(*) as order_lines,
       SUM(nodeliver_qty_aps) as total_undeliver_qty,
       SUM(nodeliver_area_aps) as total_undeliver_area
FROM dm.dm_otd_no_deliver_order_dtl
WHERE del_flag = 'N'
GROUP BY sale_lev3
ORDER BY total_undeliver_area DESC;
```

### 未交付明细（含客户交期）

```sql
SELECT order_num, material_num, prod_category, cust_name,
       nodeliver_qty_aps, nodeliver_area_aps,
       order_time, expect_date
FROM dm.dm_otd_no_deliver_order_dtl
WHERE del_flag = 'N'
ORDER BY nodeliver_area_aps DESC
LIMIT 200;
```

### 关联订单底表补充信息

```sql
SELECT nd.order_num, nd.material_num, nd.nodeliver_qty_aps,
       det.kwmeng as order_qty, det.vmeng as confirm_qty,
       det.cust_name, det.zh_channel_name1
FROM dm.dm_otd_no_deliver_order_dtl nd
LEFT JOIN dm.dm_otd_sales_order_det_t det
  ON nd.order_num = det.vbeln
  AND nd.order_item_num = det.posnr
WHERE nd.del_flag = 'N';
```

## 已知陷阱

1. **不包含零售订单** — ETL硬编码 `ORDER_TYPE != '零售销售订单'`，零售未交付需从 sales_order_det_t 自行筛选
2. **生产进度限定 6~11** — 进度状态1~5的订单即使有未交付也不在此表
3. **数据来源是OSS系统**（非SAP），与 sales_order_det_t 的订单编号口径可能有差异
4. **chanel_code 是OSS原始编码**，不是整合渠道编码。渠道中文名需另查维表
5. **del_flag 字段存在**，始终 = 'N'（ETL硬编码），但查询时建议加 WHERE del_flag = 'N'
