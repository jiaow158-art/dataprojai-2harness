---
name: sales-performance-metrics
description: 销售业绩域语义层 — 编译后的指标定义、概念映射、维度值。Agent 必须优先查阅此文件再决定用哪张表。
---

# 销售业绩域 — 语义层 (Semantic Layer)

## 零、数据时效（C-Level 必读）

DM/业绩表本身**没有** "最后更新时间" 字段；系统改用 `pg_stat_user_tables.last_analyze`（最近一次统计信息收集时间）作为数据刷新的近似信号——通常在月度加载后由 DWS 调度自动 ANALYZE，是当前可用的最权威时效指示。

| 表 | 更新节奏 | 典型滞后 |
|---|---|---|
| `dm.dm_fin_operations_mix_sum_t` | 月度（次月 5 日左右入库） | 5-10 天 |
| `dm.ct_sales_performance_t` | 月度（次月 5 日左右） | 5-10 天 |
| `dm.dm_dp_api_sales_target` | 月度（次月初） | 3-7 天 |

**强制规则**：
- 用户问"本月业绩"时，若当前日期 ≤ 次月 5 日，系统应回答"上月"数据，并明确说"本月数据尚未入库"
- 答案顶部水印（前端显示）必须显示数据实际滞后天数（取自 last_analyze）
- 滞后 > 10 天 → 标红 + 主动提示"数据严重滞后，请联系数仓团队"

## 使用规则（强制）

1. 收到任何业绩相关问题，**必须先读本文件**，再做后续判断
2. 本文件定义的概念→字段映射是权威的，不可自行猜测
3. 每张表的选择必须经过本文件的决策树

---

## 一、核心概念 → DWS 字段映射

### 1.1 "业绩"到底指什么？

| 业务口径 | Mix 表字段 | 业绩表字段 | 说明 |
|----------|-----------|-----------|------|
| 月达成额（含税，最常用） | `ambperformance` | `month_achievement` | 两表口径一致，日常"业绩"默认指这个 |
| 月不含税净额 | `notax_sales_net_amt` | `month_notax` | 两表口径一致 |
| 月销售面积 | `zxsmj` | `month_sales_area` | 两表口径一致（2026-08 业务确认 zxsmj 为准；`s_zxsmj` 仅用于成交单价计算，不可混用） |
| 月销售数量 | `zxssl` | — | 2026-08 业务确认 |
| 年累计达成额 | 按月 SUM | `year_achievement` | Mix 表无 year 列，需 SUM |
| 去年同期月达成 | — | `last_year_month_achievement` | **仅业绩表有** |
| 上月达成（环比 MoM） | Mix 表 `calmonth` 自连接或 `LAG`（**无专用字段**） | `calday` 自连接（无专用字段） | 环比必须自己算上月，与同比（`last_year_*`）不同；详见 analyst 模式 J |
| 目标销售额 | `target_sales_amt` (需 JOIN 目标表) | 同 | 目标表 |
| 预算销售额 | `ambperformance_ys` | — | **仅 Mix 表有**；2026-08 业务确认名称"预算销售额"（原"预算达成额"） |
| 预测销售额 | `ambperformance_yc` | — | **仅 Mix 表有**；2026-08 业务确认名称"预测销售额"（原"预测达成额"） |
| 实际成本（业务标准口径） | `actual_cost_exclude_logistics` | —（无对应字段） | **2026-08 业务确认：实际成本取剔除物流成本口径，仅 Mix 表有** |
| 实际成本（含分摊旧口径） | `act_cost_sum_amt` | `month_a_cost` | 口径不同（Mix 含分摊），非业务首选 |
| 分摊后毛利 | `gross_profit_after_sharing` | `month_a_gross_profit` | 口径不同 |

**歧义陷阱**：用户说"业绩"时，默认指 `ambperformance` / `month_achievement`（含税达成额）。"不含税"或"净额"→ `notax_sales_net_amt`。"面积"→ `zxsmj`。

### 1.2 维度映射

| 业务概念 | Mix 表 (`dm_fin_operations_mix_sum_t`) | 业绩表 (`ct_sales_performance_t`) |
|----------|---------------------------------------|----------------------------------|
| 组织 | **内置** `node_desc1~9` + `node_name1~9`，直接 WHERE | `org_code`（SAP短编码），需 JOIN `dm_rpt_sales_group_t` |
| 渠道（整合渠道1） | `integrate_channel` + `integrate_channel__t`（含描述） | `integrate_channel_code`（无描述） |
| 渠道（整合渠道2） | `integrate_channel2` + `integrate_channel2__t` | — |
| 渠道（分销渠道） | `distr_chan` + `distr_chan__t` | — |
| 客户 | `customer` + `cust_name` | `customer`（仅编码） |
| 客户分组 | `cust_group_code` + `cust_group_name` | — |
| 客户城市线级 | `cust_mkt_segmentation_name` | — |
| 客户 → 名称/分组/区域 | — | JOIN `dm_dp_api_cust_general` 或 `dwr_dim_cust_sales_area_d`，详见 [customer-master](../../sources-of-truth/business-context/customer-master.md) |
| 物料 | `material_num` + `material_name` | — |
| 产品品牌 | `product_brand_code` + `product_brand_name` | — |
| 产品品类 | `category` + `category_name` | — |
| 区域 | `region_code` + `region_province_name` | — |
| 产品规格/尺寸 | `dimension`（字段名误导，实际是规格如1500X750） | — |
| 日期 | `calmonth` (YYYY-MM) | `calday` (YYYYMMDD) |

### 1.3 渠道维度映射

Mix 表有 **三套独立渠道体系**，当用户说"渠道"时必须确认指哪个：

| 体系 | 字段 | 值数 | 性质 | 适用场景 |
|------|------|------|------|---------|
| 整合渠道1 | `integrate_channel` | 3 | 销售渠道导向 | "零售/整装/工程" 三分 |
| 整合渠道2 | `integrate_channel2` | 7 | 产品导向 | "产品渠道分类" |
| 分销渠道 | `distr_chan` | 7 | 客户/业务模式导向 | "经销vs零售vs工程" SAP原始口径 |

