# SKU 效益分析专题域 + 报表协议 v2.1 — 设计文档

**日期**：2026-08-18
**状态**：已与用户逐节确认
**业务材料**：`SKU效益分析问答及报告.xlsx`（仓库根目录，Sheet1 问答及展示框架 9 问、Sheet2 各类报表建议 4 表）

---

## 0. 背景与目标

业务给出 SKU 效益分析的 9 个问答场景与 4 张报表模板，要求问数系统能回答并出报告。本设计落地两件事：

1. **新建 `sku-profitability` 专题域**（knowledge + analyst 配对），接住跨销售×库存×成本的完整 SKU 问题
2. **report-generator 协议升级 v2.1**，支持业务点名的图表（帕累托/四象限气泡/热力图/瀑布）与表格条件着色

**域边界说明**：SKU 效益是业务分析主题而非物理 schema 域。"这个 SKU 该不该清仓"一张 SQL 要横跨 Mix 表（销售/毛利）+ 出入库月表（动销）+ 上市口径跌价表 + CHDJ 资金成本表 + 物料主数据（新品标识），任何单一现有域只能答半截，故建专题域（用户已选方案 A）。

---

## 1. 数据盘点结论（2026-08-18 实库验证）

### 1.1 九问可行性总表

| # | 业务问题 | 结论 | 数据来源 |
|---|---------|------|---------|
| 1 | 销售规模/帕累托 | ✅ | Mix 表 material 级（6,232 SKU）+ 物料主数据品类 |
| 2 | 销售趋势（月） | ✅ | Mix 表 calmonth；同比/环比模式已有 |
| 3 | 毛利贡献/四象限 | ✅ | Mix 表 gross_profit_after_sharing / act_cost_sum_amt |
| 4 | 库存周转 | ✅ | 月末库存（上市口径表/出入库表）÷ 月均出库 |
| 5 | 滞销/缺货 | ✅（月粒度口径） | 出入库月表判动销；月末快照判缺货；未交付订单补充 |
| 6 | 新品增量 | ✅ | 物料主数据 product_listed_date + new_product_code |
| 7 | 渠道/区域差异 | ✅ | Mix 表 channel + node_desc1~9 |
| 8 | 处置建议评分 | ✅ | 依赖 1-5+9 指标 + 业务加权公式 |
| 9 | 库存跌价 | ✅ | 上市口径表（计提比例内嵌） |

### 1.2 关键实证（写进 metrics.md 的事实）

- **跌价表**（`dm.dm_fin_stock_d_accage_list_c_t_2023`，上市口径）：批次级，600万行/月，6.4万 SKU，calmonth=YYYYMM，新鲜到 202608。跌价字段内嵌会计政策比例：`aging_1_year_fall_amt`（1年内 **0%**）、`aging_1_2_year_fall_amt`（**20%**）、`aging_2_3_year_fall_amt`（**30%**）、`aging_3_4_year_fall_amt`（**50%**）、`aging_4_year_fall_amt`（4年+ **50%**）、`aging_sum_fall_amt`（合计，202608 全集团 1.43亿）。另有天级库龄细分（0-30/31-60/…/1441+天，金额/数量/面积三套）、`zisqc` 是否清仓、doc_number/s_ord_item 销售凭证。
- **CHDJ 表**（`dm.dm_ambv2_chdj_grp_t`，阿米巴口径）：stat_month=**YYYY-MM**（日期格式不同！），28万行/月，3.5万 SKU，inventory_value 存货价值 + capital_cost 资金成本。
- **业务裁定：月粒度原则**——缺货率/动销率最小按月看，库存取月末/最新快照即可，不需要日级（业务确认 2026-08-18）。
- **全成本到 SKU 不可行**（2026-06 凭证 270万行实证）：销售侧费用科目不挂物料（广告/促销/售后 **0%**、仓储 0.5%），平台佣金科目在 B2B 不存在。SKU 级净利润/ROI 不可算，**替代口径「效益利润」**：`gross_profit_after_sharing − aging_sum_fall_amt − capital_cost`（分摊后毛利 − 跌价 − 资金成本）。
- **复购率：挂起**（业务口径未定，按用户指示暂从指标清单剔除）。

### 1.3 陷阱表（metrics.md 必收）

