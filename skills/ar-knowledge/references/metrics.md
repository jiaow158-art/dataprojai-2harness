---
name: ar-metrics
description: 应收域语义层 — 编译后的指标定义、概念映射、维度值。Agent 必须优先查阅此文件再决定用哪张表。
---

# 应收域 — 语义层 (Semantic Layer)

## 使用规则（强制）

1. 收到任何应收相关问题，**必须先读本文件**，再做后续判断
2. 本文件定义的概念→字段映射是权威的，不可自行猜测
3. 每张表的选择必须经过本文件的决策树

---

## 一、核心概念 → DWS 字段映射

### 1.1 "应收"到底指什么？

| 业务口径 | DWS 字段 | 所属表 | 说明 |
|----------|----------|--------|------|
| 本币应收余额 | `local_currency_balance_sum` | dwr_ar_receivable_aging_2023_info_f / balance_f / bill_aging_f / credit_devalue_f | 核心余额字段 |
| 应收余额（报表口径） | `receivables_am` | dm_ar_analysis_rpt_f | 分析报表用 |
| 逾期应收 | `overdue_receivables` | 多张表 | 已逾期未回款金额 |
| 未逾期应收 | `n_overdue_receivables` | 多张表 | 尚在信用期内 |
| 回款金额 | `all_collection_amt` / `collection_amt` / `cash_collection_amt` | dwr_ar_collection_detail_f | 多个回款口径 |
| 回款（付款） | `zhkje` (总回款金额) | dm_ar_return_payment_t | SAP 风格 |
| 应收账龄金额 | `overdue_receivables_*_day_*` | dwr_ar_receivable_aging_2023_info_f | 按天数分段 |
| 自然账龄 | `natural_receivables_*` | 多张表 | 按自然逾期天数分段 |
| 坏账减值金额 | `overdue_*_amt` | dwr_ar_credit_devalue_f | 按账龄计提 |
| 周转天数 | `zzts` | dwr_ar_receivable_turnover_days_f | 预计算 |

**歧义陷阱**：用户说"应收"时，默认指 `local_currency_balance_sum`（本币余额）。如果加了限定词（"逾期"/"回款"/"周转"），切换对应字段和表。

### 1.2 账龄体系（关键！）

DWS 中存在 **三套管龄口径**：

| 体系 | 字段前缀 | 适用表 | 说明 |
|------|---------|--------|------|
| **2023后新版账龄**（推荐） | `overdue_receivables_*_day_2023_after` / `_2023_ago` | dwr_ar_receivable_aging_2023_info_f | 82列版本，最完整 |
| **标准应收账龄** | `bf_2020_zl_ysyq_*` / `af_2020_zl_ysyq_*` | dm_ar_receivable_accage_t | SAP风格 ysyq=已收已清 |
| **标准应收未清** | `bf_2020_zl_yswyq_*` / `af_2020_zl_yswyq_*` | dm_ar_receivable_accage_t | SAP风格 yswyq=已收未清 |
| **自然账龄** | `natural_receivables_*` / `natoverd_receivables_*` | 多张表 | 按自然逾期天数 |

**默认优先使用 2023后新版账龄**（`dwr_ar_receivable_aging_2023_info_f`）。

**旧版表差异**：
- `dwr_ar_receivable_aging_f`（31列）：仅 5 段逾期（1_90/91_275/276_730/731_1460/1461），无未逾期分段
- `dwr_ar_receivable_aging_2023_info_f`（82列）：细分为 30/60/90/120/150/180/210/240/275/365/730/1095/1460 天等多个区间

**DM层月度快照**：
- `dm_ar_receivable_accage_t`（45列）：按月快照，bf=截止某日之前, af=截止某日之后
- `dm_ar_receivable_accage_close_t`：上述的已清账版本

### 1.3 组织维度

| 业务概念 | 字段 | 所属表 | 备注 |
|----------|------|--------|------|
| 公司 | `comp_code` / `comp_code___t` | 多张表 | `___t` 后缀=文本描述 |
| 销售组(SAP) | `sales_grp` / `sales_grp___t` | dm_ar_receivable_accage_t | SAP 风格 |
| 销售组(DWR) | `sales_group_master_file` | dwrfin 系列表 | DWR 风格 |
| WBS 要素 | `wbs_elemt` / `wbs` | 多张表 | SAP=DWR 命名差异 |
| 客户 | `cust_code` / `debitor` | 多张表 | DWR=SAP 命名差异 |
| 客户名称 | `cust_name` / `debitor___t` | 多张表 | |
| 特别总账标志 | `special_general_ledger` | dwrfin 系列表 | 空=正常应收 |
| 业务部门 | `business_department` | dwrfin 多张表 | |
| 销售员 | `sales_emp_code` / `sales_emp_desc` | 多张表 | |
| 总账科目 | `general_ledger_account` | 多张表 | |
| 客户组 | `cust_group_code` / `cust_grp_code` | 多张表 | |

