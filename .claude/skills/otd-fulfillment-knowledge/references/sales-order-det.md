# dm_otd_sales_order_det_t — 销售订单明细

## 概述

| 属性 | 值 |
|---|---|
| Schema | dm |
| 行数 | ~899万 |
| 粒度 | SAP 销售订单行（vbeln + posnr） |
| 刷新 | 全量 INSERT OVERWRITE（Hive → GaussDB） |
| ETL | PJob_DM_OTD_SALES_ORDER_DET_T.txt (1030行) |
| 数据源 | SDI_VBAK_1001, SDI_VBAP_1001, SDI_VBKD_1001, SDI_VBEP_1001, SDI_VBFA_1001, SDI_MARA_1001, SDI_KNA1_1001 |
| 订单类型 | ZA01/ZA02/ZA03/ZA06/ZA09/ZP01 |

## 列定义

### 主键/标识

| 列名 | 类型 | 说明 |
|---|---|---|
| vbeln | varchar(30) | 销售单号（SAP凭证号） |
| posnr | varchar(18) | 销售凭证项目（行号） |
| id_item | varchar(90) | OSS行ID（跨系统关联键） |

### 物料信息

| 列名 | 类型 | 说明 |
|---|---|---|
| matnr | varchar(120) | 物料编码 |
| material_name | varchar(256) | 物料名称（来自MAKT/MARA） |
| arktx | varchar(120) | 销售订单项目短文本 |
| dimension | varchar(160) | 规格（GROES，如 800X800） |
| meins | varchar(9) | 基本计量单位 |
| vrkme | varchar | 单位 |
| matkl | varchar(27) | 物料组 |
| mvgr1 | varchar(9) | 物料组1 |
| mvgr2 | varchar(9) | 物料组2 |
| extwg | varchar(54) | 外部物料组 |
| prdha | varchar(16) | 产品层次 |
| material_area | numeric | 面积（长×宽/1000000，或M2时为1） |
| length_1 | numeric | 长度（来自物料主数据） |
| width | numeric | 宽度（来自物料主数据） |

### 组织信息

| 列名 | 类型 | 说明 |
|---|---|---|
| vkorg | varchar(12) | 销售组织 |
| vtweg | varchar(6) | 分销渠道（SAP原始编码） |
| vkbur | varchar(12) | 销售办事处 |
| vkbur_txt | varchar(60) | 销售部门名称 |
| vkgrp | varchar(9) | 销售组（优先WBS覆盖） |
| spart | varchar(6) | 产品组 |
| bzirk | varchar(18) | 营销大区编码 |
| bzirk_txt | varchar(60) | 营销大区名称 |
| partment | varchar(128) | 部门（根据销售组层级推导） |

### 客户信息

| 列名 | 类型 | 说明 |
|---|---|---|
| kunnr | varchar(30) | 客户编码 |
| knkli | varchar(30) | 贷方限额参考客户 |
| cust_name | varchar(480) | 客户名称（KNA1.NAME1） |

### 渠道信息（ETL派生）

| 列名 | 类型 | 说明 |
|---|---|---|
| zh_channel_code1 | varchar(30) | 整合渠道1编码（GD01/GD02/GD03） |
| zh_channel_name1 | varchar(80) | 整合渠道1名称 |
| zh_channel_code2 | varchar(30) | 整合渠道2编码（GD04/GG01~GG08） |
| zh_channel_name2 | varchar(80) | 整合渠道2名称 |

**zh_channel_code1 判定**: vtweg='06'→GD03, vtweg='08'→GD02, 其他→GD01
**zh_channel_code2 判定**: 10类（见 metrics.md 三-渠道维度映射）

### 日期/时间

| 列名 | 类型 | 说明 |
|---|---|---|
| erdat | varchar(24) | 记录建立日期（YYYYMMDD） |
| audat | varchar(24) | 订单日期（YYYYMMDD） |
| bstdk | varchar | 客户需求交货日期（YYYYMMDD，多源回退） |
| last_bstdk | varchar | 整单最晚客户需求日期 |
| def_dl_date | varchar(24) | 默认交期 |
| confirm_date | varchar(24) | 确认日期 |
| first_confirm_date | varchar(24) | 首次确认数量日期 |
| max_confirm_date | varchar | 最晚留货时间 |
| thdat | varchar(24) | 最晚提货日期 |
| cnjq | varchar | 承诺交期 |
| prsdt | varchar | 采购订单日期 |

### 数量/金额

| 列名 | 类型 | 说明 |
|---|---|---|
| kwmeng | numeric | 订单数量 |
| kbmeng | numeric | 以销售单位表示的累计确认数量 |
| vmeng | numeric | 确认数量（计划行累计） |
| menge | numeric | 交货数量（提货单数量） |
| wqrsl | numeric | 订单未确认数量（max(0, kwmeng - max(vmeng, menge))） |
| mengef | numeric | 已出库数量（货物移动，排除602/653） |
| mengefh | numeric | 取消发货数量 |
| netpr | numeric | 销售净额 |
| netwr | numeric | 税额 |
| mwsbp | numeric | 以凭证货币计的税额 |
| zfdje | numeric | 预估返点金额（KURRF8~11合计） |
| zsyjf_percent | numeric | 使用积分百分比（来自条件价格表） |
| yj_unit_price | numeric | 预估单价（(mwsbp+netwr-zfdje)*(1-%) / kwmeng / material_area） |
| yj_amt | numeric | 预估金额（mwsbp + netwr - zfdje） |
| waerk | varchar | 凭证货币 |

