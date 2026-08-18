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
| 资金占压金额 | `zsjkcje` | dm_fin_stock_detail_accage_t_2023 | 库存占用资金的核心字段 |
| 库存金额 | `stock_amt` | dm_fin_stock_detail_accage_t_2023 | 库存金额 |
| 库存面积 | 各个 `*_area` 字段 | 多张表 | CXC 日报、出入库、全类型库存都有面积字段 |
| 可用库存数量 | `available_inventory_quantity` | dm_wm_all_type_stock_t | 可用库存 |
| 总库存数量 | `total_inventory_quantity` / `all_stock_quantity` | dm_wm_all_type_stock_t | 总库存 |
| 在途数量 | `deliver_qty` | dm_b1_transit_inventory_t | 供应商已发货未入库 |
| 库龄分段金额 | `wbzq_6_amt` / `wbzq_6_12_amt` / `wbzq_12_24_amt` / `wbzq_24_amt` | dm_fin_stock_detail_accage_t_2023 | 未包装周期分段 |
| 入库面积 | `stock_in_area_month` / `stock_in_area_day` | dm_rpt_wm_cxc_day_sum | CXC 口径入库 |
| 出库面积（销售） | `sales_stock_out_area_month` / `sales_stock_out_area_day` | dm_rpt_wm_cxc_day_sum | CXC 口径销售出库 |

**歧义陷阱**：用户说"库存"时，默认指 `dm_fin_stock_detail_accage_t_2023` 的 `quantity` 和 `zsjkcje`。如果加了限定词（"可用"/"在途"/"按面积"），切换到对应表。

### 1.2 库龄/库存类型枚举值

| 概念 | 字段 | 所属表 | 典型值 |
|------|------|--------|--------|
| 库龄分段（宽表） | `stock_age_seg` | dm_otd_wm_stock_stat_month_t | 0-3月/3-6月/6-12月/12-24月/24月+ |
| 库存类型 | `stock_type` | dm_otd_wm_stock_stat_month_t | 可用库存/冻结库存/质检库存/在途库存 |
| 库龄分段（明细） | `wbzq_6_amt` ~ `wbzq_24_amt` | dm_fin_stock_detail_accage_t_2023 | wbzq=未包装周期, ybzq=已包装周期 |
| 包装标志 | `bz_flag` | dm_fin_stock_detail_accage_t_2023 | 区分已包装/未包装 |

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
├── 涉及“跌价准备”/“库龄分段金额”/“上市口径库存金额”？
│   └── 用 dm.dm_fin_stock_d_accage_list_c_t_2023
├── 涉及“库存资金成本”（上市口径、批次级、正值）？
│   └── 用 dm.dm_fin_stock_capital_cost_t
├── 涉及“阿米巴存货价值”/“分摊资金成本”（符号待确认）？
│   └── 用 dm.dm_ambv2_chdj_grp_t
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
| 时间范围 | 202012 ~ 202606 |
| 时间字段 | `calmonth` (YYYYMM, NOT NULL) |
| 数量字段 | `quantity` |
| 金额字段 | `zsjkcje`（资金占压），`stock_amt`（库存金额） |
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
| dm_fin_stock_d_accage_list_c_t_2023 | `calmonth` | YYYYMM | `'202608'` |
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
5. **库龄多套口径**：标准(wbzq/ybzq)、协议单价(xydj/xyzjdj)、爱米巴(amb_)、自然日历(zrzlcp_)。用户未指定口径时默认用标准
6. **在途库存含预测**：`dm_b1_transit_inventory_t` 有 2030 年数据，必须过滤 doc_month
7. **`dm.dm_fin_stock_detail_accage_t` 是旧表/子集**（91列，不含面积/数量细分字段），查询用 `_2023` 后缀完整版
8. **CXC 日报变体**：`_0630`（6/30快照）、`_tmp`（临时表），查询用主表 `dm_rpt_wm_cxc_day_sum`
9. **安全库存表行数极少**：是高度汇总的报表，不是明细数据
10. **湖南基地独立表**：出入库有专门湖南表，查询时注意基地分表规则

---

## 八、存货跌价与资金成本

| 概念 | 权威字段 | 所在表 |
|---|---|---|
| 跌价准备（预计算，含计提比例 0%/20%/30%/50%/50%） | `aging_sum_fall_amt` | `dm_fin_stock_d_accage_list_c_t_2023`（上市口径，calmonth=YYYYMM） |
| 库存金额（上市口径） | `zsjkcje` | 同上 |
| 库龄分段金额（天级可聚半年口径） | `aging_*_amt` | 同上 |
| 存货价值（阿米巴口径） | `inventory_value` | `dm_ambv2_chdj_grp_t`（stat_month=YYYY-MM） |
| 库存资金成本 | `capital_cost*` | 同上 / `dm_fin_stock_capital_cost_t` |

**口径决策**：问跌价/库龄/上市口径库存金额 → dm_fin_stock_d_accage_list_c_t_2023；问库存资金成本 → 默认 dm_fin_stock_capital_cost_t（上市口径、批次级、正值、公式已验证），阿米巴分摊口径才用 dm_ambv2_chdj_grp_t（其 capital_cost 为负值、符号语义待 ETL 确认）。两套库存金额（14.3亿 vs 6.35亿，2026-08）不可混用。详见 [stock-fall-list.md](stock-fall-list.md)、[chdj-capital-cost.md](chdj-capital-cost.md)、[capital-cost-table.md](capital-cost-table.md)。

---

## 九、关联维度表

| 维度 | 表 | 关联键 |
|------|-----|--------|
| 成本中心属性 | dwifin.dwi_cost_center_main_t | cost_center_code / cost_center |
| 公司信息 | dwrdim.dwr_dim_company_d | comp_code / company_code |

注：库存明细表中已有物料描述（`material___t`/`material_name`），无需单独关联物料主数据。
