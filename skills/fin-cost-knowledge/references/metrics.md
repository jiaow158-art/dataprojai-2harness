---
name: fin-cost-metrics
description: 财务费用域语义层 — 编译后的指标定义、概念映射、维度值。Agent 必须优先查阅此文件再决定用哪张表。
---

# 财务费用域 — 语义层 (Semantic Layer)

## 使用规则（强制）

1. 收到任何费用相关问题，**必须先读本文件**，再做后续判断
2. 本文件定义的概念→字段映射是权威的，不可自行猜测
3. 每张表的选择必须经过本文件的决策树

---

## 一、核心概念 → DWS 字段映射

### 1.1 "费用"到底指什么？

| 业务口径 | DWS 字段 | 所属表 | 说明 |
|----------|----------|--------|------|
| 本位币金额（最常用） | `local_currency_amt` | dwr_fin_cost_d_compre_subj_t | SAP 记账的本位币金额，日常"费用"默认指这个 |
| 金额（报表口径） | `amount` | dm_fact_finance_cost_f | 整合后的报表金额，已做调整 |
| 手工调整金额 | `manual_adjust_amt` | 两张表均有 | SAP 调整值，2025-05-07 新增 |
| 合计金额 | `sum_amt` | 两张表均有 | 本位币+调整后的合计 |
| 预算成本 | `budget_cost` | dm_fact_finance_cost_f | 预算数据 |
| 预测成本 | `forecast_cost` | dm_fact_finance_cost_f | 预测数据 |
| 期间费用 | `period_expense` | dm_fact_finance_cost_f | 期间费用口径 |
| 运营费用 | `operating_expense` | dm_fact_finance_cost_f | 运营费用口径 |
| 预提金额 | `accrual_amount` | dm_fact_finance_cost_f | 已预提未实际发生 |
| 冲销金额 | `reversal_amount` | dm_fact_finance_cost_f | 已冲销 |

**歧义陷阱**：用户说"费用"时，默认指 `local_currency_amt`（dwrfin表）或 `amount`（dm表）。如果用户加了限定词（"预算"/"预测"/"调整后"），切换到对应字段。

### 1.2 组织维度

| 业务概念 | dwr_fin_cost_d_compre_subj_t | dm_fact_finance_cost_f | 备注 |
|----------|------------------------------|------------------------|------|
| 成本中心编码 | `cost_center_code` | `cost_center` | 两张表字段名不同 |
| 成本中心描述 | `cost_center_desc` | `cost_center_describe` | dm 表用 describe 不是 desc |
| 公司 | `comp_code` / `comp_desc` | `comp_code` / `comp_desc` | 相同 |
| 销售组 | `sales_group_code` / `sales_group_desc` | `sales_grp_code` + `node_desc1~9` | dm 表有 9 级销售组织层级 |
| 利润中心 | `profit_center_code` / `profit_center_desc` | 无 | 仅 dwrfin 表有 |
| WBS | `wbs` / `wbs_desc` | `wbs_top_level` / `wbs_top_level_desc` | dwrfin 有明细级 WBS，dm 只有顶层 |

### 1.3 科目维度

| 业务概念 | dwr_fin_cost_d_compre_subj_t | dm_fact_finance_cost_f | 备注 |
|----------|------------------------------|------------------------|------|
| 科目编码 | `general_ledger_account` | `acc_acount` | dm 表已是 10 位 LPAD 格式 |
| 科目描述 | `general_ledger_account_desc` | `gl_account_desc` | |
| 功能范围编码 | `func_scope_code` | `functional_scope` | |
| 功能范围名称 | `func_scope_name` | `config_name` | |

---

## 二、功能范围编码表（权威枚举值）

