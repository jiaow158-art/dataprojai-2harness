# 客户主数据

## 数据源

业绩域有两张客户维表，定位不同：

| 表 | Schema | 行数 | 唯一客户数 | 用途 |
|---|--------|------|-----------|------|
| `dm_dp_api_cust_general` | `dm` | 1,526 | 1,471 | **轻量 API 表**：客户名称 + 销售组织归属快速查找 |
| `dwr_dim_cust_sales_area_d` | `dwrdim` | 649,799 | 22,088 | **全量销售区域维表**：客户销售组/区域/客户分组等完整属性 |
| `dwr_dim_cust_general_d` | `dwrdim` | 205,582 | — | **客户基本信息**：地址、城市、省份、年销售额、客户分类等 |

- **更新频率**：每日（`dw_last_update_date`）
- **来源**：SAP SD 客户主数据 → `DWI_MD_CUST_SALES_AREA_T` / `DWI_MD_CUST_GENERAL_T` → DWRDIM

## 表选择决策

```
需要客户什么信息？
├── 只需要客户名称？
│   ├── 用的 Mix 表 → 直接用内置 cust_name，无需 JOIN
│   └── 用的业绩表(ct_sales_performance_t) → JOIN dm_dp_api_cust_general ON customer = cust_num
├── 需要客户分组/销售区域/销售组？
│   └── JOIN dwrdim.dwr_dim_cust_sales_area_d ON customer = CUST_NUM（注意去重，一个客户可能多区域）
└── 需要客户地址/省份/城市/年销售额？
    └── JOIN dwrdim.dwr_dim_cust_general_d ON customer = CUST_NUM
```

## 核心字段

### dm_dp_api_cust_general（轻量 API）

| 字段 | 说明 | 去重数 |
|------|------|--------|
| `cust_num` | 客户编码（关联键） | 1,471 |
| `cust_name` | 客户名称 | — |
| `sales_center_code` | 归属销售中心编码（↔ Mix 表 `node_name5`） | 10 |
| `sales_center` | 归属销售中心名称 | — |
| `sales_dep_code` | 归属销售部门编码 | 23 |
| `sales_dep` | 归属销售部门名称 | — |
| `sales_region_code` | 销售区域编码（**全为 NULL**） | 0 |
| `sales_region` | 销售区域名称（**全为 NULL**） | 0 |

**陷阱**：`sales_region_code` / `sales_region` 字段当前全为 NULL。同一 `cust_num` 可能有多条记录（不同销售中心归属），JOIN 时需注意去重。

### dwrdim.dwr_dim_cust_sales_area_d（销售区域全量）

| 字段 | 说明 | 去重数 |
|------|------|--------|
| `CUST_NUM` | 客户编码（关联键） | 22,088 |
| `SALES_ORG_CODE` / `SALES_ORG_NAME` | 销售组织（SAP 销售范围） | 69 |
| `SALES_GROUP_CODE` / `SALES_GROUP_NAME` | 销售组 | 899 |
| `SALE_REGION_CODE` / `SALE_REGION_NAME` | 销售区域 | 40 |
| `CUST_GROUP_CODE` / `CUST_GROUP_NAME` | 客户分组 | 44 |
| `BUSI_SECTION_NAME` | 业务板块（A00/A01/A02/A03） | 4 |
| `PRIMARY_SALES_DEPT_NAME` | 主销售部门 | — |
| `CUST_PRICE_GROUP_NAME` | 客户价格组 | — |
| `DISTRIBUTION_CHNL_CODE` / `DISTRIBUTION_CHNL_NAME` | 分销渠道 | — |

**陷阱**：一个客户可能有多条销售区域记录（不同销售组织/渠道下），JOIN 时会产生数据膨胀。需要按查询目的选择 DISTINCT 或按销售组织过滤。

### dwrdim.dwr_dim_cust_general_d（客户基本信息）

| 字段 | 说明 |
|------|------|
| `CUST_NUM` | 客户编码（关联键） |
| `CUST_NAME` | 客户名称 |
| `REGION_PROVINCE_NAME` | 省份 |
| `CITY_NAME` | 城市 |
| `ADDRESS_NAME` | 地址 |
| `CUST_CLASS_NAME` | 客户分类 |
| `CUST_ACCT_GROUP_NAME` | 客户账户组 |
| `CNTRY_REGION_CODE` | 国家地区代码 |
| `ANNUAL_SALES_AMT` | 年销售额 |

## 标准 JOIN 模式

### 模式 A：业绩表(ct_sales_performance_t) 查客户名称

```sql
SELECT p.customer,
       c.cust_name,
       SUM(p.month_achievement) as actual
FROM dm.ct_sales_performance_t p
LEFT JOIN dm.dm_dp_api_cust_general c
  ON p.customer = c.cust_num
WHERE p.calday = '20260531'
GROUP BY p.customer, c.cust_name
ORDER BY actual DESC
LIMIT 20;
```

**匹配率**：~48%（4,819/10,000+），部分客户未入 API 表。

### 模式 B：按客户分组汇总（Mix 表 + 销售区域维表）

```sql
SELECT c.CUST_GROUP_NAME,
       SUM(m.ambperformance) as actual
FROM dm.dm_fin_operations_mix_sum_t m
JOIN (SELECT DISTINCT CUST_NUM, CUST_GROUP_NAME
      FROM dwrdim.dwr_dim_cust_sales_area_d
      WHERE CUST_GROUP_NAME IS NOT NULL) c
  ON m.customer = c.CUST_NUM
WHERE m.calmonth = '2026-05'
  AND m.node_desc2 = '瓷砖事业部'
  AND m.data_source = 'S'
GROUP BY c.CUST_GROUP_NAME
ORDER BY actual DESC;
```

**⚠️ 必须用 DISTINCT 去重**：`dwr_dim_cust_sales_area_d` 一个客户有多条记录，直接 JOIN 会导致金额翻倍。

### 模式 C：Mix 表基本客户查询（无需 JOIN）

```sql
-- Mix 表已内置 cust_name，90% 场景不需要维表
SELECT customer, cust_name,
       SUM(ambperformance) as actual
FROM dm.dm_fin_operations_mix_sum_t
WHERE calmonth = '2026-05'
  AND node_desc2 = '瓷砖事业部'
  AND data_source = 'S'
GROUP BY customer, cust_name
ORDER BY actual DESC
LIMIT 20;
```

## 已知陷阱

1. **Mix 表不需要 JOIN 客户维表**：`customer` + `cust_name` 已内置，JOIN 维表反而带来去重成本和性能损失。
2. **销售区域维表 JOIN 必须去重**：`dwr_dim_cust_sales_area_d` 的粒度是客户×销售组织×渠道，同一 `CUST_NUM` 可能 10+ 条记录。先子查询 DISTINCT 再 JOIN。
3. **`dm_dp_api_cust_general` 匹配率 ~48%**：不是所有客户都在 API 表中。未匹配到的客户只能用编码显示。
4. **`sales_region_code` 全为 NULL**：API 表的区域字段未填充，需要区域信息用 `dwr_dim_cust_sales_area_d.SALE_REGION_NAME`。
5. **同一 `cust_num` 可能多条**：API 表按 `cust_num + sales_center_code` 复合键，一个客户可能归属多个销售中心。
6. **客户编码格式一致**：Mix 表 `customer` = 业绩表 `customer` = 维表 `CUST_NUM`，都是 10 位数字字符串（如 `0000315928`、`1000015465`）。
