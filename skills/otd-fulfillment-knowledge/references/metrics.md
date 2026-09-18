# OTD 履约域 — 语义层

> **🔴 强制优先阅读。** 在查询任何 OTD 表之前必须先读本文档。

## 一、核心业务概念

OTD（Order-To-Delivery）履约域覆盖从订单创建到客户签收的完整交付链路。

### 1.1 OTD 全链路状态机

```
订单创建(creation_time) → 提交(submission_time) → 评审通过(approval_time)
  → 留货(holding: 待留货→已留货) → 提货申请 → 仓库接单
  → 出库(outbound: 待出库→已出库) → 发运(shipping: 待发运→已发运)
  → 签收(receiving: 待签收→已签收)
```

### 1.2 关键业务指标

| 业务概念 | 字段/计算方式 | 所属表 | 备注 |
|---|---|---|---|
| 订单数量 | `kwmeng` | sales_order_det_t | 订单行原始下单数 |
| 确认数量 | `vmeng` | sales_order_det_t | 累计确认可交付数量 |
| 交货数量 | `menge` | sales_order_det_t | 提货单（交货单）数量 |
| 已出库数量 | `mengef` | sales_order_det_t | 货物移动出库数量 |
| 未确认数量 | `wqrsl` | sales_order_det_t | 订单数 - max(确认数,交货数) |
| 未交付数量 | `nodeliver_qty_aps` | no_deliver_order_dtl | OSS实际净需求数 |
| 未交付面积 | `nodeliver_area_aps` | no_deliver_order_dtl | 未交付数量 × 单位面积 |
| 已出库数量(产区) | `sales_stock_out_qty` | area_delivery_detail_m | 按产区+收货省汇总 |
| 已出库面积(产区) | `sales_stock_out_area` | area_delivery_detail_m | 出库数量 × 长 × 宽 / 1000000 |
| 确认面积 | `qr_area` | sales_order_det_t | 确认数量 × 长 × 宽 / 1000000 |
| 交货面积 | `jh_area` | sales_order_det_t | 交货数量 × 长 × 宽 / 1000000 |
| 未确认面积 | `wqr_area` | sales_order_det_t | 未确认数量 × 长 × 宽 / 1000000 |
| 已出库面积 | `yck_area` | sales_order_det_t | 出库数量 × 长 × 宽 / 1000000 |
| 开单耗时 | `billing_time` | so_order_not_user_t | 提交时间 - 创建时间 |
| 评审耗时 | `evaluation_time` | so_order_not_user_t | 评审通过 - 提交时间 |
| 留货耗时 | `holding_duration` | so_order_not_user_t | 留货时间 - 评审通过时间 |
| 留货天数 | `holding_days` | so_order_not_user_t | 留货至今的自然日数 |
| 总对版时长 | `total_proofing_time` | so_order_not_user_t | 06A节点 - 01A节点 |
| 控制天数 | `kz_date` | sales_order_det_t | 订单控制/预警天数（整型，13条规则） |

## 二、表选择决策树

```
问题涉及什么？

├── 订单基础信息（数量/金额/交期/物料/客户/渠道）
│   → dm_otd_sales_order_det_t (899万行)
│   关键字段: vbeln(销售单号), posnr(行号), kwmeng(订单数量),
│            netwr(税额), audat(订单日期), bstdk(客户交期),
│            zh_channel_code1/2(整合渠道)
│   大表！必须带 erdat 或 audat 时间范围过滤
│
├── 订单履约进度（各环节状态/耗时）
│   → dm_otd_so_order_not_user_t (794万行)
│   关键字段: order_num, row_status(行状态),
│           holding_status/warehouse_order_status/outbound_status/
│           shipping_status/receiving_status (各环节状态),
│           billing_time/evaluation_time/holding_duration(耗时)
│   大表！必须带 creation_time 范围过滤
│   关联底表: JOIN dm_otd_sales_order_det_t ON sap_order_num = vbeln
│
├── 未交付订单（哪些订单还没交、欠多少）
│   → dm_otd_no_deliver_order_dtl (1854行，仅未交付)
│   关键字段: nodeliver_qty_aps, nodeliver_area_aps,
│           expect_date(客户交期), order_time(下单时间)
│   小表，可全表扫描。已排除零售订单
│
├── 产区交付统计（哪个产区出了多少货、发到哪里）
│   → dm_otd_area_delivery_detail_m (662万行)
│   关键字段: stat_month, belong_area_name(产区),
│           receiving_province(收货省), sales_stock_out_qty/area(出库量/面积)
│   仅瓷砖事业部！月粒度。按 stat_month 过滤
│
└── 全链路综合分析（订单→交付端到端）
    → sales_order_det_t + so_order_not_user_t 双表 JOIN
    关联键: sap_order_num = vbeln AND sap_item_num = posnr
```

