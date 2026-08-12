# 成本要素 / 科目参考

## 说明

成本要素/科目主数据表（`DWI_COST_ELEMENTS_ACCOUNTS_T` 等）仅存在于 DWI 层 ETL 脚本中，**未在 DWS 中物化**，无法直接查询。

科目编码和描述信息可直接从费用表的自带字段获取：
- dwrfin 表：`general_ledger_account` + `general_ledger_account_desc`
- dm 表：`acc_acount` + `gl_account_desc`

## 制造费用过度科目（必须排除）

查询制造费用（功能范围 4105）时，dm 表需排除以下三个科目（dwrfin 表未自动排除）：

| 科目编码 | 说明 | 备注 |
|---|---|---|
| 0041011040 | 材料消耗-产成品 | dm 表 2026/03/16 后已自动排除 |
| 0041011030 | 材料消耗-半成品 | 同上 |
| 0061507000 | 能源及水资源-水煤浆 | 同上 |

## 特殊处理科目

| 科目编码 | 说明 | 特殊逻辑 |
|---|---|---|
| 61602000 | 从成本中心主档取值 | 不走标准逻辑，2026 年无数据，直接从 `dwi_cost_center_main_t` 取值 |

## 科目编码格式

- `dm_fact_finance_cost_f.acc_acount`：已是 10 位 LPAD 格式，直接匹配
- `dwr_fin_cost_d_compre_subj_t.general_ledger_account`：原始格式，可能需要 `LPAD(..., 10, '0')` 对齐

## 功能范围编码

见 [metrics.md](metrics.md) 第二节完整枚举值。

## 交叉引用

- 费用明细表 → [cost-comprehensive-subject.md](cost-comprehensive-subject.md)
- 费用事实表 → [finance-cost-fact.md](finance-cost-fact.md)
- 语义层（功能范围枚举）→ [metrics.md](metrics.md)
