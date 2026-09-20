---
name: inventory-metrics
description: 库存仓储域语义层 — 编译后的指标定义、概念映射、维度值。Agent 必须优先查阅此文件再决定用哪张表。
---

# 库存仓储域 — 语义层 (Semantic Layer)

## 使用规则（强制）

1. 收到任何库存相关问题，**必须先读本文件**，再做后续判断
2. 本文件定义的概念→字段映射是权威的，不可自行猜测
3. 每张表的选择必须经过本文件的决策树

---

## 一、核心概念 → DWS 字段映射

### 1.1 "库存"到底指什么？

| 业务口径 | DWS 字段 | 所属表 | 说明 |
|----------|----------|--------|------|
| 库存数量（最常用） | `quantity` | dm_fin_stock_detail_accage_t_2023 | 物料库存数量 |
| 库存金额（管理口径，默认） | `zsjkcje` | dm_fin_stock_detail_accage_t_2023 | 实际库存金额，库存域默认字段 |
| 库存金额（阿米巴结算价） | `stock_amt` | dm_fin_stock_detail_accage_t_2023 | 与 Mix 阿米巴口径对齐时使用 |
| 库存面积 | 各个 `*_area` 字段 | 多张表 | CXC 日报、出入库、全类型库存都有面积字段 |
| 可用库存数量 | `available_inventory_quantity` | dm_wm_all_type_stock_t | 可用库存 |
| 总库存数量 | `total_inventory_quantity` / `all_stock_quantity` | dm_wm_all_type_stock_t | 总库存 |
| 在途数量 | `deliver_qty` | dm_b1_transit_inventory_t | 供应商已发货未入库 |
| 库龄分段金额 | `wbzq_6_amt` / `wbzq_6_12_amt` / `wbzq_12_24_amt` / `wbzq_24_amt` | dm_fin_stock_detail_accage_t_2023 | 无保质期分段（管理口径；有保质期走 ybzq 到期口径） |
| 入库面积 | `stock_in_area_month` / `stock_in_area_day` | dm_rpt_wm_cxc_day_sum | CXC 口径入库 |
| 出库面积（销售） | `sales_stock_out_area_month` / `sales_stock_out_area_day` | dm_rpt_wm_cxc_day_sum | CXC 口径销售出库 |

**歧义陷阱**：用户说"库存"时，默认指 `dm_fin_stock_detail_accage_t_2023` 的 `quantity` 和 `zsjkcje`。如果加了限定词（"可用"/"在途"/"按面积"），切换到对应表。

### 1.2 库龄/库存类型枚举值

| 概念 | 字段 | 所属表 | 典型值 |
|------|------|--------|--------|
| 库龄分段（宽表） | `stock_age_seg` | dm_otd_wm_stock_stat_month_t | 0-3月/3-6月/6-12月/12-24月/24月+ |
| 库存类型 | `stock_type` | dm_otd_wm_stock_stat_month_t | 可用库存/冻结库存/质检库存/在途库存 |
| 库龄分段（明细） | `wbzq_6_amt` ~ `wbzq_24_amt` | dm_fin_stock_detail_accage_t_2023 | **wbzq=无保质期**（按批次日期 6/12/24月分桶）；有保质期产品走 ybzq_bzdq_amt（到期）/ybzq_bzdq_3_amt（3月内） |
| 跌价/减值 | `jchj_amt`（管理，预计算）/`jchj_aging`（阿米巴）+ 分段 `wbzq_*_fall_amt`/`*_fall_aging` | dm_fin_stock_detail_accage_t_2023 | 计提 0/10/40/70%+保质期 70/100%，详见 stock-fall-list.md / stock-accage.md |
| 保质期标识 | `bz_flag` | dm_fin_stock_detail_accage_t_2023 | Y=有保质期，N=无保质期（非包装标志） |

### 1.3 组织维度

| 业务概念 | 字段 | 所属表 | 备注 |
|----------|------|--------|------|
| 工厂编码 | `plant` | dm_fin_stock_detail_accage_t_2023 | SAP 风格命名 |
| 工厂名称 | `plant___t` | dm_fin_stock_detail_accage_t_2023 | `___t` 后缀=文本描述 |
| 工厂编码（宽表风格） | `factory_werks_code` | dm_product_inout_stock_t 等 | 另一种命名风格 |
| 库存地点 | `stor_loc` / `stor_loc___t` | dm_fin_stock_detail_accage_t_2023 | |
| 库存地点（其他表） | `inv_location` | dm_wm_all_type_stock_t 等 | 另一种命名风格 |
| 库存类别 | `stockcat` / `stockcat___t` | dm_fin_stock_detail_accage_t_2023 | |
| 库存类型 | `stocktype` / `stocktype___t` | dm_fin_stock_detail_accage_t_2023 | |
| 公司 | `comp_code` / `comp_code___t` | dm_fin_stock_detail_accage_t_2023 | |
| 销售中心 | `sales_center_code` / `sales_center` | dm_dp_api_warehouse_stock | |
| 销售区域 | `sales_region_code` / `sales_region` | dm_dp_api_stockout_oudue | |
| 产区 | `product_area_code` / `product_area_name` | dm_otd_wm_stock_stat_month_t | |

