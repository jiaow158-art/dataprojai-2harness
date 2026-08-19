# 库存域 ETL 口径交叉验证记录（2026-08-19）

> 用途：4 份 ETL 脚本解码的 DWS 实查实证，供后续 7 个文档任务引用。
> V3 为决定性检查——若数量级背离则后续计划 STOP。

## 验证结果总览

| # | 验证项 | 查询口径 | 结果 | 结论 |
|---|--------|----------|------|------|
| V1 | 保质期排他性 | 明细表 202608 by bz_flag | N 行 6,244,867 条 ybzq_amt=0 / Y 行 35,757 条 wbzq_6=0 | **通过** — ybzq 仅 Y 行有值，wbzq 仅 N 行有值，排他性完全成立 |
| V2 | jc 减值公式 | 明细表 202608 全表复算 | reported=286,813,489 / recalc=286,813,489 / 偏差 0% | **通过** — 公式 `0*0~6月 + 0.1*6~12 + 0.4*12~24 + 0.7*24+` 完全吻合 |
| V3 | CHDJ iv=减值 | 瓷砖 202607 双表对照 | detail_jc=233,262,625 / chdj_iv=233,262,625 / 偏差 0% | **通过** — 数量级完全一致，解码证实（chdj_iv_amb=208,720,594 另计） |
| V4 | 跌价 20% 复算 | 上市口径 202607 1-2 年段 | reported=42,356,201 / recalc=42,356,201 / 偏差 0% | **通过** — `(361~450+451~540+541~630+631~720)*0.2` 完全吻合 |
| V5 | 资金成本公式 | 资金成本表 202608 全表 | reported=581,444 / recalc=581,444 / 偏差 0% | **通过** — `((上月+本月)/2 - 202012基线)*0.04/12` 完全吻合 |
| V6 | CHDJ 负值来源 | 资金成本表范围子集 202608 | scoped_cc=581,444（正）vs CHDJ 已知值 -35.7 万（负） | **存疑** — 6 部门子集与全表合计相同（正数），与 CHDJ 负值符号相反，详见下方备注 |

## 结论

V1-V5 全部通过，ETL 脚本解码的 5 项核心口径（保质期排他性、jc 减值比例、CHDJ inventory_value 语义、上市跌价比例、资金成本公式）均获 DWS 实查实证，偏差均为 0%。**V6 存在符号疑虑但不影响主体结论——CHDJ capital_cost 负值的来源机制需进一步排查（可能是 CHDJ 汇总层有额外调整逻辑，而非直接 SUM）。**

## 各组查询完整返回数据

### V1 保质期排他性

```sql
SELECT bz_flag, COUNT(*) AS rows_cnt, ROUND(SUM(zsjkcje)) AS amt,
       ROUND(SUM(COALESCE(ybzq_bzdq_amt,0)+COALESCE(ybzq_bzdq_3_amt,0))) AS ybzq_amt,
       ROUND(SUM(COALESCE(wbzq_6_amt,0))) AS wbzq_6
FROM dm.dm_fin_stock_detail_accage_t_2023
WHERE calmonth = '202608'
GROUP BY bz_flag;
```

| bz_flag | rows_cnt | amt | ybzq_amt | wbzq_6 |
|---------|----------|-----|----------|--------|
| N | 6,244,867 | 1,497,369,546 | 0 | 822,841,734 |
| Y | 35,757 | 916 | 831 | 0 |

### V2 jc 减值公式复算

```sql
SELECT ROUND(SUM(COALESCE(wbzq_jc_amt,0))) AS jc_reported,
       ROUND(SUM(COALESCE(wbzq_6_amt,0)*0 + COALESCE(wbzq_6_12_amt,0)*0.1
               + COALESCE(wbzq_12_24_amt,0)*0.4 + COALESCE(wbzq_24_amt,0)*0.7)) AS jc_recalc
FROM dm.dm_fin_stock_detail_accage_t_2023
WHERE calmonth = '202608';
```

| jc_reported | jc_recalc |
|-------------|----------|
| 286,813,489 | 286,813,489 |

### V3 CHDJ inventory_value = 管理口径减值（瓷砖 202607）

```sql
-- 左：明细表减值合计（瓷砖）
SELECT ROUND(SUM(COALESCE(wbzq_jc_amt,0)+COALESCE(ybzq_jc_amt,0))) AS detail_jc
FROM dm.dm_fin_stock_detail_accage_t_2023
WHERE calmonth = '202607' AND zdpsyb = '11000001';

-- 右：CHDJ inventory_value（瓷砖）
SELECT ROUND(SUM(inventory_value)) AS chdj_iv,
       ROUND(SUM(inventory_value_amb)) AS chdj_iv_amb
FROM dm.dm_ambv2_chdj_grp_t
WHERE stat_month = '2026-07' AND zdpsyb = '11000001';
```

