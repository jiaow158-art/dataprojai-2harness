# 销售组层级视图 — dwr_gl_sales_group_v

## 表概览

| 属性 | 值 |
|------|-----|
| Schema | `dwrfin` |
| 表名 | `dwr_gl_sales_group_v` |
| 类型 | **VIEW**（视图） |
| 列数 | 18 |
| 用途 | **部门/区域日报专用的销售组层级视图**，替代 `dm_rpt_sales_group_t` 在瓷砖事业部部门级报表中的组织映射 |
| 使用者 | `DM_RPT_CT_DEPARTMENT_SALES_PERFORMANCE_T`（脚本4）、`DM_RPT_REGION_PERFORMANCE_DAILY_REPORT_T`（脚本5） |

## 列定义

| 列名 | 类型 | 说明 |
|------|------|------|
| `sales_group` | varchar(30) | **销售组编码**（主关联键），对应 `dm_rpt_group_achievement_amb_t.sales_grp` |
| `sales_group_name` | varchar(200) | 销售组名称（如"广州组"、"深圳工程组"） |
| `utilities_dept` | varchar(80) | 事业部编码 |
| `utilities_dept_name` | varchar(1000) | 事业部名称 |
| `system` | varchar(80) | 系统编码（如 `22000001`=区域运营中心） |
| `system_name` | text | 系统名称 |
| `subcompany_big_area` | text | **子公司/大区编码**（如 `33000046`=工程市场中心, `33000030`=大包市场中心） |
| `subcompany_big_area_name` | text | **子公司/大区名称**（如"广佛运营中心"、"深圳子公司"） |
| `sales_dept` | varchar(40) | 销售部门编码 |
| `sales_dept_name` | varchar(200) | 销售部门名称 |
| `object_versions` | varchar(10) | 对象版本 |
| `update_flag` | varchar(10) | 更新标记 |
| `cost_control_field` | varchar(40) | 成本控制字段 |
| `sales_group_in_cost` | varchar(10) | 成本中的销售组 |
| `revenue_account` | varchar(40) | 收入科目 |
| `cost_account` | varchar(40) | 成本科目 |
| `accounting_unit` | varchar(10) | 核算单位 |
| `group_num` | varchar(80) | 组号 |

## 核心用途

### 1. 组织层级解析（替代 dm_rpt_sales_group_t）

部门/区域日报 ETL 中通过此视图获取 5 级组织层级：

```sql
-- 一级：硬编码 '国内营销系统'
-- 二级：由 system + subcompany_big_area 判定
CASE 
  WHEN system = '22000001' AND subcompany_big_area != '33000046' THEN '区域运营中心'
  WHEN subcompany_big_area = '33000046' THEN '工程市场中心'
  WHEN subcompany_big_area = '33000030' THEN '大包市场中心'
  ELSE system_name 
END AS 二级

-- 三级：subcompany_big_area_name（运营中心/子公司名）
-- 四级：由渠道+三级推导（如 '广佛运营中心零售营销部'）
-- 五级：sales_group_name（线组名，如 '广州组'）
```

### 2. 关联方式

```sql
-- 与部门业绩底表关联
FROM DM.DM_RPT_GROUP_ACHIEVEMENT_AMB_T a
JOIN dwrfin.dwr_gl_sales_group_v b ON a.sales_grp = b.sales_group
WHERE sales_group NOT LIKE 'R%'  -- 排除R开头销售组
```

## 与 dm_rpt_sales_group_t 的对比

| 维度 | `dwr_gl_sales_group_v` | `dm_rpt_sales_group_t` |
|------|------------------------|------------------------|
| 主键关联 | `sales_group`（如 `JG1`） | `node_name9`（如 `JG1`） |
| 层级模型 | system→子大区→销售部门→销售组 | node1~10（10级树） |
| 使用者 | 瓷砖部门/区域日报（仅瓷砖） | 全域通用（Mix表/业绩宽表/目标表） |
| 数据粒度 | 销售组级 | 组织节点级 |
| 类型 | VIEW | TABLE |

## 已知陷阱

1. **不是10级树**：该视图只有 5 级组织层级（系统→大区→运营中心→营销部→线组），与 `dm_rpt_sales_group_t` 的10级树是独立的组织维度
2. **仅用于瓷砖事业部**：`system IN ('22000001','22000004')` + 特定 `subcompany_big_area`
3. **排除特定销售组**：`sales_group NOT LIKE 'R%'`
4. **名称特殊处理**："大包市场部"→"大包市场中心"、"子公司"后缀去除、"嘉湖组"合并等
5. **视图可能变更**：作为 VIEW，底层表结构变更会直接影响此视图