| 编码 | 名称 | 说明 | 2026-05 金额 |
|------|------|------|-------------|
| 4105 | 制造费用 | 生产制造相关费用 | 1.98亿 |
| 4101 | 生产成本 | 直接生产成本 | 1.13亿 |
| 5501 | 营业费用 | 销售相关费用 | 0.45亿 |
| 5502 | 管理费用 | 行政管理费用 | 0.26亿 |
| 4110 | 研发支出 | 研发相关 | 0.18亿 |
| 5504 | 物流费用 | 物流相关（dm口径） | 0.13亿 |
| 1010 | 物流成本 | 物流成本（另一口径） | 0.12亿 |
| 5503 | 财务费用 | 财务/资金成本 | 83万 |

**注意**：物流有两个编码（5504/1010），口径不同。用户说"物流费"时需确认用哪个。

---

## 三、表选择决策树

```
用户问题
├── 涉及"预算"或"预测"或"同比"？
│   └── 用 dm.dm_fact_finance_cost_f（唯一有 ly_/budget/forecast 字段的表）
├── 需要费用明细（到凭证级）？
│   └── 用 dwrfin.dwr_fin_cost_d_compre_subj_t（45列，最细粒度）
├── 涉及"毛利"或"销售收入"？
│   └── 用 dwrfin.dwrfin_cost_sales_gross_profit_d
├── 需要成本中心15级组织层级？
│   └── 用 dm.dm_fact_finance_cost_f（cost_center_code_1~15）
├── 需要按功能范围汇总 + 简单维度？
│   └── 首选 dm.dm_fact_finance_cost_f（查询更快，93列宽表）
├── 需要 WBS/利润中心/供应商/客户维度？
│   └── 用 dwrfin.dwr_fin_cost_d_compre_subj_t（只有它有这些字段）
└── 不确定？
    └── 默认用 dm.dm_fact_finance_cost_f（报表口径，整合后更容易理解）
```

---

## 四、三张核心表速查

### 4.1 dwr_fin_cost_d_compre_subj_t — 费用明细

| 属性 | 值 |
|------|-----|
| Schema | dwrfin |
| 粒度 | 凭证行项目 |
| 列数 | 45 |
| 时间范围 | 2020-01 ~ 2026-06 |
| 时间字段 | `year` (YYYY) + `month` (YYYY-MM) |
| 金额字段 | `local_currency_amt`（默认）、`sum_amt`、`manual_adjust_amt`、`origin_currency_amt` |
| 关键维度 | cost_center_code, general_ledger_account, func_scope_code, wbs, profit_center_code, material_code, cust_code, supplier_code, sales_group_code |
| 陷阱 | `month` 格式为 YYYY-MM 不是 MM；无同比/预算字段；无 del_flag 过滤；cost_center_code 大量 NULL |

### 4.2 dm_fact_finance_cost_f — 费用宽表

| 属性 | 值 |
|------|-----|
| Schema | dm |
| 粒度 | 月份 + 成本中心 + 科目 + 销售组 |
| 列数 | 93 |
| 时间范围 | 2021-01 ~ 2027-12（含预测期） |
| 时间字段 | `month` (YYYY-MM) |
| 金额字段 | `amount`（默认实际）、`budget_cost`、`forecast_cost`、`period_expense`、`operating_expense` |
| 同比字段 | `ly_amount`、`ly_period_expense` 等（ly_ = last year） |
| 预算/预测 | `period_expense_ys`/`_yc`、`operating_expense_ys`/`_yc`（_ys=预算, _yc=预测） |
| 关键维度 | cost_center + 15级层级、sales_grp_code + node_desc1~9、functional_scope + config_name、expense_type_name |
| 陷阱 | 2027年数据是预测；acc_acount 已是 10 位 LPAD 格式无需再 LPAD；制造费用过度科目 2026/03/16 后已自动排除 |

### 4.3 dwrfin_cost_sales_gross_profit_d — 销售毛利

