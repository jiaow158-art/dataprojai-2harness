# 综合分析报表 / 应收额度 / 客户明细

## 快速参考

| 场景 | DWS 表 | 行数 | 列数 | 时间字段 |
|------|--------|------|------|----------|
| 综合分析 | `dm.dm_ar_analysis_rpt_f` | 1,622,607 | 208 | calmonth (YYYY-MM) |
| 应收额度（月） | `dm.dm_rpt_receivable_quota_t` | 1,620,234 | 44 | edition_date (YYYYMMDD) |
| 应收额度（日） | `dm.dm_rpt_receivable_quota_daily_t` | 36,720,657 | 44 | edition_date (YYYYMMDD) |
| 应收减值 | `dm.dm_rpt_receivable_devalue_t` | 992,040 | 11 | edition_date (YYYYMM，实测 `'202501'`) |
| 应收统计 | `dm.dm_ar_rcvbl_stat_t` | 40,049 | 15 | stat_month (YYYYMM) |
| 客户明细 | `dwrfin.dwr_ar_cust_detail_f` | 20,871,454 | 36 | year + month |
| 科目明细 | `dwrfin.dwr_ar_account_detail_f` | 102,805,766 | 50 | year + month |

## dm_ar_analysis_rpt_f 字段

### 核心维度（20+列）
| 字段 | 含义 |
|------|------|
| calmonth | 会计期间 (YYYY-MM，带连字符，实测 `'2025-08'`) |
| wbs / wbs_level1_desc | WBS / WBS一级描述 |
| busi_code | 业务代码 |
| comp_code | 公司 |
| cust_code / cust_name | 客户编号/名称 |
| sales_emp_code / sales_emp_desc | 销售员 |
| special_general_ledger / general_ledger_account | 特别总账 / 科目 |
| provice_name / city_name / region_name | 省/市/区域 |
| belong_tactic_cust_name | 战略客户 |
| devel_org_name | 开发组织 |
| coop_type | 合作类型 |
| payer_rel | 付款方关系 |
| apply_staus_name | 申请状态 |
| busi_belong_name | 业务归属 |
| proj_major_cate_name / proj_sub_cate_name | 项目大类/子类 |
| cust_risk_lev | 客户风险等级 |
| proj_rcv_risk_lev | 项目应收风险等级 |
| cust_class_name | 客户分类 |
| cust_group_name | 客户组 |
| is_overdue_cust | 是否逾期客户 |
| is_contract_back | 是否合同回溯 |
| grp_abbr | 组简称 |

### LTC 全流程节点（36列）
| 字段对 | 含义 |
|--------|------|
| node_desc1 / node_name1 | LTC节点1 描述/名称 |
| ... ~ node_desc9 / node_name9 | LTC节点2~9 |
| node_desc1_c / node_name1_c | LTC节点(合同) 1~9 |

### 应收/逾期/回款指标
| 字段 | 含义 |
|------|------|
| receivables_am | 本月应收金额 |
| receivables_am_lm / _ly / _ey | 上月/去年同期/预期 |
| overdue_receivables | 本月逾期金额 |
| overdue_receivables_lm / _ly / _ey | 上月/去年同期/预期 |
| n_overdue_receivables | 本月未逾期金额 |
| n_overdue_receivables_lm / _ly / _ey | 上月/去年同期/预期 |
| all_collection_amt | 回款金额 |
| send_amt | 发送金额 |
| collection_rate | 回款率 |
| contract_amount2 | 合同金额 |

### 自然账龄（natural_receivables_*）
| 字段 | 含义 |
|------|------|
| natural_receivables_1_90 | 自然账龄 1-90天 |
| natural_receivables_91_180 | 91-180天 |
| natural_receivables_181_275 | 181-275天 |
| natural_receivables_276_365 | 276-365天 |
| natural_receivables_366_730 | 366-730天 |
| natural_receivables_731_1095 | 731-1095天 |
| natural_receivables_1095_1460 | 1096-1460天 |
| natural_receivables_1461 | 1461天以上 |

