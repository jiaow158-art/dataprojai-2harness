# 销售业绩数据血缘

## 数据流向总览

```
SAP 源系统
  ├── SD (销售分销) — VBAK/VBAP (销售订单), LIKP/LIPS (交货), VBRK/VBRP (开票)
  ├── FI (财务会计) — ACDOCA (通用日记账), BSEG (行项目)
  ├── CO (管理会计) — COSS/COEP (成本分摊/行项目)
  └── OSS系统 — SDI_S_ORG_EXT_1002 (OSS客户信息)
    ↓
SDI 层 (源系统镜像)
  ├── SDI_VBAK_1001 / SDI_VBAP_1001 — 销售订单头/行
  ├── SDI_LIKP_1001 / SDI_LIPS_1001 — 交货头/行
  ├── SDI_VBRK_1001 / SDI_VBRP_1001 — 开票头/行
  └── SDI_S_ORG_EXT_1002 — OSS客户信息
    ↓
DWI 层 (数据整合 — **业绩域DWI层脚本严重缺失**)
  ├── DWIOTD.DWI_SO_ORG_EXT_OSS_T ← SDI_S_ORG_EXT_1002 (OSS客户信息, 1:1镜像)
  └── **缺失**: 业绩域核心DWI表(DWI层销售订单/交货/开票整合脚本未归档)
    ↓
DWR 层 (数据仓库 — **业绩域DWR层脚本几乎缺失**)
  ├── DWROTD.DWR_SO_ORG_EXT_OSS_F ← DWI_SO_ORG_EXT_OSS_T (OSS客户DWR版)
  ├── DWRFIN.DWRFIN_COST_SALES_GROSS_PROFIT_D — 销售毛利宽表 (脚本在fin-cost域)
  ├── DWRFIN.DWR_FIN_COST_D_COMPRE_SUBJ_T — 费用明细 (跨域引用, 含科目0054010600/0054010700)
  └── **缺失**: DM_ZZT_XSSR_T / DM_AMBV2_ZZT_XSSR_T / DM_AMBV2_PROFIT_T 等关键上游DWR表脚本未归档
    ↓
DM 层 (数据集市 — 10个脚本)
  ├── DM.DM_FIN_OPERATIONS_MIX_T — **经营混合中间表** (脚本未归档, 核心上游!)
  │     ← DM.DM_AMBV2_ZZT_XSSR_T (阿米巴销售输入)
  │     ← DM.DM_AMBV2_PROFIT_T (阿米巴利润)
  │     ← DM.DM_ZZT_XSSR_QT_T (其他收支)
  │     ← DM.DM_ZZT_XSSR_T (销售输入事实)
  │     ← DM.DM_RPT_GROUP_ACHIEVEMENT_AMB_T (阿米巴达成)
  ├── DM.DM_FIN_OPERATIONS_MIX_SUM_T — **经营混合汇总 (主事实表)** (903万行, 详见下方映射)
  ├── DM.CT_SALES_PERFORMANCE_T — 销售业绩宽表 (222列, 892万行, 详见下方映射)
  ├── DM.CT_SALES_PERFORMANCE_DAILY_T — 销售业绩日报 (日粒度变体)
  ├── DM.CT_SALES_PERFORMANCE_MATERIAL_DAILY_T — 物料级业绩日报
  ├── DM.DM_SO_ORG_PERF_STAT_T — 销售业绩轻量汇总 (详见下方映射)
  ├── DM.DM_DP_API_SALES_TARGET — 销售目标API
  ├── DM.DM_FACT_FINANCE_SALESNETAMT_F — 销售净额 (含node_desc层级)
  ├── DM.DM_RPT_CT_DEPARTMENT_SALES_PERFORMANCE_T — 瓷砖事业部部门业绩报表
  ├── DM.DM_RPT_REGION_PERFORMANCE_DAILY_REPORT_T — 区域业绩日报
  ├── DM.DM_SW_BUSINESS_CENTER_ACHIEVEMENT_DAILY_T — 卫浴商用中心双计业绩
  ├── DM.DM_SW_BUSINESS_CENTER_ACHIEVEMENT_DAILY_F — 卫浴商用中心业绩事实 (上游中间表)
  ├── DM.DM_RPT_SW_DEPARTMENT_SALES_PERFORMANCE_CHANNEL_T — 卫浴部门业绩渠道版
  ├── DM.DM_RPT_SW_DEPARTMENT_SALES_PERFORMANCE_REGION_T — 卫浴部门业绩区域版
  ├── DM.DM_TARGET_ACHIEVEMENT — 目标达成
  ├── DM.DM_RPT_SALES_GROUP_T — **销售组层级 (全域通用, 10级node_desc/name)**
  ├── DM.DM_RPT_PROD_LEVEL_T — 产品层次维度
  ├── DM.DM_RPT_PROD_CATEGORY_T — 产品线维度
  ├── DM.DM_DIM_INTEGRATE_CHANNEL_D — 整合渠道维度 (channel_code→channel_name)
  ├── DM.DM_SDI_TVTWT_1001_T — 分销渠道文本 (SDI镜像到DM)
  └── DM.DM_DIM_DATE_D — 日期维度
    ↓
UPLOAD 层 (上传/配置表)
  ├── UPLOAD.UPLOAD_BUSINESS_ANALYSIS_CHANNEL_T — **渠道维度** (10行, channel_code→channel_name)
  ├── UPLOAD.UPLOAD_ACHIEVEMENT_BUDGET_T — 业绩预算 (按销售组×物料×渠道×月份)
  ├── UPLOAD.UPLOAD_ACHIEVEMENT_PREDICTION_T — 业绩预测 (按组织×渠道×月份)
  ├── UPLOAD.UPLOAD_KEYPRODUCTS — 关键产品/FR品类名称
  ├── UPLOAD.UPLOAD_SW_CABINET_BASIN_T — 浴室柜标识
  ├── UPLOAD.UPLOAD_SW_COMMERCIAL_TARGET_T — 卫浴商用中心目标
  └── UPLOAD.UPLOAD_TAX_CERAMIC_PROFIT_T — 陶瓷毛利预算 (跨域, fin-cost也用)
    ↓
DWS 同步层 (15个脚本, Hive→GaussDB)
  ├── PJob_DWS_DM_FIN_OPERATIONS_MIX_SUM_T — 同步经营混合汇总到GaussDB
  ├── PJob_DWS_DM_SO_ORG_PERF_STAT_T — 同步轻量汇总
  ├── PJob_DWS_DM_CT_SALES_PERFORMANCE_T — 同步业绩宽表
  ├── PJob_DWS_DM_CT_SALES_PERFORMANCE_DAILY_T — 同步业绩日报
  ├── PJob_DWS_DM_CT_SALES_PERFORMANCE_MATERIAL_DAILY_T — 同步物料日报
  ├── PJob_DWS_DM_DP_API_SALES_TARGET — 同步销售目标
  ├── PJob_DWS_DM_RPT_CT_DEPARTMENT_SALES_PERFORMANCE_T — 同步瓷砖部门业绩
  ├── PJob_DWS_DM_RPT_REGION_PERFORMANCE_DAILY_REPORT_T — 同步区域日报
  ├── PJob_DWS_DM_SW_BUSINESS_CENTER_ACHIEVEMENT_DAILY_T — 同步卫浴商用中心
  ├── PJob_DWS_DM_RPT_SW_DEPARTMENT_SALES_PERFORMANCE_* — 同步卫浴业绩
  └── 其他同步脚本
    ↓
FineReport 报表 / API 接口
```

