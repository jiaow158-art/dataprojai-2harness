# 财务费用数据血缘

## 数据流向总览

```
SAP 源系统
  ├── FI (财务会计) — ACDOCA (通用日记账), BKPF (凭证头), BSEG (行项目)
  ├── CO (管理会计) — CSKT (成本中心文本), CEPCT (利润中心文本), TFKBT (功能范围)
  ├── FI-GL (总账) — SKAT (科目主数据), T001 (公司代码)
  ├── SD (销售分销) — TVGRT (销售组文本), KNVV (客户销售视图), VBAK (销售订单)
  ├── MM (物料管理) — MAKT (物料文本), LFA1 (供应商)
  ├── PS (项目系统) — PRPS (WBS要素), PROJ (项目定义)
  └── 外部系统 — SDI_BIC_AZFISGD022 (SAP预算/调整值), SDI_V_BI_TMS_DO_FEE (TMS运费)
    ↓
SDI 层 (源系统镜像)
  ├── SDI_ACDOCA_1001 — 通用日记账 (核心事实源)
  ├── SDI_CSKT_1001 — 成本中心文本
  ├── SDI_TFKBT_1001 — 功能范围文本
  ├── SDI_T001_1001 — 公司代码主数据
  ├── SDI_SKAT_1001 — 总账科目主数据 (CNDP/CND1 两套科目表)
  ├── SDI_CEPCT_1001 — 利润中心文本
  ├── SDI_MAKT_1001 — 物料描述
  ├── SDI_LFA1_1001 — 供应商主数据
  ├── SDI_KNA1_1001 — 客户主数据
  ├── SDI_KNVV_1001 — 客户销售区域
  ├── SDI_BIC_AZFISGD022_1009 — SAP预算/手工调整值
  ├── SDI_BI0_QCOSTCENTER_1009 — 成本中心→销售组映射
  ├── SDI_TVGRT_1001 — 销售组文本
  ├── SDI_PRPS_1001 — WBS要素
  ├── SDI_PROJ_1001 — 项目定义
  ├── SDI_BKPF_1001 — 凭证头 (凭证参考 xblnr)
  ├── SDI_DIVISION_COMP_T_1037 — 事业部公司映射
  └── SDI_V_BI_TMS_DO_FEE_1005 — TMS运费
    ↓
DWI 层 (数据整合 — 28个脚本)
  ├── DWIFIN.DWI_COST_CENTER_MAIN_T ← SDI_CSKS_1001 (成本中心主数据, 含功能范围/利润中心)
  ├── DWIFIN.DWI_COST_CENTER_DESC_T ← SDI_CSKT_1001 (成本中心描述)
  ├── DWIFIN.DWI_COST_ELEMENTS_ACCOUNTS_T ← SAP CO (成本要素科目)
  ├── DWIFIN.DWI_COST_ELEMENTS_DESC_T ← SAP CO (成本要素描述)
  ├── DWIFIN.DWI_COST_ELEMENTS_CTRL_SCOPE_T ← SAP CO (控制范围成本要素)
  ├── DWIFIN.DWI_GL_ACCOUNT_MASTER_RECORD_T ← SAP FI (总账科目主记录)
  ├── DWIFIN.DWI_COST_EXPENSE_DETAILS_T ← SDI_EXPENSE_DETAILS_1014 (费用明细, 1:1镜像)
  ├── DWIFIN.DWI_COST_REIMBURSEMENT_T ← SDI_REIMBURSEMENT_1014 (费用报销, 1:1镜像)
  ├── DWIFIN.DWI_COST_TRVAPP_T ← SDI (差旅报销)
  ├── DWIFIN.DWI_COST_FUND_CENTER_R ← SAP (基金中心)
  ├── DWIFIN.DWI_COST_PAM_RETRUN_T ← SAP (成本还原返回)
  ├── DWIFIN.DWI_COST_REALTIME_RETRUN_SUM_T ← SAP (实时返回汇总)
  ├── DWIFIN.DWI_COST_RESTORE_CURRENT_BALANCE_T ← SAP (当前余额还原)
  ├── DWIFIN.DWI_COST_RESTORE_LAST_PERIOD_BALANCE_T ← SAP (上期余额还原)
  ├── DWIFIN.DWI_PRC_ZTAMB_COST_T ← SAP (标A成本价格)
  └── DWIMD.DWI_MD_COST_CENTER_INFO_T ← SAP+DWI (成本中心15级层级+销售组映射, 关键!)
    ↓
DWR 层 (数据仓库 — 33个脚本)
  ├── DWRFIN.DWR_FIN_COST_D_COMPRE_SUBJ_T — **费用明细核心事实表** (43列, 详见下方映射)
  ├── DWRFIN.DWR_FIN_EXPENSE_DETAIL_F ← DWI_COST_EXPENSE_DETAILS_T (费用报销明细)
  ├── DWRFIN.DWR_FIN_EXPENSE_APPLY_F ← DWI (费用申请)
  ├── DWRFIN.DWR_COST_TRVAPP_F ← DWI_COST_TRVAPP_T (差旅报销)
  ├── DWRFIN.DWR_FIN_CONTRACT_LEDGER_DETAIL_F ← SDI/DWI (合同台账)
  ├── DWRFIN.DWR_FIN_ORDER_CONTRACT_DETAIL_F ← SDI/DWI (订单合同)
  ├── DWRFIN.DWR_FIN_SETTLEMENT_CONTRACT_DOC_F_F ← SDI/DWI (结算合同)
  ├── DWRFIN.DWRFIN_COST_SALES_GROSS_PROFIT_D — **销售毛利宽表** (详见下方映射)
  ├── DWRDIM.DWR_DIM_EXPENSE_TYPE_D — 费用类型维度 (总账科目→费用大类映射)
  ├── DWRDIM.DWR_DIM_GL_ACCT_D — 总账科目维度 (CNDP科目表描述)
  ├── DWRDIM.DWR_DIM_COMPANY_D — 公司维度
  ├── DWRDIM.DWR_DIM_WBS_BASIS_INFO_F — WBS维度
  ├── DWRFIN.DWR_COST_CENTER_MAIN_D ← DWI_COST_CENTER_MAIN_T (成本中心主数据DWR版)
  └── DWRFIN.DWR_SAP_ADJUST_DATA_T — SAP调整值 (手工调整数据)
    ↓
DM 层 (数据集市 — 11个脚本)
  ├── DM.DM_FACT_FINANCE_COST_F — **费用宽表 (主分析表)** (详见下方映射)
  ├── DM.DM_FIN_COST_RETURN_T ← DWIFIN.DWI_COST_RESTORE_CURRENT_BALANCE_T (成本还原)
  ├── DM.DM_FIN_STOCK_CAPITAL_COST_T ← DM.DM_FIN_STOCK_DETAIL_ACCAGE_T_2023 (库存资金成本)
  ├── DM.DM_FIN_STOCK_DETAIL_ACCAGE_T_2023 — 库存账龄明细 (跨域, 属库存域)
  ├── DM.DM_EXPENSE_PREDICTION_FSRECLASS_T — 费用预测重分类
  ├── DM.DM_RPT_SALES_GROUP_T — 销售组层级 (10级node_desc/name)
  ├── DM.DM_RPT_BI0_HGL_ACCOUNT_VI — 高级总账科目视图
  └── DM.DM_DIM_DATE_D — 日期维度
    ↓
UPLOAD 层 (上传/接口表)
  ├── UPLOAD.UPLOAD_EXPENSE_GROUP_T — 预算数据 (按成本中心+科目+月份)
  ├── UPLOAD.UPLOAD_division_comp_t — 事业部公司映射 (comp_code→sales_grp)
  └── UPLOAD.UPLOAD_TAX_CERAMIC_PROFIT_T — 陶瓷毛利预算
    ↓
DWS 同步层 (10个脚本, Hive→GaussDB)
  ├── 同步 DM_FACT_FINANCE_COST_F
  ├── 同步 DWR_FIN_COST_D_COMPRE_SUBJ_T
  ├── 同步 DWRFIN_COST_SALES_GROSS_PROFIT_D
  ├── 同步 DM_FIN_OPERATIONS_MIX_SUM_T (跨域: 经营混合汇总)
  └── 其他DM表同步
    ↓
FineReport 报表
```