### 1.4 客户维度（关联 dwrdim）

| 业务概念 | 字段 | 所属表 | 备注 |
|----------|------|--------|------|
| 客户编号 | `cust_num` / `src_cust_num` | dwr_dim_cust_partner_d / _sales_area_d | |
| 销售组织 | `sales_org_code` | dwr_dim_cust_partner_d | |
| 分销渠道 | `dist_channel_code` | dwr_dim_cust_sales_area_d | |
| 客户分类 | `cust_class_name` | dwr_ar_credit_devalue_f / dm_ar_analysis_rpt_f | |
| 客户风险等级 | `cust_risk_lev` | dm_ar_analysis_rpt_f | |
| 项目应收风险 | `proj_rcv_risk_lev` | dm_ar_analysis_rpt_f | |

---

## 二、表选择决策树

```
用户问题
├── 需要应收账龄明细（含客户/科目/WBS/逾期分段）？
│   ├── 最新快照、细分段最多 → dwrfin.dwr_ar_receivable_aging_2023_info_f（82列，推荐）
│   ├── 月度快照、SAP口径 → dm.dm_ar_receivable_accage_t（45列）
│   └── 旧版简单分段 → dwrfin.dwr_ar_receivable_aging_f（31列，不推荐）
├── 涉及"应收余额"？
│   ├── 月度余额 → dwrfin.dwr_ar_receivable_balance_f（18列）
│   └── 多币种余额 → dwrfin.dwr_ar_receivable_balance_currency_f（15列）
├── 涉及"回款"/"收款"？
│   ├── 明细级 → dwrfin.dwr_ar_collection_detail_f（31列）
│   └── SAP口径月度汇总 → dm.dm_ar_return_payment_t（21列）
├── 涉及"逾期监控"/"客户逾期"？
│   └── dm.dm_ar_overdue_receivables_t（32列）
├── 涉及"坏账减值"/"信用减值"？
│   └── dwrfin.dwr_ar_credit_devalue_f（129列）
├── 涉及"应收周转"？
│   └── dwrfin.dwr_ar_receivable_turnover_days_f（4列，预计算）
├── 涉及"商业票据"/"资金成本"？
│   └── dwrfin.dwr_ar_commercial_bill_capital_cost_f（20列）
├── 涉及"综合分析"（合同→回款全链路）？
│   └── dm.dm_ar_analysis_rpt_f（208列）
├── 涉及"票据级账龄"？
│   └── dwrfin.dwr_ar_bill_aging_f（63列）
├── 涉及"客户主数据"？
│   ├── 客户合作伙伴 → dwrdim.dwr_dim_cust_partner_d（79列）
│   └── 客户销售区域 → dwrdim.dwr_dim_cust_sales_area_d（71列）
└── 不确定？
    └── 默认用 dwrfin.dwr_ar_receivable_aging_2023_info_f（最全最新）
```

---

## 三、核心表速查

### 3.1 dwr_ar_receivable_aging_2023_info_f — 应收账龄 2023 新版（第一优先）

| 属性 | 值 |
|------|-----|
| Schema | dwrfin |
| 粒度 | 客户+科目+特别总账+WBS |
| 列数 | 82 |
| 行数 | 13,406,776 |
| 时间字段 | `query_date` (YYYY-MM-DD) |
| 余额字段 | `local_currency_balance_sum`（本币余额） |
| 逾期字段 | `overdue_receivables`, `overdue_receivables_2023_after`, `overdue_receivables_2023_ago` |
| 2023后账龄分段 | `overdue_receivables_*_day_2023_after` (13段: 1_30/31_60/61_90/91_120/121_150/151_180/181_210/211_240/241_275/276_365/366_730/731_1095/1096_1460/1461+) |
| 2023前账龄分段 | `overdue_receivables_*_day_2023_ago` (同上13段) |
| 未逾期分段 | `n_overdue_receivables_*_day` (16段: 细到30天间隔) |
| 关键维度 | cust_code, cust_name, comp_code, wbs, general_ledger_account, special_general_ledger, sales_group_master_file |
| ⚠️ 陷阱 | query_date 格式 YYYY-MM-DD；需判断 `is_overdue_cust` 来过滤非逾期客户 |

