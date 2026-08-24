# 库存仓储数据血缘

## 数据流向总览

```
SAP 源系统
  ├── MM (物料管理) — MARA/MARC/MARD/MBEW/MSEG/MKPF/MATDOC
  ├── WM (仓库管理) — LQUA/LAGP/LIPS
  ├── SD (销售分销) — VBAK/VBAP/LIKP/LIPS
  ├── PP (生产计划) — AFKO/AFPO/RESB
  ├── QM (质量管理) — QALS/QAVE
  └── PUR (采购) — EKPO/EKES/EKKO
    ↓
SDI 层 (源系统镜像)
  ├── SDI_MATDOC_1001 — SAP物料凭证 (库存账龄用, 含 BWART 移动类型)
  ├── SDI_SW_INV_PROD_CATEGORY_T — 辅材分类
  ├── SDI_LOC_COMP_RELATE_1036 — 库存地点对照 (loc_flag 批次日期修正)
  ├── SDI_T001W_1001 / SDI_T001L_1001 — 工厂/库存地点主数据
  ├── SDI_BIC_HZWW010_1009 — 产区8级层级 (HIEID='IEOAELV1P2RKKPNTGNWL1Y2H5')
  └── SDI_PRPS_1001 / SDI_PROJ_1001 — WBS要素
    ↓
DWI 层 (数据整合 — 库存域 54 个脚本)
  ├── DWIOTD.DWI_WM_ALL_TYPE_STOCK_T ← SDI_ZCDSV_TOTALSTCK_1001 (全类型库存)
  │     + INNER JOIN 物料/工厂/公司/供应商主数据
  ├── DWIOTD.DWI_WM_PRODSTOCK_OUT_IN_T ← SAP MM (出入库明细)
  ├── DWIMD.DWI_MD_DATA_MATERIAL_GENERAL_T ← SAP MARA (物料主数据, group_num='800')
  ├── DWIMD.DWI_MD_DATA_MATERIAL_SALES_T ← SAP MVKE (物料销售视图)
  ├── DWIMD.DWI_MD_FACTORY_T ← SAP T001W (工厂)
  ├── DWIMD.DWI_MD_MATL_BATCH_INFO_T ← SAP MCHA (批次级 first_promote_date 等扩展信息)
  └── DWIMD.DWI_MD_MATL_INVENT_LOC_T ← SAP T001L (库存地点)
    ↓
UPLOAD 层 (手工/接口上传)
  ├── upload_in_transit_stock — 在途库存快照 (历史在途, 与计算值 FULL OUTER JOIN)
  ├── upload_wm_prod_stock_t — 产品库存
  ├── upload_safestock_material_cfg — 成品安全库存配置
  ├── upload_raw_material_safestock_cfg — 原材料安全库存配置
  ├── upload_wm_defective_product_stockout_plan — 残次品出库计划
  ├── upload_wm_stockout_target — 缺货目标
  ├── upload_rejects_definition_t — 残次品类型字典 (promote_reason_code→rejects_type)
  ├── upload_sw_inv_prod_category_t — 辅材分类 (2024-03-01 已被 SDI 版替代)
  └── upload_wm_sw_sap_prod_grp_t — 产品组映射
    ↓
DWR 层 (数据仓库 — 52 个脚本)
  ├── DWROTD.DWR_WM_ALL_TYPE_STOCK_F ← DWI_WM_ALL_TYPE_STOCK_T (INNER JOIN 主数据, DEL_FLAG='N')
  ├── DWROTD.DWR_WM_ALL_TYPE_STOCK_MONTH_T — 库存月事实 (库存月报/CXC 日报源)
  ├── DWROTD.DWR_WM_PRODSTOCK_OUT_IN_F ← DWI (出入库流水, 移动类型分类)
  ├── DWROTD.DWR_WM_LADINGBILL_ITEM_F — 装运单明细 (残次品/低周转的 SAP 销售订单头)
  ├── DWRPUR.DWR_PTP_PURCHASE_VCH_ITEM_F / HEADER_F — 采购凭证 (在途库存源)
  ├── DWRPUR.DWR_PTP_PURCHASE_RECEIPT_REL_V — 采购入库凭证 (在途库存源)
  ├── DWROTD.DWR_SO_ORG_EXT_OSS_F ← DWI_SO_ORG_EXT_OSS_T (OSS客户)
  └── DWROTD.DWR_WM_RTM_INVENTORY_CT_T_D — 瓷砖RTM库存
    ↓
DWRDIM 层 (维度主数据)
  ├── DWR_DIM_FACTORY_D — 工厂 (131 个)
  ├── DWR_DIM_MATERIAL_GENERAL_D — 物料主数据 (360万行, SCD Type 2)
  ├── DWR_DIM_MATL_INVENT_BATCH_NUM_D — 批次库存 (含财政年度)
  ├── DWR_DIM_MATL_INVENT_LOC_D — 库存地点 (含删除标志)
  ├── DWR_DIM_PROD_AREA_D — 产区 (8级层级, 同名父子取子节点)
  ├── DWR_DIM_WBS_BASIS_INFO_F — WBS要素 (三层平铺)
  └── DWR_DIM_COUNTRY_NAME_D — 国家/地区
    ↓
DM 层 (数据集市 — 19 张核心表)
  ├── dm.dm_fin_stock_detail_accage_t_2023 — **库存账龄明细** (1.44亿行, 183列, 详见下方)
  ├── dm.dm_fin_stock_detail_accage_t — 旧版账龄 (91列, 不建议使用)
  ├── dm.dm_fin_stock_detail_accage_others_t — 辅材账龄 (102列)
  ├── dm.dm_wm_all_type_stock_t — 全类型库存快照 (88列)
  ├── dm.dm_transit_inventory_t — 在途库存 (采购侧)
  ├── dm.dm_b1_transit_inventory_t — B1客户在途 (销售侧, 独立表)
  ├── dm.dm_rpt_wm_cxc_day_sum — **CXC日报** (DWS脚本已作废, Hive侧推入)
  ├── dm.dm_otd_wm_stock_stat_month_t — 库存统计月报 (105万行)
  ├── dm.dm_product_inout_stock_t — 产品出入库 (99万行)
  ├── dm.dm_otd_wm_stock_turnover_m — **库存周转率** (40行, 月级粒度)
  ├── dm.dm_safestock_all_stock / avil_stock / no_deliver — 安全库存三件套
  ├── dm.dm_dp_api_warehouse_stock — 仓库库存 API
  ├── dm.dm_dp_api_stockout_oudue — 缺货超期
  ├── dm.dm_wm_low_turnover_stockout_detail_t — 低周转出库明细
  ├── dm.dm_wm_defective_product_stockout_t — 残次品/特惠品出库
  ├── dm.dm_rpt_stock_age_month_ct — 库龄月报汇总
  └── dm.dm_rpt_sales_deliver_t — APS未发货 (安全库存 no_deliver 源)
    ↓
DWS 同步层 (Hive → GaussDB, 56 个脚本, 多为 DELETE+INSERT 增量)
    ↓
FineReport 报表 / 管理驾驶舱
```

## 核心表数据来源映射

### DM_FIN_STOCK_DETAIL_ACCAGE_T_2023 (库存账龄核心事实表)