### 应收逾清（natoverd_receivables_*）
与自然账龄相同分段，但按"逾清"口径。

### 审批口径（_sp 后缀）
`natural_receivables_*_sp`, `natoverd_receivables_*_sp`, `n_natoverd_*_sp` — 审批/特殊口径版本。

### n_natoverd 6口径细分
`n_natoverd_0_90_1` ~ `n_natoverd_0_90_6` 等 56 列，按 6 个子口径拆分。

### 其他
| 字段 | 含义 |
|------|------|
| super_emp_num / super_emp_name | 主管员工号/姓名 |
| progress_pmt / settlement_pmt / retention | 进度款/结算款/质保金 |
| settlement_payment_ratio / retention_money_ratio | 结算比例/质保比例 |
| customer_guarantee | 客户保证金 |
| uninv_amt | 未开票金额 |
| non_house_collection_amt | 非房产回款 |
| settle_amt | 结算金额 |
| pay_grp_cust | 付款组客户 |
| toatl_amt | 总金额 |
| dw_last_update_date | 最后更新 |

---

## dm_rpt_receivable_quota_daily_t 字段要点

| 字段 | 含义 |
|------|------|
| edition_date | 快照日期 (YYYYMMDD) |
| comp_code / comp_code___t | 公司 |
| debitor / debitor___t | 客户 |
| sales_grp / sales_grp___t | 销售组 |
| wbs_elemt / wbs_elemt___t | WBS |
| （与 dm_ar_receivable_accage_t 的维度相同） | |

⚠️ **3672万行**，查询必须带 edition_date 过滤。日均约 10 万行。

---

## 常见查询模式

### 综合分析 — WBS 维度
```sql
SELECT calmonth, wbs_level1_desc, busi_belong_name,
       SUM(receivables_am) as receivables,
       SUM(overdue_receivables) as overdue,
       SUM(all_collection_amt) as collection,
       ROUND(AVG(collection_rate), 2) as avg_coll_rate
FROM dm.dm_ar_analysis_rpt_f
WHERE calmonth = '2026-06'
GROUP BY calmonth, wbs_level1_desc, busi_belong_name
ORDER BY receivables DESC
LIMIT 20;
```

### 自然账龄分段汇总
```sql
SELECT SUM(natural_receivables_1_90) as d_0_90,
       SUM(natural_receivables_91_180) as d_91_180,
       SUM(natural_receivables_181_275) as d_181_275,
       SUM(natural_receivables_276_365) as d_276_365,
       SUM(natural_receivables_366_730) as d_366_730,
       SUM(natural_receivables_731_1095) as d_731_1095,
       SUM(natural_receivables_1095_1460) as d_1096_1460,
       SUM(natural_receivables_1461) as d_1461_plus
FROM dm.dm_ar_analysis_rpt_f
WHERE calmonth = '2026-06';
```

### 按风险等级汇总
```sql
SELECT cust_risk_lev, proj_rcv_risk_lev,
       COUNT(DISTINCT cust_code) as cust_cnt,
       SUM(receivables_am) as balance,
       SUM(overdue_receivables) as overdue
FROM dm.dm_ar_analysis_rpt_f
WHERE calmonth = '2026-06'
GROUP BY cust_risk_lev, proj_rcv_risk_lev
ORDER BY balance DESC;
```

## 陷阱

1. **208列极宽**：`analysis_rpt_f` 是 AR 域最宽的表，SELECT * 不要用，按需选列
2. **`_sp` 后缀 = 审批口径**：默认不用，除非用户明确要求
3. **n_natoverd 6口径**：`_1`~`_6` 是递延的 6 个子口径，普通分析不需要
4. **node_desc 对**：`node_desc1` 和 `node_name1` 是同一节点的不同描述，`node_desc1_c` 是合同版本
5. **collection_rate**：回款率是预计算字段，分子分母口径需确认
6. **应收额度日报 3672万行**：`quota_daily_t` 是 AR 域第二大表，带日期过滤也不一定够，建议带公司过滤
7. **ar_rcvbl_stat_t (4万行)**：高度汇总的统计表
