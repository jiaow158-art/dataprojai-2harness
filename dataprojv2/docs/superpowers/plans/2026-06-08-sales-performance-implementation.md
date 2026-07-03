# Sales Performance Domain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the 4th domain "销售业绩" (sales-performance) with paired knowledge + analyst skills, following the existing fin-cost/inventory/ar pattern.

**Architecture:** Two core tables — `dm.ct_sales_performance_t` (222-col wide table, daily grain, pre-computed period metrics) + `dm.dm_dp_api_sales_target` (monthly targets). Org filtering via `dm.dm_rpt_sales_group_t` mapping.

**Tech Stack:** Markdown skill files, GaussDB (PostgreSQL-compatible), Python + psycopg2 for validation queries.

---

### Task 1: Create knowledge SKILL.md (router)

**Files:**
- Create: `skills/sales-performance-knowledge/SKILL.md`

- [ ] **Step 1: Write SKILL.md**

```markdown
---
name: sales-performance-knowledge
description: 销售业绩领域数据知识库。当用户询问销售达成率、目标完成、同比增长、销售收入、销售面积等业绩相关问题时自动激活。覆盖 DM 层的销售业绩数据模型。
---

# 销售业绩领域 — 数据知识路由

## 作用

本 Skill 是路由层。根据用户问题类型，引导到对应的参考文档获取准确的表结构、字段含义、过滤条件和查询模式。

## 可用的参考文档

### 语义层（必须首先查阅）

| 文档 | 说明 |
|---|---|
| **[metrics.md](references/metrics.md)** | **🔴 强制优先阅读**。概念→字段映射、表选择决策树、标准指标公式、所有已知陷阱 |

### 表级参考文档

| 文档 | 对应问题类型 |
|---|---|
| [sales-performance.md](references/sales-performance.md) | 销售达成率、月度趋势、同比增长、多维下钻（区域/渠道/客户/产品）、含税/不含税/销售面积 |
| [sales-target.md](references/sales-target.md) | 目标销售额、目标完成进度、目标vs实际偏差 |
| [data-lineage.md](references/data-lineage.md) | 数据血缘、表之间如何关联、从源表到报表的路径 |

## 跨域共享参考

组织架构等跨领域主数据，存放在 Sources of Truth 层，所有 domain skill 共用：

| 文档 | 说明 |
|---|---|
| **[组织架构](../../sources-of-truth/business-context/org-hierarchy.md)** | 10级销售组织树（node1~node10），node2 事业部枚举值，`org_code` 与 node 层级的映射关系 |
| **[物料主数据](../../sources-of-truth/business-context/material-master.md)** | 物料维度（品牌/品类/产品层级），与业绩表按物料关联 |
| **[公司&工厂](../../sources-of-truth/business-context/company-plant.md)** | 公司/工厂主数据 |

## 使用方式

1. **首先**加载 [metrics.md](references/metrics.md) 语义层，理解概念映射和表选择决策树
2. 根据决策树确定使用哪张表
3. 使用 `Read` 工具加载对应的表级参考文档
4. 根据文档中的表结构、过滤条件、陷阱提示，给出查询方案或直接生成 SQL

## 标准全局过滤条件

- 时间字段格式：
  - `ct_sales_performance_t`：`calday` (YYYYMMDD 字符串)，月查询取月末日期或按月 GROUP BY
  - `dm_dp_api_sales_target`：`stat_year` (YYYY) + `stat_month` (YYYY-MM 或 YYYYMM)
- 大表必须带时间范围过滤（`ct_sales_performance_t` 892万行）
- 备份表/临时表（`_bak`、`_tmp`、`_wjh_` 后缀）绝对不能使用
- `org_code` 是 SAP 短编码，组织筛选必须关联 `dm_rpt_sales_group_t`
```

- [ ] **Step 2: Verify file exists**

```bash
ls -la D:/dataproj/skills/sales-performance-knowledge/SKILL.md
```

---

### Task 2: Create metrics.md (semantic layer)

**Files:**
- Create: `skills/sales-performance-knowledge/references/metrics.md`

- [ ] **Step 1: Create references directory**

```bash
mkdir -p D:/dataproj/skills/sales-performance-knowledge/references
```

- [ ] **Step 2: Write metrics.md**

