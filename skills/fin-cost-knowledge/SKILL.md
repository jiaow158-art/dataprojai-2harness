---
name: fin-cost-knowledge
description: 财务费用领域数据知识库。当用户询问费用明细、成本中心、科目、毛利、预算、费用报销、差旅费、合同台账等财务费用相关问题时自动激活。覆盖 DWRFIN 和 DM 层的费用数据模型。
---

# 财务费用领域 — 数据知识路由

## 作用

本 Skill 是路由层。根据用户问题类型，引导到对应的参考文档获取准确的表结构、字段含义、过滤条件和查询模式。

## 可用的参考文档

### 语义层（必须首先查阅）

| 文档 | 说明 |
|---|---|
| **[metrics.md](references/metrics.md)** | **🔴 强制优先阅读**。概念→字段映射、功能范围枚举值、表选择决策树、标准指标公式、所有已知陷阱 |

### 表级参考文档

| 文档 | 对应问题类型 |
|---|---|
| [cost-comprehensive-subject.md](references/cost-comprehensive-subject.md) | 费用明细查询、综合科目分析、成本中心费用汇总、TMS运费 |
| [cost-center-master.md](references/cost-center-master.md) | 成本中心主数据、成本中心与销售组映射、利润中心 |
| [cost-elements.md](references/cost-elements.md) | 科目参考（成本要素主数据表未在DWS物化，仅提供科目编码规则和特殊科目清单） |
| [gross-profit.md](references/gross-profit.md) | 销售毛利、预算vs实际、毛利率、不含税净额 |
| [finance-cost-fact.md](references/finance-cost-fact.md) | 预测与预算、功能范围、费用项目、价值链分类 |
| [expense-reimbursement.md](references/expense-reimbursement.md) | 费用报销、费用申请、差旅报销 |
| [contract-ledger.md](references/contract-ledger.md) | 合同台账、订单合同、结算合同 |
| [data-lineage.md](references/data-lineage.md) | 数据血缘、表之间如何关联、从源表到报表的路径 |

## 跨域共享参考

组织架构等跨领域主数据，存放在 Sources of Truth 层，所有 domain skill 共用：

| 文档 | 说明 |
|---|---|
| **[组织架构](../../sources-of-truth/business-context/org-hierarchy.md)** | 10级销售组织树（node1~node10），node2 事业部枚举值，与费用表的关联方式 |

## 使用方式

1. **首先**加载 [metrics.md](references/metrics.md) 语义层，理解概念映射和表选择决策树
2. 根据决策树确定使用哪张表
3. 使用 `Read` 工具加载对应的表级参考文档
4. 根据文档中的表结构、过滤条件、陷阱提示，给出查询方案或直接生成 SQL

## 标准全局过滤条件

SAP 源系统过滤（MANDT, KOKRS, SPRAS）已在 ETL 阶段处理，DWS 查询无需添加。

DWS 层实际需要的过滤：

- 时间字段格式（**不一致！**）：
  - `dwr_fin_cost_d_compre_subj_t`：`year` (YYYY) + `month` (YYYY-MM)
  - `dm_fact_finance_cost_f`：`month` (YYYY-MM)
  - `dwrfin_cost_sales_gross_profit_d`：`months` (YYYYMM，无横杠)
- 大表必须带时间范围过滤，避免全表扫描
- 备份表/临时表（`_wjh_`、`_bak`、`_tmp`、`_01` 后缀）绝对不能使用
- 查询未来月份的预测数据时需标注，避免被误读为实际
