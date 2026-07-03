# 在途库存

## 快速参考

- **DWS 表名**：`dm.dm_b1_transit_inventory_t`
- **业务含义**：采购订单已发货但尚未入库的物料，按客户/物料/品类/月份汇总
- **实体粒度**：一行 = 一个客户 + 物料的月度在途汇总
- **数据量**：1958 万行（2018-01 ~ 2030-12，包含预测数据）
- **列数**：11 列

## 核心字段

| 字段 | 含义 |
|---|---|
| doc_month | 单据月份 YYYY-MM |
| ext_cust_name | 外部客户名称 |
| material_num | 物料号 |
| material_name | 物料名称 |
| category_name | 品类名称 |
| deliver_qty | 交货数量 |
| pur_qty | 采购数量 |
| deliver_amount | 交货金额 |
| pur_amount | 采购金额 |
| dw_last_update_date | DW 最后更新日期 |
| id | 记录 ID |

## 陷阱

1. **包含未来预测数据**：日期范围到 2030-12，其中 2018 至今为实际数据，未来月份为预测/计划数据
2. **汇总表，无明细**：已经是按客户+物料+品类+月份的汇总，无法下钻到采购订单号级别
3. **deliver vs pur**：`deliver_qty` 是供应商已发货数量，`pur_qty` 是采购订单数量，两者差异反映未发出部分

## 常见查询模式

### 当前在途库存汇总
```sql
SELECT category_name, ext_cust_name,
       SUM(deliver_qty) as in_transit_qty,
       SUM(deliver_amount) as in_transit_amt
FROM dm.dm_b1_transit_inventory_t
WHERE doc_month = '2026-06'
GROUP BY category_name, ext_cust_name
ORDER BY in_transit_amt DESC;
```

### 在途库存月度趋势
```sql
SELECT doc_month, SUM(deliver_qty) as qty, SUM(deliver_amount) as amt
FROM dm.dm_b1_transit_inventory_t
WHERE doc_month >= '2025-01' AND doc_month <= '2026-06'
GROUP BY doc_month
ORDER BY doc_month;
```

## 交叉引用

- 仓库库存（入库后）→ [warehouse-stock.md](warehouse-stock.md)
- 库存账龄 → [stock-accage.md](stock-accage.md)
