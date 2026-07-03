# OTD 履约域技能设计

## 概述

新增 OTD（Order-To-Delivery）履约域，覆盖订单全链路履约监控。遵循现有 paired-skill 模式，创建 `otd-fulfillment-knowledge` + `otd-fulfillment-analyst` 两个技能。

## 业务范围

**订单履约监控** — 订单全链路跟踪（开单→评审→留货→出库→发运→签收），各环节状态/耗时。

## 核心表（4张，全部可查询）

| 表 | 行数 | 粒度 | 定位 |
|---|---|---|---|
| `dm_otd_sales_order_det_t` | 899万 | SAP订单行 | **订单底表**：数量/面积/金额、确认量、交期、渠道、产品维度 |
| `dm_otd_so_order_not_user_t` | 794万 | 订单行 | **全链路跟踪**：各节点耗时+状态（开单/评审/留货/出库/发运/签收） |
| `dm_otd_no_deliver_order_dtl` | 1,854 | WBS×订单行 | **未交付明细**：未交付数量/面积、超期、按组织/渠道/客户 |
| `dm_otd_area_delivery_detail_m` | 662万 | 月×产区 | **交付汇总**：出库量/面积、产区×收货省份、渠道 |

## 文件结构

```
skills/
├── otd-fulfillment-knowledge/
│   ├── SKILL.md                          # 路由 + 全局过滤 + 跨域共享引用
│   └── references/
│       ├── metrics.md                    # 语义层（概念→字段映射、表选择决策树、已知陷阱）
│       ├── data-lineage.md               # 数据血缘（SAP→DWR→DM）
│       ├── sales-order-det.md            # 表参考：订单底表（83列）
│       ├── so-order-not-user.md          # 表参考：履约跟踪（50列）
│       ├── no-deliver-order-dtl.md       # 表参考：未交付明细（26列）
│       └── area-delivery-detail.md       # 表参考：交付汇总月表（22列）
│
└── otd-fulfillment-analyst/
    └── SKILL.md                          # 6步法 + 常用分析模式 + 对抗性审查
```

## 表关联关系

```
dm_otd_sales_order_det_t (订单底表)
  │ vbeln / sap_order_num
  ├── dm_otd_so_order_not_user_t (履约跟踪)
  │     补充：各节点耗时、留货状态、签收状态
  │
  └── dm_otd_no_deliver_order_dtl (未交付)
        筛选：nodeliver_qty_aps > 0

dm_otd_area_delivery_detail_m (交付汇总)
  独立月表，按产区+收货省份聚合
```

## 关键业务概念

### OTD 全链路状态机

```
创建 → 提交 → 评审通过 → 留货(待留货→已留货) → 提货申请 → 仓库接单 → 出库 → 发运 → 签收
```

### 耗时指标

| 指标 | 字段 | 表 |
|---|---|---|
| 开单耗时 | billing_time | so_order_not_user_t |
| 评审耗时 | evaluation_time | so_order_not_user_t |
| 留货耗时 | holding_duration | so_order_not_user_t |
| 留货天数 | holding_days | so_order_not_user_t |
| 总对版时长 | total_proofing_time | so_order_not_user_t |
| 业务确认样板耗时 | business_confirmation_prototype_time | so_order_not_user_t |

### 状态字段

| 环节 | 状态字段 | 取值示例 |
|---|---|---|
| 留货 | holding_status | 待留货 / 已留货 |
| 提货 | pickup_application_status | 待申请提货 / 已申请提货 |
| 仓库接单 | warehouse_order_status | 待接单 / 已接单 |
| 出库 | outbound_status | 待出库 / 已出库 |
| 发运 | shipping_status | 待发运 / 已发运 |
| 签收 | receiving_status | 待签收 / 已签收 |

## 已知风险

1. **大表查询** — 订单底表 899 万行、履约表 794 万行，必须带时间/组织过滤
2. **时间字段格式不一致** — 需从 ETL 脚本确认各表的时间字段格式
3. **组织字段映射** — 部分表缺少 `node_desc` 字段，需 JOIN `dm_rpt_sales_group_t`
4. **备份表排除** — `dm_otd_sales_order_det_t_20240329`（public schema）、`dm_otd_sales_order_timespan_m_260416_wjh` 不可用

## 后续扩展

- WBS 计划订单履约（`dm_otd_wbs_plan_order_det_t`）
- SKU 管理分析（`dm_otd_sku_manage_analyse_m`）
- 库存周转（`dm_otd_wm_stock_turnover_m`）
- 销售预测履约（`dm_otd_sales_forecast_stat_t`）
- 卫浴 OTD 专项（`dm_otd_sales_order_det_sw*`）
