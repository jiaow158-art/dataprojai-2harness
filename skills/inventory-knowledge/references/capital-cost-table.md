# dm_fin_stock_capital_cost_t — 库存资金成本表

## 快速参考

- **DWS 表名**：`dm.dm_fin_stock_capital_cost_t`
- **业务含义**：按物料×工厂×批次×库存地点核算的库存资金成本（上市口径），公式为 `((期初+期末)/2 − 202012余额) × 4%/12`
- **实体粒度**：一行 = month × 事业部 × 公司 × 工厂 × 物料 × 批次 × 库存地点 × 库存类别
- **数据量 / 时间范围**：约 238 万行/月；最新月份 202608，自 2024-03-02 起持续刷新
- **时间字段与格式**：`month` = **YYYYMM**（如 '202608'，注意与 CHDJ 表的 YYYY-MM 不同！）

## 公式与计算逻辑（ETL: PJob_DWS_DM_FIN_STOCK_CAPITAL_COST_T 实证）

```text
capital_cost = ((NVL(期初余额,0) + NVL(期末余额,0))/2 − 202012余额) × 0.04 / 12
```

- **期初余额** = `LAG(期末余额)` 窗口：分区 = 事业部+事业部描述+公司+工厂+物料+物料名称+批次+库存地点+库存类别+大区，按 month 升序 → **每个物料-批次组合的首月期初=0**
- **202012余额** = 源表 `calmonth='202012'` 的 `zsjkcje` 按**同一分区键**聚合，硬锚定
- **期末余额** = 当月源表 `zsjkcje` 聚合
- "期初+期末=0 则成本=0"的零判断版**已按财务要求取消**（2023-07-29，逻辑注释保留在 ETL 脚本中）
- `capital_cost_sum` = 年内累计（**分年计算不跨年**：上年段与当年段各自 SUM 窗口）
- **事实源**：`dm_fin_stock_detail_accage_t_2023`（zsjkcje，过滤 `(stockcat IS NULL OR stockcat<>'K')`），经中间表 `DM_FIN_STOCK_CAPITAL_M1_T`（TRUNCATE-INSERT）
- **刷新**：目标表 **TRUNCATE 全量重算**，仅保留近 2 年（`${PERIOD_ID_Y}`-1 年 1 月 ~ `${PERIOD_ID_M}`）
- `sales_group_code` 映射（ETL 硬编码）：非全资公司 → `upload.upload_division_comp_t`（END_DATE='9999-12-31'）；11000010→R4R；11000003 按大区→RR5/R8R/RY9/P76/R6D；11000002→R2T；11000001→R40

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
| `capital_cost` | numeric | 当月资金成本（**2026-08 合计 +58.1万，2026-08-19 复核**） |
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

1. **日期格式 YYYYMM**（如 '202608'），CHDJ 表是 `stat_month`（YYYY-MM）。跨表查询分别处理时间格式。
2. **TRUNCATE 滚动窗口只留近 2 年**：查更早月份（如 2024 年初）可能已滚出表外，返回 0 行不是数据丢失而是窗口限制。
3. **capital_cost 可为负**：平均余额 < 202012 基线时公式结果为负（去库存期常态）。**不是符号约定错误**——负值=该物料组合库存已降至 2020 年末基线之下。2026-08 全集团合计为正（+58.1万，2026-08-19 复核）不代表各范围子集为正。
4. **CHDJ 的 capital_cost 取自本表但不可 SUM 原始列**（V6 实证）：CHDJ 原始列在分摊行结构中重复携带全额（单物料放大 ~9×，2026-08 全表 -35.3万 vs 本表 +58.1万 符号都反）；其 `capital_cost_conv`（分摊列）合计才与本表吻合（0.3%）。要 CHDJ 维度金额 → SUM conv 列；要准确金额 → 直接用本表。
5. **LAG 分区键含 material_name**：物料改名 → 分区断裂 → 期初余额变 0 → 当月资金成本突降。追查单物料资金成本异常时先查物料名称是否变过。
6. **closing_balance 14.3亿 ≠ CHDJ inventory_value 6.35亿**：后者实为**管理口径减值**（非库存价值，2026-08-19 ETL 实证），概念不同不可比。见 [chdj-capital-cost.md](chdj-capital-cost.md)。
7. `stock_type` 列承接源表 `stockcat`（库存类别），已排除 'K'。
8. `plant___t`/`stor_loc___t` 早期数据大量为空，用 `LENGTH(TRIM(x))>0` 过滤或用编码。
9. zdpsyb 码表：组织架构 node2 去 H 前缀（如 `H11000001`→`11000001`，解码见 [org-hierarchy.md](../../sources-of-truth/business-context/org-hierarchy.md) node2 枚举）；11000011/11000012 为卫浴旧组织（org-hierarchy.md 未收录）。

## 常见查询模式

### 按事业部查看资金成本
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

- [metrics.md](metrics.md) — 语义层（决策树、日期格式总览、口径决策）
- [stock-fall-list.md](stock-fall-list.md) — 上市口径跌价表
- [chdj-capital-cost.md](chdj-capital-cost.md) — 阿米巴存货价值/资金成本表