```
DM.DM_FIN_STOCK_DETAIL_ACCAGE_T_2023 (1.44亿行, 183列, 粒度: 月×公司×工厂×库存地点×物料×批次)
  ← ETL架构: 5层CTE链 mat → stock1 → stock2 → stock3 → stock4 → stock5 → INSERT OVERWRITE PARTITION(calmonth)
  ← 核心数据源 (单源 + 8路LEFT JOIN):
    Hive ETL: huaweiclaude/DM/PJob_DM_FIN_STOCK_DETAIL_ACCAGE_T_2023.txt (~1290行)
    DWS 同步: huaweiclaude/DWS/DM/DM_INSERT/PJob_DWS_DM_FIN_STOCK_DETAIL_ACCAGE_T_2023.txt (~787行)

    1. dm.dm_rpt_zzt_kcmx_t t (主表, 库存明细, BWART物料移动聚合)
       ├── LEFT JOIN dwimd.dwi_md_data_material_general_t t1 (物料主数据, prod_property产品所有权)
       │     ON t.material = t1.material_num
       ├── LEFT JOIN dwimd.dwi_md_matl_batch_info_t g (物料批次主数据, shelf_end_date保质期/产区/外协供应商)
       │     ON t.material = g.material_num AND t.batch = g.batch_num
       ├── LEFT JOIN dm.dm_rpt_stock_place_t i (库位分类, 库存地点不为空分支)
       │     ON t.stor_loc = i.stock_place_name AND i.stock_place_flag = '库存地点不为空'
       ├── LEFT JOIN dm.dm_rpt_stock_place_t j (库位分类, 库存地点为空分支, 回退到工厂)
       │     ON t.plant = j.factory_code AND j.stock_place_flag = '库存地点为空'
       ├── LEFT JOIN sdi.sdi_sw_inv_prod_category_t k (分类/品类, 产品层次3映射)
       │     ON t.zprodh3 = k.prod_level3_code
       ├── LEFT JOIN dm.dm_rpt_bathroom_risk_inventory_list l (浴室柜风险清单, 清库存标识)
       │     ON t.calmonth = l.calmonth AND t.material = l.material_num
       │       AND (t.stor_loc = l.store_loc OR l.store_loc = 'all')
       ├── LEFT JOIN sdi.sdi_loc_comp_relate_1036 m (库存地点对照, loc_flag批次日期修正开关)
       │     ON t.stor_loc = m.loc_code
       │       AND substr(t.calmonth,1,4)||'-'||substr(t.calmonth,5,2) BETWEEN substr(m.stat_date,1,7) AND substr(m.end_date,1,7)
       └── LEFT JOIN mat (CTE中间表, 批次最早入库日期budat修正)
             ON t.material = mat.matnr AND t.batch = mat.charg AND t.stor_loc = mat.lgort
    2. mat CTE: sdi.sdi_matdoc_1001 (SAP物料凭证, 按物料+批次+库存地点取min(budat))
       WHERE BWART in ('101','911','913','701','Z01','511','982','991','309','131','531','411','561','653')
         AND (BSTTYP_SG <> 'K' OR (BSTTYP_SG = 'K' AND BWART in ('411','101','991')))
    3. stock2 LEFT JOIN dwifin.dwi_prc_ztamb_cost_t d (阿米巴内部结算价, 时间窗口匹配)
       ON t2.material = d2.matnr AND t2.zsyb_code = d2.zsyb_code
          AND t2.last_day_date BETWEEN d2.datef AND d2.dated
       → 去重: row_number over (matnr,datef,zsyb_code,zsyb order by werks asc, dated desc) = 1

  ← ETL关键逻辑:
    - bz_flag保质期标识: shelf_end_date <> '00000000' AND substr(plant,1,2) in ('7C','73','72') → 'Y'
    - zdate截至日期: 当月→昨天; 历史月→该月最后一天 (账龄计算基准)
    - time_diff时间差: (next_month_first_day - zmmm_o017_zbatch_date) 天数, '0'开头/空→999
    - batch_rk_date批次入库日期修正: 若 loc_flag=1 且 mat.budat非空 → 取mat.budat; 否则取zmmm_o017_zbatch_date
    - 库龄段位阈值 (有保质期Y): shelf_end_date<=calmonth→到期; [当月,+3月]→3个月内; >+3月→3个月外
    - 库龄段位阈值 (无保质期N, 按batch_rk_date): >=zdate-6月→6个月内; [zdate-12月,zdate-6月]→6-12月; [zdate-24月,zdate-12月]→1-2年; <=zdate-24月→2年以上
    - 自制/外协ziswx (25+行CASE): prod_property<>'B0001'走factory_type; prod_property='B0001'按zww010+zprodh2+plant+comp_code组合判定
      (0J→自制; 0E/YN→外协; 江西公司32+产品层次4开头→外协, 3开头→自制)
    - 7220工厂减值0.7: ybzq_bzdq_3_amt*0.7 + ybzq_bzdq_amt*1 (临期3月内70% + 到期100%)
    - 7C工厂分时切换: calmonth<202203→0.6; calmonth>=202203→0.7
    - 73工厂减值: ybzq_bzdq_3_amt*0.7 + ybzq_bzdq_amt*1
    - 无保质期减值阶梯: wbzq_6_amt*0 + wbzq_6_12_amt*0.1 + wbzq_12_24_amt*0.4 + wbzq_24_amt*0.7
    - zsyb_code事业部编码: prod_property → 01-10 (C0001→07, A0001→01, B0001→08, C0003→04, D0001→10)

  ← DWS同步 (PJob_DWS_DM_FIN_STOCK_DETAIL_ACCAGE_T_2023.txt):
    DELETE FROM ... WHERE calmonth BETWEEN ${PERIOD_ID_M1} AND ${PERIOD_ID_M2}
    + INSERT INTO ... (按月份分区增量同步, 非全量TRUNCATE)
```

### DM_RPT_WM_CXC_DAY_SUM (CXC 产销存日报)

```
DM.DM_RPT_WM_CXC_DAY_SUM (粒度: stat_date × 基地 × 品类 × 规格 × 渠道)
  ⚠️ 此 DWS 脚本已作废 (huaweiclaude/DWS/DM/DM_INSERT/PJob_DWS_DM_RPT_WM_CXC_DAY_SUM.txt line 5: "此脚本作废，此表的数据从HIVE推过来")
  ← 核心数据源 (6个CTE链):
    脚本: huaweiclaude/DWS/DM/DM_INSERT/PJob_DWS_DM_RPT_WM_CXC_DAY_SUM.txt (~125行, 仅作逻辑参考)

    1. DWIMD.DWI_MD_DATA_MATERIAL_GENERAL_T (物料主数据, 走 mat CTE)
       ├── 过滤: matl_group_code='1000010'
       │         AND external_matl_group_code IN ('10010','10080')
       │         AND product_level2_code LIKE '1%'
       │         AND product_level2_code NOT IN ('1011','1012','1013','1014','1016')
       │         AND matl_type_code='FERT' (仅成品)
       └── 派生: width * length_1/1000/1000 AS area (规格面积)
    2. DWROTD.DWR_WM_PRODSTOCK_OUT_IN_F (出入库流水, 走 stock_chg_det CTE)
       ├── 过滤: MOVE_TYPE IN ('601','602','643','644','653','654' [销售出库],
       │                          '101','102','911','912','913','914','131','132','531','532' [生产/采购入库])
       ├── 时间窗: date_trunc('year', PERIOD_ID_D) ≤ VOUCHER_POST_DATE < PERIOD_ID_D+1
       └── 借贷: DR_CR_ID='S_SHKZG' 决定正负号
    3. DWROTD.DWR_WM_ALL_TYPE_STOCK_MONTH_T (库存快照月表, 走 stock_det CTE, 3路 UNION)
       ├── '本月库存': month_date = date_trunc('month', PERIOD_ID_D) → YYYYMM
       ├── '月初库存': month_date = date_trunc('month', PERIOD_ID_D) - 1
       └── '年初库存': month_date = date_trunc('year', PERIOD_ID_D) - 1
    4. DWRDIM.DWR_DIM_PRODUCT_AREA_D (基地映射, 走 batch_area CTE)

  ← CTE 链: batch_area → mat → stock_chg_det → stock_chg_sum → stock_det → mid → 最终聚合
  ← 基地映射两级 fallback:
       优先: substr(batch_num,1,3) → batch_start (3位精确)
       回退: substr(batch_num,1,2) → batch_start (2位宽松)
       兜底: '广东产区' (默认值)
       特例: batch_start='0Y' → '华盛昌基地'; factory_type='外协' → 'OEM'
  ← 增量刷新: DELETE WHERE stat_date=PERIOD_ID_D 后 INSERT (按日覆盖)
  ← 度量拆分: year / month / day 三个时间窗的累加出库面积与入库面积

  ⚠️ 活跃替代脚本 (卫浴域): dm_sw.dm_sw_rpt_wm_cxc_day_sum
     脚本: huaweiclaude/DM/DM_SW/PJob_DWS_DM_SW_RPT_WM_CXC_DAY_SUM.txt (2025-09-02, 作者 DP_10004701)
     物料过滤更宽: matl_group_code IN ('3000010','4000010'), 新增 DZ 定制过滤: matl_group4_code='DZ'
```

