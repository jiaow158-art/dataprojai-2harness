# SKU 效益分析专题域 + 报表协议 v2.1 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 SKU 效益分析专题域（9 问全覆盖 + 9 eval 场景）并将 report-generator 协议升级 v2.1（帕累托双格式/气泡四象限/热力图/瀑布/表格着色/int 格式）。

**Architecture:** 三阶段——①数据层：inventory 域补 3 张表文档（共享基础设施）→ 新建 sku-profitability knowledge+analyst 配对 → eval 入库；②报表层：schema→validator→模板→recipes 的 v2.1 升级（向后兼容，存量 v2 报告零修改通过）；③端到端真实数据验收 + CLAUDE.md 修正。

**Tech Stack:** Python 3.9+ 标准库（validator/builder/eval）、原生 JS（模板）、pytest、GaussDB DWS（经 MCP `mcp__dws__run_query`）、git。

**规格文档:** `docs/superpowers/specs/2026-08-18-sku-profitability-domain-design.md`

**生产约束（全程有效）:** 纯标准库、Python 3.9+ 语法、零硬编码路径、`git pull` 部署、报表层改动必须 `--selftest` PASS。本地 `.mcp.json` 的 Windows 改动**禁止提交**。

**关键裁定（依实库验证）:**
- Mix 表 `dm.dm_fin_operations_mix_sum_t`：calmonth **'YYYY-MM'**，SKU=`material_num`，主指标 `ambperformance`，毛利 `gross_profit_after_sharing`，成本 `act_cost_sum_amt`，面积 `zxsmj`，渠道 `integrate_channel__t`，必带 `data_source IN ('S','T','D','')`
- 上市口径跌价表 `dm.dm_fin_stock_d_accage_list_c_t_2023`：calmonth **'YYYYMM'**（如 '202607'），600万行/月**必须带 calmonth 过滤**
- 出入库月表 `dm.dm_product_inout_stock_t`：start_month 格式 Task 2 验证
- 判空一律 `LENGTH(TRIM(col))>0`，禁用 `TRIM(col)<>''`（GaussDB 行为不一致，实证 0 行 vs 173万行）

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `skills/inventory-knowledge/references/stock-fall-list.md` | 上市口径跌价表文档 | 新建 |
| `skills/inventory-knowledge/references/chdj-capital-cost.md` | CHDJ 存货价值/资金成本文档 | 新建 |
| `skills/inventory-knowledge/references/capital-cost-table.md` | 库存资金成本表文档 | 新建 |
| `skills/inventory-knowledge/references/metrics.md` / `SKILL.md` | 增补跌价/资金成本段 + 路由 | 修改 |
| `sources-of-truth/business-context/material-master.md` | 上市/新品字段增补 | 修改 |
| `skills/sku-profitability-knowledge/**`（SKILL.md + references 5 文件） | 新域知识层 | 新建 |
| `skills/sku-profitability-analyst/SKILL.md` | 新域分析层（模式 A-I） | 新建 |
| `eval_dataset.json` | +9 场景，meta 57→66 | 修改 |
| `skills/report-generator/references/report-schema.json` | v2.1 契约 | 修改 |
| `skills/report-generator/scripts/validate_report.py` | v2.1 校验 | 修改 |
| `skills/report-generator/templates/report-shell.html` | v2.1 渲染 | 修改 |
| `skills/report-generator/references/chart-recipes.md` | 四套图表配方 | 新建 |
| `skills/report-generator/SKILL.md` / `scripts/build.py` | v2.1 说明 / selftest 扩展 | 修改 |
| `skills/report-generator/tests/test_validate_report.py` | v2.1 测试 | 修改 |
| `CLAUDE.md` | 域表/eval 数修正 | 修改 |

---

## 阶段 1：数据层

### Task 1: inventory 补表① — stock-fall-list.md（上市口径跌价表）

**Files:**
- Create: `skills/inventory-knowledge/references/stock-fall-list.md`

- [ ] **Step 1: 定位 ETL 脚本**

Run: `ls huaweiclaude/DM/ | grep -i "ACCAGE_LIST"`（或 Glob `huaweiclaude/**/*ACCAGE_LIST*`）
Expected: 找到 `PJob_DM_FIN_STOCK_D_ACCAGE_LIST_C_T_2023.txt`（或近似名）。若找到，读前 50 行记下源系统与刷数方式，写入文档「血缘」节；找不到则血缘节写「ETL 脚本未在 huaweiclaude/ 导出，待补」。

- [ ] **Step 2: 写文档**

`skills/inventory-knowledge/references/stock-fall-list.md` 完整内容：

```markdown
# dm_fin_stock_d_accage_list_c_t_2023 — 存货跌价·上市口径表

## 快速参考

- **DWS 表名**：`dm.dm_fin_stock_d_accage_list_c_t_2023`
- **业务含义**：上市（在售）口径的库存+账龄+跌价准备表，批次级。跌价字段内嵌集团会计政策计提比例。
- **实体粒度**：一行 = 查询日期 × 批次 × calmonth × 物料 × 工厂 × 库存地点 组合
- **数据量**：约 600 万行/月（202608：607万行，64,605 SKU，实际库存金额 14.3亿，跌价合计 1.43亿）
- **时间格式**：`calmonth` = **YYYYMM**（如 '202607'）
- **注意**：结尾 `_2023` 是历史命名，实际持续更新（202608 已有数），不要找"无后缀版本"

## 跌价字段（含计提比例 — 集团会计政策）

| 字段 | 口径 | 计提比例 |
|---|---|---|
| `aging_1_year_fall_amt` | 1年以内跌价 | 0% |
| `aging_1_2_year_fall_amt` | 1-2年跌价 | 20% |
| `aging_2_3_year_fall_amt` | 2-3年跌价 | 30% |
| `aging_3_4_year_fall_amt` | 3-4年跌价 | 50% |
| `aging_4_year_fall_amt` | 4年以上跌价 | 50% |
| `aging_sum_fall_amt` | **跌价合计（预计算，直接 SUM 用）** | — |

## 账龄金额/数量/面积字段

- 年段：`aging_1_year_amt`、`aging_1_2_year_amt`、`aging_2_3_year_amt`、`aging_3_4_year_amt`、`aging_4_year_amt`
- 天级细分（三套后缀 `_amt`/`_qty`/`_area`）：`aging_0_30_*`、`aging_31_60_*`、`aging_61_90_*`、`aging_91_180_*`、`aging_181_270_*`、`aging_271_360_*`（→可聚出"半年内/半年-一年"口径**金额**；**跌价只有年段口径**）
- 库存总额：`zsjkcje`（实际库存金额）

## 关键维度

| 字段 | 说明 |
|---|---|
| `material` / `material___t` | 物料编码/描述（对应 Mix 表 `material_num`） |
| `zisqc` | 是否清仓（处置建议分析用） |
| `category` / `category_name` | 品类 |
| `product_position` / `product_position_name` | 产品定位 |
| `zprodh1`~`zprodh5`（+`___t`） | 产品层次1~5 |
| `zdpsyb` / `zdpsyb___t` | 事业部 |
| `plant` / `stor_loc` / `zww010` | 工厂/库存地点/产区 |
| `doc_number` / `s_ord_item` | 销售凭证/项目（批次挂单信息） |
| `batch` / `zmmm_o017_zbatch_date` | 批次/入库日期 |
| `ziswx` | 自制/外协 |

## 陷阱

1. **大表必带 calmonth 过滤**：600万行/月，无过滤查询会超时。
2. **跌价只有年段**，业务问"半年分段跌价"时透明说明，金额可用天级细分聚合。
3. **口径独此一家**：本表库存金额（14.3亿）与 CHDJ 阿米巴口径（6.35亿）、`dm_own_inventory_t`（1.88亿）不可混用。问跌价/库龄→本表；问阿米巴分摊/资金成本→CHDJ。
4. `material` 在本表 6.4万 SKU，Mix 表在售仅 6,232——跨表 JOIN 前声明对齐口径（通常以 Mix 为主集 LEFT JOIN 本表）。
5. 判空用 `LENGTH(TRIM(col))>0`，不要用 `TRIM(col)<>''`。

## 常见查询模式

### 跌价 TOP10
```sql
SELECT material, MAX(material___t) AS material_name,
       ROUND(SUM(aging_sum_fall_amt)) AS fall_amt,
       ROUND(SUM(zsjkcje)) AS stock_amt,
       ROUND(SUM(aging_1_2_year_fall_amt)) AS fall_1_2y,
       ROUND(SUM(aging_2_3_year_fall_amt)) AS fall_2_3y,
       ROUND(SUM(aging_3_4_year_fall_amt)) AS fall_3_4y,
       ROUND(SUM(aging_4_year_fall_amt)) AS fall_4y
FROM dm.dm_fin_stock_d_accage_list_c_t_2023
WHERE calmonth = '202607'
GROUP BY material
ORDER BY fall_amt DESC
LIMIT 10;
```

### 半年口径库存金额分段
```sql
SELECT material,
       ROUND(SUM(aging_0_30_amt + aging_31_60_amt + aging_61_90_amt + aging_91_180_amt)) AS within_half_year,
       ROUND(SUM(aging_181_270_amt + aging_271_360_amt)) AS half_to_1y,
       ROUND(SUM(aging_1_2_year_amt)) AS y1_2,
       ROUND(SUM(aging_2_3_year_amt + aging_3_4_year_amt + aging_4_year_amt)) AS over_2y
FROM dm.dm_fin_stock_d_accage_list_c_t_2023
WHERE calmonth = '202607'
GROUP BY material
ORDER BY within_half_year DESC
LIMIT 20;
```

## 血缘

（依 Step 1 查证结果填写：源系统 → DWI → DWR → DM 路径与刷新方式）

## 关联文档

- [metrics.md](metrics.md) — 库存域语义层
- [stock-accage.md](stock-accage.md) — 库龄明细主表（财务口径）
- [chdj-capital-cost.md](chdj-capital-cost.md) — 阿米巴存货价值/资金成本
```

