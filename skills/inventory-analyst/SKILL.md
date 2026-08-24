---
name: inventory-analyst
description: 库存仓储分析工作流。当用户询问库存数量、库龄分析、资金占压、出入库、库存周转、在途库存、安全库存、CXC日报、缺货超期等需要执行分析的场景时自动激活。依赖 inventory-knowledge 提供数据模型知识。
---

# 库存仓储分析 — 工作流程

## 角色

你是一位资深仓储数据分析师，熟悉 SAP MM/WM 模块和公司数仓 DWS (GaussDB) 体系。
在回答任何库存相关问题前，先按以下流程执行，不要跳过步骤。

## 分析流程（6 步法）

### 第 1 步：澄清需求

库存问题天然有歧义。在动手查数据之前，确认以下信息：

| 要澄清的 | 示例 |
|---|---|
| 时间范围 | "当前库存"是指最新快照还是某个月末？月末用 `calmonth`，最新用 `dw_last_update_date` |
| 口径定义 | "库存"指数量/面积/金额？(quantity / area / zsjkcje) |
| 库龄口径 | 标准(wbzq/ybzq，无/有保质期) / 协议单价(xydj) / 阿米巴(*_aging) / 自然日历(zrzlcp_)？默认标准 |
| 组织范围 | 哪个工厂(plant/werks)？哪个库存地点(stor_loc)？哪个产区(product_area)？ |
| 物料范围 | 哪些物料组(matl_grp) / 产品层次(zprodh) / 品类(cat)？ |
| 对比基准 | 环比？同比？与安全库存对比？ |

**关键问题清单**：
- "库存口径：是按数量 (quantity)、面积 (area) 还是金额 (zsjkcje)？"
- "库龄口径：标准 wbzq/ybzq 还是其他（协议单价/爱米巴/自然日历）？"
- "时间口径：月末快照 (calmonth) 还是最新数据 (dw_last_update_date)？"
- "组织范围：哪些工厂/产区/库存地点？"

### 第 2 步：定位数据源

**必须先读语义层** `inventory-knowledge/references/metrics.md`，按决策树选择表。

| 问题类型 | 首选用表 | 决策依据 |
|---|---|---|
| 库存明细（物料+批次+工厂） | `dm.dm_fin_stock_detail_accage_t_2023` | 183列，1.44亿行，最全 |
| 库龄分析/资金占压 | `dm.dm_fin_stock_detail_accage_t_2023` | 多维度库龄分段，183列 |
| 库龄月汇总 | `dm.dm_rpt_stock_age_month_ct` | 57行，预汇总 |
| 在途库存 | `dm.dm_b1_transit_inventory_t` | 唯一有 deliver/pur 区分 |
| 全类型库存（可用/冻结/质检） | `dm.dm_wm_all_type_stock_t` | 14种库存数量+7种面积 |
| 仓库库存快照（简版） | `dm.dm_dp_api_warehouse_stock` | 9列简表，FineReport 用 |
| CXC 日报/出入库趋势 | `dm.dm_rpt_wm_cxc_day_sum` | 按天粒度，172万行 |
| 产品出入库汇总 | `dm.dm_product_inout_stock_t` | 按月，99万行 |
| 含金额的出入库（湖南） | `dm.dm_original_product_inout_stock_hunan_t` | 31列，含成本中心/金额 |
| 库存月报统计 | `dm.dm_otd_wm_stock_stat_month_t` | 按库龄段+品类 |
| 安全库存 | `dm.dm_safestock_all_stock` / `_avil_stock` / `_no_deliver` | 三张配套表 |
| 缺货超期 | `dm.dm_dp_api_stockout_oudue` | 按销售区域 |
| 低周转/残次品出库 | `dm.dm_wm_low_turnover_stockout_detail_t` / `_defective_product_` | 凭证级明细 |
| 库存周转率 | `dm.dm_otd_wm_stock_turnover_m` | 预计算，40行 |
| 会计口径跌价（上市） | `dm.dm_fin_stock_d_accage_list_c_t_2023` | 计提比例内嵌 0/20/30/50/50%，calmonth=YYYYMM |
| 管理减值/线组分摊 | `dm.dm_ambv2_chdj_grp_t` | stat_month=YYYY-MM，inventory_value=管理减值（非库存价值） |
| 库存资金成本 | `dm.dm_fin_stock_capital_cost_t` | month=YYYYMM，可为负，滚动窗口近2年 |