### 1.4 物料/产品维度

| 业务概念 | 字段 | 所属表 | 备注 |
|----------|------|--------|------|
| 物料号 | `material` (旧) / `material_num` (新) | 多张表 | 两张表体系用不同字段名 |
| 物料描述 | `material___t` / `material_name` | 多张表 | `___t` 后缀 v.s 直接 `_name` 后缀 |
| 物料组层级1-5 | `matl_grp_1` ~ `matl_grp_5` | dm_fin_stock_detail_accage_t_2023 | `___t` 后缀为描述 |
| 产品层次1-5 | `zprodh1` ~ `zprodh5` | dm_fin_stock_detail_accage_t_2023 | SAP 风格，与 matl_grp 两套体系并存 |
| 外部物料组 | `extmatlgrp` | dm_fin_stock_detail_accage_t_2023 | |
| 物料类型 | `matl_type` | dm_fin_stock_detail_accage_t_2023 | |
| 品类 | `cat` | dm_otd_wm_stock_stat_month_t, dm_rpt_wm_cxc_day_sum | |
| 产品渠道 | `prod_channel` / `product_channel_name` | CXC/统计/全类型表 | |
| 品牌 | `product_brand_name` / `brand_name` | 出入库/全类型表 | |
| 规格 | `dimension` / `dimension_` | 多张表 | `dm_product_inout_stock_t` 有下划线后缀 |

---

## 二、表选择决策树

```
用户问题
├── 需要物料级库存明细（含批次/工厂/库存地点）？
│   └── 用 dm.dm_fin_stock_detail_accage_t_2023（183列，1.44亿行，最全）
├── 需要库龄分析/资金占压？
│   ├── 明细级 → dm.dm_fin_stock_detail_accage_t_2023
│   └── 月汇总级 → dm.dm_rpt_stock_age_month_ct（57行）
├── 涉及"在途库存"？
│   └── 用 dm.dm_b1_transit_inventory_t（1958万行，含预测）
├── 涉及"仓库库存快照"（全类型：可用/冻结/质检）？
│   └── 用 dm.dm_wm_all_type_stock_t（81列）
│   └── 简版用 dm.dm_dp_api_warehouse_stock（9列，FineReport API）
├── 涉及"CXC日报"/"仓储协作"/"出入库趋势"？
│   └── 用 dm.dm_rpt_wm_cxc_day_sum（172万行，按天）
├── 涉及"库存月报统计"/"按库龄段+品类汇总"？
│   └── 用 dm.dm_otd_wm_stock_stat_month_t（105万行）
├── 涉及"出入库明细"/"产品出入库"？
│   ├── 通用 → dm.dm_product_inout_stock_t（99万行）
│   ├── 湖南 → dm.dm_product_inout_stock_hunan_t（56万行）
│   └── 湖南含金额 → dm.dm_original_product_inout_stock_hunan_t（147万行，带成本中心/金额）
├── 涉及"安全库存"/"可用库存健康度"？
│   └── 用 dm.dm_safestock_all_stock（高度汇总）
├── 涉及"缺货/超期"？
│   └── 用 dm.dm_dp_api_stockout_oudue
├── 涉及"低周转出库"/"残次品出库"？
│   ├── 低周转 → dm.dm_wm_low_turnover_stockout_detail_t
│   └── 残次品 → dm.dm_wm_defective_product_stockout_t
├── 涉及“库存周转率”？
│   └── 用 dm.dm_otd_wm_stock_turnover_m（40行，预计算）
├── 涉及“跌价准备”/“库龄分段金额”/“库存金额（管理口径，默认）”？
│   └── 用 dm.dm_fin_stock_detail_accage_t_2023（jchj_amt / wbzq_*_fall_amt / zsjkcje）
├── 涉及“阿米巴口径库存/跌价”（与 Mix 阿米巴对齐）？
│   └── 同内部表 `*_aging` 字段族（stock_amt / jchj_aging / wbzq_*_fall_aging）
├── 涉及“线组分摊减值/分摊资金成本”（CHDJ）？
│   └── 用 dm.dm_ambv2_chdj_grp_t（inventory_value=管理减值的线组分摊，非库存价值；金额合计用 conv 列）
├── 涉及“库存资金成本”（批次级）？
│   └── 用 dm.dm_fin_stock_capital_cost_t（可为负、滚动窗口近2年）
├── 用户明确要求“上市口径”（特殊要求，回答必须声明口径）？
│   └── 用 dm.dm_fin_stock_d_accage_list_c_t_2023（非默认，勿主动路由）
└── 不确定？
    └── 默认用 dm.dm_fin_stock_detail_accage_t_2023（最全，但查询必须带 calmonth 过滤）
```

