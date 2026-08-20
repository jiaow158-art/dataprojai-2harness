# 去上市口径库存表 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 inventory 与 sku-profitability 两域的全部 skill 文件与 eval_dataset.json 从上市口径表 `dm_fin_stock_d_accage_list_c_t_2023` 迁移到内部口径表 `dm_fin_stock_detail_accage_t_2023`（sku 域用阿米巴字段族、inventory 域用管理字段族），每个重写 SQL 经真实数据验证。

**Architecture:** 三个工作包按域隔离：① sku-profitability 域 4 文件（含 4 个 SQL 模式模板重写）；② eval_dataset.json 4 场景 SQL 重写；③ inventory 域 6 文件（含 stock-fall-list.md 整文件重写）。每个任务交付前用 MCP 真实执行重写 SQL（202607 数据）验证量级，收尾任务做全仓 grep 零残留 + run_eval + pytest 回归。

**Tech Stack:** DWS/GaussDB SQL（MCP run_query）、Markdown skill 文档、Python（run_eval.py、pytest）。

## Global Constraints

- **禁用表**：`dm_fin_stock_d_accage_list_c_t_2023`（及其 `_bak20260331` 变体）；`dm_fin_stock_detail_accage_t`（旧版 91 列）、`dm_fin_stock_detail_accage_others_t`（辅材专用）也不得用于成品库存分析。
- **内部表字段族**（同一张表内两套口径，查询必须显式选族、不混用）：
  - 管理口径：`zsjkcje`（实际库存金额）、`jchj_amt`（减值合计-管理）、`wbzq_*_amt`/`ybzq_*_amt`（库龄分段金额）、`wbzq_*_fall_amt`/`ybzq_*_fall_amt`（跌价分段）。
  - 阿米巴口径：`stock_amt`（阿米巴结算价）、`jchj_aging`（减值合计-阿米巴）、`wbzq_*_aging`/`ybzq_*_aging`（库龄分段）、`wbzq_*_fall_aging`/`ybzq_*_fall_aging`（跌价分段）。
- **计提政策（内部口径）**：无保质期 0%/10%/40%/70%（6月内/6-12月/12-24月/24月+）；有保质期 70%（到期3月内）/100%（到期）。与上市口径 0/20/30/50/50 **不可跨口径对比**。
- **sku-profitability 域固定阿米巴字段族**（与 Mix 阿米巴口径对齐）；**inventory 域固定管理字段族**。
- `calmonth` 格式 YYYYMM，628 万行/月**必带过滤**；202607 实测：`zsjkcje` 合计 14.71 亿、`jchj_amt` 2.877 亿、`stock_amt` 17.52 亿、`jchj_aging` 3.301 亿。
- 清仓标识 `zisqc`（值域 Y/N，内部表同名）；另有 `clear_inv_flag`/`clearance_reason`/`promote_reason`。
- `docs/superpowers/`（历史设计/计划文档）与 `huaweiclaude/`（原始导出）**不修改**。
- run_eval 仅对比行数；eval 的 `data`/`checksum` 参考字段更新为新口径实测值。
- 备份表后缀黑名单：`_wjh_*`、`_bak*`、`_tmp*`、`_01`、`_close`、`_0630` 等。

---

### Task 1: sku-profitability 域 4 文件迁移（阿米巴字段族）

**Files:**
- Modify: `skills/sku-profitability-analyst/SKILL.md`
- Modify: `skills/sku-profitability-knowledge/references/metrics.md`
- Modify: `skills/sku-profitability-knowledge/references/data-lineage.md`
- Modify: `skills/sku-profitability-knowledge/references/inventory-side-patterns.md`

**Interfaces:**
- Consumes: 内部表字段族（见 Global Constraints）、202607 实测量级
- Produces: 4 个新 SQL 模式模板（D/E/H/I），Task 2 的 eval SQL 以其为实例化蓝本

- [ ] **Step 1: 验证新 SQL 模式模板（先写后改，数据先行）**

用 MCP `run_query` 依次执行以下 4 个新模式 SQL，确认可执行且量级合理（记录每段实际行数与 TOP 值，写进报告）：

**模式 D（可售天数，LIMIT 50）**：
```sql
WITH stock AS (
  SELECT material, SUM(stock_amt) AS stock_amt
  FROM dm.dm_fin_stock_detail_accage_t_2023
  WHERE calmonth = '202607' GROUP BY material
), cost AS (
  SELECT material_num, AVG(m_cost) AS avg_m_cost, AVG(m_amt) AS avg_m_amt FROM (
    SELECT material_num, calmonth, SUM(act_cost_sum_amt) AS m_cost, SUM(ambperformance) AS m_amt
    FROM dm.dm_fin_operations_mix_sum_t
    WHERE calmonth BETWEEN '2026-02' AND '2026-07' AND data_source IN ('S','T','D','')
    GROUP BY material_num, calmonth) t
  GROUP BY material_num
)
SELECT s.material, ROUND(s.stock_amt) AS stock_amt,
       ROUND(s.stock_amt / NULLIF(c.avg_m_cost/30.0,0), 0) AS dos_days,
       ROUND(s.stock_amt / NULLIF(c.avg_m_amt,0), 2) AS stock_sales_ratio
FROM stock s JOIN cost c ON s.material = c.material_num
ORDER BY dos_days DESC NULLS LAST LIMIT 50;
```
Expected: 50 行；库存金额量级最高约 57 万（阿米巴口径，比旧口径 573328 略变，量级接近）。

**模式 E（健康度，GROUP BY 2 行）**：
```sql
WITH act AS (
  SELECT material_num, COUNT(DISTINCT start_month) AS active_months
  FROM dm.dm_product_inout_stock_t
  WHERE start_month BETWEEN '2026-01' AND '2026-07'
    AND (out_stock_qty > 0 OR out_stock_area > 0)
  GROUP BY material_num
), stock AS (
  SELECT material, SUM(stock_amt) AS stock_amt
  FROM dm.dm_fin_stock_detail_accage_t_2023
  WHERE calmonth = '202607' GROUP BY material
)
SELECT COALESCE(a.material_num, s.material) AS material,
       COALESCE(a.active_months,0) AS active_months,
       ROUND(100.0*COALESCE(a.active_months,0)/7,0) AS active_rate,
       ROUND(COALESCE(s.stock_amt,0)) AS stock_amt,
       CASE WHEN COALESCE(s.stock_amt,0)=0 AND COALESCE(a.active_months,0)>0 THEN '缺货'
            WHEN COALESCE(s.stock_amt,0)>0 AND COALESCE(a.active_months,0)=0 THEN '滞销'
            ELSE '正常' END AS health_flag
FROM act a FULL OUTER JOIN stock s ON a.material_num = s.material
GROUP BY health_flag ORDER BY health_flag;
```
Expected: 2-3 行（正常/滞销，可能缺货为 0 行）。

