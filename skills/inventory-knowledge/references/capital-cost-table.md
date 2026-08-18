# dm_fin_stock_capital_cost_t — 库存资金成本表

## 快速参考

- **DWS 表名**：`dm.dm_fin_stock_capital_cost_t`
- **业务含义**：按物料×工厂×批次×库存地点核算的库存资金成本（上市口径），公式为 `(期初+期末)/2 - 202012余额) × 4%/12`
- **实体粒度**：一行 = month × 事业部 × 公司 × 工厂 × 物料 × 批次 × 库存地点 × 库存类别
- **数据量 / 时间范围**：约 238 万行/月；最新月份 202608，数据更新至 2024-03-02 起持续刷新
- **时间字段与格式**：`month` = **YYYYMM**（如 '202608'，注意与 CHDJ 表的 YYYY-MM 不同！）

## 核心字段

| 字段 | 类型 | 含义 |
|---|---|---|
| `business_department` | varchar(500) | 事业部代码 |
| `month` | varchar(500) | 日历月 YYYYMM |
| `comp_code` | varchar(500) | 公司代码 |
| `factory_code` | varchar(500) | 工厂 |
| `material_code` | varchar(500) | 物料编码 |
| `material_name` | varchar(500) | 物料描述 |
| `batch` | varchar(500) | 批次 |
| `stock_location` | varchar(500) | 库存地点 |
| `stock_type` | varchar(500) | 库存类别（可为空） |
| `closing_balance_202012` | numeric | 2020年12月余额（基准扣除额） |
| `closing_balance_last_month` | numeric | 期初余额 |
| `closing_balance` | numeric | 期末余额（**2026-08 合计 14.3亿**） |
| `capital_cost` | numeric | 当月资金成本（**2026-08 合计 +58.4万**） |
| `capital_cost_sum` | numeric | 累计资金成本（年初至今） |
| `business_department_desc` | varchar(100) | 事业部描述 |
| `sales_group_code` | varchar(100) | 销售组编码 |
| `plant___t` | varchar(100) | 工厂名称 |
| `stor_loc___t` | varchar(100) | 库存地点名称 |
| `product_base` | varchar(100) | 生产基地 |
| `zdpzgsdq` | varchar(100) | 子公司大区 |
| `prod_line_name` | varchar(100) | 产品线（分类） |
| `dw_last_update_date` | timestamp | 数据同步时间 |

## 陷阱

1. **日期格式 YYYYMM**（如 '202608'），与 CHDJ 表的 `stat_month`（YYYY-MM）不同。跨表查询时必须分别处理时间字段格式。
2. **与 CHDJ 表的 capital_cost 符号相反**：本表 2026-08 资金成本合计 +58.4万（正值），CHDJ 表同期合计 -35.7万（负值）。两套核算体系（上市口径 vs 阿米巴口径），**不可混用**。
3. **closing_balance 14.3亿 ≠ CHDJ inventory_value 6.35亿**：上市口径含全部库存，阿米巴口径仅含瓷砖等部分品类。跨表金额加减无意义。
4. **物料字段名不同**：本表用 `material_code`，CHDJ 表用 `material_num`，上市口径明细表用 `material`。
5. **plant___t / stor_loc___t 大量为空**（早期数据），使用时用 `LENGTH(TRIM(plant___t)) > 0` 过滤或使用编码关联。
6. **closing_balance_202012 为基准扣除项**：ETL 公式为 `(期初+期末)/2 - 202012余额) × 年化利率/12`，202012 基数大的物料资金成本低。

## 常见查询模式

### 按事业部查看资金成本（验证通过）
```sql
SELECT business_department_desc,
       ROUND(SUM(closing_balance)) AS balance,
       ROUND(SUM(capital_cost)) AS cost
FROM dm.dm_fin_stock_capital_cost_t
WHERE month = '202608'
  AND LENGTH(TRIM(business_department_desc)) > 0
GROUP BY business_department_desc
ORDER BY balance DESC;
```

## 血缘

源表：`DM.DM_FIN_STOCK_DETAIL_ACCAGE_T_2023`（上市口径库存明细）
ETL 脚本：`huaweiclaude/DM/PJob_DM_FIN_STOCK_CAPITAL_COST_T.txt`
DWS 层加载：`huaweiclaude/DWS/FIN/FIN_INSERT/PJob_DWS_DM_FIN_STOCK_CAPITAL_COST_T.txt`

## 关联文档

- [chdj-capital-cost.md](chdj-capital-cost.md) — 阿米巴存货价值/资金成本表