## 核心表数据来源映射

### DM_FIN_OPERATIONS_MIX_SUM_T (主事实表, 经营混合汇总)

```
DM.DM_FIN_OPERATIONS_MIX_SUM_T (903万行, 粒度: 月×日×渠道×客户×物料×销售组×WBS)
  ← 实际值:
    DM.DM_FIN_OPERATIONS_MIX_T (经营混合中间表, 脚本未归档)
    ├── LEFT JOIN DWIMD.DWI_MD_GENERAL_CONFIG_CODE_R (分销渠道名称, source_code='TVTWT')
    ├── LEFT JOIN DWIMD.DWI_MD_DATA_MATERIAL_GENERAL_T (物料主数据, 全量维度)
    ├── LEFT JOIN DWRDIM.DWR_DIM_CUST_GENERAL_D (客户通用主数据, end_date='4712-12-31')
    │     → region_code, region_province_name, cust_name
    ├── LEFT JOIN DWRDIM.DWR_DIM_CUST_SALES_AREA_D2 (客户销售区域, end_date='4712-12-31')
    │     → cust_group_code/name, cust_group1/2/3_name
    ├── LEFT JOIN DWRDIM.DWR_DIM_WBS_BASIS_INFO_F (WBS→销售组/工程类别)
    ├── LEFT JOIN DM.DM_RPT_SALES_GROUP_T (9级组织层级, 关键JOIN!)
    │     ON: data_source IN ('S','T') → coalesce(wbs_sales_grp, cust_sales_grp, t1.sales_grp)
    │         else → t1.sales_grp
    ├── LEFT JOIN DWIMD.DWI_MD_DATA_MATERIAL_SALES_T (物料销售视图)
    ├── LEFT JOIN DM.DM_RPT_PROD_CATEGORY_T (产品线名称)
    ├── LEFT JOIN UPLOAD.UPLOAD_SW_CABINET_BASIN_T (浴室柜标识, 按年+物料)
    ├── LEFT JOIN DWRDIM.DWR_DIM_COUNTRY_NAME_D (出口国名称)
    └── LEFT JOIN DM.DM_DIM_INTEGRATE_CHANNEL_D (整合渠道层级1名称, channel_type='整合渠道1')
  ← 预算:
    UPLOAD.UPLOAD_ACHIEVEMENT_BUDGET_T
    ├── LEFT JOIN DM.DM_SDI_TVTWT_1001_T (分销渠道名称)
    ├── LEFT JOIN DM.DM_RPT_SALES_GROUP_T (组织层级, sale_grp_name=node_name9)
    ├── LEFT JOIN DWIMD.DWI_MD_GENERAL_CONFIG_CODE_R (产品所有权/工艺/品类描述)
    ├── LEFT JOIN DWIMD.DWI_MD_DATA_MATERIAL_GENERAL_T (物料主数据)
    ├── LEFT JOIN DWRDIM.DWR_DIM_MATERIAL_FIELD_DICTIONARY (产品系列名称, fieldname='WLPP')
    ├── LEFT JOIN DWRDIM.DIM_MATERIAL_CONFIG_T (渠道层级2名称, fieldname='YL10')
    └── LEFT JOIN DM.DM_DIM_INTEGRATE_CHANNEL_D (整合渠道层级1名称)
  ← 预测:
    UPLOAD.UPLOAD_ACHIEVEMENT_PREDICTION_T
    ├── LEFT JOIN DM.DM_SDI_TVTWT_1001_T (分销渠道名称)
    ├── LEFT JOIN DM.DM_RPT_SALES_GROUP_T (组织层级, org_code=node_name9)
    ├── LEFT JOIN DWIMD.DWI_MD_GENERAL_CONFIG_CODE_R (产品所有权/品类描述)
    └── LEFT JOIN DM.DM_DIM_INTEGRATE_CHANNEL_D (整合渠道层级1名称)
  ← ETL关键逻辑:
    - TRUNCATE全量刷新 (非增量)
    - 排除: comp_code='8000' (测试公司), cust_group='Z0'
    - 产品线: 浴室柜(优先) > 产品线维度表 > '其他类'
    - node_name9非空处理: coalesce(node_name9, node_name8, ... , node_name2)
    - 新增字段: mt_height(产品高度), tow_lev_channel_code/name(二级渠道)
```