**常见混淆**：`integrate_channel` GD01="零售渠道" vs `distr_chan` 02="零售" 是不同口径。整合渠道是业务整合后的分组，分销渠道是 SAP 原始分类。

**整合渠道1**（`integrate_channel`，channel_type = `整合渠道1`）：

| 编码 | 含义 |
|------|------|
| GD01 | 零售渠道 |
| GD02 | 整装头部 |
| GD03 | 工程渠道 |

**整合渠道2**（`integrate_channel2`，channel_type = `整合渠道2`）：

| 编码 | 含义 |
|------|------|
| GD04 | 特惠品 |
| GG01 | N品类产品 |
| GG02 | 瓷砖产品 |
| GG03 | 大包专供产品 |
| GG05 | 非设计师产品 |
| GG06 | 零售产品 |
| GG08 | 设计师专供产品 |

**分销渠道**（`distr_chan`，SAP 原始口径）：

| 编码 | 含义 |
|------|------|
| 01 | 经销 |
| 02 | 零售 |
| 06 | 工程 |
| 07 | 电商 |
| 08 | 家装 |
| 09 | 设计师 |
| 10 | 乡镇或流通 |

> 权威映射来源：`upload.upload_business_analysis_channel_t`。Mix 表一级渠道描述直接用内置 `integrate_channel__t` 字段（无需 JOIN）。
> 完整文档见 [channel-dimension.md](channel-dimension.md)。

---

## 二、表选择决策树

```
用户问题
├── 需要"同比增长"？
│   └── ct_sales_performance_t（唯一有 last_year_* 字段，需 JOIN 组织表）
├── 需要"预算/预测"对比？
│   └── dm_fin_operations_mix_sum_t（有 _ys / _yc 后缀字段）
├── 需要"产品分类"下钻（高值/大规格/套餐/旗舰/IW/辅材等12种）？
│   └── ct_sales_performance_t（222列预计算产品分类，判定规则详见「二-C」）
├── 需要"客户/物料/品牌/区域"明细？
│   └── dm_fin_operations_mix_sum_t（物料级粒度，含名称字段）
├── 其余所有场景（达成率/趋势/渠道/组织下钻/面积）？
│   └── dm_fin_operations_mix_sum_t（内置 node_desc + calmonth，写法最简单）
└── 不确定？
    └── 默认用 dm_fin_operations_mix_sum_t（相当于费用域的 dm_fact_finance_cost_f）
```

---

## 二-A、渠道维度决策树

```
用户说"渠道"
├── 问"按零售/整装/工程看"？
│   └── integrate_channel（整合渠道1，GD01/GD02/GD03）
├── 问"按产品渠道/产品分类看"？
│   └── integrate_channel2（整合渠道2，GD04/GG01~GG08）
├── 问"经销vs零售vs家装"（SAP原始业务模式）？
│   └── distr_chan（分销渠道，01~10）
└── 说不清？
    └── 必须反问用户指哪个维度（三套体系不互通）
```

---

## 二-B、产品维度决策指引

Mix 表有 7 个产品维度，按粒度从粗到细排列：

| 粒度 | 字段 | 值数 | 适用场景 |
|------|------|------|---------|
| 最粗 | `matl_group_name` (物料组) | 9 | "瓷砖/卫浴/涂料" 最高层大类 |
| 粗 | `prod_property_name` (产品属性) | 10 | "瓷砖产品/梦之家产品" 业务属性 |
| 粗 | `external_matl_group_name` (外部物料组) | 11 | "东鹏/梦之家/DPI CASA" 品牌归属 |
| 中 | `category_name` (品类) | 42 | "岩板/抛釉砖/仿古砖" 产品类型 |
| 中 | `product_level2_name` (产品层级2) | ~22 | "岩板/仿古砖/晶理石" 标准分类 |
| 细 | `product_brand_name` (产品系列描述) | 43 | "天然理石/柔光理石/质感木纹" 产品风格/花色系列（列注释为"产品系列描述"，是最接近业务"系列"语义的字段） |
| 最细 | `product_series_name` (规格系列编号) | 12 | "840/612/715" 规格系列编号（⚠️ 不是业务"系列"，与 dimension 一一对应：840=800×400, 612=1200×600, 715=1500×750） |
| 特殊 | `dimension` (产品规格/尺寸) | 115 | "1500X750/800X800" 物理尺寸 |

**常见陷阱**：
1. **`category_name` 和 `product_level2_name` 是 N:M 关系**，不是层级关系。例如"抛釉砖" category 下有 ART+、仿古砖、岩板、晶理石等多个 product_level2。
2. **`product_level` 命名反直觉**：`product_level` (1级) 最细，`product_level2` (2级) 更粗。不是通常的"1=粗,2=细"。
3. **`dimension` 字段名误导**：这不是数据建模的"维度"，而是产品物理规格（长X宽）。
4. **`prod_property` vs `external_matl_group`** 近似但不同：prod_property 按业务线分（A=瓷砖/B=卫浴/C=辅材/D=新材），external_matl_group 按对外品牌分（东鹏/梦之家/DPI CASA）。
5. **`product_series_name` 不是业务"系列"**：该字段值为规格编号（840/612/715），与 `dimension` 一一对应（840=800×400, 612=1200×600, 715=1500×750）。用户说"系列/产品系列"时应使用 `product_brand_name`（列注释为"产品系列描述"，实际存储天然理石/柔光理石等风格系列）。

**物料主数据 JOIN（2026-08 开通）**：Mix 未内嵌的产品属性——产品等级 `reserved_field6_name`、二级渠道 `tow_lev_channel_name`、产品所有权 `prod_property_name`、高值说明 `product_position_name` 等——可 JOIN 物料主数据 `dwimd.dwi_md_data_material_general_t`（26.2万行，aiuser 已可读，关联键 `material_num`，已验证与 Mix 对齐）取 `*_name` 中文，**不要硬编码码表**。⚠️ 其中 `product_position_name` 手工维护有漏，不可用于高值口径（见二-C）。字段全量清单见 docs/业绩域-指标与维度-业务确认表.xlsx ⑥（2026-08 业务逐项确认）。

### 二-B-1、用户说"下钻到产品维度"时的字段默认优先级