### DM_WM_ALL_TYPE_STOCK_T (全类型库存)

```
DM.DM_WM_ALL_TYPE_STOCK_T (粒度: 物料 × 工厂 × 库存地点 × 批次)
  ← 核心数据源:
    DM.DM_WM_ALL_TYPE_STOCK_TMP (上游临时表, 由 Hive ETL 写入, _TMP 脚本未归档)
  ← 字段范围: 88列, 涵盖:
       库存维度 (material/factory_werks/inv_location/batch_num/cust/supplier/wbs)
       库存数量 (total/project/qc/frozen/reserve/prepar/available + 对应 _pro 前缀工艺库存)
       库存面积 (total/project/qc/frozen/reserve/prepar/available_area)
       物料属性 (matl_group1~5, product_level_code1~6, brand, dimension)
       业务属性 (product_channel, product_stage2, product_area, promote_reason, clearance_reason)
  ← 新增字段 (2022-03-15 创建, 2023-04-07 yangjunhua 增补):
       all_stock_quantity (总库存)
       other_stock_quantity (其他库存)
       long_wbs_element (长WBS元素)
  ← 刷新模式: 全量覆盖 — DELETE FROM 全表 + INSERT (无时间窗)
  ← 上游链路参考: DWROTD.DWR_WM_ALL_TYPE_STOCK_F ← DWIOTD.DWI_WM_ALL_TYPE_STOCK_T
     (脚本: huaweiclaude/DWR/OTD/WM/PJob_DWR_WM_ALL_TYPE_STOCK_F.txt)
```

### DM_TRANSIT_INVENTORY_T (在途库存 — 采购侧)

```
DM.DM_TRANSIT_INVENTORY_T (粒度: stat_month × material_num)
  ← 核心数据源 (FULL OUTER JOIN 双向合并):
    脚本: huaweiclaude/DWS/DM/DM_INSERT/PJob_DWS_DM_TRANSIT_INVENTORY_T.txt (~92行)

    ZT_PUR CTE — 在途采购单 (订单侧):
       DWRPUR.DWR_PTP_PURCHASE_VCH_ITEM_F A
       JOIN DWRPUR.DWR_PTP_PURCHASE_VCH_HEADER_F B
         ON A.purchase_voucher_num = B.purchase_voucher_num
       CROSS JOIN dm.dm_dim_date_d t (扩展到所有 month_id ≤ 当月)
       ├── 过滤: purchase_voucher_type IN ('NB','ZNB2','ZNB1')
       │         purchase_group IN ('A14','A15')
       │         factory_code IN ('3320','3603','3620','3820')
       │         material_num <> 'SNULL'
       │         purchase_vch_flag IS NULL
       │         supplier_or_creditor_num <> '0001001511'  -- 稳畅(内部供应商, 排除)
       │         po_currency_networth <> 0
       │         SUBSTR(record_create_date,1,6) ≤ t.month_id
       └── 度量: RETURN_ITEM_FLAG='X' → 取负 (退货冲销)

    ZT_BEL CTE — 入库物料凭证 (已收货侧):
       DWRPUR.DWR_PTP_PURCHASE_RECEIPT_REL_V A
       JOIN DWRPUR.DWR_PTP_PURCHASE_VCH_HEADER_F B
       CROSS JOIN dm.dm_dim_date_d t
       ├── 过滤条件同 ZT_PUR
       └── MOVE_TYPE 符号: 101/911/162/123 → +, 102/912/161/122 → -

    UPLOAD.UPLOAD_IN_TRANSIT_STOCK (人工上传历史在途)
       → FULL OUTER JOIN ZT (物料+月份) → ZT1 (双向合并历史与计算)

  ← 维度补充 (mat CTE):
    DWIMD.DWI_MD_DATA_MATERIAL_GENERAL_T b
    LEFT JOIN DWIMD.DWI_MD_DATA_MATERIAL_SALES_T c (取 matl_group2_code, MAX 聚合)
    LEFT JOIN UPLOAD.UPLOAD_WM_SW_SAP_PROD_GRP_T k (product_level3_code → prod_code3)
    └── 过滤: bath_category_name <> '配件'

  ← 风险标识: matl_group2_code = 'J10' → is_risk='X' (浴室柜风险品类)
  ← 在途数量公式: 在途数量 = 采购订单数量 − 入库数量 (ZT_PUR − ZT_BEL)
  ← 在途金额公式: (po_currency_networth − BASIC_CURRENCY_AMT) / 10000 (万元)
  ← 跨月窗口: CASE WHEN SUBSTR(CURRENT_DATE,9,2)='05' → 每月5号前重刷上月, 5号后重刷当月
```

### DM_WM_DEFECTIVE_PRODUCT_STOCKOUT_T (残次品/特惠品出库明细)