**模式 H（跌价 TOP10，LIMIT 10）**：
```sql
SELECT material, MAX(material___t) AS material_name,
       ROUND(SUM(jchj_aging)) AS fall_amt,
       ROUND(SUM(stock_amt)) AS stock_amt,
       ROUND(SUM(wbzq_6_12_fall_aging)) AS fall_6_12m,
       ROUND(SUM(wbzq_12_24_fall_aging)) AS fall_12_24m,
       ROUND(SUM(wbzq_24_fall_aging)) AS fall_24m
FROM dm.dm_fin_stock_detail_accage_t_2023
WHERE calmonth = '202607'
GROUP BY material ORDER BY fall_amt DESC LIMIT 10;
```
Expected: 10 行；TOP 跌价量级约 200-500 万（阿米巴口径，比旧口径 199 万偏大）。若 `fall_amt` 列名与 SELECT 中 `SUM(stock_amt) AS stock_amt` 无冲突则原样执行；若报错（GaussDB 同名列别名），将跌价列改为 `ROUND(SUM(jchj_aging)) AS fall_amt_v`，以实际执行为准。

**模式 I（综合评分，LIMIT 20）**：
```sql
WITH cur AS (
  SELECT material_num, SUM(ambperformance) AS amt, SUM(gross_profit_after_sharing) AS gp
  FROM dm.dm_fin_operations_mix_sum_t
  WHERE calmonth BETWEEN '2026-05' AND '2026-07' AND data_source IN ('S','T','D','')
  GROUP BY material_num
), act AS (
  SELECT material_num, COUNT(DISTINCT start_month) AS active_months
  FROM dm.dm_product_inout_stock_t
  WHERE start_month BETWEEN '2026-01' AND '2026-07'
    AND (out_stock_qty > 0 OR out_stock_area > 0)
  GROUP BY material_num
), stk AS (
  SELECT material, SUM(stock_amt) AS stock_amt, SUM(jchj_aging) AS fall_amt
  FROM dm.dm_fin_stock_detail_accage_t_2023 WHERE calmonth='202607' GROUP BY material
), base AS (
  SELECT c.material_num, c.amt, c.gp, COALESCE(a.active_months,0) AS active_months,
         COALESCE(s.stock_amt,0) AS stock_amt, COALESCE(s.fall_amt,0) AS fall_amt
  FROM cur c
  LEFT JOIN act a ON c.material_num=a.material_num
  LEFT JOIN stk s ON c.material_num=s.material
  WHERE c.amt > 0
), scored AS (
  SELECT *,
    ROUND(100*PERCENT_RANK() OVER (ORDER BY amt),1) AS s_sales,
    ROUND(100*PERCENT_RANK() OVER (ORDER BY gp),1) AS s_gp,
    ROUND(100*active_months/7.0,1) AS s_active,
    ROUND(100*PERCENT_RANK() OVER (ORDER BY stock_amt DESC),1) AS s_stock_inv,
    ROUND(100*PERCENT_RANK() OVER (ORDER BY stock_amt/NULLIF(amt,0) DESC),1) AS s_turnover
  FROM base
), final AS (
  SELECT *, ROUND(s_sales*0.25+s_gp*0.30+s_active*0.20+s_stock_inv*0.15+s_turnover*0.10,1) AS score
  FROM scored
)
SELECT material_num, ROUND(amt) AS amt, ROUND(fall_amt) AS fall_amt, stock_amt, score,
       CASE WHEN score>=80 THEN '加大投入' WHEN score>=60 THEN '保留优化'
            WHEN score>=40 THEN '调价降本' ELSE '降库存' END AS action
FROM final ORDER BY score DESC LIMIT 20;
```
Expected: 20 行，score 量级 40-80。

- [ ] **Step 2: 重写 `skills/sku-profitability-analyst/SKILL.md`**

替换点（按顺序）：
1. 第 34 行核心表清单行：
   `| \`dm.dm_fin_stock_d_accage_list_c_t_2023\` | 库存余额/跌价/库龄（上市口径） | \`calmonth\` | YYYYMM |`
   → `| \`dm.dm_fin_stock_detail_accage_t_2023\` | 库存余额/跌价/库龄（内部口径，**阿米巴字段族**） | \`calmonth\` | YYYYMM |`
2. 第 89 行日期红线表行：
   `| 上市口径（库存/跌价） | \`calmonth\` | YYYYMM | \`'202607'\` |`
   → `| 内部口径（库存/跌价，阿米巴字段族） | \`calmonth\` | YYYYMM | \`'202607'\` |`
3. 第 108 行对抗性审查清单 A 节：
   `- [ ] 跌价/库龄相关查询是否使用了上市口径表（\`dm_fin_stock_d_accage_list_c_t_2023\`，calmonth='YYYYMM'）？`
   → `- [ ] 跌价/库龄/库存余额是否使用了内部口径表（\`dm_fin_stock_detail_accage_t_2023\`，calmonth='YYYYMM'）？`
   `- [ ] 库存金额是否用阿米巴字段 \`stock_amt\`（不是管理口径 \`zsjkcje\`）？跌价用 \`jchj_aging\`（不是 \`jchj_amt\`）？`
4. 第 114 行：
   `- [ ] 上市口径表 \`calmonth\` 是否为 \`YYYYMM\` 格式？`
   → `- [ ] 内部口径表 \`calmonth\` 是否为 \`YYYYMM\` 格式？`
5. 第 121 行审查清单 C 节：
   `- [ ] \`material_num\`（Mix/出入库）与 \`material\`（库存表）字段名是否正确对应？`
   → 不变（内部表同用 `material`，此条仍正确）。