### DM_SO_ORG_PERF_STAT_T (销售业绩轻量汇总)

```
DM.DM_SO_ORG_PERF_STAT_T (粒度: 月×日×客户×物料×WBS×渠道×销售组)
  ← 2路UNION汇总:
    1. DM.DM_AMBV2_ZZT_XSSR_T (阿米巴销售输入)
       ├── LEFT JOIN UPLOAD.UPLOAD_BUSINESS_ANALYSIS_CHANNEL_T (整合渠道名称)
       ├── LEFT JOIN DM.DM_SDI_TVTWT_1001_T (分销渠道名称)
       └── 提供: ambperformance(业绩), zxsmj(面积), zsyjf(积分), performance_1n(1+N业绩), zxssl(数量)
    2. DM.DM_AMBV2_PROFIT_T (阿米巴利润)
       ├── LEFT JOIN UPLOAD.UPLOAD_BUSINESS_ANALYSIS_CHANNEL_T
       ├── LEFT JOIN DM.DM_SDI_TVTWT_1001_T
       └── 提供: notax_sales_net_amt(不含税), act_cost_sum_amt(A成本), standard_price_a(标A成本)
         amb_profit_amt(阿米巴毛利), zyywcb_zxf(装卸费), zyywcb_yf(运费), zcbtzz(成本调整), zzyywcb_azf(安装费)
  ← ETL关键逻辑:
    - 增量: DELETE按calmonth范围 + INSERT
    - A成本 = act_cost_sum_amt - 装卸费 - 运费 (2024-03-29修改, 含安装费)
    - 当月毛利 = notax_sales_net_amt - (last_period_sum_price + 安装费)
```