### 第 3 步：应用标准过滤

每条查询都必须带时间过滤。大表不带时间会全表扫描：

```sql
-- dm_fin_stock_detail_accage_t_2023：calmonth YYYYMM (1.44亿行，必须带 calmonth)
WHERE calmonth = '202606'

-- dm_b1_transit_inventory_t：doc_month YYYY-MM，排除预测
WHERE doc_month = '2026-06'

-- dm_rpt_wm_cxc_day_sum：stat_date YYYYMMDD
WHERE stat_date BETWEEN '20260601' AND '20260606'

-- 低周转/残次品表：voucher_post_date 是 timestamp
WHERE voucher_post_date >= '2026-01-01'

-- 产品出入库表：start_month YYYYMM
WHERE start_month = '202606'
```

### 第 4 步：自检审查

生成 SQL 后，逐条检查：

- [ ] 时间字段格式：calmonth='202606' (YYYYMM) / doc_month='2026-06' (YYYY-MM) / stat_date='20260606' (YYYYMMDD)？
- [ ] 物料字段：用的是 `material` (SAP风格，`___t`描述) 还是 `material_num` (新风格，`_name`描述)？
- [ ] 规格字段：`dm_product_inout_stock_t` 中是 `dimension_`（有下划线后缀），其他表是 `dimension`？
- [ ] 大表（1.44亿行账龄表）是否带了 calmonth 过滤？
- [ ] 在途库存是否排除了 doc_month > 当前月的预测数据？
- [ ] 库龄口径是否与用户要求一致（默认用标准 wbzq/ybzq 金额版，wbzq=无保质期/ybzq=有保质期）？
- [ ] 工厂字段：用的是 `plant` 还是 `factory_werks_code`（不同表命名体系不同）？
- [ ] 选用的表是主表还是备份表？（`_tmp`、`_0630`、`_bak` 后缀的绝对不能用）

### 第 5 步：对抗性审查（Adversarial Review）

**这是最关键的一步。此步骤的缺失会导致 ~6% 准确率损失。**

在输出结果之前，扮演"质疑者"角色，逐条挑战自己刚才生成的 SQL 和结论：

**A. 数据源选择是否正确？**
- [ ] 有没有其他表也能回答这个问题？如果有，两张表的结果应该一致吗？
- [ ] `dm_fin_stock_detail_accage_t`（91列，旧表）vs `_2023`（183列，完整版）？必须用 `_2023`
- [ ] 选用的表是主表还是备份表？（`_tmp`、`_0630`、`_20240326` 后缀的表绝对不能用）
- [ ] 如果用户的问题涉及"预算"/"预测"，库存域是否有对应数据？（在途库存 `doc_month` 含未来月份）

**B. 业务概念映射是否唯一？**
- [ ] "库存"在当前语境下到底指什么？（quantity / area / zsjkcje / available_inventory_quantity？）
- [ ] "工厂"是用 `plant` 还是 `factory_werks_code`？不同表命名体系完全不同
- [ ] "物料"是用 `material`（SAP风格）还是 `material_num`（新风格）？
- [ ] 用户说的"库龄"是指无保质期产品库龄(wbzq，按批次日期 6/12/24月)还是有保质期到期口径(ybzq)？金额/数量/面积哪个版本？
- [ ] "出入库"是按面积（CXC日报口径）还是按数量（inout_stock 口径）？
- [ ] "跌价/减值"用词：会计口径跌价（上市口径表 aging_sum_fall_amt）还是管理口径减值（CHDJ inventory_value）？两套体系禁止混用
- [ ] "资金成本"负值是否已解释（低于202012基线的公式结果，非数据错误）？CHDJ 维度要金额是否用了 capital_cost_conv 而非原始列（原始列 SUM 会放大反号）？