## 三、渠道维度映射

### 整合渠道1（zh_channel_code1）— 一级渠道

| 编码 | 名称 | ETL判定规则 |
|---|---|---|
| GD01 | 大零售渠道 | vtweg ≠ '06' AND vtweg ≠ '08' |
| GD02 | 整装头部 | vtweg = '08' |
| GD03 | 工程渠道 | vtweg = '06' |

来源：`dm_otd_sales_order_det_t` ETL (t9 CTE, lines 833-836)

### 整合渠道2（zh_channel_code2）— 二级渠道

| 编码 | 名称 | ETL判定规则 |
|---|---|---|
| GD04 | 特惠品 | auart='ZA02' OR werks后2位='80' |
| GG01 | N品类产品(vtweg=08) | vtweg=08 AND (prdha不以1开头 OR prdha第4位=1016) |
| GG02 | 瓷砖产品(vtweg=08) | vtweg=08 AND 非N品类 |
| GG03 | 大包专供产品 | ZYL03='A9' |
| GG05 | 非设计师产品(工程) | vtweg=06 AND yl01≠'G105' |
| GG06 | 零售产品 | 默认（以上都不满足） |
| GG08 | 设计师专供产品 | yl01='G105' |

来源：`dm_otd_sales_order_det_t` ETL (t9 CTE, lines 842-853)

### 渠道维度表

- 整合渠道名称（中文）：`upload.upload_business_analysis_channel_t` (channel_code + channel_type='整合渠道1'/'整合渠道2')
- 新增维表（2026-05）：`dm.dm_dim_integrate_channel_d`

## 四、现货判断逻辑（is_xh）

`dm_otd_sales_order_det_t.is_xh` (是/否) 判定规则（ETL t5 CTE, lines 263-269）:

1. submi为空 OR (submi='现货' AND vbak_ihrez='零售销售订单') → 是
2. submi='现货' AND vbak_ihrez='零售计划订单' → 否
3. submi='计划' AND jhddlx为空 → 是
4. submi='现货' AND jhddlx≠'零售销售订单' AND 客户在ZCUSLIST2 → 否
5. 其他: submi='现货' → 是, 否则 → 否

## 五、控制天数逻辑（kz_date）

`dm_otd_sales_order_det_t.kz_date` (整数) 13条规则（ETL t6 CTE, lines 405-441），优先级从高到低:

| 优先级 | 条件 | 控制天数 |
|---|---|---|
| 1 | audat<'20260317' AND (vbeln like '112%' OR jhddlx为空) | 7 |
| 2 | audat>='20260317' AND (vbeln like '112%' OR jhddlx为空) AND vtweg='06' | 60 |
| 3 | audat>='20260317' AND jhddlx IN ('工程样板间销售订单','工程样板间订单') | 20 |
| 4 | audat>='20260317' AND vtweg='06' AND jhddlx='特惠品销售订单' | 60 |
| 5 | audat>='20260317' AND jhddlx='特惠品销售订单' | 7 |
| 6 | vtweg='06' AND (is_chain='是' OR sjlx IN 连锁类) | 120 |
| 7 | vtweg='06' | 60 |
| 8 | vbeln like '112%' OR jhddlx为空 | 7 |
| 9 | is_xh='否' AND jhddlx IN ('零售计划订单','门店装修计划订单') | 15 |
| 10 | is_xh='否' AND jhddlx IN (4种工程计划订单) | 60 |
| 11 | is_xh='是' AND jhddlx IN ('特惠品销售订单','零售销售订单') | 7 |
| 12 | is_xh='是' AND jhddlx IN (4种工程订单) | 60 |
| 13 | czjhdh有值 | 7 |

后续补充：is_xh='是' + 包销订单 → 90, is_xh='否' + vtweg='06' + 连锁 → 120, is_xh='否' + 零售/整装 → 15, is_xh='是' + 零售/整装 → 7, 工程批量/样板间 → 60

## 六、表关联关系

### 核心关联
```
dm_otd_sales_order_det_t (订单底表)
  │ vbeln = order_num / sap_order_num
  ├── dm_otd_so_order_not_user_t (履约跟踪)
  │     ON det.vbeln = track.sap_order_num AND det.posnr = track.sap_item_num
  │
  └── dm_otd_no_deliver_order_dtl (未交付)
        ON det.vbeln = nd.order_num AND det.posnr = nd.order_item_num
```

