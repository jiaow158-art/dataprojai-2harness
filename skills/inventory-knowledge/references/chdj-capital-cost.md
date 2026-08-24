# dm_ambv2_chdj_grp_t — 存货减值/资金成本·线组分摊表（CHDJ）

## 快速参考

- **DWS 表名**：`dm.dm_ambv2_chdj_grp_t`（CHDJ=存货跌价拼音缩写；ETL 描述"存货跌价分摊（线组）"）
- **真实业务含义（2026-08-19 ETL 解码+DWS 实证）**：把**管理口径存货减值 + 库存资金成本**按年度预算比例分摊到线组/渠道。⚠️ **表内没有会计口径跌价金额，也没有"库存价值"**——见核心字段语义
- **实体粒度**：一行 = stat_month × 物料 × 工厂 × 库存地点 × 产品渠道 × 销售组（线组）
- **数据量**：约 28 万行/月（2026-08：27.8万行，35,770 SKU）
- **时间格式**：`stat_month` = **YYYY-MM**（如 '2026-08'，注意与内部口径表 dm_fin_stock_detail_accage_t_2023 的 calmonth YYYYMM 不同！）
- **刷新**：`delete where stat_month='${PERIOD_ID_M}'` + insert（按月）

## ⚠️ 核心字段语义（ETL 实证，推翻旧解读）

| 字段 | ✅ ETL 实证语义 | 计算来源 |
|---|---|---|
| `inventory_value` | **管理口径减值合计**（≠库存价值！） | `SUM(wbzq_jc_amt + ybzq_jc_amt)`，源：内部表 jc 族（比例 0/10/40/70% + 保质期工厂白名单）；瓷砖分支复算 0% 偏差实证 |
| `inventory_value_amb` | **阿米巴结算价减值** | `SUM(ybzq_jc_aging + wbzq_jc_aging)`；仅瓷砖 11000001 / 11240102 / 11250401 分支非零，卫浴族恒 0 |
| `contributory_value` | 分摊减值 = 减值 × 销售/工厂比例 | 比例 null 取 1 |
| `capital_cost` / `capital_cost_sum` | 取自 dm_fin_stock_capital_cost_t（同月范围子集）；**⚠️ 原始列在分摊行结构中重复携带全额，SUM 放大 ~9×/物料、可反号——禁止 SUM 当金额** | 同月（month YYYYMM ↔ stat_month YYYY-MM 转换），范围过滤后聚合 |
| `capital_cost_conv` / `capital_cost_sum_conv` | 分摊资金成本 / 分摊累计资金成本（**金额合计以本对列为准**：与源表吻合 0.3%） | capital_cost(_sum) × 同比例 |
| `percentage` | 销售/工厂比例 | 按年度预算（upload_achievement_budget_t）分摊；预算缺失取上一年度 |
| `sales_grp` / `sales_grp_sum` / `center_sum` | 线组 / 线组汇总 / 中心汇总（预算金额） | 分摊基数 |
| `zdpsyb` | 事业部（码表见 [org-hierarchy.md](../../sources-of-truth/business-context/org-hierarchy.md) node2 枚举，去 H 前缀；11000011/11000012 为卫浴旧组织，ETL 注释标注） | — |
| 其余维度 | `material_num`/`material_name`、`plant`(+`___t`)、`stor_loc`(+`___t`)、`prod_channal`(+`_name`，注意拼写)、`base_name` 基地、`zww010`(+`___t`) 产区、`comp_code`、`stockcat`、`distribution_channel` 渠道、`ext_grp`、`product_level_code`、`prod_line_name` | — |

## 覆盖范围（分摊对象，非全集团）

卫浴族 zdpsyb IN ('11000002','11000011','11000012')（排除 plant 3A/3B/3C/39、extmatlgrp 10050，prop 大区走独立分支）+ 瓷砖 11000001 + 11240102（国际营销）+ 11250401（丽适岩板）。
2026-08 实测构成：卫浴 3.91亿（61%）/ 瓷砖 2.32亿 / 国际 560万 / 卫浴旧组织 460万 / 丽适 160万。

## 陷阱

1. **`inventory_value` 不是库存价值**：是管理口径减值（2026-08-19 ETL+DWS 双实证：内部表 jc 复算与 CHDJ 值一致）。与内部表 `zsjkcje`（库存金额 14.71亿，202607）是**概念不同**（减值 vs 金额）+**范围不同**（部分事业部 vs 全集团），"6.35亿 vs 14.71亿"不是两套库存口径之差。
2. **问跌价默认 → 内部表** `jchj_amt`（管理口径预计算，0/10/40/70%+保质期 70/100%）；问线组分摊 → 本表；上市口径表非默认（仅特殊要求且须声明）。多套体系禁止混用或相加。
3. **`capital_cost` 原始列禁止 SUM 当金额**（V6 实证）：分摊行结构中每行重复携带全额（单物料放大 ~9×，2026-08 全表 -35.3万 vs 源表 +58.1万，符号都反）。需要金额合计 → SUM `capital_cost_conv`（与源表吻合 0.3%）或直接查 `dm_fin_stock_capital_cost_t`。源表本身的负值语义（平均余额<202012基线→负）仍然成立。
4. `stat_month` 格式 YYYY-MM（内部表 calmonth 是 YYYYMM）；表内无 `calmonth` 字段。
5. `stockcat` 含 'K'（与内部口径表排除 K 不同）。
6. **ETL 隐患**：末段以 `物料描述 = material_num`（描述 JOIN 编码）关联物料主数据取产品层次 → `product_level_code`/`prod_line_name` 可靠性受限，做产品线分析优先用物料主数据表重关联。
7. 阿米巴结算价减值（inventory_value_amb）仅 3 个瓷砖系分支有值，跨事业部汇总时注意非瓷砖分支恒 0。

## 常见查询模式

### 线组分摊减值与资金成本
```sql
SELECT sales_grp,
       ROUND(SUM(inventory_value)) AS impairment_mgmt,
       ROUND(SUM(contributory_value)) AS impairment_allocated,
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

- [metrics.md](metrics.md) — 语义层（跌价/减值体系对照表）
- [stock-fall-list.md](stock-fall-list.md) — 内部口径跌价（管理字段族）
- [capital-cost-table.md](capital-cost-table.md) — 库存资金成本表（capital_cost 源头）
