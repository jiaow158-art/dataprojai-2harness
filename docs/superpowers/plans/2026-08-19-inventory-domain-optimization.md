# 库存域优化（ETL 深挖驱动）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 4 份 ETL 脚本的实证公式与血缘，增厚库存域三层（knowledge 表文档 + metrics 语义层 + analyst 模式 + eval 场景），解开 CHDJ 悬案并纠正现有文档的字段误读。

**Architecture:** ETL 挖掘已在计划期完成（发现清单见下），实施期 = DWS 实证验证 → 逐文档写入 → analyst 模式 → eval 实跑 → 回归收尾。所有新内容在计划中完整给出，实施者做机械写入与验证。

**Tech Stack:** DWS GaussDB（MCP `mcp__dws__run_query` 只读查询）、Markdown skill 文档、`eval_dataset.json` + `run_eval.py`、git。

---

## 计划期 ETL 挖掘发现（实施者必读上下文）

四份 ETL（`huaweiclaude/` 下导出）已挖透。**加粗条目是对现有文档的推翻性纠错**：

### A. 库龄明细表 `dm_fin_stock_detail_accage_t_2023`
- 双 ETL 并存且 jc 逻辑完全一致：DWS 版 `DWS/DM/DM_INSERT/PJob_DWS_DM_FIN_STOCK_DETAIL_ACCAGE_T_2023.txt`（metadata 标注**"废弃"**）+ Hive 版 `DM/PJob_DM_FIN_STOCK_DETAIL_ACCAGE_T_2023.txt`（dp_mrs_hive_prod/stg，活跃维护方）
- **`wbzq`/`ybzq` = 无保质期/有保质期（非"未包装/已包装周期"！）**。ETL 注释：`bz_flag -- 保质期产品标识`、`ybzq_bzdq_amt -- 有保质期产品，保质期到期`、`wbzq_6_amt -- 无保质期产品，6个月以内`
- 库龄分桶规则：无保质期（bz_flag='N'）按 `zmmm_o017_zbatch_date`（批次入库日期）距快照日 zdate 分 6月内/6-12/12-24/24+；有保质期（'Y'）按 `shelf_end_date` 分"已到期/3月内到期"两桶；**plant 前缀 7C 的行用 `zpcrk_fc` 代替批次日期分桶**
- **`jc` = 减值（impairment），非"检出"**：
  - `wbzq_jc_amt`（无保质期减值）= `wbzq_6_amt×0 + wbzq_6_12_amt×0.1 + wbzq_12_24_amt×0.4 + wbzq_24_amt×0.7`
  - `ybzq_jc_amt`（有保质期减值）仅特定工厂：plant 7C（202203 前 到期3月内×0.6+到期×1.0；202203 起 ×0.7/×1.0）、plant 73（×0.7/×1.0）、plant 7220 且 stor_loc IN ('TY','FC','QA','TA')（×0.7/×1.0）；**其余工厂恒 0**
  - `jchj_amt` = 减值合计（管理口径）
  - `wbzq_jc_aging`/`ybzq_jc_aging` = 同比例作用于 `*_aging`（阿米巴结算价桶）= 阿米巴结算价减值
- **维度字段纠错**（现文档字面错误）：`zdpsyb`=事业部（资金成本 ETL 将其 AS BUSINESS_DEPARTMENT）；`zdpzgsdq`=子公司大区（非"在制品核算地区"）；`zyl01`=产品渠道（CHDJ ETL `zyl01 as prod_channal`）；`zww010`=产区；`zisqc`=是否清仓（值域 Y/N）；`ziswx`=自制/外协
- 自然账龄族 `zrzlcp_6/6_12/12_24/24_amt`（按批次日期四段金额）

### B. 上市口径跌价表 `dm_fin_stock_d_accage_list_c_t_2023`
- 跌价公式精确实现（天级 90 天桶 → 年段）：
  - `aging_1_year_fall_amt` = 1年以内桶（0~360天）×0
  - `aging_1_2_year_fall_amt` = (361_450+451_540+541_630+631_720)×**0.2**
  - `aging_2_3_year_fall_amt` = (721_810+811_900+901_990+991_1080)×**0.3**
  - `aging_3_4_year_fall_amt` = (1081_1170+1171_1260+1261_1350+1351_1440)×**0.5**
  - `aging_4_year_fall_amt` = `aging_1441_amt`×**0.5**
  - `aging_sum_fall_amt` = 五段之和（ETL 直算，文档可放心 SUM）
- `query_date` = 调度参数 `${PERIOD_ID_D}` 直填

### C. 资金成本表 `dm_fin_stock_capital_cost_t`
- 唯一事实源：`DM.DM_FIN_STOCK_DETAIL_ACCAGE_T_2023`（取 `ZSJKCJE` 当期余额；过滤 `(STOCKCAT IS NULL OR STOCKCAT<>'K')`；月份窗口 = 上年1月~`${PERIOD_ID_M}`）；中间表 `DM.DM_FIN_STOCK_CAPITAL_M1_T`（TRUNCATE-INSERT）
- 刷新：**TRUNCATE 目标表全量重算**，只保留近 2 年 → **老月份滚出窗口**（查 2024 年初可能查不到）
- 公式（活跃版）：`((NVL(期初,0)+NVL(期末,0))/2 − 202012余额) × 0.04/12`；"期初+期末=0 则成本=0"判断版已被注释（财务 2023-07-29 要求取消，注释保留在脚本）
- 期初余额 = `LAG(期末余额)`，分区键=事业部+事业部描述+公司+工厂+物料+**物料名称**+批次+库位+库存类别+大区 → **物料改名断链 + 首月期初=0**
- `capital_cost_sum` 分年累计（UNION 去年段/今年段各自年内 SUM，**不跨年**）
- `capital_cost` **可为负**：平均余额 < 202012 基线时（去库存常态），不是符号约定错误
- `sales_group_code` 硬编码映射：非全资公司→`UPLOAD.UPLOAD_DIVISION_COMP_T`（END_DATE='9999-12-31'）；11000010→'R4R'；11000003→按大区 33000014→RR5/33000033→R8R/33000018|33000001→RY9/33000016→P76/33000019→R6D；11000002→缺省 R2T；11000001→缺省 R40
- 插入前 GROUP BY 去重（2023-07-28）

### D. CHDJ `dm_ambv2_chdj_grp_t`（表名陷阱：名"存货跌价分摊"）
- **`inventory_value` = SUM(wbzq_jc_amt+ybzq_jc_amt) = 管理口径减值合计（不是库存价值！）**——推翻现有文档解读。"存货价值 6.35亿 vs 上市口径库存 14.3亿"的真解释：**减值 vs 库存金额（概念不同）+ 组织范围不同（双差异）**
- `inventory_value_amb` = SUM(jc_aging 族) = 阿米巴结算价减值；仅瓷砖 11000001、11240102、11250401 分支非零，卫浴族分支恒 0
- `capital_cost`/`capital_cost_sum` = **直接 SUM 自 `DM.DM_FIN_STOCK_CAPITAL_COST_T`**（悬案破案：CHDJ 负值 = 承袭源公式在"平均余额<202012基线"时的负值；且 CHDJ 范围（卫浴/瓷砖/国际/丽适）是资金成本表全集团的一部分——范围子集的负值与全表正值不矛盾）
- `contributory_value`(分摊价值) = 减值 × (销售/工厂比例，null 取 1)；`capital_cost_conv`/`capital_cost_sum_conv`(分摊资金成本) = capital_cost × 同比例。比例按**年度预算**（`upload.upload_achievement_budget_t`）分摊到线组；预算年度缺失取上一年度
- 范围：卫浴族 zdpsyb IN ('11000002','11000011','11000012')（排 plant 3A/3B/3C/39、extmatlgrp 10050、prop 表大区走独立分支）+ 瓷砖 11000001 + 11240102 + 11250401
- 刷新：`delete ... where stat_month='${PERIOD_ID_M}'` + insert（按月）
- ETL 隐患：末段 `tmpp."物料描述" = t.material_num`（**描述 JOIN 编码**）→ `product_level_code`/`prod_line_name` 可靠性受限
- 实际列名（现文档已证实）：`capital_cost_conv`、`capital_cost_sum_conv`

