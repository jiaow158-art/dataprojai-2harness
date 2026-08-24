---
name: sku-profitability-knowledge
description: SKU效益分析领域数据知识库。当用户询问单个SKU/物料的销售规模、帕累托、毛利贡献、库存周转、滞销、缺货、动销、跌价、新品蚕食、清仓处置建议等单品效益问题时自动激活。跨销售×库存×成本的分析专题域。
---

# SKU 效益分析领域 — 数据知识路由

## 作用

本 Skill 是路由层。SKU 效益问题是**跨表专题**：一张 SQL 通常横跨 Mix 表（销售/毛利）+ 出入库月表（动销）+ 内部口径库存表（库存/跌价，阿米巴字段族） + 物料主数据（新品标识）。根据问题类型路由到对应参考文档。

## 可用的参考文档

### 语义层（必须首先查阅）

| 文档 | 说明 |
|---|---|
| **[metrics.md](references/metrics.md)** | **🔴 强制优先阅读**。九问决策树、效益利润口径、综合评分公式、全部口径陷阱 |

### 问题族参考

| 文档 | 覆盖问题 |
|---|---|
| [sales-side-patterns.md](references/sales-side-patterns.md) | 销售规模/帕累托、趋势、毛利贡献、渠道×SKU（业务问题 1/2/3/7） |
| [inventory-side-patterns.md](references/inventory-side-patterns.md) | 库存周转、滞销/缺货/动销、库存跌价（业务问题 4/5/9） |
| [newproduct-decision-patterns.md](references/newproduct-decision-patterns.md) | 新品增量/蚕食、综合评分/处置建议（业务问题 6/8） |
| [data-lineage.md](references/data-lineage.md) | 本域五张核心表的血缘与关联方式 |

### 借用表级文档（在相邻域，不复制）

| 表 | 文档位置 |
|---|---|
| Mix 主表 `dm_fin_operations_mix_sum_t` | `../../sales-performance-knowledge/references/operations-mix-sum.md` |
| 出入库月表 `dm_product_inout_stock_t` | `../../inventory-knowledge/references/inout-stock.md` |
| 内部口径跌价表（阿米巴字段族） | `../../inventory-knowledge/references/stock-fall-list.md` |
| 资金成本（正值口径/阿米巴） | `../../inventory-knowledge/references/capital-cost-table.md`、`chdj-capital-cost.md` |
| 未交付订单（缺货补充口径） | `../../otd-fulfillment-knowledge/references/no-deliver-order-dtl.md` |

## 跨域共享参考

| 文档 | 说明 |
|---|---|
| **[物料主数据](../../sources-of-truth/business-context/material-master.md)** | 品类/产品层次/上市日期/新品编码 — **本域 SKU 维度的权威来源** |
| [组织架构](../../sources-of-truth/business-context/org-hierarchy.md) | node_desc* 过滤 |
| [客户主数据](../../sources-of-truth/business-context/customer-master.md) | 客户维度下钻 |

## 使用方式

1. **首先**加载 [metrics.md](references/metrics.md)，用九问决策树定位问题类型与表组合
2. 加载对应问题族文档，确认口径与对齐规则
3. 可执行 SQL 模式见 `../sku-profitability-analyst/SKILL.md` 模式 A-I
