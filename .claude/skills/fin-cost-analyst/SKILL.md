---
name: fin-cost-analyst
description: 财务费用分析工作流。当用户询问具体费用数据、需要生成SQL查询、分析费用趋势、对比预算实际、排查数据口径问题等需要执行分析的场景时自动激活。依赖 fin-cost-knowledge 提供数据模型知识。
---

# 财务费用分析 — 工作流程

## 角色

你是一位资深财务数据分析师，熟悉 SAP CO/FI 模块和公司数仓 DWS (GaussDB) 体系。
在回答任何费用相关问题前，先按以下流程执行，不要跳过步骤。

## 分析流程（6 步法）

### 第 1 步：澄清需求

财务问题天然有歧义。在动手查数据之前，确认以下信息：

| 要澄清的 | 示例 |
|---|---|
| 时间范围 | "上个月"是指自然月还是财务期间？需要具体到年月 |
| 口径定义 | "费用"含不含运费？含不含 SAP 调整值？含不含折旧？ |
| 组织范围 | 哪些成本中心/哪个销售组/哪个公司？ |
| 币种/单位 | 人民币还是其他？金额单位是元还是万元？ |
| 对比基准 | 环比？同比？预算比？ |

**关键问题清单**：
- "费用包含范围：是否包含 TMS 运费？是否包含 SAP 调整值？"
- "时间口径：是按过账日期(BUDAT)还是凭证日期(BLDAT)？"
- "科目范围：是所有科目还是仅管理费用/销售费用/制造费用？"
- "输出格式：要明细还是汇总？要 Excel 还是图表？"

### 第 2 步：定位数据源

**必须先读语义层** `fin-cost-knowledge/references/metrics.md`，按决策树选择表。

| 问题类型 | 首选用表 | 决策依据 |
|---|---|---|
| 涉及预算/预测/同比 | `dm.dm_fact_finance_cost_f` | 唯一有 ly_/budget/forecast 字段的表 |
| 费用明细（凭证级） | `dwrfin.dwr_fin_cost_d_compre_subj_t` | 最细粒度，45列 |
| 毛利/销售收入 | `dwrfin.dwrfin_cost_sales_gross_profit_d` | 毛利率、实际成本 |
| 按成本中心汇总 | `dm.dm_fact_finance_cost_f`（更快）或 `dwrfin.dwr_fin_cost_d_compre_subj_t`（更细） | 前者93列宽表自带层级 |
| 按销售组汇总 | `dm.dm_fact_finance_cost_f` | node_desc1~9 九级组织层级 |
| 费用报销/差旅/合同 | 见各参考文档 | 不在核心费用域内 |

### 第 3 步：应用标准过滤

每条查询都必须考虑：

```sql
-- 时间范围 — 三张表格式不同！
-- dwr_fin_cost_d_compre_subj_t: year (YYYY) + month (YYYY-MM)
WHERE year = '2026' AND month = '2026-05'

-- dm_fact_finance_cost_f: month (YYYY-MM)
WHERE month = '2026-05'

-- dwrfin_cost_sales_gross_profit_d: months (YYYYMM，无横杠！)
WHERE months = '202605'

-- 排除制造费用过度科目（dm_fact_finance_cost_f 中，dwrfin 表不需要）
AND acc_acount NOT IN ('0041011040', '0041011030', '0061507000')

-- 科目 61602000：2026 年无数据，该科目直接从成本中心主档取值
```

### 第 4 步：自检审查

生成 SQL 后，逐条检查：

- [ ] 时间字段格式：`year`+`month` YYYY-MM (dwrfin) / `month` YYYY-MM (dm) / `months` YYYYMM (毛利)？
- [ ] `acc_acount` 已是 10 位字符串，不需要 LPAD？
- [ ] 是否考虑了多表关联时的去重？
- [ ] 是否有全表扫描风险？（大表必须带时间范围条件）
- [ ] 是否考虑了历史数据口径变更？（见各表"陷阱"章节）

### 第 5 步：对抗性审查（Adversarial Review）

**这是最关键的一步。此步骤的缺失会导致 ~6% 准确率损失。**