## 核心表数据来源映射

### DWR_FIN_COST_D_COMPRE_SUBJ_T (费用明细核心事实表)

```
DWRFIN.DWR_FIN_COST_D_COMPRE_SUBJ_T (43列, 粒度: 凭证行×月)
  ← 核心数据源 (3路UNION):
    1. SDI.SDI_ACDOCA_1001 (SAP通用日记账, KOART='S')
       ├── LEFT JOIN SDI.SDI_TFKBT_1001 (功能范围名称, SPRAS='1')
       ├── LEFT JOIN SDI.SDI_T001_1001 (公司描述)
       ├── LEFT JOIN DWRFIN.DWR_FIN_CSKT_TMP ← SDI.SDI_CSKT_1001 (成本中心描述, 最新一条)
       ├── LEFT JOIN SDI.SDI_SKAT_1001 (总账科目描述, KTOPL='CNDP' 优先, 'CND1' 备选)
       ├── LEFT JOIN SDI.SDI_MAKT_1001 (物料描述, SPRAS='1')
       ├── LEFT JOIN SDI.SDI_LFA1_1001 (供应商名称)
       ├── LEFT JOIN SDI.SDI_CEPCT_1001 (利润中心描述, KOKRS='DP00')
       ├── LEFT JOIN SDI.SDI_BI0_QCOSTCENTER_1009 → DWR_FIN_QCOSTCENTER_TMP (成本中心→销售组)
       ├── LEFT JOIN SDI.SDI_KNA1_1001 (客户名称)
       ├── LEFT JOIN SDI.SDI_KNVV_1001 (客户销售区域→销售组)
       ├── LEFT JOIN SDI.SDI_PRPS_1001 (WBS描述)
       ├── LEFT JOIN SDI.SDI_PROJ_1001 (项目→WBS销售组 ZVKGRP)
       ├── LEFT JOIN SDI.SDI_VBAK_1001 (销售订单→销售组)
       ├── LEFT JOIN SDI.SDI_BKPF_1001 (凭证头→凭证参考 xblnr)
       └── LEFT JOIN SDI.SDI_DIVISION_COMP_T_1037 (公司→事业部销售组, 无成本中心时回填)
    2. SDI.SDI_BIC_AZFISGD022_1009 (SAP预算/手工调整值, ZDATAINDX='T')
       ├── LEFT JOIN SDI.SDI_TVGRT_1001 (销售组描述)
       └── 销售组来自 SDI_BI0_QCOSTCENTER_1009 (成本中心映射)
    3. DWROTD.DWR_TRA_TMS_FEE_T (TMS运费, 仅科目 0054010600/0054010700)
       └── LEFT JOIN DWRDIM.DWR_DIM_CUST_SALES_AREA_D2 (客户→销售组)
    4. DWRFIN.DWR_SAP_ADJUST_DATA_T (SAP调整值)
       └── LEFT JOIN DWIMD.DWI_MD_DATA_MATERIAL_GENERAL_T (物料描述)
  ← ETL关键逻辑:
    - 销售组取值优先级: 订单销售组 > 会计凭证VKGRP_PA > WBS销售组 > 客户主档销售组 > 成本中心销售组
    - 科目61602000直接读取成本中心主档销售组 (2024-03-23修复)
    - 研发费用还原: 功能范围4105/4101且无成本中心→按公司映射事业部销售组
    - 排除科目前缀: 不取0061002*/0061001*/00410130* (过渡科目)
    - 排除功能范围: 1603/6100/6200/6000 (非费用类)
```