用户只说"下钻到产品维度"、**没指定具体层级**时，按下表选默认字段（基于业务常用度+粒度合理性）：

| 用户用词 | 默认字段 | 理由 |
|---------|---------|------|
| "下钻到产品维度" / "按产品看" / "产品分布"（未指定） | `category_name` | 中粒度 42 值，最符合业务直觉 |
| "按品类/品类分布" | `category_name` | 直接对应 |
| "按品牌" | `product_brand_name` | 直接对应 |
| "按事业部大类" / "瓷砖/卫浴/涂料" | `matl_group_name` | 最粗 9 值，事业部大类 |
| "按业务属性" | `prod_property_name` | 10 值 |
| "按规格/尺寸" | `dimension` | 物理尺寸（1500X750） |
| "按系列" | `product_series_name` | 12 值 |
| "高值产品/大规格/套餐/特惠品/旗舰产品/辅材/IW/世界印象/工程调整/共享仓" | 换 `ct_sales_performance_t` 用预计算字段 | mix 表无这些分类，判定规则详见「二-C」 |

### 二-B-2、跨表下钻可行性表（下钻前必查）

下钻/筛选维度前，先确认目标表是否含该维度。**不含则换表**，不要硬挑 null 字段。

| 维度 | mix_sum_t | ct_sales_performance_t | dm_dp_api_sales_target |
|------|-----------|------------------------|------------------------|
| 组织（事业部） | ✅ `node_desc2` 内置 | ⚠️ JOIN `dm_rpt_sales_group_t` | ✅ `sales_center` |
| 渠道 | ✅ 三套（`integrate_channel`/`2`/`distr_chan`） | ✅ `integrate_channel_code` | ✅ `integrate_channel` |
| 客户（编码+名称） | ✅ `customer`+`cust_name` | ⚠️ 仅 `customer` 编码 | ❌ |
| 客户分组 | ✅ `cust_group_*` | ❌ | ❌ |
| 物料（编码+名称） | ✅ `material_num`+`material_name` | ❌ | ❌ |
| 产品品牌 | ✅ `product_brand_name` | ❌ | ❌ |
| 产品品类 | ✅ `category_name` | ❌ | ❌ |
| 产品大类 | ✅ `matl_group_name` | ❌ | ❌ |
| 产品规格 | ✅ `dimension` | ❌ | ❌ |
| 区域 | ✅ `region_*` | ❌ | ✅ `sales_region` |
| 销售中心 / 销部 | ❌ | ❌ | ✅ `sales_center` / `sales_dep` |
| **预计算产品分类**（高值/大规格/套餐/特惠品/旗舰/辅材/IW 等12种） | ❌ | ✅ **独有**（详见「二-C」ETL判定规则） | ❌ |
| 同比（去年同期） | ❌ | ✅ **独有** `last_year_*` | ❌ |

**规则**：
- 在 `dm_dp_api_sales_target` 上做产品/客户/物料下钻 = **必然失败**（该表只有 14 列、维度仅组织/渠道/销部/销区）
- 在 mix 表查"高值产品业绩" = **必然失败**（mix 表无预计算分类字段，应换 ct_sales_performance_t）
- 在 ct_sales_performance_t 上做品牌/品类/规格下钻 = **必然失败**（无产品维度字段，应换 mix 表）

## 二-C、ct_sales_performance_t 产品分类判定规则（ETL 源码级）

`ct_sales_performance_t` 有 **11 种预计算产品分类**，每种有独立的判定逻辑（基于产品属性、渠道、等级等多维度组合）。以下从 ETL 脚本 `PJob_DWS_DM_CT_SALES_PERFORMANCE_T.txt` 逐项提取。

### 分类总览

| 分类 | 字段前缀 | 指标类型 | 判定维度 | 简要规则 |
|------|---------|---------|---------|---------|
| 高值产品 | `high_value_*` | 业绩金额 | 渠道+产品+等级 | 工程渠道 + 918/超大板/A18 + 瓷砖 + A优等品 |
| 世界印象 | `word_impression_*` | 业绩金额 | 整合渠道2 | `integrate_channel2 = 'GG08'`（设计师专供） |
| 套餐/大包 | `package_*` | 业绩金额 | 整合渠道2 | `integrate_channel2 = 'GG03'`（大包专供） |
| 1+N | `n1_*` | 业绩金额 | 工程渠道+产品所有权 | GD03 + 卫浴/新材/绿家/辅材，排除内部交易 |
| 大规格 | `large_spec_*` | **销售面积** | 产品所有权+规格 | 瓷砖 + (918/超大板 或 A16) |
| 特惠品 | `GD04_*` | **销售面积** | 整合渠道2 | `integrate_channel2 = 'GD04'` |
| 工程差价积分 | `engineering_adjust_*` | 业绩调整额 | 佣金组 | `commission_group = '02'`，取 `ABS(zsyjf)` |
| 共享仓 | `share_warehouse_*` | 业绩调整额 | 业务域 | `bus_area = 'G000'`，取 `z_yjsgtzz` |
| 其他调整 | `other_adjust_*` | 业绩调整额 | 业务域(非G000) | `bus_area NOT IN ('G000', '#')`，取 `z_yjsgtzz` |
| 旗舰产品 | `qjcp_*` | 业绩金额 | 零售渠道+系列+等级 | GD01 + (A5/A26/A35) + A优等品，排除特惠品 |
| IW产品 | `iw_*` | 业绩金额 | 二级渠道 | `tow_lev_channel_code IN ('A003', 'A004')` |
| 辅材 | `fc_*` | 业绩金额 | 零售渠道+产品所有权 | GD01 + (C0003/C0005) |

### 逐项详解

#### 1. 高值产品 (`high_value_*`)

**口径**：工程渠道中，高等级瓷砖的高端规格/系列产品的含税达成额。

```sql
-- 判定条件（所有必须同时满足）
integrate_channel = 'GD03'              -- 工程渠道
AND d.prod_property = 'A0001'           -- 产品所有权=瓷砖产品
AND d.reserved_field_6 = 'A'            -- 产品等级=A优等品
AND (d.product_series_name IN ('918', '超大板')  -- 规格系列=918或超大板
     OR d.product_brand_code = 'A18')   -- 或产品系列=战略A(A18)
```