### 面积（ETL计算）

| 列名 | 类型 | 说明 |
|---|---|---|
| qr_area | numeric | 确认面积 = vmeng × length_1 × width / 1000000 |
| jh_area | numeric | 交货面积 = menge × length_1 × width / 1000000 |
| wqr_area | numeric | 未确认面积 = wqrsl × length_1 × width / 1000000 |
| yck_area | numeric | 已出库面积 = mengef × length_1 × width / 1000000 |

### 状态/分类

| 列名 | 类型 | 说明 |
|---|---|---|
| pstyv | varchar(12) | 销售凭证项目类别 |
| abgru | varchar(6) | 拒绝原因编码 |
| abgru_txt | varchar(120) | 拒绝原因描述 |
| lfgsk | varchar(3) | 所有项目的总体交货状态 |
| is_xh | varchar(8) | 是否为现货（是/否，见 metrics.md 四） |
| sfzdjf | varchar(12) | 是否整单交付（Y/N） |
| submi | varchar(36) | 备货类型（现货/计划） |
| kz_date | integer | 控制天数（13条规则，见 metrics.md 五） |

### 订单类型/计划

| 列名 | 类型 | 说明 |
|---|---|---|
| auart | varchar(12) | 订单类型（ZA01~ZP01） |
| jhddlx | varchar(60) | 计划订单类型 |
| czjhdh | varchar(72) | 参照计划单号 |
| bstkd | varchar(105) | 客户参考 |
| ihrez | varchar(36) | 您的参考（备注） |
| bsark | varchar | 采购订单类型 |

### 工厂/库存

| 列名 | 类型 | 说明 |
|---|---|---|
| werks | varchar(12) | 工厂 |
| lgort | varchar(12) | 库存地点 |
| charg | varchar(30) | 批次 |

### WBS/工程

| 列名 | 类型 | 说明 |
|---|---|---|
| ps_psp_pnr | varchar(24) | WBS元素编码 |
| zcqmc | varchar(90) | 产区名称 |
| zcqbm | varchar(30) | 产区编码 |
| tsyqmx | varchar(150) | 特殊要求明细 |
| policy_name | varchar(1000) | 政策名称 |
| gc_type3 | varchar(100) | 工程分类（大货/补货/样板间），仅工程渠道有值 |
| business_opportunity | varchar(100) | 商机号 |

### 人员

| 列名 | 类型 | 说明 |
|---|---|---|
| ernam | varchar | 销售员工工号 |
| last_name | varchar(30) | OSS订单创建人 |
| sale_emp_name | varchar(160) | 销售员工名称 |
| salesman_num_list | varchar | 销售员工号列表（多人逗号分隔） |
| salesman_name_list | varchar | 销售员工姓名列表 |

### 订单组

| 列名 | 类型 | 说明 |
|---|---|---|
| order_group | varchar | 订单组编码 |
| order_group_name | varchar | 订单组名称 |

### 连锁/KA

| 列名 | 类型 | 说明 |
|---|---|---|
| is_chain | varchar | 是否连锁工程 |
| sjlx | varchar | 商机类型 |
| znka | varchar | KA类型 |
| znka_kunnr | varchar | KA客户 |
| znka_type | varchar | 客户产品类型 |
| znka_flag | varchar | KA标识 |

### 其他

| 列名 | 类型 | 说明 |
|---|---|---|
| volum | numeric | 体积 |
| order_progress_state_message | varchar(240) | 生产进度状态 |

## 常用查询模式

### 按日期查订单（必须带时间过滤）

```sql
SELECT vbeln, posnr, matnr, material_name, kwmeng,
       zh_channel_code1, zh_channel_name1, cust_name
FROM dm.dm_otd_sales_order_det_t
WHERE audat BETWEEN '20260501' AND '20260531'
  AND zh_channel_code1 = 'GD01'
LIMIT 200;
```

### 订单面积汇总（按渠道）

```sql
SELECT zh_channel_code1, zh_channel_name1,
       SUM(qr_area) as confirm_area,
       SUM(jh_area) as delivery_area,
       SUM(yck_area) as outbound_area
FROM dm.dm_otd_sales_order_det_t
WHERE audat BETWEEN '20260501' AND '20260531'
GROUP BY zh_channel_code1, zh_channel_name1
ORDER BY confirm_area DESC;
```

### 未确认订单行

```sql
SELECT vbeln, posnr, matnr, material_name, kwmeng, vmeng, wqrsl
FROM dm.dm_otd_sales_order_det_t
WHERE audat BETWEEN '20260501' AND '20260531'
  AND wqrsl > 0
ORDER BY wqrsl DESC
LIMIT 200;
```

## 已知陷阱

1. **audat 是 YYYYMMDD 字符串**，不是 date 类型。用 BETWEEN '20260501' AND '20260531'
2. **wqrsl > 0 不代表未交付**，仅代表未确认。未交付看 no_deliver_order_dtl
3. **mengef（已出库）排除602/653移动类型**（退货/冲销），实际出库量可能偏小
4. **预估单价为NULL时**说明 material_area=0（非面积计价的物料，如卫浴）
5. **zh_channel_code2 的 GD04（特惠品）在有些数据中可能映射不完整**
6. **组织筛选需JOIN dm_rpt_sales_group_t**，sales_order_det_t 自身没有 node_desc 字段