```markdown
---
name: sales-performance-metrics
description: 销售业绩域语义层 — 编译后的指标定义、概念映射、维度值。Agent 必须优先查阅此文件再决定用哪张表。
---

# 销售业绩域 — 语义层 (Semantic Layer)

## 使用规则（强制）

1. 收到任何业绩相关问题，**必须先读本文件**，再做后续判断
2. 本文件定义的概念→字段映射是权威的，不可自行猜测
3. 每张表的选择必须经过本文件的决策树

---

## 一、核心概念 → DWS 字段映射

### 1.1 "业绩"到底指什么？

| 业务口径 | DWS 字段 | 所属表 | 说明 |
|----------|----------|--------|------|
| 月达成额（含税，最常用） | `month_achievement` | ct_sales_performance_t | 含税销售收入，日常"业绩"默认指这个 |
| 月不含税净额 | `month_notax` | ct_sales_performance_t | 不含税销售收入 |
| 月销售面积 | `month_sales_area` | ct_sales_performance_t | 销售面积(㎡) |
| 年累计达成额 | `year_achievement` | ct_sales_performance_t | YTD 含税 |
| 季达成额 | `quarter_achievement` | ct_sales_performance_t | QTD 含税 |
| 去年同期月达成 | `last_year_month_achievement` | ct_sales_performance_t | 月同比用 |
| 去年同期年达成 | `last_year_achievement` | ct_sales_performance_t | 年同比用 |
| 目标销售额 | `target_sales_amt` | dm_dp_api_sales_target | 月目标 |
| N目标金额 | `n_target_amount` | dm_dp_api_sales_target | N类目标 |

**歧义陷阱**：用户说"业绩"时，默认指 `month_achievement`（含税达成额）。如果用户说"不含税"或"净额"，切换到 `month_notax`。"面积"指 `month_sales_area`。

### 1.2 维度映射

| 业务概念 | ct_sales_performance_t | dm_dp_api_sales_target | 备注 |
|----------|----------------------|------------------------|------|
| 组织 | `org_code` (SAP短编码) | `sales_center_code` | 组织筛选必须关联 `dm_rpt_sales_group_t` 转换 |
| 渠道 | `integrate_channel_code` (GD01/GD02/GD03) | `integrate_channel` | 3个渠道编码 |
| 客户 | `customer` | — | 10,876个，聚合查询不要按客户分组 |
| 日期 | `calday` (YYYYMMDD) | `stat_year` + `stat_month` | 格式不同！ |
| 销售部门 | — | `sales_dep_code` / `sales_dep` | 仅目标表有 |
| 销售区域 | — | `sales_region_code` / `sales_region` | 仅目标表有 |

### 1.3 渠道编码

| 编码 | 推测含义 | 说明 |
|------|---------|------|
| GD01 | 国内渠道1 | 待确认 |
| GD02 | 国内渠道2 | 待确认 |
| GD03 | 国内渠道3 | 待确认 |

---

## 二、表选择决策树

```
用户问题
├── 涉及"达成率"或"目标vs实际"？
│   └── ct_sales_performance_t + dm_dp_api_sales_target JOIN
├── 涉及"同比增长"？
│   └── ct_sales_performance_t（自带 last_year_* 字段）
├── 涉及"组织下钻"（按事业部/部门）？
│   └── ct_sales_performance_t JOIN dm_rpt_sales_group_t
├── 涉及"渠道/客户/产品"维度？
│   └── ct_sales_performance_t（单表即可）
├── 只需看目标？
│   └── dm_dp_api_sales_target（单表）
├── 需要销售面积？
│   └── ct_sales_performance_t（month_sales_area / year_sales_area）
└── 不确定？
    └── 默认用 ct_sales_performance_t（222列宽表，覆盖90%场景）
```

---

## 三、两张核心表速查

### 3.1 ct_sales_performance_t — 销售业绩主表

| 属性 | 值 |
|------|-----|
| Schema | dm |
| 粒度 | 日 × 客户 × org_code × 渠道 |
| 列数 | 222 |
| 行数 | 892万 |
| 时间范围 | 2023-12-31 ~ 至今 |
| 时间字段 | `calday` (YYYYMMDD 字符串) |
| 核心指标 | `month_achievement`, `month_notax`, `month_sales_area`, `year_achievement`, `quarter_achievement` |
| 同比字段 | `last_year_*_achievement` 系列 |
| 关键维度 | `org_code`, `customer`, `integrate_channel_code` |
| 产品分类 | 按前缀分：`high_value_*`(高值), `large_spec_*`(大规格), `package_*`(套餐), `n1_*`, `gd04_*`, `qjcp_*` 等 |
| 陷阱 | `org_code` 非 node_desc；日粒度聚合不能直接 SUM month_achievement |

### 3.2 dm_dp_api_sales_target — 销售目标

| 属性 | 值 |
|------|-----|
| Schema | dm |
| 粒度 | 月 × 销售中心 × 渠道 × 部门 × 区域 |
| 时间字段 | `stat_year` (YYYY) + `stat_month` |
| 核心指标 | `target_sales_amt` (目标额), `n_target_amount` (N目标) |
| 关键维度 | `sales_center_code`, `integrate_channel`, `sales_dep_code`, `sales_region_code` |
| 陷阱 | 未来月份有数据（全年目标预置），查询需 `stat_month <= 当前月` |

---

## 四、标准指标公式

| 指标 | 公式 | 适用表 |
|------|------|--------|
| 月达成率 | `SUM(month_achievement) / SUM(target_sales_amt) * 100` | 主表 + 目标表 |
| 同比增长率 | `(SUM(month_achievement) - SUM(last_year_month_achievement)) / NULLIF(SUM(last_year_month_achievement),0) * 100` | 主表 |
| YTD达成额 | `SUM(year_achievement)` | 主表 |
| 目标完成进度 | `SUM(year_achievement) / SUM(全年target) * 100` | 主表 + 目标表 |
| 渠道占比 | `SUM(CASE WHEN integrate_channel_code='GD01' THEN month_achievement END) / SUM(month_achievement) * 100` | 主表 |
| 不含税净额 | `SUM(month_notax)` | 主表 |

---

## 五、标准过滤条件

```sql
-- ct_sales_performance_t: 必须带时间范围
-- 月度查询：取月末最后一天
WHERE calday = '20260531'