6. **模式 D**（第 202-221 行）：`FROM dm.dm_fin_stock_d_accage_list_c_t_2023` → `FROM dm.dm_fin_stock_detail_accage_t_2023`；`SUM(zsjkcje) AS stock_amt` → `SUM(stock_amt) AS stock_amt`（Step 1 验证过的完整 SQL 原样替换）。
7. **模式 E**（第 223-248 行）：同 6。
8. **模式 H**（第 283-296 行）：整体替换为 Step 1 验证过的模式 H SQL。
9. **模式 I**（第 298-340 行）：`stk` CTE 内 `FROM dm.dm_fin_stock_d_accage_list_c_t_2023` → `FROM dm.dm_fin_stock_detail_accage_t_2023`；`SUM(zsjkcje) AS stock_amt` → `SUM(stock_amt) AS stock_amt`；`SUM(aging_sum_fall_amt) AS fall_amt` → `SUM(jchj_aging) AS fall_amt`。
10. 第 342 行清仓注：`上市口径表 zisqc='Y'` → `内部口径表（dm_fin_stock_detail_accage_t_2023）zisqc='Y'`。
11. 模式标题注释中"月末 202607 快照"等不变；模式 D/E/H/I 的**模式名与注释**（"模式 D：可售天数/库销比"等）不变。

- [ ] **Step 3: 重写 `skills/sku-profitability-knowledge/references/metrics.md`**

替换点：
1. 第 10 行：`| 4 | 库存周转/可售天数/库销比 | 上市口径+Mix | D |` → `| 4 | 库存周转/可售天数/库销比 | 内部口径（阿米巴字段族）+Mix | D |`
2. 第 11 行：`| 5 | 滞销/缺货/动销率 | 出入库月表+上市口径(+otd未交付) | E |` → `| 5 | 滞销/缺货/动销率 | 出入库月表+内部口径(+otd未交付) | E |`
3. 第 15 行：`| 9 | 库存跌价/库龄分段 | 上市口径 | H |` → `| 9 | 库存跌价/库龄分段 | 内部口径（阿米巴字段族） | H |`
4. 第 17 行：`SKU 键：Mix 表 \`material_num\` ↔ 上市口径表 \`material\` ↔ 出入库表 \`material_num\` ↔ 主数据 \`material_num\`。` → `SKU 键：Mix 表 \`material_num\` ↔ 内部口径表 \`material\` ↔ 出入库表 \`material_num\` ↔ 主数据 \`material_num\`。`
5. 第 27 行效益利润公式：`− aging_sum_fall_amt（上市口径跌价合计）` → `− jchj_aging（内部口径跌价合计-阿米巴结算价，计提 0/10/40/70%+保质期 70/100%）`
6. 第 46 行陷阱 1：整条替换为：
   `1. **两套库存金额不可混用**：内部口径管理字段 zsjkcje 14.71亿 / 阿米巴字段 stock_amt 17.52亿 / 阿米巴 CHDJ 6.35亿（2026-07 量级）。本域统一用**阿米巴字段族**（stock_amt/jchj_aging/*_aging）与 Mix 对齐；资金成本→capital_cost_t（正值）或 CHDJ（阿米巴，待确认）。\`dm_own_inventory_t\` 未获业务确认，不使用。上市口径表 \`dm_fin_stock_d_accage_list_c_t_2023\` 已弃用，禁止使用。`
7. 第 47 行陷阱 2：`上市口径 \`calmonth='202607'\`` → `内部口径 \`calmonth='202607'\``
8. 第 48 行陷阱 3：`**跌价只有年段**（1年内/1-2/2-3/3-4/4年+，比例 0/20/30/50/50%）…` → `**跌价按 6月段**（6月内 0%、6-12月 10%、12-24月 40%、24月+ 70%），另含保质期段（到期3月内 70%、到期 100%）；业务问"年段/半年段"时按 6月段聚合呈现并声明口径。`
9. 第 50 行陷阱 5：`Mix 在售 6,232 vs 上市口径在库 64,605` → `Mix 在售 6,232 vs 内部口径在库 ~6.4万`
10. 第 68-70 行指标速查：
    `| 月末库存金额（上市口径） | \`zsjkcje\` | 上市口径表 |` → `| 月末库存金额（阿米巴结算价） | \`stock_amt\` | 内部口径表 dm_fin_stock_detail_accage_t_2023 |`
    `| 跌价合计 | \`aging_sum_fall_amt\` | 上市口径表 |` → `| 跌价合计（阿米巴） | \`jchj_aging\` | 内部口径表 |`
    `| 是否清仓 | \`zisqc\` | 上市口径表 |` → `| 是否清仓 | \`zisqc\`（值域 Y/N） | 内部口径表 |`
    并追加一行：`| 库龄分段金额（阿米巴） | \`wbzq_6_aging\`~\`wbzq_24_aging\` | 内部口径表 |`

- [ ] **Step 4: 重写 `skills/sku-profitability-knowledge/references/data-lineage.md`**

替换点：
1. 第 9 行表行：
   `| \`dm.dm_fin_stock_d_accage_list_c_t_2023\` | DM | 库龄明细表+批次入库日期推账龄（ETL: PJob_DWS_DM_FIN_STOCK_D_ACCAGE_LIST_C_T_2023） | 月（delete-insert by calmonth） | 批次×物料×库存地点×月 |`
   → `| \`dm.dm_fin_stock_detail_accage_t_2023\` | DM | 库存账龄明细主表（内部口径，SAP 库存+批次入库日期推账龄，含管理/阿米巴双字段族） | 月（delete-insert by calmonth） | 批次×物料×库存地点×月 |`
2. 第 18 行关联键：`Mix.material_num = 出入库.material_num = 上市口径.material = capital_cost_t.material_code = CHDJ.material_num = 主数据.material_num` → `Mix.material_num = 出入库.material_num = 内部口径.material = capital_cost_t.material_code = CHDJ.material_num = 主数据.material_num`
3. 第 22 行：`Mix ↔ 上市口径：销售侧 ↔ 库存侧（以 Mix 为主集 LEFT JOIN；口径差见 metrics.md 陷阱 1/5）` → `Mix ↔ 内部口径：销售侧 ↔ 库存侧（以 Mix 为主集 LEFT JOIN；口径差见 metrics.md 陷阱 1/5）`
4. 第 23 行：`出入库 ↔ 上市口径：动销 ↔ 库存快照（月粒度对齐：start_month ↔ calmonth，**格式不同 YYYY-MM vs YYYYMM**）` → `出入库 ↔ 内部口径：动销 ↔ 库存快照（月粒度对齐：start_month ↔ calmonth，**格式不同 YYYY-MM vs YYYYMM**）`

- [ ] **Step 5: 重写 `skills/sku-profitability-knowledge/references/inventory-side-patterns.md`**

