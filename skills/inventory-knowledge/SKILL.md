---
name: inventory-knowledge
description: 库存仓储领域数据知识库。当用户询问库存账龄、在途库存、仓库库存、出入库、库龄分析、库存周转、安全库存、仓协销(CXC)、低周转/残次品等库存相关问题时自动激活。覆盖 dm 层的库存数据模型。
---

# 库存仓储领域 — 数据知识路由

## 作用

本 Skill 是路由层。根据用户问题类型，引导到对应的参考文档获取准确的表结构、字段含义、过滤条件和查询模式。

## 可用的参考文档

### 语义层（必须首先查阅）

| 文档 | 说明 |
|---|---|
| **[metrics.md](references/metrics.md)** | **🔴 强制优先阅读**。概念→字段映射、表选择决策树、日期格式总览、标准指标公式、所有已知陷阱 |

### 表级参考文档

| 文档 | 对应问题类型 |
|---|---|
| [stock-accage.md](references/stock-accage.md) | 库存账龄分析、库龄分段、按工厂/物料/科目的库存余额和金额 |
| [transit-inventory.md](references/transit-inventory.md) | 在途库存、采购在途、交货在途 |
| [warehouse-stock.md](references/warehouse-stock.md) | 仓库库存查询、全类型库存（可用/冻结/质检）、按工厂/渠道/品牌的库存现状 |
| [stock-stat-month.md](references/stock-stat-month.md) | 库存统计月报、按库龄分段的库存统计 |
| [cxc-daily.md](references/cxc-daily.md) | 仓协销日报(CXC)、期初期末库存、出入库面积、销售出库 |
| [inout-stock.md](references/inout-stock.md) | 产品出入库明细、入库量/面积、出库量/面积、期末库存 |
| [safestock-lowturnover.md](references/safestock-lowturnover.md) | 安全库存、低周转库存、残次品库存、缺货超期、库存周转率 |
| [stock-fall-list.md](references/stock-fall-list.md) | **存货跌价（上市口径）**。计提比例、库龄分段、天级细分、跌价 TOP |
| [chdj-capital-cost.md](references/chdj-capital-cost.md) | **阿米巴存货价值/资金成本**。stat_month=YYYY-MM |
| [capital-cost-table.md](references/capital-cost-table.md) | **库存资金成本（上市口径，批次级，month=YYYYMM，正值）** |
| [data-lineage.md](references/data-lineage.md) | 数据血缘、表之间如何关联、从源表到报表的路径 |

## 跨域共享参考

组织架构等跨领域主数据，存放在 Sources of Truth 层，所有 domain skill 共用：

| 文档 | 说明 |
|---|---|
| **[组织架构](../../sources-of-truth/business-context/org-hierarchy.md)** | 10级销售组织树（node1~node10），node2 事业部枚举值，与库存表的关联方式 |

## 使用方式

1. **首先**加载 [metrics.md](references/metrics.md) 语义层，理解概念映射和表选择决策树
2. 根据决策树确定使用哪张表
3. 使用 `Read` 工具加载对应的表级参考文档
4. 根据文档中的表结构、过滤条件、陷阱提示，给出查询方案或直接生成 SQL

## 标准全局过滤条件

SAP 源系统过滤（MANDT, KOKRS, SPRAS）已在 ETL 阶段处理，DWS 查询无需添加。

DWS 层实际需要的过滤：

- 时间字段格式（**不一致！**）：
  - `dm_fin_stock_detail_accage_t_2023`：`calmonth` (YYYYMM)
  - `dm_b1_transit_inventory_t`：`doc_month` (YYYY-MM)
  - `dm_rpt_wm_cxc_day_sum`：`stat_date` (YYYYMMDD)
  - `dm_product_inout_stock_t`：`start_month` (YYYY-MM)
  - `dm_fin_stock_d_accage_list_c_t_2023`：`calmonth` (YYYYMM)
  - `dm_fin_stock_capital_cost_t`：`month` (YYYYMM)
  - `dm_ambv2_chdj_grp_t`：`stat_month` (YYYY-MM)
  - 低周转/残次品表：`voucher_post_date` (timestamp)
- 大表（>1000万行）必须带时间范围过滤，避免全表扫描
- 在途库存必须排除预测月份：`doc_month <= '当前月'`
- 备份表/临时表（`_tmp`、`_0630`、`_bak` 后缀）绝对不能使用