-- 月度范围：用 BETWEEN
WHERE calday BETWEEN '20260101' AND '20260531'

-- dm_dp_api_sales_target: 年月过滤
WHERE stat_year = '2026' AND stat_month = '2026-05'

-- 排除未来目标
AND stat_month <= '2026-06'

-- 排除备份表
-- ct_sales_performance_t_bak* 绝对不能使用
```

---

## 六、已知陷阱总览

1. **`org_code` ≠ `node_desc`**：业绩表用 SAP 短编码(ZJ7/B21/P52等)，`dm_rpt_sales_group_t` 用 node 层级。组织筛选必须 JOIN 映射。
2. **日粒度聚合**：`month_achievement` 是 MTD 值，不能直接 SUM 多天的 month_achievement。应取 `MAX(calday)` 那天的值，或直接用 `year_achievement` 做累计。
3. **渠道编码无描述**：GD01/GD02/GD03 含义需通过业务确认，表内无 desc 字段。
4. **目标表有全年数据**：2026-12 的数据已存在，过滤时注意不取未来月。
5. **calday 字符串格式**：YYYYMMDD，不是 DATE 类型，比较时用字符串即可。
6. **客户粒度**：10,876个客户，聚合分析务必 GROUP BY 汇总，不要列明细。
7. **备份表泛滥**：`ct_sales_performance_t_bak*` 有15+个变体，只用 `ct_sales_performance_t`。
8. **产品分类分散**：高值/大规格/套餐等各占一组列(11组前缀×每个6~12个指标)，查具体品类时确认前缀名。
```

---

### Task 3: Create data-lineage.md

**Files:**
- Create: `skills/sales-performance-knowledge/references/data-lineage.md`

- [ ] **Step 1: Write data-lineage.md**

```markdown
# 销售业绩数据血缘

## 数据流向总览

```
SAP 源系统
  ├── SD (销售分销) — VBAK/VBAP (销售订单)
  ├── FI (财务会计) — BSEG (会计凭证行项目)
  └── CO (管理会计) — COSS/COEP (成本分摊/行项目)
    ↓
DWI 层 (数据整合 — 业绩域 DWI 表未在 DWS 物化)
    ↓
DM 层 (数据集市)
  ├── dm.ct_sales_performance_t — 销售业绩主表 (222列, 892万行)
  ├── dm.ct_sales_performance_daily_t — 销售业绩日报 (变体)
  ├── dm.ct_sales_performance_material_daily_t — 物料级业绩日报
  ├── dm.dm_dp_api_sales_target — 销售目标
  ├── dm.dm_fact_finance_salesnetamt_f — 销售净额 (含 node_desc 层级)
  ├── dm.dm_rpt_ct_department_sales_performance_t — 部门业绩报表
  ├── dm.dm_rpt_region_performance_daily_report_t — 区域业绩日报
  ├── dm.dm_sw_business_center_achievement_daily_t — 事业部达成日报
  └── dm.dm_target_achievement — 目标达成 (另一口径)
    ↓
FineReport 报表 / API 接口
```

## 核心表数据来源

### ct_sales_performance_t

```
dm.ct_sales_performance_t
  ← SAP SD: 销售订单/交货单按日汇总
  ← FI/CO: 收入确认数据
  ← 预计算: month/quarter/year + last_year/last_period + 产品分类
  ← 粒度: 日 × customer × org_code × integrate_channel_code
  ← 指标: achievement(含税) + notax(不含税) + sales_area(面积) + cost + gross_profit
  ← 产品维度: 按 11 个前缀分类(hv/large_spec/package/n1/gd04/eng/qjcp/iw/fc等)
```

### dm_dp_api_sales_target

```
dm.dm_dp_api_sales_target
  ← 手工/系统上传的目标分解数据
  ← 粒度: 月 × sales_center × channel × department × region
  ← 指标: target_sales_amt (目标额) + n_target_amount (N目标)
  ← 目标编制: 全年目标在年初一次性导入
```

## 表关联关系

### 最常用 JOIN 链路

```
ct_sales_performance_t (事实)
  ├── org_code → dm_rpt_sales_group_t.node* (组织映射, 关键!)
  ├── customer → (客户主数据, 未在 DWS 物化)
  └── integrate_channel_code → (渠道主数据, 无维度表)

ct_sales_performance_t + dm_dp_api_sales_target
  ├── p.org_code = t.sales_center_code
  └── p.integrate_channel_code = t.integrate_channel
```

### 跨域关联

| 分析场景 | 关联路径 |
|---|---|
| 业绩 → 费用 | org_code → node → dm_fact_finance_cost_f (通过 dm_rpt_sales_group_t) |
| 业绩 → 毛利 | 同表已有 a_cost/a_gross_profit 字段 |
| 业绩 → 库存 | 暂不直接关联 |
| 业绩 → 应收 | org_code → sales_group → dwr_ar_* 表 |
| 业绩 → 物料 | customer → material (间接, 不推荐) |

## 备份表警告

以下表绝对不能使用：
- `ct_sales_performance_t_bak*` (~15个变体)
- `ct_sales_performance_daily_t_bak*` (~12个变体)
- `ct_sales_performance_t_new` (开发变体)
- `ct_sales_performance_daily_t_new` (开发变体)

---

### Task 4: Create sales-performance.md (main table reference)

**Files:**
- Create: `skills/sales-performance-knowledge/references/sales-performance.md`

- [ ] **Step 1: Write sales-performance.md**

```markdown
# 销售业绩主表 — ct_sales_performance_t