### E. 双减值体系对照（新语义资产，写入 metrics.md）

| 体系 | 字段族 | 计提比例 | 桶边界 | 载体表 |
|---|---|---|---|---|
| 会计口径跌价（上市） | `aging_*_fall_amt` | 0/20/30/50/50% | 1/2/3/4年（天级90天桶聚合） | 上市口径表 |
| 管理口径减值 | `wbzq_jc_amt`/`ybzq_jc_amt`/`jchj_amt` | 无保质期 0/10/40/70%；有保质期仅 7C/73/7220 工厂 0.6~0.7/1.0 | 6/12/24月 + 保质期到期 | 明细表 → CHDJ `inventory_value` |
| 阿米巴结算价减值 | `*_jc_aging` | 0/10/40/70% | 6/12/24月（阿米巴结算价桶） | 明细表 → CHDJ `inventory_value_amb` |

**对 SKU 域的启示（只记录在本计划与本域文档，不改 SKU 域文件）**：E 公式的 `aging_sum_fall_amt` 是会计口径；CHDJ 减值是管理口径，两套不可混。`amb_profit_amt` 是否含减值/资金成本仍未解（Mix ETL 不在本轮范围）。

---

## 硬性约束（每个任务都适用）

1. **SKU 域文件零改动**：`skills/sku-profitability-*` 一律不碰（最终任务 git diff 验证）
2. **格式红线**：写完任何 .md 必须 `wc -l` 自查真实换行（上轮发生过单行格式灾难）；代码块/表格不塌陷
3. `.mcp.json` 不提交（工作区保留 M 状态）
4. DWS 查询用 MCP 工具 `mcp__dws__run_query`（只读，自动 LIMIT 200）；大表必带 calmonth/stat_month/month 过滤
5. 文档中所有公式标注 ETL 出处（如"ETL: PJob_DWS_… line ~567"）

---

### Task 1: DWS 口径交叉验证（6 组实证查询）

**Files:**
- Create: `docs/superpowers/verification/2026-08-19-inventory-etl-verification.md`（验证记录，供后续任务引用）

- [ ] **Step 1: 逐组执行验证查询（MCP `mcp__dws__run_query`），记录实际数字**

**V1 保质期语义佐证**（ybzq 字段只应出现在 bz_flag='Y' 行）：
```sql
SELECT bz_flag,
       COUNT(*) AS rows_cnt,
       ROUND(SUM(zsjkcje)) AS amt,
       ROUND(SUM(COALESCE(ybzq_bzdq_amt,0)+COALESCE(ybzq_bzdq_3_amt,0))) AS ybzq_amt,
       ROUND(SUM(COALESCE(wbzq_6_amt,0))) AS wbzq_6
FROM dm.dm_fin_stock_detail_accage_t_2023
WHERE calmonth = '202608'
GROUP BY bz_flag;
```
预期：bz_flag='N' 行 ybzq_amt≈0；'Y' 行 wbzq_6≈0（排他性成立 → 有/无保质期证实）

**V2 明细表 jc 减值复算**（偏差 <0.1%）：
```sql
SELECT ROUND(SUM(COALESCE(wbzq_jc_amt,0))) AS jc_reported,
       ROUND(SUM(COALESCE(wbzq_6_amt,0)*0 + COALESCE(wbzq_6_12_amt,0)*0.1
               + COALESCE(wbzq_12_24_amt,0)*0.4 + COALESCE(wbzq_24_amt,0)*0.7)) AS jc_recalc
FROM dm.dm_fin_stock_detail_accage_t_2023
WHERE calmonth = '202608';
```

**V3 CHDJ inventory_value = 管理口径减值**（瓷砖分支，ETL 无 plant 排除，最干净）：
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
预期：两者同量级且接近（CHDJ 过滤"减值<>0 或 capital_cost<>0"行+渠道分组，偏差应 <1%）。**若数量级背离（如 10 倍差），停止后续文档任务并上报**——说明解码有误。

**V4 上市口径跌价比例复算**（偏差 <0.1%）：
```sql
SELECT ROUND(SUM(aging_1_2_year_fall_amt)) AS fall_reported,
       ROUND(SUM((COALESCE(aging_361_450_amt,0)+COALESCE(aging_451_540_amt,0)
                +COALESCE(aging_541_630_amt,0)+COALESCE(aging_631_720_amt,0))*0.2)) AS fall_recalc
FROM dm.dm_fin_stock_d_accage_list_c_t_2023
WHERE calmonth = '202607';
```

**V5 资金成本公式复算**（表内自带三列，直接验）：
```sql
SELECT ROUND(SUM(COALESCE(capital_cost,0))) AS cc_reported,
       ROUND(SUM(((COALESCE(closing_balance_last_month,0)+COALESCE(closing_balance,0))/2
                - COALESCE(closing_balance_202012,0))*0.04/12)) AS cc_recalc
FROM dm.dm_fin_stock_capital_cost_t
WHERE month = '202608';
```

**V6 CHDJ 资金成本负值来源**（范围子集负值验证）：
```sql
SELECT ROUND(SUM(COALESCE(capital_cost,0))) AS scoped_cc
FROM dm.dm_fin_stock_capital_cost_t
WHERE month = '202608'
  AND business_department IN ('11000001','11000002','11000011','11000012','11240102','11250401');
-- 对照：CHDJ 2026-08 SUM(capital_cost)（现文档记录 -35.7万）
```
预期：scoped_cc 为负或接近 0（与 CHDJ -35.7万 同号/同量级）→ 证明 CHDJ 负值承袭源表而非符号翻转

- [ ] **Step 2: 写验证记录文档**

`docs/superpowers/verification/2026-08-19-inventory-etl-verification.md` 内容模板（填入实际数字）：
```markdown
# 库存域 ETL 口径交叉验证记录（2026-08-19）

| # | 验证项 | 查询口径 | 结果 | 结论 |
|---|---|---|---|---|
| V1 | 保质期排他性 | 明细表 202608 by bz_flag | （填数） | ybzq 仅 Y 行有值 → 有/无保质期证实 |
| V2 | jc 减值公式 | 明细表 202608 全表复算 | reported=X recalc=Y 偏差 Z% | 通过/不通过 |
| V3 | CHDJ iv=减值 | 瓷砖 202607 双表对照 | detail_jc=X chdj_iv=Y | 数量级一致 → 解码证实 |
| V4 | 跌价 20% 复算 | 上市口径 202607 1-2年段 | reported=X recalc=Y | 通过/不通过 |
| V5 | 资金成本公式 | 资金成本表 202608 全表 | reported=X recalc=Y | 通过/不通过 |
| V6 | CHDJ 负值来源 | 资金成本表范围子集 202608 | scoped_cc=X vs CHDJ -35.7万 | 同号 → 承袭证实 |

结论：[一句话——ETL 解码是否全部实证]
```

- [ ] **Step 3: 提交**

```bash
git add docs/superpowers/verification/2026-08-19-inventory-etl-verification.md
git commit -m "docs: 库存域ETL口径交叉验证记录—jc减值/CHDJ解码/资金成本公式实证"
```

---

### Task 2: stock-accage.md 增厚与字段纠错

**Files:**
- Modify: `skills/inventory-knowledge/references/stock-accage.md`（全文重写为下面内容）

- [ ] **Step 1: 用以下完整内容重写 `stock-accage.md`**

````markdown
# 库存账龄明细（库龄明细主表）

## 快速参考