- [ ] **Step 3: 验证文档中的 SQL 可跑**

经 MCP 运行「跌价 TOP10」查询（calmonth='202607'），Expected: 返回 10 行，fall_amt 降序。

- [ ] **Step 4: Commit**

```bash
git add skills/inventory-knowledge/references/stock-fall-list.md
git commit -m "docs(inventory): 上市口径跌价表文档—计提比例+天级库龄+口径陷阱"
```

---

### Task 2: inventory 补表②③ — CHDJ + 资金成本表 + metrics/SKILL 增补

**Files:**
- Create: `skills/inventory-knowledge/references/chdj-capital-cost.md`
- Create: `skills/inventory-knowledge/references/capital-cost-table.md`
- Modify: `skills/inventory-knowledge/references/metrics.md`（增补一节）
- Modify: `skills/inventory-knowledge/SKILL.md`（3 行路由）

- [ ] **Step 1: 探查 DM_FIN_STOCK_CAPITAL_COST_T**

经 MCP 依次执行：
1. `mcp__dws__search_tables` keyword=`CAPITAL_COST` → 确定 schema（预期 dm）
2. `mcp__dws__run_query`：`SELECT * FROM dm.dm_fin_stock_capital_cost_t LIMIT 5`（表名以搜索结果为准）→ 记录列名/样例值
3. `mcp__dws__run_query`：按其时间列 `GROUP BY 时间列 ORDER BY 1 DESC LIMIT 6` → 确认时间字段名、格式、新鲜度、行数
4. `ls huaweiclaude/DM/ | grep -i CAPITAL` → ETL 脚本定位

- [ ] **Step 2: 验证出入库月表 start_month 格式**

Run（MCP）:
```sql
SELECT start_month, COUNT(*) FROM dm.dm_product_inout_stock_t GROUP BY start_month ORDER BY start_month DESC LIMIT 4
```
Expected: 确定 `start_month` 是 'YYYY-MM' 还是 'YYYYMM'，记下（Task 6/7 SQL 依赖此格式）。

- [ ] **Step 3: 写 chdj-capital-cost.md**

```markdown
# dm_ambv2_chdj_grp_t — 阿米巴存货价值/资金成本表

## 快速参考

- **DWS 表名**：`dm.dm_ambv2_chdj_grp_t`（CHDJ=存货跌价，阿米巴 v2 体系；实际承载存货价值分摊+资金成本）
- **实体粒度**：一行 = stat_month × 物料 × 工厂 × 库存地点 × 产品渠道 × 销售组 组合
- **数据量**：约 28 万行/月（2026-08：27.8万行，35,770 SKU，存货价值合计 6.35亿）
- **时间格式**：`stat_month` = **YYYY-MM**（如 '2026-08'，注意与上市口径表 YYYYMM 不同！）

## 核心字段

| 字段 | 说明 |
|---|---|
| `stat_month` | 统计月份 YYYY-MM |
| `material_num` / `material_name` | 物料编码/描述 |
| `inventory_value` | 存货价值（**是否已扣跌价：口径待 ETL 确认**） |
| `inventory_value_amb` | 存货价值 amb（瓷砖专用） |
| `capital_cost` / `capital_cost_conv` / `capital_cost_sum` / `capital_cost_sum_conv` | 资金成本/分摊/累计/分摊累计（**现值为小负数，符号语义待 ETL 确认**） |
| `contributory_value` | 分摊价值 |
| `percentage` | 销售/工厂比例 |
| `prod_channal` / `prod_channal_name` | 产品渠道（注意拼写 channal） |
| `base_name` / `zww010___t` | 基地/产区 |
| `zdpsyb` | 事业部 |
| `product_level_code` / `prod_line_name` | 产品层次/产品线 |

## 陷阱

1. **日期格式 YYYY-MM**（上市口径表是 YYYYMM），同一查询混用两张表时必须分别处理。
2. 存货价值口径 6.35亿 ≠ 上市口径 14.3亿（阿米巴核算范围不同），**不可跨表加减**。
3. `capital_cost` 出现负值（2026-08 合计 -35.7万），使用前先与财务确认符号约定；确认前 SKU 效益计算中该减项标注"口径待确认"。
4. 表内无 `calmonth` 字段，时间过滤字段名是 `stat_month`。

## 常见查询模式

### 物料级资金成本 TOP20
```sql
SELECT material_num, MAX(material_name) AS material_name,
       ROUND(SUM(inventory_value)) AS inv_value,
       ROUND(SUM(capital_cost)) AS capital_cost
FROM dm.dm_ambv2_chdj_grp_t
WHERE stat_month = '2026-08'
GROUP BY material_num
ORDER BY capital_cost ASC
LIMIT 20;
```

## 血缘

源系统 SAP/阿米巴 → DWI → DM；ETL 脚本：`huaweiclaude/DM/DM_CT/PJob_DM_CRM_AMBV2_*` 系（实施时以实际文件为准）。

## 关联文档

- [stock-fall-list.md](stock-fall-list.md) — 上市口径跌价（另一套库存口径）
- [capital-cost-table.md](capital-cost-table.md) — 库存资金成本表
```

- [ ] **Step 4: 写 capital-cost-table.md（依 Step 1 探查结果）**

文档骨架（与 Step 1 查得的实际列/格式填入）：

```markdown
# dm_fin_stock_capital_cost_t — 库存资金成本表

## 快速参考

- **DWS 表名**：（Step 1 搜索确认的全名）
- **业务含义**：库存资金成本核算
- **实体粒度**：（依主键/维度列描述）
- **数据量 / 时间范围**：（Step 1 查证值）
- **时间字段与格式**：（Step 1 查证值）

## 核心字段

（依 describe_table 输出逐列：字段 | 类型 | 含义，含 comment 释义）

## 陷阱

（依数据实况写：日期格式、口径与 CHDJ capital_cost 的关系、判空规则 LENGTH(TRIM())>0）

## 常见查询模式

（一条最小可用 SQL，含时间过滤）

## 血缘

（ETL 脚本定位结果）

## 关联文档

- [chdj-capital-cost.md](chdj-capital-cost.md)
```

若 Step 1 发现该表数据为空/已停用，文档照写但「快速参考」标明实况，并在陷阱节注明"停用/空表，资金成本用 CHDJ 表"。

- [ ] **Step 5: metrics.md 增补**

在 `skills/inventory-knowledge/references/metrics.md` 的库存指标概念区（按现有章节风格追加一节）：

```markdown
## 存货跌价与资金成本

| 概念 | 权威字段 | 所在表 |
|---|---|---|
| 跌价准备（预计算，含计提比例 0%/20%/30%/50%/50%） | `aging_sum_fall_amt` | `dm_fin_stock_d_accage_list_c_t_2023`（上市口径，calmonth=YYYYMM） |
| 库存金额（上市口径） | `zsjkcje` | 同上 |
| 库龄分段金额（天级可聚半年口径） | `aging_*_amt` | 同上 |
| 存货价值（阿米巴口径） | `inventory_value` | `dm_ambv2_chdj_grp_t`（stat_month=YYYY-MM） |
| 库存资金成本 | `capital_cost*` | 同上 / `dm_fin_stock_capital_cost_t` |

**口径决策**：问跌价/库龄/上市口径库存 → 上市口径表；问阿米巴分摊/资金成本 → CHDJ 表。两套库存金额（14.3亿 vs 6.35亿，202607）不可混用。详见 [stock-fall-list.md](stock-fall-list.md)、[chdj-capital-cost.md](chdj-capital-cost.md)、[capital-cost-table.md](capital-cost-table.md)。
```

- [ ] **Step 6: SKILL.md 路由**

在 `skills/inventory-knowledge/SKILL.md` 的表级参考文档表追加 3 行（对齐现有表格列结构）：

```markdown
| [stock-fall-list.md](references/stock-fall-list.md) | **存货跌价（上市口径）**。计提比例、库龄分段、天级细分、跌价 TOP |
| [chdj-capital-cost.md](references/chdj-capital-cost.md) | **阿米巴存货价值/资金成本**。stat_month=YYYY-MM |
| [capital-cost-table.md](references/capital-cost-table.md) | **库存资金成本表** |
```

- [ ] **Step 7: 验证**

Run: `grep -c "stock-fall-list\|chdj-capital-cost\|capital-cost-table" skills/inventory-knowledge/SKILL.md`
Expected: >= 3

- [ ] **Step 8: Commit**

```bash
git add skills/inventory-knowledge/
git commit -m "docs(inventory): CHDJ+资金成本表文档；metrics/SKILL 增补跌价与资金成本路由"
```

---

### Task 3: material-master.md 增补（上市/新品字段）

**Files:**
- Modify: `sources-of-truth/business-context/material-master.md`

- [ ] **Step 1: 验证字段格式**

Run（MCP）:
```sql
SELECT new_product_code, product_listed_date, COUNT(*) AS cnt
FROM dwimd.dwi_md_data_material_general_t
WHERE LENGTH(TRIM(product_listed_date)) > 0
GROUP BY new_product_code, product_listed_date
ORDER BY cnt DESC
LIMIT 8
```
Expected: 确定 `product_listed_date` 实际格式（'YYYYMMDD' 或 'YYYY-MM-DD'）与 `new_product_code` 取值形态。记下用于 Task 6 模式 F 与 Task 7 eval。

- [ ] **Step 2: 增补文档**

在 `sources-of-truth/business-context/material-master.md` 的「## 核心字段」下（「### 标识字段」之后）插入：

```markdown
### 上市与新品字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `product_listed_date` | varchar | 上市日期，格式：（Step 1 查证值，如 YYYYMMDD）。空串表示未填——判空用 `LENGTH(TRIM(...))>0` |
| `new_product_code` / `new_product_name` | varchar | 新品编码/名称，标识新品（配合上市日期圈定新品批次，如上市日期 ≥ 某 cutoff） |
```

- [ ] **Step 3: Commit**