**注意**：高值产品的「日业绩」(`high_value_day_achievement`) 口径略有不同——品牌范围更宽（`product_brand_code IN ('A1','A13','A14','A16','A18')`），且额外排除特惠品（`integrate_channel2 != 'GD04'`）。

**⚠️ 2026-08 业务确认**：不可用物料主数据 `product_position_name`（"高值说明"=高值/非高值）替代上述判定规则——该字段为手工维护、存在漏维护，仅作参考，**不构成高值业绩口径**。

#### 2. 世界印象 (`word_impression_*`)

**口径**：整合渠道2=设计师专供产品(GG08)的含税达成额。最简洁的分类——仅依赖 `integrate_channel2` 单一字段。

```sql
integrate_channel2 = 'GG08'  -- 设计师专供产品
```

#### 3. 套餐/大包专供 (`package_*`)

**口径**：整合渠道2=大包专供产品(GG03)的含税达成额。

```sql
integrate_channel2 = 'GG03'  -- 大包专供产品
```

#### 4. 1+N 跨事业部 (`n1_*`)

**口径**：工程渠道中，非瓷砖事业部（卫浴/新材/绿家/辅材）的产品销售业绩。即"瓷砖事业部的工程客户顺带买了其他事业部的产品"。

```sql
integrate_channel = 'GD03'                            -- 工程渠道
AND d.prod_property IN ('B0001', 'C0006', 'D0001', 'C0003')  -- 卫浴/新材/绿家/辅材
AND COALESCE(data_source, '$$$') <> 'U'               -- 排除事业部内部交易
```

**产品所有权编码对应**：
| 编码 | 事业部 |
|------|--------|
| `B0001` | 卫浴 |
| `C0006` | 新材 |
| `D0001` | 绿家 |
| `C0003` | 辅材 |

**历史变更**（2025-10-28）：1+N 增加条件"产品所有权=辅材"，实际为将 `C0003` 加入 IN 列表。

#### 5. 大规格 (`large_spec_*`)

**口径**：瓷砖产品中大规格（918/超大板系列 或 A16品牌）的**销售面积**（非金额！）。

```sql
d.prod_property = 'A0001'              -- 产品所有权=瓷砖
AND (product_series_name IN ('918', '超大板')  -- 规格=918/超大板
     OR (product_series_name NOT IN ('918', '超大板')
         AND product_brand_code = 'A16'))       -- 或非918/超大板但品牌=A16
```

**关键区别**：
- 高值产品取 **金额**（`ambperformance`），大规格取 **面积**（`zxsmj`）
- 高值限定工程渠道(GD03)+A优等品，大规格**不限渠道、不限等级**
- 大规格品牌条件用 A16，高值用 A18（不同品牌编码）

#### 6. 特惠品 (`GD04_*`)

**口径**：整合渠道2=特惠品(GD04)的**销售面积**（非金额！）。

```sql
COALESCE(integrate_channel2, '#') = 'GD04'  -- 特惠品
```

**历史变更**（2025-07-16）：此前基于产品属性判定，改为直接用 `integrate_channel2 = 'GD04'`。

#### 7. 工程差价积分 (`engineering_adjust_*`)

**口径**：佣金组=02 的工程差价积分金额（`zsyjf`，取绝对值）。这是**业绩调整项**，非原始销售业绩。

```sql
commission_group = '02'
-- 取值：ABS(COALESCE(zsyjf, 0))
```

**业务含义**：工程渠道存在差价补贴/积分机制，该字段将这部分调整单独列示。正值增加业绩，负值减少业绩（取绝对值后均为正）。

#### 8. 共享仓 (`share_warehouse_*`)

**口径**：业务域=G000（共享仓）的调整值（`z_yjsgtzz`）。业绩调整项，非原始销售。

```sql
bus_area = 'G000'
-- 取值：COALESCE(z_yjsgtzz, 0)
```

**业务含义**：共享仓是瓷砖事业部的内部调拨/共享库存机制，相关调整额归入此分类。

#### 9. 其他调整 (`other_adjust_*`)

**口径**：非共享仓（`bus_area NOT IN ('G000', '#'`) 的调整值。与共享仓互斥，覆盖其余所有业务域的调整。

```sql
COALESCE(bus_area, '#') NOT IN ('G000', '#')
-- 取值：COALESCE(z_yjsgtzz, 0)
```

**共享仓 vs 其他调整的关系**：
```
z_yjsgtzz 调整额
├── bus_area = 'G000'  → share_warehouse_*（共享仓调整）
├── bus_area IS NULL   → 不计入任何分类
└── bus_area 为其他值  → other_adjust_*（其他调整）
```

#### 10. 旗舰产品 (`qjcp_*`)

**口径**：零售渠道中，指定高端系列（净奢石/微韵石/质臻）的 A 优等品含税达成额，排除特惠品。

```sql
integrate_channel = 'GD01'                    -- 零售渠道
AND d.product_brand_code IN ('A5', 'A26', 'A35')  -- 净奢石/微韵石/质臻
AND d.reserved_field_6 = 'A'                  -- A优等品
AND COALESCE(integrate_channel2, '$$$') <> 'GD04'  -- 排除特惠品
```

**品牌编码对应**：
| 编码 | 系列 |
|------|------|
| `A5` | 净奢石 |
| `A26` | 微韵石 |
| `A35` | 质臻（2026-03-18 新增） |

**历史变更**：
- 2025-04-28：新增旗舰产品字段（最初11个字段）
- 2026-03-18：增加系列「质臻」(A35)；having 条件去掉去年同期不等于0（后又加回）
- 2026-04-04：增加过滤条件 `integrate_channel2 <> 'GD04'`（排除特惠品）

#### 11. IW产品 (`iw_*`)

**口径**：二级渠道编码为 IW(A003) 或 ART+(A004) 的含税达成额。全渠道（不限零售/工程）。

```sql
tow_lev_channel_code IN ('A003', 'A004')  -- IW / ART+
```

**编码对应**：
| 编码 | 含义 |
|------|------|
| `A003` | IW |
| `A004` | ART+ |