替换点（全文 3 处"上市口径表"）：
1. 第 7 行：`- 表：上市口径表（月末库存金额 \`zsjkcje\`，calmonth=YYYYMM）× Mix（月均销售成本 \`act_cost_sum_amt\`，calmonth=YYYY-MM）` → `- 表：内部口径表（月末库存金额 \`stock_amt\` 阿米巴结算价，calmonth=YYYYMM）× Mix（月均销售成本 \`act_cost_sum_amt\`，calmonth=YYYY-MM）`
2. 第 14 行：`- 表：出入库月表（动销，start_month=YYYY-MM）+ 上市口径表（月末库存，calmonth=YYYYMM）+（可选）otd 未交付订单` → `- 表：出入库月表（动销，start_month=YYYY-MM）+ 内部口径表（月末库存 \`stock_amt\`，calmonth=YYYYMM）+（可选）otd 未交付订单`
3. 第 22-25 行问题 9 整段：
   `- 表：上市口径表单表（calmonth=YYYYMM）\n- 跌价 = \`aging_sum_fall_amt\`（预计算，比例 0/20/30/50/50%）\n- 分段呈现按年段；"半年分段"只有金额（天级细分聚合），透明说明\n- 处置联动：\`zisqc\`（是否清仓，值域 Y/N）+ 跌价 TOP 榜`
   → `- 表：内部口径表单表（\`dm_fin_stock_detail_accage_t_2023\`，calmonth=YYYYMM）\n- 跌价 = \`jchj_aging\`（阿米巴减值合计，比例 0/10/40/70% + 保质期 70/100%）\n- 分段呈现按 6月段（\`wbzq_6_12_fall_aging\`/12-24/24+）；业务问"年段/半年段"按 6月段聚合并声明口径\n- 处置联动：\`zisqc\`（是否清仓，值域 Y/N）+ 跌价 TOP 榜`

- [ ] **Step 6: 提交**

```bash
git add skills/sku-profitability-analyst/SKILL.md skills/sku-profitability-knowledge/references/metrics.md skills/sku-profitability-knowledge/references/data-lineage.md skills/sku-profitability-knowledge/references/inventory-side-patterns.md
git commit -m "refactor(sku-profitability): 库存侧迁移内部口径表（阿米巴字段族），弃用上市口径表"
```

---

### Task 2: eval_dataset.json 4 场景重写 + run_eval 回归

**Files:**
- Modify: `eval_dataset.json`（4 个 sku-profitability 场景：`sku_turnover_dos`、`sku_health_flag`、`sku_fall_top10`、`sku_score_top20`）

**Interfaces:**
- Consumes: Task 1 验证过的模式 D/E/H/I SQL（蓝本）
- Produces: 新口径的 eval 场景（sql + data + checksum + row_count）

- [ ] **Step 1: 用 Task 1 的 4 个验证 SQL 替换对应场景的 `sql` 字段**

用 Python 脚本定位 4 个场景（`pattern` 字段：`sku_turnover_dos`/`sku_health_flag`/`sku_fall_top10`/`sku_score_top20`），替换其 `sql` 为 **Task 1 Step 1 验证通过的完整 SQL**（见 Task 1 报告；这是本任务的唯一 SQL 来源，不得自行改写字段）。四个 SQL 的映射与形态调整：
- `sku_turnover_dos` ← 模式 D 完整 SQL（原样，含 `ORDER BY dos_days DESC NULLS LAST LIMIT 50`）
- `sku_health_flag` ← 模式 E 的 SQL，但**汇总形态改为原 eval 结构**：外层 `SELECT health_flag, COUNT(*) AS cnt FROM (...模式 E 的 act+stock+三态 CASE... ) t GROUP BY health_flag ORDER BY health_flag`（无 LIMIT；原 eval 场景 2 即此形态）
- `sku_fall_top10` ← 模式 H 完整 SQL（原样，含 `LIMIT 10`）
- `sku_score_top20` ← 模式 I 完整 SQL（原样，含 `LIMIT 20`）

替换脚本骨架（SQL 文本从 Task 1 报告复制，勿用占位符）：

```python
import json
new_sql = {
  # 每个值 = Task 1 报告中验证通过的完整 SQL 文本（原样复制，含换行缩进）
  "sku_turnover_dos": "<Task 1 模式 D 验证版 SQL>",
  "sku_health_flag": "<Task 1 模式 E 验证版 SQL 套 health_flag 汇总外层>",
  "sku_fall_top10": "<Task 1 模式 H 验证版 SQL>",
  "sku_score_top20": "<Task 1 模式 I 验证版 SQL>",
}
d = json.load(open("eval_dataset.json"))
for q in d["questions"]:
    if q["pattern"] in new_sql:
        q["sql"] = new_sql[q["pattern"]]
json.dump(d, open("eval_dataset.json", "w"), ensure_ascii=False, indent=2)
```

- [ ] **Step 2: 更新 `data` 样本与 `checksum`**

跑完 Step 3 的 run_eval 前，先用 psycopg2 或 MCP 执行每个新 SQL，取前 3 行写入 `data` 字段（新口径真实结果，json.dumps ensure_ascii=False 的原始值），并计算 `checksum`（与旧值算法一致：如旧 checksum 是 md5(data 序列化)，用相同算法重算；若无法确定算法，将 checksum 置为该 SQL 结果前 3 行的 md5(data_json)）。

验证 checksum 算法：对比旧场景 checksum 是否等于 `hashlib.md5(json.dumps(data, ensure_ascii=False).encode()).hexdigest()` 或 `hashlib.md5(json.dumps(data, ensure_ascii=False, sort_keys=True).encode()).hexdigest()` 之一；命中则用同算法重算，未命中则用前 3 行序列化 md5 并注明。

- [ ] **Step 3: run_eval 回归（sku-profitability）**

Run: `/usr/bin/python3 run_eval.py sku-profitability`
Expected: `4 passed, 0 failed`，Accuracy 100%。若某场景 FAIL（行数不匹配），检查该 SQL 与模式模板的差异（通常为 GROUP BY 形态或 LIMIT 差异），修正后重跑。

- [ ] **Step 4: 提交**

```bash
git add eval_dataset.json
git commit -m "test(eval): sku-profitability 4 场景 SQL 迁移内部口径表（阿米巴字段族）"
```

---

### Task 3: inventory 域 6 文件迁移（管理字段族）

**Files:**
- Modify: `skills/inventory-knowledge/SKILL.md`
- Modify: `skills/inventory-knowledge/references/metrics.md`
- Modify: `skills/inventory-knowledge/references/stock-fall-list.md`（整文件重写）
- Modify: `skills/inventory-knowledge/references/stock-accage.md`
- Modify: `skills/inventory-knowledge/references/chdj-capital-cost.md`
- Modify: `skills/inventory-knowledge/references/capital-cost-table.md`