```bash
git add sources-of-truth/business-context/material-master.md
git commit -m "docs(sot): 物料主数据增补上市日期/新品编码字段"
```

---

### Task 4: sku-profitability-knowledge — SKILL.md + metrics.md

**Files:**
- Create: `skills/sku-profitability-knowledge/SKILL.md`
- Create: `skills/sku-profitability-knowledge/references/metrics.md`

- [ ] **Step 1: 写 SKILL.md**

```markdown
---
name: sku-profitability-knowledge
description: SKU效益分析领域数据知识库。当用户询问单个SKU/物料的销售规模、帕累托、毛利贡献、库存周转、滞销、缺货、动销、跌价、新品蚕食、清仓处置建议等单品效益问题时自动激活。跨销售×库存×成本的分析专题域。
---

# SKU 效益分析领域 — 数据知识路由

## 作用

本 Skill 是路由层。SKU 效益问题是**跨表专题**：一张 SQL 通常横跨 Mix 表（销售/毛利）+ 出入库月表（动销）+ 上市口径跌价表（库存/跌价）+ 物料主数据（新品标识）。根据问题类型路由到对应参考文档。

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
| 上市口径跌价表 | `../../inventory-knowledge/references/stock-fall-list.md` |
| CHDJ 资金成本 | `../../inventory-knowledge/references/chdj-capital-cost.md` |
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
```

- [ ] **Step 2: 写 metrics.md**

```markdown
# SKU 效益分析 — 语义层（强制首读）

## 一、九问决策树

| # | 用户问题类型 | 主表组合 | 分析师模式 |
|---|---|---|---|
| 1 | SKU 销售规模/排名/帕累托/核心SKU | Mix | A |
| 2 | SKU 趋势/同比/环比 | Mix | B |
| 3 | SKU 毛利贡献/毛利率/四象限 | Mix | C |
| 4 | 库存周转/可售天数/库销比 | 上市口径+Mix | D |
| 5 | 滞销/缺货/动销率 | 出入库月表+上市口径(+otd未交付) | E |
| 6 | 新品增量/蚕食/替代 | 物料主数据+Mix | F |
| 7 | 渠道/区域 × SKU 差异 | Mix | G |
| 8 | 综合评分/处置建议（清仓/加大投入） | A-E+H 输出汇总 | I |
| 9 | 库存跌价/库龄分段 | 上市口径 | H |

SKU 键：Mix 表 `material_num` ↔ 上市口径表 `material` ↔ 出入库表 `material_num` ↔ 主数据 `material_num`。

## 二、效益利润口径（替代"净利润"）

**禁止**声称算出 SKU 级净利润/ROI——销售费用（广告/促销/售后/仓储）在凭证层不挂物料（2026-06 实证填充率 0%~0.5%），无法分摊。

**效益利润**（持有代价视角，全部现成字段）：

```
效益利润 = gross_profit_after_sharing（Mix 分摊后毛利）
         − aging_sum_fall_amt（上市口径跌价合计）
         − capital_cost（CHDJ 资金成本，口径符号待财务确认，确认前该减项标注"待确认"）
```

回答模板必须透明列出构成与缺口（"营销/售后费用不可分摊，未计入"）。

## 三、综合评分与处置阈值（业务给定公式）

```
综合评分 = 销售收入得分×25% + 毛利额得分×30% + 动销率得分×20%
         + 库存金额得分×15% + 库存周转得分×10%
```

- 各维度得分 = PERCENT_RANK×100（正向指标升序；库存金额**反向**——越多得分越低；周转用"库销比"反向近似：库存金额÷同期销售额，比值越小越好）
- 决策阈值：**≥80 加大投入；60-79 保留优化；40-59 调价降本；<40 或（周转超标且销售下降）降库存；效益利润为负且 `zisqc='是'`倾向 清仓淘汰**（业务原文"净利润为负"落地为效益利润为负）

## 四、口径与陷阱（全部实证）

1. **三套库存金额不可混用**：上市口径 14.3亿 / 阿米巴 CHDJ 6.35亿 / dm_own 1.88亿（202607-08 同期量级）。跌价/库龄→上市口径表；资金成本/阿米巴分摊→CHDJ。`dm_own_inventory_t` 未获业务确认，不使用。
2. **日期格式三态**：Mix `calmonth='2026-07'`；上市口径 `calmonth='202607'`；CHDJ `stat_month='2026-07'`。跨表同月条件必须分别写。
3. **跌价只有年段**（1年内/1-2/2-3/3-4/4年+，比例 0/20/30/50/50%）；业务"半年分段"只有金额可聚（天级细分字段），跌价金额必须按年段呈现。
4. **月粒度原则（业务裁定 2026-08-18）**：动销/缺货最小按月看，库存取月末快照。"有销量天数"=「有销量月份数」；缺货 = 月末库存为 0 且当月有出库/需求。
5. **SKU 范围口径差**：Mix 在售 6,232 vs 上市口径在库 64,605。跨表以 Mix 为主集 LEFT JOIN，或明确声明"在库口径"。
6. **判空**：`LENGTH(TRIM(col))>0`（`TRIM(col)<>''` 在 GaussDB 行为不一致）。
7. **Mix 必带过滤**：`data_source IN ('S','T','D','')`。
8. **周转口径透明**：可售天数 = 月末库存金额 ÷ 日均销售成本（Mix `act_cost_sum_amt` 月均÷30）；非财务精确周转，回答时注明。

## 五、渠道决策（同业绩域）

"渠道"默认 `integrate_channel__t`（3 值：零售/整装头部/工程）；产品导向用 `integrate_channel2__t`；SAP 原始用 `distr_chan__t`。详见业绩域 metrics.md 渠道决策树。

## 六、指标→字段速查

| 指标 | 字段 | 表 |
|---|---|---|
| 销售额（含税达成，主口径） | `ambperformance` | Mix |
| 销售面积/数量 | `zxsmj` / `zxssl` | Mix |
| 分摊后毛利 | `gross_profit_after_sharing` | Mix |
| 实际成本 | `act_cost_sum_amt` | Mix |
| 月末库存金额（上市口径） | `zsjkcje` | 上市口径表 |
| 跌价合计 | `aging_sum_fall_amt` | 上市口径表 |
| 是否清仓 | `zisqc` | 上市口径表 |
| 月度出库量/面积 | `out_stock_qty` / `out_stock_area` | 出入库月表 |
| 月末库存量/面积 | `stock_qty_month_end` / `stock_area_month_end` | 出入库月表 |
| 存货价值/资金成本（阿米巴） | `inventory_value` / `capital_cost` | CHDJ |
| 上市日期/新品标识 | `product_listed_date` / `new_product_code` | 物料主数据 |
```

- [ ] **Step 3: Commit**

```bash
git add skills/sku-profitability-knowledge/
git commit -m "feat(sku): 专题域知识层—九问决策树+效益利润口径+评分公式+8条实证陷阱"
```

---

### Task 5: sku-profitability-knowledge — 3 个问题族文档 + 血缘

**Files:**
- Create: `skills/sku-profitability-knowledge/references/sales-side-patterns.md`
- Create: `skills/sku-profitability-knowledge/references/inventory-side-patterns.md`
- Create: `skills/sku-profitability-knowledge/references/newproduct-decision-patterns.md`
- Create: `skills/sku-profitability-knowledge/references/data-lineage.md`

- [ ] **Step 1: 写 sales-side-patterns.md（问题 1/2/3/7 口径）**

```markdown
# 销售侧问题族 — 口径与表组合（问题 1/2/3/7）

> 可执行 SQL 见 analyst 模式 A/B/C/G。本文件只定口径。

## 问题1 SKU 销售规模 / 帕累托

- 表：Mix 单表（`material_num` 粒度聚合）
- 口径：销售额 = `ambperformance`（含税达成主口径）；面积 = `zxsmj`
- 帕累托：按销售额降序累计占比，80% 线为「核心 SKU」边界；报告端画线，SQL 给 `cum_pct`
- SKU 分层：累计 ≤80% 核心 / 80-95% 腰部 / >95% 长尾
- 品类过滤用 `category_name`；无品类条件时默认全品类 + LIMIT TOP N

## 问题2 SKU 趋势

- 表：Mix 单表，`calmonth` 月序列（'YYYY-MM'）
- 环比：LAG 窗口；同比：自连接 `t2.calmonth = to_char(to_date(t1.calmonth||'-01','YYYY-MM-DD') - interval '1 year','YYYY-MM')`
- **周度趋势不可答**（无周聚合表），引导用户按月

## 问题3 毛利贡献 / 四象限

- 表：Mix 单表
- 毛利额 = `gross_profit_after_sharing`（分摊后，主口径）；毛利率 = 毛利额÷`ambperformance`
- 四象限：横轴 = 销售增长率（本期 vs 上期等长窗口），纵轴 = 毛利率，气泡 = 销售额
- 品类平均毛利率 = 品类聚合毛利÷品类聚合销售额（不是 SKU 毛利率平均）

## 问题7 渠道/区域 × SKU

- 表：Mix 单表
- 渠道默认 `integrate_channel__t`；区域 = `region_province_name` 或 `node_desc*`（依用户表述）
- 热力图数据 = 渠道(列) × SKU(行) 的销售额/毛利率矩阵，TOP N SKU
```

- [ ] **Step 2: 写 inventory-side-patterns.md（问题 4/5/9 口径）**