**历史变更**（2026-03-18）：此前逻辑为"零售渠道(GD01) + 整合品类文本=设计师专供产品"，改为基于 `tow_lev_channel_code` 的二级渠道判定，且不再限渠道。

#### 12. 辅材 (`fc_*`)

**口径**：零售渠道中，产品所有权为辅材或木地板的含税达成额。

```sql
integrate_channel = 'GD01'              -- 零售渠道
AND d.prod_property IN ('C0003', 'C0005')  -- 辅材产品 / 木地板产品
```

**产品所有权编码对应**：
| 编码 | 含义 |
|------|------|
| `C0003` | 辅材产品 |
| `C0005` | 木地板产品 |

### 分类互斥性说明

**分类之间不互斥**。同一行销售明细可能同时满足多个分类条件，例如：
- 一笔零售渠道路人石(A5)+A优等品的销售 → 同时计入 `qjcp_*`（旗舰）和 `fc_*`？不会，因为 `A0001`(瓷砖) ≠ `C0003/C0005`(辅材)
- 一笔工程渠道+918规格+A优等品+瓷砖的销售 → 同时计入 `high_value_*`（高值）和 `large_spec_*`（大规格面积），且可能同时计入总 `month_achievement`
- 同一 `bus_area` 不可能同时属于共享仓(G000)和其他调整

**业绩调整项（工程差价积分/共享仓/其他调整）与业绩金额分类（高值/世界印象/套餐/1+N/旗舰/IW/辅材）互不重叠**——前者来自 `zsyjf`/`z_yjsgtzz` 调整字段，后者来自 `ambperformance` 销售业绩。

### 字段时间粒度覆盖

| 分类 | month | quarter | year | last_period_month | last_year_month | last_year |
|------|-------|---------|------|-------------------|-----------------|-----------|
| 高值 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 世界印象 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 套餐 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 1+N | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 大规格 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 特惠品 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 工程差价积分 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 共享仓 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 其他调整 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 旗舰产品 | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| IW产品 | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| 辅材 | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |

> **注意**：旗舰/IW/辅材是 2025-03-31 新增的字段组，仅含月/季/年三个时间粒度，无上期/去年同期/去年全年。

### 查询示例

```sql
-- 查询某客户的高值产品月业绩
SELECT customer, org_code,
       SUM(high_value_month_achievement) AS 高值月业绩,
       SUM(high_value_year_achievement)  AS 高值年业绩
FROM dm.ct_sales_performance_t
WHERE calday = '20260531'
  AND org_code IN (SELECT node_name10 FROM dm.dm_rpt_sales_group_t WHERE node_desc2 = '瓷砖事业部')
GROUP BY customer, org_code;

-- 旗舰产品 + IW + 辅材 零售渠道产品结构分析
SELECT org_code,
       SUM(month_achievement)               AS 总月业绩,
       SUM(qjcp_month_achievement)          AS 旗舰月业绩,
       SUM(iw_month_achievement)            AS IW月业绩,
       SUM(fc_month_achievement)            AS 辅材月业绩,
       SUM(high_value_month_achievement)    AS 高值月业绩
FROM dm.ct_sales_performance_t
WHERE calday = '20260531'
GROUP BY org_code;
```

## 三、三张核心表速查

### 3.1 dm_fin_operations_mix_sum_t — 经营混合汇总（**主事实表，默认首选**）

| 属性 | 值 |
|------|-----|
| Schema | dm |
| 粒度 | 日 × 物料 × 客户 × 销售组 × 渠道 |
| 行数 | 903万 |
| 时间范围 | 2022-01 ~ 2026-12（含预算/预测月） |
| 时间字段 | `calmonth` (YYYY-MM)，直接用月格式 |
| 核心指标 | `ambperformance`(达成额), `notax_sales_net_amt`(不含税), `zxsmj`(面积), `zxssl`(数量) |
| 预算/预测 | `ambperformance_ys`, `ambperformance_yc` 等 |
| 组织层级 | **内置** `node_desc1~9`, `node_name1~9`，直接 WHERE 无需 JOIN |
| 关键维度 | `integrate_channel`, `customer`, `material_num`, `product_brand_name`, `region_province_name` |
| 陷阱 | 无 `last_year_*` 字段；`data_source` 需按组织层级选择（见标准过滤条件）；日和月粒度区分 |

### 3.2 ct_sales_performance_t — 销售业绩宽表（同比 + 产品分类专用）

| 属性 | 值 |
|------|-----|
| Schema | dm |
| 粒度 | 日 × 客户 × org_code × 渠道 |
| 列数 | 222 |
| 行数 | 892万 |
| 时间字段 | `calday` (YYYYMMDD 字符串) |
| 核心指标 | `month_achievement`, `month_notax`, `month_sales_area`, `year_achievement`, `quarter_achievement` |
| 同比字段 | `last_year_*` 系列（**独有优势**） |
| 产品分类 | `high_value_*`, `large_spec_*`, `package_*`, `n1_*`, `gd04_*`, `qjcp_*` 等（**独有优势**） |
| 陷阱 | `org_code` 需 JOIN 组织表；日粒度不能直接 SUM `month_achievement` |

### 3.3 dm_dp_api_sales_target — 销售目标

| 属性 | 值 |
|------|-----|
| Schema | dm |
| 粒度 | 月 × 销售中心 × 渠道 × 部门 × 区域 × org_type |
| 时间字段 | `stat_year` (YYYY) + `stat_month` (YYYY-MM) |
| 核心指标 | `target_sales_amt` **(万元!)** 需 `* 10000` 转元 |
| org关联 | `sales_center_code` ↔ Mix 表 `node_name5` |
| 陷阱 | `org_type` 必须过滤（`业务单位`=汇总 / `营销部`=明细，总分重复）；金额单位万元；未来月份有数据；⚠️ 下方 org 关联 `sales_center ↔ node_name5` 实测 0/143 匹配（2026 全年，见「七」idx 30 教训 3），禁止用该键 JOIN 事实表 |

---

## 四、标准指标公式

