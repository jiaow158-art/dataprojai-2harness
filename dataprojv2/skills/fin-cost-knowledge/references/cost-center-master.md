# 成本中心主数据

## 快速参考

- **DWS 表名**：`dwifin.dwi_cost_center_main_t`（32 列）
- **业务含义**：成本中心是 SAP CO 模块的核心组织单元，用于归集费用和控制成本。每个成本中心属于一个控制范围、关联一个利润中心和一个公司代码。
- **实体粒度**：一行 = 一个成本中心的一条有效记录（有时间有效性）
- **标准过滤**：`control_scope='DP00' AND del_flag IS NULL`

## 核心表

### dwifin.dwi_cost_center_main_t — 成本中心主数据表

DWS 中唯一可用的成本中心主数据表（DWI 层）。包含有效期管理，支持历史追溯。

- **关联方式**：与费用表通过 `cost_center` = `cost_center_code` 关联

## 关键字段

| 字段 | 含义 | 注意事项 |
|---|---|---|
| cost_center | 成本中心编码 | 主键，与费用表 cost_center_code 关联 |
| company_code | 公司编码 | |
| profit_center | 利润中心编码 | |
| func_scope | 功能范围编码 | 区分制造/销售/管理/研发费用 |
| cost_center_type | 成本中心类型 | WBS 相关 / 部门成本中心等 |
| control_scope | 控制范围 | 始终为 DP00 |
| start_effect_date | 有效期开始 | 拉链表查询时使用 |
| end_effect_date | 有效期结束 | |
| leader | 负责人 | |
| group_num | 集团 | |
| lang_code | 语言 | |
| del_flag | 删除标识 | 必须过滤 IS NULL |
| create_date | 创建日期 | |
| input_by | 录入人 | |
| business_scope | 业务范围 | |
| currency_code | 货币代码 | |

注：此表**没有成本中心描述字段**。成本中心描述在 `dwrfin.dwr_fin_cost_d_compre_subj_t` 中有 `cost_center_desc` 字段可用。

## 常见查询模式

### 查询某成本中心的完整属性
```sql
SELECT * FROM dwifin.dwi_cost_center_main_t
WHERE cost_center = 'XXXX' AND del_flag IS NULL;
```

### 按功能范围汇总成本中心数量
```sql
SELECT func_scope, COUNT(DISTINCT cost_center) as cnt
FROM dwifin.dwi_cost_center_main_t
WHERE del_flag IS NULL
GROUP BY func_scope;
```

## 陷阱

1. 成本中心有时间有效性，历史查询需注意 `start_effect_date` 和 `end_effect_date`
2. 此表没有成本中心描述（`cost_center_desc`），需要描述时用费用表 `dwr_fin_cost_d_compre_subj_t` 自带的 `cost_center_desc` 字段
3. 科目 61602000 的成本中心有特殊取值逻辑（见费用明细表文档）
4. 这是 DWI 层表，不是 DWR 层。离线脚本中的 `DWR_COST_CENTER_MAIN_D` 未在 DWS 中物化

## 交叉引用

- 费用明细表 → [cost-comprehensive-subject.md](cost-comprehensive-subject.md)
- 成本要素 → [cost-elements.md](cost-elements.md)