| 来源 | detail_jc / chdj_iv | chdj_iv_amb |
|------|---------------------|-------------|
| 明细表 | 233,262,625 | — |
| CHDJ | 233,262,625 | 208,720,594 |

### V4 上市口径跌价比例复算

```sql
SELECT ROUND(SUM(aging_1_2_year_fall_amt)) AS fall_reported,
       ROUND(SUM((COALESCE(aging_361_450_amt,0)+COALESCE(aging_451_540_amt,0)
                +COALESCE(aging_541_630_amt,0)+COALESCE(aging_631_720_amt,0))*0.2)) AS fall_recalc
FROM dm.dm_fin_stock_d_accage_list_c_t_2023
WHERE calmonth = '202607';
```

| fall_reported | fall_recalc |
|---------------|------------|
| 42,356,201 | 42,356,201 |

### V5 资金成本公式复算

```sql
SELECT ROUND(SUM(COALESCE(capital_cost,0))) AS cc_reported,
       ROUND(SUM(((COALESCE(closing_balance_last_month,0)+COALESCE(closing_balance,0))/2
                - COALESCE(closing_balance_202012,0))*0.04/12)) AS cc_recalc
FROM dm.dm_fin_stock_capital_cost_t
WHERE month = '202608';
```

| cc_reported | cc_recalc |
|-------------|----------|
| 581,444 | 581,444 |

### V6 CHDJ 资金成本负值来源

```sql
SELECT ROUND(SUM(COALESCE(capital_cost,0))) AS scoped_cc
FROM dm.dm_fin_stock_capital_cost_t
WHERE month = '202608'
  AND business_department IN ('11000001','11000002','11000011','11000012','11240102','11250401');
```

| scoped_cc | CHDJ 已知值 |
|-----------|-------------|
| 581,444（正） | -357,000（负，-35.7 万） |

**备注（初判）：** scoped_cc = 581,444 与 V5 全表合计完全一致，说明这 6 个部门覆盖了资金成本表的全部数据，且源表 capital_cost 为正数。CHDJ 层面出现 -35.7 万负值，推测 CHDJ 汇总逻辑中存在额外调整（如抵减项或口径差异），并非简单 SUM 源表。此问题不影响 V1-V5 已证实的核心口径结论，但 CHDJ capital_cost 字段解读需标注“非直接 SUM，存在汇总层调整”。

### V6 深挖（控制器复核，同日）

**探针 1：CHDJ 近月资金成本两列对照**

```sql
SELECT stat_month, ROUND(SUM(COALESCE(capital_cost,0))) AS cc_total,
       ROUND(SUM(COALESCE(capital_cost_conv,0))) AS cc_conv_total, COUNT(*) AS rows_cnt
FROM dm.dm_ambv2_chdj_grp_t WHERE stat_month >= '2026-05' GROUP BY stat_month ORDER BY stat_month;
```

| stat_month | cc_total（原始列 SUM） | cc_conv_total（分摊列 SUM） | rows_cnt |
|---|---|---|---|
| 2026-05 | -1,160,230 | 486,682 | 288,609 |
| 2026-06 | -1,347,005 | 402,341 | 286,107 |
| 2026-07 | -957,847 | 426,120 | 249,441 |
| 2026-08 | -353,226 | **583,383** | 277,562 |

→ 分摊列合计 583,383 与源表 202608 合计 581,444（V5）偏差仅 0.3%；原始列符号相反。

**探针 2：单物料放大检查（W1551A05TYQ，202608）**

| master_versions | src_cc | chdj_cc（SUM 原始列） | chdj_rows |
|---|---|---|---|
| 1 | -13,495.11 | -120,796.68 | 97 |

→ 单物料在 CHDJ 被放大 ~9×：97 行分摊结构中原始列每行携带全额而非份额（物料主数据版本数=1，排除 SCD 扇出）。

**V6 最终结论（修正初判“承袭源表负值”）：**

1. CHDJ `capital_cost`（原始列）在分摊行结构中**重复携带全额**——SUM 该列按行数放大（样例 9×），2026-08 全表 -35.3万 vs 源表 +58.1万，符号都能反。**禁止 SUM 原始列当金额。**
2. CHDJ `capital_cost_conv`（分摊列）合计与源表吻合（0.3%）——**需要 CHDJ 维度的资金成本金额时 SUM conv 列；要准确金额直接用源表 `dm_fin_stock_capital_cost_t`。**
3. `inventory_value` 不受此影响（V3 精确一致：减值每物料单一来源分支）。
4. 源表 capital_cost 本身可为负（平均余额<202012基线）——该语义不变，但 CHDJ 负值的主因是行结构放大而非承袭。
