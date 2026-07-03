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
| 月销售面积 | `s_zxsmj` | `month_sales_area` | 两表口径一致 |
| 年累计达成额 | 按月 SUM | `year_achievement` | Mix 表无 year 列，需 SUM |
| 去年同期月达成 | — | `last_year_month_achievement` | **仅业绩表有** |
| 目标销售额 | `target_sales_amt` (需 JOIN 目标表) | 同 | 目标表 |
| 预算达成额 | `ambperformance_ys` | — | **仅 Mix 表有** |
| 预测达成额 | `ambperformance_yc` | — | **仅 Mix 表有** |
| 实际成本 | `act_cost_sum_amt` | `month_a_cost` | 口径不同（Mix 含分摊） |
| 分摊后毛利 | `gross_profit_after_sharing` | `month_a_gross_profit` | 口径不同 |

**歧义陷阱**：用户说"业绩"时，默认指 `ambperformance` / `month_achievement`（含税达成额）。"不含税"或"净额"→ `notax_sales_net_amt`。"面积"→ `s_zxsmj`。

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
├── 需要"产品分类"下钻（高值/大规格/套餐等）？
│   └── ct_sales_performance_t（222列预计算产品前缀分类）
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
| "高值产品/大规格/套餐/特惠品/旗舰产品/辅材/IW" | 换 `ct_sales_performance_t` 用预计算字段 | mix 表无这些分类 |

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
| **预计算产品分类**（高值/大规格/套餐/特惠品/旗舰/辅材/IW 等） | ❌ | ✅ **独有**（直接 SUM 即得，无需 GROUP BY） | ❌ |
| 同比（去年同期） | ❌ | ✅ **独有** `last_year_*` | ❌ |

**规则**：
- 在 `dm_dp_api_sales_target` 上做产品/客户/物料下钻 = **必然失败**（该表只有 14 列、维度仅组织/渠道/销部/销区）
- 在 mix 表查"高值产品业绩" = **必然失败**（mix 表无预计算分类字段，应换 ct_sales_performance_t）
- 在 ct_sales_performance_t 上做品牌/品类/规格下钻 = **必然失败**（无产品维度字段，应换 mix 表）

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
| 陷阱 | `org_type` 必须过滤（`业务单位`=汇总 / `营销部`=明细，总分重复）；金额单位万元；未来月份有数据 |

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
| 预算 | `ambperformance_ys` | Mix 表内置 | 元 | 年初编制 |
| 预测 | `ambperformance_yc` | Mix 表内置 | 元 | 动态调整 |

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
4. **业绩表 org_code 映射**：必须 JOIN `dm_rpt_sales_group_t`，关联键 `org_code = node_name10`（不是 `node10`！），已验证 382/382 匹配。
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
18. **【P1 预计算分类字段】** `ct_sales_performance_t` 独有 `high_value_*` / `large_spec_*` / `package_*` / `n1_*` / `gd04_*` / `qjcp_*` / `iw_*` / `fc_*` / `word_impression_*` 等**预计算产品分类字段**（直接 `SUM(high_value_month_achievement)` 即得该分类业绩，**不需要 GROUP BY**）。用户问"高值/大规格/套餐/特惠品/旗舰产品/辅材/IW 产品"→ 换 ct_sales_performance_t 用对应字段，不要在 mix 表上硬过滤。
