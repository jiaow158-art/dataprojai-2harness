# 销售组织架构

## 数据源

- **DWS 表**：`dm.dm_rpt_sales_group_t`
- **更新频率**：每日（`dw_last_update_date` 记录最后更新时间）
- **行数**：2,427 行
- **用途**：定义公司 10 级销售组织层级树，是所有领域查询组织维度费用的共同主数据

## 表结构

每级组织有 3 个字段：`node*`(编码)、`node_name*`(名称)、`node_desc*`(描述)：

| 层级 | 编码字段 | 名称字段 | 描述字段 | 说明 |
|------|----------|----------|----------|------|
| 1 | node1 | node_name1 | node_desc1 | 集团（仅 1 个：东鹏集团） |
| 2 | node2 | node_name2 | node_desc2 | 事业部/平台（15 个） |
| 3 | node3 | node_name3 | node_desc3 | 一级部门（95 个） |
| 4 | node4 | node_name4 | node_desc4 | 二级部门（274 个） |
| 5 | node5 | node_name5 | node_desc5 | 三级部门（454 个） |
| 6 | node6 | node_name6 | node_desc6 | 四级部门（824 个） |
| 7 | node7 | node_name7 | node_desc7 | 五级部门（1,425 个） |
| 8 | node8 | node_name8 | node_desc8 | 六级部门（1,898 个） |
| 9 | node9 | node_name9 | node_desc9 | 七级部门（2,119 个） |
| 10 | node10 | node_name10 | node_desc10 | 八级部门 |

## node2 事业部/平台（15 个）

| 编码 | 名称 | 说明 |
|------|------|------|
| H11000001 | 瓷砖事业部 | 核心业务 |
| H11000002 | 卫浴事业部 | |
| H11240102 | 国际营销中心 | |
| H11250401 | 丽适岩板 | |
| R91000047 | 财经平台 | 财务/法务等 |
| R91000049 | 人资运营平台 | HR/总裁办等 |
| R91000048 | 数字赋能平台 | IT/流程信息等 |
| R91000001 | 工程物流 | 工程+物流 |
| R91000003 | 公司层面 | 跨事业部的公司级部门 |
| R91000050 | 董事会 | |
| R91250501 | 审计稽察部 | |
| R91230602 | 上市主体内的关联交易 | |
| — | 集团品牌中心 | |
| — | 过渡部门 | |
| — | 东鹏集团 | node2 直接等于集团 |

## 如何查询组织费用

`dm.dm_fact_finance_cost_f` 表已内置 `node_desc1~9` 和 `node_name1~9` 字段，**直接 WHERE 过滤，无需 JOIN**：

```sql
-- 按事业部汇总制造费用
SELECT node_desc2, SUM(amount) as total
FROM dm.dm_fact_finance_cost_f
WHERE month = '2026-06'
  AND config_name = '制造费用'
  AND node_desc2 = '瓷砖事业部'
GROUP BY node_desc2;

-- 下钻到 node3（事业部下的部门）
SELECT node_desc3, SUM(amount) as total
FROM dm.dm_fact_finance_cost_f
WHERE month = '2026-06'
  AND config_name = '制造费用'
  AND node_desc2 = '瓷砖事业部'
GROUP BY node_desc3
ORDER BY total DESC;
```

如果需要获取最新的完整组织树（含编码映射），关联 `dm_rpt_sales_group_t`：

```sql
SELECT f.*, s.node_desc3, s.node_desc4
FROM dm.dm_fact_finance_cost_f f
LEFT JOIN dm.dm_rpt_sales_group_t s
  ON f.sales_grp_code = s.node10  -- 最细粒度关联
WHERE f.month = '2026-06';
```

## 其他领域对应

- **库存表**：`dm_fin_stock_detail_accage_t_2023` 等通过 `sales_grp_code` / `node_desc*` 关联
- **应收表**：`dwr_ar_receivable_aging_2023_info_f` 等通过 `sales_group_code` 关联
- **通用原则**：各域事实表均内置 node_desc 层级字段

## 注意事项

- node1~node10 并非每个组织都填满 10 级，部分组织在较粗粒度就结束了
- 同一编码在不同行可能出现于不同层级（取决于具体路径）
- `sales_grp_code` 在费用表中通常对应最细粒度的 node 编码
