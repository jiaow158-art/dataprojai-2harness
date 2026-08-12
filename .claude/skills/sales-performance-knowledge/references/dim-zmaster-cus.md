# 客户主数据表 — dm_rpt_zmaster_cus_t

## 表概览

| 属性 | 值 |
|------|-----|
| Schema | `dm` |
| 表名 | `dm_rpt_zmaster_cus_t` |
| 列数 | 107 |
| 用途 | **SAP客户主数据宽表**，含客户基本信息、销售范围、合作伙伴功能、母客编、组织归属等 |
| 使用者 | `ct_sales_performance_t` ETL（脚本1）——用于母客编映射和渠道重映射 |

## 核心列（业绩域相关）

### 客户标识

| 列名 | 说明 |
|------|------|
| `ACCOUNT_NUMBER` | 客户编号 |
| `NAME` | 客户名称1 |
| `DESCRIPTION` | 客户名称2 |
| `PARENT_ACCNT_NUMBER` | **母客户编号**（关键！） |
| `PARTNER_CODE` | 业务伙伴的客户号 |
| `PARVW` | 合作伙伴功能（如 'AG' = 收货方） |

### 销售范围

| 列名 | 说明 |
|------|------|
| `SALES_ORGANIZATION_CODE` | 销售组织编码 |
| `SALES_ORGANIZATION` | 销售组织名称 |
| `SALES_CHANNEL_CODE` | 分销渠道编码 |
| `SALES_CHANNEL` | 分销渠道名称 |
| `SALES_GROUP_CODE` | 销售组编码 |
| `SALES_GROUP` | 销售组名称 |
| `SALES_DEPARTMENT_CODE` | 销售办事处编码 |
| `SALES_DEPARTMENT` | 销售办事处名称 |

### 客户分组

| 列名 | 说明 |
|------|------|
| `ACCNT_GROUP1CODE` ~ `ACCNT_GROUP5CODE` | 客户组1~5（含描述） |
| `ACCNT_GROUP6CODE/6` | 洁具组织体系 |
| `accnt_group8code/8` | 客户组8 |

### 客户属性

| 列名 | 说明 |
|------|------|
| `KUKLA` | 客户分类 |
| `BZIRK` | 销售地区 |
| `SALES_AREA` | 区名 |
| `shared_warehouse` | 共享仓客户 |
| `cust_mak_seg_code/name` | 客户市场细分 |
| `cust_qualification_code/name` | 客户资质 |
| `annual_sales_code/name` | 年销售额(万) |
| `store_attribute_code/name` | 门店属性 |

## 在业绩宽表 ETL 中的用法

### 1. 母客编映射（优先级最高）

```sql
-- PARVW='AG' (收货方) 客户 → 获取 PARENT_ACCNT_NUMBER
LEFT JOIN dm.dm_rpt_zmaster_cus_t zz
  ON a.customer = zz.ACCOUNT_NUMBER
  AND a.zsales_channel = zz.SALES_CHANNEL_CODE
  AND a.salesorg = zz.SALES_ORGANIZATION_CODE
  AND zz.PARVW = 'AG'

-- 母客编优先级（2025-12修改）:
-- 1. WBS映射客户 (tmp_wbs_sale_grp.cust_num)
-- 2. 经销母客编 (dm_rpt_zmaster_cus_t PARENT_ACCNT_NUMBER, PARVW='AG')
-- 3. 客户主档母客编 (dwr_dim_cust_sales_area_d2)
-- 4. 底表母客编 (原始 customer)
```

### 2. 渠道重映射

```sql
-- 当 zsales_channel 为空时，从客户主数据取 SALES_CHANNEL_CODE
LEFT JOIN dm.dm_rpt_zmaster_cus_t g
  ON a.customer = g.ACCOUNT_NUMBER
  AND a.salesorg = g.SALES_ORGANIZATION_CODE
  AND g.SALES_CHANNEL_CODE = '01'  -- 取渠道01的默认值
```

## 已知陷阱

1. **PARVW 过滤**：母客编查询必须带 `PARVW = 'AG'`（收货方），否则返回多行
2. **多行问题**：同一客户+销售组织可能有多个渠道记录，需指定 `SALES_CHANNEL_CODE`
3. **与 DWR_DIM_CUST_SALES_AREA_D2 的关系**：两者都有母客编，业绩宽表优先用 zmaster_cus（经销母客编），其次用 D2（客户主档母客编）
4. **列名是 SAP 风格**：大写+缩写（`PARVW`, `BZIRK`, `KUKLA`），与 DWR 层命名风格不同
5. **107列**：全表很宽，查询时只 SELECT 需要的列
