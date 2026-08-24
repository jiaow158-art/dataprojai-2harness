# 库存账龄明细（库龄明细主表）

## 快速参考

- **DWS 表名**：`dm.dm_fin_stock_detail_accage_t_2023`（1.44亿行，183 列，202012 ~ 202608，持续刷新）
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

> 减值体系对照（管理默认/阿米巴/上市非默认）见 [metrics.md](metrics.md) 第八节。**本表 jc/fall 族与上市口径表 `aging_*_fall_amt` 是两套体系，禁止混用或相加；上市口径表非默认（仅特殊要求且须声明）。**

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

### 跌价字段（计提比例 0/10/40/70% + 保质期 70/100%，预计算可直接 SUM）

| 字段 | 含义 |
|---|---|
| wbzq_6_fall_amt / wbzq_6_12_fall_amt / wbzq_12_24_fall_amt / wbzq_24_fall_amt | 无保质期各段跌价（0%/10%/40%/70%） |
| ybzq_bzdq_3_fall_amt / ybzq_bzdq_fall_amt | 有保质期跌价（到期3月内 70% / 已到期 100%） |
| jchj_amt | 减值合计-管理（= 各段之和，可直接 SUM；亦 = wbzq_jc_amt+ybzq_jc_amt，2026-08-19 复算 0% 偏差） |
| jchj_aging / wbzq_*_fall_aging / ybzq_*_fall_aging | 同上结构，阿米巴结算价口径（减值合计-阿米巴 3.301亿，202607） |
| stock_amt | 库存金额（阿米巴结算价，202607 合计 17.52亿） |
| clear_inv_flag / clearance_reason / promote_reason | 清库存标识 / 清仓原因 / 促销原因 |
| time_diff / next_mon_date | 时间差（天）/ 下月日期 |

### 维度字段

`calmonth`/`calyear`、`material`/`material___t`、`plant`/`plant___t`、`stor_loc`/`stor_loc___t`、`batch`、`stockcat`/`stocktype`（+`___t`）、`comp_code`（+`___t`）、`extmatlgrp`、`matl_grp_1~5`（+`___t`）、`zprodh1~5`（+`___t`）、`wbs_elemt`、`vendor`、`val_class`、`unit`、`zdpsyb`（事业部）、`zdpzgsdq`（子公司大区）、`zyl01`（产品渠道）、`zyl06`（产品等级）、`zww010`（产区）、`zisqc`（清仓）、`ziswx`（自制/外协）、`matl_type`、`zmatltype`

## 陷阱

1. **表名带 `_2023` 但覆盖 202012 起全量**（最新 202608），不要跨表 UNION；`dm_fin_stock_detail_accage_t`（91列旧表）与 `_others_t` 不用
2. **`___t` 后缀** = 三下划线+t 文本描述（`plant` → `plant___t`）
3. **四套库龄口径并存**（标准 wbzq/zrzlcp、协议单价 xydj、阿米巴 *_aging、减值 jc/fall 族），用户未指定时默认标准 `wbzq_*_amt`
4. **wbzq/ybzq 是保质期维度不是包装维度**；ybzq 字段只会在 bz_flag='Y' 行有值（2026-08 实证排他性）
5. **jc 减值有保质期工厂白名单**（7C/73/7220），其余工厂 `ybzq_jc_amt` 恒 0——按事业部汇总减值时勿以为漏算
6. **plant 7C 分桶日期字段不同**（zpcrk_fc），跨工厂库龄对比存在口径微差
7. 大表必带 `calmonth` 过滤；calmonth NOT NULL（DWS 实测无 NULL 行）
8. zprodh 与 matl_grp 两套产品层级并存，过滤产品优先 `matl_grp_*`
9. **跌价两套字段族**：管理（jchj_amt/wbzq_*_fall_amt，2.877亿）与阿米巴（jchj_aging/*_fall_aging，3.301亿）（202607），查询显式选族；`stock_amt`（阿米巴 17.52亿）≠ `zsjkcje`（管理 14.71亿）

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
  - → `dm_fin_stock_d_accage_list_c_t_2023`（上市口径表，非默认——仅特殊要求）

## 交叉引用

- 语义层 → [metrics.md](metrics.md)；内部口径跌价（管理/阿米巴字段族）→ [stock-fall-list.md](stock-fall-list.md)；CHDJ → [chdj-capital-cost.md](chdj-capital-cost.md)；资金成本 → [capital-cost-table.md](capital-cost-table.md)；库存统计月报 → [stock-stat-month.md](stock-stat-month.md)