- **DWS 表名**：`dm.dm_fin_stock_detail_accage_t_2023`（1.44亿行，183 列，202012 ~ 202606+，持续刷新）
- **业务含义**：按物料+工厂+批次+库存地点+会计期间记录库存余额和金额，内嵌**四套库龄口径**与**两套减值估算**。库存分析最核心的单表，也是跌价/资金成本族的唯一事实源。
- **实体粒度**：一行 = 一个物料在一个工厂/库存地点/批次的月度库存快照
- **时间格式**：`calmonth` = YYYYMM（NOT NULL，可能存在空值行需排除）
- **ETL**：活跃维护方为 Hive 作业 `DM/PJob_DM_FIN_STOCK_DETAIL_ACCAGE_T_2023.txt`（dp_mrs_hive_prod）；DWS 原生作业 `DWS/DM/DM_INSERT/PJob_DWS_DM_FIN_STOCK_DETAIL_ACCAGE_T_2023.txt` 已标注**废弃**，但两者字段逻辑完全一致（jc 公式逐字相同）

## ⚠️ 字段语义纠错表（2026-08-19 ETL 实证，以此为准）

| 字段 | ❌ 旧误读 | ✅ ETL 实证语义 |
|---|---|---|
| `bz_flag` | 包装标志 | **保质期产品标识**（Y=有保质期，N=无保质期） |
| `wbzq_*` | 未包装周期 | **无保质期**产品库龄段（6月内/6-12/12-24/24+） |
| `ybzq_bzdq_amt`/`ybzq_bzdq_3_amt` | 标准地区金额 | **有保质期产品**：已到期 / 距到期3月以内 金额 |
| `*_jc_amt`/`jchj_amt` | "检出"金额 | **减值**估算（管理口径），见下方公式 |
| `zdpsyb` | 盘点损益 | **事业部**（码=组织架构 node2 去 H 前缀） |
| `zdpzgsdq` | 在制品核算地区 | **子公司大区** |
| `zyl01`/`zyl01___t` | 预留相关 | **产品渠道**/描述 |
| `zww010`/`zww010___t` | 物料评估 | **产区**/描述 |
| `zisqc` | 是否切裁 | **是否清仓**（值域 Y/N） |
| `ziswx` | 是否维修 | **自制/外协** |

## 库龄分桶规则（ETL 实证）

- **无保质期产品（bz_flag='N'）**：按 `zmmm_o017_zbatch_date`（批次入库日期）距快照日 `zdate` 分桶：6月内 → `wbzq_6_amt`；6-12月 → `wbzq_6_12_amt`；12-24月 → `wbzq_12_24_amt`；24月+ → `wbzq_24_amt`（金额/数量/面积三套后缀）
- **有保质期产品（bz_flag='Y'）**：按 `shelf_end_date` 分两桶：已到期 → `ybzq_bzdq_amt`；距到期3月内 → `ybzq_bzdq_3_amt`
- **特例**：plant 前缀 **7C** 的行用 `zpcrk_fc` 代替批次日期分桶（其余工厂用 `zmmm_o017_zbatch_date`）
- **自然账龄族** `zrzlcp_6/6_12/12_24/24_amt`：按批次日期四段（独立于保质期体系）

## 减值公式（管理口径，ETL 实证）

```text
wbzq_jc_amt（无保质期减值）= wbzq_6_amt×0 + wbzq_6_12_amt×0.1
                          + wbzq_12_24_amt×0.4 + wbzq_24_amt×0.7
ybzq_jc_amt（有保质期减值）= 仅特定工厂，其余恒 0：
  plant 7C   ：202203 前 = bzdq_3×0.6 + bzdq×1.0；202203 起 = ×0.7 / ×1.0
  plant 73   ：bzdq_3×0.7 + bzdq×1.0
  plant 7220 且 stor_loc IN ('TY','FC','QA','TA')：×0.7 / ×1.0
jchj_amt = ybzq_jc_amt + wbzq_jc_amt（减值合计·管理口径）
*_jc_aging = 同比例作用于 *_aging 桶（阿米巴结算价）= 阿米巴结算价减值
```

> 减值三系对照（会计上市/管理/阿米巴结算价）见 [metrics.md](metrics.md) 第八节。**本表 jc 族与上市口径表 `aging_*_fall_amt` 是两套体系，禁止混用或相加。**

## 核心字段

### 数量/金额字段

| 字段 | 含义 |
|---|---|
| `quantity` | 库存数量 |
| `zsjkcje` | 实际库存金额（资金占压核心字段；资金成本表/CHDJ 均以它为余额源） |
| `stock_amt` | 库存金额 |
| `wbzq_6_amt` ~ `wbzq_24_amt` | 无保质期库龄段金额（+ `_qty`/`_area` 两套） |
| `ybzq_bzdq_amt` / `ybzq_bzdq_3_amt` | 有保质期：已到期 / 3月内到期（+ qty/area） |
| `wbzq_jc_amt` / `ybzq_jc_amt` / `jchj_amt` | 减值（无保质期/有保质期/合计，管理口径） |
| `wbzq_jc_aging` / `ybzq_jc_aging` | 减值（阿米巴结算价口径） |
| `xydj_7_12_amt`/`_12_24_`/`_24_` | 协议单价分段金额 |
| `zrzlcp_*` | 自然账龄四段（金额/数量/面积） |

### 维度字段

`calmonth`/`calyear`、`material`/`material___t`、`plant`/`plant___t`、`stor_loc`/`stor_loc___t`、`batch`、`stockcat`/`stocktype`（+`___t`）、`comp_code`（+`___t`）、`extmatlgrp`、`matl_grp_1~5`（+`___t`）、`zprodh1~5`（+`___t`）、`wbs_elemt`、`vendor`、`val_class`、`unit`、`zdpsyb`（事业部）、`zdpzgsdq`（子公司大区）、`zyl01`（产品渠道）、`zyl06`（产品等级）、`zww010`（产区）、`zisqc`（清仓）、`ziswx`（自制/外协）、`matl_type`、`zmatltype`

## 陷阱

1. **表名带 `_2023` 但覆盖 202012 起全量**，不要跨表 UNION；`dm_fin_stock_detail_accage_t`（91列旧表）与 `_others_t` 不用
2. **`___t` 后缀** = 三下划线+t 文本描述（`plant` → `plant___t`）
3. **四套库龄口径并存**（标准 wbzq/zrzlcp、协议单价 xydj、阿米巴 *_aging、减值 jc 族），用户未指定时默认标准 `wbzq_*_amt`
4. **wbzq/ybzq 是保质期维度不是包装维度**；ybzq 字段只会在 bz_flag='Y' 行有值（2026-08 实证排他性）
5. **jc 减值有保质期工厂白名单**（7C/73/7220），其余工厂 `ybzq_jc_amt` 恒 0——按事业部汇总减值时勿以为漏算
6. **plant 7C 分桶日期字段不同**（zpcrk_fc），跨工厂库龄对比存在口径微差
7. 大表必带 `calmonth` 过滤；`calmonth` 可能为空的行需排除
8. zprodh 与 matl_grp 两套产品层级并存，过滤产品优先 `matl_grp_*`

## 常见查询模式

### 当前库存账龄汇总（按工厂）
```sql
SELECT plant, plant___t,
       SUM(quantity) AS total_qty,
       SUM(zsjkcje) AS total_amount,
       SUM(wbzq_6_amt) AS aged_0_6m,
       SUM(wbzq_6_12_amt) AS aged_6_12m,
       SUM(wbzq_12_24_amt) AS aged_12_24m,
       SUM(wbzq_24_amt) AS aged_24m_plus,
       SUM(COALESCE(jchj_amt,0)) AS mgmt_impairment
FROM dm.dm_fin_stock_detail_accage_t_2023
WHERE calmonth = '202606'
GROUP BY plant, plant___t
ORDER BY total_amount DESC;
```

