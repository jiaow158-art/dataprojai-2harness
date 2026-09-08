# 安全库存 / 低周转 / 残次品 / 缺货

## 快速参考

覆盖四类特殊库存分析场景：

| 场景 | DWS 表 | 行数 | 列数 |
|---|---|---|---|
| 安全库存-总库存 | `dm.dm_safestock_all_stock` | 384 | 5 |
| 安全库存-可用库存 | `dm.dm_safestock_avil_stock` | 28,093 | 3 |
| 安全库存-未发 | `dm.dm_safestock_no_deliver` | 965 | 3 |
| 缺货超期 | `dm.dm_dp_api_stockout_oudue` | 4,942 | 13 |
| 低周转出库明细 | `dm.dm_wm_low_turnover_stockout_detail_t` | 362,782 | 46 |
| 残次品出库 | `dm.dm_wm_defective_product_stockout_t` | 944,434 | 39 |
| 库龄月报汇总 | `dm.dm_rpt_stock_age_month_ct` | 57 | 9 |
| 库存周转月度 | `dm.dm_otd_wm_stock_turnover_m` | 40 | 7 |

## 安全库存表 (safestock_*)

### dm_safestock_all_stock
| 字段 | 含义 |
|---|---|
| product_level2_name | 产品二级分类 |
| dimension | 规格 |
| prod_area | 产区 |
| all_stock_quantity | 总库存数量 |
| all_stock_area | 总库存面积 |

### dm_safestock_avil_stock
| 字段 | 含义 |
|---|---|
| material_num | 物料号 |
| prod_area | 产区 |
| available_inventory_quantity | 可用库存数量 |

### dm_safestock_no_deliver
| 字段 | 含义 |
|---|---|
| material_num | 物料号 |
| prod_area | 产区 |
| nodeliver_qty_aps | 未发数量（APS 计划口径） |

## 缺货超期表

### dm_dp_api_stockout_oudue
| 字段 | 含义 |
|---|---|
| stat_year / stat_month / stat_month_ym | 统计期间 |
| sales_center_code / sales_center | 销售中心 |
| sales_dep_code / sales_dep | 销售部门 |
| sales_region_code / sales_region | 销售区域 |
| integrate_channel | 整合渠道 |
| stockout_area_ondue | 按期缺货面积 |
| stockout_area | 总缺货面积 |
| dw_last_update_date | 最后更新日期 |

## 低周转 / 残次品出库明细

两张表结构高度相似（46 列 vs 39 列），共用基础字段：

| 字段 | 含义 |
|---|---|
| material_vch_no_mblnr | 物料凭证号 |
| voucher_post_date | 凭证过账日期 |
| warehouse_manage_move_type | 仓库管理移动类型 |
| material_id / material_num | 物料 |
| batch_num | 批次号 |
| input_unit_qty / quantity | 数量 |
| base_measure_unit | 基本计量单位 |
| factory_werks_id / factory_werks_code / factory_werks_name | 工厂 |
| company_id / company_code / company_name | 公司 |
| (更多明细字段) | 成本中心、利润中心、移动原因等 |

## 库龄月报汇总

### dm_rpt_stock_age_month_ct
| 字段 | 含义 |
|---|---|
| calmonth | 会计期间 |
| zsjkcje | 资金占压金额（总） |
| ybzq_bzdq_amt | 已包装-标准地区 |
| ybzq_bzdq_3_amt | 已包装-标准地区-3月 |
| wbzq_6_amt | 未包装 0-6月 |
| wbzq_6_12_amt | 未包装 6-12月 |
| wbzq_12_24_amt | 未包装 12-24月 |
| wbzq_24_amt | 未包装 24月+ |
| other_amt | 其他金额 |

## 库存周转月度

### dm_otd_wm_stock_turnover_m

| 字段 | 类型 | 含义 |
|---|---|---|
| stat_month | text | 统计月份 |
| stock_amt | numeric | 当月库存金额 |
| sales_cost | numeric | 当月销售成本 |
| stock_amt_last13m | numeric | 近13月库存金额 |
| sales_cost_last12m | numeric | 近12月销售成本 |
| turnover_times | numeric | 周转次数 |
| dw_last_update_date | timestamp with time zone | 最后更新日期 |

**周转率计算**：`turnover_times` 是预计算字段，也可用 `sales_cost_last12m / (stock_amt_last13m / 13)` 手动计算月均周转。

## 陷阱

1. **安全库存表行数很少**：`safestock_all_stock` 仅 384 行，是高度汇总的报表数据
2. **库龄月报（57 行）**：按 calmonth 汇总的月级库龄分布，不含明细
3. **低周转 vs 残次品**：
   - 低周转 = 库龄超过阈值的正常品出库
   - 残次品 = 质量缺陷产品的出库
4. **缺货数据的口径**：`stockout_area_ondue` 是按期缺货（到期未交付），`stockout_area` 是总缺货（含未到期）

## 常见查询模式

### 安全库存健康度
```sql
SELECT product_level2_name, prod_area,
       all_stock_quantity, all_stock_area
FROM dm.dm_safestock_all_stock
ORDER BY all_stock_area DESC;
```

### 缺货按销售区域汇总
```sql
SELECT sales_region, stat_month_ym,
       SUM(stockout_area) as total_out,
       SUM(stockout_area_ondue) as due_out
FROM dm.dm_dp_api_stockout_oudue
WHERE stat_year >= '2025'
GROUP BY sales_region, stat_month_ym
ORDER BY stat_month_ym, total_out DESC;
```

### 低周转出库明细
```sql
SELECT factory_werks_name, material_num, batch_num,
       quantity, voucher_post_date
FROM dm.dm_wm_low_turnover_stockout_detail_t
WHERE voucher_post_date >= '2026-01-01'
ORDER BY voucher_post_date DESC
LIMIT 100;
```

## 交叉引用

- 库存账龄明细 → [stock-accage.md](stock-accage.md)
- 库存统计月报 → [stock-stat-month.md](stock-stat-month.md)