## 表概览

| 属性 | 值 |
|------|-----|
| Schema | `dm` |
| 表名 | `ct_sales_performance_t` |
| 粒度 | 日 × 客户 × org_code × 渠道 |
| 列数 | 222 |
| 行数 | 8,920,871 |
| 时间范围 | 2023-12-31 ~ 至今 |
| 更新频率 | 每日 |
| 数据量级 | 月达成额亿级（瓷砖事业部月约3-5亿） |

## 维度列

| 列名 | 类型 | 说明 | 示例 |
|------|------|------|------|
| `calday` | varchar | 日期，YYYYMMDD | `20260531` |
| `customer` | varchar | 客户编码 | `0000318427` |
| `org_code` | varchar | 组织编码（SAP短编码） | `ZJ7`, `B21`, `P52` |
| `integrate_channel_code` | varchar | 渠道编码 | `GD01`, `GD02`, `GD03` |
| `data_source` | varchar | 数据来源标记 | — |
| `double_count` | integer | 重复计数标记 | — |

## 核心指标列（通用）

### 月达成（month_*）

| 列名 | 说明 | 同比列 |
|------|------|--------|
| `month_achievement` | 月达成额（含税） | `last_year_month_achievement` |
| `month_notax` | 月不含税净额 | `last_year_month_notax` |
| `month_sales_area` | 月销售面积(㎡) | `last_year_month_sales_area` |
| `month_a_cost` | 月实际成本 | `last_year_month_a_cost` |
| `month_a_gross_profit` | 月实际毛利 | `last_year_month_a_gross_profit` |
| `month_stand_a_cost` | 月标准成本 | `last_year_month_stand_a_cost` |
| `month_stand_a_gross_profit` | 月标准毛利 | `last_year_month_stand_a_gross_profit` |
| `month_amb_cost` | 月AMB成本 | `last_year_month_amb_cost` |
| `month_amb_gross_profit` | 月AMB毛利 | `last_year_month_amb_gross_profit` |

### 季达成（quarter_*）

| 列名 | 说明 |
|------|------|
| `quarter_achievement` | 季达成额 |
| `quarter_notax` | 季不含税净额 |
| `quarter_sales_area` | 季销售面积 |
| `last_year_quarter_achievement` | 去年同季达成额 |

### 年达成（year_*）

| 列名 | 说明 |
|------|------|
| `year_achievement` | YTD年达成额 |
| `year_notax` | YTD不含税净额 |
| `year_sales_area` | YTD销售面积 |
| `last_year_achievement` | 去年全年/同期达成额 |

### 产品分类列（按前缀分组）

每组包含：`{prefix}_month_achievement`, `{prefix}_quarter_achievement`, `{prefix}_year_achievement` 及其 `last_year_*` / `last_period_*` 变体。

| 前缀 | 推测产品类别 | 典型指标数 |
|------|-------------|-----------|
| `high_value_` | 高值产品 | ~18 |
| `large_spec_` | 大规格产品 | ~18 |
| `package_` | 套餐 | ~18 |
| `n1_` | N1产品 | ~18 |
| `gd04_` | GD04渠道 | ~12 (sales_area) |
| `engineering_adjust_` | 工程调整 | ~18 |
| `share_warehouse_` | 共享仓 | ~18 |
| `other_adjust_` | 其他调整 | ~18 |
| `qjcp_` | QJCP产品 | ~6 |
| `iw_` | IW产品 | ~9 |
| `fc_` | FC产品 | ~9 |

### 其他字段

| 列名 | 说明 |
|------|------|
| `day_achievement` | 日达成额 |
| `week_avg_day_achievement` | 周日均 |
| `last_month_day_achievement` | 上月日均 |
| `dw_last_update_date` | DWS最后更新日期 |

## 标准查询模式

### 模式 A：月度达成 + 同比

```sql
SELECT LEFT(calday, 6) as mon,
       SUM(month_achievement) as actual,
       SUM(last_year_month_achievement) as ly,
       (SUM(month_achievement) - SUM(last_year_month_achievement))
         / NULLIF(SUM(last_year_month_achievement), 0) * 100 as yoy_pct
FROM dm.ct_sales_performance_t
WHERE calday BETWEEN '20260101' AND '20260531'
GROUP BY LEFT(calday, 6)
ORDER BY mon;
```

### 模式 B：按渠道分解

```sql
SELECT integrate_channel_code,
       SUM(month_achievement) as actual,
       SUM(last_year_month_achievement) as ly
FROM dm.ct_sales_performance_t
WHERE calday = '20260531'
GROUP BY integrate_channel_code
ORDER BY actual DESC;
```

### 模式 C：按组织下钻（关联组织表）

```sql
SELECT s.node_desc2,
       SUM(p.month_achievement) as actual,
       SUM(p.last_year_month_achievement) as ly
FROM dm.ct_sales_performance_t p
JOIN dm.dm_rpt_sales_group_t s ON p.org_code = s.node10
WHERE p.calday = '20260531'
  AND s.node_desc2 = '瓷砖事业部'
GROUP BY s.node_desc2;
```

