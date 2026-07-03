---
name: sales-performance-knowledge
description: 销售业绩领域数据知识库。当用户询问销售达成率、目标完成、同比增长、销售收入、销售面积等业绩相关问题时自动激活。覆盖 DM 层的销售业绩数据模型。
---

# 销售业绩领域 — 数据知识路由

## 作用

本 Skill 是路由层。根据用户问题类型，引导到对应的参考文档获取准确的表结构、字段含义、过滤条件和查询模式。

## 可用的参考文档

### 语义层（必须首先查阅）

| 文档 | 说明 |
|---|---|
| **[metrics.md](references/metrics.md)** | **🔴 强制优先阅读**。概念→字段映射、表选择决策树、标准指标公式、所有已知陷阱 |

### 表级参考文档

| 文档 | 对应问题类型 |
|---|---|
| [operations-mix-sum.md](references/operations-mix-sum.md) | **主事实表**（默认首选）。月度达成、渠道/品牌/客户/区域下钻、预算vs实际、不含税净额、销售面积。内置 node_desc 无需 JOIN 组织表 |
| [sales-performance.md](references/sales-performance.md) | 同比增长（唯一有 `last_year_*` 字段）、产品分类达成（高值/大规格/套餐等预计算列） |
| [sales-target.md](references/sales-target.md) | 目标销售额、目标完成进度、目标vs实际偏差 |
| [channel-dimension.md](references/channel-dimension.md) | 渠道维度权威映射（`integrate_channel`/`integrate_channel2` → channel_name） |
| [data-lineage.md](references/data-lineage.md) | 数据血缘、表之间如何关联、从源表到报表的路径 |

## 跨域共享参考

组织架构等跨领域主数据，存放在 Sources of Truth 层，所有 domain skill 共用：

| 文档 | 说明 |
|---|---|
| **[组织架构](../../sources-of-truth/business-context/org-hierarchy.md)** | 10级销售组织树（node1~node10），node2 事业部枚举值。`org_code` 通过 `node_name10` 关联组织表（非 `node10`，后者是序号） |
| **[客户主数据](../../sources-of-truth/business-context/customer-master.md)** | 客户名称/分组/销售区域/销售组。业绩表查客户名用 `dm_dp_api_cust_general`，分组下钻用 `dwr_dim_cust_sales_area_d` |
| **[物料主数据](../../sources-of-truth/business-context/material-master.md)** | 物料维度（品牌/品类/产品层级），与业绩表按物料关联 |
| **[公司&工厂](../../sources-of-truth/business-context/company-plant.md)** | 公司/工厂主数据 |

## 使用方式

1. **首先**加载 [metrics.md](references/metrics.md) 语义层，理解概念映射和表选择决策树
2. 根据决策树确定使用哪张表
3. 使用 `Read` 工具加载对应的表级参考文档
4. 根据文档中的表结构、过滤条件、陷阱提示，给出查询方案或直接生成 SQL

## 标准全局过滤条件

- 时间字段格式：
  - `dm_fin_operations_mix_sum_t`：`calmonth` (YYYY-MM)，直接用月格式；`calday` (YYYYMMDD) 有31个日值
  - `ct_sales_performance_t`：`calday` (YYYYMMDD 字符串)，月查询取月末快照，不可 BETWEEN 多天后直接 SUM
  - `dm_dp_api_sales_target`：`stat_year` (YYYY) + `stat_month` (YYYY-MM)
- Mix 表 `dm_fin_operations_mix_sum_t` **内置 `node_desc1~9`**，直接 WHERE 过滤，无需 JOIN 组织表
- `ct_sales_performance_t` 组织筛选必须 JOIN `dm_rpt_sales_group_t`，关联键 `org_code = node_name10`（不是 `node10`）
- Mix 表 `data_source` 按组织层级选择：集团/node_desc2 → `IN ('S','T','D','')`，其他层级 → `IN ('','S','T','D','U')`，未指定组织时询问用户
- 大表必须带时间范围过滤（Mix 表 903万行，业绩表 892万行）
- 备份表/临时表（`_bak`、`_tmp`、`_wjh_` 后缀）绝对不能使用