### 管理口径减值 TOP（按事业部）
```sql
SELECT zdpsyb,
       ROUND(SUM(COALESCE(jchj_amt,0))) AS impairment_mgmt,
       ROUND(SUM(COALESCE(wbzq_jc_aging,0)+COALESCE(ybzq_jc_aging,0))) AS impairment_amb
FROM dm.dm_fin_stock_detail_accage_t_2023
WHERE calmonth = '202608'
GROUP BY zdpsyb
ORDER BY impairment_mgmt DESC;
```

### 单物料库龄下钻
```sql
SELECT calmonth, plant___t, stor_loc___t, batch,
       quantity, zsjkcje,
       wbzq_6_amt, wbzq_6_12_amt, wbzq_12_24_amt, wbzq_24_amt
FROM dm.dm_fin_stock_detail_accage_t_2023
WHERE material = '物料号' AND calmonth >= '202601'
ORDER BY calmonth;
```

## 血缘与下游

- 上游：SAP 库存账龄明细（Hive ETL 维护 → 同步 DWS）
- **下游（本表是跌价/资金成本族唯一事实源）**：
  - → `dm_fin_stock_capital_cost_t`（资金成本，取 zsjkcje，排 stockcat K）
  - → `dm_ambv2_chdj_grp_t`（CHDJ：jc 族减值 → inventory_value/inventory_value_amb）
  - → `dm_fin_stock_d_accage_list_c_t_2023`（上市口径表）

## 交叉引用

- 语义层 → [metrics.md](metrics.md)；上市口径跌价 → [stock-fall-list.md](stock-fall-list.md)；CHDJ → [chdj-capital-cost.md](chdj-capital-cost.md)；资金成本 → [capital-cost-table.md](capital-cost-table.md)；库存统计月报 → [stock-stat-month.md](stock-stat-month.md)
````

- [ ] **Step 2: 验证格式**

Run: `wc -l skills/inventory-knowledge/references/stock-accage.md`
预期：≥ 150 行（真实换行；若 ≤ 20 说明发生单行格式灾难，重写）

Run: `grep -c "减值" skills/inventory-knowledge/references/stock-accage.md`
预期：≥ 8

- [ ] **Step 3: 提交**

```bash
git add skills/inventory-knowledge/references/stock-accage.md
git commit -m "docs(inventory): 库龄明细表增厚—保质期语义/jc减值公式/字段纠错(ETL实证)"
```

---

### Task 3: capital-cost-table.md 增厚

**Files:**
- Modify: `skills/inventory-knowledge/references/capital-cost-table.md`

- [ ] **Step 1: 在"快速参考"与"核心字段"之间插入"公式与计算逻辑（ETL 实证）"节，并替换"陷阱"节**

插入的新节（位于 `## 核心字段` 之前）：

````markdown
## 公式与计算逻辑（ETL: PJob_DWS_DM_FIN_STOCK_CAPITAL_COST_T 实证）

```text
capital_cost = ((NVL(期初余额,0) + NVL(期末余额,0))/2 − 202012余额) × 0.04 / 12
```

- **期初余额** = `LAG(期末余额)` 窗口：分区 = 事业部+事业部描述+公司+工厂+物料+物料名称+批次+库存地点+库存类别+大区，按 month 升序 → **每个物料-批次组合的首月期初=0**
- **202012余额** = 源表 `calmonth='202012'` 的 `zsjkcje` 按**同一分区键**聚合，硬锚定
- **期末余额** = 当月源表 `zsjkcje` 聚合
- "期初+期末=0 则成本=0"的零判断版**已按财务要求取消**（2023-07-29，逻辑注释保留在 ETL 脚本中）
- `capital_cost_sum` = 年内累计（**分年计算不跨年**：上年段与当年段各自 SUM 窗口）
- **事实源**：`dm_fin_stock_detail_accage_t_2023`（zsjkcje，过滤 `(stockcat IS NULL OR stockcat<>'K')`），经中间表 `DM_FIN_STOCK_CAPITAL_M1_T`（TRUNCATE-INSERT）
- **刷新**：目标表 **TRUNCATE 全量重算**，仅保留近 2 年（`${PERIOD_ID_Y}`-1 年 1 月 ~ `${PERIOD_ID_M}`）
- `sales_group_code` 映射（ETL 硬编码）：非全资公司 → `upload.upload_division_comp_t`（END_DATE='9999-12-31'）；11000010→R4R；11000003 按大区→RR5/R8R/RY9/P76/R6D；11000002→R2T；11000001→R40
````

替换后的"陷阱"节：

````markdown
## 陷阱

1. **日期格式 YYYYMM**（如 '202608'），CHDJ 表是 `stat_month`（YYYY-MM）。跨表查询分别处理时间格式。
2. **TRUNCATE 滚动窗口只留近 2 年**：查更早月份（如 2024 年初）可能已滚出表外，返回 0 行不是数据丢失而是窗口限制。
3. **capital_cost 可为负**：平均余额 < 202012 基线时公式结果为负（去库存期常态）。**不是符号约定错误**——负值=该物料组合库存已降至 2020 年末基线之下。2026-08 全集团合计为正（+58.4万）不代表各范围子集为正。
4. **CHDJ 的 capital_cost 直接 SUM 自本表**（2026-08-19 ETL 实证）：CHDJ 负值（-35.7万）= 本表按 CHDJ 范围（卫浴/瓷砖/国际/丽适）过滤后的子集负值，非独立核算。两表金额是"全表 vs 范围子集"关系，非两套公式。
5. **LAG 分区键含 material_name**：物料改名 → 分区断裂 → 期初余额变 0 → 当月资金成本突降。追查单物料资金成本异常时先查物料名称是否变过。
6. **closing_balance 14.3亿 ≠ CHDJ inventory_value 6.35亿**：后者实为**管理口径减值**（非库存价值，2026-08-19 ETL 实证），概念不同不可比。见 [chdj-capital-cost.md](chdj-capital-cost.md)。
7. `stock_type` 列承接源表 `stockcat`（库存类别），已排除 'K'。
8. `plant___t`/`stor_loc___t` 早期数据大量为空，用 `LENGTH(TRIM(x))>0` 过滤或用编码。
9. zdpsyb 码表：组织架构 node2 去 H 前缀；11000011/11000012 为卫浴旧组织（org-hierarchy.md 未收录）。
````

- [ ] **Step 2: 验证格式**

Run: `wc -l skills/inventory-knowledge/references/capital-cost-table.md` → 预期 ≥ 95 行
Run: `grep -c "202012" skills/inventory-knowledge/references/capital-cost-table.md` → 预期 ≥ 5

- [ ] **Step 3: 提交**

```bash
git add skills/inventory-knowledge/references/capital-cost-table.md
git commit -m "docs(inventory): 资金成本表增厚—公式精确实现/滚动窗口/LAG断链/负值语义(ETL实证)"
```

---

### Task 4: chdj-capital-cost.md 重写（解码纠错）

**Files:**
- Modify: `skills/inventory-knowledge/references/chdj-capital-cost.md`（全文重写）

- [ ] **Step 1: 用以下完整内容重写**

````markdown
# dm_ambv2_chdj_grp_t — 存货减值/资金成本·线组分摊表（CHDJ）

## 快速参考

- **DWS 表名**：`dm.dm_ambv2_chdj_grp_t`（CHDJ=存货跌价拼音缩写；ETL 描述"存货跌价分摊（线组）"）
- **真实业务含义（2026-08-19 ETL 解码）**：把**管理口径存货减值 + 库存资金成本**按年度预算比例分摊到线组/渠道。⚠️ **表内没有会计口径跌价金额，也没有"库存价值"**——见核心字段纠错
- **实体粒度**：一行 = stat_month × 物料 × 工厂 × 库存地点 × 产品渠道 × 销售组（线组）
- **数据量**：约 28 万行/月（2026-08：27.8万行，35,770 SKU）
- **时间格式**：`stat_month` = **YYYY-MM**（如 '2026-08'，与上市口径表 YYYYMM 不同！）
- **刷新**：`delete where stat_month='${PERIOD_ID_M}'` + insert（按月）