### 模式 D：达成率（关联目标表）

```sql
SELECT p.org_code,
       SUM(p.month_achievement) as actual,
       MAX(t.target_sales_amt) as target,
       SUM(p.month_achievement) / NULLIF(MAX(t.target_sales_amt), 0) * 100 as rate
FROM dm.ct_sales_performance_t p
LEFT JOIN dm.dm_dp_api_sales_target t
  ON p.org_code = t.sales_center_code
  AND p.integrate_channel_code = t.integrate_channel
  AND t.stat_year = '2026' AND t.stat_month = '2026-05'
WHERE p.calday = '20260531'
GROUP BY p.org_code
ORDER BY rate DESC;
```

### 模式 E：客户 Top N

```sql
SELECT customer,
       SUM(month_achievement) as total
FROM dm.ct_sales_performance_t
WHERE calday = '20260531'
GROUP BY customer
ORDER BY total DESC
LIMIT 20;
```

### 模式 F：高值产品达成

```sql
SELECT LEFT(calday, 6) as mon,
       SUM(high_value_month_achievement) as hv_actual,
       SUM(high_value_last_year_month_achievement) as hv_ly
FROM dm.ct_sales_performance_t
WHERE calday BETWEEN '20260101' AND '20260531'
GROUP BY LEFT(calday, 6)
ORDER BY mon;
```

## 已知陷阱

1. **日粒度聚合不能 SUM month_achievement**：`month_achievement` 是 MTD 值。取最新 `calday` 当天数据再聚合，或按 `calday` 按月取 `MAX`。
2. **org_code 不是 node_desc**：SAP 短编码(ZJ7/B21)，和 node_desc2 等中文名没有直接关系，必须 JOIN `dm_rpt_sales_group_t`。
3. **渠道编码无描述列**：GD01/GD02/GD03 含义需要业务确认，主表无 desc 字段。
4. **备份表众多**：`_bakYYYYMMDD` 后缀的约15张变体，只用 `ct_sales_performance_t`。
5. **customer 基数大**：10,876个客户，全量明细查询会很慢，聚合加 LIMIT。
6. **产品分类列默认行为**：各前缀字段可能为0或NULL，需确认业务是否启用该分类。
7. **calday 格式**：字符串 YYYYMMDD，不是 DATE 类型。

---

### Task 5: Create sales-target.md (target table reference)

**Files:**
- Create: `skills/sales-performance-knowledge/references/sales-target.md`

- [ ] **Step 1: Write sales-target.md**

```markdown
# 销售目标表 — dm_dp_api_sales_target

## 表概览

| 属性 | 值 |
|------|-----|
| Schema | `dm` |
| 表名 | `dm_dp_api_sales_target` |
| 粒度 | 月 × 销售中心 × 渠道 × 销售部门 × 销售区域 |
| 列数 | 14 |
| 用途 | 月度销售目标，用于达成率计算 |

## 列定义

| 列名 | 类型 | 说明 | 示例 |
|------|------|------|------|
| `stat_year` | varchar | 统计年份 | `2026` |
| `stat_month` | varchar | 统计月份 | `2026-05` |
| `stat_month_ym` | varchar | 月份（另一格式） | — |
| `sales_center_code` | varchar | 销售中心编码 | — |
| `sales_center` | varchar | 销售中心名称 | `战略工程中心` |
| `integrate_channel` | varchar | 渠道 | `GD01`, `GD03` |
| `sales_dep_code` | varchar | 销售部门编码 | — |
| `sales_dep` | varchar | 销售部门名称 | — |
| `sales_region_code` | varchar | 销售区域编码 | — |
| `sales_region` | varchar | 销售区域名称 | — |
| `target_sales_amt` | numeric | 目标销售额 | `5318.00` |
| `n_target_amount` | numeric | N目标金额 | — |
| `org_type` | varchar | 组织类型 | — |
| `dw_last_update_date` | varchar | 最后更新日期 | — |

## 标准查询模式

### 模式 A：单月目标查询

```sql
SELECT sales_center, integrate_channel,
       SUM(target_sales_amt) as target
FROM dm.dm_dp_api_sales_target
WHERE stat_year = '2026' AND stat_month = '2026-05'
GROUP BY sales_center, integrate_channel
ORDER BY target DESC;
```

### 模式 B：全年目标汇总

```sql
SELECT sales_center, SUM(target_sales_amt) as year_target
FROM dm.dm_dp_api_sales_target
WHERE stat_year = '2026'
  AND stat_month <= '2026-12'
GROUP BY sales_center
ORDER BY year_target DESC;
```

### 模式 C：按区域目标

```sql
SELECT sales_region, stat_month,
       SUM(target_sales_amt) as target
FROM dm.dm_dp_api_sales_target
WHERE stat_year = '2026'
GROUP BY sales_region, stat_month
ORDER BY stat_month, target DESC;
```

### 模式 D：达成率（关联业绩表）

```sql
SELECT t.sales_center,
       SUM(p.month_achievement) as actual,
       SUM(t.target_sales_amt) as target,
       SUM(p.month_achievement) / NULLIF(SUM(t.target_sales_amt), 0) * 100 as rate
