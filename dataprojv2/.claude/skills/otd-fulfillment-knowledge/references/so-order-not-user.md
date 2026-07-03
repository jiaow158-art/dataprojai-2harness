# dm_otd_so_order_not_user_t — 订单履约全链路跟踪

## 概述

| 属性 | 值 |
|---|---|
| Schema | dm |
| 行数 | ~794万 |
| 粒度 | 订单行（sap_number + sap_item_num + batch） |
| 刷新 | 全量 INSERT OVERWRITE |
| ETL | PJob_DM_OTD_SO_ORDER_NOT_USER_T.txt (119行) |
| 数据源 | DWR_OTD_SO_SALE_OFR_ORDER_F + 10张DWR关联表 |

## 核心定位

这是 OTD 域**唯一的全链路状态+耗时跟踪表**。从订单创建到客户签收的8个环节，每个环节的状态和耗时都在此表中。

## 列定义

### 主键/关联键

| 列名 | 类型 | 说明 |
|---|---|---|
| order_num | varchar(255) | 订单编号（OSS订单号） |
| item_number | varchar(255) | 订单行（OSS行号） |
| sap_number | varchar(255) | SAP单号 → 关联 sales_order_det_t.vbeln |
| sap_item_num | varchar(255) | SAP行号 → 关联 sales_order_det_t.posnr |

### 物料信息

| 列名 | 类型 | 说明 |
|---|---|---|
| material_num | varchar(255) | 物料编号 |
| material_description | varchar(255) | 物料描述 |
| material_specifications | varchar(255) | 物料规格 |
| unit_area | numeric | 单位面积 |
| unit_weight_kg | numeric | 单位重量（KG） |
| material_group1 | varchar(255) | 物料组1 |
| quantity | numeric | 数量 |

### 客户/组织

| 列名 | 类型 | 说明 |
|---|---|---|
| customer_code | varchar(255) | 客户编码 |
| sales_organization | varchar(255) | 销售组织 |
| sales_channel | varchar(255) | 分销渠道（SAP原始编码） |
| sales_employee | varchar(255) | 销售雇员 |
| plan_order_type | varchar(255) | 计划订单类型 |

### 工厂/库存

| 列名 | 类型 | 说明 |
|---|---|---|
| supply_area | varchar(255) | 供货产区 |
| factory_code | varchar(255) | 工厂编码 |
| stock_location | varchar(255) | 库存地点 |
| batch | varchar(255) | 批次 |

### 时间节点

| 列名 | 类型 | 说明 |
|---|---|---|
| creation_time | timestamp | 创建时间 |
| submission_time | timestamp | 提交时间 |
| approval_time | timestamp | 评审通过时间 |
| required_delivery_date | varchar(255) | 需求交货日期（来自计划订单审批表） |
| expected_delivery_time | timestamp | 预计交付时间（来自生产订单） |

### 耗时指标（格式化字符串：'X天Y小时'）

| 列名 | 类型 | 说明 | 计算来源 |
|---|---|---|---|
| billing_time | varchar(255) | 开单耗时 | submission_time - creation_time |
| evaluation_time | varchar(255) | 评审耗时 | approval_time - submission_time |
| total_proofing_time | varchar(255) | 总对版时长 | 06A节点 - 01A节点 |
| business_confirmation_prototype_time | varchar(255) | 业务确认样板耗时 | 15A节点 - 07A节点 |
| base_prototype_time | varchar(255) | 基地仿版耗时 | 05A节点 - 04B节点 |
| holding_duration | varchar(255) | 留货耗时 | 留货时间 - 评审通过时间 |

### 留货环节

| 列名 | 类型 | 说明 |
|---|---|---|
| confirmed_quantity | numeric | 已确认（留货）数量 |
| holding_status | varchar(255) | 留货状态: 待留货 / 已留货 |
| holding_time | varchar(255) | 留货时间 |
| holding_days | integer | 留货天数（当前日期 - 留货日期） |
| holding_warning | — | **恒为NULL**（ETL未实现） |
| stock_quantity_summary | numeric | 备货数量汇总（提货单数量窗口累加） |
| pickup_application_status | varchar(255) | 提货申请状态: 待申请提货 / 已申请提货 |