### 3.2 dm_ar_receivable_accage_t — 应收账龄月度快照

| 属性 | 值 |
|------|-----|
| Schema | dm |
| 粒度 | 公司+客户+销售组+WBS |
| 列数 | 45 |
| 行数 | 1,620,234 |
| 时间字段 | `edition_date` (YYYYMMDD) |
| 余额字段 | `zysye`（总应收余额）, `zyq`（总逾期）, `zdqyj`（总到期押金） |
| 账龄分段 | `bf_2020_zl_ysyq_*` (应收账龄), `af_2020_zl_ysyq_*`, `bf_2020_zl_yswyq_*` (应收未清), `af_2020_zl_yswyq_*` |
| 分段粒度 | 0_90 / 91_275 / 276_720 / 721_1440 / 1441+ 天 |
| ⚠️ 陷阱 | bf=截止日之前, af=截止日之后；ysyq=应收已清, yswyq=应收未清；还有 1_90 等新细分段 |

### 3.3 dwr_ar_collection_detail_f — 回款明细

| 属性 | 值 |
|------|-----|
| Schema | dwrfin |
| 粒度 | 凭证+客户+科目 |
| 列数 | 31 |
| 行数 | 12,873,369 |
| 时间字段 | `year` + `month` + `posting_date` (过账日期, timestamp) + `voucher_date` (凭证日期, timestamp) |
| 核心字段 | all_collection_amt, collection_amt, cash_collection_amt, non_cash_collection_amt, non_confirm_amt, send_amt, return_collection_amt |
| ⚠️ 陷阱 | `collection_amt` = 已匹配回款, `all_collection_amt` = 全部回款含未匹配, `non_confirm_amt` = 未确认回款 |

### 3.4 dwr_ar_receivable_balance_f — 应收余额

| 属性 | 值 |
|------|-----|
| Schema | dwrfin |
| 粒度 | 客户+科目+WBS+月份 |
| 列数 | 18 |
| 行数 | 6,516,423 |
| 时间字段 | `year` + `month`（两列） |
| 核心字段 | `current_local_currency_balance`（当期本币余额）, `local_currency_balance_sum`（本币余额合计） |
| ⚠️ 陷阱 | 只有余额没有账龄分段；需要 year + month 两个过滤条件 |

### 3.5 其他表速查

| 表名 | 行数 | 关键时间字段 | 主要用途 |
|------|------|-------------|----------|
| dwr_ar_bill_aging_f | 10,433 | query_date | 票据级账龄 |
| dwr_ar_credit_devalue_f | 5,575,285 | query_date | 坏账减值 |
| dm_ar_overdue_receivables_t | 3,133,955 | ed_mon (YYYYMM) | 逾期监控 |
| dm_ar_analysis_rpt_f | 1,622,607 | calmonth (YYYY-MM) | 综合分析 |
| dm_ar_return_payment_t | 1,792,544 | calmonth (YYYYMM) | 回款/付款 |
| dwr_ar_receivable_turnover_days_f | 484 | calmonth (YYYYMM, 仅到202212) | 周转天数 |
| dwr_ar_commercial_bill_capital_cost_f | 1,566,703 | month | 票据资金成本 |
| dwr_ar_cust_detail_f | 20,871,454 | year + month | 客户明细(大表) |
| dwr_ar_account_detail_f | 102,805,766 | year + month | 科目明细(超大) |
| dwrdim.dwr_dim_cust_partner_d | 1,731,147 | — | 客户主数据 |

---

## 四、日期格式总览（关键！）

| 表 | 时间字段 | 格式 | 示例 |
|---|---------|------|------|
| dwr_ar_receivable_aging_2023_info_f | `query_date` | YYYY-MM-DD | `'2026-06-07'` |
| dm_ar_receivable_accage_t | `edition_date` | YYYYMMDD | `'20260608'` |
| dwr_ar_receivable_balance_f | `year` + `month` | YYYY + YYYY-MM | `'2026'`, `'2026-06'` |
| dwr_ar_collection_detail_f | `year` + `month` + `posting_date` | YYYY + YYYY-MM + timestamp | |
| dm_ar_overdue_receivables_t | `ed_mon` | YYYYMM | `'202606'` |
| dm_ar_analysis_rpt_f | `calmonth` | YYYY-MM | `'2026-06'` |
| dm_ar_return_payment_t | `calmonth` | YYYYMM | `'202606'` |
| dwr_ar_bill_aging_f | `query_date` | YYYY-MM-DD | `'2026-06-07'` |
| dwr_ar_credit_devalue_f | `query_date` | YYYY-MM-DD | `'2026-06-07'` |
| dwr_ar_receivable_turnover_days_f | `calmonth` | YYYYMM | `'202212'` (仅到2022年) |
| dwr_ar_commercial_bill_capital_cost_f | `month` | YYYY-MM | `'2026-06'` |