### DM_FACT_FINANCE_COST_F (费用宽表, 主分析表)

```
DM.DM_FACT_FINANCE_COST_F (90+列, 粒度: 月×成本中心×科目×销售组)
  ← 实际值 (2路UNION, 当期+同期):
    DWRFIN.DWR_FIN_COST_D_COMPRE_SUBJ_T
    ├── LEFT JOIN DM.DM_RPT_BI0_HGL_ACCOUNT_VI (高级科目视图)
    ├── LEFT JOIN DWIMD.DWI_MD_COST_CENTER_INFO_T (成本中心15级层级)
    │     ON cost_center_code = REPLACE(ZCOST_CENTER,'DP00','')
    ├── LEFT JOIN DM.DM_RPT_SALES_GROUP_T (9级销售组织层级)
    │     ON SALES_GRP_CODE = NODE_NAME9
    ├── LEFT JOIN DWRDIM.DWR_DIM_EXPENSE_TYPE_D (费用大类映射)
    │     ON general_ledger_account = GL_ACCOUNT
    ├── LEFT JOIN DWIFIN.DWI_COST_CENTER_MAIN_T (成本中心类型)
    ├── LEFT JOIN DWRDIM.DWR_DIM_COMPANY_D (公司名称)
    ├── LEFT JOIN UPLOAD.UPLOAD_division_comp_t (公司→事业部)
    └── LEFT JOIN DWROTD.DWR_DIM_WBS_BASIS_INFO_F → wbs_top_level (WBS顶层)
  ← 预算 (2路UNION, 当期+同期):
    UPLOAD.UPLOAD_EXPENSE_GROUP_T
    ├── LEFT JOIN DWIMD.DWI_MD_COST_CENTER_INFO_T (成本中心层级)
    ├── LEFT JOIN DM.DM_RPT_SALES_GROUP_T (9级层级)
    ├── LEFT JOIN DWRDIM.DWR_DIM_GL_ACCT_D (科目描述, CNDP)
    ├── LEFT JOIN DWRDIM.DWR_DIM_EXPENSE_TYPE_D (费用大类)
    └── LEFT JOIN DWIMD.DWI_MD_GENERAL_CONFIG_CODE_R (功能范围名称)
  ← 预测 (2路UNION, 当期+同期):
    DM.DM_EXPENSE_PREDICTION_FSRECLASS_T
    └── JOIN链路同预算
  ← ETL关键逻辑:
    - infoprov 字段区分: '实际' / '预算' / '预测'
    - 功能范围→费用类型映射: 5501=销售费用, 5504=物流费用, 5502=管理费用, 4110=研发费用, 5503=财务费用
    - 物流成本特殊: 科目0054010600/0054010700 独立分类
    - 成本中心为空+功能范围4105/4101时: 从UPLOAD_division_comp_t取销售组
    - 制造费用4105/生产成本4101排除3个过渡科目: 0041011040/0041011030/0061507000
```