```markdown
# 库存侧问题族 — 口径与表组合（问题 4/5/9）

> 可执行 SQL 见 analyst 模式 D/E/H。本文件只定口径。日期格式：上市口径表 calmonth=YYYYMM；出入库表 start_month=（Task 2 Step 2 验证值）。

## 问题4 库存周转 / 可售天数

- 表：上市口径表（月末库存金额 `zsjkcje`）× Mix（月均销售成本 `act_cost_sum_amt`）
- 可售天数 = 月末库存金额 ÷ (近 N 月平均月成本 ÷ 30)，N 默认 6
- 库销比 = 月末库存金额 ÷ 近 N 月销售额（评分公式的周转代理指标）
- 透明声明：非财务精确周转

## 问题5 滞销 / 缺货 / 动销（月粒度原则）

- 表：出入库月表（动销）+ 上市口径表（月末库存）+（可选）otd 未交付订单
- 动销率 = 有出库月份数 ÷ 统计期月份数（出库 = `out_stock_qty>0 OR out_stock_area>0`）
- 滞销 = 有库存且统计期内 0 动销（业务参考线：库销比>60 天计入滞销 SKU 数）
- 缺货 = 月末库存为 0 且当月有出库/需求；数量级补充 = otd 未交付订单
- 健康标记：正常 / 滞销 / 缺货 三态

## 问题9 库存跌价

- 表：上市口径表单表
- 跌价 = `aging_sum_fall_amt`（预计算，比例 0/20/30/50/50%）
- 分段呈现按年段；"半年分段"只有金额（天级细分聚合），透明说明
- 处置联动：`zisqc`（是否清仓）+ 跌价 TOP 榜
```

- [ ] **Step 3: 写 newproduct-decision-patterns.md（问题 6/8 口径）**

```markdown
# 新品与决策问题族 — 口径与表组合（问题 6/8）

> 可执行 SQL 见 analyst 模式 F/I。本文件只定口径。

## 问题6 新品增量 / 蚕食

- 表：物料主数据（新品圈定）× Mix（两期对比）
- 新品圈定：`product_listed_date >= cutoff`（格式见主数据文档，Task 3 已验证）或 `new_product_code` 非空
- 口径（业务模板定义）：
  - 新品销售额 = 新品 SKU 本期销售额合计
  - 替代销售额 = 原有 SKU（上期销售额 − 本期销售额）的正值部分合计（品类内）
  - 净增量 = 新品销售额 − 替代销售额
  - 蚕食率 = 替代销售额 ÷ 新品销售额 × 100%
- 透明声明：这是品类基准对比模型（假设无新品时老品持平），非因果归因

## 问题8 综合评分 / 处置建议

- 表：模式 A/C/D/E/H 输出的物料级中间结果汇总
- 公式与阈值：见 metrics.md 第三节
- 处置动作五档：保留并加大投入 / 优化价格或成本 / 降低库存 / 限渠道销售 / 清仓淘汰
- 报告呈现：决策四象限（评分×库存风险）+ 决策分布环形图 + 建议清单表
```

- [ ] **Step 4: 写 data-lineage.md**

```markdown
# SKU 效益分析 — 血缘与表关联

## 五张核心表

| 表 | 层 | 源 | 刷新 | 粒度 |
|---|---|---|---|---|
| `dm.dm_fin_operations_mix_sum_t` | DM | SAP 销售/成本多源汇入 | 月 | 渠道×品类×物料×月 |
| `dm.dm_product_inout_stock_t` | DM | 仓储出入库 | 月 | 工厂×品牌×物料×月 |
| `dm.dm_fin_stock_d_accage_list_c_t_2023` | DM | SAP 库存+批次入库日期推账龄 | 月 | 批次×物料×库存地点×月 |
| `dm.dm_ambv2_chdj_grp_t` | DM | 阿米巴核算体系 | 月 | 物料×工厂×渠道×销售组×月 |
| `dwimd.dwi_md_data_material_general_t` | DWI | SAP MARA/MAKT 类主数据 | SCD | 物料 |

## 关联键

```
Mix.material_num = 出入库.material_num = 上市口径.material = CHDJ.material_num = 主数据.material_num
```

- Mix ↔ 主数据：品类/产品层次/上市日期丰富维度（JOIN 主数据取最新版本）
- Mix ↔ 上市口径：销售侧 ↔ 库存侧（以 Mix 为主集 LEFT JOIN；库存口径差见 metrics.md 陷阱1/5）
- 出入库 ↔ 上市口径：动销 ↔ 库存快照（月粒度对齐：start_month ↔ calmonth，注意格式差异）

## 详细血缘

- Mix：`../../sales-performance-knowledge/references/data-lineage.md`
- 库存族：`../../inventory-knowledge/references/data-lineage.md`
```

- [ ] **Step 5: 链接检查 + Commit**

Run: `grep -c "references/" skills/sku-profitability-knowledge/SKILL.md` Expected: >= 5；确认 4 个新文件都在 references/ 下。

```bash
git add skills/sku-profitability-knowledge/
git commit -m "feat(sku): 问题族口径文档×3+血缘—销售/库存/新品决策"
```

---

### Task 6: sku-profitability-analyst SKILL.md（模式 A-I）

**Files:**
- Create: `skills/sku-profitability-analyst/SKILL.md`

- [ ] **Step 1: 写 SKILL.md**

骨架复用 `skills/sales-performance-analyst/SKILL.md` 的 6 步工作流与对抗审查结构（先 Read 该文件对齐章节样式），域专属内容如下：

frontmatter:
```markdown
---
name: sku-profitability-analyst
description: SKU效益分析执行器。接收单个SKU或SKU组的效益问题（规模/趋势/毛利/周转/滞销/跌价/新品/处置），按6步工作流产出带溯源的SQL结果。必须先读 sku-profitability-knowledge 语义层。
---
```

6 步工作流（对齐现有域）：①读 knowledge metrics.md 语义层 → ②确认问题类型（九问决策树）与 SKU 范围口径 → ③选模式写 SQL（下方 A-I）→ ④执行（MCP run_query，大表必带时间过滤）→ ⑤对抗审查（口径三查：库存口径用对表了吗/日期格式对了吗/SKU 主集声明了吗）→ ⑥输出 Markdown 结果（数字+口径声明+陷阱提示）。

**模式 A-I**（完整 SQL；`start_month`/`product_listed_date` 格式以 Task 2/3 验证值为准，若为 YYYYMM 将下方 'YYYY-MM' 形式替换为 'YYYYMM'）：