## ⚠️ 核心字段语义（ETL 实证，推翻旧解读）

| 字段 | ✅ ETL 实证语义 | 计算来源 |
|---|---|---|
| `inventory_value` | **管理口径减值合计**（≠库存价值！） | `SUM(wbzq_jc_amt + ybzq_jc_amt)`，源：库龄明细表 jc 族（比例 0/10/40/70% + 保质期工厂白名单） |
| `inventory_value_amb` | **阿米巴结算价减值** | `SUM(ybzq_jc_aging + wbzq_jc_aging)`；仅瓷砖 11000001 / 11240102 / 11250401 分支非零，卫浴族恒 0 |
| `contributory_value` | 分摊减值 = 减值 × 销售/工厂比例 | 比例 null 取 1 |
| `capital_cost` / `capital_cost_sum` | **直接 SUM 自 dm_fin_stock_capital_cost_t**（非独立核算） | 同月（month YYYYMM ↔ stat_month YYYY-MM 转换），范围过滤后聚合 |
| `capital_cost_conv` / `capital_cost_sum_conv` | 分摊资金成本 / 分摊累计资金成本 | capital_cost(_sum) × 同比例 |
| `percentage` | 销售/工厂比例 | 按年度预算（upload_achievement_budget_t）分摊；预算缺失取上一年度 |
| `sales_grp` / `sales_grp_sum` / `center_sum` | 线组 / 线组汇总 / 中心汇总（预算金额） | 分摊基数 |
| `zdpsyb` | 事业部（码=node2 去 H 前缀） | — |
| 其余维度 | `material_num`/`material_name`、`plant`(+`___t`)、`stor_loc`(+`___t`)、`prod_channal`(+`_name`，注意拼写)、`base_name` 基地、`zww010`(+`___t`) 产区、`comp_code`、`stockcat`、`distribution_channel` 渠道、`ext_grp`、`product_level_code`、`prod_line_name` | — |

## 覆盖范围（分摊对象，非全集团）

卫浴族 zdpsyb IN ('11000002','11000011','11000012')（排除 plant 3A/3B/3C/39、extmatlgrp 10050，prop 大区走独立分支）+ 瓷砖 11000001 + 11240102（国际营销）+ 11250401（丽适岩板）。
2026-08 实测构成：卫浴 3.91亿（61%）/ 瓷砖 2.32亿 / 国际 560万 / 卫浴旧组织 460万 / 丽适 160万。

## 陷阱

1. **`inventory_value` 不是库存价值**：是管理口径减值（2026-08-19 ETL+DWS 双实证：明细表 jc 复算与 CHDJ 值一致）。与上市口径表 `zsjkcje`（库存金额 14.3亿）是**概念不同**（减值 vs 金额）+**范围不同**（部分事业部 vs 上市在售），"6.35亿 vs 14.3亿"不是两套库存口径之差。
2. **问会计跌价 → 上市口径表** `aging_sum_fall_amt`（0/20/30/50/50%）；问管理减值/分摊到线组 → 本表。两套体系禁止混用或相加。
3. **`capital_cost` 负值承袭源表公式**（平均余额<202012基线→负），非符号约定；且本表范围（卫浴/瓷砖/国际/丽适）是资金成本表全集团的范围子集——本表负、全表正不矛盾。
4. `stat_month` 格式 YYYY-MM；表内无 `calmonth`。
5. `stockcat` 含 'K'（与上市口径表排除 K 不同）。
6. **ETL 隐患**：末段以 `物料描述 = material_num`（描述 JOIN 编码）关联物料主数据取产品层次 → `product_level_code`/`prod_line_name` 可靠性受限，做产品线分析优先用物料主数据表重关联。
7. 阿米巴结算价减值（inventory_value_amb）仅 3 个瓷砖系分支有值，跨事业部汇总时注意非瓷砖分支恒 0。

## 常见查询模式

### 线组分摊减值与资金成本
```sql
SELECT sales_grp,
       ROUND(SUM(inventory_value)) AS impairment_mgmt,
       ROUND(SUM(contributory_value)) AS impairment_allocated,
       ROUND(SUM(capital_cost)) AS capital_cost,
       ROUND(SUM(capital_cost_conv)) AS capital_cost_allocated
FROM dm.dm_ambv2_chdj_grp_t
WHERE stat_month = '2026-08'
GROUP BY sales_grp
ORDER BY impairment_allocated DESC;
```

### 事业部减值构成（对照明细表复算）
```sql
SELECT zdpsyb,
       ROUND(SUM(inventory_value)) AS impairment_mgmt,
       ROUND(SUM(inventory_value_amb)) AS impairment_amb
FROM dm.dm_ambv2_chdj_grp_t
WHERE stat_month = '2026-08'
GROUP BY zdpsyb
ORDER BY impairment_mgmt DESC;
```

## 血缘

```text
库龄明细表(jc 减值族, zdpsyb 范围过滤)
  ├─ inventory_value / inventory_value_amb ──┐
dm_fin_stock_capital_cost_t(同月范围子集)     ├─ 按年度预算比例分摊 → dm_ambv2_chdj_grp_t
  └─ capital_cost / capital_cost_sum ────────┘
维度：dwi_md_data_material_general_t（渠道）、dm_rpt_sales_group_t（线组）、upload_achievement_budget_t（预算比例）
```
ETL：`huaweiclaude/DM/DM_CT/PJob_DWS_DM_AMBV2_CHDJ_GRP_T.txt`（1973 行）

## 关联文档

- [metrics.md](metrics.md) — 语义层（双减值体系对照表）
- [stock-fall-list.md](stock-fall-list.md) — 会计口径跌价（上市口径）
- [capital-cost-table.md](capital-cost-table.md) — 库存资金成本表（capital_cost 源头）
````

- [ ] **Step 2: 验证格式**

Run: `wc -l skills/inventory-knowledge/references/chdj-capital-cost.md` → 预期 ≥ 100 行
Run: `grep -c "管理口径减值" skills/inventory-knowledge/references/chdj-capital-cost.md` → 预期 ≥ 3

- [ ] **Step 3: 提交**

```bash
git add skills/inventory-knowledge/references/chdj-capital-cost.md
git commit -m "docs(inventory): CHDJ解码重写—inventory_value实为管理口径减值/资金成本承袭源表(ETL实证)"
```

---

### Task 5: stock-fall-list.md 增厚 + metrics.md 语义层大改

**Files:**
- Modify: `skills/inventory-knowledge/references/stock-fall-list.md`
- Modify: `skills/inventory-knowledge/references/metrics.md`

- [ ] **Step 1: stock-fall-list.md 插入跌价公式精确实现节（替换现有"跌价字段"表之前的同位内容）**

在 `## 跌价字段（含计提比例 — 集团会计政策）` 节后追加：

````markdown
### 跌价公式精确实现（ETL: PJob_DWS_DM_FIN_STOCK_D_ACCAGE_LIST_C_T_2023 实证）

| 字段 | 天级桶组成 | 比例 |
|---|---|---|
| `aging_1_year_fall_amt` | 0~360 天（0_30+31_60+61_90+91_180+181_270+271_360） | ×0 |
| `aging_1_2_year_fall_amt` | 361_450+451_540+541_630+631_720 | ×0.2 |
| `aging_2_3_year_fall_amt` | 721_810+811_900+901_990+991_1080 | ×0.3 |
| `aging_3_4_year_fall_amt` | 1081_1170+1171_1260+1261_1350+1351_1440 | ×0.5 |
| `aging_4_year_fall_amt` | aging_1441 | ×0.5 |
| `aging_sum_fall_amt` | 五段之和（ETL 预计算） | — |