### 维度关联
- 客户名称：`kunnr` → `dwrdim.dwr_dim_cust_general_d.cust_num` (end_date='4712-12-31')
- 物料维度：`matnr` → `dwimd.dwi_md_data_material_general_t.material_num`
- 销售组织：`vkgrp` → `dm.dm_rpt_sale_grp_t` (通过 node 层级；关联键 `sale_grp = vkgrp`，组织名取 `lev2_name` 等 lev 列)
- WBS信息：`ps_psp_pnr` → `dm.dm_otd_wbs_plan_order_det_t.pspnr`
- 渠道名称：`zh_channel_code1/2` → `upload.upload_business_analysis_channel_t.channel_code`

## 七、已知陷阱

1. **两张同名销售组织维表勿混**（2026-09-18 DWS 实测）：本域用 `dm.dm_rpt_sale_grp_t`（关联键 `sale_grp` = det.`vkgrp`，lev2_name 等取组织名）；`dm.dm_rpt_sales_group_t` 是另一张 10 级树表（sales-performance 域用，关联键 `node_name10`），**没有 `sale_grp` 列**，本域 JOIN 它必错
2. **大表性能**: `sales_order_det_t` (899万) 和 `so_order_not_user_t` (794万) 必须带时间范围过滤，禁止全表扫描
3. **时间格式不一致**:
   - `sales_order_det_t.erdat/audat` 是 YYYYMMDD 字符串（如 '20260531'）
   - `so_order_not_user_t.creation_time` 是 timestamp 类型
   - `area_delivery_detail_m.stat_month` 是 YYYY-MM 字符串（如 '2026-05'）
4. **产区交付表仅瓷砖**: `area_delivery_detail_m` ETL硬编码 `lev2_name='瓷砖事业部'`，不能查卫浴
5. **未交付表排除零售**: `no_deliver_order_dtl` ETL硬编码 `ORDER_TYPE != '零售销售订单'`，零售未交付不在此表
6. **确认数量 vs 交货数量**: `wqrsl`（未确认数量）= kwmeng - max(vmeng, menge)，不是简单的减法
7. **已出库数量有两套口径**:
   - `sales_order_det_t.mengef`（SAP货物移动，排除602/653移动类型）
   - `area_delivery_detail_m.sales_stock_out_qty`（WM库存移动，仅601/602/643/644/653/654 + record_type='MDOC'）
8. **渠道编码需JOIN维表取中文名**，ETL中 channel_code1 名称来自 `SDI_BUSINESS_ANALYSIS_CHANNEL_1037`，GaussDB中对应 `upload.upload_business_analysis_channel_t`
9. **订单类型过滤**: `sales_order_det_t` ETL限定 `auart IN ('ZA01','ZA02','ZA03','ZA06','ZA09','ZP01')`
10. **so_order_not_user_t.is_sealing（是否封仓）字段恒为NULL** — ETL中第88行指定 `null as is_sealing`
11. **so_order_not_user_t.holding_warning（留货预警）字段恒为NULL** — ETL第77行
12. **no_deliver_order_dtl 是Hive外表同步** — ETL包含 `CREATE TABLE IF NOT EXISTS` DDL，可能与GaussDB实际结构有差异
13. **预估返点金额**: `zfdje` 是预估金额，含条件逻辑（KURRF8~KURRF11四个条件类型求和）
14. **单价计算因年份而异**: 2024年 ×(1-0.04), 2025年 ×(1-0.05), 其他年 ×(1+zsyjf_percent)
15. **签收数据覆盖率仅 4.5%，不可用作履约完成率**: 全表 794 万行中 receiving_status='已签收' 仅 35 万行（4.5%），95.1% 为'待签收'。TMS 签收数据集成不完整，大部分订单永远不会流转到已签收状态。评估履约完成度请使用 **outbound_status（出库率）** 或 **shipping_status（发运率 39.9%）** 替代。
15. **两表 JOIN 匹配率约 99%**: `so_order_not_user_t` LEFT JOIN `sales_order_det_t` 时有约 1% 行无法匹配（sap_number/sap_item_num 在 sales_order_det_t 中不存在对应 vbeln/posnr）。使用 INNER JOIN 会静默丢弃这些行。
16. **状态字段不严格级联**: ETL 不保证 OTD 状态顺序。已验证出现 `shipping_status='已发运' AND outbound_status IS NULL`（448/69733 ≈ 0.6%）和 `holding_status IS NULL`（388/69733 ≈ 0.6%）。分析时需考虑状态 NULL 和跳跃的情况。
