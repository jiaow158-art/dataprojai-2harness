# dm_ambv2_chdj_grp_t — 阿米巴存货价值/资金成本表

## 快速参考

- **DWS 表名**：`dm.dm_ambv2_chdj_grp_t`（CHDJ=存货跌价，阿米巴 v2 体系；实际承载存货价值分摊+资金成本）
- **实体粒度**：一行 = stat_month × 物料 × 工厂 × 库存地点 × 产品渠道 × 销售组 组合
- **数据量**：约 28 万行/月（2026-08：27.8万行，35,770 SKU，存货价值合计 6.35亿）
- **时间格式**：`stat_month` = **YYYY-MM**（如 '2026-08'，注意与上市口径表 YYYYMM 不同！）

## 核心字段

| 字段 | 说明 |
|---|---|
| `stat_month` | 统计月份 YYYY-MM |
| `material_num` / `material_name` | 物料编码/描述 |
| `inventory_value` | 存货价值（**是否已扣跌价：口径待 ETL 确认**） |
| `inventory_value_amb` | 存货价值 amb（瓷砖专用） |
| `capital_cost` / `capital_cost_conv` / `capital_cost_sum` / `capital_cost_sum_conv` | 资金成本/分摊/累计/分摊累计（**现值为小负数，符号语义待 ETL 确认**） |
| `contributory_value` | 分摊价值 |
| `percentage` | 销售/工厂比例 |
| `prod_channal` / `prod_channal_name` | 产品渠道（注意拼写 channal） |
| `base_name` / `zww010___t` | 基地/产区 |
| `plant` / `plant___t` | 工厂 |
| `stor_loc` / `stor_loc___t` | 库存地点 |
| `sales_grp` | 销售组 |
| `comp_code` | 公司 |
| `stockcat` | 库存类型（含 'K'，与上市口径表排除 K 不同，口径差的可查证据） |
| `distribution_channel` | 渠道 |
| `ext_grp` | 外部物料组 |
| `zdpsyb` | 事业部（码表见 [org-hierarchy.md](../../sources-of-truth/business-context/org-hierarchy.md) node2 枚举，去 H 前缀；11000011/11000012 为卫浴旧组织，ETL 注释标注） |
| `product_level_code` / `prod_line_name` | 产品层次/产品线 |

## 陷阱

1. **日期格式 YYYY-MM**（上市口径表是 YYYYMM），同一查询混用两张表时必须分别处理。
2. 存货价值口径 6.35亿 ≠ 上市口径 14.3亿（阿米巴核算范围不同），**不可跨表加减**。
3. `capital_cost` 出现负值（2026-08 合计 -35.7万），使用前先与财务确认符号约定；确认前 SKU 效益计算中该减项标注"口径待确认"。同名字段 capital_cost 在 dm_fin_stock_capital_cost_t（上市口径，month=YYYYMM）为正值且公式已验证；上市口径或需正号成本时用彼表。
4. 表内无 `calmonth` 字段，时间过滤字段名是 `stat_month`。

## 常见查询模式

### 物料级资金成本 TOP20
```sql
SELECT material_num, MAX(material_name) AS material_name,
       ROUND(SUM(inventory_value)) AS inv_value,
       ROUND(SUM(capital_cost)) AS capital_cost
FROM dm.dm_ambv2_chdj_grp_t
WHERE stat_month = '2026-08'
GROUP BY material_num
ORDER BY ABS(SUM(capital_cost)) DESC
LIMIT 20;
```

## 血缘

源系统 SAP/阿米巴 → DWI → DM；ETL 脚本：`huaweiclaude/DM/DM_CT/PJob_DWS_DM_AMBV2_CHDJ_GRP_T.txt`。

## 关联文档

- [metrics.md](metrics.md) — 语义层（决策树、日期格式总览、口径决策）
- [stock-fall-list.md](stock-fall-list.md) — 上市口径跌价（另一套库存口径）
- [capital-cost-table.md](capital-cost-table.md) — 库存资金成本表