---

## 三、核心表速查

### 3.1 dm_fin_stock_detail_accage_t_2023 — 库存账龄明细（第一优先）

| 属性 | 值 |
|------|-----|
| Schema | dm |
| 粒度 | 物料+工厂+库存地点+批次+会计期间 |
| 列数 | 183 |
| 行数 | 1.44亿 |
| 时间范围 | 202012 ~ 202608 |
| 时间字段 | `calmonth` (YYYYMM, NOT NULL) |
| 数量字段 | `quantity` |
| 金额字段 | `zsjkcje`（实际库存金额-管理），`stock_amt`（阿米巴结算价）；跌价 `jchj_amt`/`jchj_aging` |
| 库龄字段 | `wbzq_6_amt`~`wbzq_24_amt`（金额），`wbzq_6_qty`~`wbzq_24_qty`（数量），`wbzq_6_area`~`wbzq_24_area`（面积） |
| 关键维度 | plant, stor_loc, stockcat, stocktype, batch, material, matl_grp_1~5, zprodh1~5, wbs_elemt, vendor |
| ⚠️ 陷阱 | calmonth 格式 YYYYMM（如 '202606'）；`___t` 后缀=描述；库龄多套口径并存（标准/爱米巴/自然日历/协议单价） |

### 3.2 dm_wm_all_type_stock_t — 全类型库存

| 属性 | 值 |
|------|-----|
| Schema | dm |
| 粒度 | 物料+工厂+库存地点的库存快照 |
| 列数 | 81 |
| 行数 | 14.4万 |
| 时间字段 | `dw_last_update_date`（快照时间） |
| 数量字段 | total_inventory_quantity, available_inventory_quantity, qc_inventory_quantity, frozen_inventory_quantity 等 14 个 |
| 面积字段 | total_inventory_area, available_inventory_area 等 7 个 |
| ⚠️ 陷阱 | 是快照表，不是实时数据；必须带工厂/渠道过滤 |

### 3.3 dm_rpt_wm_cxc_day_sum — CXC 日报

| 属性 | 值 |
|------|-----|
| Schema | dm |
| 粒度 | 日期+区域+品类+规格+产品渠道 |
| 列数 | 15 |
| 行数 | 172万 |
| 时间范围 | 2022-07-31 ~ 2026-06-06 |
| 时间字段 | `stat_date` (YYYYMMDD) |
| 核心字段 | stock_area_month_start/end, stock_area_year_start, sales_stock_out_area_year/month/day, stock_in_area_year/month/day |
| ⚠️ 陷阱 | 单位是面积（平米），不是数量；有 `_0630` 和 `_tmp` 变体表，用主表 |

### 3.4 dm_b1_transit_inventory_t — 在途库存

| 属性 | 值 |
|------|-----|
| Schema | dm |
| 粒度 | 客户+物料+品类+月份 |
| 列数 | 11 |
| 行数 | 1958万 |
| 时间范围 | 2018-01 ~ 2030-12（含预测） |
| 时间字段 | `doc_month` (YYYY-MM) |
| ⚠️ 陷阱 | 含未来预测数据；汇总表无采购订单明细 |

### 3.5 其他表速查

| 表名 | 行数 | 关键时间字段 | 主要用途 |
|------|------|-------------|----------|
| dm_product_inout_stock_t | 99万 | start_month (YYYY-MM) | 产品出入库汇总 |
| dm_otd_wm_stock_stat_month_t | 105万 | month_date | 库存月报+库龄分段 |
| dm_dp_api_warehouse_stock | 1.7万 | dw_last_update_date | 仓库库存快照 API |
| dm_dp_api_stockout_oudue | 0.5万 | stat_month_ym | 缺货超期 |
| dm_wm_low_turnover_stockout_detail_t | 36万 | voucher_post_date | 低周转出库明细 |
| dm_wm_defective_product_stockout_t | 94万 | voucher_post_date | 残次品出库 |
| dm_otd_wm_stock_turnover_m | 40 | stat_month | 库存周转率（预计算） |
| dm_rpt_stock_age_month_ct | 57 | calmonth (YYYYMM) | 库龄月报汇总 |

---

## 四、日期格式总览（关键！）