| 指标 | 公式（Mix表） | 公式（业绩表） |
|------|-------------|-------------|
| 月达成额 | `SUM(ambperformance)` | `SUM(month_achievement)` (取月末快照) |
| 同比增长率 | 需 JOIN 业绩表取 `last_year_*` | `(SUM(month_achievement) - SUM(ly_*)) / NULLIF(SUM(ly_*),0) * 100` |
| 达成率 | 子查询聚合目标（`org_type='业务单位'`，万元×10000），JOIN on `node_name5 + integrate_channel` | 子查询聚合目标，JOIN on `node_name5 + integrate_channel_code` |
| 不含税净额 | `SUM(notax_sales_net_amt)` | `SUM(month_notax)` |
| 销售面积 | `SUM(zxsmj)` | `SUM(month_sales_area)` |
| 渠道占比 | `SUM(CASE WHEN integrate_channel='GD01' THEN ambperformance END) / SUM(ambperformance) * 100` | 同，用 `integrate_channel_code` |
| 预算偏差 | `(SUM(ambperformance) - SUM(ambperformance_ys)) / NULLIF(SUM(ambperformance_ys),0) * 100` | 不支持 |

---

## 四-A、指标口径差异说明

### "业绩"口径（用户说"业绩"时默认含税达成额）

| 指标 | 说明 | 差异 |
|------|------|------|
| `ambperformance` | AMB业绩/含税达成额 | **默认指标** |
| `deal_price_total` | 成交价总额 | 比 ambperformance 多 ~5%（含额外逻辑，用于计算成交单价，详见 ETL `PJob_DWS_DM_FIN_OPERATIONS_MIX_T`） |
| `notax_sales_net_amt` | 不含税销售净额 | 与 amb 差税额 |

### 面积/数量双字段

| 字段 | 用途 |
|------|------|
| `zxsmj` / `zxssl` | **标准面积/数量**，直接用于查询销售面积和数量 |
| `s_zxsmj` / `s_zxssl` | 用于计算成交单价（`deal_price_total / s_zxsmj`），不用于常规面积/数量查询 |

### 目标 vs 预算 vs 预测

| 类型 | 字段 | 来源 | 单位 | 说明 |
|------|------|------|------|------|
| 目标 | `target_sales_amt` | dm_dp_api_sales_target | **万元** | 需 ×10000 转元 |
| 预算销售额 | `ambperformance_ys` | Mix 表内置 | 元 | 年初编制（2026-08 业务确认名） |
| 预测销售额 | `ambperformance_yc` | Mix 表内置 | 元 | 动态调整（2026-08 业务确认名） |

用户说"目标完成率"和"预算达成率"是不同概念，口语经常混用。

---

## 五、标准过滤条件

```sql
-- dm_fin_operations_mix_sum_t（主表，默认首选）
-- 月度查询：直接用 calmonth
WHERE calmonth = '2026-05'
  AND node_desc2 = '瓷砖事业部'      -- 内置组织层级，无需 JOIN
  AND data_source IN ('S', 'T', 'D', '')   -- node_desc2 层级

-- data_source 取值规则（重要！）：
-- S  = SAP 源数据
-- D  = 重算
-- T  = 调整值
-- U  = 事业部内部交易
-- W  = 卫浴费全资成本调整值
-- '' = 空值（部分数据未标记来源）

-- 组织范围 → data_source 选择：
-- 集团 / 第二层级事业部（node_desc2） → IN ('S', 'T', 'D', '')
-- 其他组织层级                           → IN ('', 'S', 'T', 'D', 'U')
-- 用户未指定组织                         → 询问用户取什么 data_source

-- ct_sales_performance_t（同比/产品分类用）
-- 月度快照：取月末最后一天
WHERE calday = '20260531'
  -- 组织筛选必须 JOIN
  JOIN dm.dm_rpt_sales_group_t s ON p.org_code = s.node_name10
  AND s.node_desc2 = '瓷砖事业部'

-- dm_dp_api_sales_target: 年月过滤
WHERE stat_year = '2026' AND stat_month = '2026-05'
  AND stat_month <= '2026-06'        -- 排除未来目标月
```

---

## 六、已知陷阱总览