### DWRFIN_COST_SALES_GROSS_PROFIT_D (销售毛利宽表)

```
DWRFIN.DWRFIN_COST_SALES_GROSS_PROFIT_D
  ← 当期实际+同期 (2路UNION):
    DM.DM_ZZT_XSSR_T (销售输入事实表)
    ├── LEFT JOIN DM.DM_RPT_SALES_GROUP_T (9级组织层级)
    ├── LEFT JOIN DWIMD.DWI_MD_DATA_MATERIAL_GENERAL_T_01 (物料主数据)
    ├── LEFT JOIN DWIFIN.DWI_PRC_ZTAMB_COST_T (标A成本价格, dated=YYYY0731)
    ├── LEFT JOIN DM.DM_RPT_PROD_LEVEL_T (产品层次)
    ├── JOIN DM.DM_DIM_DATE_D (日期维度, day_id→day_id_yago 同期映射)
    └── LEFT JOIN upload.upload_keyproducts (关键产品/FR品类名称)
  ← 预算:
    UPLOAD.UPLOAD_TAX_CERAMIC_PROFIT_T (陶瓷毛利预算)
    └── JOIN DM.DM_RPT_SALES_GROUP_T + DM.DM_DIM_DATE_D
  ← 阿米巴业绩 (2路UNION):
    DM.DM_RPT_GROUP_ACHIEVEMENT_AMB_T (阿米巴达成)
    └── JOIN DM.DM_RPT_SALES_GROUP_T + DWIMD.DWI_MD_DATA_MATERIAL_GENERAL_T_01
  ← 粒度: 月×日×二级部门×三级部门×销售区域×运营中心×产品层次×量纲×整合渠道×工厂
  ← 特殊逻辑: 仅取瓷砖事业部 (node_desc2='瓷砖事业部')
  ← 渠道二级分类 zqdzh23_2: GG01/GG02/GG03/GG05/GG06/GG08/GD01/GD02/GD03/GD04
```