FROM dm.dm_dp_api_sales_target t
LEFT JOIN dm.ct_sales_performance_t p
  ON t.sales_center_code = p.org_code
  AND t.integrate_channel = p.integrate_channel_code
  AND p.calday = '20260531'
WHERE t.stat_year = '2026' AND t.stat_month = '2026-05'
GROUP BY t.sales_center
ORDER BY rate DESC;
```

## 已知陷阱

1. **未来月份有数据**：全年目标在年初导入，`stat_month` = `2026-12` 的数据已存在。查询当月达成率时务必 `stat_month <= '当前月'`。
2. **`stat_month` 格式**：需要实际验证，可能是 `YYYY-MM` 或 `YYYYMM`。
3. **`sales_center_code` 与业绩表的 `org_code` 关联**：两个字段可能不是完全对应的编码体系，JOIN 后可能有空值，使用 LEFT JOIN 并检查匹配率。
4. **`n_target_amount`**：大部分行的 n_target_amount 为 0，可能尚未启用。
5. **无 `dw_last_update_date` 类型**：字段是 varchar 而非 timestamp。

---

### Task 6: Create analyst SKILL.md (6-step workflow)

**Files:**
- Create: `skills/sales-performance-analyst/SKILL.md`

- [ ] **Step 1: Write SKILL.md**

```markdown
---
name: sales-performance-analyst
description: 销售业绩分析工作流。当用户询问达成率、目标完成、同比增长、销售趋势、多维下钻等需要执行分析的场景时自动激活。依赖 sales-performance-knowledge 提供数据模型知识。
---

# 销售业绩分析 — 工作流程

## 角色

你是一位资深销售运营分析师，熟悉陶瓷制造行业的销售管理体系和公司数仓 DWS (GaussDB) 体系。
在回答任何业绩相关问题前，先按以下流程执行，不要跳过步骤。

## 分析流程（6 步法）

### 第 1 步：澄清需求

销售业绩问题天然有口径差异。在动手查数据之前，确认以下信息：

| 要澄清的 | 示例 |
|---|---|
| 时间范围 | "上个月"是指自然月？需要具体到年月 |
| 口径定义 | "业绩"指含税达成额还是不含税净额？含不含工程调整？ |
| 组织范围 | 哪个事业部/销售中心/区域？ |
| 对比基准 | 同比？环比？目标比？ |
| 单位 | 金额单位（元/万元）？面积单位（㎡）？ |

**关键问题清单**：
- "业绩口径：含税(`month_achievement`)还是不含税(`month_notax`)？"
- "是否包含工程调整？"
- "按什么维度看：组织/渠道/客户/产品分类？"
- "输出格式：要明细还是汇总？"

### 第 2 步：定位数据源

**必须先读语义层** `sales-performance-knowledge/references/metrics.md`，按决策树选择表。

| 问题类型 | 首选用表 | 决策依据 |
|---|---|---|
| 达成率/目标vs实际 | `ct_sales_performance_t` + `dm_dp_api_sales_target` | 两张表 JOIN |
| 同比增长 | `ct_sales_performance_t` | 自带 `last_year_*` 字段 |
| 月度趋势 | `ct_sales_performance_t` | 222列宽表覆盖全场景 |
| 按组织下钻 | `ct_sales_performance_t` JOIN `dm_rpt_sales_group_t` | org_code → node_desc 映射 |
| 按渠道/客户/产品 | `ct_sales_performance_t` | 单表即可 |
| 只看目标 | `dm_dp_api_sales_target` | 单表 |

### 第 3 步：应用标准过滤

```sql
-- ct_sales_performance_t: 时间范围（必须！892万行）
-- 月度快照：取月末最后一天
WHERE calday = '20260531'

-- 月度范围：
WHERE calday BETWEEN '20260101' AND '20260531'

-- 组织筛选（org_code → node_desc 映射）
JOIN dm.dm_rpt_sales_group_t s ON p.org_code = s.node10
WHERE s.node_desc2 = '瓷砖事业部'

-- dm_dp_api_sales_target: 年月过滤 + 排除未来
WHERE stat_year = '2026' AND stat_month = '2026-05'

-- 排除备份表
-- 只用 ct_sales_performance_t，不用 _bak / _new 变体
```

### 第 4 步：自检审查

生成 SQL 后，逐条检查：

- [ ] 时间字段格式：`calday` YYYYMMDD 字符串？`stat_month` 格式正确？
- [ ] 日粒度聚合是否正确？（month_achievement 是 MTD，不能直接 SUM 多天）
- [ ] `org_code` JOIN `dm_rpt_sales_group_t` 的关联键对吗？(likely `node10`)
- [ ] 是否有全表扫描风险？（892万行必须带 calday 范围）
- [ ] 达成率分母为0时是否做了 NULLIF？

### 第 5 步：对抗性审查（Adversarial Review）

**这是最关键的一步。此步骤的缺失会导致 ~6% 准确率损失。**

在输出结果之前，扮演"质疑者"角色，逐条挑战自己刚才生成的 SQL 和结论：

**A. 数据源选择是否正确？**
- [ ] 有没有其他表也能回答这个问题？如果有，两张表的结果应该一致吗？
- [ ] 选用的表是主表还是备份表？（备份表名含 `_bak`、`_new` 后缀，绝对不能用）
- [ ] 目标表关联时，是否确认了 `sales_center_code` 与 `org_code` 的匹配率？

