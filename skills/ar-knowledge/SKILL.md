---
name: ar-knowledge
description: 应收领域数据知识库。当用户询问应收账龄、逾期应收、回款、应收账款余额、坏账减值、应收周转、商业票据、客户信用等应收相关问题时自动激活。覆盖 dm 和 dwrfin 层的应收数据模型。
---

# 应收领域 — 数据知识路由

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
| [receivable-aging.md](references/receivable-aging.md) | 应收账龄分析、逾期账龄分段、按客户/公司/WBS 的应收余额和逾期 |
| [receivable-balance.md](references/receivable-balance.md) | 应收余额、本币余额、多币种余额、期末余额 |
| [overdue-collection.md](references/overdue-collection.md) | 逾期应收监控、回款明细、客户逾期排名 |
| [credit-devalue.md](references/credit-devalue.md) | 坏账减值计提、信用减值分析、风险分类 |
| [ar-analysis-rpt.md](references/ar-analysis-rpt.md) | 综合分析报表、合同→回款全链路、自然账龄 |
| [bill-capital-cost.md](references/bill-capital-cost.md) | 商业票据、资金成本 |
| [data-lineage.md](references/data-lineage.md) | 数据血缘、表之间如何关联、从源表到报表的路径 |

## 跨域共享参考

组织架构等跨领域主数据，存放在 Sources of Truth 层，所有 domain skill 共用：

| 文档 | 说明 |
|---|---|
| **[组织架构](../../sources-of-truth/business-context/org-hierarchy.md)** | 10级销售组织树（node1~node10），node2 事业部枚举值，与应收表的关联方式 |

## 使用方式

1. **首先**加载 [metrics.md](references/metrics.md) 语义层，理解概念映射和表选择决策树
2. 根据决策树确定使用哪张表
3. 使用 `Read` 工具加载对应的表级参考文档
4. 根据文档中的表结构、过滤条件、陷阱提示，给出查询方案或直接生成 SQL

## 标准全局过滤条件

SAP 源系统过滤（MANDT, KOKRS, SPRAS）已在 ETL 阶段处理，DWS 查询无需添加。

DWS 层实际需要的过滤：

- 时间字段格式（**不一致！**）：
  - `dm.dm_ar_receivable_accage_t`：`edition_date` (YYYYMMDD)
  - `dwrfin.dwr_ar_receivable_aging_2023_info_f`：`query_date` (YYYY-MM-DD)
  - `dwrfin.dwr_ar_receivable_balance_f`：`year` + `month` (两列)
  - `dwrfin.dwr_ar_collection_detail_f`：`year` + `month` + `posting_date` (timestamp)
  - `dm.dm_ar_overdue_receivables_t`：`ed_mon` (YYYYMM)
  - `dm.dm_ar_analysis_rpt_f`：`calmonth` (YYYY-MM)
- 大表（>1000万行）必须带时间范围过滤，避免全表扫描
- 备份表/临时表（`_wjh_`、`_bak`、`_tmp`、`_01` 后缀）绝对不能使用
- 变体表识别：同一表名的 `_close` 后缀是已清账版本