### DM_FIN_COST_RETURN_T (成本还原表)

```
DM.DM_FIN_COST_RETURN_T
  ← DWIFIN.DWI_COST_RESTORE_CURRENT_BALANCE_T (当前余额还原数据)
  ├── LEFT JOIN DWRDIM.DWR_DIM_PRODUCT_AREA_D (工厂→产区, SUBSTR前2位匹配)
  ├── LEFT JOIN DWIMD.DWI_MD_DATA_MATERIAL_GENERAL_T (物料→品类/规格, matl_group_code='1000010')
  └── 基地映射: SUBSTR(werks,1,2) → 清远/江西/佛山/湖南/山东/重庆/山西
  ← 粒度: 年月×工厂×物料×单位
  ← 成本项: 材料沙泥/化工/包装/其他, 半成品/产成品/副产品, 返工耗用, 人工费, 燃料煤/气, 电费, 折旧, 委外, 水费, 物料消耗, 维修费, 柴油, 污水处理, 其他费用
```

### DM_FIN_STOCK_CAPITAL_COST_T (库存资金成本)

```
DM.DM_FIN_STOCK_CAPITAL_COST_T
  ← DM.DM_FIN_STOCK_DETAIL_ACCAGE_T_2023 (库存账龄明细, 核心数据源)
    ├── 3路UNION: 2020年底库存(基准) + 当月库存 + 上月库存
    └── 粒度: 月×事业部×公司×工厂×物料×批次×库存地点×库存类别
  ← 维度JOIN:
    ├── SDI.SDI_DIVISION_COMP_T_1037 (公司→事业部→销售组)
    ├── DWIMD.DWI_MD_DATA_MATERIAL_GENERAL_T (物料主数据, group_num=800)
    ├── SDI.SDI_T001W_1001 (工厂名称, MANDT=800)
    ├── SDI.SDI_T001L_1001 (库存地点名称, MANDT=800)
    ├── DWIMD.DWI_MD_MATL_BATCH_INFO_T (批次→产区编码)
    ├── DM.DM_RPT_SALES_GROUP_T (销售组→9级层级)
    ├── SDI.SDI_SW_CABINET_BASIN_T_1037 (浴室柜标识)
    ├── SDI.SDI_RPT_PROD_CATEGORY_T_1037 (产品线)
    └── SDI.SDI_SW_CATEGORY_SALES_GRP_RELATION_T_1037 (品类→销售组)
  ← 资金成本公式: ((期初+期末)/2 - 2020基准) * 4%/12, 按月累计
  ← 事业部→销售组映射: 7种事业部代码→对应销售组编码, 家居事业部合并入瓷砖事业部
```

## 表关联关系

### 费用分析最常用 JOIN 链路