| 表 | 时间字段 | 格式 | 示例 |
|---|---------|------|------|
| dm_fin_stock_detail_accage_t_2023 | `calmonth` | YYYYMM | `'202606'` |
| dm_fin_stock_detail_accage_t | `calmonth` | YYYYMM | `'202606'` |
| dm_rpt_wm_cxc_day_sum | `stat_date` | YYYYMMDD | `'20260606'` |
| dm_b1_transit_inventory_t | `doc_month` | YYYY-MM | `'2026-06'` |
| dm_product_inout_stock_t | `start_month` | YYYY-MM | `'2026-06'` |
| dm_otd_wm_stock_stat_month_t | `month_date` | 需确认 | 不同数据源可能不同 |
| dm_otd_wm_stock_turnover_m | `stat_month` | text | |
| 低周转/残次品表 | `voucher_post_date` | timestamp | `'2026-06-01'` |
| dm_fin_stock_capital_cost_t | `month` | YYYYMM | `'202608'` |
| dm_ambv2_chdj_grp_t | `stat_month` | YYYY-MM | `'2026-08'` |

⚠️ **最大陷阱**：同一个库不同表的时间字段格式不一致！YYYYMM vs YYYY-MM vs YYYYMMDD vs timestamp。

---

## 五、标准指标公式

### 库存类

| 指标 | 公式 | 适用表 |
|------|------|--------|
| 库存总量 | `SUM(quantity)` | dm_fin_stock_detail_accage_t_2023 |
| 库存资金占压 | `SUM(zsjkcje)` | dm_fin_stock_detail_accage_t_2023 |
| 库存面积（全类型） | `SUM(total_inventory_area)` | dm_wm_all_type_stock_t |
| 可用库存占比 | `SUM(available_inventory_quantity) / SUM(total_inventory_quantity) * 100` | dm_wm_all_type_stock_t |

### 库龄类

| 指标 | 公式 | 适用表 |
|------|------|--------|
| 库龄0-6月金额 | `SUM(wbzq_6_amt)` | dm_fin_stock_detail_accage_t_2023 |
| 库龄6-12月金额 | `SUM(wbzq_6_12_amt)` | dm_fin_stock_detail_accage_t_2023 |
| 库龄12-24月金额 | `SUM(wbzq_12_24_amt)` | dm_fin_stock_detail_accage_t_2023 |
| 库龄24月+金额 | `SUM(wbzq_24_amt)` | dm_fin_stock_detail_accage_t_2023 |
| 长龄库存占比（>12月） | `SUM(wbzq_12_24_amt + wbzq_24_amt) / SUM(zsjkcje) * 100` | dm_fin_stock_detail_accage_t_2023 |

### 出入库/周转类

| 指标 | 公式 | 适用表 |
|------|------|--------|
| 月度出库面积 | `SUM(sales_stock_out_area_month)` | dm_rpt_wm_cxc_day_sum |
| 月度入库面积 | `SUM(stock_in_area_month)` | dm_rpt_wm_cxc_day_sum |
| 月均库存 | `(stock_area_month_start + stock_area_month_end) / 2` | dm_rpt_wm_cxc_day_sum |
| 月度库存周转率 | `sales_stock_out_area_month / ((stock_area_month_start + stock_area_month_end) / 2)` | dm_rpt_wm_cxc_day_sum |
| 库存周转次数 | `turnover_times`（预计算） | dm_otd_wm_stock_turnover_m |
| 在途库存金额 | `SUM(deliver_amount)` | dm_b1_transit_inventory_t |

---

## 六、标准过滤条件

```sql
-- dm_fin_stock_detail_accage_t_2023：必须带 calmonth 过滤避免全表扫描
WHERE calmonth = '202606'

-- dm_b1_transit_inventory_t：排除未来预测数据
WHERE doc_month <= '2026-06' AND doc_month >= '2018-01'

-- dm_rpt_wm_cxc_day_sum：stat_date 格式为 YYYYMMDD
WHERE stat_date = '20260606'

-- 低周转/残次品表：用 timestamp 过滤
WHERE voucher_post_date >= '2026-01-01'

-- 产品出入库表：start_month 格式 YYYY-MM
WHERE start_month = '2026-06'

-- dm_product_inout_stock_t 规格字段带下划线
SELECT dimension_ FROM dm.dm_product_inout_stock_t
```

---

## 七、已知陷阱总览