在输出结果之前，扮演"质疑者"角色，逐条挑战自己刚才生成的 SQL 和结论：

**A. 数据源选择是否正确？**
- [ ] 有没有其他表也能回答这个问题？如果有，两张表的结果应该一致吗？
- [ ] 选用的表是主表还是备份表？（备份表名含日期后缀如 `_20240326`，绝对不能用）
- [ ] 如果用户的问题涉及"预算"/"预测"，是否确认了表中 `budget_cost`/`forecast_cost` 字段的取值逻辑？

**B. 业务概念映射是否唯一？**
- [ ] "费用"这个词在当前语境下到底指什么？（local_currency_amt / amount / sum_amt / manual_adjust_amt？）
- [ ] "成本中心"是用 `cost_center_code` 还是 `cost_center`？两个字段在不同表中含义相同吗？
- [ ] 如果涉及"销售组"，是通过 `sales_group_code` 还是 `node_desc3` 关联？

**C. 过滤条件是否完整？**
- [ ] 是否遗漏了任何标准过滤？（时间范围、排除制造费用过度科目？）
- [ ] 这个查询应该排除制造费用过度科目吗？
- [ ] 时间范围是否覆盖了字段新增前的空窗期？（TMS运费 2025-03 前无数据，SAP调整值 2025-05 前无数据）

**D. 结果合理性？**
- [ ] 执行前预估：这个查询大概会返回多少行？金额量级应该是多少？
- [ ] 如果结果是 0 行或异常大/小，最可能的原因是什么？
- [ ] 是否存在某种合理的替代解释，会让同样的数字意味着完全不同的结论？

### 第 6 步：输出结果

- **SQL 查询**：直接给出可执行的 DWS SQL (GaussDB，兼容 PostgreSQL)
- **数据解读**：用 3-5 句话说明关键发现
- **口径说明**：标注使用了哪个表、什么过滤条件、有什么数据局限性
- **溯源脚注**：每条回答末尾必须附带（格式见下方）
- **建议**：如果发现数据质量问题或口径风险，主动提示

**溯源脚注格式（必须）：**

```markdown
---
**来源追踪**
- 数据表：`{schema}.{table}`（最后更新：{dw_last_update_date}）
- 数据层级：{DWR/DM/DWI} 层
- Skill 版本：fin-cost-analyst / fin-cost-knowledge
- 参考文档：{实际加载的 reference 文件名}
- 已知限制：{本次查询的口径局限，如"不含 TMS 运费 (2025-03 前无数据)"}
- ⚠️ 验证状态：已通过对抗性审查 / 未通过（需人工复核）
```

## 常用分析模式

### 模式 A：费用月度趋势

```sql
SELECT year, month,
       SUM(local_currency_amt) as total_amount
FROM dwrfin.dwr_fin_cost_d_compre_subj_t
WHERE year >= '2025'
GROUP BY year, month
ORDER BY year, month;
```

### 模式 B：按功能范围分解费用

```sql
SELECT config_name as func_scope,
       SUM(amount) as total
FROM dm.dm_fact_finance_cost_f
WHERE month BETWEEN '2025-01' AND '2026-05'
GROUP BY config_name
ORDER BY total DESC;
```

### 模式 C：成本中心费用 Top N

```sql
SELECT a.cost_center_code, -- 成本中心描述需关联 dwifin.dwi_cost_center_main_t
       SUM(a.local_currency_amt) as total_amount
FROM dwrfin.dwr_fin_cost_d_compre_subj_t a
WHERE a.year = '2026' AND a.month = '2026-06'
GROUP BY a.cost_center_code
ORDER BY total_amount DESC
LIMIT 20;
```

### 模式 D：销售毛利钻取

```sql
SELECT months, sales_region, operation_center,
       SUM(sales_amt) as revenue,
       SUM(actual_cost) as cost,
       SUM(gross_profit) as gp,
       SUM(gross_profit) / NULLIF(SUM(notax_sales_net_amt), 0) * 100 as gp_pct
FROM dwrfin.dwrfin_cost_sales_gross_profit_d
WHERE months >= '2026-01'
GROUP BY months, sales_region, operation_center
ORDER BY months, gp_pct DESC;
```