```
DM_FACT_FINANCE_COST_F (事实, 主分析用)
  ├── cost_center → DWIMD.DWI_MD_COST_CENTER_INFO_T (成本中心15级层级)
  │     └── sales_grp_code → DM.DM_RPT_SALES_GROUP_T (9级组织层级)
  ├── acc_acount → DWRDIM.DWR_DIM_GL_ACCT_D (科目描述, GL_ACCOUNT_TYPE='CNDP')
  ├── acc_acount → DWRDIM.DWR_DIM_EXPENSE_TYPE_D (费用大类, BUDGET_GL_ACCOUNT_DESC)
  ├── functional_scope → DWIMD.DWI_MD_GENERAL_CONFIG_CODE_R (功能范围名称)
  ├── comp_code → DWRDIM.DWR_DIM_COMPANY_D (公司名称, end_date='4712-12-31')
  └── wbs_top_level → DWRDIM.DWR_DIM_WBS_BASIS_INFO_F (WBS顶层描述)

DWR_FIN_COST_D_COMPRE_SUBJ_T (事实, 明细查询用)
  ├── cost_center_code → DWIFIN.DWI_COST_CENTER_MAIN_T (成本中心主数据)
  ├── comp_code → SDI.SDI_T001_1001 (公司描述)
  ├── general_ledger_account → SDI.SDI_SKAT_1001 (科目描述)
  └── sales_group_code → SDI.SDI_TVGRT_1001 (销售组描述)

DWRFIN_COST_SALES_GROSS_PROFIT_D (毛利分析)
  ├── node_desc2~5 → DM.DM_RPT_SALES_GROUP_T (组织层级, 内置)
  ├── prod_hierarchys → 产品层次维度
  └── DM.DM_DIM_DATE_D (日期维度, day_id_yago 同期)
```

### 跨域关联

| 分析场景 | 关联路径 |
|---|---|
| 费用 → 销售 | cost_center → DWI_MD_COST_CENTER_INFO_T → sales_grp_code → DM_RPT_SALES_GROUP_T |
| 费用 → 利润 | cost_center → profit_center (通过 DWI_COST_CENTER_MAIN_T) |
| 费用 → 合同 | fin_voucher_code → 合同号/订单号 (DWR_FIN_CONTRACT_LEDGER_DETAIL_F) |
| 费用 → 公司 | comp_code → DWR_DIM_COMPANY_D |
| 费用 → 库存成本 | 独立链路: DM_FIN_STOCK_CAPITAL_COST_T ← DM_FIN_STOCK_DETAIL_ACCAGE_T_2023 |
| 费用 → 毛利 | DWRFIN_COST_SALES_GROSS_PROFIT_D (费用域自有的毛利宽表) |
| 费用 → 业绩 | cost_center → sales_grp_code → DM_FIN_OPERATIONS_MIX_SUM_T.sales_grp (跨域) |

## 维度表速查

| 维度 | 表名 | Schema | 关联键 | 说明 |
|------|------|--------|--------|------|
| 成本中心(主数据) | DWI_COST_CENTER_MAIN_T | dwifin | cost_center + company_code | 含功能范围/利润中心, end_effect_date='4712-12-31' |
| 成本中心(15级层级) | DWI_MD_COST_CENTER_INFO_T | dwimd | zcost_center (需去掉前缀DP00) | 15级成本中心编码+名称, 含销售组映射 |
| 销售组织(10级) | DM_RPT_SALES_GROUP_T | dm | node_name9 → node_desc1~9 | 全域通用, 10级组织层级 |
| 总账科目 | DWR_DIM_GL_ACCT_D | dwrdim | gl_account_code | CNDP科目表, gl_account_type='CNDP' |
| 费用大类 | DWR_DIM_EXPENSE_TYPE_D | dwrdim | gl_account → budget_gl_account_desc | 科目→费用大类映射 |
| 功能范围 | DWI_MD_GENERAL_CONFIG_CODE_R | dwimd | src_sys_config_code (source_code='TFKBT') | 功能范围编码→名称 |
| 公司 | DWR_DIM_COMPANY_D | dwrdim | company_code (end_date='4712-12-31') | 199家公司 |
| WBS | DWR_DIM_WBS_BASIS_INFO_F | dwrdim | wbs_elemt | WBS要素, 含顶层WBS |
| 物料 | DWI_MD_DATA_MATERIAL_GENERAL_T | dwimd | material_num | 物料主数据, group_num=800 |
| 日期 | DM_DIM_DATE_D | dm | day_id / month_id | 日期维度, 含 day_id_yago (去年同期) |
| 事业部公司 | UPLOAD_division_comp_t | upload | comp_code (end_date='9999-12-31') | 公司→事业部→销售组映射 |
| 事业部公司(SDI) | SDI_DIVISION_COMP_T_1037 | sdi | comp_code (end_date='9999-12-31') | 同上, SDI版 |