**B. 业务概念映射是否唯一？**
- [ ] "业绩"在当前语境下到底指什么？（month_achievement / month_notax / year_achievement？）
- [ ] "组织"是用 node_desc2/3 还是 sales_center？映射路径正确吗？
- [ ] 渠道编码 GD01/GD02/GD03 在当前问题中是否需要解释含义？

**C. 过滤条件是否完整？**
- [ ] 是否遗漏了时间范围过滤？
- [ ] 目标表是否排除了未来月份？
- [ ] 组织映射 JOIN 是否会导致数据膨胀或丢失？

**D. 结果合理性？**
- [ ] 执行前预估：这个查询大概会返回多少行？金额量级应该是多少？
- [ ] 如果结果是 0 行或异常大/小，最可能的原因是什么？
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
- Skill 版本：sales-performance-analyst / sales-performance-knowledge
- 参考文档：{实际加载的 reference 文件名}
- 已知限制：{本次查询的口径局限}
- ⚠️ 验证状态：已通过对抗性审查 / 未通过（需人工复核）
```

## 常用分析模式

### 模式 A：月度达成趋势 + 同比

```sql
SELECT LEFT(calday, 6) as mon,
       SUM(month_achievement) as actual,
       SUM(last_year_month_achievement) as ly,
       (SUM(month_achievement) - SUM(last_year_month_achievement))
         / NULLIF(SUM(last_year_month_achievement), 0) * 100 as yoy_pct
FROM dm.ct_sales_performance_t
WHERE calday IN ('20260131', '20260228', '20260331', '20260430', '20260531')
GROUP BY LEFT(calday, 6)
ORDER BY mon;
```

### 模式 B：按渠道达成对比

```sql
SELECT integrate_channel_code,
       SUM(month_achievement) as actual,
       SUM(last_year_month_achievement) as ly
FROM dm.ct_sales_performance_t
WHERE calday = '20260531'
GROUP BY integrate_channel_code
ORDER BY actual DESC;
```

### 模式 C：事业部达成率

```sql
SELECT s.node_desc2,
       SUM(p.month_achievement) as actual,
       SUM(p.last_year_month_achievement) as ly,
       (SUM(p.month_achievement) - SUM(p.last_year_month_achievement))
         / NULLIF(SUM(p.last_year_month_achievement), 0) * 100 as yoy_pct
FROM dm.ct_sales_performance_t p
JOIN dm.dm_rpt_sales_group_t s ON p.org_code = s.node10
WHERE p.calday = '20260531'
GROUP BY s.node_desc2
ORDER BY actual DESC;
```

### 模式 D：客户 Top 10

```sql
SELECT customer,
       SUM(month_achievement) as total
FROM dm.ct_sales_performance_t
WHERE calday = '20260531'
GROUP BY customer
ORDER BY total DESC
LIMIT 10;
```

### 模式 E：达成率（关联目标）

```sql
SELECT t.sales_center,
       SUM(p.month_achievement) as actual,
       MAX(t.target_sales_amt) as target,
       SUM(p.month_achievement) / NULLIF(MAX(t.target_sales_amt), 0) * 100 as rate
FROM dm.ct_sales_performance_t p
LEFT JOIN dm.dm_dp_api_sales_target t
  ON p.org_code = t.sales_center_code
  AND p.integrate_channel_code = t.integrate_channel
  AND t.stat_year = '2026' AND t.stat_month = '2026-05'
WHERE p.calday = '20260531'
GROUP BY t.sales_center
ORDER BY rate DESC;
```

### 模式 F：产品分类达成（高值产品）

```sql
SELECT LEFT(calday, 6) as mon,
       SUM(high_value_month_achievement) as hv_actual,
       SUM(high_value_last_year_month_achievement) as hv_ly