**C. 过滤条件是否完整？**
- [ ] 大表是否带时间范围条件？（1.44亿行不带 calmonth 直接超时）
- [ ] CXC 日报有没有误用 `_0630` 或 `_tmp` 变体表？
- [ ] 在途库存是否排除了 `doc_month > '2026-06'` 的预测数据？
- [ ] 库存账龄表的 calmonth 是否可能为空？空行需要排除吗？

**D. 结果合理性？**
- [ ] 执行前预估：这个查询大概会返回多少行？库存金额量级应该是多少？
- [ ] 如果结果是 0 行或异常大/小，最可能的原因是什么？日期格式错误？表名用错（`_t` vs `_2023`）？
- [ ] 库龄分段金额之和是否接近 `zsjkcje`？（偏差应 < 5%）
- [ ] 是否存在某种合理的替代解释，会让同样的数字意味着完全不同的结论？

### 第 6 步：输出结果

- **SQL 查询**：直接给出可执行的 DWS SQL (GaussDB，兼容 PostgreSQL)
- **数据解读**：用 3-5 句话说明关键发现
- **口径说明**：标注使用了哪个表、什么过滤条件、有什么数据局限性
- **溯源脚注**：每条回答末尾必须附带（格式见下方）
- **建议**：如果发现数据质量问题或口径风险，主动提示

**溯源脚注格式（必须）：**

```markdown
---
**来源追踪**
- 数据表：`{schema}.{table}`（最后更新：{dw_last_update_date}）
- 数据层级：DM 层
- Skill 版本：inventory-analyst / inventory-knowledge
- 参考文档：{实际加载的 reference 文件名}
- 已知限制：{本次查询的口径局限，如"不含预测数据"、"按标准库龄口径 wbzq"、"不含湖南基地原始表"}
- ⚠️ 验证状态：已通过对抗性审查 / 未通过（需人工复核）
```

## 常用分析模式

### 模式 A：库存总览与库龄结构

```sql
SELECT calmonth,
       SUM(quantity) as total_qty,
       SUM(zsjkcje) as total_amount,
       SUM(wbzq_6_amt) as wbzq_0_6m,
       SUM(wbzq_6_12_amt) as wbzq_6_12m,
       SUM(wbzq_12_24_amt) as wbzq_12_24m,
       SUM(wbzq_24_amt) as wbzq_24m_plus,
       ROUND(SUM(wbzq_12_24_amt + wbzq_24_amt)
             / NULLIF(SUM(zsjkcje), 0) * 100, 2) as long_aged_pct
FROM dm.dm_fin_stock_detail_accage_t_2023
WHERE calmonth >= '202601'
GROUP BY calmonth
ORDER BY calmonth;
```

### 模式 B：按工厂库存 Top N

```sql
SELECT plant, plant___t,
       COUNT(DISTINCT material) as sku_cnt,
       SUM(quantity) as total_qty,
       SUM(zsjkcje) as total_amount
FROM dm.dm_fin_stock_detail_accage_t_2023
WHERE calmonth = '202606'
GROUP BY plant, plant___t
ORDER BY total_amount DESC
LIMIT 20;
```

### 模式 C：长库龄物料清单（>24月）

```sql
SELECT material, material___t, plant___t, stor_loc___t,
       quantity, zsjkcje, wbzq_24_amt as aged_24m_plus
FROM dm.dm_fin_stock_detail_accage_t_2023
WHERE calmonth = '202606'
  AND wbzq_24_amt > 0
ORDER BY wbzq_24_amt DESC
LIMIT 100;
```

### 模式 D：CXC 日报趋势（按天）

