---
name: otd-fulfillment-knowledge
description: OTD履约领域数据知识库。当用户询问订单履约、交付进度、签收状态、留货时长、未交付订单等OTD相关问题时自动激活。覆盖 DM 层的 OTD 履约数据模型。
---

# OTD 履约领域 — 数据知识路由

## 作用

本 Skill 是路由层。根据用户问题类型，引导到对应的参考文档获取准确的表结构、字段含义、过滤条件和查询模式。

## 可用的参考文档

### 语义层（必须首先查阅）

| 文档 | 说明 |
|---|---|
| **[metrics.md](references/metrics.md)** | **🔴 强制优先阅读**。概念→字段映射、表选择决策树、OTD全链路状态机、所有已知陷阱 |

### 表级参考文档

| 文档 | 对应问题类型 |
|---|---|
| [sales-order-det.md](references/sales-order-det.md) | **订单底表**（默认首选）。订单数量/面积/金额、确认量、交期、客户、渠道、产品维度。899万行 |
| [so-order-not-user.md](references/so-order-not-user.md) | **履约全链路跟踪**。开单→评审→留货→出库→发运→签收各节点状态+耗时。794万行 |
| [no-deliver-order-dtl.md](references/no-deliver-order-dtl.md) | **未交付订单明细**。未交付数量/面积、超期分析、按组织/渠道/客户下钻。1854行（仅未交付） |
| [area-delivery-detail.md](references/area-delivery-detail.md) | **产区交付汇总月表**。出库量/面积、产区×收货省份×渠道。662万行，仅瓷砖事业部 |

### 血缘文档

| 文档 | 说明 |
|---|---|
| [data-lineage.md](references/data-lineage.md) | 数据血缘、表之间如何关联、从SAP源表到DM的路径 |

## 跨域共享参考

组织架构等跨领域主数据，存放在 Sources of Truth 层，所有 domain skill 共用：

| 文档 | 说明 |
|---|---|
| **[组织架构](../../sources-of-truth/business-context/org-hierarchy.md)** | 10级销售组织树（node1~node10），node2 事业部枚举值 |
| **[客户主数据](../../sources-of-truth/business-context/customer-master.md)** | 客户名称/分组/销售区域/销售组 |
| **[物料主数据](../../sources-of-truth/business-context/material-master.md)** | 物料维度（品牌/品类/产品层级） |
| **[公司&工厂](../../sources-of-truth/business-context/company-plant.md)** | 公司/工厂主数据 |

## 使用方式

1. **首先**加载 [metrics.md](references/metrics.md) 语义层，理解概念映射和表选择决策树
2. 根据决策树确定使用哪张表
3. 使用 `Read` 工具加载对应的表级参考文档
4. 根据文档中的表结构、过滤条件、陷阱提示，给出查询方案或直接生成 SQL

## 标准全局过滤条件

- **大表必须带过滤**: `dm_otd_sales_order_det_t`（899万行）和 `dm_otd_so_order_not_user_t`（794万行）必须带时间或组织过滤
- 时间字段格式:
  - `dm_otd_sales_order_det_t`: `erdat` (YYYYMMDD 字符串，记录建立日期), `audat` (YYYYMMDD 字符串，订单日期)
  - `dm_otd_so_order_not_user_t`: `creation_time` (timestamp), `submission_time` (timestamp), `approval_time` (timestamp)
  - `dm_otd_area_delivery_detail_m`: `stat_month` (YYYY-MM 字符串), `voucher_post_date` (timestamp)
- 渠道字段:
  - `dm_otd_sales_order_det_t`: `zh_channel_code1` (整合渠道1: GD01/GD02/GD03), `zh_channel_code2` (整合渠道2: GG01~GG08/GD04)
  - `dm_otd_so_order_not_user_t`: `sales_channel` (分销渠道原始编码)
- 备份表排除:
  - `dm_otd_sales_order_det_t_20240329`（public schema）— 不可用
  - `dm_otd_sales_order_timespan_m_260416_wjh` — 不可用
  - `dm_otd_sales_forecast_stat_t_0515`（public schema）— 不可用
- `dm_otd_area_delivery_detail_m` 仅限瓷砖事业部（ETL 硬编码 `lev2_name = '瓷砖事业部'`）
- `dm_otd_no_deliver_order_dtl` 排除零售销售订单（ETL 硬编码 `ORDER_TYPE != '零售销售订单'`）