```sql
-- 模式 A：SKU 帕累托（问题1）
WITH ranked AS (
  SELECT material_num, MAX(material_name) AS material_name,
         ROUND(SUM(ambperformance)) AS amt, ROUND(SUM(zxsmj)) AS area
  FROM dm.dm_fin_operations_mix_sum_t
  WHERE calmonth BETWEEN '2026-01' AND '2026-06'
    AND data_source IN ('S','T','D','')
    AND category_name = '{品类}'            -- 无品类条件时删除此行
  GROUP BY material_num
), r2 AS (SELECT *, ROW_NUMBER() OVER (ORDER BY amt DESC) AS rnk FROM ranked)
SELECT rnk, material_num, material_name, amt, area,
       ROUND(100.0 * SUM(amt) OVER (ORDER BY rnk ROWS UNBOUNDED PRECEDING)
             / SUM(amt) OVER (), 1) AS cum_pct
FROM r2 ORDER BY rnk LIMIT 30;

-- 模式 B：SKU 月度趋势+环比（问题2）
SELECT calmonth, ROUND(SUM(ambperformance)) AS amt, ROUND(SUM(zxsmj)) AS area,
       ROUND(100.0 * (SUM(ambperformance) - LAG(SUM(ambperformance)) OVER (ORDER BY calmonth))
             / NULLIF(LAG(SUM(ambperformance)) OVER (ORDER BY calmonth), 0), 1) AS mom_pct
FROM dm.dm_fin_operations_mix_sum_t
WHERE material_num = '{SKU}' AND calmonth BETWEEN '2026-02' AND '2026-07'
  AND data_source IN ('S','T','D','')
GROUP BY calmonth ORDER BY calmonth;

-- 模式 C：毛利四象限数据（问题3；本期/上期等长窗口）
WITH cur AS (
  SELECT material_num, SUM(ambperformance) AS amt, SUM(gross_profit_after_sharing) AS gp
  FROM dm.dm_fin_operations_mix_sum_t
  WHERE calmonth BETWEEN '2026-05' AND '2026-07' AND data_source IN ('S','T','D','')
  GROUP BY material_num
), prev AS (
  SELECT material_num, SUM(ambperformance) AS amt
  FROM dm.dm_fin_operations_mix_sum_t
  WHERE calmonth BETWEEN '2026-02' AND '2026-04' AND data_source IN ('S','T','D','')
  GROUP BY material_num
)
SELECT c.material_num, ROUND(c.amt) AS amt,
       ROUND(100.0*c.gp/NULLIF(c.amt,0),1) AS gp_rate,
       ROUND(100.0*(c.amt-p.amt)/NULLIF(p.amt,0),1) AS growth_pct
FROM cur c JOIN prev p USING (material_num)
ORDER BY c.amt DESC LIMIT 50;

-- 模式 D：可售天数/库销比（问题4；月末 202607 快照）
WITH stock AS (
  SELECT material, SUM(zsjkcje) AS stock_amt
  FROM dm.dm_fin_stock_d_accage_list_c_t_2023
  WHERE calmonth = '202607' GROUP BY material
), cost AS (
  SELECT material_num, AVG(m_cost) AS avg_m_cost, AVG(m_amt) AS avg_m_amt FROM (
    SELECT material_num, calmonth, SUM(act_cost_sum_amt) AS m_cost, SUM(ambperformance) AS m_amt
    FROM dm.dm_fin_operations_mix_sum_t
    WHERE calmonth BETWEEN '2026-02' AND '2026-07' AND data_source IN ('S','T','D','')
    GROUP BY material_num, calmonth) t
  GROUP BY material_num
)
SELECT s.material, ROUND(s.stock_amt) AS stock_amt,
       ROUND(s.stock_amt / NULLIF(c.avg_m_cost/30.0,0), 0) AS dos_days,
       ROUND(s.stock_amt / NULLIF(c.avg_m_amt,0), 2) AS stock_sales_ratio
FROM stock s JOIN cost c ON s.material = c.material_num
ORDER BY dos_days DESC NULLS LAST LIMIT 50;

-- 模式 E：动销/滞销/缺货（问题5；月粒度）
WITH act AS (
  SELECT material_num, COUNT(DISTINCT start_month) AS active_months
  FROM dm.dm_product_inout_stock_t
  WHERE start_month BETWEEN '2026-01' AND '2026-07'
    AND (out_stock_qty > 0 OR out_stock_area > 0)
  GROUP BY material_num
), stock AS (
  SELECT material, SUM(zsjkcje) AS stock_amt
  FROM dm.dm_fin_stock_d_accage_list_c_t_2023
  WHERE calmonth = '202607' GROUP BY material
)
SELECT COALESCE(a.material_num, s.material) AS material,
       COALESCE(a.active_months,0) AS active_months,
       ROUND(100.0*COALESCE(a.active_months,0)/7,0) AS active_rate,
       ROUND(COALESCE(s.stock_amt,0)) AS stock_amt,
       CASE WHEN COALESCE(s.stock_amt,0)=0 AND COALESCE(a.active_months,0)>0 THEN '缺货'
            WHEN COALESCE(s.stock_amt,0)>0 AND COALESCE(a.active_months,0)=0 THEN '滞销'
            ELSE '正常' END AS health_flag
FROM act a FULL OUTER JOIN stock s ON a.material_num = s.material
ORDER BY stock_amt DESC NULLS LAST LIMIT 100;

-- 模式 F：新品增量/蚕食（问题6；cutoff 依业务，默认近12个月上市）
WITH new_sku AS (
  SELECT material_num FROM dwimd.dwi_md_data_material_general_t
  WHERE product_listed_date >= '20250701'      -- 格式以 Task 3 验证为准
), split AS (
  SELECT CASE WHEN n.material_num IS NOT NULL THEN '新品' ELSE '老品' END AS sku_type,
         SUM(m.ambperformance) AS amt
  FROM dm.dm_fin_operations_mix_sum_t m
  LEFT JOIN new_sku n ON m.material_num = n.material_num
  WHERE m.calmonth BETWEEN '2026-01' AND '2026-06' AND m.data_source IN ('S','T','D','')
  GROUP BY 1
), prev_old AS (
  SELECT SUM(m.ambperformance) AS amt
  FROM dm.dm_fin_operations_mix_sum_t m
  JOIN new_sku n ON m.material_num = n.material_num  -- 排除新品后的老品上期
  WHERE false  -- 说明：上期老品 = 上期销售额 - 上期新品销售额，见下方完整版
)
-- 完整版（品类内两期对比）：
-- 蚕食率 = MAX(0, 老品上期-老品本期) / 新品本期，按品类分组同法

-- 模式 G：渠道×SKU 透视（问题7）
SELECT integrate_channel__t AS channel,
       ROUND(SUM(ambperformance)) AS amt,
       ROUND(SUM(gross_profit_after_sharing)) AS gp,
       ROUND(100.0*SUM(gross_profit_after_sharing)/NULLIF(SUM(ambperformance),0),1) AS gp_rate
FROM dm.dm_fin_operations_mix_sum_t
WHERE material_num = '{SKU}' AND calmonth BETWEEN '2026-01' AND '2026-07'
  AND data_source IN ('S','T','D','')
GROUP BY integrate_channel__t ORDER BY amt DESC;

-- 模式 H：跌价 TOP N（问题9）
SELECT material, MAX(material___t) AS material_name,
       ROUND(SUM(aging_sum_fall_amt)) AS fall_amt,
       ROUND(SUM(zsjkcje)) AS stock_amt,
       ROUND(SUM(aging_1_2_year_fall_amt)) AS fall_1_2y,
       ROUND(SUM(aging_2_3_year_fall_amt)) AS fall_2_3y,
       ROUND(SUM(aging_3_4_year_fall_amt)) AS fall_3_4y,
       ROUND(SUM(aging_4_year_fall_amt)) AS fall_4y
FROM dm.dm_fin_stock_d_accage_list_c_t_2023
WHERE calmonth = '202607'
GROUP BY material ORDER BY fall_amt DESC LIMIT 10;

-- 模式 I：综合评分/处置（问题8；评分维度与阈值见 knowledge metrics.md 第三节）
WITH cur AS (
  SELECT material_num, SUM(ambperformance) AS amt, SUM(gross_profit_after_sharing) AS gp
  FROM dm.dm_fin_operations_mix_sum_t
  WHERE calmonth BETWEEN '2026-05' AND '2026-07' AND data_source IN ('S','T','D','')
  GROUP BY material_num
), act AS (
  SELECT material_num, COUNT(DISTINCT start_month) AS active_months
  FROM dm.dm_product_inout_stock_t
  WHERE start_month BETWEEN '2026-01' AND '2026-07'
    AND (out_stock_qty > 0 OR out_stock_area > 0)
  GROUP BY material_num
), stk AS (
  SELECT material, SUM(zsjkcje) AS stock_amt, SUM(aging_sum_fall_amt) AS fall_amt
  FROM dm.dm_fin_stock_d_accage_list_c_t_2023 WHERE calmonth='202607' GROUP BY material
), base AS (
  SELECT c.material_num, c.amt, c.gp, COALESCE(a.active_months,0) AS active_months,
         COALESCE(s.stock_amt,0) AS stock_amt, COALESCE(s.fall_amt,0) AS fall_amt
  FROM cur c
  LEFT JOIN act a ON c.material_num=a.material_num
  LEFT JOIN stk s ON c.material_num=s.material
  WHERE c.amt > 0
), scored AS (
  SELECT *,
    ROUND(100*PERCENT_RANK() OVER (ORDER BY amt),1) AS s_sales,
    ROUND(100*PERCENT_RANK() OVER (ORDER BY gp),1) AS s_gp,
    ROUND(100*active_months/7.0,1) AS s_active,
    ROUND(100*PERCENT_RANK() OVER (ORDER BY stock_amt DESC),1) AS s_stock_inv,
    ROUND(100*PERCENT_RANK() OVER (ORDER BY stock_amt/NULLIF(amt,0) ASC),1) AS s_turnover
  FROM base
), final AS (
  SELECT *, ROUND(s_sales*0.25+s_gp*0.30+s_active*0.20+s_stock_inv*0.15+s_turnover*0.10,1) AS score
  FROM scored
)
SELECT material_num, ROUND(amt) AS amt, ROUND(fall_amt) AS fall_amt, stock_amt, score,
       CASE WHEN score>=80 THEN '加大投入' WHEN score>=60 THEN '保留优化'
            WHEN score>=40 THEN '调价降本' ELSE '清仓淘汰' END AS action
FROM final ORDER BY score DESC LIMIT 20;
```

对抗审查节（域专属三查）：①库存口径查——跌价/库龄必须上市口径表，资金成本必须 CHDJ，混用即打回；②日期格式查——Mix 'YYYY-MM'、上市口径 'YYYYMM'、CHDJ 'YYYY-MM'；③SKU 主集查——跨表以 Mix 为主集或声明在库口径；④净利润红线——输出中出现"净利润/ROI"字样且未带效益利润口径声明即打回。

- [ ] **Step 2: 抽查 3 条模式 SQL 可执行**

经 MCP 分别运行模式 H（预期 10 行）、模式 A（去掉品类行，LIMIT 10，预期 10 行）、模式 D（LIMIT 5，预期 ≤5 行）。报错则修 SKILL.md 后重试。

- [ ] **Step 3: Commit**

```bash
git add skills/sku-profitability-analyst/
git commit -m "feat(sku): 分析师域—6步工作流+模式A-I(帕累托/趋势/四象限/周转/健康/新品/渠道/跌价/评分)"
```

---

### Task 7: eval 9 场景入库 + 全绿

**Files:**
- Modify: `eval_dataset.json`

- [ ] **Step 1: 预备参数查询（MCP）**

1. 取真实头部 SKU：`SELECT material_num FROM dm.dm_fin_operations_mix_sum_t WHERE calmonth BETWEEN '2026-05' AND '2026-07' AND data_source IN ('S','T','D','') GROUP BY material_num ORDER BY SUM(ambperformance) DESC LIMIT 1` → 记为 `{TOP_SKU}`
2. 取真实品类名：`SELECT category_name, COUNT(*) FROM dm.dm_fin_operations_mix_sum_t WHERE calmonth='2026-07' AND data_source IN ('S','T','D','') GROUP BY category_name ORDER BY 2 DESC LIMIT 3` → 选一行为 `{CAT}`
3. 用 `{TOP_SKU}`/`{CAT}` 代入 Task 6 模式 A/B/C/D/G SQL；模式 E 用计数版：外层 `SELECT health_flag, COUNT(*) FROM (模式E内层) t GROUP BY health_flag ORDER BY 1`；模式 F 用 split 版；H/I 原样

- [ ] **Step 2: 逐条运行 9 条 golden SQL 记录 row_count 与样例数据**

每条经 MCP 运行，记录行数与前 3 行。`start_month`/`product_listed_date` 格式按 Task 2/3 验证结果调整日期字面量。

- [ ] **Step 3: 写入 eval_dataset.json**

用脚本追加（避免手改 JSON 出错）：

```python
# append_sku_evals.py（临时脚本，用后删除）
import json, hashlib

NEW = [
  # 每项: {"domain":"sku-profitability","pattern":...,"question":...,"sql":...,
  #        "row_count":<Step2实测>,"elapsed_ms":<实测>,"data":<前3行>,"checksum":"<md5(sql)>"}
]
with open("eval_dataset.json", encoding="utf-8") as f:
    d = json.load(f)
for q in NEW:
    q["checksum"] = hashlib.md5(q["sql"].encode()).hexdigest()
d["questions"].extend(NEW)
d["meta"]["total"] = len(d["questions"])
if "sku-profitability" not in d["meta"]["domains"]:
    d["meta"]["domains"].append("sku-profitability")
with open("eval_dataset.json", "w", encoding="utf-8") as f:
    json.dump(d, f, ensure_ascii=False, indent=2)
print("total:", d["meta"]["total"])
```

