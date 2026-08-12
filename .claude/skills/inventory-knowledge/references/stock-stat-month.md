# 库存统计月报

## 快速参考

- **DWS 表名**：`dm.dm_otd_wm_stock_stat_month_t`
- **业务含义**：按月+产品渠道+品类+规格维度的库存统计，含库龄分段（stock_age_seg）和库存类型（stock_type）
- **实体粒度**：一行 = 一个月份 + 产品渠道 + 品类 + 规格 + 库龄段 + 库存类型 的组合
- **数据量**：105 万行（2022-08 ~ 2026-06）
- **列数**：15 列

## 核心字段

| 字段 | 含义 |
|---|---|
| month_date | 月份 |
| prod_channel | 产品渠道 |
| cat | 品类 |
| dimension | 规格 |
| stock_age_seg | 库龄分段（text 类型） |
| stock_type | 库存类型（text 类型） |
| stock_qty | 库存数量 |
| stock_area | 库存面积 |
| display_factory | 展示工厂 |
| product_area_code | 产区编码 |
| product_area_name | 产区名称 |
| supplier_or_creditor_acct | 供应商/债权人科目 |
| supplier_or_creditor_name | 供应商/债权人名称 |
| inv_location | 库存地点 |
| dw_last_update_date | 最后更新日期 |

## 库龄分段（stock_age_seg 典型值）

需要实际查询确认，通常为：
- 0-3 月 / 3-6 月 / 6-12 月 / 12-24 月 / 24 月+

## 库存类型（stock_type 典型值）

需要实际查询确认，通常包含：
- 可用库存 / 冻结库存 / 质检库存 / 在途库存

## 陷阱

1. `stock_age_seg` 和 `stock_type` 是 text 类型，可能包含中文值，查询时注意字符匹配
2. 该表是月统计汇总，不含明细级的物料号/批次信息

## 常见查询模式

### 某月库龄分布
```sql
SELECT stock_age_seg, SUM(stock_qty) as qty, SUM(stock_area) as area
FROM dm.dm_otd_wm_stock_stat_month_t
WHERE month_date = '202606'
GROUP BY stock_age_seg
ORDER BY stock_age_seg;
```

### 按产区+库龄的库存趋势
```sql
SELECT month_date, product_area_name, stock_age_seg,
       SUM(stock_area) as total_area
FROM dm.dm_otd_wm_stock_stat_month_t
WHERE month_date >= '2026-01' AND stock_age_seg IN ('0-3月','3-6月','6-12月')
GROUP BY month_date, product_area_name, stock_age_seg
ORDER BY month_date, product_area_name;
```

## 交叉引用

- 库存账龄明细（具物料明细）→ [stock-accage.md](stock-accage.md)
- 仓协销日报 → [cxc-daily.md](cxc-daily.md)
