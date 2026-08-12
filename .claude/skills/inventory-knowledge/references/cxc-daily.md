# 仓协销日报（CXC）

## 快速参考

- **DWS 表名**：`dm.dm_rpt_wm_cxc_day_sum`
- **业务含义**：仓协销（仓储协作销售）日报，按天+区域+品类+规格+产品渠道维度记录期初期末库存、销售出库、入库面积。这是运营日报的核心数据源。
- **实体粒度**：一行 = 一个日期 + 区域 + 品类 + 规格 + 渠道 的组合
- **数据量**：172 万行（2022-07-31 ~ 2026-06-06）
- **列数**：15 列

## 核心字段

| 字段 | 含义 |
|---|---|
| stat_date | 统计日期 YYYYMMDD |
| belong_area_name | 所属区域名称 |
| cat | 品类 |
| dimension | 规格 |
| prod_channel | 产品渠道 |
| stock_area_month_start | 月初库存面积 |
| stock_area_month_end | 月末库存面积 |
| stock_area_year_start | 年初库存面积 |
| sales_stock_out_area_year | 年度累计销售出库面积 |
| stock_in_area_year | 年度累计入库面积 |
| sales_stock_out_area_month | 月度销售出库面积 |
| stock_in_area_month | 月度入库面积 |
| sales_stock_out_area_day | 当日销售出库面积 |
| stock_in_area_day | 当日入库面积 |
| dw_last_update_date | 最后更新日期 |

## 计算指标

| 指标 | 公式 |
|---|---|
| 月度库存周转率 | sales_stock_out_area_month / ((stock_area_month_start + stock_area_month_end) / 2) |
| 累计库存周转率 | sales_stock_out_area_year / 平均库存 |
| 当日净入库 | stock_in_area_day - sales_stock_out_area_day |

## 陷阱

1. **单位是面积（平米），不是数量（片/箱）**：所有字段都是 `area`，如果需要按数量分析需用其他表
2. **月初/月末是快照值**，不是当月累计值
3. 该表还有 `_0630` 和 `_tmp` 两个变体，查询时用主表
4. `prod_channel` 可能为空，空值也需要纳入分析

## 常见查询模式

### 某日库存日报
```sql
SELECT belong_area_name, cat, prod_channel, dimension,
       stock_area_month_start, stock_area_month_end,
       sales_stock_out_area_day, stock_in_area_day
FROM dm.dm_rpt_wm_cxc_day_sum
WHERE stat_date = '20260606'
ORDER BY belong_area_name, cat
LIMIT 100;
```

### 月度出入库趋势
```sql
SELECT SUBSTR(stat_date, 1, 6) as month,
       belong_area_name,
       SUM(sales_stock_out_area_month) as out_area,
       SUM(stock_in_area_month) as in_area
FROM dm.dm_rpt_wm_cxc_day_sum
WHERE stat_date >= '20260101'
GROUP BY SUBSTR(stat_date, 1, 6), belong_area_name
ORDER BY month, out_area DESC;
```

## 交叉引用

- 出入库明细 → [inout-stock.md](inout-stock.md)
- 库存统计月报 → [stock-stat-month.md](stock-stat-month.md)
