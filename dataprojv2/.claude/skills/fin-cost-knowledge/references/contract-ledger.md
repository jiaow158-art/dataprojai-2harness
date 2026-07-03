# 合同台账

## 快速参考

- **业务含义**：合同全生命周期台账，含基本信息、金额、执行状态，以及关联的订单和结算信息
- **覆盖表**：3 张表覆盖合同→订单→结算全链路
- **关联键**：`contract_no` 串联合同与订单/结算

## 核心表

### dwr_fin_contract_ledger_detail_f — 合同台账明细（136 列）

- **粒度**：合同行项目（合同头 + 明细行）
- **关键字段**：

| 字段 | 含义 | 备注 |
|---|---|---|
| id | 主键 | numeric |
| order_no | 订单号 | |
| contract_no | 合同号 | 关联订单/结算表 |
| contract_name | 合同名称 | |
| contract_status | 合同状态 | |
| contract_clas | 合同分类 | |
| contract_type | 合同类型 | |
| framework | 是否框架合同 | |
| co_code / co_name | 公司编码/名称 | |
| organization_code / organization_nam | 组织 | 注意拼写是 nam 不是 name |
| organization_name_path | 组织路径 | |
| partner_type | 合作方类型 | |
| partner_code / partner_name | 合作方 | |
| signing_date | 签订日期 | **不是 sign_date** |
| start_date / end_date | 合同开始/结束日期 | |
| contract_amount | 合同金额 | |
| currency_code / currency_name | 币种 | |
| amount | 金额 | 明细行金额 |
| cost_amount / tax_amount | 成本金额/税额 | |
| applied_amount | 已申请金额 | |
| can_apply_amount | 可申请金额 | |
| paid_amount | 已付金额 | |
| cost_center_code / cost_center_name | 成本中心 | |
| cont_organization_code / cont_organization_name | 合同组织 | |
| flow_status | 流程状态 | |
| archive_no | 归档编号 | |
| del_flag | 删除标识 | 必须过滤 IS NULL |
| contract_del_flag | 合同删除标识 | |
| need_amortize | 是否需要摊销 | |
| amortize_start_date / amortize_end_date | 摊销起止日期 | |
| amortize_amount / amortize_period_number | 摊销金额/期数 | |
| tax_rate / contract_tax_rate | 税率 | |
| write_off_status | 核销状态 | |
| write_off_amount / pre_write_off_amount | 核销金额/预核销 | |
| invoice_nature_code / invoice_nature_name | 发票性质 | |
| payment_terms | 付款条款 | |
| planned_payment_date | 计划付款日期 | |

### dwr_fin_order_contract_detail_f — 订单合同明细（10 列）

- **粒度**：销售订单与合同的关联关系

| 字段 | 含义 | 备注 |
|---|---|---|
| id | 主键 | |
| contract_no | 合同号 | 关联合同台账 |
| contract_name | 合同名称 | |
| order_no | 订单号 | |
| item_number | 行项目号 | |
| payment_amount | 付款金额 | |
| pay_channels | 付款渠道 | |
| pay_state | 付款状态 | |
| pay_amount_act | 实际付款金额 | |

### dwr_fin_settlement_contract_doc_f_f — 结算合同单据（11 列）

- **粒度**：合同结算单据

| 字段 | 含义 | 备注 |
|---|---|---|
| contract_no | 合同号 | 关联合同台账 |
| contract_name | 合同名称 | |
| order_no | 订单号 | |
| item_no | 行项目号 | |
| payment_amount | 付款金额 | |
| payment_channel | 付款渠道 | |
| payment_status | 付款状态 | |
| business_no | 业务编号 | |
| currency_amount | 币种金额 | |
| payment_result | 付款结果 | |

## 常见查询模式

### 某时间段内签订的合同

```sql
SELECT contract_no, contract_name, co_name, partner_name,
       contract_amount, signing_date
FROM dwrfin.dwr_fin_contract_ledger_detail_f
WHERE signing_date >= '2026-01-01' AND signing_date < '2026-07-01'
  AND del_flag IS NULL;
```

### 按公司/组织汇总合同金额

```sql
SELECT co_name, organization_nam,
       COUNT(DISTINCT contract_no) as contract_cnt,
       SUM(contract_amount) as total_amount
FROM dwrfin.dwr_fin_contract_ledger_detail_f
WHERE signing_date >= '2025-01-01'
  AND del_flag IS NULL
GROUP BY co_name, organization_nam
ORDER BY total_amount DESC;
```

### 合同关联订单查询

```sql
SELECT a.contract_no, a.contract_name, a.partner_name,
       b.order_no, b.payment_amount, b.pay_state
FROM dwrfin.dwr_fin_contract_ledger_detail_f a
JOIN dwrfin.dwr_fin_order_contract_detail_f b
  ON a.contract_no = b.contract_no
WHERE a.signing_date >= '2026-01-01'
  AND a.del_flag IS NULL;
```

## 陷阱

1. **`signing_date` 不是 `sign_date`**：文档历史版本曾误写为 `sign_date`
2. **`organization_nam` 拼写**：字段名就是 `organization_nam`（少一个 e），不是 `organization_name`
3. **两个删除标识**：`del_flag`（合同行项目级）和 `contract_del_flag`（合同头级），通常过滤 `del_flag IS NULL` 即可
4. **合同台账列数庞大**（136列），不要 `SELECT *`，按需取列
5. **日期字段是 character varying**，不是 date 类型，但可直接用字符串比较

## 交叉引用

- 费用明细 → [cost-comprehensive-subject.md](cost-comprehensive-subject.md)
- 费用报销 → [expense-reimbursement.md](expense-reimbursement.md)