```
DM.DM_WM_DEFECTIVE_PRODUCT_STOCKOUT_T
  ← DWROTD.DWR_WM_PRODSTOCK_OUT_IN_F a (生产出入库事实, 主表)
    ├── INNER JOIN 物料过滤 CTE mat:
    │     DWIMD.DWI_MD_DATA_MATERIAL_GENERAL_T
    │     WHERE matl_group_code='1000010'
    │       AND external_matl_group_code IN ('10010','10030')   -- 瓷砖+薄板
    │       AND matl_type_code='FERT'                           -- 仅成品
    │     计算 product_area = width * length_1 / 1000 / 1000
    ├── LEFT JOIN dwrotd.dwr_wm_ladingbill_item_f C            -- 取 SAP销售订单头/行
    │       ON a.delivery_im = C.DELIVERY AND a.delivery_project = C.delivery_project
    ├── LEFT JOIN (聚合) dm.dm_ambv2_zzt_xssr_t D              -- 销售组来源(关键!)
    │       ON C.REFERENCE_BILL_NUM = D.DOC_NUMBER
    │       聚合: max(SALES_GRP) GROUP BY DOC_NUMBER
    ├── LEFT JOIN DM.DM_RPT_SALE_GRP_T T5                      -- 销售组→4/5/6级组织
    │       ON D.SALES_GRP = T5.SALE_GRP
    ├── LEFT JOIN DWIMD.DWI_MD_MATL_BATCH_INFO_T T             -- 批次级: 首促日期/促清原因
    │       ON a.MATERIAL_NUM = T.MATERIAL_NUM AND a.BATCH_NUM = T.BATCH_NUM
    └── LEFT JOIN UPLOAD.UPLOAD_REJECTS_DEFINITION_T C1        -- 残次品类型字典
            ON T.PROMOTE_REASON_CODE = C1.PROMOTION_REASON_CODE
  ← 关键过滤: VOUCHER_POST_DATE >= '2022-01-01'
              AND stat_month = ${PERIOD_ID_M}
              AND A.MOVE_TYPE IN ('601','602','653','654')     -- 仅销售出库
  ← 残次品判定 CASE:
       batch LIKE '%888888' OR '%999999' → 0 (虚拟批次不入表)
       factory_werks_code LIKE '%80'     → 1 (清仓小堆头专属仓)
       PROMOTION_REASON_CODE IS NOT NULL
         AND voucher_post_date >= T.FIRST_PROMOTE_DATE → 1
       ELSE 0
  ← REJECTS_TYPE 特殊映射:
       factory_werks_code LIKE '%80' AND clearance_reason_code='QC19'
         → '清仓小堆头' (覆盖字典)
       ELSE → C1.REJECTS_TYPE
  ← 增量: DELETE+INSERT by stat_month
  ← 历史修复: 2024-03-15 架构树编码问题(qyj)、2024-04-07 销售组空问题(qyj)
```

### DM_WM_LOW_TURNOVER_STOCKOUT_DETAIL_T (低周转+特惠品出库明细)

```
DM.DM_WM_LOW_TURNOVER_STOCKOUT_DETAIL_T
  ← 主表: dm.dm_wm_defective_product_stockout_t (复用, 特惠品分支)
  ← 来源 data_detail CTE (独立路径):
     SELECT ... FROM dwrotd.dwr_wm_prodstock_out_in_f
       物料过滤放宽: 不限 external_matl_group_code
       JOIN dwimd.dwi_md_data_material_sales_t 取 matl_group2_code IN ('KM','ZY','JX','GM')
       渠道 distribution_channel_code='06'
  ← stock_type 6 个分类(关键):
     1. '特惠品'       ← dm_wm_defective_product_stockout_t
                         排除 rejects_type='超一年ABC'
                         排除 promote_reason_code IN ('AC98','AC97','AC96')
     2. '低周转'       ← batch_num 后6位 NOT IN ('888888','999999')
                         AND promote_reason_code IN ('AC91','AC92')
     3. '梦之家滚动库龄一年以上' ← external_matl_group_code='10080'
                                   AND batch_in_time < 当年1月1日
     4. 'DPI'          ← external_matl_group_code IN ('10020'~'10024')
                          AND batch_in_time < 当年1月1日
     5. 'ART+'         ← external_matl_group_code='10060'
                          AND batch_in_time < 当年1月1日
     6. '库龄半年以上订制品' ← matl_group2_code IN ('KM','ZY','JX','GM')
                              AND material_num LIKE '%A'
                              AND batch_in_time 在[当前-12月, 当前-5月]区间
  ← 业绩金额: JOIN dm.dm_ambv2_zzt_xssr_t D2 (data_source='S')
       ON sap_so_header_no=DOC_NUMBER AND sap_so_line_no=s_ord_item
       HAVING sum(zxssl) <> 0
       unit_price = sum(ambperformance) / sum(zxssl)
       amt = quantity * unit_price
  ← 销区名称特殊: lev4_code='H04230600' 且 lev6_name LIKE '%零售部%' → 取 lev7_name
  ← 增量: DELETE+INSERT by stat_month = ${PERIOD_ID_M}
```

### DM_OTD_WM_STOCK_STAT_MONTH_T (瓷砖库存月报, 105万行)

```
DM.DM_OTD_WM_STOCK_STAT_MONTH_T
  ← DWROTD.DWR_WM_ALL_TYPE_STOCK_MONTH_T t1 (库存月事实, 主表)
    ├── JOIN mat CTE: dwimd.dwi_md_data_material_general_t
    │     + dwimd.dwi_md_data_material_sales_t (matl_group1_code)
    │     WHERE matl_group_code='1000010'
    │       AND external_matl_group_code IN ('10010','10080')
    │       AND product_level2_code LIKE '1%'
    │       AND product_level2_code NOT IN ('1011','1012','1013','1014','1016')
    │       AND matl_type_code='FERT'
    ├── LEFT JOIN dwimd.dwi_md_matl_batch_info_t t4 (批次→入库时间/首促日期/清仓原因)
    ├── LEFT JOIN upload.upload_rejects_definition_t c1
    └── LEFT JOIN batch_area T5 (基于 batch_num 前3位/前2位 + factory_werks_code 推断基地)
  ← 粒度: month_date × prod_channel × cat × dimension × stock_age_seg × stock_type × factory × product_area × inv_location
  ← 库龄分段: 半年以内 / 7-12个月 / 1-2年 / 2年以上 (基于 BATCH_IN_TIME 与 month_date 差)
       特例: BATCH_IN_TIME 首字符='0' 或 NULL → '2年以上'
  ← stock_type 分类:
       '不良品'   ← goods_move_stock_type_sid IN ('01','02','07')
                    AND (虚拟批次/80仓/促销批次的复合判定)=1
                    AND REJECTS_TYPE NOT IN ('超一年ABC','超一年定制(战略保存部分)')
       '主菜单'   ← matl_group1_code IN ('A','B','C')
       '定制品'   ← else
  ← 基地映射(硬编码): 12%→山东, 13%→清远, 15%→江西, 16%→湖南, 17%→华盛昌, 18%→重庆, 19%→山西
  ← 增量: DELETE+INSERT WHERE month_date >= ${PERIOD_ID_M}
```

### DM_OTD_WM_STOCK_TURNOVER_M (瓷砖库存周转率, 40行)

```
DM.DM_OTD_WM_STOCK_TURNOVER_M
  ← t3 库存金额: dm.dm_fin_stock_detail_accage_t_2023
       WHERE zdpsyb IN ('11000001','11000003')  -- 瓷砖事业部2个二级行政
         AND matl_type='FERT'
         GROUP BY calmonth, SUM(zsjkcje)
  ← t4 销售成本: dm.dm_ambv2_profit_t
       WHERE sales_division_1n_code IN ('11000001','11000003')
         AND data_source IN ('D','S','T')
       销售成本 = 物流剔除调整 + 1+N成本 + 对外销售实际成本
                  + 跨事业部成本 + 部门内部成本 + 主营业务成本(制造+安装费)
       物流剔除: bus_area IN ('F000','E000','J000','H000','I000') → 不计入
  ← t5: 近3天所属月份新算 + 历史月份定版保留 (UNION)
  ← t6: 窗口函数聚合
       stock_amt_last13m    = SUM OVER (12 PRECEDING + CURRENT)  -- 13个月库存和
       sales_cost_last12m   = SUM OVER (11 PRECEDING + CURRENT)  -- 12个月销售成本和
  ← 周转率公式: turnover_times = sales_cost_last12m / (stock_amt_last13m / 13)
       即: 年化销售成本 / 月均库存金额
  ← 为什么只有 40 行: 每月只产出1行(全集团瓷砖), 数据从 2022-XX 至今 ≈ 40 个月度
  ← 增量: DELETE WHERE stat_month >= 近3天所属月 + INSERT
  ← 2026-04-17 改造: 库存源从 dm_wm_all_type_stock_month_t 改为 dm_fin_stock_detail_accage_t_2023
```