### 仓库/出库环节

| 列名 | 类型 | 说明 |
|---|---|---|
| warehouse_order_quantity | numeric | 仓库接单数量 |
| warehouse_order_status | varchar(255) | 仓库接单状态: 待接单 / 已接单 |
| shipped_quantity | numeric | 已出库数量 |
| outbound_status | varchar(255) | 出库状态: 待出库 / 已出库 |
| is_sealing | — | **恒为NULL**（ETL未实现） |

### 发运/签收环节

| 列名 | 类型 | 说明 |
|---|---|---|
| shipping_quantity | numeric | 发运数量 |
| shipping_status | varchar(255) | 发运状态: 待发运 / 已发运 |
| received_quantity | numeric | 签收数量 |
| receiving_status | varchar(255) | 签收状态: 待签收 / 已签收 |

### 样板/生产

| 列名 | 类型 | 说明 |
|---|---|---|
| prototype_available | varchar(255) | 有无样板 (是/否，PAM_GENE_BOARD_INFO_T 物料存在即为是) |
| order_progress_status | varchar(255) | 订单进度状态（生产订单进度） |

### 其他

| 列名 | 类型 | 说明 |
|---|---|---|
| row_status | varchar(255) | 行状态 |

### 系统字段

| 列名 | 类型 | 说明 |
|---|---|---|
| dw_last_update_time | timestamp | 最后更新时间（ETL写入时间） |

## OTD 全链路状态查询

### 各环节状态分布

```sql
SELECT row_status,
       COUNT(*) as order_lines,
       SUM(CASE WHEN holding_status = '待留货' THEN 1 ELSE 0 END) as pending_hold,
       SUM(CASE WHEN holding_status = '已留货' THEN 1 ELSE 0 END) as held,
       SUM(CASE WHEN outbound_status = '待出库' THEN 1 ELSE 0 END) as pending_outbound,
       SUM(CASE WHEN outbound_status = '已出库' THEN 1 ELSE 0 END) as outbounded,
       SUM(CASE WHEN shipping_status = '已发运' THEN 1 ELSE 0 END) as shipped,
       SUM(CASE WHEN receiving_status = '已签收' THEN 1 ELSE 0 END) as received
FROM dm.dm_otd_so_order_not_user_t
WHERE creation_time >= '2026-05-01'
GROUP BY row_status;
```

### 留货超期预警（留货>30天）

```sql
SELECT t.order_num, t.sap_number, t.material_num, t.material_description,
       t.customer_code, t.quantity, t.holding_days, t.holding_status
FROM dm.dm_otd_so_order_not_user_t t
WHERE t.creation_time >= '2026-01-01'
  AND t.holding_days > 30
ORDER BY t.holding_days DESC
LIMIT 200;
```

### 履约全链路耗时分析

```sql
SELECT plan_order_type,
       COUNT(*) as order_count,
       AVG(CAST(SUBSTRING(billing_time FROM '^[0-9]+') AS INTEGER)) as avg_billing_hours,
       AVG(CAST(SUBSTRING(evaluation_time FROM '^[0-9]+') AS INTEGER)) as avg_eval_hours,
       AVG(holding_days) as avg_holding_days
FROM dm.dm_otd_so_order_not_user_t
WHERE creation_time >= '2026-05-01'
GROUP BY plan_order_type
ORDER BY order_count DESC;
```

## 已知陷阱

1. **耗时字段是字符串**（'X天Y小时'），不能直接算术运算。需用 SUBSTRING 解析
2. **holding_warning 和 is_sealing 恒为NULL** — ETL 未实现这两个字段
3. **creation_time 是 timestamp**，用 `>= '2026-05-01'` 过滤，不是 BETWEEN 字符串
4. **留货天数(holding_days)动态变化** — 计算逻辑为 datediff(current_date, 留货时间)，每天跑数结果不同
5. **shipped_quantity 来自 DWR_WM_PRODSTOCK_OUT_IN_F**，与 sales_order_det_t.mengef 口径不同
6. **TMS预约单排除 CANCELED 和 EXIT** — 发运/签收相关字段已过滤取消和离场状态
7. **关联 sales_order_det_t 用 sap_number/sap_item_num = vbeln/posnr**（不是 order_num）
