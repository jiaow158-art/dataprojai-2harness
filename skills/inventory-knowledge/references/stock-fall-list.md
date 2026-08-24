# dm_fin_stock_d_accage_list_c_t_2023 — 存货跌价·上市口径表

## 快速参考

- **DWS 表名**：`dm.dm_fin_stock_d_accage_list_c_t_2023`
- **业务含义**：上市（在售）口径的库存+账龄+跌价准备表，批次级。跌价字段内嵌集团会计政策计提比例。
- **实体粒度**：一行 = 查询日期 × 批次 × calmonth × 物料 × 工厂 × 库存地点 组合
- **数据量**：约 600 万行/月（202608：607万行，64,605 SKU，实际库存金额 14.3亿，跌价合计 1.43亿）
- **时间格式**：`calmonth` = **YYYYMM**（如 '202607'）
- **注意**：结尾 `_2023` 是历史命名，实际持续更新（202608 已有数），不要找"无后缀版本"

## 跌价字段（含计提比例 — 集团会计政策）

| 字段 | 口径 | 计提比例 |
|---|---|---|
| `aging_1_year_fall_amt` | 1年以内跌价 | 0% |
| `aging_1_2_year_fall_amt` | 1-2年跌价 | 20% |
| `aging_2_3_year_fall_amt` | 2-3年跌价 | 30% |
| `aging_3_4_year_fall_amt` | 3-4年跌价 | 50% |
| `aging_4_year_fall_amt` | 4年以上跌价 | 50% |
| `aging_sum_fall_amt` | **跌价合计（预计算，直接 SUM 用）** | — |

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

## 账龄金额/数量/面积字段

- 年段：`aging_1_year_amt`、`aging_1_2_year_amt`、`aging_2_3_year_amt`、`aging_3_4_year_amt`、`aging_4_year_amt`
- 天级细分（三套后缀 `_amt`/`_qty`/`_area`）：`aging_0_30_*`、`aging_31_60_*`、`aging_61_90_*`、`aging_91_180_*`、`aging_181_270_*`、`aging_271_360_*`，另有 aging_361_450_* ~ aging_1441_*（90天一档至1440天+，覆盖1~4年天级细分）（→可聚出"半年内/半年-一年"口径**金额**；**跌价只有年段口径**）
- 库存总额：zsjkcje（实际库存金额；与本域 stock-accage.md 同名字段同源，彼处称"资金占压金额"）

## 关键维度

| 字段 | 说明 |
|---|---|
| `material` / `material___t` | 物料编码/描述（对应 Mix 表 `material_num`） |
| `query_date` | 快照日期 YYYYMMDD，每个 calmonth 恒定一个值，过滤用 calmonth 即可 |
| `zisqc` | 是否清仓（处置建议分析用） |
| `category` / `category_name` | 品类 |
| `product_position` / `product_position_name` | 产品定位 |
| `zprodh1`~`zprodh5`（+`___t`） | 产品层次1~5 |
| `zdpsyb` / `zdpsyb___t` | 事业部 |
| `plant` / `stor_loc` / `zww010` | 工厂/库存地点/产区 |
| `doc_number` / `s_ord_item` | 销售凭证/项目（批次挂单信息） |
| `batch` / `zmmm_o017_zbatch_date` | 批次/入库日期 |
| `ziswx` | 自制/外协 |

## 陷阱

1. **大表必带 calmonth 过滤**：600万行/月，无过滤查询会超时。
2. **跌价只有年段**，业务问"半年分段跌价"时透明说明，金额可用天级细分聚合。
3. **口径独此一家（会计口径）**：本表跌价（0/20/30/50/50%）与库龄明细表 jc 族**管理口径减值**（0/10/40/70%）、CHDJ `inventory_value`（=管理减值合积分摊）是**三套体系**，禁止混用或相加。问会计跌价/库龄→本表；问库存资金成本→`dm_fin_stock_capital_cost_t`（正值主口径）；问管理减值/线组分摊→CHDJ。
4. `material` 在本表 6.4万 SKU，Mix 表在售仅 6,232——跨表 JOIN 前声明对齐口径（通常以 Mix 为主集 LEFT JOIN 本表）。
5. 判空用 `LENGTH(TRIM(col))>0`，不要用 `TRIM(col)<>''`。

## 常见查询模式

### 跌价 TOP10
```sql
SELECT material, MAX(material___t) AS material_name,
       ROUND(SUM(aging_sum_fall_amt)) AS fall_amt,
       ROUND(SUM(zsjkcje)) AS stock_amt,
       ROUND(SUM(aging_1_2_year_fall_amt)) AS fall_1_2y,
       ROUND(SUM(aging_2_3_year_fall_amt)) AS fall_2_3y,
       ROUND(SUM(aging_3_4_year_fall_amt)) AS fall_3_4y,
       ROUND(SUM(aging_4_year_fall_amt)) AS fall_4y
FROM dm.dm_fin_stock_d_accage_list_c_t_2023
WHERE calmonth = '202607'
GROUP BY material
ORDER BY fall_amt DESC
LIMIT 10;
```

### 半年口径库存金额分段
```sql
SELECT material,
       ROUND(SUM(aging_0_30_amt + aging_31_60_amt + aging_61_90_amt + aging_91_180_amt)) AS within_half_year,
       ROUND(SUM(aging_181_270_amt + aging_271_360_amt)) AS half_to_1y,
       ROUND(SUM(aging_1_2_year_amt)) AS y1_2,
       ROUND(SUM(aging_2_3_year_amt + aging_3_4_year_amt + aging_4_year_amt)) AS over_2y
FROM dm.dm_fin_stock_d_accage_list_c_t_2023
WHERE calmonth = '202607'
GROUP BY material
ORDER BY within_half_year DESC
LIMIT 20;
```

## 血缘

- **源系统**：SAP 库存明细账龄数据
- **上游明细表（DM 层）**：`dm.dm_fin_stock_detail_accage_t_2023`（财务口径库龄明细主表，按 batch + calmonth 粒度存储）
- **维度关联**：
  - `dm.dm_rpt_prod_category_t` — 产品品类/定位（ON `zprodh3 = prod_level3_code`）
  - `dwimd.dwi_md_data_material_general_t` — 物料主数据（ON `material = material_num`，取 length/width 算面积）
- **过滤条件**：`stockcat <> 'K' OR stockcat IS NULL`（排除非在售库存类别，保留上市口径）
- **刷新方式**：按 `calmonth` 先 DELETE 再 INSERT（全量刷新当月），调度参数 `${PERIOD_ID_M}`
- **面积计算**：单位为 M2 时直接取 quantity；否则取 `length_1 * width / 1000000`（含 area1 = 面积×数量）

## 关联文档

- [metrics.md](metrics.md) — 库存域语义层
- [stock-accage.md](stock-accage.md) — 库龄明细主表（财务口径）
- [chdj-capital-cost.md](chdj-capital-cost.md) — 阿米巴存货价值/资金成本