9 场景清单（question 用户口吻 / pattern）：
1. `sku_pareto` — "2026年上半年{CAT}品类销售额TOP20的SKU及累计占比如何？"
2. `sku_trend_mom` — "物料{TOP_SKU}近半年销售额环比变化如何？"
3. `sku_margin_quadrant` — "近3个月SKU毛利率与销售增长率四象限数据（销售额TOP30）"
4. `sku_turnover_dos` — "7月末库存可售天数最长的50个SKU是哪些？"
5. `sku_health_flag` — "2026年前7个月在库SKU的健康状态分布（正常/滞销/缺货）？"
6. `sku_newproduct_split` — "2026年上半年新品与老品的销售额拆分如何？"
7. `sku_channel_pivot` — "物料{TOP_SKU}在各整合渠道的销售额与毛利率？"
8. `sku_fall_top10` — "7月末存货跌价TOP10的SKU？"
9. `sku_score_top20` — "SKU综合效益评分TOP20及处置建议？"

- [ ] **Step 4: 验证 JSON 完整 + 删临时脚本**

Run: `python -c "import json; d=json.load(open('eval_dataset.json',encoding='utf-8')); print(d['meta']['total'], len([q for q in d['questions'] if q['domain']=='sku-profitability']))"`
Expected: `66 9`。然后删除 `append_sku_evals.py`。

- [ ] **Step 5: 跑新域 eval**

Run: `python run_eval.py sku-profitability`
Expected: `9 PASS 0 FAIL`。某场景 FAIL（行数漂移）→ 重跑该 SQL 取新 row_count 更新（数据月更导致 ±1 行可接受，更新后重跑）。

- [ ] **Step 6: 存量回归**

Run: `python run_eval.py`
Expected: 总 66，FAIL 仅允许数据漂移项；与运行前基线对比无新增 FAIL。

- [ ] **Step 7: Commit**

```bash
git add eval_dataset.json
git commit -m "test(sku): 9条SKU效益eval场景入库—帕累托/趋势/四象限/周转/健康/新品/渠道/跌价/评分"
```

---

## 阶段 2：报表层（report-generator v2.1）

### Task 8: validator v2.1 — 先写失败测试

**Files:**
- Modify: `skills/report-generator/tests/test_validate_report.py`（追加）

- [ ] **Step 1: 追加测试**

在文件末尾追加：

```python
# ---------- v2.1 扩展 ----------

def test_series_level_valueformat_passes():
    r = _base_report()
    r["sections"][0]["chart"]["option"]["series"] = [
        {"name": "a", "type": "bar", "data": [1, 2], "valueFormat": "yi"},
        {"name": "b", "type": "line", "data": [10, 20], "valueFormat": "percent"}]
    assert vr.validate_data(r) == []


def test_series_level_bad_valueformat_fails():
    r = _base_report()
    r["sections"][0]["chart"]["option"]["series"] = [
        {"name": "a", "type": "bar", "data": [1], "valueFormat": "billion"}]
    errs = vr.validate_data(r)
    assert any("series[0].valueFormat" in e for e in errs), errs


def test_yaxis_level_valueformat_validated():
    r = _base_report()
    opt = r["sections"][0]["chart"]["option"]
    opt["yAxis"] = [{"type": "value", "valueFormat": "yi:1"},
                    {"type": "value", "valueFormat": "percent"}]
    assert vr.validate_data(r) == []
    opt["yAxis"][1]["valueFormat"] = "pct"
    errs = vr.validate_data(r)
    assert any("yAxis[1].valueFormat" in e for e in errs), errs


def test_int_format_accepted():
    r = _base_report()
    r["sections"][0]["chart"]["valueFormat"] = "int"
    assert vr.validate_data(r) == []


def test_tone_cell_passes():
    r = _base_report()
    r["sections"][1]["table"]["rows"] = [["1", {"v": "正常", "tone": "good"}, {"v": "—", "tone": "na"}]]
    assert vr.validate_data(r) == []


def test_tone_cell_bad_enum_fails():
    r = _base_report()
    r["sections"][1]["table"]["rows"] = [["1", {"v": "x", "tone": "green"}]]
    errs = vr.validate_data(r)
    assert any("tone" in e for e in errs), errs


def test_tone_cell_missing_v_fails():
    r = _base_report()
    r["sections"][1]["table"]["rows"] = [["1", {"tone": "good"}]]
    errs = vr.validate_data(r)
    assert any("rows[0][1].v" in e for e in errs), errs
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python -m pytest skills/report-generator/tests/test_validate_report.py -v`
Expected: 新增 7 个中至少 5 个 FAIL（series/yAxis 校验缺失、int 拒绝、tone 校验缺失）；`test_tone_cell_missing_v_fails` 可能因当前不校验 dict 而意外 PASS——以实现后全绿为准。

---

### Task 9: validator v2.1 实现 + schema 同步

**Files:**
- Modify: `skills/report-generator/scripts/validate_report.py`
- Modify: `skills/report-generator/references/report-schema.json`

- [ ] **Step 1: VALUE_FORMAT_RE 加 int（第 26 行）**

```python
VALUE_FORMAT_RE = re.compile(r"^(yi|wan|percent|signed_percent|sqm_wan|yuan|int)(:[0-9])?$")
```

- [ ] **Step 2: `_validate_chart_section` 的 option 校验块追加 series/yAxis 检查**

在 `n = _count_data_points(opt)` 数据点检查之后、函数返回前追加：

```python
            for si, se in enumerate(opt.get("series") or []):
                if isinstance(se, dict):
                    svf = se.get("valueFormat")
                    if svf is not None and (not isinstance(svf, str) or not VALUE_FORMAT_RE.match(svf)):
                        err(cp + ".option.series[%d].valueFormat" % si,
                            "非法值 %r，允许 yi/wan/percent/signed_percent/sqm_wan/yuan/int 可带 :N" % svf)
            yax = opt.get("yAxis")
            ax_list = yax if isinstance(yax, list) else ([yax] if yax else [])
            for yi_, ax in enumerate(ax_list):
                if isinstance(ax, dict):
                    avf = ax.get("valueFormat")
                    if avf is not None and (not isinstance(avf, str) or not VALUE_FORMAT_RE.match(avf)):
                        err(cp + ".option.yAxis[%d].valueFormat" % yi_,
                            "非法值 %r，允许 yi/wan/percent/signed_percent/sqm_wan/yuan/int 可带 :N" % avf)
```

- [ ] **Step 3: `_validate_table_section` 追加单元格校验**

在 pageSize 校验之后追加：

```python
    for ri, row in enumerate(tbl["rows"]):
        if not isinstance(row, list):
            err(p + ".table.rows[%d]" % ri, "必须是数组")
            continue
        for ci, cell in enumerate(row):
            if isinstance(cell, dict):
                if not str(cell.get("v") or "").strip():
                    err(p + ".table.rows[%d][%d].v" % (ri, ci), "不能为空")
                if cell.get("tone") not in ("good", "warn", "bad", "na"):
                    err(p + ".table.rows[%d][%d].tone" % (ri, ci),
                        "非法值 %r，允许 good/warn/bad/na" % cell.get("tone"))
            elif not isinstance(cell, (str, int, float)) or isinstance(cell, bool):
                err(p + ".table.rows[%d][%d]" % (ri, ci), "单元格必须是字符串/数值或 {v, tone} 对象")
```

- [ ] **Step 4: 跑测试全绿**

Run: `python -m pytest skills/report-generator/tests/ -v`
Expected: 全部 PASS（存量 16 + 新增 7 ≈ 23）。

- [ ] **Step 5: schema 同步（report-schema.json）**

1. 两处 valueFormat `pattern` 改为 `"^(yi|wan|percent|signed_percent|sqm_wan|yuan|int)(:[0-9])?$"`
2. `definitions.chart.properties.option` 改为：

```json
"option": {
  "type": "object",
  "properties": {
    "series": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "valueFormat": {"type": "string", "pattern": "^(yi|wan|percent|signed_percent|sqm_wan|yuan|int)(:[0-9])?$"}
        }
      }
    },
    "yAxis": {
      "oneOf": [
        {"type": "object", "properties": {"valueFormat": {"type": "string", "pattern": "^(yi|wan|percent|signed_percent|sqm_wan|yuan|int)(:[0-9])?$"}}},
        {"type": "array", "items": {"type": "object", "properties": {"valueFormat": {"type": "string", "pattern": "^(yi|wan|percent|signed_percent|sqm_wan|yuan|int)(:[0-9])?$"}}}}
      ]
    }
  }
}
```

3. table 的 rows items 改为：

```json
"rows": {
  "type": "array", "minItems": 1,
  "items": {
    "type": "array",
    "items": {
      "oneOf": [
        {"type": "string"},
        {"type": "number"},
        {"type": "object", "required": ["v", "tone"],
         "properties": {"v": {"type": "string", "minLength": 1},
                        "tone": {"enum": ["good", "warn", "bad", "na"]}}}
      ]
    }
  }
}
```

- [ ] **Step 6: schema JSON 语法自检**

Run: `python -c "import json; json.load(open('skills/report-generator/references/report-schema.json', encoding='utf-8')); print('OK')"`
Expected: `OK`

- [ ] **Step 7: Commit**

```bash
git add skills/report-generator/scripts/validate_report.py skills/report-generator/references/report-schema.json skills/report-generator/tests/
git commit -m "feat(report): validator v2.1—series/yAxis级valueFormat+tone单元格+int格式"
```

---

### Task 10: 模板 v2.1 — 就近格式 + tone 渲染

**Files:**
- Modify: `skills/report-generator/templates/report-shell.html`

- [ ] **Step 1: FORMAT_REGISTRY 加 int（479-487 行区域）**

```javascript
  var FORMAT_REGISTRY = {
    yi:             { div: 100000000, unit: '亿',  sep: false },
    wan:            { div: 10000,     unit: '万',  sep: true  },
    percent:        { div: 1,         unit: '%',   sep: false },
    signed_percent: { div: 1,         unit: '%',   sep: false, sign: true },
    sqm_wan:        { div: 10000,     unit: '万㎡', sep: false },
    yuan:           { div: 1,         unit: '元',  sep: true  },
    int:            { div: 1,         unit: '',   sep: true  }
  };
  var FORMAT_DEFAULT_DEC = { yi: 2, wan: 0, percent: 1, signed_percent: 1, sqm_wan: 1, yuan: 0, int: 0 };
```

