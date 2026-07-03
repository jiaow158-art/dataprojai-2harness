# 销售净额事实表 — dm_fact_finance_salesnetamt_f

## 表概览

| 属性 | 值 |
|------|-----|
| Schema | `dm` |
| 表名 | `dm_fact_finance_salesnetamt_f` |
| 行数 | 49,720 |
| 列数 | 23 |
| 粒度 | 月 × node_desc3（第3级组织节点） |
| 时间字段 | `calmonth` (YYYY-MM) |
| 用途 | **组织级销售净额+期间费用汇总表**，提供不含税销售净额和经营费用的月度快照 |
| 适用事业部 | 全事业部（瓷砖/卫浴/国际营销中心/生态新材等） |

## 列定义

### 组织维度（内置 node_desc，无需 JOIN）

| 列名 | 说明 |
|------|------|
| `node_desc1` ~ `node_desc9` | 1~9级组织描述（如 `东鹏集团` → `瓷砖事业部` → `国内营销系统`） |
| `node_name1` ~ `node_name9` | 1~9级组织编码 |

### 核心指标

| 列名 | 类型 | 说明 |
|------|------|------|
| `notax_sales_net_amt` | numeric | **不含税销售净额（管理口径）** |
| `period_expense` | numeric | 期间费用 |
| `operating_expense` | numeric | 经营费用 |

### 时间/元数据

| 列名 | 类型 | 说明 |
|------|------|------|
| `calmonth` | varchar(256) | 日历月 (YYYY-MM)，含特殊值 `S`（来源系统标记） |
| `dw_last_update_date` | timestamp | 同步时间 |

## 数据特征

### 组织覆盖

该表覆盖多个事业部，按 `node_desc3` 粒度：

| node_desc2 | node_desc3 示例 |
|-----------|----------------|
| 瓷砖事业部 | 国内营销系统、梦之家 |
| 卫浴事业部 | 卫浴全资、卫浴非全资 |
| 国际营销中心 | 战略工程部、卫浴整装营销部、澳新美加区域、RCEP区域 |
| 生态新材事业部 | 营销一部、营销二部 |

### calmonth 特殊值

`calmonth = 'S'`：部分行的月份为 `S`（非标准日期格式），`notax_sales_net_amt` 为 NULL，可能表示"来源系统"标记行或汇总行。

## 与 Mix 表的关键区别

| 维度 | `dm_fact_finance_salesnetamt_f` | `dm_fin_operations_mix_sum_t` |
|------|--------------------------------|-------------------------------|
| 粒度 | 月 × node_desc3 | 日 × 物料 × 客户 × 销售组 × 渠道 |
| 行数 | 5万 | 903万 |
| 不含税净额 | `notax_sales_net_amt` | `notax_sales_net_amt` |
| 期间/经营费用 | **独有** `period_expense` / `operating_expense` | 无 |
| 产品/客户/渠道 | 无 | 完整维度 |
| 预算/预测 | 无 | `_ys` / `_yc` 后缀 |
| 费用分析 | **是**（含期间费用和经营费用） | 否 |

## 适用场景

1. **事业部级净额+费用对比**：按 `node_desc2` + `calmonth` 汇总，快速获取各事业部的不含税净额和费用
2. **净额与费用率**：`operating_expense / notax_sales_net_amt` 计算经营费用率
3. **跨事业部对比**：表中5万行已含全事业部数据，无需 UNION 多表

## 已知陷阱

1. **calmonth 含特殊值 `S`**：查询时必须过滤 `calmonth != 'S'` 或使用 `calmonth LIKE '____-__'`
2. **粒度粗**：仅到 node_desc3，无法按客户/物料/渠道下钻
3. **无 ETL 脚本归档**：该表的 ETL 脚本在 `huaweiclaude/` 中未找到，数据来源和计算逻辑无法确认
4. **费用口径不明**：`period_expense` 与 `operating_expense` 在当前查询结果中值完全相同，可能是同一概念的不同命名或冗余列
5. **与 Mix 表的不含税净额可能有口径差异**：本表标注为"管理口径"，Mix 表为"财务口径"
6. **数据量小**：仅5万行，月粒度，适合做管理报表级别的汇总查询