### SAFESTOCK 三件套 (安全库存)

```
DM.DM_SAFESTOCK_ALL_STOCK (全量库存按品类/规格/产区聚合)
  ← dm.dm_wm_all_type_stock_t t
    JOIN dwimd.dwi_md_data_material_general_t (物料过滤: 1000010+10010/10080+FERT)
    LEFT JOIN batch_prod_area CTE: dwrdim.dwr_dim_product_area_d
       按 batch_start(前3位/前2位) 聚合 → GD/SD/SX/HN/JX/XN → 华南/华北/...
  ← 粒度: product_level2_name × dimension × prod_area
  ← 度量: all_stock_quantity, all_stock_area (=qty * unit_area)
  ← 全量刷新: DELETE ALL + INSERT (无月份键)

DM.DM_SAFESTOCK_AVIL_STOCK (可分配库存按物料/产区聚合)
  ← dm.dm_wm_all_type_stock_t
    LEFT JOIN batch_prod_area (同上)
  ← 关键过滤(扣除非可用部分):
       inv_location NOT IN ('BC','GFZ','7F21')
       inv_location NOT LIKE '00%'
       factory_werks_code NOT LIKE '%80'      -- 排除清仓小堆头
       batch_num NOT LIKE '%7' AND NOT LIKE '%9'
  ← 粒度: material_num × prod_area
  ← 度量: available_inventory_quantity
  ← 全量刷新

DM.DM_SAFESTOCK_NO_DELIVER (未发货数量按物料/产区)
  ← dm.dm_rpt_sales_deliver_t
       WHERE nodeliver_qty_aps > 0
         AND stat_month = ${PERIOD_ID_M}
  ← 粒度: material_num × product_area
  ← 度量: SUM(nodeliver_qty_aps)
  ← 注释中保留旧逻辑: 来自 DWROTD.DWR_PS_SALE_ORDER_DTL_F (INV_ORG_ID=1 等过滤) 已废弃
  ← 增量: DELETE ALL + INSERT by stat_month
```

## 表关联关系

### 库存分析最常用 JOIN 链路

```
dm_fin_stock_detail_accage_t_2023 (事实)
  ├── plant → dwrdim.dwr_dim_factory_d (工厂名称/属性)
  ├── material → dwimd.dwi_md_data_material_general_t (物料主数据)
  ├── stor_loc → dwrdim.dwr_dim_matl_invent_loc_d (库存地点)
  ├── batch → dwimd.dwi_md_matl_batch_info_t (批次扩展信息)
  ├── wbs_elemt → dwrdim.dwr_dim_wbs_basis_info_f (WBS 要素)
  └── matl_grp_1~5 ↔ zprodh1~5 (物料组与产品层次两套体系)

dm_wm_all_type_stock_t (全类型库存)
  ├── material_num → dwimd.dwi_md_data_material_general_t
  ├── factory_werks_code → dwrdim.dwr_dim_factory_d
  ├── inv_location → dwrdim.dwr_dim_matl_invent_loc_d
  └── batch_num → dwimd.dwi_md_matl_batch_info_t

dm_otd_wm_stock_stat_month_t (库存月报)
  ├── material_num → dwimd.dwi_md_data_material_general_t
  ├── batch_num → dwimd.dwi_md_matl_batch_info_t
  ├── factory_werks_code → batch_area CTE (硬编码基地映射)
  └── promote_reason_code → upload.upload_rejects_definition_t
```

### 跨域关联

| 分析场景 | 关联路径 |
|---|---|
| 库存 → 费用(成本中心) | plant → cost_center (通过 dwi_cost_center_main_t) |
| 库存 → 公司 | comp_code → dwrdim.dwr_dim_company_d |
| 库存 → 销售 | material → 销售订单 (通过 dwr_gl_sales_group_f) |
| 库存 → 采购 | material → 采购订单 (通过 dwr_procure_order_his_f) |
| 库存 → 资金 | 库存账龄 → dm_fin_stock_capital_cost_t (库存资金成本) |
| 库存 → 毛利 | material → dwrfin_cost_sales_gross_profit_d (按物料关联) |
| 库存 → 销售业绩 | material_num → dm_ambv2_zzt_xssr_t (残次品出库金额/周转率) |
| 库存 → WBS | wbs_elemt → dwr_dim_wbs_basis_info_f (三层平铺) |

## 维度表速查

| 维度 | 表名 | Schema | 关联键 | 关键过滤 | 说明 |
|------|------|--------|--------|---------|------|
| 工厂 | DWR_DIM_FACTORY_D | dwrdim | factory_code / factory_id | group_num='800' | 131 个工厂，含采购组织/分销渠道/公司，无 SCD 字段 |
| 物料(通用) | DWR_DIM_MATERIAL_GENERAL_D | dwrdim | material_num / material_id | (源 DWI 已限集团) | 360万行, SCD: start_date/end_date; 宽度/长度算面积必备 |
| 批次 | DWR_DIM_MATL_INVENT_BATCH_NUM_D | dwrdim | material_num + batch_num + factory_code | del_flag (源 DWI) | 含 invent_loc_code, factory_id，无独立时间字段 |
| 库存地点 | DWR_DIM_MATL_INVENT_LOC_D | dwrdim | material_num + invent_loc_code + factory_code | del_flag (源 DWI) | 物料 × 工厂 × 库位 三键, 含 maintain_status |
| 产区 | DWR_DIM_PROD_AREA_D | dwrdim | prod_area_code / lvl1~8_prod_area_code | hieid='IEOAELV1P2RKKPNTGNWL1Y2H5' (硬编码) | 8级产区层级, 同名父子取子节点(RN=1), 含 batch_start |
| WBS | DWR_DIM_WBS_BASIS_INFO_F | dwrdim | wbs_level3 (主键) / wbs_level1 / wbs_top_level | sdi_prps_1001.up='00000000' (顶层) | 第三层为主键, 平铺首层/二层; 含销售组/经销商/资产号 |
| 销售组织 | DM_RPT_SALES_GROUP_T | dm | node_name9 → node_desc1~9 | data_source IN ('S','T','D') | 全域通用, 10级组织层级 |
| 销售组(残次品专用) | DM_RPT_SALE_GRP_T | dm | sale_grp → lev4/lev5/lev6_name | (无) | 9级, lev4='H04230600'+lev6 含'零售部'时取 lev7 |
| 销售订单项(阿米巴) | DM_AMBV2_ZZT_XSSR_T | dm | doc_number + s_ord_item | data_source IN ('S','D','T') | 残次品/低周转出库金额的业绩来源 |
| 残次品字典 | UPLOAD_REJECTS_DEFINITION_T | upload | promote_reason_code → rejects_type | (无) | AC05(战略保存)、AC91/AC92(低周转)、AC96/97/98 等 |
| 批次扩展信息 | DWI_MD_MATL_BATCH_INFO_T | dwimd | material_num + batch_num | (无) | first_promote_date / promote_reason_code / clearance_reason_code / batch_in_time |
| 物料销售视图 | DWI_MD_DATA_MATERIAL_SALES_T | dwimd | material_num (distribution_channel_code='06') | distribution_channel_code='06' | matl_group1_code(A/B/C=主菜单) + matl_group2_code(KM/ZY/JX/GM=订制品) |
| 库存月事实 | DWR_WM_ALL_TYPE_STOCK_MONTH_T | dwrotd | month_date + material_num + batch_num + inv_location + factory_werks_code | stock_qty <> 0 | 库存月报源表, goods_move_stock_type_sid IN(01,02,07) 为可售 |
| 库存地点对照 | SDI_LOC_COMP_RELATE_1036 | sdi | loc_code + 月份范围 | (无) | loc_flag 批次日期修正开关 (账龄表用) |
| 物料凭证 | SDI_MATDOC_1001 | sdi | matnr + charg + lgort + BWART | BWART IN ('101','911',...) | 批次最早入库日期budat (mat CTE) |
| 公司 | DWR_DIM_COMPANY_D | dwrdim | comp_code / company_code (end_date='4712-12-31') | end_date='4712-12-31' | 公司主数据 |

