# 数据集过期/消失锚点修复轮（2026-09-20，零 API 成本）

> 直连 DWS 只读重导，不跑 agent 引擎。依据：`eval_results/round-golden10/REJUDGE.md` 二次更新节（idx 11/20/30 数据侧发现）+ `skills/ar-knowledge/references/metrics.md` 十节 10.3 快照日历发现（aging_2023_info_f 全表 INSERT OVERWRITE 无分区，2026-06-07 快照已被上游重跑抹掉）。
> 纪律：沿用 T6-changes.md —— 数据集是标准；文本级精确替换（CRLF、无 BOM、literal CJK）；parse 前后断言只有目标字段变化；结构性字段（domain/pattern）绝不动。
> 实现：`eval_results/round-manual/repair_20260920.py`（逐场景 span 定位 + 片段替换 + fresh 重导 + 内建断言）；运行证据 `repair_20260920_run.json`、前后差异 `_before_after.txt`、重述差异 `_verify_diffs.txt`。

## 锚点存在性验证（写入前，2026-09-20 直连 DWS 实测）

| 验证项 | 结果 |
|---|---|
| `dwrfin.dwr_ar_receivable_aging_2023_info_f` 5-6 月现存快照日 | **2026-05-02 / 2026-05-31 / 2026-06-02 / 2026-06-30**（现行日历=每月02+月末） |
| 同表 `query_date='2026-06-07'` 行数 | **0**（确认已被抹掉） |
| 同表 `query_date='2026-06-30'` 行数 | 251,915（锚点存在） |
| `dwrfin.dwr_ar_credit_devalue_f` 5-6 月快照日 | **2026-05-31 / 2026-06-30**（仅月末；06-30 = 311,968 行） |
| `dm.dm_ar_overdue_receivables_t` `ed_mon='202606'` | 已出账（yqe>0 且非忽略 = 10 行，录制时为 0） |

## 逐条修复表

### A 组：ar 消失快照重锚（统一 06-07 → 06-30）

| idx | pattern | 改了什么 | 为何 | 锚点验证 |
|---|---|---|---|---|
| 20 | topn_customer | question "6月7日"→"6月30日"；SQL `query_date='2026-06-07'`→`'2026-06-30'`；data/elapsed_ms 重录（row_count=10、checksum=rows=10 不变） | 06-07 快照消失，fresh 恒 0 行 | 06-30 存在（25.2 万行） |
| 21 | aging_structure | question 不动（仍"2026年5-6月"）；SQL `IN(...)` 列表末位 `'2026-06-07'`→`'2026-06-30'`；data 重录（4 行不变） | IN 列表重建为 5-6 月现存快照日 | 5-6 月现存=05-02/05-31/06-02/06-30，恰好只换末位 |
| 22 | aging_bucket_detail | question+SQL 同 idx20 单日重锚；data/elapsed_ms 重录（1 行不变） | 同 idx20 | 同 idx20 |
| 26 | devalue_by_class | question+SQL 同 idx20；data/elapsed_ms 重录（2 行不变） | 同 idx20；该表仅月末快照 | 06-30 存在（31.2 万行） |
| 23 | overdue_customer | question/SQL 均不动（`ed_mon='202606'` 已定）；data 重录 + row_count 0→10 + checksum rows=0→rows=10（checksum 为 rows=N 派生格式，随 row_count 联动） | 录制时 row_count=0 系月结前时点，现已出账 | ed_mon=202606 现存 10 行 |

### B 组：无上界 SQL 补界（E-6 销账；question 与 SQL 窗口对齐）

| idx | 域/pattern | 改了什么 | 为何 | data 校验结果 |
|---|---|---|---|---|
| 0 | fin-cost/trend_monthly | question →"2026年1-6月各月费用总额趋势"；SQL `WHERE year='2026'` 补 `AND month <= '2026-06'` | 录制 data 即 1-6 月，无上界会长出 7 月后行 | **非一致→重录**：2026-06 重述 -2,614 万→+13.37 亿（见下注） |
| 9 | fin-cost/summary_year | SQL `year >= '2024'` → `year BETWEEN '2024' AND '2026'`；question 不动 | 防未来年份数据长出第 4 行 | **非一致→重录**：2026 年合计重述（见下注） |
| 24 | ar/collection_monthly | SQL `WHERE year='2026'` 补 `AND month <= '2026-06'`（month 为 'YYYY-MM' 带横杠格式）；question 不动（"2026年上半年"） | 同 E-6：7 月后会长行 | **非一致→重录**：2026-06 回款重述（见下注） |
| 25 | ar/balance_trend | SQL 同 idx24 补月上界；question →"2026年上半年应收余额月度趋势"；data 重录 | question 原为 2026 自然年，与补界后窗口对齐 | 6 月行重述（见下注） |

