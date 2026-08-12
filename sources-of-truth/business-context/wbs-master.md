# WBS 元素主数据

## 数据源

- **DWS 表**：`dwrdim.dwr_dim_wbs_basis_info_f`
- **更新频率**：由 `dw_last_update_date` 记录
- **数据量**：129 万行，5.1 万顶层 WBS 元素
- **用途**：WBS（Work Breakdown Structure，工作分解结构）是费用核算的关键维度，用于归集项目成本、工程费用、研发支出等

## WBS 层级结构

```
wbs_top_level          (顶层，51120 个)
  └ wbs_level1         (一级，含 wbs_level1_object)
      └ wbs_level2     (二级，含 wbs_level2_object)
          └ wbs_level3 (三级，含 wbs_level3_object)
```

示例：`CZMP200001-02MM` → `CZMP200001-02MM-08` → `CZMP200001-02MM-08-xx`

## 核心维度字段

| 字段 | 说明 |
|------|------|
| `wbs_top_level` / `wbs_top_level_desc` | WBS 顶层编码/描述 |
| `wbs_level1~3` / `wbs_level1~3_desc` | WBS 1~3 级编码/描述 |
| `wbs_level1_object` / `wbs_level2_object` / `wbs_level3_object` | 1~3 级对象编码 |
| `wbs_internal_num` | WBS 内部编号 |
| `pspnr` | SAP 项目编号 |

## 项目类型（16 种）

| 编码 | 类型 | 说明 |
|------|------|------|
| RD | 产品研发项目 | 新产品研发 |
| TD | 高新研发项目 | 高新技术项目研发 |
| YF | 研发类项目 | 通用研发 |
| JJ | 基地建设项目 | 生产基地建设 |
| IT | IT 重大项目 | 信息系统建设 |
| KM | 战略工程项目 | 战略级别工程 |
| PA | 总部工程（除战略)项目 | 总部级工程 |
| GM | 瓷砖国贸工程 | 国际工程 |
| PJ | 洁具公司工程项目 | 洁具工程 |
| PD | 集团其他公司工程项目 | 集团其他工程 |
| PX | 经销商代签工程项目 | 经销商代签工程 |
| PZ | 子公司工程项目 | 子公司工程 |
| YX | 营销活动项目 | 市场推广活动 |
| GX | 广告宣传项目 | 广告投放 |
| FW | 中介服务项目 | 中介/咨询 |
| HY | 大型会议项目 | 会议/展会 |

## 业务属性

| 字段 | 说明 | 唯一值数 |
|------|------|----------|
| `company` | 所属公司 | 39 |
| `factory` | 所属工厂 | 80 |
| `profit_center` | 利润中心 | 41 |
| `sales_org` | 销售组织 | 41 |
| `sales_grp` | 销售组 | — |
| `sales_emp` / `sales_emp_name` | 销售代表 | — |
| `distribution_channel` | 分销渠道 | — |
| `business_scope` | 业务范围 | — |
| `func_area` | 功能范围 | — |
| `currency` | 币种 | 1（CNY） |
| `custom` / `custom_oss` | 客户/OSS 客户 | — |

## 结算信息

| 字段 | 说明 |
|------|------|
| `settlement_rules` / `settlement_rules_desc` | 结算规则 |
| `settlement_ratio` | 结算比例（可分配给多个接收方） |
| `asset_code` / `asset_sub_code` / `asset_desc` | 固定资产编码 |

## 生命周期

| 字段 | 说明 |
|------|------|
| `create_date` | 创建日期 |
| `last_update_date` | 最后更新日期 |
| `delete_flag` | 删除标记 |
| `dw_last_update_date` | DWS 最后更新日期 |
| `system_station_creator` ~ `system_station_lock` | 各系统状态（创建/发布/维护/部分/锁定） |
| `user_station` / `user_station_desc` | 用户状态 |
| `owner` / `owner_desc` | 负责人 |

## 与各域的关联

费用表（`dm_fact_finance_cost_f` / `dwr_fin_cost_d_compre_subj_t`）中均有 WBS 字段：

```sql
-- 按 WBS 汇总费用
SELECT wbs, wbs_desc, SUM(amount) as total
FROM dm.dm_fact_finance_cost_f
WHERE month = '2026-06'
  AND wbs_top_level IS NOT NULL
GROUP BY wbs, wbs_desc
ORDER BY total DESC;

-- 关联 WBS 主数据获取项目类型
SELECT f.wbs, w.project_type_desc, w.profit_center, SUM(f.amount) as total
FROM dm.dm_fact_finance_cost_f f
LEFT JOIN dwrdim.dwr_dim_wbs_basis_info_f w
  ON f.wbs_top_level = w.wbs_top_level
  AND (w.delete_flag IS NULL OR w.delete_flag != 'X')
WHERE f.month = '2026-06'
GROUP BY f.wbs, w.project_type_desc, w.profit_center;
```

## 注意事项

- **dm 表只有 wbs_top_level**：`dm_fact_finance_cost_f` 仅有 `wbs_top_level`/`wbs_top_level_desc`，明细 WBS 在 `dwr_fin_cost_d_compre_subj_t` 中有 `wbs`/`wbs_desc`
- **WBS 层级不固定**：部分 WBS 只有顶层，没有 level1~3
- **结算比例**：`settlement_ratio` 用于费用分摊，同一 WBS 可能有多个分摊规则
- **WBS 类型影响科目归集**：不同类型的项目费用归入不同科目，验证查询时留意