## ETL 注意事项

### DM_FIN_STOCK_DETAIL_ACCAGE_T_2023 (库存账龄)

1. **三套账龄表版本 (t / t_2023 / others_t) 的实质差异**：`dm_fin_stock_detail_accage_t` (旧版, 无 shelf_end_date 分支)、`dm_fin_stock_detail_accage_t_2023` (本表, 主用)、`dm_fin_stock_detail_accage_others_t` (辅材专用, zpcrk_fc 批次入库日期)。**为什么**：2023年改版引入保质期概念后逻辑裂化, 旧表保留向后兼容。**如何应用**：库存账龄分析永远查 `_t_2023`, 辅材查 `_others_t`, 不要混用。

2. **保质期工厂范围逐步扩大 (历史事件)**: 7C/73 → 72 → 7C/73/72。脚本 update history 显示 2023-05-09 (guzhengfeng) "增加 '72*' 工厂的有保质期产品判断", bz_flag CASE 中硬编码 `substr(plant,1,2) in ('7C','73','72')`。**为什么**：卫浴业务上线后临期产品管理范围分阶段推广。**如何应用**：跨期分析 2023-05 前后 72 工厂的保质期口径会跳变, 趋势分析需提示口径切换。

3. **7220工厂临期减值0.7的精确条件**: `plant in ('7220')` (全5位字符匹配, 不是 substr) → `ybzq_bzdq_3_amt * 0.7 + ybzq_bzdq_amt * 1`。2023-05-30 update: "7220工厂 (库存地点 TY/FC/QA/TA) 按临保质期三个月内的库存金额*0.7"。**为什么**：7220 是东鹏洁具特殊工厂, 单独的减值政策。**如何应用**：减值金额核对时, 7220 的数据需独立验证。

4. **7C工厂的 0.6/0.7 时间切换**: `calmonth < 202203` → 系数 0.6; `calmonth >= 202203` → 系数 0.7。**为什么**：2022年3月调整了 7C 工厂的减值政策。**如何应用**：跨 2022-03 的同比/环比减值金额对比有口径跳变。

5. **批次入库日期字段在不同时期含义不同**: `zmmm_o017_zbatch_date` (SAP 入库日期, 直接来源) vs `batch_rk_date` (阿米巴调整后批次入库日期, 经 `loc_flag=1 AND mat.budat IS NOT NULL` 修正) vs `zpcrk_fc` (辅材专用批次入库日期, 仅 `_others_t` 用)。**为什么**：阿米巴考核口径与 SAP 财务口径存在差异, 部分库存地点需用 SDI 物料凭证最早过账日修正。**如何应用**：账龄金额 (wbzq_*_aging) 用 `batch_rk_date` 计算, 自然账龄 (zrzlcp_*) 用 `zmmm_o017_zbatch_date` — 两个口径在同张表共存。

6. **自制/外协判定 (ziswx) 25+行CASE WHEN**: 复杂嵌套, 分支维度包括 `prod_property` (B0001 走产区逻辑 vs 其他走 factory_type)、`zww010` 产区编码、`zprodh2` 产品层次2、`plant` 工厂前2位、`comp_code` 公司前2位。**为什么**：SAP 主数据不完整, 需业务规则补齐。**如何应用**：自制/外协汇总用 `ziswx` 字段或 `product_base`/`foreign_own`; 个别边界 case 可能 fall through 到 ELSE, 数据稽核时需关注 NULL。

7. **2024-03-01 辅材改集团统一逻辑**: 原 `upload_sw_inv_prod_category_t` 外挂表替换为 `sdi.sdi_sw_inv_prod_category_t`。**为什么**：消除外挂数据延迟。**如何应用**：跨 2024-03 的辅材分类 (classify_name / category_name) 数据可能有重分类。

8. **阿米巴结算价字段变更 (2023-08-18 update)**: `stock_amt` = `nvl(d2.price1, 0) * nvl(t2.quantity, 0)`, 来自 `dwifin.dwi_prc_ztamb_cost_t`, 按 `matnr + zsyb_code + last_day_date∈[datef,dated]` 时间窗口匹配, `row_number` 按 `werks asc, dated desc` 取最新。**为什么**：阿米巴结算价按事业部+物料+时间区间, 同物料多工厂需去重。**如何应用**：库存账龄金额 (ybzq/wbzq_*_aging) 是阿米巴口径, 与 zsjkcje (实际库存金额) 是两套口径; 资金成本分析用 stock_amt, 财务账面分析用 zsjkcje。

9. **2025-03-14 外协供应商字段新增**: 新增 `supplier_or_creditor_num` 字段, 来自 `dwi_md_matl_batch_info_t`, 同时产区/产区描述/生产基地逻辑优化 (2025-03-24 第二版)。**为什么**：外协产能扩大, 需供应商级追踪。**如何应用**：2025-03 前的外协供应商数据为空, 不能做长周期外协集中度分析。

10. **DWS同步为增量 (DELETE + INSERT)**: `DELETE FROM ... WHERE calmonth BETWEEN ${PERIOD_ID_M1} AND ${PERIOD_ID_M2}` 后 `INSERT INTO`。**为什么**：1.44亿行表全量重刷代价太大。**如何应用**：补刷历史月只需重跑该月分区; 但若维度主数据变更 (如物料批次 shelf_end_date 修正), 需重刷受影响月份。

11. **mat CTE 移动类型过滤陷阱**: `BWART in ('101','911','913','701','Z01','511','982','991','309','131','531','411','561','653')`, 且对采购订单类型 `BSTTYP_SG='K'` 只取 `('411','101','991')`。**为什么**：批次最早入库日需排除退货/转移等非入库凭证。**如何应用**：batch_rk_date 为空或异常时, 检查 SDI_MATDOC_1001 是否有未覆盖的 BWART。

12. **Hive 性能参数**: 脚本顶部设置 `hive.auto.convert.join` + `mapjoin.smalltable.filesize=100MB` + `tez.grouping.min/max-size=20MB`。**为什么**：1.44亿行主表 JOIN 小维度表需走 mapjoin 避免 shuffle。**如何应用**：在 DWS 上查询本表时, 对维度表 JOIN 也建议用 broadcast hint。

### DM_RPT_WM_CXC_DAY_SUM (CXC 日报)