⚠️ **最大陷阱**：同一个库不同表的时间字段格式不一致！YYYYMMDD vs YYYYMM vs YYYY-MM vs timestamp。

---

## 五、标准指标公式

### 应收余额类

| 指标 | 公式 | 适用表 |
|------|------|--------|
| 本币应收余额 | `SUM(local_currency_balance_sum)` | aging_2023_info_f / balance_f |
| 逾期应收总额 | `SUM(overdue_receivables)` | aging_2023_info_f / aging_f |
| 未逾期应收总额 | `SUM(n_overdue_receivables)` | aging_2023_info_f |
| 逾期占比 | `SUM(overdue_receivables) / SUM(local_currency_balance_sum) * 100` | aging_2023_info_f |

### 账龄类

| 指标 | 公式 | 适用表 |
|------|------|--------|
| 逾期 0-90天 | `SUM(overdue_receivables_1_90_day_2023_after)` | aging_2023_info_f |
| 逾期 91-275天 | `SUM(overdue_receivables_91_275_day_2023_after)` | aging_2023_info_f |
| 逾期 276-730天 | `SUM(overdue_receivables_276_730_day_2023_after)` | aging_2023_info_f |
| 逾期 731-1460天 | `SUM(overdue_receivables_731_1460_day_2023_after)` | aging_2023_info_f |
| 逾期 1461天+ | `SUM(overdue_receivables_1461_day_2023_after)` | aging_2023_info_f |
| 长账龄占比(>730天) | `SUM(overdue_731_1460 + overdue_1461) / SUM(overdue_receivables) * 100` | aging_2023_info_f |

### 回款/周转类

| 指标 | 公式 | 适用表 |
|------|------|--------|
| 回款总额 | `SUM(all_collection_amt)` | collection_detail_f |
| 已匹配回款 | `SUM(collection_amt)` | collection_detail_f |
| 回款匹配率 | `SUM(collection_amt) / NULLIF(SUM(all_collection_amt), 0) * 100` | collection_detail_f |
| 应收周转天数 | `zzts`（预计算） | turnover_days_f |

---

## 六、标准过滤条件

```sql
-- dwr_ar_receivable_aging_2023_info_f: query_date YYYY-MM-DD
WHERE query_date = '2026-06-07'

-- dm_ar_receivable_accage_t: edition_date YYYYMMDD
WHERE edition_date = '20260608'

-- dwr_ar_receivable_balance_f: year + month
WHERE year = '2026' AND month = '2026-06'

-- dwr_ar_collection_detail_f: year + month (大表必须带)
WHERE year = '2026' AND month = '2026-06'

-- dm_ar_overdue_receivables_t: ed_mon YYYYMM
WHERE ed_mon = '202606'

-- dm_ar_analysis_rpt_f: calmonth YYYY-MM
WHERE calmonth = '2026-06'

-- 排除特别总账（正常应收）
WHERE (special_general_ledger IS NULL OR special_general_ledger = '')
```

---

## 七、已知陷阱总览