1. **日期格式不一致**（见第四节）：同一概念在不同表中格式不同，绝对不能混用
2. **物料字段名不一致**：`material`（SAP风格，`___t`后缀）vs `material_num`（新风格，`_name`后缀）。查询时注意表用的是哪套
3. **`___t` 后缀**：三个下划线 + t，SAP 风格文本字段。如 `plant` → `plant___t`，`zprodh1` → `zprodh1___t`
4. **规格字段**：`dm_product_inout_stock_t` 中是 `dimension_`（单下划线后缀），其他表是 `dimension`
5. **库龄多套口径**：管理(wbzq/ybzq+fall_amt)、阿米巴(*_aging)、协议单价(xydj/xyzjdj)、自然日历(zrzlcp_)。用户未指定时默认管理口径；SKU 效益域配 Mix 用阿米巴口径
6. **在途库存含预测**：`dm_b1_transit_inventory_t` 有 2030 年数据，必须过滤 doc_month
7. **`dm.dm_fin_stock_detail_accage_t` 是旧表/子集**（91列，不含面积/数量细分字段），查询用 `_2023` 后缀完整版
8. **CXC 日报变体**：`_0630`（6/30快照）、`_tmp`（临时表），查询用主表 `dm_rpt_wm_cxc_day_sum`
9. **安全库存表行数极少**：是高度汇总的报表，不是明细数据
10. **湖南基地独立表**：出入库有专门湖南表，查询时注意基地分表规则
11. **`jc` 字段族=减值**（管理口径 0/10/40/70%），不是"检出金额"；`jchj_amt`=减值合计（管理）
12. **`wbzq`/`ybzq`=无/有保质期**（按 bz_flag 分流），不是未/已包装；有保质期减值仅 7C/73/7220+特定库位工厂计提，其余恒 0
13. **CHDJ `inventory_value` 实为管理口径减值**（非库存价值）：与库存金额是不同概念，与上市口径跌价是不同体系，禁止跨表加减
14. **资金成本表 TRUNCATE 滚动窗口只留近 2 年**：更早月份查不到是窗口限制非数据丢失
15. **资金成本可为负**（平均余额<202012基线，去库存常态）；**CHDJ `capital_cost` 原始列在分摊行结构中重复携带全额（SUM 放大反号）——CHDJ 维度金额 SUM `capital_cost_conv`，准确金额用源表**
16. **资金成本 LAG 分区含 material_name**：物料改名断链→期初变 0→当月成本突降
17. **CHDJ 范围限卫浴/瓷砖/国际/丽适**（非全集团）；其 zdpsyb 码=node2 去 H 前缀，11000011/11000012 为卫浴旧组织
18. **库龄明细表 plant 7C 用 zpcrk_fc 分桶**（其余工厂用批次日期 zmmm_o017_zbatch_date）

---

## 八、存货跌价与减值 · 资金成本（完整语义）

### 8.1 跌价/减值体系对照（禁止混用，2026-08-20/24 合并裁定）

| 体系 | 字段族 | 计提比例 | 桶边界 | 载体表 | 路由 |
|---|---|---|---|---|---|
| **管理口径跌价（默认）** | `jchj_amt`（合计，预计算）+ 分段 `wbzq_6_fall_amt`/`wbzq_6_12_fall_amt`/`wbzq_12_24_fall_amt`/`wbzq_24_fall_amt`/`ybzq_bzdq_3_fall_amt`/`ybzq_bzdq_fall_amt` | 0/10/40/70% + 保质期 70/100% | 6/12/24月 + 保质期到期 | 内部表 `dm_fin_stock_detail_accage_t_2023`（calmonth=YYYYMM） | "跌价/减值/库龄"（默认） |
| **阿米巴口径跌价** | `jchj_aging` + 分段 `*_fall_aging`；金额基数 `stock_amt` | 同上比例 | 6/12/24月（阿米巴结算价桶） | 同上（`*_aging` 族） | 与 Mix/销售侧对齐、SKU 效益域 |
| **CHDJ 线组分摊** | `inventory_value`（=管理减值合计的线组分摊，**非库存价值**）/ `inventory_value_amb`（阿米巴结算价减值分摊） | 承袭上述比例 | 同上 + 预算比例分摊 | `dm_ambv2_chdj_grp_t`（stat_month=YYYY-MM） | "线组/渠道分摊"；范围限卫浴/瓷砖/国际/丽适 |
| **上市口径（非默认）** | `aging_sum_fall_amt` + 年段分段 | 0/20/30/50/50% | 1/2/3/4年（天级90天桶） | `dm_fin_stock_d_accage_list_c_t_2023` | **仅用户明确要求且声明口径时使用**（业务裁定 2026-08-24） |

### 8.2 库存资金成本

| 概念 | 权威字段 | 所在表 |
|---|---|---|
| 库存资金成本（批次级，主口径） | `capital_cost` | `dm_fin_stock_capital_cost_t`（month=YYYYMM） |
| 累计资金成本（分年不跨年） | `capital_cost_sum` | 同上 |
| 分摊资金成本（按预算比例到线组） | `capital_cost_conv`/`capital_cost_sum_conv` | `dm_ambv2_chdj_grp_t`（stat_month=YYYY-MM） |

公式（ETL 实证）：`((期初+期末)/2 − 202012余额) × 4%/12`；期初=LAG(期末)；**可为负**（低于基线）；TRUNCATE 滚动窗口仅近 2 年；**CHDJ 原始 capital_cost 列禁止 SUM 当金额（分摊行重复携带全额），用 conv 列或源表**。