## ETL 注意事项

1. **DWR_FIN_COST_D_COMPRE_SUBJ_T 是4步ETL**: 先建3个临时表(CSKT/QCOSTCENTER/TMP1/TMP2/TMP3), 最后合并写入目标表。DWS同步时用DELETE+INSERT增量更新(以科目+月份+公司+凭证号为唯一键)
2. **销售组取值优先级(极易出错)**: 订单销售组(ORD_SALES_GRP) > 会计凭证(VKGRP_PA) > 科目61602000特殊逻辑 > WBS销售组(ZVKGRP) > 客户主档(VKGRP) > 成本中心映射(SALES_GRP)
3. **研发费用还原**: ACDOCA中功能范围4105/4101的记录, 若成本中心属于特定研发组(GWEA/GCFE), 则将金额作为手工调整值(manual_adjust_amt)重新入表, 功能范围改为4101
4. **TMS运费合并**: DWR_TRA_TMS_FEE_T 仅取科目 0054010600/0054010700, 并排除SAP中USNAM='TMS'的记录, 避免重复
5. **日期格式混乱**: ACDOCA中FISCYEARPER为YYYYPPP格式(期间), 转换为YYYY-MM; BUDAT/BLDAT为YYYYMMDD格式; 各层月份字段格式不一致 (YYYY-MM vs YYYYMM)
6. **DM_FACT_FINANCE_COST_F 是全量刷新**: TRUNCATE + INSERT, 每次重算全部数据, 实际值从DWR_COMPRE_SUBJ_T取, 预算从UPLOAD_EXPENSE_GROUP_T取, 预测从DM_EXPENSE_PREDICTION_FSRECLASS_T取
7. **语言过滤**: SDI表JOIN时通常需要 SPRAS='1' (中文) + MANDT='800' (集团)
8. **科目过滤规则(核心)**: 只取前3位为'004'或'006'的科目, 加上3个物流成本特殊科目; 排除0061002*/0061001*/00410130*共8个过渡科目
9. **成本中心层级**: DM_FACT_FINANCE_COST_F内置15级成本中心层级(cost_center_code_1~15 + cost_center_name_1~15), 来自DWI_MD_COST_CENTER_INFO_T, 无需额外JOIN
10. **双科目表**: SKAT有CNDP和CND1两套科目表, 优先取CNDP (case when D6.TXT20 is not null then D6.TXT20 else D7.TXT20)
11. **备份表黑名单**: DWR_FIN_COST_D_COMPRE_SUBJ_T_00 (TMS手工差异), DWR_FIN_COST_D_COMPRE_SUBJ_T_01 (中间表), DWR_FIN_COST_D_COMPRE_SUBJ_TMP* (临时表) — 不可直接查询, 只用最终表 DWR_FIN_COST_D_COMPRE_SUBJ_T
12. **性能参数**: DWR层ETL设置 hive.auto.convert.join、tez.grouping.max-size 等参数优化大表JOIN性能
13. **DWRFIN_COST_SALES_GROSS_PROFIT_D 仅限瓷砖事业部**: node_desc2='瓷砖事业部' 硬编码过滤, 其他事业部毛利不在本表
14. **DWS同步层**: Hive ETL产出后通过DWS脚本同步到GaussDB, 字段名保持一致, 部分表用DELETE+INSERT增量, 部分用TRUNCATE全量