1. **日期格式不一致**（见第四节）：同一概念在不同表中格式不同，绝对不能混用
2. **两套命名体系**：`cust_code` (DWR风格) vs `debitor` (SAP风格) — 对应客户编码
3. **`___t` 后缀**：三个下划线 + t，SAP 风格文本字段。如 `comp_code` → `comp_code___t`
4. **三套管龄体系**：2023新版(优先) / 标准应收账龄 ysyq / 应收未清 yswyq / 自然账龄 natural — 绝对不可混用
5. **`_close` 后缀表**：`_close` 是已清账版本，一般分析用未清账版本
6. **`_sp` 后缀字段**：审批/特殊口径字段（如 `natoverd_receivables_*_sp`），默认不查
7. **balance_f vs aging_f**：balance_f 只有余额没有账龄分段，aging_f 有分段。两表 `local_currency_balance_sum` 应接近但可能因快照时点不同有偏差
8. **特别总账标志**：`special_general_ledger` 为空 = 正常应收（绝大多数分析场景），非空 = 特别总账（预收款/保证金等）
9. **备份表泛滥**：`_wjh_*`、`_bak*`、`_tmp*`、`_01`、`_2024*` 等后缀均为备份/临时表，绝对不能使用
10. **account_detail_f 1亿行**：最大的应收表，不带 year+month 过滤直接超时
11. **旧版 aging_f (31列) vs 新版 _2023_info_f (82列)**：新版账龄分段细得多，优先用新版
12. **bf vs af 前缀**：`bf_*` = Before（截止日之前），`af_*` = After（截止日之后），在 `dm_ar_receivable_accage_t` 中成对出现
13. **跨域表 DM_FIN_AR_NODEEXCEPTION_LTC_T（LTC 节点异常）**：以 `DM_FIN_AR_*` 命名但**实际不属于 AR 应收事实**，是 LTC（Lead Time to Cash）全流程 10 节点追踪表（2247万行），数据源全部来自 SDI 商机/合同/验收录/请款/签收等节点表。AR 域只通过 `dm_ar_analysis_rpt_f` 的 36 列 LTC 节点字段间接引用它（JOIN node_desc1~9 等）。**用户问"应收账款"不要查 LTC 表；问"LTC 周期/节点超期"才用此表，且需带 period_id_m 分区裁剪**
14. **应收余额/逾期率存在两套口径，数字不可比**：同一个"集团应收余额"，账龄表白名单口径 = **33.63 亿 / 逾期率 68.4%**，分析报表自洽口径 = **18.11 亿 / 80.0%**（2026-08 实测）。回答前必须按第九节二选一并**声明所用口径**，两套数字不可混用、不可互相"纠错"
15. **跨域表 dm_fin_operations_mix_sum_t 的 `calmonth='S'` 脏数据**：该表 `calmonth` 正常为 'YYYY-MM'，但存在 **38 行字面值 `'S'`**（2026-09-09 实测：这 38 行 `data_source` 恰也为 `'S'`、`ambperformance` 全 NULL；成因推测为 ETL 字段串位，**待业务/ETL 确认**）。危害：`MAX(calmonth)`、`GROUP BY calmonth`、最新账期判断都会被 `'S'` 污染（'S' 字典序大于所有 '20..' 开头账期，会占据 MAX）。安全写法：加 `calmonth LIKE '____-__'`（或 `calmonth ~ '^\d{4}-\d{2}$'`）排除。金额聚合因 ambperformance 为 NULL 不受影响，但行数统计会多 38。此表为销售/费用/应收多域共用的 mix 表，属跨域陷阱

---

## 八、关联维度表

| 维度 | 表 | 关联键 |
|------|-----|--------|
| 客户主数据 | dwrdim.dwr_dim_cust_partner_d | cust_code / cust_num |
| 客户销售区域 | dwrdim.dwr_dim_cust_sales_area_d | cust_code / src_cust_num |
| 公司信息 | dwrdim.dwr_dim_company_d | comp_code / company_code |

注：应收表中已有客户描述（`cust_name`/`debitor___t`），无需单独关联客户主数据。

---

## 九、应收余额与逾期率口径（两个口径二选一，必须声明）

**何时读本节**：用户问"集团/公司目前应收多少"、"逾期率多少"、经营分析报告的应收 KPI——这是应收域**最容易踩坑的指标**，存在两套都正确但数字不可比的口径（2026-08 实测相差 15.5 亿）。

### 9.1 两口径对比

| | 口径 A：主营应收科目正余额口径 | 口径 B：分析报表自洽口径 |
|---|---|---|
| 表 | `dwrfin.dwr_ar_receivable_aging_2023_info_f` | `dm.dm_ar_analysis_rpt_f` |
| 过滤 | `query_date='2026-08-31'`（YYYY-MM-DD）+ 6 科目白名单 + `local_currency_balance_sum>0` | `calmonth='2026-08'`（YYYY-MM），无科目/正负过滤 |
| 应收余额 | **33.63 亿**（`SUM(local_currency_balance_sum)`） | **18.11 亿**（`SUM(receivables_am)`） |
| 逾期金额 | 23.01 亿（`SUM(overdue_receivables)`） | 14.49 亿（`SUM(overdue_receivables)`） |
| 逾期率 | **68.4%** | **80.0%**（=14.49/18.11，余额=逾期+未逾期 3.62，自洽） |
| 自洽性 | 不自洽（余额不含负余额与挂账科目，逾期可>余额） | 自洽（`receivables_am = overdue + n_overdue`） |
| 适用场景 | 与历史正式报告/月度经营分析口径对齐（历史 KPI 趋势系列如 33.76/33.63 亿即此口径）；需账龄分段下钻 | 分析报表类需求：按客户分类/风险等级/LTC 节点等多维分析；要求"余额=逾期+未逾期"数字自洽的场景 |