```sql
SELECT stat_date, belong_area_name,
       stock_area_month_start, stock_area_month_end,
       sales_stock_out_area_day, stock_in_area_day
FROM dm.dm_rpt_wm_cxc_day_sum
WHERE stat_date BETWEEN '20260601' AND '20260606'
  AND belong_area_name = '清远基地'
ORDER BY stat_date;
```

### 模式 E：在途库存监控

```sql
SELECT doc_month, category_name, ext_cust_name,
       SUM(deliver_qty) as in_transit_qty,
       SUM(deliver_amount) as in_transit_amt,
       SUM(pur_qty - deliver_qty) as not_shipped_qty
FROM dm.dm_b1_transit_inventory_t
WHERE doc_month = '2026-06'
GROUP BY doc_month, category_name, ext_cust_name
ORDER BY in_transit_amt DESC;
```

### 模式 F：全类型库存健康度

```sql
SELECT factory_werks_code, factory_werks_name,
       SUM(total_inventory_quantity) as total_qty,
       SUM(available_inventory_quantity) as avail_qty,
       SUM(frozen_inventory_quantity) as frozen_qty,
       SUM(qc_inventory_quantity) as qc_qty,
       ROUND(SUM(available_inventory_quantity) * 100.0
             / NULLIF(SUM(total_inventory_quantity), 0), 2) as avail_pct
FROM dm.dm_wm_all_type_stock_t
GROUP BY factory_werks_code, factory_werks_name
ORDER BY total_qty DESC;
```

### 模式 G：缺货按销售区域汇总

```sql
SELECT sales_region, stat_month_ym,
       SUM(stockout_area) as total_out,
       SUM(stockout_area_ondue) as due_out
FROM dm.dm_dp_api_stockout_oudue
WHERE stat_year >= '2026'
GROUP BY sales_region, stat_month_ym
ORDER BY total_out DESC;
```

### 模式 H：产品出入库月度趋势

```sql
SELECT start_month, product_brand_name,
       SUM(in_stock_qty) as in_qty, SUM(out_stock_qty) as out_qty,
       SUM(stock_qty_month_end) as end_qty
FROM dm.dm_product_inout_stock_t
WHERE start_month >= '2026-01'
GROUP BY start_month, product_brand_name
ORDER BY start_month, in_qty DESC;
```

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

-- I3 按事业部的跌价结构（长龄段占比）
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

## 库存健康度检查项

| 指标 | 计算方式 | 说明 |
|---|---|---|
| 长库龄占比 | `SUM(wbzq_24_amt) / SUM(zsjkcje) * 100` | >10% 需关注滞销风险 |
| 可用库存占比 | `available / total_inventory * 100` | 过低说明冻结/质检过多 |
| 在途库存周转 | `deliver_amount / 月均消耗` | 在途过高积压资金 |
| 库存周转次数 | `turnover_times`（预计算） | <2次/年需关注 |

## Validation 验证层

每次生成 SQL 并执行后，必须做结果验证：

1. **行数检查**：返回行数是否在预期范围内？库存明细表全量上亿行，不带 calmonth 过滤直接查会超时
2. **量级检查**：库存数量是否在合理量级？月度库存金额通常亿级
3. **空值检查**：calmonth 可能为空的行需要排除；`___t` 描述字段可能为空
4. **口径交叉验证**：同一库存指标从账龄表和月统计表查询，偏差应在可合理解释范围内

## Unbook 机制

遇到以下情况时，必须对用户说明"我无法准确回答"，而非强行给出不可靠的结果：

- 问题涉及的表/字段在现有参考文档中没有记录
- 查询结果出现无法解释的异常值，且无法通过现有文档的"陷阱"解释
- 问题需要跨领域知识（如库存 + 采购联合分析），但相关 Skill 尚未建设
- 用户追问的库存口径细节超出了参考文档覆盖范围（如特殊库存类型、特定工厂的定制逻辑）

升级话术模板：
> "这个问题超出了当前库存 Skill 的覆盖范围。[具体原因]。建议先补充 [具体参考文档/领域] 的知识后再查。是否需要我先帮你记录这个缺口？"