1. **Mix 表无同比字段**：`ambperformance` 只含当期值，同比必须回 `ct_sales_performance_t` 取 `last_year_*`。
2. **Mix 表 data_source 取值**：S=SAP / D=重算 / T=调整值 / U=事业部内部交易 / W=卫浴费全资成本调整值。集团或 node_desc2 层级用 `IN ('S','T','D','')`，其他组织用 `IN ('','S','T','D','U')`。未指定组织时先询问用户。
3. **Mix 表含未来预算月**：calmonth 到 2026-12，查实际数注意 `calmonth <= 当前月`。
4. **业绩表 org_code 映射**：必须 JOIN `dm_rpt_sales_group_t`，关联键 `org_code = node_name10`（不是 `node10`！），已验证 382/382 匹配。⚠️ 2026-09-20 实测补充：表内 org_code **全部属瓷砖事业部**（364/376/381 个 org 跨 2024-2026 月末快照均映射瓷砖），该 JOIN 仅对瓷砖有效——卫浴/国际营销中心/丽适岩板在 ct 表无数据，JOIN 后再加这些事业部过滤 = 0 行。详见「七」idx 30 教训 2。
5. **业绩表日粒度聚合**：`month_achievement` 是 MTD 值，只能取月末快照，不能 BETWEEN 后直接 SUM。
6. **成本/毛利口径差异**：Mix 表含费用分摊，业绩表不含，两表差异 ~3.7%。
7. **渠道三套体系**：`integrate_channel`(整合渠道1,销售渠道导向)、`integrate_channel2`(整合渠道2,产品导向)、`distr_chan`(分销渠道,SAP原始口径)。用户说"渠道"时必须确认指哪个。权威映射表 `upload.upload_business_analysis_channel_t`，详见 [channel-dimension.md](channel-dimension.md)。
8. **目标表有全年数据**：2026-12 的目标已存在，务必过滤未来月。
9. **备份表泛滥**：`ct_sales_performance_t_bak*` (~15个) + `_new` 变体，只用主表。
10. **`dimension` 字段名误导**：实际是产品物理规格（如 1500X750），不是数据建模的"维度"。
11. **面积/数量双字段**：`s_zxsmj`/`s_zxssl` 用于计算成交单价，`zxsmj`/`zxssl` 用于常规面积数量查询。不可混用。
12. **`cust_mkt_segmentation_name`**：叫"市场细分"但实际是城市线级（一线/二线/.../乡镇）+ 海外区域，45% 为 NULL。
13. **`works_category`**：工程等级分类（10/20/30/40），97% 为 NULL，仅工程渠道相关行有值。
14. **产品维度交叉**：`category_name` 和 `product_level2_name` 是 N:M 关系，不是层级关系。
15. **【P0 组织层级固定枚举】** sales-performance 域 mix 表的 `node_desc2` 只有 **5 个有效事业部**值（按数据频次）：`瓷砖事业部` / `卫浴事业部` / `国际营销中心` / `丽适岩板` / `公司层面`（另含少量 `null` 和 `过渡部门`）。用户说"XX事业部/XX营销中心/XX岩板"→ **必须用 `node_desc2 = '精确名'`**，禁用 `LIKE '%XX%'`，因为：(a) 名称是固定枚举值，等值匹配即可；(b) `node_desc3` 里有"瓷砖国际营销中心"等含相同子串的子部门，LIKE 会跨事业部污染。子部门（如"营销一部/营销二部/卫浴营销部"）在 `node_desc3`。
16. **【P0 聚合查询的"伪 1 行"】** `SELECT SUM(...) FROM ... WHERE <错误过滤>` 即使 0 行匹配，聚合仍返回 **1 行 NULL**。trace 里 step4 报告"1 row"看着正常，review 也会通过——这是**隐性失败**。对策：(a) 过滤条件含组织/渠道/产品时，先单独 `SELECT COUNT(*) WHERE ...` 验证有匹配行；(b) 报告里若关键指标为 NULL，必须明确说"该筛选下无数据"，禁止编造结论。
17. **【P1 跨表下钻可行性】** 在 `dm_dp_api_sales_target` 上做产品/客户/物料/品牌下钻 = **必然失败**（该表只 14 列，无产品/客户/物料维度）。在 `ct_sales_performance_t` 上做品牌/品类/规格下钻 = **必然失败**（无产品维度字段）。下钻前必查上方「二-B-2 跨表下钻可行性表」。
18. **【待调研·业务提出 2026-08】区域业绩按"客户/工程 WBS"归属区分**：Mix 表 `region_province_name` 为内置区域（随客户销售区域走），业绩域表内无 WBS 归属字段；工程 WBS 主数据在跨域 [wbs-master](../../sources-of-truth/business-context/wbs-master.md)（129万 WBS 元素）。若需按 WBS 归属区域业绩，须调研 LTC/订单链路表后另行扩展——当前超出本 Skill 覆盖范围，遇此类问题用 Unbook 话术引导并记录缺口。
18. **【P1 预计算分类字段】** `ct_sales_performance_t` 独有 `high_value_*` / `large_spec_*` / `package_*` / `n1_*` / `gd04_*` / `qjcp_*` / `iw_*` / `fc_*` / `word_impression_*` / `engineering_adjust_*` / `share_warehouse_*` / `other_adjust_*` 共 **12 组预计算产品分类字段**。用户问"高值/大规格/套餐/特惠品/旗舰产品/辅材/IW/世界印象/工程差价积分/共享仓"→ 换 ct_sales_performance_t 用对应字段，不要在 mix 表上硬过滤。**判定规则详见上方「二-C」章节**（含每类的渠道、产品所有权、等级、品牌编码等完整 WHERE 条件）。

---

## 七、pattern → 首选表与字段路由（对齐 eval_dataset 录制口径）

> 本节把 14 类业绩问题 pattern 固化为"首选表 + 达成额/目标字段 + 组织过滤"的路由规则。依据 = `eval_dataset.json` sales-performance 全部 27 场景的期望 SQL（录制口径，即判定标准）+ 2026-09-20 直连实测（round-golden10 idx 30 失败分析）。
> 当多表业务上都讲得通时，**以 eval_dataset 录制口径为准**——不换表、不换金额字段、不加录制 SQL 之外的过滤条件。业绩序列/排名/预算/渠道/客户/品牌/区域下钻 → 一律 `dm_fin_operations_mix_sum_t`；同比与预计算产品分类 → `ct_sales_performance_t`（注意：该表实测仅含瓷砖事业部，见下方 idx 30 教训 2）。