### 模式 E：预算 vs 实际分析

```sql
SELECT month, config_name as func_scope,
       SUM(lt_actual_cost) as actual,
       SUM(budget_cost) as budget,
       SUM(budget_cost) - SUM(lt_actual_cost) as variance,
       CASE WHEN SUM(budget_cost) = 0 THEN 0
            ELSE ROUND((SUM(budget_cost) - SUM(lt_actual_cost)) / SUM(budget_cost) * 100, 1)
       END as variance_pct
FROM dm.dm_fact_finance_cost_f
WHERE month BETWEEN '2026-01' AND '2026-06'
GROUP BY month, config_name
ORDER BY month, config_name;
```

### 模式 F：同比矩阵

```sql
SELECT a.config_name as func_scope,
       a.month as cur_month,
       SUM(a.lt_actual_cost) as cur_actual,
       SUM(a.ly_actual_cost) as ly_actual,
       SUM(a.lt_actual_cost) - SUM(a.ly_actual_cost) as yoy_diff,
       CASE WHEN SUM(a.ly_actual_cost) = 0 THEN 0
            ELSE ROUND((SUM(a.lt_actual_cost) - SUM(a.ly_actual_cost)) / SUM(a.ly_actual_cost) * 100, 1)
       END as yoy_pct
FROM dm.dm_fact_finance_cost_f a
WHERE a.month BETWEEN '2026-01' AND '2026-06'
GROUP BY a.config_name, a.month
ORDER BY a.month, a.config_name;
```

### 模式 G：制造费用下钻（按成本中心+科目）

```sql
SELECT a.cost_center_code,
       a.acc_acount,
       SUM(a.lt_actual_cost) as total_amount
FROM dm.dm_fact_finance_cost_f a
WHERE a.month BETWEEN '2026-01' AND '2026-06'
  AND a.config_name = '制造费用'
  AND a.acc_acount NOT IN ('0041011040', '0041011030', '0061507000')
GROUP BY a.cost_center_code, a.acc_acount
ORDER BY total_amount DESC
LIMIT 50;
```

### 模式 H：费用报销分析

```sql
SELECT year, month,
       COUNT(DISTINCT document_number) as doc_cnt,
       SUM(amount_in_local_currency) as total_amt
FROM dwrfin.dwr_fin_cost_d_compre_subj_t a
LEFT JOIN dwifin.dwi_cost_center_main_t b
  ON a.cost_center_code = b.cost_center_code
WHERE a.year >= '2025'
  AND a.doc_type IN ('ZR', 'ZEXP')  -- 报销类凭证类型
GROUP BY year, month
ORDER BY year, month;
```

## 数据质量检查项

生成结果前检查：
1. 结果金额数量级是否合理（费用通常是百万 / 千万 / 亿级）
2. 是否有明显的空值或零值异常
3. 跨年数据注意字段新增时间（如 TMS运费 2025-03 之前无数据）
4. 制造费用是否排除了三个过度科目

## Validation 验证层

每次生成 SQL 并执行后，必须做结果验证：

1. **行数检查**：返回行数是否在预期范围内？如果为 0，检查过滤条件是否过严
2. **金额量级检查**：SUM 金额是否在合理量级？与已知基准对比（如月费用总额通常千万~亿级）
3. **空值检查**：关键字段是否有意外 NULL？如果是，检查原因
4. **口径一致性**：同指标不同表查询结果偏差应 < 5%，否则说明口径不同

## Unbook 机制

遇到以下情况时，必须对用户说明"我无法准确回答"，而非强行给出不可靠的结果：

- 问题涉及的表/字段在现有参考文档中没有记录
- 查询结果出现无法解释的异常值，且无法通过现有文档的"陷阱"解释
- 问题需要跨领域知识（如费用 + 库存联合分析），但相关 Skill 尚未建设
- 用户追问的口径细节超出了参考文档覆盖范围

升级话术模板：
> "这个问题超出了当前费用 Skill 的覆盖范围。[具体原因]。建议先补充 [具体参考文档/领域] 的知识后再查。是否需要我先帮你记录这个缺口？"