### CT_SALES_PERFORMANCE_T (销售业绩宽表, 222列)

```
DM.CT_SALES_PERFORMANCE_T (892万行, 222列, 粒度: 日×客户×销售组×整合渠道)
  ← 数据源:
    DM.DM_AMBV2_ZZT_XSSR_T (阿米巴销售输入, 当期+同期+上期)
    ├── LEFT JOIN DM.DM_RPT_SALES_GROUP_T (组织层级, node_desc5=区域/子公司)
    ├── LEFT JOIN UPLOAD.UPLOAD_BUSINESS_ANALYSIS_CHANNEL_T (渠道名称)
    ├── LEFT JOIN DWIMD.DWI_MD_DATA_MATERIAL_GENERAL_T (物料→量纲/品类/产品所有权)
    ├── LEFT JOIN DWIMD.DWI_MD_DATA_MATERIAL_SALES_T (物料销售视图→高值标识)
    ├── LEFT JOIN DWRDIM.DWR_DIM_WBS_BASIS_INFO_F (WBS→销售组/工程类别)
    ├── LEFT JOIN DWRDIM.DWR_DIM_CUST_SALES_AREA_D2 (客户→母客编)
    ├── LEFT JOIN DM.DM_SDI_TVTWT_1001_T (分销渠道名称)
    └── LEFT JOIN DM.DM_DIM_DATE_D (日期维度, 当日/同期/上期)
  ← 预算/目标:
    UPLOAD.UPLOAD_ACHIEVEMENT_BUDGET_T (填报表)
    UPLOAD.UPLOAD_SD_FORECAST_ADN_achievement_T (ART+/DPI/绿家/辅材预测)
  ← 预测:
    UPLOAD.UPLOAD_ACHIEVEMENT_PREDICTION_T
  ← ETL关键逻辑:
    - DELETE按calday (日级增量)
    - 组织架构: 7级层级, level1~7 + level1_code~7_code, level8新增(2025-12)
    - 母客编优先级: 经销母客编 > 客户主档母客编 > 底表母客编 (2025-12修改)
    - 双计逻辑: 2025-02已剔除双计
    - 产品维度11个前缀分类: flagship(旗舰), high_value(高值), world_impression(世界印象), package(大包), n1(1+N) 等
    - 222列含: day/month/quarter/year + 当期/同期/上期/全年各粒度的业绩/面积/毛利/成本
    - 同期映射: last_year_* 用 DM_DIM_DATE_D.day_id_yago
  ← 上游依赖: DM_AMBV2_ZZT_XSSR_T 和 DM_AMBV2_PROFIT_T 的ETL脚本未归档
```

### DM_DP_API_SALES_TARGET

```
DM.DM_DP_API_SALES_TARGET
  ← 手工/系统上传的目标分解数据
  ← 粒度: 月 × sales_center × channel × department × region
  ← 指标: target_sales_amt (目标额) + n_target_amount (N目标)
  ← 目标编制: 全年目标在年初一次性导入
```

### DM_RPT_CT_DEPARTMENT_SALES_PERFORMANCE_T (瓷砖部门业绩)

```
DM.DM_RPT_CT_DEPARTMENT_SALES_PERFORMANCE_T
  ← DM.DM_ZZT_XSSR_T (销售输入事实表, 脚本未归档)
  ├── LEFT JOIN DM.DM_RPT_SALES_GROUP_T (组织层级)
  ├── LEFT JOIN DWIMD.DWI_MD_DATA_MATERIAL_GENERAL_T (物料主数据)
  ├── LEFT JOIN UPLOAD.UPLOAD_BUSINESS_ANALYSIS_CHANNEL_T (渠道名称)
  └── LEFT JOIN DM.DM_DIM_DATE_D (日期维度)
  ← 特殊: 仅瓷砖事业部, 5级层级架构(一级=国内营销系统, 二级=区域运营中心/工程/大包)
  ← 渠道分类: 零售/工程/设计师/大包, 按distr_chan+zyl01+plant规则判定
  ← 日级增量: calday = current_date - 1
```