**Interfaces:**
- Consumes: 管理字段族（zsjkcje/jchj_amt/wbzq_*_amt）、202607 实测量级
- Produces: 内部口径跌价文档（stock-fall-list.md 重写版）——inventory 域 Agent 的跌价知识来源

- [ ] **Step 1: 重写 `skills/inventory-knowledge/references/stock-fall-list.md`（整文件）**

整文件替换为（新内容完整如下）：

````markdown
# dm_fin_stock_detail_accage_t_2023 — 存货跌价·内部口径表

## 快速参考

- **DWS 表名**：`dm.dm_fin_stock_detail_accage_t_2023`
- **业务含义**：内部（财务/管理）口径的库存+账龄+跌价明细表，批次级，库存分析主表。跌价字段内嵌集团会计政策计提比例。
- **实体粒度**：一行 = 批次 × calmonth × 物料 × 工厂 × 库存地点 组合
- **数据量**：约 628 万行/月（202607：622.9万行，实际库存金额 14.71亿，减值合计 2.877亿；202608：628.3万行，14.97亿 / 2.865亿）
- **时间格式**：`calmonth` = **YYYYMM**（如 '202607'）
- **注意**：结尾 `_2023` 是历史命名，实际持续更新（202608 已有数）；不要使用旧版 `dm_fin_stock_detail_accage_t`（91列）或辅材表 `_others_t`

## 跌价字段（含计提比例 — 集团会计政策）

### 管理口径（默认，金额 = 实际库存金额 zsjkcje）

| 字段 | 口径 | 计提比例 |
|---|---|---|
| `wbzq_6_fall_amt` | 无保质期，6个月以内 | 0% |
| `wbzq_6_12_fall_amt` | 无保质期，6-12月 | 10% |
| `wbzq_12_24_fall_amt` | 无保质期，1-2年 | 40% |
| `wbzq_24_fall_amt` | 无保质期，2年以上 | 70% |
| `ybzq_bzdq_3_fall_amt` | 有保质期，距到期3个月以内 | 70% |
| `ybzq_bzdq_fall_amt` | 有保质期，已到期 | 100% |
| `jchj_amt` | **跌价合计-管理（预计算，直接 SUM 用）** | — |

### 阿米巴口径（`*_aging` 后缀，金额 = 阿米巴结算价 stock_amt）

- 同结构字段：`wbzq_6_fall_aging`(0%)、`wbzq_6_12_fall_aging`(10%)、`wbzq_12_24_fall_aging`(40%)、`wbzq_24_fall_aging`(70%)、`ybzq_bzdq_3_fall_aging`(70%)、`ybzq_bzdq_fall_aging`(100%)
- 合计：`jchj_aging`（减值合计-阿米巴结算价）
- ⚠️ 两个口径跌价金额不同（202607：管理 2.877亿 vs 阿米巴 3.301亿），**不可混用**；SKU 效益域（Mix 阿米巴语境）用阿米巴族，库存域默认管理族。

## 库龄分段金额字段

- 无保质期：`wbzq_6_amt`（6月内）、`wbzq_6_12_amt`（6-12月）、`wbzq_12_24_amt`（1-2年）、`wbzq_24_amt`（2年+）；对应 `_qty`/`_area` 数量/面积
- 有保质期：`ybzq_bzdq_3_amt`（到期3月内）、`ybzq_bzdq_amt`（已到期）；对应 `_qty`/`_area`
- 阿米巴口径：同结构 `*_aging` 字段（金额，阿米巴结算价）
- 有保质期产品仅占 0.6% 行数（202607：3.6万行 vs 无保质期 619万行），瓷砖业务以无保质期分段为主

## 关键维度

| 字段 | 说明 |
|---|---|
| `material` / `material___t` | 物料编码/描述（对应 Mix 表 `material_num`） |
| `calmonth` | 会计期间 YYYYMM（NOT NULL） |
| `zisqc` | 是否清仓（值域 Y/N，处置建议分析用） |
| `clear_inv_flag` / `clearance_reason` / `promote_reason` | 清库存标识/清仓原因/促销原因 |
| `bz_flag` | 保质期标识（Y=有保质期，N=无保质期） |
| `batch` / `batch_rk_date` / `zmmm_o017_zbatch_date` | 批次/批次入库日期（阿米巴调整）/SAP 入库日期 |
| `zprodh1`~`zprodh5`（+`___t`） | 产品层次1~5 |
| `matl_grp_1`~`matl_grp_5` | 物料组层级1-5 |
| `zdpsyb` / `zdpsyb___t` | 事业部 |
| `plant` / `stor_loc` / `zww010` | 工厂/库存地点/产区 |
| `doc_number` / `s_ord_item` | 销售凭证/项目（批次挂单信息） |
| `ziswx` | 自制/外协 |

## 陷阱

1. **大表必带 calmonth 过滤**：628万行/月，无过滤查询会超时。
2. **两套计提政策不可混用**：内部口径 0/10/40/70%（6月段）+保质期 70/100% vs 已弃用的上市口径 0/20/30/50/50%（年段）。跌价数字跨口径对比无意义（202607 上市 1.43亿 vs 内部 2.877亿）。
3. **跌价/库龄金额分字段族**：`jchj_amt`（管理）≠ `jchj_aging`（阿米巴），库龄同理（`wbzq_*_amt` vs `wbzq_*_aging`）。查询必须显式选族。
4. **工厂特殊政策**：7220 工厂临期减值 70%、7C 工厂 2022-03 前后 0.6/0.7 切换、73 工厂 70%——跨期对比减值需提示口径跳变。
5. **有保质期产品**：bz_flag='Y' 仅 0.6%，按 `ybzq_*` 段位呈现；业务默认问无保质期分段。
6. 判空用 `LENGTH(TRIM(col))>0`，不要用 `TRIM(col)<>''`。
7. 库存金额：`zsjkcje`（实际库存金额，14.71亿）≠ `stock_amt`（阿米巴结算价，17.52亿）≠ CHDJ 阿米巴存货价值（6.35亿）——三套口径不可混用。

## 常见查询模式

### 跌价 TOP10（管理口径）
```sql
SELECT material, MAX(material___t) AS material_name,
       ROUND(SUM(jchj_amt)) AS fall_amt,
       ROUND(SUM(zsjkcje)) AS stock_amt,
       ROUND(SUM(wbzq_6_12_fall_amt)) AS fall_6_12m,
       ROUND(SUM(wbzq_12_24_fall_amt)) AS fall_12_24m,
       ROUND(SUM(wbzq_24_fall_amt)) AS fall_24m
FROM dm.dm_fin_stock_detail_accage_t_2023
WHERE calmonth = '202607'
GROUP BY material ORDER BY fall_amt DESC LIMIT 10;
```

