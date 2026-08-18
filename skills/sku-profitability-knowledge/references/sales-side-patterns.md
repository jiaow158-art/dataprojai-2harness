# 销售侧问题族 — 口径与表组合（问题 1/2/3/7）

> 可执行 SQL 见 analyst 模式 A/B/C/G。本文件只定口径。

## 问题1 SKU 销售规模 / 帕累托

- 表：Mix 单表（`material_num` 粒度聚合）
- 口径：销售额 = `ambperformance`（含税达成主口径）；面积 = `zxsmj`
- 帕累托：按销售额降序累计占比，80% 线为「核心 SKU」边界；报告端画线，SQL 给累计占比列
- SKU 分层：累计 ≤80% 核心 / 80-95% 腰部 / >95% 长尾
- 品类过滤用 `category_name`；无品类条件时默认全品类 + LIMIT TOP N

## 问题2 SKU 趋势

- 表：Mix 单表，`calmonth` 月序列（'YYYY-MM'）
- 环比：LAG 窗口；同比：自连接上一年同月
- **周度趋势不可答**（无周聚合表），引导用户按月

## 问题3 毛利贡献 / 四象限

- 表：Mix 单表
- 毛利额 = `gross_profit_after_sharing`（分摊后，主口径）；毛利率 = 毛利额÷`ambperformance`
- 四象限：横轴 = 销售增长率（本期 vs 上期等长窗口），纵轴 = 毛利率，气泡 = 销售额
- 品类平均毛利率 = 品类聚合毛利÷品类聚合销售额（不是 SKU 毛利率平均）

## 问题7 渠道/区域 × SKU

- 表：Mix 单表
- 渠道默认 `integrate_channel__t`；区域 = `region_province_name` 或 `node_desc*`（依用户表述）
- 热力图数据 = 渠道(列) × SKU(行) 的销售额/毛利率矩阵，TOP N SKU
