# 费用报销与差旅

## 快速参考

- **业务含义**：员工费用申请、报销、差旅报销的完整流程数据
- **覆盖表**：5 张表覆盖申请→报销→差旅全流程
- **关联键**：申请单号（`apply_order_no` / `application_order_number`）串联申请和报销

## 核心表

### dwr_fin_expense_apply_f — 费用申请（89 列）

- **粒度**：费用申请单行项目
- **关键字段**：

| 字段 | 含义 | 备注 |
|---|---|---|
| apply_order_no | 申请单号 | 关联报销表 |
| apply_head_id | 申请头ID | |
| apply_activity_id | 申请活动ID | |
| company / company_name | 公司编码/名称 | |
| currency / currency_name | 币种编码/名称 | |
| apply_amount | 申请金额 | numeric |
| apply_rate_amount | 折算金额 | |
| approve_amount | 审批金额 | |
| apply_cost_center_code | 申请成本中心 | |
| borne_cost_center_code | 承担成本中心 | |
| expense_borne_org | 费用承担组织 | |
| budget_use_date | 预算使用日期 | |
| creator_account / creator_name | 创建人 | |
| start_date / end_date | 开始/结束日期 | |
| deleted_flag | 删除标识 | |

### dwr_fin_expense_detail_f — 费用明细报销（32 列）

- **粒度**：费用报销单行项目（ERP凭证级）
- **关键字段**：

| 字段 | 含义 | 备注 |
|---|---|---|
| co_code / co_name | 公司编码/名称 | |
| erp_voucher_no | ERP凭证号 | |
| erp_item_number | 凭证行项目号 | |
| account_code / account_name | 科目编码/名称 | |
| acc_amount | 凭证金额 | numeric，**这是报销金额字段** |
| voucher_date | 凭证日期 | |
| posting_date | 过账日期 | |
| source_order_no | 来源单号 | |
| expense_category | 费用类别 | |
| expense_subclass / expense_subclass_amount | 费用子类/金额 | |
| cost_breakdown / cost_breakdown_entry | 费用拆分 | |
| creater / creatname | 创建人 | |
| reimburser_num / reimburser_name | 报销人 | |
| bear_organization_code / bear_organization_name | 承担组织 | **组织维度，无 cost_center 字段** |
| supplier_code / supplier_name | 供应商 | |
| contract_no / contract_name | 合同号/名称 | |
| oa_serial_number | OA流水号 | |

### dwr_fin_expense_reimbursement_detail_f — 费用报销明细 GL 域（138 列）

- **粒度**：从总账视角记录的费用报销明细，字段最全
- **关键字段**：

| 字段 | 含义 | 备注 |
|---|---|---|
| expense_report_number | 报销单号 | |
| company_code / company_name | 公司 | |
| currency_code / currency_name | 币种 | |
| total_amount | 总金额 | |
| cost_center_code / cost_center_name | 成本中心 | **有成本中心！** |
| bearing_organization_code / bearing_organization_name | 承担组织 | |
| organization_code / organization_name | 申请组织 | |
| flow_status | 流程状态 | |
| accounting_status | 记账状态 | |
| erp_voucher_number | ERP凭证号 | |
| voucher_date / posting_date | 凭证/过账日期 | |
| expense_amount | 费用金额 | |
| expense_category / expense_subcategory | 费用类别/子类 | |
| employee_code / employee_name | 员工 | |
| supplier_code / supplier_name | 供应商 | |
| contract_number / contract_name | 合同 | |
| sales_group_code / sales_group_name | 销售组 | |
| application_order_number | 申请单号 | 关联 dwr_fin_expense_apply_f |
| start_date / end_date | 开始/结束日期 | |
| invoice_code / invoice_number | 发票 | |
| tax_rate / invoice_tax / deduction_tax | 税率/税额/抵扣 | |

### dwr_fin_travel_detail_f — 差旅明细（103 列）

- **粒度**：机票/酒店/用车/交通的订单级明细
- **关键字段**：

| 字段 | 含义 | 备注 |
|---|---|---|
| order_no | 订单号 | |
| code / name | 员工编码/姓名 | |
| cost_center_code / cost_center_name | 成本中心 | |
| expense_borne_code / expense_borne_name | 费用承担组织 | |
| flight_total_amount | 机票总金额 | 含票价+税费+服务费 |
| hotel_total_amount | 酒店总金额 | |
| car_total_amount | 用车总金额 | |
| amount | 金额 | 汇总金额字段 |
| reservation_date | 预订日期 | |
| flight_start_date / flight_end_date | 航班日期 | |
| hotel_start_date / hotel_end_date | 入住/离店日期 | |
| settle_status | 结算状态 | |
| reimbursement_order_no | 报销单号 | |
| reimbursement_status | 报销状态 | |

### dwr_cost_trvapp_f — 差旅报销（39 列）

- **粒度**：差旅申请与报销单
- **关键字段**：

| 字段 | 含义 | 备注 |
|---|---|---|
| integration_id | 集成ID | |
| business_code | 业务编码 | |
| applicant_name | 申请人 | |
| company_code / company_name | 公司 | |
| department_name | 部门 | |
| start_date / end_date | 行程日期 | |
| total_budget | 总预算 | |
| app_status_desc | 审批状态 | |
| app_approval_date | 审批日期 | |
| trv_itinerary_type_desc | 行程类型 | |
| trv_itinerary_city | 行程城市 | |
| supplier_name | 供应商 | |
| del_flag | 删除标识 | 必须过滤 IS NULL |

## 常见查询模式

### 按组织汇总某时间段费用报销

```sql
SELECT bear_organization_code, bear_organization_name,
       SUM(acc_amount) as total_reimb
FROM dwrfin.dwr_fin_expense_detail_f
WHERE posting_date >= '2026-01-01' AND posting_date < '2026-07-01'
GROUP BY bear_organization_code, bear_organization_name
ORDER BY total_reimb DESC;
```

### 按成本中心汇总报销（GL域视角）

```sql
SELECT cost_center_code, cost_center_name,
       SUM(expense_amount) as total
FROM dwrfin.dwr_fin_expense_reimbursement_detail_f
WHERE posting_date >= '2026-01-01' AND posting_date < '2026-07-01'
GROUP BY cost_center_code, cost_center_name
ORDER BY total DESC;
```

### 按费用类别汇总

```sql
SELECT expense_category,
       SUM(acc_amount) as total
FROM dwrfin.dwr_fin_expense_detail_f
WHERE posting_date >= '2026-01-01'
GROUP BY expense_category
ORDER BY total DESC;
```

## 陷阱

1. **`dwr_fin_expense_detail_f` 无 `cost_center_code`**，组织维度用 `bear_organization_code`。需要成本中心用 `dwr_fin_expense_reimbursement_detail_f`
2. 费用申请（apply）和实际报销（detail）是两个不同的表，不要混淆
3. 差旅报销（trvapp）和差旅明细（travel_detail）来自不同 ETL 链路
4. 报销数据可能同时出现在 `expense_detail_f` 和 `expense_reimbursement_detail_f`，后者是 GL 视角且字段更全
5. `dwr_cost_trvapp_f` 有 `del_flag`，查询时需过滤 `IS NULL`

## 交叉引用

- 费用明细 → [cost-comprehensive-subject.md](cost-comprehensive-subject.md)
- 合同 → [contract-ledger.md](contract-ledger.md)