### 库龄分段金额（按物料）
```sql
SELECT material, MAX(material___t) AS material_name,
       ROUND(SUM(wbzq_6_amt)) AS seg_0_6m,
       ROUND(SUM(wbzq_6_12_amt)) AS seg_6_12m,
       ROUND(SUM(wbzq_12_24_amt)) AS seg_12_24m,
       ROUND(SUM(wbzq_24_amt)) AS seg_24m,
       ROUND(SUM(wbzq_12_24_amt + wbzq_24_amt) / NULLIF(SUM(zsjkcje),0) * 100, 1) AS pct_over_12m
FROM dm.dm_fin_stock_detail_accage_t_2023
WHERE calmonth = '202607'
GROUP BY material ORDER BY seg_24m DESC LIMIT 20;
```

## 血缘

- **源系统**：SAP 库存明细账龄数据（MATDOC 物料凭证 + 批次主数据）
- **ETL**：`huaweiclaude/DM/PJob_DM_FIN_STOCK_DETAIL_ACCAGE_T_2023.txt`（Hive，5层CTE链）+ DWS 增量同步（DELETE+INSERT by calmonth）
- **跌价计算**：无保质期 `wbzq_6_amt*0 + wbzq_6_12_amt*0.1 + wbzq_12_24_amt*0.4 + wbzq_24_amt*0.7`；有保质期 `ybzq_bzdq_3_amt*0.7 + ybzq_bzdq_amt*1`（7220/7C/73 工厂另有政策）
- **上游明细**：`dm.dm_rpt_zzt_kcmx_t`（库存明细主表）+ 8 路 LEFT JOIN（物料主数据/批次/库位分类/品类/风险清单/库存地点对照）
- **关联文档**：[metrics.md](metrics.md) — 库存域语义层；[stock-accage.md](stock-accage.md) — 库存账龄明细主表；[chdj-capital-cost.md](chdj-capital-cost.md) — 阿米巴存货价值/资金成本
````

