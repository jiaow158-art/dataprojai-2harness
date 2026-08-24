# 设计：去上市口径库存表，库存/SKU 效益域迁移到内部口径表

日期：2026-08-20
状态：已批准（用户选定方案 A + 阿米巴口径 + 保留 capital_cost_t）

## 1. 背景与根因

用户反馈：库存分析不应使用上市口径表 `dm.dm_fin_stock_d_accage_list_c_t_2023`，要求优化库存域和涉及的域（sku-profitability）。

该表在 4 处活跃 skill 文件 + eval_dataset.json 4 个场景中被引用：

| 域 | 文件 | 引用点 |
|---|---|---|
| inventory | `skills/inventory-knowledge/SKILL.md` | 路由描述（31/33 行）、表清单（62 行） |
| inventory | `references/metrics.md` | 决策树（108-109 行）、第八节跌价（288-294 行）、日期表（203 行） |
| inventory | `references/stock-fall-list.md` | **整文件**（标题即该表名） |
| inventory | `references/chdj-capital-cost.md` | 8/27/35-37/61 行对比表述 |
| inventory | `references/capital-cost-table.md` | 6/41-45/65/72 行（含错误源表表述） |
| sku-profitability | `analyst/SKILL.md` | 表清单（34 行）、日期表（89 行）、审查清单（108/114 行）、模式 D/E/H/I 的 4 段 SQL、清仓注（342 行） |
| sku-profitability | `knowledge/references/metrics.md` | 10/11/15/17/27/46/47/50/68/69/70 行 |
| sku-profitability | `knowledge/references/data-lineage.md` | 9 行表、18/22/23 行 |
| sku-profitability | `knowledge/references/inventory-side-patterns.md` | 7/14/22 行 |
| eval | `eval_dataset.json` | 4 个 sku-profitability 场景期望 SQL |

`docs/superpowers/plans|specs/2026-08-18-*` 为历史设计归档，**不修改**。

## 2. 替代表与数据验证（2026-08-20 实测）

内部口径表 `dm.dm_fin_stock_detail_accage_t_2023`（183 列，628 万行/月，已更新到 202608）：

| 月份 | 行数 | zsjkcje（管理） | jchj_amt（管理减值） |
|---|---|---|---|
| 202607 | 622.9 万 | 14.71 亿 | 2.877 亿 |
| 202608 | 628.3 万 | 14.97 亿 | 2.865 亿 |

- 管理口径 `jchj_amt` = `wbzq_6_fall_amt + wbzq_6_12_fall_amt + wbzq_12_24_fall_amt + wbzq_24_fall_amt + ybzq_bzdq_3_fall_amt + ybzq_bzdq_fall_amt`（2.877 亿 完全吻合 ✓）
- 阿米巴口径 `jchj_aging` = 对应 `*_fall_aging` 分段之和（3.301 亿 完全吻合 ✓），`stock_amt`（阿米巴结算价）17.52 亿
- 有保质期产品（bz_flag='Y'）仅 0.6%（3.6 万行），瓷砖行业以无保质期为主——跌价/库龄查询以无保质期分段为主，有保质期字段保留说明
- 两套计提政策差异：上市 0/20/30/50/50%（年段）vs 内部 0/10/40/70%（6月段）+ 有保质期 70/100%——**跌价数字不可跨口径对比**，文档必须写明

## 3. 字段映射（用户已确认）

### 3.1 inventory 域（管理口径）

| 概念 | 旧（上市表） | 新（内部表） |
|---|---|---|
| 库存金额 | `zsjkcje` | `zsjkcje`（同名同源） |
| 跌价合计 | `aging_sum_fall_amt` | `jchj_amt`（减值合计-管理，可直接 SUM） |
| 跌价分段 | `aging_1y/1_2y/2_3y/3_4y/4y_fall_amt`（0/20/30/50/50%） | `wbzq_6_fall_amt`(0%)、`wbzq_6_12_fall_amt`(10%)、`wbzq_12_24_fall_amt`(40%)、`wbzq_24_fall_amt`(70%)；有保质期 `ybzq_bzdq_3_fall_amt`(70%)、`ybzq_bzdq_fall_amt`(100%) |
| 库龄分段 | `aging_0_30_amt` 天级细分 | `wbzq_6_amt`/`wbzq_6_12_amt`/`wbzq_12_24_amt`/`wbzq_24_amt`（+`ybzq_bzdq_3_amt`/`ybzq_bzdq_amt` 保质期） |
| 是否清仓 | `zisqc` | `zisqc`（内部表同名）+ `clear_inv_flag`/`clearance_reason`/`promote_reason` |
| 时间字段 | `calmonth` YYYYMM | `calmonth` YYYYMM（同格式） |