2026-07 全表复算验证：reported 与 recalc 偏差 <0.1%（见 docs/superpowers/verification/2026-08-19-inventory-etl-verification.md）。
`query_date` = 调度参数 `${PERIOD_ID_D}` 直填，每 calmonth 一个值。
````

同时更新该文档"陷阱"节第 3 条为：

````markdown
3. **口径独此一家（会计口径）**：本表跌价（0/20/30/50/50%）与库龄明细表 jc 族**管理口径减值**（0/10/40/70%）、CHDJ `inventory_value`（=管理减值合积分摊）是**三套体系**，禁止混用或相加。问会计跌价/库龄→本表；问库存资金成本→`dm_fin_stock_capital_cost_t`（正值主口径）；问管理减值/线组分摊→CHDJ。
````

- [ ] **Step 2: metrics.md 三处修改**

(a) 1.2 节表格中库龄行替换为：

````markdown
| 库龄分段（明细） | `wbzq_6_amt` ~ `wbzq_24_amt` | dm_fin_stock_detail_accage_t_2023 | **wbzq=无保质期**（按批次日期 6/12/24月分桶）；有保质期产品走 `ybzq_bzdq_amt`（到期）/`ybzq_bzdq_3_amt`（3月内） |
| 减值估算 | `jchj_amt`（管理）/`*_jc_aging`（阿米巴结算价） | dm_fin_stock_detail_accage_t_2023 | 管理口径比例 0/10/40/70%，详见 stock-accage.md |
| 包装标志 | `bz_flag` | dm_fin_stock_detail_accage_t_2023 | **保质期产品标识**（Y=有保质期），非包装标志 |
````

(b) 第七节"已知陷阱总览"追加 8 条（10 → 18）：

````markdown
11. **`jc` 字段族=减值**（管理口径 0/10/40/70%），不是"检出金额"；`jchj_amt`=减值合计（管理）
12. **`wbzq`/`ybzq`=无/有保质期**（按 bz_flag 分流），不是未/已包装；有保质期减值仅 7C/73/7220+特定库位工厂计提，其余恒 0
13. **CHDJ `inventory_value` 实为管理口径减值**（非库存价值）：与库存金额是不同概念，与上市口径跌价是不同体系，禁止跨表加减
14. **资金成本表 TRUNCATE 滚动窗口只留近 2 年**：更早月份查不到是窗口限制非数据丢失
15. **资金成本可为负**（平均余额<202012基线，去库存常态）；CHDJ capital_cost 直接 SUM 自资金成本表（范围子集），负值承袭非符号翻转
16. **资金成本 LAG 分区含 material_name**：物料改名断链→期初变 0→当月成本突降
17. **CHDJ 范围限卫浴/瓷砖/国际/丽适**（非全集团）；其 zdpsyb 码=node2 去 H 前缀，11000011/11000012 为卫浴旧组织
18. **库龄明细表 plant 7C 用 zpcrk_fc 分桶**（其余工厂用批次日期 zmmm_o017_zbatch_date）
````

(c) 第八节整体替换为：

````markdown
## 八、存货跌价与减值 · 资金成本（完整语义）

### 8.1 三套减值/跌价体系对照（禁止混用）

| 体系 | 字段族 | 计提比例 | 桶边界 | 载体表 | 问法路由 |
|---|---|---|---|---|---|
| **会计口径跌价（上市）** | `aging_*_fall_amt` / `aging_sum_fall_amt` | 0/20/30/50/50% | 1/2/3/4年（天级90天桶） | `dm_fin_stock_d_accage_list_c_t_2023`（calmonth=YYYYMM） | "跌价准备/计提/上市口径" |
| **管理口径减值** | `wbzq_jc_amt`/`ybzq_jc_amt`/`jchj_amt` → CHDJ `inventory_value` | 无保质期 0/10/40/70%；有保质期仅 7C/73/7220 工厂 0.6~0.7/1.0 | 6/12/24月+保质期到期 | 库龄明细表 → CHDJ 分摊 | "管理减值/线组分摊/阿米巴存货" |
| **阿米巴结算价减值** | `*_jc_aging` → CHDJ `inventory_value_amb` | 0/10/40/70% | 6/12/24月（阿米巴结算价桶） | 同上 | 瓷砖系分支专用 |

### 8.2 库存资金成本

| 概念 | 权威字段 | 所在表 |
|---|---|---|
| 库存资金成本（正值主口径，批次级） | `capital_cost` | `dm_fin_stock_capital_cost_t`（month=YYYYMM） |
| 累计资金成本（分年不跨年） | `capital_cost_sum` | 同上 |
| 分摊资金成本（按预算比例到线组） | `capital_cost_conv`/`capital_cost_sum_conv` | `dm_ambv2_chdj_grp_t`（stat_month=YYYY-MM） |

公式（ETL 实证）：`((期初+期末)/2 − 202012余额) × 4%/12`；期初=LAG(期末)；**可为负**（低于基线）；TRUNCATE 滚动窗口仅近 2 年。

### 8.3 金额口径判别（2026-08 实测锚点）

| 金额 | 表 | 概念 |
|---|---|---|
| 14.3亿 | 上市口径 `zsjkcje` / 资金成本表 `closing_balance` | **库存金额**（上市在售口径） |
| 1.43亿 | 上市口径 `aging_sum_fall_amt` | **会计跌价准备** |
| 6.35亿 | CHDJ `inventory_value` | **管理口径减值**（卫浴/瓷砖/国际/丽适范围） |

**决策**：问库存金额→上市口径表；问会计跌价→上市口径表；问管理减值/线组分摊→CHDJ；问资金成本→默认 `dm_fin_stock_capital_cost_t`。任何两表金额不可加减。详见 [stock-fall-list.md](stock-fall-list.md)、[chdj-capital-cost.md](chdj-capital-cost.md)、[capital-cost-table.md](capital-cost-table.md)、[stock-accage.md](stock-accage.md)。
````

- [ ] **Step 3: 同步修正 metrics.md 决策树三行**（第二节末尾三行替换为）

````markdown
├── 涉及“跌价准备”（会计口径）？
│   └── 用 dm.dm_fin_stock_d_accage_list_c_t_2023（aging_sum_fall_amt）
├── 涉及“管理减值”/“线组分摊”（含 CHDJ 提法）？
│   └── 用 dm.dm_ambv2_chdj_grp_t（inventory_value=管理减值，注意非库存价值）
├── 涉及“库存资金成本”（正值主口径、批次级）？
│   └── 用 dm.dm_fin_stock_capital_cost_t（可为负、滚动窗口近2年）
````

- [ ] **Step 4: 验证格式**

Run: `wc -l skills/inventory-knowledge/references/metrics.md` → 预期 330~400 行
Run: `grep -c "管理口径减值" skills/inventory-knowledge/references/metrics.md` → 预期 ≥ 4
Run: `grep -c "未包装" skills/inventory-knowledge/references/metrics.md` → 预期 0（旧误读清零；1.2/陷阱5 中"未包装周期"字样必须已替换）

- [ ] **Step 5: 提交**

```bash
git add skills/inventory-knowledge/references/stock-fall-list.md skills/inventory-knowledge/references/metrics.md
git commit -m "docs(inventory): 语义层大改—三套减值体系对照/8.3金额锚点/陷阱库10→18/保质期纠错"
```

---

### Task 6: data-lineage.md 增补跌价/资金成本族链路

**Files:**
- Modify: `skills/inventory-knowledge/references/data-lineage.md`（在文件末尾追加新节）

- [ ] **Step 1: 追加以下内容**

````markdown

## 库存跌价/减值与资金成本族血缘（2026-08-19 ETL 实证）