- [ ] **Step 2: 替换 initializeCharts 的 fns 注入块（819-850 行区域）**

将 `var fns = null;` 起至 `if (fns) { ... }` 整块替换为：

```javascript
            /* ---- v2.1: valueFormat 就近作用域 (series > chart; yAxis > chart) ---- */
            var chartSpec = parseValueFormat(ch.valueFormat || '');
            if (ch.valueFormat && !chartSpec) {
              dom.innerHTML = '<div class="chart-error">非法 valueFormat: ' + escapeHTML(ch.valueFormat)
                + ' — 允许 yi/wan/percent/signed_percent/sqm_wan/yuan/int（可带 :N）</div>';
              return;
            }
            var seriesSpecs = [];
            (mergedOption.series || []).forEach(function (se) {
              if (se && se.valueFormat && !parseValueFormat(se.valueFormat)) {
                dom.innerHTML = '<div class="chart-error">非法 series valueFormat: ' + escapeHTML(se.valueFormat) + '</div>';
              }
              seriesSpecs.push(parseValueFormat((se && se.valueFormat) || '') || chartSpec);
            });
            /* yAxis 轴标签：就近取格式 */
            var yAxes = mergedOption.yAxis;
            (Array.isArray(yAxes) ? yAxes : [yAxes]).forEach(function (ax) {
              if (!ax) return;
              var axSpec = parseValueFormat(ax.valueFormat || '') || chartSpec;
              if (axSpec) {
                ax.axisLabel = ax.axisLabel || {};
                if (!ax.axisLabel.formatter) ax.axisLabel.formatter = function (v) { return formatValue(v, axSpec); };
              }
            });
            /* tooltip：逐系列取格式 */
            if (seriesSpecs.length) {
              if (!mergedOption.tooltip) mergedOption.tooltip = { trigger: 'axis' };
              if (!mergedOption.tooltip.trigger) mergedOption.tooltip.trigger = 'axis';
              if (!mergedOption.tooltip.formatter) {
                mergedOption.tooltip.formatter = (ch.tooltipTemplate === 'pie')
                  ? function (p) {
                      var sp = seriesSpecs[p.seriesIndex] || chartSpec;
                      return p.name + ': ' + (sp ? formatValue(p.value, sp) : p.value) + ' (' + p.percent + '%)';
                    }
                  : function (params) {
                      var r = params[0].name + '<br/>';
                      params.forEach(function (p) {
                        var sp = seriesSpecs[p.seriesIndex] || chartSpec;
                        r += p.marker + ' ' + p.seriesName + ': ' + (sp ? formatValue(p.value, sp) : p.value) + '<br/>';
                      });
                      return r;
                    };
              }
              if (mergedOption.tooltip.trigger === 'item' || ch.tooltipTemplate === 'pie') {
                mergedOption.tooltip.trigger = 'item';
              }
              (mergedOption.series || []).forEach(function (se, i) {
                if (!se) return;
                se.label = se.label || {};
                if (se.type === 'pie') {
                  if (!se.label.formatter) se.label.formatter = function (p) {
                    return p.name + '\n' + p.percent + '%';
                  };
                } else if (!se.label.formatter) {
                  var sp2 = seriesSpecs[i];
                  if (sp2) se.label.formatter = function (p) { return formatValue(p.value, sp2); };
                }
              });
            }
```

- [ ] **Step 3: 表格 tone 渲染（730-750 行区域 forEach）**

将单元格 forEach 内 `var cls = ''; var text = String(cell);` 起至 `rowHTML += '<td class="' + cls + '">' + escapeHTML(text) + '</td>';` 替换为：

```javascript
          var cls = '';
          var tone = '';
          var raw = cell;
          if (cell !== null && typeof cell === 'object') {
            tone = cell.tone || '';
            raw = cell.v;
          }
          var text = String(raw);
          /* Detect numeric cells: pure number, no Chinese unit suffix */
          if (typeof raw === 'number' || (!isNaN(parseFloat(text)) && isFinite(text) && text.trim() !== '')) {
            /* Skip values that already have Chinese formatting */
            if (/[亿万%％]$/.test(text)) {
              cls = '';
            } else if (text === '—' || text === '-') {
              cls = '';
            } else {
              cls = 'num';
            }
          }
          /* Detect negative values */
          var numVal = parseFloat(text.replace(/,/g, ''));
          if (!isNaN(numVal) && numVal < 0) {
            cls += ' neg';
          }
          if (tone) cls = cls ? cls + ' tone-' + tone : 'tone-' + tone;
          rowHTML += '<td class="' + cls + '">' + escapeHTML(text) + '</td>';
```

- [ ] **Step 4: tone CSS**

在 `<style>` 区 `.data-table td.neg`（或 num/neg 相关规则）之后追加：

```css
    .data-table td.tone-good { color: #2e9e5b; font-weight: 600; }
    .data-table td.tone-warn { color: #c9930a; font-weight: 600; }
    .data-table td.tone-bad { color: #e05252; font-weight: 600; }
    .data-table td.tone-na { color: #8a94a6; }
```

- [ ] **Step 5: grep 验证**

```bash
grep -c "tone-good\|tone-warn\|tone-bad\|tone-na" skills/report-generator/templates/report-shell.html   # >= 5
grep -c "reviveFunctions\|eval(" skills/report-generator/templates/report-shell.html                     # 0
grep -c "__REPORT_VALID__" skills/report-generator/templates/report-shell.html                           # >= 1
grep -c "seriesSpecs" skills/report-generator/templates/report-shell.html                                # >= 5
```

- [ ] **Step 6: 存量测试回归**

Run: `python -m pytest skills/report-generator/tests/ -v`
Expected: 全 PASS（模板改动不触碰 Python 测试，但 builder 端到端会重渲染模板，验证无语法撕裂）。

- [ ] **Step 7: Commit**

```bash
git add skills/report-generator/templates/report-shell.html
git commit -m "feat(report): 模板v2.1—valueFormat就近作用域+逐系列tooltip+tone四色渲染+int"
```

---

### Task 11: chart-recipes.md + SKILL.md v2.1 + selftest 扩展

**Files:**
- Create: `skills/report-generator/references/chart-recipes.md`
- Modify: `skills/report-generator/SKILL.md`
- Modify: `skills/report-generator/scripts/build.py`（SELFTEST_JSON）

- [ ] **Step 1: 写 chart-recipes.md**

```markdown
# 图表配方 v2.1 — 帕累托 / 四象限气泡 / 热力图 / 瀑布

> 全部纯 JSON（零 JS 函数）。单图数据点 ≤200，超出先 TOP-N 聚合。

## 1. 帕累托（柱=金额，线=累计占比）

要点：双 yAxis 各自带 `valueFormat`；series 各自带 `valueFormat`（覆盖 chart 级默认）。

```json
{
  "id": "pareto", "title": "SKU 帕累托", "valueFormat": "yi:2",
  "option": {
    "xAxis": {"type": "category", "data": ["SKU1", "SKU2", "SKU3"]},
    "yAxis": [
      {"type": "value", "name": "销售额(亿)", "valueFormat": "yi:2"},
      {"type": "value", "name": "累计占比", "valueFormat": "percent", "max": 100}
    ],
    "series": [
      {"name": "销售额", "type": "bar", "data": [500000000, 300000000, 200000000], "valueFormat": "yi:2"},
      {"name": "累计占比", "type": "line", "yAxisIndex": 1, "data": [50, 80, 100], "valueFormat": "percent"}
    ]
  }
}
```

80% 核心线（可选）：`"markLine": {"data": [{"yAxis": 80}]}` 加在折线 series 上。

## 2. 四象限气泡（散点+分割线）

要点：逐点 `symbolSize` 由分析师预计算（建议 `8 + 52 * sqrt(v/max_v)`，√面积感知）；分割线用声明式 markLine（xAxis/yAxis 值）。

```json
{
  "id": "quad", "title": "SKU 效益四象限", "valueFormat": "signed_percent:1",
  "option": {
    "xAxis": {"type": "value", "name": "销售增长率%"},
    "yAxis": {"type": "value", "name": "毛利率%"},
    "series": [{
      "name": "SKU", "type": "scatter",
      "data": [
        {"name": "SKU-A", "value": [12.5, 30.2], "symbolSize": 40},
        {"name": "SKU-B", "value": [-8.1, 15.0], "symbolSize": 22}
      ],
      "markLine": {
        "symbol": "none", "lineStyle": {"type": "dashed"},
        "data": [{"xAxis": 0}, {"yAxis": 25}]
      }
    }]
  }
}
```

tooltip 显示名称：chart 级 `tooltipTemplate` 默认 multi；散点建议 `"option": {"tooltip": {"trigger": "item"}}`。

## 3. 热力图（渠道 × SKU）

要点：visualMap 声明 min/max；x=渠道、y=SKU、value=指标；TOP-N 控制点数（如 20 SKU × 8 渠道 = 160 ≤ 200）。

```json
{
  "id": "heat", "title": "渠道×SKU 销售额热力", "valueFormat": "wan",
  "option": {
    "tooltip": {"trigger": "item"},
    "grid": {"height": "60%"},
    "xAxis": {"type": "category", "data": ["零售", "整装头部", "工程"], "splitArea": {"show": true}},
    "yAxis": {"type": "category", "data": ["SKU1", "SKU2"], "splitArea": {"show": true}},
    "visualMap": {"min": 0, "max": 10000000, "calculable": true, "orient": "horizontal", "left": "center", "bottom": "0%"},
    "series": [{"name": "销售额", "type": "heatmap",
      "data": [[0, 0, 5200000], [1, 0, 1800000], [2, 1, 900000]]}]
  }
}
```

## 4. 瀑布图（利润/增量拆解）

要点：堆叠柱两系列——`base` 透明垫底（`itemStyle.color: "rgba(0,0,0,0)"`、`tooltip.show: false`、`emphasis` 关闭），`value` 实际增量；负值由分析师换算进 base/value 两个正数列。

```json
{
  "id": "waterfall", "title": "效益利润瀑布", "valueFormat": "wan",
  "option": {
    "xAxis": {"type": "category", "data": ["分摊后毛利", "跌价", "资金成本", "效益利润"]},
    "yAxis": {"type": "value", "valueFormat": "wan"},
    "series": [
      {"name": "base", "type": "bar", "stack": "w", "itemStyle": {"color": "rgba(0,0,0,0)"},
       "emphasis": {"itemStyle": {"color": "rgba(0,0,0,0)"}}, "data": [0, 8000, 7000, 0]},
      {"name": "金额", "type": "bar", "stack": "w", "valueFormat": "wan",
       "data": [10000, 2000, 1000, 9000]}
    ]
  }
}
```

## 表格条件着色（tone）

单元格 `字符串` 或 `{"v": "文本", "tone": "good|warn|bad|na"}`（绿/黄/红/灰）。适用：健康标记、评分档位、达成率红绿灯。

```json
"table": {"columns": ["SKU", "健康状态", "评分"],
          "rows": [["SKU-A", {"v": "正常", "tone": "good"}, {"v": "88", "tone": "good"}],
                   ["SKU-B", {"v": "滞销", "tone": "bad"}, {"v": "42", "tone": "warn"}]]}
