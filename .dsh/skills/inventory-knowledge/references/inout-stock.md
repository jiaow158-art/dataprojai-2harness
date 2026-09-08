# 产品出入库明细

## 快速参考

- **DWS 表名**：
  - `dm.dm_product_inout_stock_t`（992,759 行，21 列）
  - `dm.dm_original_product_inout_stock_hunan_t`（1,472,744 行，31 列，含原始库存维度）
  - `dm.dm_product_inout_stock_hunan_t`（562,631 行，21 列，湖南基地）
- **业务含义**：按工厂+品牌+产品+物料维度的月度出入库汇总
- **实体粒度**：一行 = 一个物料在一个工厂/品牌的月度出入库汇总

## dm_product_inout_stock_t 字段（21 列）

| 字段 | 含义 |
|---|---|
| factory_werks_code / factory_werks_name | 工厂 |
| product_level2_name | 产品二级分类 |
| product_brand_code / product_brand_name | 品牌 |
| product_place_code / product_place_name | 产地 |
| dimension_ | 规格（注意字段名有下划线后缀） |
| material_num / material_name | 物料 |
| in_stock_qty / in_stock_area | 入库数量/面积 |
| out_stock_qty / out_stock_area | 出库数量/面积 |
| stock_qty_month_end / stock_area_month_end | 月末库存数量/面积 |
| stock_qty_month_start / stock_area_month_start | 月初库存数量/面积 |
| start_month | 统计月份（时间字段） |
| material_rank | 物料等级 |
| dw_last_update_date | 最后更新日期 |

## dm_original_product_inout_stock_hunan_t 额外字段（31 列）

比 `dm_product_inout_stock_t` 多了：

| 字段 | 含义 |
|---|---|
| batch_num | 批次号 |
| gl_account_no | 总账科目编码 |
| cost_center / cost_center_name | 成本中心 |
| avgprice | 平均价格 |
| move_type | 移动类型 |
| stock_amt_month_end / stock_amt_month_start | 月末/月初库存金额 |
| in_stock_amt / out_stock_amt | 入库金额/出库金额 |

## 陷阱

1. `dm_product_inout_stock_t` 的规格字段是 `dimension_`（有下划线后缀），不是 `dimension`
2. 湖南基地有 `dm_product_inout_stock_hunan_t`（21 列）和 `dm_original_product_inout_stock_hunan_t`（31 列含金额/成本中心）
3. 时间字段为 `start_month`（YYYY-MM 格式）

## 常见查询模式

### 某工厂月度出入库汇总
```sql
SELECT factory_werks_name, product_brand_name,
       SUM(in_stock_area) as in_area,
       SUM(out_stock_area) as out_area,
       SUM(stock_area_month_end) as end_area
FROM dm.dm_product_inout_stock_t
GROUP BY factory_werks_name, product_brand_name
ORDER BY in_area DESC;
```

## 交叉引用

- 仓协销日报（更细时间粒度）→ [cxc-daily.md](cxc-daily.md)
- 库存账龄 → [stock-accage.md](stock-accage.md)