### DM_RPT_REGION_PERFORMANCE_DAILY_REPORT_T (区域业绩日报)

```
DM.DM_RPT_REGION_PERFORMANCE_DAILY_REPORT_T
  ← DM.DM_ZZT_XSSR_T (销售输入事实, 脚本未归档)
  ├── LEFT JOIN DM.DM_RPT_SALES_GROUP_T
  ├── LEFT JOIN DWIMD.DWI_MD_DATA_MATERIAL_GENERAL_T
  └── LEFT JOIN UPLOAD.UPLOAD_BUSINESS_ANALYSIS_CHANNEL_T
  ← 日级增量, 含6级组织+渠道维度
  ← 含季/年累计业绩, 同期对比, 排名
```

### DM_SW_BUSINESS_CENTER_ACHIEVEMENT_DAILY_T (卫浴商用中心)

```
DM.DM_SW_BUSINESS_CENTER_ACHIEVEMENT_DAILY_T
  ← DM.DM_SW_BUSINESS_CENTER_ACHIEVEMENT_DAILY_F (中间事实表)
  ← UPLOAD.UPLOAD_SW_COMMERCIAL_TARGET_T (商用中心目标)
  ← 日级增量, 含区域×业务类型维度 (直营KA/工程经销商/运营中心)
  ← 仅卫浴事业部, H03230613组织节点下
```

## 表关联关系

### 最常用 JOIN 链路

```
DM_FIN_OPERATIONS_MIX_SUM_T (主事实表, 90%场景)
  ├── node_desc2 = '瓷砖事业部' (内置, 无需 JOIN)
  ├── calmonth = '2026-05' (直接用月格式 YYYY-MM)
  ├── integrate_channel → DM.DM_DIM_INTEGRATE_CHANNEL_D (渠道名称)
  ├── customer → DWRDIM.DWR_DIM_CUST_GENERAL_D (客户名称/区域, end_date='4712-12-31')
  ├── material_num → DWIMD.DWI_MD_DATA_MATERIAL_GENERAL_T (物料维度)
  ├── sales_grp → DM.DM_RPT_SALES_GROUP_T (9级组织层级, data_source过滤)
  └── wbs_elemt → DWRDIM.DWR_DIM_WBS_BASIS_INFO_F (工程类别)

CT_SALES_PERFORMANCE_T (同比/产品分类用)
  ├── org_code → DM.DM_RPT_SALES_GROUP_T.node_name9 (组织映射, 关键!)
  ├── customer → DWRDIM.DWR_DIM_CUST_SALES_AREA_D2 (客户主数据)
  └── integrate_channel_code → UPLOAD.UPLOAD_BUSINESS_ANALYSIS_CHANNEL_T.channel_code (渠道描述)

DM_FIN_OPERATIONS_MIX_SUM_T + DM_DP_API_SALES_TARGET
  ├── sales_grp ↔ sales_center_code
  └── integrate_channel ↔ channel (匹配口径需注意)

DM_SO_ORG_PERF_STAT_T (轻量汇总)
  ├── integrate_channel → UPLOAD.UPLOAD_BUSINESS_ANALYSIS_CHANNEL_T
  ├── sales_grp → DM.DM_RPT_SALES_GROUP_T
  └── distr_chan → DM.DM_SDI_TVTWT_1001_T (分销渠道名称)
```

### 跨域关联

| 分析场景 | 关联路径 |
|---|---|
| 业绩 → 费用 | sales_grp → node_name9 → DM_FACT_FINANCE_COST_F.sales_grp_code |
| 业绩 → 毛利 | 同表已有 a_cost/a_gross_profit/amb_profit_amt 字段 |
| 业绩 → 库存 | material_num → 库存表.material (通过 DM_FIN_STOCK_DETAIL_ACCAGE_T_2023) |
| 业绩 → 应收 | customer → dwr_ar_* 表的 cust_code |
| 业绩 → 物料 | material_num → DWIMD.DWI_MD_DATA_MATERIAL_GENERAL_T |
| 业绩 → 客户 | customer → DWRDIM.DWR_DIM_CUST_GENERAL_D / DWR_DIM_CUST_SALES_AREA_D2 |
| 业绩 → 成本还原 | material_num → DM_FIN_COST_RETURN_T.material_num (按物料) |