1. 三套库存金额口径差 2 倍+：上市口径 14.3亿 / 阿米巴 6.35亿 / dm_own_inventory_t 1.88亿（202608 同月）。**决策规则：问跌价/库龄→上市口径表；问阿米巴分摊/资金成本→CHDJ 表**。
2. 跌价只有「年」分段（1年内/1-2/2-3/3-4/4年+），业务 Excel 用「半年」分段；天级细分可聚出半年口径**金额**，但**跌价金额只有年口径**。回答时透明声明。
3. 日期格式三态：上市口径 `calmonth='202608'`（YYYYMM）、CHDJ `stat_month='2026-08'`（YYYY-MM）、dm_own 中文字段。
4. 空串陷阱：`TRIM(col)<>''` 与 `LENGTH(TRIM(col))>0` 在 GaussDB 上行为不一致（实证：前者 0 行、后者 173万行），判空一律用 LENGTH。
5. SKU 范围口径差：Mix 表 6,232 SKU（在售）vs 上市口径表 64,605 SKU（在库，含停产/在产），跨表 JOIN 前必须声明对齐口径。
6. 动销/缺货为月粒度口径（业务裁定），「有销量天数」退化为「有销量月份数」。

---

## 2. 新域结构（sku-profitability）

```
skills/sku-profitability-knowledge/
├── SKILL.md                    # 路由：SKU/单品/清仓/淘汰/滞销/动销/跌价/效益/新品蚕食 关键词
└── references/
    ├── metrics.md              # 🔴 强制首读语义层
    ├── sales-side-patterns.md      # 问题1/2/3/7：Mix 表 SKU 级（帕累托/趋势/毛利/渠道）
    ├── inventory-side-patterns.md  # 问题4/5/9：动销/周转/滞销/缺货/跌价
    ├── newproduct-decision-patterns.md  # 问题6/8：新品增量/综合评分/处置
    └── data-lineage.md

skills/sku-profitability-analyst/
└── SKILL.md                    # 6步工作流+对抗审查（复用现有域骨架）+ 模式 A-I
```

约定：SQL 模式放 analyst SKILL.md（同 sales-performance 模式 A-K 惯例）；knowledge 的问题族文档只写**口径与表组合**（指标定义、用哪张表、对齐规则、陷阱），可执行 SQL 一律在 analyst 侧，不重复；**表级文档不复制**，跨链接到 inventory / sales-performance 域 references。

### 2.1 metrics.md 内容清单

1. 九问决策树：问题类型 → 主表组合 → 模式编号
2. 效益利润口径及构成声明（含"营销/售后不可分摊"的透明度声明）
3. 综合评分公式：销售收入×25% + 毛利×30% + 动销率×20% + 库存金额×15% + 库存周转×10%；决策阈值 ≥80 加大投入 / 60-79 保留优化 / 40-59 调价降本 / 周转超标且销售下降 降库存 / 净利为负且战略价值低 清仓淘汰（业务 Sheet2 原文；"净利为负"落地为"效益利润为负"）
4. 陷阱表（§1.3 全部 6 条）

### 2.2 analyst 模式 A-I

| 模式 | 问题 | 核心表 |
|---|---|---|
| A | SKU 销售规模/帕累托（累计占比窗口+RANK） | Mix |
| B | SKU 趋势/同比/环比 | Mix |
| C | SKU 毛利贡献/四象限数据 | Mix |
| D | 库存周转/可售天数 | 上市口径表+出入库月表 |
| E | 动销/滞销/缺货（月粒度） | 出入库月表+上市口径表+otd 未交付 |
| F | 新品增量/蚕食（品类基准对比） | 物料主数据+Mix |
| G | 渠道/区域 × SKU 透视 | Mix |
| H | 库存跌价分段/TOP N | 上市口径表 |
| I | 综合评分/处置建议（跨表汇总+阈值映射） | A-H 输出 |

---

## 3. 共享基础设施改动

| 文件 | 动作 | 内容 |
|---|---|---|
| `skills/inventory-knowledge/references/stock-fall-list.md` | 新建 | 上市口径跌价表：批次级粒度、计提比例字段表、天级细分、zisqc、大表时间过滤警告 |
| `skills/inventory-knowledge/references/chdj-capital-cost.md` | 新建 | CHDJ 表：YYYY-MM 日期陷阱、两疑点标注待 ETL 确认（inventory_value 是否已扣跌价、capital_cost 负值语义） |
| `skills/inventory-knowledge/references/capital-cost-table.md` | 新建 | DM_FIN_STOCK_CAPITAL_COST_T（实施时 describe + 对照 huaweiclaude ETL 脚本后成文） |
| `skills/inventory-knowledge/references/metrics.md` | 修改 | 增补跌价/资金成本概念段 |
| `skills/inventory-knowledge/SKILL.md` | 修改 | 3 张新表路由行 |
| `sources-of-truth/business-context/material-master.md` | 修改 | 增补 product_listed_date / new_product_code 字段说明 |

`dm_own_inventory_t` 未获业务确认，不入文档。

---

## 4. report-generator 协议 v2.1

**原则：向后兼容**（v2 报告零修改仍通过校验），维持生产约束：纯标准库、Python 3.9+、零硬编码路径、`--selftest` 验收。