### 3.2 sku-profitability 域（阿米巴口径，与 Mix 对齐）

| 概念 | 旧（上市表） | 新（内部表） |
|---|---|---|
| 库存金额 | `zsjkcje` | `stock_amt`（库存金额-阿米巴结算价） |
| 跌价合计 | `aging_sum_fall_amt` | `jchj_aging`（减值合计-阿米巴结算价，可直接 SUM） |
| 跌价分段 | `aging_*_year_fall_amt` | `wbzq_6_fall_aging`(0%)、`wbzq_6_12_fall_aging`(10%)、`wbzq_12_24_fall_aging`(40%)、`wbzq_24_fall_aging`(70%)；有保质期 `ybzq_bzdq_3_fall_aging`(70%)、`ybzq_bzdq_fall_aging`(100%) |
| 库龄分段 | `aging_*_amt` | `wbzq_6_aging`/`wbzq_6_12_aging`/`wbzq_12_24_aging`/`wbzq_24_aging` + `ybzq_*_aging` |
| 是否清仓 | `zisqc` | `zisqc` |
| 时间字段 | `calmonth` YYYYMM | `calmonth` YYYYMM |

## 4. 方案（用户选定 A：全量替换）

1. **inventory 域 6 文件**：SKILL.md 路由/表清单；metrics.md 决策树+第八节+日期表；**stock-fall-list.md 整文件重写**为内部口径跌价文档（保留文档结构：快速参考/计提比例表/库龄分段/陷阱/查询模式/血缘/关联文档）；stock-accage.md 修正过时字段语义（`bz_flag`=保质期标识非包装标志、`jchj_amt`=减值合计、fall_amt 族、clear_inv_flag、时间范围 202012~202608）；chdj-capital-cost.md、capital-cost-table.md 对比表述更新（capital_cost_t 表**保留**，修正第 65 行"源表（上市口径库存明细）"→"财务口径库存明细（内部口径）"——其源表本就是内部表）。
2. **sku-profitability 域 4 文件**：analyst SKILL.md（表清单、日期表、对抗性审查清单改为"内部口径表"、模式 D/E/H/I 的 4 段 SQL 全换阿米巴字段、清仓注）；knowledge metrics.md、data-lineage.md、inventory-side-patterns.md 同步换口径。
3. **eval_dataset.json**：4 个场景（可售天数 50、健康度分布、跌价 TOP10、综合评分 TOP20）期望 SQL 重写为内部表阿米巴口径。
4. **验证**：每个重写 SQL 模板用 MCP 真实执行（202607）；eval SQL 替换后跑 `run_eval.py sku-profitability`；全仓 grep 零残留（docs 历史除外）。

## 5. 不做的

- 不改 `docs/superpowers/` 历史设计文档（归档）。
- 不弃用 `dm_fin_stock_capital_cost_t`（资金成本专用表，无内部替代；仅修正文档表述）。
- 不引入新表/新字段假设；`dm_fin_stock_detail_accage_t`（无 2023 后缀旧表）继续禁用。

## 6. 风险

- 跌价数字跨口径翻倍（1.43亿 → 2.877/3.301亿）会改变既有结论——文档和 eval 期望都按新口径重写，回答中口径说明必须声明计提政策。
- 内部表 183 列多口径并存（标准/阿米巴/协议单价/自然日历）——查询必须显式选字段族，不混用。
- eval 期望 SQL 变更后需回归确认 run_eval 通过。