## 维度表速查

| 维度 | 表名 | Schema | 关联键 | 说明 |
|------|------|--------|--------|------|
| 销售组织(10级) | DM_RPT_SALES_GROUP_T | dm | node_name9 → node_desc1~9 / node_name1~9 | 全域通用, 10级组织层级 |
| 客户(通用) | DWR_DIM_CUST_GENERAL_D | dwrdim | cust_num (end_date='4712-12-31') | 客户名称/区域/省份/城市线级 |
| 客户(销售区域) | DWR_DIM_CUST_SALES_AREA_D2 | dwrdim | cust_num + sales_org_code + distribution_chnl_code | 客户组/母客编 |
| 物料 | DWI_MD_DATA_MATERIAL_GENERAL_T | dwimd | material_num (group_num=800) | 物料主数据全量维度 |
| 产品线 | DM_RPT_PROD_CATEGORY_T | dm | prod_level3_code | 产品线名称 |
| 产品层次 | DM_RPT_PROD_LEVEL_T | dm | product_level3_code / product_level2_code | 4级产品层次 |
| 整合渠道 | DM_DIM_INTEGRATE_CHANNEL_D | dm | channel_code (channel_type='整合渠道1') | 新增(2026-05), 替代upload表 |
| 渠道(上传) | UPLOAD_BUSINESS_ANALYSIS_CHANNEL_T | upload | channel_code → channel_name | 老版渠道映射(10行), 逐步废弃 |
| 分销渠道 | DM_SDI_TVTWT_1001_T | dm | vtweg (spras='1', mandt='800') | 分销渠道名称 |
| 日期 | DM_DIM_DATE_D | dm | day_id / month_id | 含 day_id_yago (去年同期日历映射) |
| WBS | DWR_DIM_WBS_BASIS_INFO_F | dwrdim | wbs_level1/2/3 → sales_grp | WBS→销售组/工程类别 |
| 浴室柜标识 | UPLOAD_SW_CABINET_BASIN_T | upload | product_code + stat_year | 物料→浴室柜分类 |
| 物料字段字典 | DWR_DIM_MATERIAL_FIELD_DICTIONARY | dwrdim | value_code + fieldname | 产品系列/渠道等枚举翻译 |
| 物料配置 | DIM_MATERIAL_CONFIG_T | dwrdim | value_code + fieldname | 渠道层级2等枚举翻译 |
| 国家 | DWR_DIM_COUNTRY_NAME_D | dwrdim | cntry_region_code (language_code='1') | 出口国名称 |
| 物料销售视图 | DWI_MD_DATA_MATERIAL_SALES_T | dwimd | sales_org_code + material_num + distribution_channel_code | 高值标识等 |
| 客户主数据(SAP) | DM_RPT_ZMASTER_CUS_T | dm | ACCOUNT_NUMBER + SALES_CHANNEL_CODE + SALES_ORGANIZATION_CODE (PARVW='AG') | 经销母客编/渠道重映射, 107列 |
| 销售组重置 | DM_MD_SALE_GRP_RESET_T | dm | node_name9 → node_desc1~9 | 组织架构变更后历史修正, 仅瓷砖 |
| 销售组层级视图 | DWR_GL_SALES_GROUP_V | dwrfin | sales_group → system/subcompany/sales_dept | 部门/区域日报专用(5级), 替代sales_group_t |
| 销售组结构 | DM_DP_API_SALES_GROUP_STRUCT | dm | sales_grp → center/dep/region | 目标表组织映射(3级) |

## Upload表扩展速查（业绩域新增）

| Upload表 | 用途 | 使用者 |
|----------|------|--------|
| UPLOAD_SALES_PERFORMANCE_TARGET_PUS | 瓷砖部门/区域级月度目标(48列,12月unpivot) | 部门业绩日报, 区域业绩日报 |
| UPLOAD_ACHIEVEMENT_HISTORY | 客户→线组人工映射(中文列名) | 部门业绩日报, 区域业绩日报 |
| UPLOAD_CT_SALES_PERFORMANCE_TARGET_T | 10种口径目标填报(17列) | dm_dp_api_sales_target |
| UPLOAD_SD_FORECAST_ADN_ACHIEVEMENT_T | ART+/DPI/绿家/辅材预测 | ct_sales_performance_t(上游) |