| 属性 | 值 |
|------|-----|
| Schema | dwrfin |
| 粒度 | 天+销售区域+运营中心+产品层次+渠道+工厂 |
| 列数 | ~50 |
| 时间范围 | 202201 ~ 202606 |
| 时间字段 | `months` (YYYYMM，无横杠) |
| 关键维度 | sales_region, operation_center, prod_hierarchys, integration_channel, factory_80_flag |
| 预算字段 | budget_amt, budget_gross_profit, budget_gross_margin 等 |
| 实际字段 | sales_amt, actual_cost, gross_profit, notax_sales_net_amt |
| 同比字段 | last_year_sales_amt, last_year_gross_profit 等 |
| 陷阱 | months 格式为 YYYYMM（无横杠）！gross_margin 是计算字段非直接 SUM；该表按月份 DELETE+INSERT 覆盖更新 |

---

## 五、标准指标公式

### 费用类

| 指标 | 公式 | 适用表 |
|------|------|--------|
| 费用总额 | `SUM(local_currency_amt)` 或 `SUM(amount)` | dwrfin / dm |
| 费用同比变化率 | `(SUM(amount) - SUM(ly_amount)) / SUM(ly_amount) * 100` | dm |
| 预算执行率 | `SUM(amount) / SUM(budget_cost) * 100` | dm |
| 预算偏差 | `SUM(amount) - SUM(budget_cost)` | dm |
| 费用占比（某功能范围/总额） | `SUM(CASE WHEN functional_scope='4105' THEN amount END) / SUM(amount) * 100` | dm |

### 毛利类

| 指标 | 公式 | 适用表 |
|------|------|--------|
| 毛利额 | `SUM(gross_profit)` | dwrfin |
| 毛利率 | `SUM(gross_profit) / NULLIF(SUM(notax_sales_net_amt), 0) * 100` | dwrfin |
| 预算毛利达成率 | `SUM(gross_profit) / NULLIF(SUM(budget_gross_profit), 0) * 100` | dwrfin |
| 销售净额（管理口径） | `SUM(notax_sales_net_amt)` | dwrfin |
| 实际成本 | `SUM(actual_cost)` | dwrfin |

---

## 六、标准过滤条件

```sql
-- dwr_fin_cost_d_compre_subj_t: 无 MANDT/KOKRS/SPRAS 过滤
-- 必须带时间范围
WHERE year = '2026' AND month = '2026-05'

-- dm_fact_finance_cost_f
WHERE month = '2026-05'

-- 制造费用查询必须排除三个过度科目（仅 dm 表需要，dwrfin 表未排除）
AND acc_acount NOT IN ('0041011040', '0041011030', '0061507000')

-- dwrfin_cost_sales_gross_profit_d
WHERE months = '202605'  -- YYYYMM 格式，无横杠！

-- 排除未来预测数据（dm 表）
AND month <= '2026-06'  -- 当前月
```

---

## 七、已知陷阱总览

1. **month 格式不一致**：dwrfin 表 `month = '2026-05'` (YYYY-MM)，dm 表 `month = '2026-05'` (YYYY-MM)，毛利表 `months = '202605'` (YYYYMM)
2. **科目 61602000**：数据直接从成本中心主档取值，2026 年无数据。该科目查询用 `general_ledger_account = '61602000'` 即可，但预期为空。
3. **制造费用过度科目**：`0041011040`、`0041011030`、`0061507000` 在 dm 表中 2026/03/16 后自动排除，但 dwrfin 表中仍存在
4. **TMS 运费**：2025-03 之前无数据
5. **SAP 调整值**：2025-05 之前 `manual_adjust_amt` 为空
6. **dwrfin 表 cost_center_code 大量 NULL**：聚合时注意
7. **dm 表 2027 年数据**：是预测/预算，实际数据截止当月
8. **毛利表更新方式**：按月份 DELETE + INSERT 覆盖，增量取数需注意
9. **两张表不可混用**：dwrfin 表无同比/预算字段，dm 表无 WBS/利润中心明细

---

## 八、关联维度表

| 维度 | 表 | 关联键 |
|------|-----|--------|
| 成本中心属性 | dwifin.dwi_cost_center_main_t | cost_center_code / cost_center |
| 公司信息 | dwrdim.dwr_dim_company_d | comp_code / company_code |

注：`dwi_cost_center_main_t` 无描述字段，需要描述直接用费用表自带的 `cost_center_desc`/`cost_center_describe`。