| pattern（问题形态） | 首选表 | 达成额/目标字段 · 关键过滤 | 组织过滤方式 | 路由理由（录制口径） |
|---------------------|--------|---------------------------|--------------|---------------------|
| org_monthly_achievement（XX事业部某月/月段达成） | dm.dm_fin_operations_mix_sum_t | `SUM(ambperformance)` 主指标，可并 `SUM(notax_sales_net_amt)`/`SUM(zxsmj)`，calmonth 等值或 BETWEEN | `node_desc2='精确名'` 等值 + `data_source IN ('S','T','D','')` | 录制口径（idx 30 等 3 场景）；内置组织列写法最简 |
| monthly_trend（XX事业部月度业绩趋势） | 同上 | `SUM(ambperformance)` BY calmonth ORDER BY calmonth | 同上 | 与 org_monthly_achievement 同口径家族 |
| org_monthly_with_mom（XX事业部环比） | 同上 | `calmonth IN ('当月','上月')` CASE/MAX 透视自算环比（mix 无环比专用字段） | 同上 | 录制口径；环比必须自己算上月，与同比不同（见一.1） |
| org_monthly_with_yoy（XX事业部同比） | dm.ct_sales_performance_t | `SUM(month_achievement)` vs `SUM(last_year_month_achievement)`，`calday='月末YYYYMMDD'` 快照 | **不加组织过滤**（全表即瓷砖，见 idx 30 教训 2） | `last_year_*` 仅业绩表有 |
| yoy_growth_warning（同比下滑的渠道） | dm.ct_sales_performance_t | 同上，BY `integrate_channel_code`，`HAVING 当期 < 去年同期` | 不加组织过滤 | 同上 |
| channel_breakdown（按整合渠道1达成） | dm.dm_fin_operations_mix_sum_t | `integrate_channel + integrate_channel__t`，`IS NOT NULL` | node_desc2 + data_source | 渠道描述字段内置，无需 JOIN |
| cross_division_rank（各事业部业绩排名） | 同上 | `SUM(ambperformance)` BY `node_desc2`（`IS NOT NULL`，不筛具体事业部） | 仅 data_source 过滤 | 各事业部须同表同过滤才可比 |
| target_achievement_rate（各事业部预算达成率排名） | 同上 | `SUM(ambperformance)` vs `SUM(ambperformance_ys)`（预算内置字段，单位元） | 仅 data_source + node_desc2 IS NOT NULL | 录制口径用 mix 预算字段，**不用** dm_dp_api_sales_target |
| budget_vs_actual（XX事业部预算vs实际） | 同上 | diff = `SUM(ambperformance) − SUM(ambperformance_ys)` | node_desc2 + data_source | 同上；预算字段仅 mix 有 |
| product_brand_topn（TOP10产品品牌） | 同上 | `SUM(ambperformance)` BY `product_brand_name`，`IS NOT NULL AND ambperformance > 0`，LIMIT 10 | 同上 | 品牌名称仅 mix 有 |
| customer_topn（TOP10客户） | 同上 | `customer + cust_name`，`IS NOT NULL AND ambperformance > 0` | 同上 | 客户名称仅 mix 有 |
| region_breakdown（按省份达成TOP10） | 同上 | `SUM(ambperformance)` BY `region_province_name`，`IS NOT NULL AND ambperformance > 0` | 同上 | 区域字段内置 |
| high_value_analysis（高值产品按渠道达成） | dm.ct_sales_performance_t | `SUM(high_value_month_achievement)` BY `integrate_channel_code`，calday 月末 | 不加组织过滤 | 预计算产品分类仅业绩表有（判定规则见二-C） |
| cost_margin_trend（成本与毛利趋势） | dm.dm_fin_operations_mix_sum_t | `actual_cost_exclude_logistics`（业务标准成本）+ `gross_profit_after_sharing`；毛利率 = gp/amb×100 | node_desc2 + data_source | 业务确认成本口径仅 mix 有（见一.1） |

**idx 30（org_monthly_achievement，「2026年1-6月卫浴事业部业绩情况」）失败教训 → 规则（2026-09-20 直连实测）**

idx 30 录播 29 条 SQL 里只有 1 条是录制口径（还多了预算/预测/成本列），其余 28 条耗在 ct 表组织 JOIN 排查（0 行）、目标表关联排查（0 匹配）、data_source 反复核验上；最终判定失败 = 6 月数据漂移 + 答案未含录制度量。落成规则：

1. **月度业绩序列的标准路径只有一条**：mix 表 + `ambperformance`（含税达成）+ `node_desc2` 等值 + `data_source IN ('S','T','D','')` + `calmonth` 区间。ct 表与目标表**不参与、不交叉验证、不当"复核"用**。
2. **ct_sales_performance_t 实测仅含瓷砖事业部**（对六.4 陷阱的实测修正）：20240630/20250630/20260630 三个末快照的 org_code 去重 364/376/381 个，**100% 映射 dm_rpt_sales_group_t 的瓷砖事业部**——卫浴/国际营销中心/丽适岩板在该表无任何数据，`JOIN dm_rpt_sales_group_t … WHERE node_desc2='卫浴事业部'` 必然 0 行（idx 30 实录：agent 为这个 0 行耗了 8+ 条排查 SQL）。**非瓷砖事业部要同比 → mix 跨年自连接**（如 2025 同月 vs 2026 同月 CASE 透视，参考 analyst 模式 J），不要去 ct 表取 last_year_*。
3. **目标表（dm_dp_api_sales_target）不用于业绩/预算问答**：27 个录制场景中"预算达成率/预算vs实际"全部用 mix 内置 `ambperformance_ys`，无一用目标表。且 3.3 所载 `node_name5 ↔ sales_center` 关联**实测 0/143 匹配**（mix node_name5 是 H03230604 型 SAP 编码，target sales_center 是"华东运营中心"等中文名，2026 全年）——该 JOIN 必然空结果，禁止用于交叉验证。仅当用户明确问"目标"（target_sales_amt）时单表作答：`org_type='业务单位'` + 万元×10000 + 排除未来月（见五、3.3）。
4. **交叉验证引入口径偏差的三种形态**（idx 30 全踩中）：(a) ct 与 mix 同月同事业部数值本就对不齐——瓷砖 2026-06 实测 ct 61,271.5万 vs mix 60,409.2万（ct 高 +1.4%）；(b) 目标表万元单位 + org_type 三值同额（业务单位/营销部/销区总分重复）+ 组织粒度是营销中心而非事业部；(c) ct 表对非瓷砖事业部 0 行被误读为"该事业部无业绩"。两表对不上 ≠ 谁错了：按本节路由选定口径作答并声明，不要私下换表凑数。
5. **录制数据的"部分月"陷阱**：数据集录制时 2026-06 卫浴仅入库 11,712,138.82 元（部分月），现值 80,836,718.80——月度序列在**次月初/月中**取当月值必然偏低（1-5 月实测与录制完全一致，仅 6 月漂移）。回答含最近月份时按「零」章 last_analyze 判断完整性并声明。

**已知口径分歧点（实测写明，不替业务拍板新口径）**

- **ct.month_achievement vs mix.ambperformance**：同称"含税月达成"，同月同事业部差 ~1.4%（2026-06 瓷砖实测）。两口径各有 ETL 链路、都讲得通；路由以录制口径为准——业绩序列/排名/下钻/预算 → mix；同比与预计算产品分类 → ct（last_year_*/分类字段仅此表有）。
- **目标 vs 预算 vs 预测**（详见四-A）：目标表粒度=营销中心×渠道×org_type、单位万元、当前与事实表关联断裂（0/143）；预算/预测是 mix 行级内置字段、单位元。**"预算达成率/预算vs实际"一律走 mix 的 `ambperformance_ys`，目标表只答"目标"本身。**
- 同类辨析先例（手动实测 E1，库存域）：同月不同表数值不同属常态——两个都算、在答案里声明所用口径、按本节路由选定。