### 4.1 六项扩展

| # | 扩展 | 协议变化 | 模板实现 |
|---|---|---|---|
| 1 | 帕累托双格式 | `valueFormat` 新增作用域：series 级、yAxis 级（chart 级仍为默认值，就近覆盖） | formatFactory 按 series.valueFormat ‖ chart.valueFormat 取格式；tooltip 逐系列取各自格式 |
| 2 | 四象限气泡 | data item 允许逐点 `symbolSize`（分析师预计算，√面积归一 8~60px）；markLine 声明式（`{xAxis:v}`/`{yAxis:v}`）本就放行 | 无代码改动，recipe 给归一化指引 |
| 3 | 热力图 | heatmap 系列 + visualMap 纯 JSON 直通 | 无代码改动，recipe 给 TOP-N 裁剪指引 |
| 4 | 瀑布图 | 堆叠柱 + 透明基座系列（`itemStyle.color:'rgba(0,0,0,0)'`） | 无代码改动，recipe 文档 |
| 5 | 表格着色 | 表格单元格 `string` 或 `{v:"文本", tone}`，tone ∈ `good/warn/bad/na`（绿/黄/红/灰，对应业务 Sheet2 条件格式要求） | renderTable 识别对象单元格 + tone CSS class；纯字符串渲染不变 |
| 6 | `int` 格式 | FORMAT_REGISTRY +1：千分位整数无单位，默认 0 位（周转天数/排名/SKU 数） | registry/默认小数表各 +1 行 |

### 4.2 文件改动清单

| 文件 | 动作 |
|---|---|
| `skills/report-generator/references/report-schema.json` | chart.valueFormat 作用域扩展、series/yAxis 定义、table cell oneOf(string/{v,tone}) |
| `skills/report-generator/scripts/validate_report.py` | series/yAxis 级 valueFormat 校验、tone 枚举校验、int 格式放行 |
| `skills/report-generator/templates/report-shell.html` | formatFactory 就近取格式 + 逐系列 tooltip、tone CSS 与渲染 |
| `skills/report-generator/references/chart-recipes.md` | 新建：帕累托/四象限/热力图/瀑布四套 option 模板 + 数据点预算（沿用单图 ≤200 点，recipe 指引 TOP-N 裁剪） |
| `skills/report-generator/SKILL.md` | v2.1 变更说明 + recipes 引用 + tone 表 |
| `skills/report-generator/tests/` | 新增：per-series valueFormat 正/负、tone 正/负、int 格式、声明式 scatter 通过/函数串仍拒、帕累托+着色表端到端 build |

### 4.3 不变项

单 chart 数据点 ≤200 上限、`function(`/`eval(` 黑名单、占位符/大小/__REPORT_VALID__ 校验、build.py 流程（validator 前置强制）全部维持。

---

## 5. Eval 计划

`eval_dataset.json` 新增 domain `sku-profitability`，9 场景（九问各一，覆盖模式 A-I），golden SQL 以本设计盘点中验证过的查询为基线，meta.total 57→66。运行 `python run_eval.py sku-profitability` 全 PASS 为数据层验收线。

---

## 6. 交付阶段与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| 1 数据层 | inventory 补表 3 张 → material-master 增补 → 新域 knowledge+analyst → eval 9 场景 | `run_eval.py sku-profitability` 全 PASS；存量域 eval 不回归 |
| 2 报表层 | 协议 v2.1（schema→validator→模板→tests→SKILL.md→recipes） | pytest 全绿；`--selftest` PASS；现有 v2 样例报告复验通过（兼容性） |
| 3 端到端 | 真实数据走「跌价 TOP10 + 帕累托」→ 分析 → HTML 报告；CLAUDE.md 修正（补 otd-fulfillment 与 sku-profitability 两域、表数/eval 数过时值） | 浏览器验收图表（双轴格式/着色/气泡）；CLAUDE.md 与实际一致 |

---

## 7. 挂起项与风险

| 项 | 状态 | 处置 |
|---|---|---|
| 复购率口径 | 挂起（业务未定） | 指标清单剔除；业务要再加 |
| CHDJ inventory_value 是否已扣跌价、capital_cost 负值语义 | 待 ETL 确认 | 实施时对照 huaweiclaude ETL 脚本；确认前 metrics.md 标"口径待确认" |
| DM_FIN_STOCK_CAPITAL_COST_T 结构未知 | 未探查 | 实施时 describe + ETL 成文 |
| Mix 6,232 SKU vs 上市口径 64,605 SKU 对齐 | 口径差大 | 陷阱#5 已列；模式 I 评分时以 Mix 在售为主集、库存表 LEFT JOIN |
| 本地 `.mcp.json` Windows 改动 | 禁止提交 | 维持现状 |
