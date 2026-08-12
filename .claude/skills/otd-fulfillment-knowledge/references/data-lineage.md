# OTD 履约数据血缘

## 数据流向总览

```
SAP 源系统
  ├── SD (销售分销) — VBAK/VBAP/VBKD/VBEP/VBFA (销售订单全链路)
  ├── OSS 系统 — SDI_SALE_ORDER_1007/SDI_SALE_ORDER_DTL_1007 (计划订单)
  ├── WM (仓库管理) — 库存移动凭证
  └── TMS (运输管理) — 发运/签收
    ↓
SDI 层 (源系统镜像)
  ├── SDI_VBAK_1001 / SDI_VBAP_1001 — 销售订单头/行
  ├── SDI_VBKD_1001 — 销售订单业务数据（交期等）
  ├── SDI_VBEP_1001 — 销售订单计划行（确认日期/数量）
  ├── SDI_VBFA_1001 — 销售订单凭证流（交货/出库/取消）
  ├── SDI_SALE_ORDER_1007 / SDI_SALE_ORDER_DTL_1007 — OSS计划订单
  └── SDI_ITEM_1007 / SDI_CSM_CUSTOMER_1007 — OSS物料/客户
    ↓
DWI/DWR 层
  ├── DWIOTD.DWI_WM_PRODSTOCK_OUT_IN_T — 库存移动明细
  ├── DWRDIM.DWR_DIM_PRODUCT_AREA_D — 产区维度（批次→产区映射）
  ├── DWROTD.DWR_OTD_SO_SALE_OFR_ORDER_F — 销售订单DWR版
  ├── DWROTD.DWR_OTD_SO_REMAIN_GOODS_T — 留货单
  ├── DWROTD.DWR_OTD_PLAN_ORDER_APPROVAL_F — 计划订单审批
  ├── DWROTD.DWR_TM_RESERVATION_RECORD_DETAIL_F — TMS预约记录
  ├── DWROTD.DWR_TRA_TMS_SHIP_DTL_F — TMS发运明细
  ├── DWROTD.DWR_PS_SALE_ORDER_DTL_F — 生产订单明细
  ├── DWROTD.DWR_PAM_GENE_BOARD_INFO_T — 样板信息
  ├── DWRPI.DWR_WF_CSTM_PROD_NODE_F — 生产节点（对版耗时）
  └── DWROTD.DWR_WM_PRODSTOCK_OUT_IN_F — 出库凭证
    ↓
DM 层
  ├── DM.DM_OTD_SALES_ORDER_DET_T (订单底表, 899万行)
  │     ← SDI_VBAK_1001 + SDI_VBAP_1001 + SDI_VBKD_1001 + SDI_VBEP_1001 + SDI_VBFA_1001
  │     ← SDI_MARA_1001 (物料主数据, 含排产周期)
  │     ← SDI_KNA1_1001 (客户名称)
  │     ← DWR_SO_SAL_PARTNER_SAP_F (销售员工)
  │     ← DWI_MD_DATA_MATERIAL_GENERAL_T (物料长/宽/面积)
  │
  ├── DM.DM_OTD_SO_ORDER_NOT_USER_T (履约跟踪, 794万行)
  │     ← DWR_OTD_SO_SALE_OFR_ORDER_F (销售订单)
  │     ← DWR_OTD_PLAN_ORDER_APPROVAL_F (计划订单审批 → 需求交期)
  │     ← DWR_OTD_SO_REMAIN_GOODS_T (留货单)
  │     ← DWR_WM_LADINGBILL_ITEM_F (提货单 → 备货数量)
  │     ← DWR_TRA_TMS_SHIP_DTL_F (TMS发运 → 发运数量/状态)
  │     ← DWR_TRA_RCPT_ORDER_F (签收单 → 签收状态)
  │     ← DWR_PS_SALE_ORDER_DTL_F (生产订单 → 预计交付/进度)
  │     ← DWR_WF_CSTM_PROD_NODE_F (生产节点 → 对版耗时)
  │     ← DWR_PAM_GENE_BOARD_INFO_T (样板信息)
  │     ← DWR_WM_PRODSTOCK_OUT_IN_F (出库数量)
  │
  ├── DM.DM_OTD_NO_DELIVER_ORDER_DTL (未交付明细, 1854行)
  │     ← SDI_SALE_ORDER_DTL_1007 (OSS订单明细)
  │     ← SDI_SALE_ORDER_1007 (OSS订单头)
  │     ← SDI_ITEM_1007 (OSS物料)
  │     ← SDI_CSM_CUSTOMER_1007 (OSS客户)
  │     ← DM_RPT_SALE_GRP_T (组织层级)
  │
  └── DM.DM_OTD_AREA_DELIVERY_DETAIL_M (产区交付汇总, 662万行)
        ← DWI_WM_PRODSTOCK_OUT_IN_T (库存移动)
        ← DWI_MD_DATA_MATERIAL_GENERAL_T (物料长/宽)
        ← DWR_DIM_PRODUCT_AREA_D (批次→产区)
        ← DWR_DIM_CUST_GENERAL_D (客户省份)
        ← DM_LTC_ORDER_PLAN_STOCKUP_T (备货→销售订单关联)
        ← DM_LTC_ORDER_PLAN_SIGN_T (签收→收货省份)
```