```text
SAP 库存账龄明细
  └─ Hive ETL: PJob_DM_FIN_STOCK_DETAIL_ACCAGE_T_2023（DWS 版 PJob_DWS_… 已废弃，逻辑一致）
       └─ dm.dm_fin_stock_detail_accage_t_2023（库龄明细主表，唯一事实源）
            ├─ PJob_DWS_DM_FIN_STOCK_CAPITAL_COST_T（TRUNCATE 全量，近2年窗口，中间表 DM_FIN_STOCK_CAPITAL_M1_T）
            │    └─ dm.dm_fin_stock_capital_cost_t（资金成本，month=YYYYMM）
            │         └─┐
            ├─ jc 减值族（zdpsyb 范围过滤）────────────────────────┤
            │    └─ PJob_DWS_DM_AMBV2_CHDJ_GRP_T（按预算比例分摊到线组/渠道）  │
            │         └─ dm.dm_ambv2_chdj_grp_t（stat_month=YYYY-MM）        │
            │              ├─ inventory_value = SUM(jc_amt 族) 管理减值      │
            │              ├─ inventory_value_amb = SUM(jc_aging 族)        │
            │              └─ capital_cost = SUM(dm_fin_stock_capital_cost_t)┘
            └─ PJob_DWS_DM_FIN_STOCK_D_ACCAGE_LIST_C_T_2023（delete-insert by calmonth）
                 └─ dm.dm_fin_stock_d_accage_list_c_t_2023（上市口径跌价，calmonth=YYYYMM）
                      └─ 天级桶×{0,0.2,0.3,0.5,0.5} → aging_*_fall_amt

CHDJ 维度依赖：dwi_md_data_material_general_t（渠道/物料）、dm_rpt_sales_group_t（线组→node 层级）、
upload_achievement_budget_t（年度预算比例）、upload_loc_comp_relate_t（库位→公司）、upload_division_comp_t（公司→销售组）
```

关键 ETL 事实：① 明细表 jc 减值公式 0/10/40/70%（双脚本一致）；② 上市口径跌价 0/20/30/50/50% 天级桶精确映射；③ 资金成本公式 ((期初+期末)/2−202012余额)×4%/12，零判断已取消；④ CHDJ 1973 行、7 个 UNION 分支（卫浴族/瓷砖/国际/丽适等）。

已知 ETL 隐患：CHDJ 末段 `物料描述 = material_num` JOIN → product_level_code/prod_line_name 可靠性受限。
````

- [ ] **Step 2: 验证**

Run: `wc -l skills/inventory-knowledge/references/data-lineage.md` → 预期 ≥ 610
Run: `grep -c "PJob_DWS_DM_AMBV2_CHDJ_GRP_T" skills/inventory-knowledge/references/data-lineage.md` → 预期 ≥ 1

- [ ] **Step 3: 提交**

```bash
git add skills/inventory-knowledge/references/data-lineage.md
git commit -m "docs(inventory): 血缘增补—跌价/减值/资金成本族ETL链路实证"
```

---

### Task 7: inventory-analyst 模式 I/J/K + 用词纠错

**Files:**
- Modify: `skills/inventory-analyst/SKILL.md`

- [ ] **Step 1: 第 2 步数据源表追加 3 行**（在 `| 库存周转率 | ...` 行之后）：

````markdown
| 会计口径跌价（上市） | `dm.dm_fin_stock_d_accage_list_c_t_2023` | 计提比例内嵌，calmonth=YYYYMM |
| 管理减值/线组分摊 | `dm.dm_ambv2_chdj_grp_t` | stat_month=YYYY-MM，inventory_value=管理减值 |
| 库存资金成本 | `dm.dm_fin_stock_capital_cost_t` | month=YYYYMM，可为负，滚动窗口近2年 |
````

- [ ] **Step 2: 对抗性审查 B 组追加 2 项**：

````markdown
- [ ] "跌价/减值"用词：会计口径跌价（上市口径表）还是管理口径减值（CHDJ）？两套体系禁止混用
- [ ] "资金成本"负值是否已解释（低于202012基线的公式结果，非数据错误）？
````

- [ ] **Step 3: 模式 H 之后追加三个新模式**：

````markdown
### 模式 I：跌价分析族（会计口径，上市口径表）

```sql
-- I1 月度跌价趋势
SELECT calmonth,
       ROUND(SUM(aging_sum_fall_amt)) AS fall_total,
       ROUND(SUM(aging_1_2_year_fall_amt)) AS fall_1_2y,
       ROUND(SUM(aging_2_3_year_fall_amt)) AS fall_2_3y,
       ROUND(SUM(aging_3_4_year_fall_amt + aging_4_year_fall_amt)) AS fall_over3y
FROM dm.dm_fin_stock_d_accage_list_c_t_2023
WHERE calmonth BETWEEN '202601' AND '202607'
GROUP BY calmonth ORDER BY calmonth;

-- I2 跌价 TOP 物料
SELECT material, MAX(material___t) AS material_name,
       ROUND(SUM(aging_sum_fall_amt)) AS fall_amt,
       ROUND(SUM(zsjkcje)) AS stock_amt,
       ROUND(SUM(aging_sum_fall_amt)/NULLIF(SUM(zsjkcje),0)*100,1) AS fall_pct
FROM dm.dm_fin_stock_d_accage_list_c_t_2023
WHERE calmonth = '202607'
GROUP BY material ORDER BY fall_amt DESC LIMIT 20;

-- I3 按事业部/品类的跌价结构（长龄段占比）
SELECT zdpsyb___t,
       ROUND(SUM(aging_sum_fall_amt)) AS fall_total,
       ROUND(SUM(aging_3_4_year_fall_amt + aging_4_year_fall_amt)) AS fall_3y_plus,
       ROUND(SUM(aging_3_4_year_fall_amt + aging_4_year_fall_amt)
             /NULLIF(SUM(aging_sum_fall_amt),0)*100,1) AS long_ratio_pct
FROM dm.dm_fin_stock_d_accage_list_c_t_2023
WHERE calmonth = '202607'
GROUP BY zdpsyb___t ORDER BY fall_total DESC;
```

### 模式 J：资金成本分析（正值主口径，资金成本表）

```sql
SELECT business_department_desc,
       ROUND(SUM(closing_balance)) AS balance,
       ROUND(SUM(capital_cost)) AS month_cost,
       ROUND(SUM(capital_cost_sum)) AS ytd_cost
FROM dm.dm_fin_stock_capital_cost_t
WHERE month = '202608'
  AND LENGTH(TRIM(business_department_desc)) > 0
GROUP BY business_department_desc
ORDER BY month_cost DESC;
```

> 注意：capital_cost 可为负（平均余额<202012基线）；跨年查累计注意 TRUNCATE 滚动窗口只留近 2 年。

### 模式 K：双口径对照（业务问"两个数对不上"时）

业务高频困惑：CHDJ `inventory_value`（6.35亿）vs 上市口径库存金额（14.3亿）/会计跌价（1.43亿）。标准解释：**三者是不同概念**——管理口径减值（0/10/40/70%，范围限卫浴/瓷砖/国际/丽适）vs 库存金额 vs 会计跌价（0/20/30/50/50%，上市在售范围），不是口径误差。

```sql
SELECT 'CHDJ管理减值' AS metric, ROUND(SUM(inventory_value)) AS amt
FROM dm.dm_ambv2_chdj_grp_t WHERE stat_month = '2026-07'
UNION ALL
SELECT '上市口径库存金额', ROUND(SUM(zsjkcje))
FROM dm.dm_fin_stock_d_accage_list_c_t_2023 WHERE calmonth = '202607'
UNION ALL
SELECT '上市口径会计跌价', ROUND(SUM(aging_sum_fall_amt))
FROM dm.dm_fin_stock_d_accage_list_c_t_2023 WHERE calmonth = '202607';
```

