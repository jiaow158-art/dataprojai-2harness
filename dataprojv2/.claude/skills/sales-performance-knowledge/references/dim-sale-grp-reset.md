# 销售组重置映射表 — dm_md_sale_grp_reset_t

## 表概览

| 属性 | 值 |
|------|-----|
| Schema | `dm` |
| 表名 | `dm_md_sale_grp_reset_t` |
| 列数 | 30 |
| 用途 | **组织架构变更后的销售组历史数据对齐表**，提供修正后的10级组织层级 |
| 使用者 | `ct_sales_performance_t` ETL（脚本1）——用于获取修正后的 node_name9（最末级销售组） |

## 列定义

与 `dm_rpt_sales_group_t` 结构相同，10级组织层级：

| 列名 | 说明 |
|------|------|
| `node1` ~ `node10` | 1~10级组织编码 |
| `node_name1` ~ `node_name10` | 1~10级组织名称（编码） |
| `node_desc1` ~ `node_desc10` | 1~10级组织描述（中文名） |

## 与 dm_rpt_sales_group_t 的区别

| 维度 | `dm_md_sale_grp_reset_t` | `dm_rpt_sales_group_t` |
|------|--------------------------|------------------------|
| 用途 | **历史修正**：组织架构变更后回刷历史数据 | **当前快照**：反映当前有效的组织架构 |
| node_name9 | 修正后的最末级销售组编码 | 当前最末级销售组编码 |
| 更新时机 | 组织架构调整时 | 持续同步 |
| 数据范围 | 仅受影响的组织 | 全量 2427 行 |

## 在业绩宽表 ETL 中的用法

```sql
-- 获取修正后的组织层级
LEFT JOIN dm.dm_md_sale_grp_reset_t c
  ON a.sales_grp = c.node_name9
  AND c.node_name2 = 'H11000001'  -- 仅瓷砖事业部

-- 然后在 INSERT 中使用修正后的 node_desc 系列:
-- c.node_desc2, c.node_desc3, ... 填充 org 的 level1~7
```

## 已知陷阱

1. **node_name9 是关键关联键**：与 `dm_rpt_sales_group_t` 一致
2. **仅瓷砖事业部**：ETL 硬编码 `node_name2 = 'H11000001'`
3. **不是全量数据**：仅包含发生过组织变更的销售组
4. **列顺序**：node9 和 node10 的顺序与 sales_group_t 相同（node10 在 node9 之前，因架构变更）