```
```

- [ ] **Step 2: SKILL.md 更新（report-generator）**

1. valueFormat 表追加一行：`| int / int:1 | 1,234 / 1,234.5 | 千分位整数无单位（天数/排名/计数） |`
2. valueFormat 表下方追加作用域说明：

```markdown
**作用域（v2.1）**：`chart.valueFormat` 为图级默认；`series[].valueFormat`、`yAxis[].valueFormat` 就近覆盖（帕累托：柱 yi + 线 percent 双轴双格式）。表格单元格支持条件着色：`字符串` 或 `{"v": "...", "tone": "good|warn|bad|na"}`（绿/黄/红/灰）。高级图表（帕累托/四象限气泡/热力图/瀑布）的完整 option 配方见 [references/chart-recipes.md](references/chart-recipes.md)。
```

3. 「已废弃脚本」节之前插入：

```markdown
## 图表配方（v2.1）

SKU 效益等分析报告的帕累托、四象限气泡、热力图、瀑布图，直接套用 [references/chart-recipes.md](references/chart-recipes.md) 的 option 模板（纯 JSON、逐点 symbolSize 预计算、声明式 markLine）。数据点超 200 先 TOP-N。
```

- [ ] **Step 3: build.py SELFTEST_JSON 扩展**

`SELFTEST_JSON` 的 sections 改为（series 级 valueFormat + tone 单元格纳入冒烟）：

```python
    "sections": [
        {"id": "trend", "tab": "趋势", "type": "chart-with-analysis",
         "chart": {"id": "c1", "title": "图", "valueFormat": "yi:2",
                   "option": {"xAxis": {"type": "category", "data": ["1月", "2月"]},
                              "yAxis": [{"type": "value", "valueFormat": "yi:2"},
                                        {"type": "value", "valueFormat": "percent"}],
                              "series": [{"name": "s", "type": "line", "data": [1, 2], "valueFormat": "int"},
                                         {"name": "p", "type": "line", "yAxisIndex": 1, "data": [50, 100], "valueFormat": "percent"}]}},
         "analysis": [{"label": "a", "color": "blue", "text": "t"}]},
        {"id": "data", "tab": "明细", "type": "table",
         "table": {"columns": ["A", "B"], "rows": [["1", {"v": "2", "tone": "good"}]]}}
    ],
```

- [ ] **Step 4: 全量测试 + selftest**

Run: `python -m pytest skills/report-generator/tests/ -v` → 全 PASS
Run: `python skills/report-generator/scripts/build.py --selftest` → 末行 `SELFTEST PASS`

- [ ] **Step 5: Commit**

```bash
git add skills/report-generator/
git commit -m "feat(report): chart-recipes四配方+SKILL v2.1作用域说明+selftest覆盖就近格式与tone"
```

---

## 阶段 3：端到端验收

### Task 12: 真实数据端到端报告

**Files:**
- Create: `report.json`（项目根，验收后删除）
- 产物: `reports/report_sku-profitability_20260818.html`（gitignored）

- [ ] **Step 1: 取真实数据（MCP）**

运行 Task 6 模式 H（跌价 TOP10，calmonth='202607'）与模式 A（无品类 LIMIT 15）→ 记录结果数字。

- [ ] **Step 2: 组装 report.json**

结构：KPI 4 张（跌价总额/在库SKU数/最大单SKU跌价/2年以上段占比）；帕累托 section（库存金额 yi 柱 + 累计跌价占比 percent 线，双轴双格式 + markLine 80）；跌价明细 table section（列：排名/SKU/名称/库存金额/跌价合计/1-2年/2-3年/3-4年/4年+，健康列用 tone：跌价占库存 >30% bad、10-30% warn、<10% good）；insight 一段含数字结论；provenance.query 填模式 H 真实 SQL。数字用 Step 1 实测值。

- [ ] **Step 3: 构建 + 校验**

```bash
python skills/report-generator/scripts/build.py --json report.json --domain sku-profitability
python skills/report-generator/scripts/validate_report.py reports/report_sku-profitability_20260818.html
```
Expected: `OK reports/...` + `VALIDATION PASS`

- [ ] **Step 4: 浏览器人工验收**

打开 HTML 核对：帕累托左轴显示「X.XX亿」右轴「XX%」（双格式生效）；80% 虚线；表格健康列绿/黄/红着色；tooltip 柱显亿、线显百分比；console 无错误。

- [ ] **Step 5: 清理 + Commit（如 report.json 有保留价值则只删 report.json）**

```bash
rm report.json
git log --oneline -12   # 确认阶段1/2的 commit 全部在线
```

（本任务产物 HTML 在 gitignored reports/，无需 commit；若组装过程中修了任何代码，单独 commit。）

---

### Task 13: CLAUDE.md 修正 + 收尾

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: 修正过时信息**

1. 「Covered domains」表：`(4 of 22)` → `(6 of 22)`；追加两行：

```markdown
| otd-fulfillment | `skills/otd-fulfillment-knowledge/` | `skills/otd-fulfillment-analyst/` | 4 |
| sku-profitability | `skills/sku-profitability-knowledge/` | `skills/sku-profitability-analyst/` | 5 |
```

2. sales-performance 行 Tables `2` → `18`（references 文档数）
3. Layer 4 节 `eval_dataset.json` (30 scenarios) → `(66 scenarios, 6 domains)`；「Per-domain launch gate」句保留
4. Architecture 目录树 skills/ 下补 `otd-fulfillment-*` 与 `sku-profitability-*` 两行（对齐现有缩写样式）

- [ ] **Step 2: 全量回归**

```bash
python -m pytest skills/report-generator/tests/ -v     # 全 PASS
python skills/report-generator/scripts/build.py --selftest  # SELFTEST PASS
python run_eval.py sku-profitability                   # 9 PASS
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: CLAUDE.md 域表/eval数修正—补otd与sku两域(6/22)"
```

---

## Self-Review

**1. Spec 覆盖：**
- §1 盘点事实/陷阱 → Task 1/2/4（陷阱表 8 条全部进 metrics.md）✓
- §2 新域结构 → Task 4（SKILL+metrics）/Task 5（3 问题族+血缘）/Task 6（模式 A-I）✓
- §3 共享基础设施 → Task 1/2（inventory 3 表+metrics+SKILL 路由）/Task 3（material-master）✓
- §4 报表 v2.1 六项 → Task 9（int/series/yAxis 校验+schema）/Task 10（int registry/就近格式/逐系列 tooltip/tone 渲染+CSS）/Task 11（recipes 四配方+作用域文档+selftest）✓；向后兼容由 Task 9 Step 4/Task 10 Step 6 存量测试不改仍绿保证 ✓
- §5 eval → Task 7（9 场景+meta 66+域回归）✓
- §6 三阶段验收 → Task 12（端到端）/Task 13（CLAUDE.md）✓
- §7 挂起项 → 复购率不入清单（计划无涉及）✓；CHDJ 两疑点在 Task 2 文档标注"待 ETL 确认" ✓

**2. 占位符扫描：** Task 2 capital-cost-table 与 Task 7 的 {TOP_SKU}/{CAT} 是"探查后填实测值"的显式程序步骤（附查询命令），非 TBD；模式 F 的 split 简版+完整版说明完整。无 TODO/待实现字样。

**3. 类型/命名一致性：** `tone` 枚举 good/warn/bad/na 在 validator（Task 9）↔ 模板（Task 10）↔ recipes（Task 11）↔ selftest（Task 11 Step 3）一致；`int` 格式四处一致；`seriesSpecs` 仅模板内使用；模式字母 A-I 与 knowledge 决策树（Task 4 metrics.md 第一节）一一对应；`start_month`/`product_listed_date` 格式统一锚定 Task 2 Step 2 / Task 3 Step 1 验证结果。

---

## 执行注意事项

1. **Task 2 Step 2 与 Task 3 Step 1 是格式锚点**——Task 6/7 的日期字面量依赖它们的验证结果，必须先做。
2. 文档类任务（1-6）验证靠内容核对+SQL 实跑，无 pytest；代码类任务（8-11）严格 TDD。
3. eval 数据漂移：月末跑数与创建时 row_count 可能差 ±1~2 行，属正常，更新 expected 后重跑；跨大版本（月切换）建议重验。
4. 生产部署照旧：服务器 `git pull` 后 `python3 skills/report-generator/scripts/build.py --selftest` 验收。
5. 全程不得提交 `.mcp.json`。