## 表关联关系

### 最常用 JOIN 链路

```
DM_OTD_SALES_ORDER_DET_T (订单底表, 90%场景的起点)
  ├── kunnr → DWRDIM.DWR_DIM_CUST_GENERAL_D.cust_num (客户名称/省份)
  ├── matnr → DWIMD.DWI_MD_DATA_MATERIAL_GENERAL_T.material_num (物料长/宽/面积)
  ├── vkgrp → DM.DM_RPT_SALES_GROUP_T (销售组织层级)
  ├── zh_channel_code1/2 → UPLOAD.UPLOAD_BUSINESS_ANALYSIS_CHANNEL_T (渠道中文名)
  └── ps_psp_pnr → DM.DM_OTD_WBS_PLAN_ORDER_DET_T.pspnr (WBS信息)

DM_OTD_SO_ORDER_NOT_USER_T (履约跟踪)
  ├── sap_order_num / sap_item_num → DM_OTD_SALES_ORDER_DET_T.vbeln / posnr
  │   (订单详情补充)
  └── customer_code → DWRDIM.DWR_DIM_CUST_GENERAL_D.cust_num (客户信息)

DM_OTD_NO_DELIVER_ORDER_DTL (未交付)
  └── order_num / order_item_num → DM_OTD_SALES_ORDER_DET_T.vbeln / posnr

DM_OTD_AREA_DELIVERY_DETAIL_M (交付汇总)
  ├── sale_order_num / sale_order_item_num → DM_OTD_SALES_ORDER_DET_T.vbeln / posnr
  └── 独立月表，按 stat_month 过滤
```

## 跨域关联

| 分析场景 | 关联路径 |
|---|---|
| OTD → 业绩 | vbeln → Mix表（待验证关联键） |
| OTD → 物料 | matnr → DWIMD.DWI_MD_DATA_MATERIAL_GENERAL_T |
| OTD → 客户 | kunnr / customer_code → DWRDIM.DWR_DIM_CUST_GENERAL_D |
| OTD → 组织 | vkgrp → DM.DM_RPT_SALES_GROUP_T.sale_grp |
| OTD → WBS | ps_psp_pnr → DM.DM_OTD_WBS_PLAN_ORDER_DET_T.pspnr |

## ETL 注意事项

1. **sales_order_det_t**: 全量刷新（INSERT OVERWRITE），Hive→GaussDB 同步
2. **so_order_not_user_t**: 全量刷新（INSERT OVERWRITE），GaussDB 内 ETL
3. **no_deliver_order_dtl**: 全量刷新，OSS系统→Hive→GaussDB
4. **area_delivery_detail_m**: 全量刷新，仅瓷砖事业部+瓷砖物料组硬编码
5. **时间格式链**: SAP(YYYYMMDD字符串) → DWR(timestamp) → DM(混合)
6. **渠道三套体系**: (a) zh_channel_code1 (一级整合), (b) zh_channel_code2 (二级整合), (c) vtweg (SAP原始)
7. **订单类型限定**: sales_order_det_t 仅含 ZA01/ZA02/ZA03/ZA06/ZA09/ZP01 六种订单类型
8. **产区映射**: 批次号前2~3位 → 产区（如 '123' → 广东基地）
9. **TMS预约过滤**: 排除 CANCELED 和 EXIT 状态的预约单
10. **备货类型(submi)**: 现货/计划，影响is_xh和控制天数计算