回答时必须附概念对照表（见 inventory-knowledge metrics.md 第 8.1 节），并说明各口径适用场景。
````

- [ ] **Step 4: 全文用词纠错（3 处）**

- 第 1 步表格中 `库龄口径 | 标准(wbzq/ybzq) / 协议单价(xydj) / 爱米巴(amb_) / 自然日历(zrzlcp_)？默认标准` → 改为 `库龄口径 | 标准(wbzq/ybzq，无/有保质期) / 协议单价(xydj) / 阿米巴(*_aging) / 自然日历(zrzlcp_)？默认标准`
- 第 5 步 B 组 `用户说的"库龄"是指未包装周期(wbzq)还是已包装周期(ybzq)？` → `用户说的"库龄"是指无保质期产品库龄(wbzq，按批次日期 6/12/24月)还是有保质期到期口径(ybzq)？`
- 模式 A SQL 注释 `as wbzq_0_6m` 保留不动（别名无歧义）

- [ ] **Step 5: 验证**

Run: `wc -l skills/inventory-analyst/SKILL.md` → 预期 ≥ 370
Run: `grep -c "### 模式" skills/inventory-analyst/SKILL.md` → 预期 11（A-K）
Run: `grep -c "未包装周期" skills/inventory-analyst/SKILL.md` → 预期 0

- [ ] **Step 6: 提交**

```bash
git add skills/inventory-analyst/SKILL.md
git commit -m "feat(inventory-analyst): 模式I跌价/J资金成本/K双口径对照+保质期用词纠错"
```

---

### Task 8: eval 新增 5 场景并实跑入库

**Files:**
- Modify: `eval_dataset.json`

- [ ] **Step 1: 逐条执行以下 5 条 SQL（MCP `mcp__dws__run_query`），确认行数与量级合理**

```sql
-- E1 inventory_fall_top10
SELECT material, MAX(material___t) AS material_name,
       ROUND(SUM(aging_sum_fall_amt)) AS fall_amt,
       ROUND(SUM(zsjkcje)) AS stock_amt
FROM dm.dm_fin_stock_d_accage_list_c_t_2023
WHERE calmonth = '202607'
GROUP BY material ORDER BY fall_amt DESC LIMIT 10;

-- E2 inventory_fall_trend
SELECT calmonth, ROUND(SUM(aging_sum_fall_amt)) AS fall_total
FROM dm.dm_fin_stock_d_accage_list_c_t_2023
WHERE calmonth BETWEEN '202601' AND '202607'
GROUP BY calmonth ORDER BY calmonth;

-- E3 inventory_capital_cost_by_dept
SELECT business_department_desc,
       ROUND(SUM(closing_balance)) AS balance,
       ROUND(SUM(capital_cost)) AS month_cost
FROM dm.dm_fin_stock_capital_cost_t
WHERE month = '202608' AND LENGTH(TRIM(business_department_desc)) > 0
GROUP BY business_department_desc ORDER BY balance DESC;

-- E4 inventory_chdj_vs_listed（模式 K 的 eval 版）
SELECT 'CHDJ管理减值' AS metric, ROUND(SUM(inventory_value)) AS amt
FROM dm.dm_ambv2_chdj_grp_t WHERE stat_month = '2026-07'
UNION ALL
SELECT '上市口径会计跌价', ROUND(SUM(aging_sum_fall_amt))
FROM dm.dm_fin_stock_d_accage_list_c_t_2023 WHERE calmonth = '202607';

-- E5 inventory_aging_fall_link（长龄段跌价敞口）
SELECT zdpsyb___t,
       ROUND(SUM(aging_3_4_year_fall_amt + aging_4_year_fall_amt)) AS long_fall,
       ROUND(SUM(aging_sum_fall_amt)) AS total_fall,
       ROUND(SUM(aging_3_4_year_fall_amt + aging_4_year_fall_amt)
             /NULLIF(SUM(aging_sum_fall_amt),0)*100,1) AS long_ratio_pct
FROM dm.dm_fin_stock_d_accage_list_c_t_2023
WHERE calmonth = '202607'
GROUP BY zdpsyb___t ORDER BY long_fall DESC;
```

预期：E1 = 10 行（fall_amt 量级 百万~亿内单物料）；E2 = 7 行（月度 1~2 亿量级）；E3 = 5~15 行；E4 = 2 行；E5 = 5~15 行。异常（0 行/量级离谱）先排查再入库。

- [ ] **Step 2: 在 `eval_dataset.json` 的 `questions` 数组追加 5 个场景对象**

结构对齐现有条目（`domain, pattern, question, sql, row_count, elapsed_ms, data, checksum`）。`question` 用业务问法：
- E1: "2026年7月跌价准备最高的前10个物料是哪些？"
- E2: "今年以来上市口径存货跌价准备每月总额走势？"
- E3: "2026年8月各事业部的库存资金成本情况？"
- E4: "为什么阿米巴存货减值和上市口径跌价对不上？两个数各是多少？"
- E5: "各事业部3年以上长库龄段的跌价敞口有多大？"

`row_count`/`elapsed_ms`/`data` 填 Step 1 实跑结果（data 放返回行，如超长截断前 5 行并注明）；`checksum` 按 run_eval.py 现有计算方式（先看文件内其他条目的格式再对齐）。同时更新 `meta.total`：66 → 71。

- [ ] **Step 3: 实跑 eval 验证**

Run: `python run_eval.py inventory`
预期：`inventory: 15/15 PASS`（旧 10 + 新 5）；新场景 SQL 重跑行数与 row_count 一致

- [ ] **Step 4: 提交**

```bash
git add eval_dataset.json
git commit -m "test(eval): 库存域+5场景—跌价TOP/趋势/资金成本/双口径/长龄敞口(实跑入库)"
```

---

### Task 9: 回归验证与收尾

**Files:**
- Modify: `C:\Users\Administrator\.claude\projects\D--dataprojai\memory\dws-inventory-core-tables.md`（记忆更新，不入库）

- [ ] **Step 1: 全量回归**

Run: `python run_eval.py`
预期：71 场景，PASS ≥ 64（新 15 个 inventory 全绿；ar 域 7 个存量漂移 FAIL 与本轮无关，数量不得增加）

- [ ] **Step 2: SKU 域零改动验证**

Run: `git diff --stat 6b4ac11..HEAD -- skills/sku-profitability-knowledge skills/sku-profitability-analyst`
预期：空输出（零改动）。若有输出，回滚越界改动。

- [ ] **Step 3: 更新记忆文件**（直接覆盖 `dws-inventory-core-tables.md` 对应段落）

追加/更新要点：待办已闭环；CHDJ 解码（inventory_value=管理减值、capital_cost 承袭资金成本表）；jc=减值 0/10/40/70%；wbzq/ybzq=无/有保质期；资金成本滚动窗口陷阱。悬案状态：两个原悬案均已实证破案；E 公式仍待 Mix ETL（未动）。

- [ ] **Step 4: 汇报**

向用户汇总：验证记录数字、纠错清单（4 处字面纠错+1 处概念纠错）、eval 结果、SKU 域零改动证明。

---

## Self-Review 记录（计划期已完成）

1. **Spec 覆盖**：spec §3 ETL挖掘→Task 1（验证）+发现清单；§4.1 四文档→Task 2/3/4/5；§4.2 metrics→Task 5；§4.3 lineage→Task 6；§5 analyst→Task 7；§6 eval→Task 8；§7 验证收尾→Task 1+9。无缺口。
2. **占位符扫描**：无 TBD/TODO；所有文档内容与 SQL 均完整给出。
3. **一致性**：模式字母 I/J/K 与现有 A-H 无冲突；eval pattern 名与 spec §6 一致；三套减值体系表述在 Task 2/4/5/7 间一致（0/20/30/50/50% 会计 vs 0/10/40/70% 管理）。