## 上游脚本缺失说明

**严重缺失**: 业绩域的 SDI→DWI→DWR 层ETL脚本几乎未归档到 `huaweiclaude/` 目录。以下关键上游表的ETL逻辑无法溯源:

| 缺失脚本对应的表 | 层级 | 说明 |
|---|---|---|
| DM_ZZT_XSSR_T | DWI/DWR | 销售输入事实表, 业绩宽表和部门业绩报表的核心数据源, **最重要的缺失** |
| DM_AMBV2_ZZT_XSSR_T | DWI/DWR | 阿米巴销售输入, 轻量汇总和经营混合的核心上游 |
| DM_AMBV2_PROFIT_T | DWI/DWR | 阿米巴利润表, 含成本/毛利/积分计算逻辑 |
| DM_ZZT_XSSR_QT_T | DWI/DWR | 其他收支表, 经营混合的数据源之一 |
| DM_RPT_GROUP_ACHIEVEMENT_AMB_T | DWI/DWR | 阿米巴达成表, 毛利宽表数据源 |
| DM_FIN_OPERATIONS_MIX_T | DM | 经营混合中间表, 汇总表的上游, 含5张来源表UNION逻辑 |

**影响**: 无法通过脚本确认上述表的字段派生逻辑、过滤条件、JOIN关系。当前血缘信息来源于:
1. DM/DWS层的下游脚本中暴露的上游表名和字段名
2. 现有 `metrics.md` 和 table reference docs 中的字段定义
3. 数据库中实际表结构的逆向推断

**建议**: 下次维护窗口从Hive平台导出上述6张表的ETL脚本, 归档到 `huaweiclaude/` 对应目录。

## ETL 注意事项

1. **DM_FIN_OPERATIONS_MIX_SUM_T 全量刷新**: TRUNCATE + INSERT, 每次重算全量数据 (903万行), 实际值来自DM_FIN_OPERATIONS_MIX_T, 预算来自UPLOAD_ACHIEVEMENT_BUDGET_T, 预测来自UPLOAD_ACHIEVEMENT_PREDICTION_T
2. **CT_SALES_PERFORMANCE_T 日级增量**: DELETE where calday = 当日 + INSERT, 历史数据保留不变, 组织架构变更后历史数据不回刷
3. **DM_SO_ORG_PERF_STAT_T 月级增量**: DELETE按calmonth范围 + INSERT, 可重跑指定月份区间
4. **销售组确定逻辑复杂**: Mix主表中, data_source IN ('S','T')时优先取WBS→客户主档→底表的销售组; 其他来源直接用底表sales_grp
5. **日期格式不一致**: Mix表calmonth用YYYY-MM格式, calday用YYYYMMDD; 业绩宽表calday用YYYYMMDD; 轻量汇总calmonth用YYYYMM
6. **渠道三套体系**: (a) integrate_channel (整合渠道1, 编码), (b) integrate_channel2 (整合渠道2, 编码), (c) distr_chan (分销渠道, SAP编码). 2026-05新增DM_DIM_INTEGRATE_CHANNEL_D替代upload表
7. **产品维度层级深**: 产品所有权(prod_property) > 产品线(product_line) > 品类(category) > 产品层次(product_level) > 物料组(matl_group), 共7层交叉
8. **同期映射**: 通过DM_DIM_DATE_D.day_id_yago字段实现, 同日历日映射到去年同日(考虑闰年)
9. **排除了comp_code='8000'**: Mix表ETL中排除测试公司数据
10. **排除了cust_group='Z0'**: Mix表和轻量汇总均排除Z0客户组
11. **DWS同步层15个脚本**: 全部是DELETE+INSERT模式, 按日/月增量同步Hive到GaussDB
12. **备份表黑名单**: ct_sales_performance_t_bak*, ct_sales_performance_daily_t_bak*, ct_sales_performance_t_new, *_wjh_*, *_tmp*, *_01, *_close — 不可使用
13. **业绩宽表222列**: 含当期/同期/上期/全年各粒度的含税业绩/不含税净额/面积/毛利/成本, 加上旗舰/高值/世界印象/大包/1+N等11种产品维度分类, 更新历史超30次, 逻辑极其复杂
14. **卫浴/瓷砖分支**: 部分表仅限瓷砖事业部(node_desc2硬编码), 部分表仅限卫浴事业部, 混用时注意过滤条件