### C 组：纯 data 重录（question/SQL 不动）

| idx | 域/pattern | 改了什么 | 为何 |
|---|---|---|---|
| 11 | inventory/aging_structure | data 重录（3 行不变，仅 202606 行值变） | 202606 被上游重述（-6,087 万，精确复核见下） |
| 30 | sales-performance/org_monthly_achievement | data 重录（6 行不变，仅 2026-06 行值变） | 6 月录制时部分入库（11.7M→80.8M，精确复核见下） |

## data 重录前后差异注记（关键值）

- **idx 11（202606 行）**：total_amount 1,472,667,069.96 → 1,411,793,189.67（**-60,873,880 = -6,087.4 万**，与金点子轮发现的 -6,087 万精确吻合）；total_qty 9,463.0 万→9,412.6 万；长库龄占比 32.30%→33.11%；各库龄段金额同步重述。202604/202605 两行字节不变。
- **idx 30（2026-06 行）**：total_achievement 11,712,138.82 → 80,836,718.80（**11.7M→80.8M**，与 REJUDGE 预告精确吻合）；notax_amt 1,024 万→7,037 万；sales_area 4,568.80→21,315.61。其余 5 行不变。
- **idx 0（2026-06 行）**：total_amount -26,142,233.40 → 1,337,047,071.25（6 月费用晚入账重述，+13.6 亿）；1-5 月五行值不变。
- **idx 9（2026 年行）**：total -1,063,703,726 → -1,079,403,230（-1,570 万）；cc_cnt 4,104→4,581；acct_cnt 497→507（年内新增成本中心/科目入账）。2024/2025 两行不变。
- **idx 24**：2026-06 total_collection 101,411,372→628,476,060（+5.27 亿，6 月回款补录入库）；matched 97.9 万→1,359.9 万；match_rate 0.97%→2.16%；2-5 月微调（±30 万级，属正常重述）。行数恒 6。
- **idx 25（2026-06 行）**：cust_cnt 19,898→19,958；total_balance 93.13 亿→49.12 亿；current_balance 3.80 亿→-40.20 亿（6 月余额快照重算）。行数恒 6。
- **idx 20**：Top10 全量换新（06-30 真值）：Top1 上海东鹏陶瓷余额 3.89 亿；广东东鹏控股逾期 178.2 亿入列（overdue 列含集团内部大额）。
- **idx 21**：仅 06-07→06-30 行换值：total_balance 26.33 亿→56.12 亿、overdue_pct 388.84%→528.94%；其余三快照日行字节不变。
- **idx 22**：五段账龄全量重录（如 d_731_1460 35.2 万→33.45 亿）。
- **idx 26**：未分类行 cust_cnt 19,092→19,155、balance 35.48 亿→27.43 亿、total_devalue 100.95 亿→102.14 亿；"陶瓷客户（含自动运费）"行微调。
- **idx 23**：0 行→10 行；Top1 As American Inc（北美组）逾期 1,844.67 万、占比 100%。

## 计划内校验偏离说明

任务预期 idx 0/9/24 "data 应与现存一致"，实测 fresh 与录制值存在真实重述（上注）。按"数据集=fresh DWS 真值"纪律一并重录（脚本 verify 分支），未沿用过期录制值。三场景 row_count 均未变（6/3/6），checksum 无需动。

## 未动条目及原因

- idx 21/23/24/25 的 elapsed_ms：任务未列重录，保留录制基线（A 组仅 idx 20/22/26 按任务重录 elapsed_ms：105→187 / 52→67 / 138→178）。
- 其余 74 个场景：parse 级断言逐条 byte-identical；meta 不变。
- 红队 6 条（idx 71-76）：无 SQL 锚点，本轮范围外。
- idx 28（analysis_wbs，calmonth='2026-06'）：锚点未消失，run_eval PASS（25s 慢查询为该表常态，非本轮范围）。

## 完成后验证（全部通过）

- `python -m pytest eval/ -v`：**94 passed**（与基线一致）。
- `python run_eval.py ar`：**10/10 PASS**；`fin-cost`：**10/10 PASS**；`inventory`：**15/15 PASS**；`sales-performance`：**27/27 PASS**（后两域因 idx 11/30 触及一并回归）。
- 全量 parse 断言：85 场景数不变；仅 11 个目标场景的 question/sql/data/row_count/elapsed_ms/checksum 六类字段变化；domain/pattern 零变化。
- 字节形态：无 BOM、CRLF-only（lone LF=0）、尾换行保持；git diff 180 insertions / 109 deletions，全部 hunk 落在 11 个目标场景 span 内。
