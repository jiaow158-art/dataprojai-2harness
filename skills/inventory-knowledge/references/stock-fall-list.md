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