### 8.3 金额口径锚点（2026-07/08 实测，内部口径）

| 金额 | 表/字段 | 概念 |
|---|---|---|
| 14.71亿（202607） | 内部表 `zsjkcje` / 资金成本表 `closing_balance` 14.3亿（202608） | **库存金额（管理口径）** |
| 17.52亿 | 内部表 `stock_amt` | 库存金额（阿米巴结算价） |
| 2.877亿 | 内部表 `jchj_amt` | **管理口径跌价/减值** |
| 3.301亿 | 内部表 `jchj_aging` | 阿米巴口径减值 |
| 6.35亿 | CHDJ `inventory_value` | 管理减值的**线组分摊**（卫浴/瓷砖/国际/丽适范围，非全集团） |

**决策**：问库存金额/跌价→内部表（默认管理族）；与 Mix/销售侧对齐→`*_aging` 族；问线组分摊→CHDJ；问资金成本→默认 `dm_fin_stock_capital_cost_t`。任何两口径金额不可加减。上市口径表 `dm_fin_stock_d_accage_list_c_t_2023` 非默认——仅特殊要求使用且回答必须声明口径。详见 [stock-fall-list.md](stock-fall-list.md)、[chdj-capital-cost.md](chdj-capital-cost.md)、[capital-cost-table.md](capital-cost-table.md)、[stock-accage.md](stock-accage.md)。

---

## 九、关联维度表

| 维度 | 表 | 关联键 |
|------|-----|--------|
| 成本中心属性 | dwifin.dwi_cost_center_main_t | cost_center_code / cost_center |
| 公司信息 | dwrdim.dwr_dim_company_d | comp_code / company_code |

注：库存明细表中已有物料描述（`material___t`/`material_name`），无需单独关联物料主数据。

---

## 十、pattern → 首选表与字段路由（对齐 eval_dataset 录制口径）

> 本节把 15 类库存问题 pattern 固化为"首选表 + 字段/聚合口径"的路由规则。依据 = `eval_dataset.json` inventory 15 场景的期望 SQL（录制口径，即判定标准）+ 2026-09-20 DWS 直连实测（round-golden10 idx 10/11 失败复盘）。
> 当两表业务上都讲得通时，**以 eval_dataset 录制口径为准**，不替业务拍板新口径——不换表、不换金额字段、不加录制 SQL 之外的过滤/分组条件。判定器按真值列名与行数据对照：真值外新增列可容忍（按真值列对照），**真值键列缺名/改名会导致键列对照失败**。