1. **DWS 脚本头注明确标注"作废"** (`PJob_DWS_DM_RPT_WM_CXC_DAY_SUM.txt` line 5: "此脚本作废，此表的数据从HIVE推过来")。该脚本不会被执行, 但保留作为逻辑参考。**表数据由 Hive 推入, 字段口径以 Hive ETL 为准**。
2. **活跃替代脚本不同表不同 schema**: 卫浴域使用 `dm_sw.dm_sw_rpt_wm_cxc_day_sum` (`huaweiclaude/DM/DM_SW/PJob_DWS_DM_SW_RPT_WM_CXC_DAY_SUM.txt`, 2025-09-02), 物料过滤更宽 (`matl_group_code IN ('3000010','4000010')`), 新增 DZ 定制过滤 (`matl_group4_code='DZ'`)。**用户问"卫浴 CXC"必须切到 dm_sw 表**, 不能误用 dm 表。
3. **物料过滤严苛**: `matl_group_code='1000010'` (瓷砖) + `external_matl_group_code IN ('10010','10080')` + `product_level2_code LIKE '1%'` 且排除 1011/1012/1013/1014/1016 + `matl_type_code='FERT'` (仅产成品)。不满足此过滤的物料在 CXC 日报中**完全缺失**。
4. **基地映射两级 fallback + 默认值**: `batch_num` 前 3 位精确匹配 → 前 2 位宽松匹配 → 默认 '广东产区'。`batch_start='0Y'` 强制 '华盛昌基地'; `factory_type='外协'` 强制 'OEM'。**用户按基地拆分时若得到 '广东产区', 大概率是兜底而非真实基地**, 需追溯 `dwr_dim_product_area_d` 核对 batch_start。
5. **库存快照 3 路 UNION 来源同一张月表**: `dwr_wm_all_type_stock_month_t` 按 `month_date` 区分本月/月初/年初, 三路都走同一表。若该月表某月缺失, CXC 日报对应快照字段全部为空。

### DM_WM_ALL_TYPE_STOCK_T (全类型库存)

1. **DWS 脚本仅做透传**: `DELETE 全表 + INSERT ... SELECT * FROM DM_WM_ALL_TYPE_STOCK_TMP`, 实际字段加工逻辑全在 Hive 侧 `_TMP` 表的 ETL 中 (`huaweiclaude/` 目录内**找不到该 _TMP 脚本**), DWS 无法回答字段口径细节。
2. **`all_stock_quantity` 与 `other_stock_quantity` 来源不明**: 这两列在 DWS 脚本中只是 SELECT 透传, 注释指明 2022-03-15 创建, 2023-04-07 yangjunhua 增补。**口径由 Hive 上游定义**, 用户查询涉及这两列时必须显式提醒"该字段为上游透传, 需另查 Hive ETL"。
3. **上游链路可参考**: `DWROTD.DWR_WM_ALL_TYPE_STOCK_F` (DWR 层) ← `DWIOTD.DWI_WM_ALL_TYPE_STOCK_T` (DWI 层, INNER JOIN 物料/工厂/公司/供应商主数据), 该 DWR 脚本在 `huaweiclaude/DWR/OTD/WM/PJob_DWR_WM_ALL_TYPE_STOCK_F.txt`, 可作为字段血缘追溯起点。
4. **全量覆盖刷新**: 每次 `DELETE FROM dm.dm_wm_all_type_stock_t` (无 WHERE) 后 INSERT 全量, **无时间窗、无增量**, 单次失败会清空全表, 用户在 ETL 窗口期查询可能拿到空表, 需提醒检查 `dw_last_update_date`。
5. **字段命名含历史遗留**: `projectqc_*, profrozen_*, proreserve_*, pro prepar_*, available_pro*` 五组 "PRO" 前缀字段对应工艺库存, 与非 PRO 版本并存, **用户做"库存总量"核对时容易混淆 PRO 与非 PRO**, 必须显式确认口径。

### DM_TRANSIT_INVENTORY_T (在途库存 — 采购侧)

1. **`dm.dm_b1_transit_inventory_t` 是完全独立的表**: 位于 `huaweiclaude/DM/DM_SW/PJob_DWS_DM_B1_TRANSIT_INVENTORY_t.txt`, TRUNCATE 后从 `dm.dm_zasd_p001_q066v2_t` (B1 客户) 起算, 业务范围是 **B1 客户在途** (销售在途), 与本表 `dm.dm_transit_inventory_t` **(采购在途) 完全不同**。**用户问"在途库存"默认指 `dm.dm_transit_inventory_t` (采购侧), B1 在途需另查 `dm_b1_transit_inventory_t`**。
2. **FULL OUTER JOIN 双向合并含义**: `upload.upload_in_transit_stock` (人工上传历史) FULL OUTER JOIN 计算结果 `zt`。**`coalesce(a.transit_num, b.在途数量)` 优先取上传值**, 因此历史月份 (上传有数据) 与新计算月份 (zt 有数据) 共存时, 上传值会覆盖计算值。**用户查历史在途时若与采购凭证追溯结果不一致, 很可能是 upload 表覆盖**, 需核对 upload_in_transit_stock。
3. **预测/未来月份来自 `dm.dm_dim_date_d` CROSS JOIN**: ZT_PUR 与 ZT_BEL 均 `CROSS JOIN (SELECT month_id FROM dm.dm_dim_date_d WHERE month_id <= 当月)`, 即把每个采购单/入库单**扩展到从其创建月到当月的所有月份**, 实现"月份在途累计"。每月 5 号前重刷上月, 5 号后重刷当月, **跨月窗口边界需特别注意**。
4. **排除内部供应商稳畅 '0001001511'**: 注释明确 "稳畅属于内部", 是集团内部关联方, 在途数据需剔除以避免内部交易虚增。**用户按供应商拆分在途时, 稳畅数据缺失是正常**, 不是 ETL bug。
5. **采购单/采购组/工厂过滤固定值**: `purchase_voucher_type IN ('NB','ZNB2','ZNB1')` + `purchase_group IN ('A14','A15')` + `factory_code IN ('3320','3603','3620','3820')`。**这四个工厂之外的在途数据完全缺失**, 用户查非这四个工厂的在途时, 表中无数据是过滤导致而非真实为零。`po_currency_networth <> 0` 用于**排除数量为 0 但有金额的寄售订单**。
6. **风险物料标识**: `matl_group2_code='J10'` → `is_risk='X'`, 这是**浴室柜风险品类** (J10), 用户做风险在途分析可直接用此标识。

### DM_WM_DEFECTIVE_PRODUCT_STOCKOUT_T / LOW_TURNOVER_STOCKOUT_DETAIL_T (残次品/低周转)

1. **物料过滤双轨**: `DEFECTIVE_PRODUCT_STOCKOUT_T` 限定 `external_matl_group_code IN ('10010','10030')` (瓷砖+薄板); `LOW_TURNOVER_STOCKOUT_DETAIL_T` 不限定，覆盖更广。同一物料/批次/凭证号在两表可能重复，分析低周转时若需"非特惠品"要 `stock_type != '特惠品'` 排除。
2. **清仓小堆头硬编码**: `factory_werks_code LIKE '%80' AND clearance_reason_code='QC19'` → REJECTS_TYPE 强制覆盖为 `'清仓小堆头'`，绕过 `UPLOAD_REJECTS_DEFINITION_T` 字典。月报表 `STOCK_STAT_MONTH_T` 也复用此判定（`'80全算'`）。
3. **销售组来源走 `dm_ambv2_zzt_xssr_t`**: 不走 SDI 主数据。聚合方式 `max(SALES_GRP) GROUP BY DOC_NUMBER` (按销售订单头取)，2024-04-07 修复了销售组空值 bug。若 SALES_GRP 缺失，lev4/lev5/lev6 全部 NULL。
4. **2024-03/04 历史修复**: 2024-03-15 架构树编码问题（DM_RPT_SALE_GRP_T 的 lev* 编码变更）、2024-04-07 销售组空值修复。涉及此前的数据需重新回刷。
5. **低周转 stock_type 6 分类**: 特惠品/低周转(AC91/AC92)/梦之家滚动库龄一年以上/DPI/ART+/库龄半年以上订制品 — 用户按 stock_type 过滤时需明确类别名称。