### 9.2 口径 A SQL 骨架（2026-08-31 实测 33.63 / 23.01，逾期率 68.4%）

```sql
SELECT ROUND(SUM(local_currency_balance_sum)/100000000,2) AS balance_yi,
       ROUND(SUM(overdue_receivables)/100000000,2)        AS overdue_yi
FROM dwrfin.dwr_ar_receivable_aging_2023_info_f
WHERE query_date = '2026-08-31'          -- YYYY-MM-DD，月末快照日
  AND general_ledger_account IN (        -- 6 科目白名单（主营应收）
      '0011310100','0011310110','0011310300',
      '0011310600','0011310700','0011310800')
  AND local_currency_balance_sum > 0     -- 剔除负余额（贷方/冲销挂账）
GROUP BY query_date
```

要点：
- **科目白名单是本口径的灵魂**：该表实际有 7 个总账科目，白名单=全科目**剔除 `0011310200`**。
- `query_date` 换月末日期即得历史各期：2026-07-31 = 33.76 亿、2026-06-30 = 34.70 亿（2026-09-09 实测复现）。注：金样报告趋势系列曾出现 37.90 亿（2026-06），本次同口径实测 06-30 为 34.70、06-02 为 22.99，均非 37.90，该期数值未能复现，**待业务确认**（可能对应已重算的历史快照）。
- **⚠️ 必须加科目过滤**：不加时全科目余额约 70 亿且负值/挂账科目混入，逾期金额（283.58 亿，见下）远大于余额，完全不可用——不要"先查总再自己挑科目"。

### 9.3 口径 B SQL 骨架（2026-08 实测 18.11 = 14.49 + 3.62，逾期率 80.0%）

```sql
SELECT calmonth,
       ROUND(SUM(COALESCE(receivables_am,0))/100000000,2)        AS recv_yi,
       ROUND(SUM(COALESCE(overdue_receivables,0))/100000000,2)   AS od_yi,
       ROUND(SUM(COALESCE(n_overdue_receivables,0))/100000000,2) AS nod_yi
FROM dm.dm_ar_analysis_rpt_f
WHERE calmonth = '2026-08'               -- YYYY-MM
GROUP BY calmonth
```

要点：
- 自洽性校验式：`recv_yi = od_yi + nod_yi`（18.11 = 14.49 + 3.62），先跑校验再报数。
- 该表 208 列，支持客户分类/风险等级/合同→回款全链路等多维下钻（见 ar-analysis-rpt.md）。

### 9.4 分歧根因与已知事实

两口径差异主要来自 `dwr_ar_receivable_aging_2023_info_f` 的科目 `0011310200`：该科目在该表呈现 ±300 亿级的挂账/互抵特征（2026-08-31 实测：余额 43.10 亿、逾期 283.58 亿、13.3 万行），且表内存在负余额行。口径 A 靠"白名单 + 正余额"把它排除掉，才得到与历史报告一致的 33.63 亿；口径 B 的 `receivables_am` 在 DM 层已按报表规则加工，天然不含该科目噪声。**注意：0011310200 的业务含义（暂挂/清算/内部往来科目？）知识库未掌握，白名单本身也是"从历史报告数值反推"得到——以上标注均待业务确认**。

### 9.5 使用建议

1. **回复时必须声明口径**（"应收余额 X 亿（口径 A/B，定义见…）"），两口径数值不可相加、相减、互相对表。
2. 与历史报告/榜单对数 → 用口径 A；做自洽的多维分析或逾期结构拆解 → 用口径 B。
3. 若用户坚持某个数字（如"我上次看到的是 33.63"），按用户给的数字反查其口径后沿用户口径走，不替业务裁决哪套"正确"。
4. 科目白名单成员与 0011310200 的业务含义**待业务确认**；确认后更新本节。
5. 关联跨域陷阱：多域共用的 `dm.dm_fin_operations_mix_sum_t` 存在 `calmonth='S'` 脏数据 38 行，处理方式见第七节第 15 条。