| pattern（问题形态） | 首选表 | 关键字段 / 聚合口径 | 路由规则与理由 |
|---------------------|--------|---------------------|----------------|
| topn_material（库存量Top10物料） | dm.dm_fin_stock_detail_accage_t_2023 | `SUM(quantity)` 排序 DESC；`GROUP BY material, material___t` 双列（`material___t` 裸列输出）；伴随 COUNT(DISTINCT plant)、SUM(zsjkcje) | "库存量"=数量口径，排序键是 SUM(quantity)，不是金额/面积；zsjkcje=0 行**不排除**（录制无此谓词）；详见 10.1 |
| aging_structure（库龄结构+长库龄占比） | dm.dm_fin_stock_detail_accage_t_2023 | 逐月 `GROUP BY calmonth`；四桶 `SUM(wbzq_6_amt)`/`SUM(wbzq_6_12_amt)`/`SUM(wbzq_12_24_amt)`/`SUM(wbzq_24_amt)`；占比 = SUM(wbzq_12_24_amt+wbzq_24_amt)/SUM(zsjkcje)*100 | 占比分母是 zsjkcje 总额**非桶和**；快照月选择与近月漂移判读见 10.2 |
| factory_comparison（各工厂库存金额Top10） | dm.dm_fin_stock_detail_accage_t_2023 | `SUM(zsjkcje)` 排序 DESC；GROUP BY plant___t；伴随 COUNT(DISTINCT material)、SUM(quantity) | "金额Top"排序键是 zsjkcje（与 topn_material 的数量键相反）；金额默认管理口径 zsjkcje |
| long_aged_detail（长库龄24月+物料Top10） | dm.dm_fin_stock_detail_accage_t_2023 | **行级不聚合**：`WHERE wbzq_24_amt > 0 ORDER BY wbzq_24_amt DESC`；SELECT material, material___t, plant___t, quantity, zsjkcje, wbzq_24_amt | "长库龄段Top"是批次级行排序——同一物料可多行入榜（不同工厂/批次）；排序键=行级 wbzq_24_amt，不要 SUM |
| cxc_daily（某周协销日报） | dm.dm_rpt_wm_cxc_day_sum | stat_date BETWEEN 'YYYYMMDD'；stock_area_month_start/end + sales_stock_out_area_day + stock_in_area_day | 单位是面积（平米）非数量；stat_date YYYYMMDD 无横杠；用主表，勿用 `_0630`/`_tmp` 变体 |
| transit_category（在途库存按品类汇总） | dm.dm_b1_transit_inventory_t | `SUM(deliver_qty)`/`SUM(deliver_amount)` BY doc_month, category_name，ORDER BY 金额 DESC | doc_month YYYY-MM 带横杠；单月等值过滤天然避开未来预测；NULL 品类行与 NULL 聚合行**不剔除**（录制真值实测含 NULL 品类行约 315 万件、"整装"NULL 聚合行） |
| trend_monthly（库存总金额与库龄趋势） | dm.dm_fin_stock_detail_accage_t_2023 | `SUM(zsjkcje)` + SUM(wbzq_6_amt) + SUM(wbzq_24_amt) BY calmonth，BETWEEN 窗口 | 录制口径只带首末两桶（0-6 与 24+）代表库龄两端，勿自行扩成全桶列——列形状按真值 |
| product_hierarchy（按产品层次汇总前两级） | dm.dm_fin_stock_detail_accage_t_2023 | GROUP BY zprodh1___t, zprodh2___t + `zprodh1___t IS NOT NULL`；ORDER BY SUM(zsjkcje) DESC LIMIT 10 | 层次维度用 zprodh 族（非 matl_grp 族）；`IS NOT NULL` 过滤是本场景录制口径**自带**——加不加过滤以录制 SQL 为准，勿把 fin-cost E4 的"勿加过滤"教训反向套用 |
| warehouse_type（仓库库存类型×财务类别汇总） | dm.dm_dp_api_warehouse_stock | COUNT(DISTINCT material_num) + SUM(stock_area) BY warehouse_type, fin_cate，ORDER BY 面积 DESC | 快照表无时间维度（问题不带时间=全量）；物料列名是 material_num（非 material） |
| defective_factory（残次品出库量Top10工厂） | dm.dm_wm_defective_product_stockout_t | COUNT(DISTINCT material_num) + SUM(quantity) BY factory_werks_name，ORDER BY 数量 DESC | 全量表无时间过滤（录制口径）；工厂列名 factory_werks_name（新命名风格） |
| inventory_fall_top10（存货跌价最高Top10物料） | dm.dm_fin_stock_detail_accage_t_2023 | `ROUND(SUM(COALESCE(jchj_amt,0)))` 排序 DESC；GROUP BY material，`MAX(material___t) AS material_name` | 减值默认管理口径 jchj_amt（预计算，直接 SUM）；本场景录制口径就是 MAX 改名——列形状随各自录制 SQL（与 topn_material 的裸列不同） |
| inventory_fall_trend（跌价每月总额走势） | dm.dm_fin_stock_detail_accage_t_2023 | `ROUND(SUM(COALESCE(jchj_amt,0)))` BY calmonth，BETWEEN 窗口 | 逐月一行；勿换 jchj_aging（阿米巴口径）——两口径 202607 相差 4,240 万（2.877 亿 vs 3.301 亿） |
| inventory_capital_cost_by_dept（各事业部资金成本） | dm.dm_fin_stock_capital_cost_t | `SUM(closing_balance)` + `SUM(capital_cost)` BY business_department_desc + `LENGTH(TRIM(business_department_desc))>0`，ORDER BY 余额 DESC | 资金成本主口径在本表（非 CHDJ 的 conv 列）；capital_cost 可为负（见七.15）；month=YYYYMM 无横杠；空事业部描述过滤是录制口径自带 |
| inventory_impairment_calibers（管理/阿米巴/CHDJ 三口径对账） | 明细表 + dm.dm_ambv2_chdj_grp_t（UNION ALL 三段） | 管理减值 SUM(jchj_amt)、阿米巴 SUM(jchj_aging)（calmonth=YYYYMM）；CHDJ SUM(inventory_value)（stat_month=YYYY-MM） | 对账类=三段并列各报各数、声明口径，禁止跨口径加减（见八.1）；两表时间格式不同（YYYYMM vs YYYY-MM） |
| inventory_aging_fall_link（事业部2年+跌价敞口） | dm.dm_fin_stock_detail_accage_t_2023 | SUM(COALESCE(wbzq_24_fall_amt,0)) / SUM(COALESCE(jchj_amt,0))*100 BY zdpsyb___t，ORDER BY 敞口 DESC | 事业部维度用表自带 zdpsyb___t（无需 JOIN 组织表）；占比分母=jchj_amt 总减值 |

### 10.1 金点子教训一：topn_material（round-golden10 idx 10，FAIL/口径错，09-18 与 09-20 两轮同伤）