（外层 fence 用 4 个反引号包裹上述整块内容以保持内部 ```sql fence 结构；实际写入文件时外层用 4 反引号。）

- [ ] **Step 2: 重写 `skills/inventory-knowledge/references/stock-accage.md`（字段语义修正）**

替换点：
1. 第 5 行时间范围：`（1.44亿行，183 列，202012 ~ 202606）` → `（1.44亿行，183 列，202012 ~ 202608）`
2. 第 44-58 行字段表修正：
   - `| bz_flag | varchar | 包装标志 |` → `| bz_flag | varchar | 保质期标识（Y=有保质期，N=无保质期） |`
   - `| ybzq_bzdq_amt | numeric | 已包装周期-标准地区金额 |` → `| ybzq_bzdq_amt | numeric | 有保质期产品，保质期到期金额 |`
   - `| ybzq_bzdq_3_amt | numeric | 已包装周期-标准地区 3 月金额 |` → `| ybzq_bzdq_3_amt | numeric | 有保质期产品，距到期3个月以内金额 |`
   - `| wbzq_6_amt | numeric | 未包装周期 0-6月金额 |` → `| wbzq_6_amt | numeric | 无保质期产品，6个月以内金额 |`
   - `| wbzq_6_12_amt | numeric | 未包装周期 6-12月金额 |` → `| wbzq_6_12_amt | numeric | 无保质期产品，6-12月金额 |`
   - `| wbzq_12_24_amt | numeric | 未包装周期 12-24月金额 |` → `| wbzq_12_24_amt | numeric | 无保质期产品，1-2年金额 |`
   - `| wbzq_24_amt | numeric | 未包装周期 24月+金额 |` → `| wbzq_24_amt | numeric | 无保质期产品，2年以上金额 |`
   - `| ybzq_jc_amt | numeric | 已包装周期-检出金额 |` → `| ybzq_jc_amt | numeric | 有保质期减值 |`
   - `| wbzq_jc_amt | numeric | 未包装周期-检出金额 |` → `| wbzq_jc_amt | numeric | 无保质期减值 |`
   - `| jchj_amt | numeric | 检出合计金额 |` → `| jchj_amt | numeric | 减值合计（管理） |`
3. 第 47 行：`| zsjkcje | numeric | 资金占压金额（核心字段） |` → `| zsjkcje | numeric | 实际库存金额（管理口径核心字段） |`
4. 第 58 行后追加跌价字段族与阿米巴族说明块：
   ```markdown
   ### 跌价字段（计提比例 0/10/40/70% + 保质期 70/100%）
   
   | 字段 | 含义 |
   |---|---|
   | wbzq_6_fall_amt / wbzq_6_12_fall_amt / wbzq_12_24_fall_amt / wbzq_24_fall_amt | 无保质期各段跌价（0%/10%/40%/70%） |
   | ybzq_bzdq_3_fall_amt / ybzq_bzdq_fall_amt | 有保质期跌价（到期3月内 70% / 已到期 100%） |
   | jchj_amt | 减值合计-管理（= 各段之和，可直接 SUM） |
   | jchj_aging / wbzq_*_fall_aging / ybzq_*_fall_aging | 同上结构，阿米巴结算价口径（减值合计-阿米巴 3.301亿，202607） |
   | stock_amt | 库存金额（阿米巴结算价，202607 合计 17.52亿） |
   | clear_inv_flag / clearance_reason / promote_reason | 清库存标识 / 清仓原因 / 促销原因 |
   | time_diff / next_mon_date | 时间差（天）/ 下月日期 |
   ```
5. 第 3 条陷阱（"库龄字段众多…确认用哪个口径"）后追加一条：
   `4. **跌价两套字段族**：管理（jchj_amt/wbzq_*_fall_amt）与阿米巴（jchj_aging/*_fall_aging）金额不同（2.877 vs 3.301亿，202607），查询显式选族。`

- [ ] **Step 3: 重写 `skills/inventory-knowledge/references/metrics.md`**

替换点：
1. 第 108-109 行决策树：
   ```
   ├── 涉及“跌价准备”/“库龄分段金额”/“上市口径库存金额”？
   │   └── 用 dm.dm_fin_stock_d_accage_list_c_t_2023
   ```
   →
   ```
   ├── 涉及“跌价准备”/“库龄分段金额”/“库存金额（管理口径）”？
   │   └── 用 dm.dm_fin_stock_detail_accage_t_2023（jchj_amt / wbzq_*_fall_amt / zsjkcje）
   ```
2. 第 110-111 行：
   `├── 涉及“库存资金成本”（上市口径、批次级、正值）？` → `├── 涉及“库存资金成本”（批次级、正值）？`
3. 第 203 行日期表：删除 `| dm_fin_stock_d_accage_list_c_t_2023 | \`calmonth\` | YYYYMM | \`'202608'\` |` 一行。
4. 第八节（284-294 行）整节替换为：
   ```markdown
   ## 八、存货跌价与资金成本
   
   | 概念 | 权威字段 | 所在表 |
   |---|---|---|
   | 跌价合计（管理口径，计提 0%/10%/40%/70% + 保质期 70%/100%） | `jchj_amt` | `dm_fin_stock_detail_accage_t_2023`（calmonth=YYYYMM） |
   | 跌价分段（无保质期） | `wbzq_6_fall_amt`(0%) / `wbzq_6_12_fall_amt`(10%) / `wbzq_12_24_fall_amt`(40%) / `wbzq_24_fall_amt`(70%) | 同上 |
   | 跌价分段（有保质期） | `ybzq_bzdq_3_fall_amt`(70%) / `ybzq_bzdq_fall_amt`(100%) | 同上 |
   | 库存金额（管理口径） | `zsjkcje` | 同上 |
   | 库龄分段金额 | `wbzq_6_amt` ~ `wbzq_24_amt`（+`ybzq_*`） | 同上 |
   | 阿米巴口径（可选） | `stock_amt` / `jchj_aging` / `wbzq_*_aging` | 同上 |
   | 存货价值（阿米巴口径） | `inventory_value` | `dm_ambv2_chdj_grp_t`（stat_month=YYYY-MM） |
   | 库存资金成本 | `capital_cost*` | `dm_fin_stock_capital_cost_t`（month=YYYYMM，正值） / `dm_ambv2_chdj_grp_t` |
   
   **口径决策**：问跌价/库龄/库存金额 → dm_fin_stock_detail_accage_t_2023（管理字段族默认；SKU 效益域配 Mix 用阿米巴字段族）；问库存资金成本 → 默认 dm_fin_stock_capital_cost_t（批次级、正值、公式已验证），阿米巴分摊口径才用 dm_ambv2_chdj_grp_t（其 capital_cost 为负值、符号语义待 ETL 确认）。库存金额三套口径（管理 14.71亿 / 阿米巴 17.52亿 / CHDJ 6.35亿，2026-07）不可混用。上市口径表 `dm_fin_stock_d_accage_list_c_t_2023` 已弃用，禁止使用。详见 [stock-fall-list.md](stock-fall-list.md)、[chdj-capital-cost.md](chdj-capital-cost.md)、[capital-cost-table.md](capital-cost-table.md)。
   ```
5. 第 136 行 3.1 表速查 `| 金额字段 | \`zsjkcje\`（资金占压），\`stock_amt\`（库存金额） |` → `| 金额字段 | \`zsjkcje\`（实际库存金额-管理），\`stock_amt\`（阿米巴结算价）；跌价 \`jchj_amt\`/\`jchj_aging\` |`
6. 第 42 行 `| 包装标志 | \`bz_flag\` | dm_fin_stock_detail_accage_t_2023 | 区分已包装/未包装 |` → `| 保质期标识 | \`bz_flag\` | dm_fin_stock_detail_accage_t_2023 | Y=有保质期，N=无保质期 |`
7. 第 29 行 `| 库龄分段金额 | \`wbzq_6_amt\` / \`wbzq_6_12_amt\` / \`wbzq_12_24_amt\` / \`wbzq_24_amt\` | dm_fin_stock_detail_accage_t_2023 | 未包装周期分段 |` → `| 库龄分段金额 | \`wbzq_6_amt\` / \`wbzq_6_12_amt\` / \`wbzq_12_24_amt\` / \`wbzq_24_amt\` | dm_fin_stock_detail_accage_t_2023 | 无保质期分段（管理口径） |`
8. 第 275 条陷阱 `5. **库龄多套口径**：标准(wbzq/ybzq)、协议单价(xydj/xyzjdj)、爱米巴(amb_)、自然日历(zrzlcp_)。用户未指定口径时默认用标准` → `5. **库龄多套口径**：管理(wbzq/ybzq+fall_amt)、阿米巴(*_aging)、协议单价(xydj/xyzjdj)、自然日历(zrzlcp_)。用户未指定时默认管理口径；SKU 效益域配 Mix 用阿米巴口径`

- [ ] **Step 4: 重写 `skills/inventory-knowledge/SKILL.md`**

替换点：
1. 第 31 行：`| [stock-fall-list.md](references/stock-fall-list.md) | **存货跌价（上市口径）**。计提比例、库龄分段、天级细分、跌价 TOP |` → `| [stock-fall-list.md](references/stock-fall-list.md) | **存货跌价（内部口径）**。计提比例 0/10/40/70%+保质期、库龄分段、跌价 TOP |`
2. 第 33 行：`| [capital-cost-table.md](references/capital-cost-table.md) | **库存资金成本（上市口径，批次级，month=YYYYMM，正值）** |` → `| [capital-cost-table.md](references/capital-cost-table.md) | **库存资金成本（批次级，month=YYYYMM，正值）** |`
3. 第 62 行：删除 `  - \`dm_fin_stock_d_accage_list_c_t_2023\`：\`calmonth\` (YYYYMM)` 一行（第 58 行已有内部表）。

- [ ] **Step 5: 修正 `skills/inventory-knowledge/references/chdj-capital-cost.md` 与 `capital-cost-table.md`**

chdj-capital-cost.md：
1. 第 8 行：`（如 '2026-08'，注意与上市口径表 YYYYMM 不同！）` → `（如 '2026-08'，注意与内部口径表 dm_fin_stock_detail_accage_t_2023 的 calmonth YYYYMM 不同！）`
2. 第 27 行：`| \`stockcat\` | 库存类型（含 'K'，与上市口径表排除 K 不同，口径差的可查证据） |` → `| \`stockcat\` | 库存类型（含 'K'，与内部口径表排除 K 不同，口径差的可查证据） |`
3. 第 35 行：`1. **日期格式 YYYY-MM**（上市口径表是 YYYYMM），同一查询混用两张表时必须分别处理。` → `1. **日期格式 YYYY-MM**（内部口径表 calmonth 是 YYYYMM），同一查询混用两张表时必须分别处理。`
4. 第 36 行：`2. 存货价值口径 6.35亿 ≠ 上市口径 14.3亿（阿米巴核算范围不同），**不可跨表加减**。` → `2. 存货价值口径 6.35亿 ≠ 内部口径管理金额 14.71亿（阿米巴核算范围不同），**不可跨表加减**。`
5. 第 37 行：`同名字段 capital_cost 在 dm_fin_stock_capital_cost_t（上市口径，month=YYYYMM）为正值且公式已验证；上市口径或需正号成本时用彼表。` → `同名字段 capital_cost 在 dm_fin_stock_capital_cost_t（month=YYYYMM）为正值且公式已验证；需正号成本时用彼表。`
6. 第 61 行：`- [stock-fall-list.md](stock-fall-list.md) — 上市口径跌价（另一套库存口径）` → `- [stock-fall-list.md](stock-fall-list.md) — 内部口径跌价（管理字段族）`

capital-cost-table.md：
1. 第 6 行：`- **业务含义**：按物料×工厂×批次×库存地点核算的库存资金成本（上市口径），公式为...` → `- **业务含义**：按物料×工厂×批次×库存地点核算的库存资金成本，公式为...`（删"（上市口径）"）
2. 第 41 行：`两套核算体系（上市口径 vs 阿米巴口径），**不可混用**。` → `两套核算体系（资金成本表 vs 阿米巴 CHDJ），**不可混用**。`
3. 第 42 行：`**closing_balance 14.3亿 ≠ CHDJ inventory_value 6.35亿**：上市口径含全部库存...` → `**closing_balance 14.3亿 ≠ CHDJ inventory_value 6.35亿**：资金成本表口径含全部库存...`
4. 第 45 行：`4. **物料字段名不同**：本表用 \`material_code\`，CHDJ 表用 \`material_num\`，上市口径明细表用 \`material\`。` → `4. **物料字段名不同**：本表用 \`material_code\`，CHDJ 表用 \`material_num\`，内部口径明细表（dm_fin_stock_detail_accage_t_2023）用 \`material\`。`
5. 第 65 行：`源表：\`DM.DM_FIN_STOCK_DETAIL_ACCAGE_T_2023\`（上市口径库存明细）` → `源表：\`DM.DM_FIN_STOCK_DETAIL_ACCAGE_T_2023\`（财务/内部口径库存明细主表）`
6. 第 72 行：`- [stock-fall-list.md](stock-fall-list.md) — 上市口径跌价表` → `- [stock-fall-list.md](stock-fall-list.md) — 内部口径跌价表`

- [ ] **Step 6: 验证重写 SQL**

用 MCP `run_query` 执行 stock-fall-list.md 重写版的两个查询模式（跌价 TOP10 管理口径、库龄分段），Expected: 各 10/20 行，TOP 跌价量级百万级（202607 实测 TOP 约 200-500 万管理口径）；库龄分段 `pct_over_12m` 合理区间 20-60%。

- [ ] **Step 7: 提交**

```bash
git add skills/inventory-knowledge/SKILL.md skills/inventory-knowledge/references/metrics.md skills/inventory-knowledge/references/stock-fall-list.md skills/inventory-knowledge/references/stock-accage.md skills/inventory-knowledge/references/chdj-capital-cost.md skills/inventory-knowledge/references/capital-cost-table.md
git commit -m "refactor(inventory): 库存跌价迁移内部口径表（管理字段族），修正 stock-accage 字段语义"
```

---

### Task 4: 收尾验证

**Files:**
- 无修改；验证性任务

**Interfaces:**
- Consumes: Task 1-3 全部产出

- [ ] **Step 1: 全仓 grep 零残留**

Run:
```bash
grep -rn "dm_fin_stock_d_accage_list_c_t_2023\|accage_list_c_t\|aging_sum_fall_amt\|aging_1_year_fall_amt\|aging_1_2_year_fall_amt" --include="*.md" --include="*.json" --include="*.py" /home/dp-user/dataprojv2 --exclude-dir=.git --exclude-dir=huaweiclaude --exclude-dir=docs
```
Expected: 无输出（`docs/superpowers/` 历史文档与 `huaweiclaude/` 原始导出被排除，属预期保留）。

再确认 docs 下的残留仅限历史文档：
```bash
grep -rln "dm_fin_stock_d_accage_list_c_t_2023" /home/dp-user/dataprojv2/docs /home/dp-user/dataprojv2/huaweiclaude 2>/dev/null | head
```
Expected: 仅 `docs/superpowers/plans/2026-08-18-*`、`docs/superpowers/specs/2026-08-18-*`、`huaweiclaude/*` 文件（历史归档）。

- [ ] **Step 2: run_eval 全量回归**

Run: `/usr/bin/python3 run_eval.py`
Expected: 66/66 全部 PASS（Accuracy 100%）。若有 FAIL，定位到具体场景并检查是否与本次迁移相关（Task 2 已单独回归过 sku-profitability，理论上只有其他域场景不受影响）。

- [ ] **Step 3: pytest 全套回归**

Run: `/usr/bin/python3 -m pytest skills/report-generator/tests/ -v`
Expected: 全部 PASS（本次改动不涉及 report-generator，应保持 35 个用例全绿）。

- [ ] **Step 4: 数据佐证记录写入（可选增强）**

若 Task 1/3 的报告缺实测量级截图，可补跑一条汇总 SQL 佐证文档数字：
```sql
SELECT calmonth, ROUND(SUM(zsjkcje)) AS stock_mgmt, ROUND(SUM(jchj_amt)) AS fall_mgmt,
       ROUND(SUM(stock_amt)) AS stock_amb, ROUND(SUM(jchj_aging)) AS fall_amb
FROM dm.dm_fin_stock_detail_accage_t_2023
WHERE calmonth IN ('202607','202608') GROUP BY calmonth ORDER BY calmonth
```
Expected: 202607 = 14.71亿 / 2.877亿 / 17.52亿 / 3.301亿（与文档一致）。

- [ ] **Step 5: 无 git 提交（验证任务）**

验证通过后本任务不产生提交；若发现需修复项，由修复者按所属任务提交。

---

## 执行顺序与依赖

Task 1 → Task 2（依赖 Task 1 验证过的 SQL 蓝本）→ Task 3（独立）→ Task 4（依赖全部）。Task 2 与 Task 3 无相互依赖，但 eval SQL 与 analyst 模式 SQL 必须字段一致（Task 2 在 Task 1 之后执行以保证）。