FROM dm.ct_sales_performance_t
WHERE calday IN ('20260131', '20260228', '20260331', '20260430', '20260531')
GROUP BY LEFT(calday, 6)
ORDER BY mon;
```

## 数据质量检查项

生成结果前检查：
1. 结果金额数量级是否合理（瓷砖事业部月业绩通常3-5亿级）
2. 是否有明显的空值或零值异常
3. 达成率>100%是否合理（可能是目标分解有滞后）
4. 同比波动>50%是否可以用春节/政策解释

## Validation 验证层

每次生成 SQL 并执行后，必须做结果验证：

1. **行数检查**：返回行数是否在预期范围内？如果为 0，检查 org_code JOIN 是否匹配
2. **金额量级检查**：SUM 金额是否在合理量级？月业绩通常千万~亿级
3. **空值检查**：关键字段是否有意外 NULL？特别是 last_year_* 同比字段
4. **口径一致性**：达成额与 fin-cost 的销售收入口径可能有差异，差异>10%需说明

## Unbook 机制

遇到以下情况时，必须对用户说明"我无法准确回答"，而非强行给出不可靠的结果：

- 问题涉及的表/字段在现有参考文档中没有记录
- org_code 与 node 层级映射关系无法确认
- 查询结果出现无法解释的异常值，且无法通过现有文档的"陷阱"解释
- 用户追问的维度细节超出了参考文档覆盖范围（如要求按SKU级别下钻）

升级话术模板：
> "这个问题超出了当前业绩 Skill 的覆盖范围。[具体原因]。建议先补充 [具体参考文档/领域] 的知识后再查。是否需要我先帮你记录这个缺口？"

---

### Task 7: Register skills in .claude/skills/

**Files:**
- Create: `.claude/skills/sales-performance-knowledge` (symlink)
- Create: `.claude/skills/sales-performance-analyst` (symlink)

- [ ] **Step 1: Create symlinks**

```bash
cd D:/dataproj/.claude/skills && MSYS=winsymlinks:nativestrict ln -s ../../skills/sales-performance-knowledge sales-performance-knowledge && MSYS=winsymlinks:nativestrict ln -s ../../skills/sales-performance-analyst sales-performance-analyst
```

- [ ] **Step 2: Verify symlinks**

```bash
ls -la D:/dataproj/.claude/skills/sales-performance-*
```

Expected: Two symlinks pointing to `../../skills/sales-performance-*`

---

### Task 8: Validate with real queries

**Files:**
- None (read-only validation)

- [ ] **Step 1: Test org_code → node_desc mapping**

```bash
"C:/Users/Administrator/AppData/Local/Programs/Python/Python39/python.exe" -c "
import psycopg2
conn = psycopg2.connect(host='121.37.200.214', port=8000, dbname='DP_DWS', user='aiuser', password='Dp123456')
cur = conn.cursor()
# Test the org_code ↔ node mapping
cur.execute('''
SELECT COUNT(DISTINCT p.org_code) as perf_orgs,
       COUNT(DISTINCT s.node10) as tree_nodes,
       COUNT(DISTINCT CASE WHEN p.org_code = s.node10 THEN p.org_code END) as matched
FROM dm.ct_sales_performance_t p
FULL OUTER JOIN dm.dm_rpt_sales_group_t s ON p.org_code = s.node10
WHERE p.calday = '20260531'
''')
r = cur.fetchone()
print(f'业绩表org_code数: {r[0]}')
print(f'组织表node10数: {r[1]}')
print(f'匹配数: {r[2]}')
print(f'匹配率: {r[2]/r[0]*100:.1f}%' if r[0] else 'N/A')
conn.close()
"
```

- [ ] **Step 2: Test basic achievement query**

```bash
"C:/Users/Administrator/AppData/Local/Programs/Python/Python39/python.exe" -c "
import psycopg2
conn = psycopg2.connect(host='121.37.200.214', port=8000, dbname='DP_DWS', user='aiuser', password='Dp123456')
cur = conn.cursor()
cur.execute('''
SELECT COUNT(*), SUM(month_achievement), MIN(calday), MAX(calday)
FROM dm.ct_sales_performance_t
WHERE calday = '20260531'
''')
r = cur.fetchone()
print(f'2026-05-31 rows: {r[0]}, total amount: {r[1]:,.0f} yuan ({r[1]/100000000:.2f}亿)')
conn.close()
"
```

- [ ] **Step 3: Test target table**

```bash
"C:/Users/Administrator/AppData/Local/Programs/Python/Python39/python.exe" -c "
import psycopg2
conn = psycopg2.connect(host='121.37.200.214', port=8000, dbname='DP_DWS', user='aiuser', password='Dp123456')
cur = conn.cursor()
cur.execute('''
SELECT stat_month, COUNT(*), SUM(target_sales_amt) as total_target
FROM dm.dm_dp_api_sales_target
WHERE stat_year = '2026' AND stat_month <= '2026-06'
GROUP BY stat_month
ORDER BY stat_month
''')
for r in cur.fetchall():
    print(f'{r[0]}: {r[1]} rows, target={r[2]:,.0f}')
conn.close()
"
```

---

### Task 9: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md:109-115` (covered domains table)

- [ ] **Step 1: Add sales-performance to covered domains table**

Read CLAUDE.md first, then edit the covered domains table to add:

```
| sales-performance | `skills/sales-performance-knowledge/` | `skills/sales-performance-analyst/` | TBD |
```

In the Cross-domain shared resources section, ensure sales-performance-knowledge points to business-context files.

- [ ] **Step 2: Verify CLAUDE.md consistency**

Read CLAUDE.md and confirm:
- [ ] sales-performance appears in covered domains table
- [ ] Key project files table updated (or covered by skills/ directory entry)
- [ ] Architecture diagram comment still accurate (skills now 4 domains)

---

### Task 10: Verify completeness

**Files:**
- None

- [ ] **Step 1: Show what changed**

```bash
cd D:/dataproj && git status
```

- [ ] **Step 2: Summary of all new files**

New files:
- `skills/sales-performance-knowledge/SKILL.md`
- `skills/sales-performance-knowledge/references/metrics.md`
- `skills/sales-performance-knowledge/references/data-lineage.md`
- `skills/sales-performance-knowledge/references/sales-performance.md`
- `skills/sales-performance-knowledge/references/sales-target.md`
- `skills/sales-performance-analyst/SKILL.md`
- `.claude/skills/sales-performance-knowledge` (symlink)
- `.claude/skills/sales-performance-analyst` (symlink)
- `docs/superpowers/specs/2026-06-08-sales-performance-design.md` (already exists)
- `docs/superpowers/plans/2026-06-08-sales-performance-implementation.md` (this file)

Modified files:
- `CLAUDE.md` (add domain to covered domains table)