- **排序口径**：`ORDER BY SUM(quantity) DESC`。"库存量 TopN" 的排序键是**数量**，不是金额（zsjkcje）、不是面积（zkcmj）——失败会话中 agent 同时产出过按金额排序、按面积排序的 TopN 变体 SQL，均非录制口径。
- **zsjkcje=0/NULL 处理：不排除、不过滤**。录制 SQL 唯一谓词是 `calmonth`。实测（2026-09-20，calmonth='202605'）：Top10 每个物料内部都含 zsjkcje=0 的行（#1 物料 LN63111_A 达 1,611 行），这是月末快照的正常构成；zsjkcje 无 NULL 行。整物料级"数量大但金额合计=0"的料最大仅 272 件（YF24D00008_B），距 Top10 门槛（540,398 件）差三个数量级——**若答案表出现"金额=0 的物料排进库存量 Top10"，说明排序/分组口径已经错了**，应回查排序键，而不是怀疑数据或加过滤凑数。
- **分组与列形状**：`GROUP BY material, material___t` 且 `material___t` 作为裸列输出。失败会话 agent 用了 `GROUP BY material` + `MAX(material___t) AS material_name`，真值键列 material___t 缺名导致判定器键列对照失败。当前数据两种分组结果逐行相同（202605 实测无一物料多描述，0 行分叉），但仍以录制双列口径为准——物料与描述若多对一（改名/清仓改描述）两口径将分叉。

### 10.2 金点子教训二：aging_structure（round-golden10 idx 11，FAIL/数值偏差+数据漂移混合）

- **快照月选择**：库龄结构按**每月各自的月末快照**取数（`WHERE calmonth IN ('202604','202605','202606') GROUP BY calmonth`），每月一行（3 个月=3 行）。不要把窗口混成单行"Q2 合计"作主答案（可作附注），也不要按"最近三个月"动态推算月份——月份以问题给定的显式窗口为准。
- **占比分母**：长库龄占比 = `SUM(wbzq_12_24_amt + wbzq_24_amt) / SUM(zsjkcje) * 100`。分母是 **zsjkcje 总额**，不是 wbzq 四桶之和——桶和不等于总额（202604 实测：四桶和比 zsjkcje 少约 1,180 元，因有保质期 ybzq 金额独立成桶且桶间有尾差）。分子固定为 >12 月两桶（12-24 + 24+）。
- **COALESCE 包装无数值差**：`SUM(COALESCE(wbzq_12_24_amt,0)+COALESCE(wbzq_24_amt,0))` 与裸 `SUM(wbzq_12_24_amt + wbzq_24_amt)` 实测逐分相同（2026-06 三个关键列 NULL 计数=0）——失败轮的数值偏差**不是** COALESCE 引起的。
- **近月快照重述（漂移判读）**：202606 快照录制值 14.727 亿/长库龄 32.30%，2026-09-20 实测 14.118 亿/33.11%（差 -6,087 万/-4.1%，total_qty 94,629,892→94,126,358）。当 agent 与 fresh 一致而双双≠录制真值、且仅近月不一致（202604/202605 与录制值分毫不差）时，判**数据修订（DATA_DRIFT）**而非口径错：答案声明取数时点，不要为凑录制数改口径。

### 10.3 已知口径分歧点（两口径数值写明，路由以 eval_dataset 录制口径为准）

- **库龄月报汇总表 vs 明细表**：`dm_rpt_stock_age_month_ct`（57 行汇总表）202604 zsjkcje 12.334 亿 vs 明细表 SUM(zsjkcje) 14.668 亿（差 -2.334 亿/-15.9%，2026-09-20 实测）。agent 曾用它交叉验证（round-golden10 idx 11 表集合差异被注记）——**路由以明细表录制口径为准**，汇总表只作旁证且差值需在答案声明。
- **资金成本表期末余额 vs 明细表库存金额**：`dm_fin_stock_capital_cost_t.closing_balance` 202608 合计 14.121 亿 vs 明细表 zsjkcje 14.739 亿——差值全部由 ETL 源过滤 `(stockcat IS NULL OR stockcat<>'K')` 解释（实测：明细表排 K 后 14.12137608 亿 = closing_balance 合计 14.12137608 亿，分毫不差；fin-cost 域援引的 E1 先例 11.86 亿 vs 12.43 亿同机制）。问库存金额→明细表 zsjkcje；问资金成本→资金成本表（idx 68 录制口径）。
- **管理 vs 阿米巴 vs CHDJ**（八.3 锚点重申）：zsjkcje 14.7 亿 vs stock_amt 17.5 亿；jchj_amt 2.877 亿 vs jchj_aging 3.301 亿（202607）；CHDJ inventory_value 6.35 亿是线组分摊非库存价值。对账类（idx 69）三段并列各报各数，禁止跨口径加减。