### DM_OTD_WM_STOCK_STAT_MONTH_T / STOCK_TURNOVER_M (月报+周转率)

1. **月报粒度极细**: 9 个维度字段（月+渠道+品类+规格+库龄+类型+工厂+产区+库位），每行一个组合。105 万行 = 月份数 × 组合数。
2. **库龄计算时点**: `date_month_cz.months_between(last_day(month_date)+1, BATCH_IN_TIME)`，按"下月第一天" vs "入库日"算月差。BATCH_IN_TIME 首字符为 `'0'` 或 NULL 强制归入 `'2年以上'`（旧数据脏值兜底）。
3. **周转率仅 40 行原因**: 按月聚合 + 全集团瓷砖（不分事业部/工厂/品类），从 2022 年起累计约 40 个月。**不能按工厂/品类下钻**（粒度限制）。
4. **2026-04-17 库存源切换**: 周转率库存金额从 `dm_wm_all_type_stock_month_t` 切到 `dm_fin_stock_detail_accage_t_2023`，**历史月份保留定版** (`stat_month < 近3天月` 直接 SELECT 自身)，仅重刷近月。导致 2026-04 前后口径不完全一致。
5. **基地硬编码映射**: 月报中基地按 batch_num 前缀硬编码 (12%→山东, 13%→清远, 15%→江西, 16%→湖南, 17%→华盛昌, 18%→重庆, 19%→山西)，未匹配的基地为 NULL。

### SAFESTOCK 三件套 (安全库存)

1. **无月份键设计**: `ALL_STOCK` 和 `AVIL_STOCK` 是 `DELETE ALL + INSERT` 全表，**只反映"最新"快照**，无 stat_month 字段。`NO_DELIVER` 有 stat_month。三者关联做安全库存分析时，需自行加入"查询时点"。
2. **产区映射硬编码**: `GD/SD/SX/HN/JX/XN → 华南/华北/西北/华中/华东/西南` 在 CTE 内 `CASE` 硬编码，6 个值。批次前缀映射失败时 prod_area 为 NULL。
3. **可分配库存过滤**: AVIL_STOCK 排除 `inv_location IN ('BC','GFZ','7F21')` 或 `'00%'` 开头，以及 `factory_werks_code LIKE '%80'`（清仓小堆头），和 `batch_num LIKE '%7'/'%9'`（虚拟批次）。分析"实际可用"时这三类自动剔除。
4. **NO_DELIVER 数据源变更**: 2024 前用 `DWR_PS_SALE_ORDER_DTL_F`（按订单状态 IN(6-11) 算未发），2024-12 改为 `dm_rpt_sales_deliver_t`（预聚合表），口径从"销售订单未发"变为"APS 未发"。

### 通用维度表 ETL 注意事项

1. **全量刷新 + SCD Type 2 字段**: 6 张维度表均为 `INSERT OVERWRITE` 全量刷新，但保留 `start_date`/`end_date` 字段（来自 DWI 层）。当前有效记录 `end_date='4712-12-31'`，取最新值时需加该过滤。
2. **维度表过滤约定**: DWIMD 源表已内置 `GROUP_NUM='800'`（集团）过滤；语言类 JOIN `DWI_MD_GENERAL_CONFIG_CODE_R` 必须 `LANG_CODE='1'`（中文），SDI 源（如 WBS）需 `mandt='800' AND langu='1'`。
3. **产区表 8 路自连接**: `DWR_DIM_PROD_AREA_D` 通过 `SDI_BIC_HZWW010_1009` 8 路 UNION ALL 平铺 8 级层级，且对同名父子节点 `ROW_NUMBER() ORDER BY LVL_ID DESC` 取深层（子节点优先），`HIEID` 硬编码为 `'IEOAELV1P2RKKPNTGNWL1Y2H5'`（东鹏瓷砖产区专用层级）。
4. **WBS 表三层平铺**: `DWR_DIM_WBS_BASIS_INFO_F` 用 tmp1 CTE 将第一/二层平铺到第三层，第三层 `POSID` 作主键（2025-11-07 改造），原 SDI 4 层（PRHI→PROJ→PRPS→COBRA/COBRB）。

### 通用备份表黑名单

以下后缀的表绝对不能使用：`_wjh_*`、`_bak*`、`_tmp*`、`_01`、`_close`、`_0630`、`_2024*`、`_20240326`、`new`（开发变体）。

### 湖南基地独立

出入库表有湖南基地独立表（`dm_original_product_inout_stock_hunan_t` 和 `dm_product_inout_stock_hunan_t`），其他基地数据在通用表。湖南基地独立表额外含成本中心(cost_center)、总账科目(gl_account_no)、均价(avgprice)。

## 库存跌价/减值与资金成本族血缘（2026-08-19 ETL 实证）

```text
SAP 库存账龄明细
  └─ Hive ETL: PJob_DM_FIN_STOCK_DETAIL_ACCAGE_T_2023（DWS 版 PJob_DWS_… 已废弃，逻辑一致）
       └─ dm.dm_fin_stock_detail_accage_t_2023（库龄明细主表，唯一事实源）
            ├─ PJob_DWS_DM_FIN_STOCK_CAPITAL_COST_T（TRUNCATE 全量，近2年窗口，中间表 DM_FIN_STOCK_CAPITAL_M1_T）
            │    └─ dm.dm_fin_stock_capital_cost_t（资金成本，month=YYYYMM）
            │         └─┐
            ├─ jc 减值族（zdpsyb 范围过滤）────────────────────────┤
            │    └─ PJob_DWS_DM_AMBV2_CHDJ_GRP_T（按预算比例分摊到线组/渠道）  │
            │         └─ dm.dm_ambv2_chdj_grp_t（stat_month=YYYY-MM）        │
            │              ├─ inventory_value = SUM(jc_amt 族) 管理减值      │
            │              ├─ inventory_value_amb = SUM(jc_aging 族)        │
            │              └─ capital_cost = 取自资金成本表（⚠️原始列分摊行重复携带全额，金额用 conv 列或源表）┘
            └─ PJob_DWS_DM_FIN_STOCK_D_ACCAGE_LIST_C_T_2023（delete-insert by calmonth）
                 └─ dm.dm_fin_stock_d_accage_list_c_t_2023（上市口径跌价，calmonth=YYYYMM）
                      └─ 天级桶×{0,0.2,0.3,0.5,0.5} → aging_*_fall_amt

CHDJ 维度依赖：dwi_md_data_material_general_t（渠道/物料）、dm_rpt_sales_group_t（线组→node 层级）、
upload_achievement_budget_t（年度预算比例）、upload_loc_comp_relate_t（库位→公司）、upload_division_comp_t（公司→销售组）
```

关键 ETL 事实：① 明细表 jc 减值公式 0/10/40/70%（双脚本一致）；② 上市口径跌价 0/20/30/50/50% 天级桶精确映射；③ 资金成本公式 ((期初+期末)/2−202012余额)×4%/12，零判断已取消；④ CHDJ 1973 行、7 个 UNION 分支（卫浴族/瓷砖/国际/丽适等）。

已知 ETL 隐患：CHDJ 末段 `物料描述 = material_num` JOIN → product_level_code/prod_line_name 可靠性受限。
