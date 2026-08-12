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
| [dm-so-org-perf-stat.md](references/dm-so-org-perf-stat.md) | **轻量汇总表**（业绩宽表上游）。阿米巴业绩+利润合并、毛利计算、费用明细 |
| [ct-dept-sales-performance.md](references/ct-dept-sales-performance.md) | **瓷砖部门业绩日报**（58列）。6级组织×4渠道, 含715/超大板/918/高值产品分类, 6种排名 |
| [region-performance-daily.md](references/region-performance-daily.md) | **区域业绩日报**（25列）。部门日报简化版, 含季/年目标 |
| [sw-business-center-daily.md](references/sw-business-center-daily.md) | **卫浴商用中心双计业绩**（13列）。大区×业务类型(直营KA/工程经销商/运营中心) |
| [fact-finance-salesnetamt.md](references/fact-finance-salesnetamt.md) | **销售净额事实表**（5万行）。全事业部月度净额+期间费用, node_desc3粒度 |
| [channel-dimension.md](references/channel-dimension.md) | 渠道维度权威映射（`integrate_channel`/`integrate_channel2` → channel_name） |
| [data-lineage.md](references/data-lineage.md) | 数据血缘、表之间如何关联、从源表到报表的路径 |

### Upload 表参考文档

| 文档 | 对应问题类型 |
|---|---|
| [upload-sales-performance-target-pus.md](references/upload-sales-performance-target-pus.md) | 瓷砖部门/区域月度目标（48列, 三级/四级/五级达成率排名） |
| [upload-achievement-history.md](references/upload-achievement-history.md) | 客户→线组人工映射（覆盖默认线组分配, 影响五级排名） |
| [upload-ct-sales-performance-target-t.md](references/upload-ct-sales-performance-target-t.md) | 10种口径销售目标填报（KPI/1+N/高值/大包/特惠品/世界印象/辅材/旗舰/IW/整装新品） |

### 维度表参考文档

| 文档 | 对应问题类型 |
|---|---|
| [dim-zmaster-cus.md](references/dim-zmaster-cus.md) | 客户主数据SAP源表（107列, 母客编映射/渠道重映射, 业绩宽表专用） |
| [dim-sale-grp-reset.md](references/dim-sale-grp-reset.md) | 销售组历史重置（组织架构变更后回刷, 仅瓷砖） |
| [dwr-gl-sales-group-v.md](references/dwr-gl-sales-group-v.md) | 销售组层级视图（部门/区域日报专用5级组织, 替代sales_group_t） |

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
