# 应收数据血缘

## 数据流向总览

```
SAP 源系统
  ├── FI-AR (应收会计) — BSID/BSAD/BSIK/BSAK/BKPF/BSEG
  ├── SD (销售分销) — VBAK/VBAP/VBRK/VBRP/VBFA (开票/凭证流)
  ├── FI-GL (总账) — SKB1/SKAT (科目主数据)
  ├── FI-CA (合同应收) — 合同应收/进度款
  ├── BP (业务伙伴) — BUT000 (客户主数据)
  ├── TVZBT (付款条款描述)
  ├── PRPS/PROJ (WBS要素/项目主数据)
  ├── KNVV/KNVP (客户销售区域/伙伴关系)
  ├── BSED (票据主数据)
  └── AMB_CREDIT (暴雷客户清单)
    ↓
SDI 层 (源系统镜像 — AR 域直接读 SDI, 跳过 DWI 层)
  ├── SDI_ACDOCA_1001 — SAP通用日记账 (KOART='D' 客户类, 核心事实源)
  ├── SDI_BKPF_1001 / SDI_BSEG_1001 — 凭证头/行项目
  ├── SDI_BSED_1001 — 票据主数据 (签发日期 WDATE)
  ├── SDI_BUT000_1001 — 客户BP主数据
  ├── SDI_KNVV_1001 / SDI_KNVP_1001 — 客户销售区域/伙伴关系
  ├── SDI_TVZBT_1001 — 付款条款描述 (SPRAS='1')
  ├── SDI_PRPS_1001 / SDI_PROJ_1001 — WBS要素/项目
  ├── SDI_VBRP_1001 / SDI_VBFA_1001 — 发票/凭证流
  ├── SDI_ZVBAK_1001 — 销售订单扩展 (含 zso_group)
  ├── SDI_ZGATHERING_SG_1001 — 订单组聚合
  ├── SDI_SKAT_1001 — 总账科目主数据 (KTOPL='CNDP')
  ├── SDI_AMB_CREDIT_CUSTCODE_1037 — 暴雷客户 (含 del_flag/stat_date/end_date)
  ├── SDI_BIC_AZMAM_O0062_1009 — 阿米巴事业部
  └── SDI_BUSINESS_OPPORTUNITY_1033 等 — LTC 节点系列表
    ↓
DWR 层 (数据仓库 — 26 个脚本, AR 域直接从 SDI 读)
  ⚠️ 主源表是 DWRFIN.DWR_AR_CUST_DETAIL_F (不是 SAP BSID/BSAD, 2023-10-26 切换底表)
  ├── DWRFIN.DWR_AR_CUST_DETAIL_F — **应收客户明细 (AR域基石表)** (533行 ETL)
  │     ← SDI_ACDOCA_1001 (KOART='D') + 11路 LEFT JOIN
  │     脚本: huaweiclaude/DWR/FIN/AR/PJob_DWR_AR_CUST_DETAIL_F.txt
  ├── DWRFIN.DWR_AR_RECEIVABLE_AGING_2023_INFO_F — 应收账龄新版 (82列, 2563行 ETL)
  │     ← DWRFIN.DWR_AR_CUST_DETAIL_F (主源, 2023-10-26 切换)
  │     脚本: huaweiclaude/DWR/FIN/AR/PJob_DWR_AR_RECEIVABLE_AGING_2023_INFO_F.txt
  ├── DWRFIN.DWR_AR_RECEIVABLE_AGING_F — 应收账龄旧版 (31列, 5段逾期)
  │     脚本: huaweiclaude/DWR/FIN/AR/PJob_DWR_AR_RECEIVABLE_AGING_F.txt
  ├── DWRFIN.DWR_AR_BILL_AGING_F — 票据账龄 (63列, 含自然账龄7×6矩阵)
  │     ← DWRFIN.DWR_AR_CUST_DETAIL_F (主源, 仅取 W/V 特别总账)
  │     脚本: huaweiclaude/DWR/FIN/AR/PJob_DWR_AR_BILL_AGING_F.txt
  ├── DWRFIN.DWR_AR_CREDIT_DEVALUE_F — **坏账减值 (129列)** (870行 ETL)
  │     ← DWR_AR_RECEIVABLE_AGING_F + DWR_AR_N_RECEIVABLE_AGING_F + DWR_AR_BILL_AGING_F
  │     + CONTRACT_TERMS (LTC合同优先) + DWR_AR_CUST_DETAIL_F
  │     脚本: huaweiclaude/DWR/FIN/AR/PJob_DWR_AR_CREDIT_DEVALUE_F.txt
  ├── DWRFIN.DWR_AR_RECEIVABLE_BALANCE_F — 应收余额 (粒度: 客户+科目+WBS+月份)
  ├── DWRFIN.DWR_AR_COLLECTION_DETAIL_F — 回款明细 (4口径: all/collection/cash/non_cash)
  ├── DWRFIN.DWR_AR_CUST_LATEST_DIMENSION_T — 客户最新维度 (销售员+客户组+销售组)
  ├── DWRFIN.DWR_AR_ACCOUNT_DETAIL_F — 科目明细
  ├── DWRFIN.DWR_AR_COMMERCIAL_BILL_CAPITAL_COST_F — 商票资金成本
  ├── DWRFIN.DWR_AR_RECEIVABLE_DERECEIVED_RECLASSIFY_D — 应收重分类
  ├── DWRFIN.DWR_AR_RECEIVABLE_FROECAST_F — 应收预测
  ├── DWRFIN.DWR_AR_RECEIVABLE_TURNOVER_DAYS_F — 周转天数 (zzts)
  ├── DWRFIN.DWR_AR_N_RECEIVABLE_AGING_F — N类应收账龄
  ├── DWRFIN.DWRFIN_CONTRACT_TERMS_F — 合同条款 (LTC源优先)
  └── DWRFIN.DWR_AR_RISK_LEVEL_F_T — 风险等级 (⚠️ ETL 脚本未归档)
    ↓
DWRDIM 层 (维度主数据)
  ├── DWR_DIM_CUST_GENERAL_D — 客户通用主数据 (含 cust_class_name 客户分类)
  ├── DWR_DIM_CUST_PARTNER_D — 客户BP (79列)
  ├── DWR_DIM_CUST_SALES_AREA_D / _D2 — 客户销售区域 (含 cust_group_code)
  ├── DWR_DIM_COMPANY_D — 公司主数据 (199家)
  ├── DWR_DIM_WBS_BASIS_INFO_F — WBS要素 (三层平铺)
  └── DWR_DIM_SAP_EMP_INFO_F — 销售员工主数据 (含上级)
    ↓
DWRLTC 层 (LTC 合同/商机维度)
  ├── DWR_LTC_CNTC_ITEM_INFO_T — 合同主数据 (version_flag/rcpts_st_code/new_flag)
  ├── DWR_PROJ_BUSI_GATHER_T — 商机项目维度 (省/市/区域/品类)
  └── DWR_LTC_CNTC_ITEM_INFO_T 等
    ↓
UPLOAD 层 (手工/接口上传)
  ├── UPLOAD.UPLOAD_AMB_CREDIT_CUSTODE_T — 暴雷客户外挂表 (时间窗口匹配)
  ├── UPLOAD.UPLOAD_AR_ENG_DET_T — 工程应收填报 (含 cust_risk_level/pay_grp_cust)
  └── UPLOAD.UPLOAD_DIVISION_COMP_T — 事业部公司映射
    ↓
DM 层 (数据集市 — 14 个脚本)
  ├── DM.DM_AR_RECEIVABLE_ACCAGE_T — **应收账龄月度快照** (45列, 162万行)
  │     ← DM.DM_RPT_RECEIVABLE_QUOTA_T (上游余额)
  │     脚本: huaweiclaude/DWS/DM/DM_INSERT/PJob_DWS_DM_AR_RECEIVABLE_ACCAGE_T.txt
  ├── DM.DM_AR_OVERDUE_RECEIVABLES_T — **逾期应收监控** (313万行)
  │     ← 7路CTE UNION ALL (商票/应收/减值/销售收入/代垫/回款) + 笛卡尔积月份补齐
  │     脚本: huaweiclaude/DWS/DM/BW_RPT/PJob_DWS_DM_AR_OVERDUE_RECEIVABLES_T.txt
  ├── DM.DM_AR_ANALYSIS_RPT_F — **综合分析报表** (208列, 162万行)
  │     ← 8+ CTE 链 (pl_sub/tax/tmp1/WBS_BAS/s_emp 等)
  │     脚本: huaweiclaude/DM/DM_CT/PJob_DWS_DM_AR_ANALYSIS_RPT_F.txt
  ├── DM.DM_FIN_AR_NODEEXCEPTION_LTC_T — **LTC节点异常** (2247万行)
  │     ← 10 个 SDI 节点表 + 5 个字典表 (HIVE ETL, 动态分区)
  │     脚本: huaweiclaude/DM/DM_CT/PJob_DM_FIN_AR_NODEEXCEPTION_LTC_T.txt
  ├── DM.DM_AR_RECEIVABLE_ACCAGE_CLOSE_T — 应收账龄已清账版
  ├── DM.DM_AR_RETURN_PAYMENT_T — **应收回款主版** (179万行, ⚠️ ETL 未归档)
  ├── DM.DM_AR_RETURN_PAYMENT_CLOSE_T — 回款已清账版
  ├── DM.DM_AR_RCVBL_STAT_T — 应收统计
  ├── DM.DM_RPT_RECEIVABLE_DEVALUE_T — 应收减值报表主版 (⚠️ ETL 未归档)
  ├── DM.DM_RPT_RECEIVABLE_DEVALUE_CLOSE_T — 减值已关账版
  ├── DM.DM_RPT_RECEIVABLE_QUOTA_T — 应收额度月报 (162万行)
  ├── DM.DM_RPT_RECEIVABLE_QUOTA_DAILY_T — **应收额度日报** (3672万行, AR域第二大表)
  ├── DM.DM_RPT_RECEIVABLE_QUOTA_DAILY_AFnD_T — AF变体系列 (6D/7D/14D/15D/30D)
  └── DM.DM_RPT_SALES_GROUP_T / DM_RPT_SALE_GRP_T — 销售组层级
    ↓
DWS 同步层 (Hive → GaussDB, 26 个脚本, 多为 DELETE+INSERT 增量)
    ↓
FineReport 报表 / 管理驾驶舱
```

## 核心表数据来源映射

### DWR_AR_CUST_DETAIL_F (应收客户明细 — AR 域基石表)

```
DWRFIN.DWR_AR_CUST_DETAIL_F (533行 ETL, 36+列, 粒度: 公司×客户×凭证×凭证项目×WBS×特别总账)
  脚本: huaweiclaude/DWR/FIN/AR/PJob_DWR_AR_CUST_DETAIL_F.txt

  ← 核心数据源 (3 层 CTE + 双 INSERT):
    1. SDI.SDI_ACDOCA_1001 T (SAP 总账凭证行项目, 主表)
       ├── LEFT JOIN SDI.SDI_SKAT_1001 D (总账科目描述, KTOPL='CNDP')
       │     ON T.RACCT = D.SAKNR
       ├── LEFT JOIN SDI.SDI_BUT000_1001 D1 (客户主数据, BP 编号)
       │     ON T.KUNNR = D1.PARTNER
       ├── LEFT JOIN SDI.SDI_ZGATHERING_SG_1001 D10 (订单组聚合)
       │     ON T.KUNNR=D10.KUNNR AND T.RBUKRS=D10.BUKRS AND T.ZUONR=D10.SO_GROUP
       ├── LEFT JOIN SDI.SDI_VBRP_1001 M1 (发票凭证, rn=1 取首条)
       │     ON T.AWREF = M1.VBELN
       ├── LEFT JOIN SDI.SDI_VBFA_1001 D11 (凭证流, VBTYP_V='C' 销售订单)
       │     ON T.AWREF = D11.VBELN
       ├── LEFT JOIN SDI.SDI_BKPF_1001 D2 (凭证抬头, 取汇率 KURSF)
       │     ON T.GJAHR=D2.GJAHR AND T.RBUKRS=D2.BUKRS AND T.BELNR=D2.BELNR
       └── LEFT JOIN SDI.SDI_BSEG_1001 D3 (凭证行项目, 付款条款/到期日基础)
             ON T.GJAHR+RBUKRS+BELNR+BUZEI = D3.*
       → WHERE T.KOART = 'D' (科目类型=客户)
       → 过滤: SUBSTR(T.DW_LAST_UPDATE_DATE,1,10) >= ${PERIOD_ID_D} (增量)
    2. ACDOCA1 CTE (在 ACDOCA 上再 LEFT JOIN 5 张表):
       ├── SDI.SDI_TVZBT_1001 D4 (付款条款描述, SPRAS='1' 中文)
       ├── SDI.SDI_PRPS_1001 D5 (WBS 元素 → 项目号 PSPHI)
       ├── SDI.SDI_ZVBAK_1001 M2 (销售订单扩展, 销售组取值源1)
       ├── SDI.SDI_ZVBAK_1001 D12 (销售订单前置凭证, 销售组取值源2)
       └── SDI.SDI_ZGATHERING_SG_1001 D13 (订单组聚合, 销售组取值源3)
    3. 最终 INSERT OVERWRITE _01 临时表 (在 ACDOCA1 上再 LEFT JOIN 5 张):
       ├── SDI.SDI_PROJ_1001 D6 (项目主数据, WBS销售组 ZVKGRP + 销售人员 ZXSRY)
       ├── SDI.SDI_AMB_CREDIT_CUSTCODE_1037 D7/D8 (暴雷客户, 双分支: 公司匹配 / 公司为空)
       │     ON T.KUNNR=D7.CUST_CODE AND T.RBUKRS=D7.COMP_CODE
       │        AND T.BUDAT BETWEEN D7.STAT_DATE AND D7.END_DATE
       ├── SDI.SDI_KNVV_1001 + SDI.SDI_KNVP_1001 D9 (客户主档销售组/客户组/销售员)
       │     WHERE G.VKGRP <> '' AND G.FAKSD = '' (非冻结)
       │     ROW_NUMBER PARTITION BY KUNNR,SUBSTR(VKORG,1,2) ORDER BY VKORG,KUNNR,VTWEG → rn=1
       └── SDI.SDI_BSED_1001 D10 (票据主数据, 汇款长号 WBANK)

  ← ETL关键逻辑:
    - 清账日期脏值处理: CASE WHEN T.AUGDT='00000000' THEN '47121231' ELSE T.AUGDT END
    - 付款起算日兜底: D3.ZFBDT 为空/00000000 → '47121231'
    - 到期日 DUE_DATE: date_add(ZFBDT, ZBD1T+ZBD2T) (起算日+固定天数1+天数2)
    - 订单组编码 SO_GROUP_CODE: 三层 CASE 回退 D10.SO_GROUP → M2.ZSO_GROUP → D12.ZSO_GROUP → ''
    - 销售组-主档: CASE WHEN D6.ZVKGRP <> '' THEN D6.ZVKGRP ELSE D9.VKGRP END
    - 业务人员: CASE WHEN D6.ZXSRY IS NULL/'' THEN D9.PERNR ELSE D6.ZXSRY END
    - 暴雷客户 IS_OVERDUE_CUST: COALESCE(D7.DEL_FLAG, D8.DEL_FLAG, 'N')
    - 数据同步: 2023-09-21 全量改增量 (用 DW_LAST_UPDATE_DATE >= 参数日期)
    - 双表写入: 先 INSERT OVERWRITE _01 临时表, 再 _01 ∪ (旧表 LEFT ANTI JOIN _01) 覆盖主表
```

### DWR_AR_RECEIVABLE_AGING_2023_INFO_F (应收账龄新版, 82列)

```
DWRFIN.DWR_AR_RECEIVABLE_AGING_2023_INFO_F (2563行 ETL, 82列, 粒度: 公司×客户×WBS×特别总账×总账科目×订单组)
  脚本: huaweiclaude/DWR/FIN/AR/PJob_DWR_AR_RECEIVABLE_AGING_2023_INFO_F.txt
  ⚠️ 主源表是 DWRFIN.DWR_AR_CUST_DETAIL_F (不是 SAP BSID/BSAD, 2023-10-26 切换底表)

  ← 3 层 CTE 架构 (AGING → DWR_AR_M3_F 中间表 → ACDOCA4/5/6 分段聚合):

    1. AGING CTE (从 DWR_AR_CUST_DETAIL_F 读未清账款):
       SELECT ... row_number PARTITION BY 公司,客户,WBS,特别总账,总账科目,货币,订单组
                 ORDER BY DW_LAST_UPDATE_DATE DESC) rn
       WHERE POSTING_DATE <= 查询日期 AND CLEAR_DATE > 查询日期 (未清)
         AND SPECIAL_GENERAL_LEDGER IN ('','U','Q','M','&') OR IS NULL (5值过滤)
    2. INSERT OVERWRITE DWRFIN.DWR_AR_M3_F (AGING 自联 AGING t2 ON rn=1 取最新一条):
       - DUE_DAYS (逾期天数): CASE WHEN day(DATE1 - DUE_DATE) >= 0 THEN day(DATE1 - DUE_DATE) ELSE 0 END
       - N_OVERDUE_DUE_DAYS (未逾期天数): CASE WHEN DUE_DATE >= DATE1
                          THEN (DATE1 - VOUCHER_DATE, 兜底0) ELSE -1 END
    3. ACDOCA4 (主聚合, 53 个 LEFT JOIN): 在 DWR_AR_M3_F 上分桶聚合:
       - T1: 本币累计余额 (SUM(AMT))
       - T2: 2023前本币累计 (SUBSTR(VOUCHER_DATE,1,4) < ${PERIOD_ID_Y})
       - T3: 2023后本币累计 (SUBSTR(VOUCHER_DATE,1,4) >= ${PERIOD_ID_Y})
       - T4: 回款金额 (AMT < 0 的汇总)
       - T5: 逾期应收 (AMT > 0 AND DUE_DATE < 查询日期) + T4.REPAY_AMT, <0 则取 0
       - T7~T20: 2023前 13 段 (1-30/31-60/.../1461+)
       - T22~T35: 2023后 13 段 (相同分段)
       - T36~T51: 未逾期 16 段 (0-30/31-60/.../1461+)
       - T52: before_year_receivables (查询年前应收)
    4. ACDOCA5/6 (自然账龄尾差修正): 对未逾期各段做累计扣减法, 保证不超 N_OVERDUE_RECEIVABLES1 总额
    5. 最终 INSERT OVERWRITE 目标表:
       - 销售组主档: CASE WHEN D6.ZVKGRP <> '' THEN D6.ZVKGRP ELSE T2.sales_grp END
       - 事业部: CASE WHEN WBS_SALES_GROUP 为空 THEN T6.NODE_NAME2 ELSE T5.NODE_NAME2 END
       - LEFT JOIN DM.DM_RPT_SALES_GROUP_T T5/T6 (NODE_NAME9 销售组织树)
       - LEFT JOIN DWRDIM.DWR_CUST_LATEST_DIMENSION_T T2 (客户最新维度, 客户组+销售员)
       - LEFT JOIN SDI.SDI_PROJ_1001 D6 (项目号 SUBSTR(WBS,1,10))

  ← ETL关键逻辑:
    - 查询日期 DATE1 月结切换: 当月01号 → 上月最后一天; 否则 → ${PERIOD_ID_D}
    - 2023 前后分段口径: SUBSTR(VOUCHER_DATE,1,4) 比较 ${PERIOD_ID_Y} (2024-10-08 从过账年度改为凭证年度)
    - 5 值特别总账过滤: ('','U','Q','M','&')
    - 去重: row_number PARTITION BY 7字段 ORDER BY DW_LAST_UPDATE_DATE DESC, 取 rn=1
    - 逾期 = SUM(AMT>0 且 DUE_DATE<查询日期) + 回款(AMT<0), 小于 0 兜底为 0
    - ysyq/yswyq 双口径: 2023_ago (查询年前) vs 2023_after (查询年后), 同样 13 段分桶
    - bf/af 前缀: 字段名 _2023_ago (before) 和 _2023_after (after), 对应"查询年前/后"
    - 全量覆盖: INSERT OVERWRITE (无月份分区, 每次重跑全表)
```

### DWR_AR_CREDIT_DEVALUE_F (坏账减值, 129列)

```
DWRFIN.DWR_AR_CREDIT_DEVALUE_F (870行 ETL, 129列, 粒度: 公司×客户×WBS×特别总账×总账科目×订单组)
  脚本: huaweiclaude/DWR/FIN/AR/PJob_DWR_AR_CREDIT_DEVALUE_F.txt

  ← 核心数据源 (CONTRACT_TERMS + cust_detail_f + CREDIT 3-CTE 架构):

    1. CONTRACT_TERMS CTE (合同条款, 优先 LTC 来源):
       SELECT FROM DWRFIN.DWRFIN_CONTRACT_TERMS_F
       ROW_NUMBER PARTITION BY customer_code, wbs_number, company_code
                  ORDER BY CASE WHEN contract_source='LTC' THEN 1 ELSE 2 END
       → RN=1 取 LTC 合同源 (其他源作回退)
    2. cust_detail_f CTE (发货+回款金额汇总):
       SELECT FROM DWRFIN.DWR_AR_CUST_DETAIL_F T
       LEFT JOIN DWRDIM.DWR_DIM_CUST_GENERAL_D T3 (客户一般主数据, end_date='4712-12-31')
              ON T.CUST_CODE = T3.cust_num
       LEFT JOIN CONTRACT_TERMS T4 (RN=1)
              ON T.CUST_CODE=T4.customer_code AND T.WBS=T4.wbs_number AND T.comp_code=T4.company_code
       LEFT JOIN SDI.SDI_BIC_AZMAM_O0062_1009 T5 (事业部 /bic/za_syamb)
              ON T.CUST_CODE = T5.comp_code
       WHERE posting_date <= 查询日期
         AND special_general_ledger IN ('','U','Q','M','O','&')  -- ⚠️ 源端写 6 值但 'O' 无实际数据；最终表 UNION ALL 后实际 7 值
       GROUP BY 公司, 客户, WBS, 订单组, 总账科目
       → 派生: SHIP_VAL (RV 发货额), Collections_VAL (非RV 回款额)
              SHIP_Progress/Settlement/Retention (按合同比例拆分)
              balance_amt_cl (0021310200 科目, 预收账款)
    3. CREDIT CTE (主结果 UNION 2 路汇总):
       路1: DWR_AR_RECEIVABLE_AGING_F T1 (旧版逾期) INNER JOIN DWR_AR_N_RECEIVABLE_AGING_F T2 (旧版未逾期)
            ON 8字段 NVL 全等 JOIN (含 LOCAL_CURRENCY_BALANCE_SUM 金额也参与 JOIN)
            LEFT JOIN CONTRACT_TERMS T4 (RN=1)
       路2: DWR_AR_BILL_AGING_F T (票据账龄) LEFT JOIN CONTRACT_TERMS T4
       → 12 种账龄段减值比例 (外部参数 P_NUM1~P_NUM12 / 100):
          - 1-90天 / 91-275天 / 276-730天 / 731-1460天 / 1461天+ (5段逾期)
          - 1年内 / 1-2年 / 2-3年 / 3-4年 / 4年以上 (5段未逾期自然账龄)
          - 一个月内 / 超一个月 (2段月度口径)
    4. 最终 INSERT OVERWRITE 目标表:
       FROM CREDIT T
       LEFT JOIN DWRDIM.DWR_CUST_LATEST_DIMENSION_T T1 (销售员+客户组+销售组客户主档)
              ON T.CUST_CODE=T1.CUST_NUM AND SUBSTR(T.COMP_CODE,1,2)=T1.SALES_ORG
       LEFT JOIN SDI.SDI_PROJ_1001 D6 (WBS项目主数据, 取 zxsry 销售员)
              ON SUBSTR(T.WBS,1,10) = D6.pspid

  ← ETL关键逻辑:
    - 12 种减值比例: 通过 ETL 调度参数 P_NUM1~P_NUM12 注入 (不是硬编码, 每次跑批可调)
    - 客户分类 cust_class_name: 来自 DWR_DIM_CUST_GENERAL_D (SCD2, end_date='4712-12-31')
    - 垫款逻辑 amt_after_adv (2025-09-21 修改): = 逾期 + 未逾期 (旧版剔除垫款, 新版包含)
    - 进度款/结算款/质保金: 通过 CONTRACT_TERMS 比例 * 发货额 拆分 (新字段 2025-09-21 加入)
    - 扩散逻辑 (2025-09-21): 同一客户+WBS 多条合同取 RN=1, LTC 源优先
    - 13 条变更历史: 2023-03 创建 → 2025-09~10 密集修改 (9 次变更, 主要新增自然账龄 NATOVERD_* 字段和合同拆分)
```

### DWR_AR_BILL_AGING_F (票据账龄, 63列, 含自然账龄)

```
DWRFIN.DWR_AR_BILL_AGING_F (862行 ETL, 63列, 粒度: 公司×客户×WBS×特别总账×总账科目×订单组)
  脚本: huaweiclaude/DWR/FIN/AR/PJob_DWR_AR_BILL_AGING_F.txt
  ⚠️ 票据独立链路: 主源仍 DWR_AR_CUST_DETAIL_F, 但只取票据特别总账, 与应收账龄不同源

  ← 2 层 CTE 架构:

    1. AGING CTE (从 DWR_AR_CUST_DETAIL_F 读票据):
       SELECT FROM DWRFIN.DWR_AR_CUST_DETAIL_F T
       LEFT JOIN SDI.SDI_BSED_1001 T2 (票据主数据, 签发日期 WDATE 来源)
              ON T.COMP_CODE=T2.BUKRS AND T.YEAR=T2.GJAHR
                 AND T.VOUCHER_CODE=T2.BELNR AND T.VOUCHER_ITEM=T2.BUZEI
       WHERE POSTING_DATE <= 查询日期 AND CLEAR_DATE > 查询日期 (未清)
         AND SPECIAL_GENERAL_LEDGER IN ('W','V')  -- 仅银行承兑/商业承兑汇票
       → row_number rn 同 AGING_2023 (7字段 PARTITION, ORDER BY DW_LAST_UPDATE_DATE DESC)
    2. INSERT OVERWRITE DWR_AR_M_F 中间表 (AGING 自联取 rn=1):
       - 签发日期 WDATE: NVL(T2.WDATE,'47121231') (BSED 为空兜底)
       - DUE_DAYS (逾期天数): day(DATE1 - DUE_DATE), <0 → 0
       - N_OVERDUE_DUE_DAYS (未逾期天数): DUE_DATE >= DATE1 时取 day(DATE1 - WDATE), 否则 -1
       - natural_due_days (自然账龄天数): day(DATE1 - WDATE), <0 → 0  -- 用签发日算, 不看到期日
    3. ACDOCA4 CTE (票据聚合, 含自然账龄 56 个 N_NATOVERD_* 字段):
       FROM DWR_AR_M_F GROUP BY 10字段
       → 13 段逾期账龄 + 13 段未逾期账龄 (分段口径为天数连续)
       → 自然账龄 NATOVERD_RECEIVABLES_* (7段: 0-90/91-180/181-365/366-730/731-1095/1096-1460/1461+)
       → 自然账龄×逾期账龄二维矩阵 N_NATOVERD_<nat>_<overdue> (7×6=42 字段, 双维度交叉)
    4. ACDOCA5 (汇总) + 最终 INSERT OVERWRITE 目标表:
       FROM ACDOCA5 T
       LEFT JOIN DWRDIM.DWR_CUST_LATEST_DIMENSION_T T1 (销售员/客户组)
       LEFT JOIN SDI.SDI_PROJ_1001 D6 (项目主数据)

  ← ETL关键逻辑:
    - 特别总账只取 W (银行承兑汇票) / V (商业承兑汇票), 与应收账龄 ('','U','Q','M','&') 互斥
    - 自然账龄基准: 签发日 WDATE (BSED 表), 不是到期日
    - 7×6 自然账龄矩阵: 行=自然账龄段(7), 列=逾期账龄段(6), 用于减值表交叉引用
    - 月结切换: 同 AGING_2023 (当月01号→上月最后一天)
    - 销售组取值 3 次变更 (2023-06/06-30/07-06, 同 AGING_2023)
```

### DM_AR_RECEIVABLE_ACCAGE_T (账龄月度快照)

```
DM.DM_AR_RECEIVABLE_ACCAGE_T (162万行, 45列, 粒度: EDITION_DATE × 公司 × 客户 × WBS × 销售组)
  脚本: huaweiclaude/DWS/DM/DM_INSERT/PJob_DWS_DM_AR_RECEIVABLE_ACCAGE_T.txt (~241行)

  ← 核心数据源:
    1. DM.DM_RPT_RECEIVABLE_QUOTA_T (上游应收余额月表, 提供 ZYSYE/ZYQ/ZDQYJ + 全套 ZAF/ZBF/ZWYQ/zyQ_NRV 分段基数)
       └── 同表单 SELECT, 无 JOIN
  ← CTE 链 (2 步):
    TMP_A → 按累计阈值 CASE 计算 24 个分段金额 (AF/BF × 5 段 × YSYQ/YSWYQ + 4 个总未逾期段)
    TMP_B → 用 TMP_A 的总未逾期金额做上限切片, 再生成 20 个 YSWYQ 分段子段
  ← ETL关键逻辑 (CASE 链约 130 行, 双口径分段算法):
    - 输入基数: ZYQ (总逾期), ZYSYE (总应收), ZAF_YQ_RV_Z/ZBF_YQ_RV_Z (2020后/前逾期RV正数),
      ZAF_YQ_NRV/ZBF_YQ_NRV (2020后/前逾期非RV), ZYQ_NRV_* (1-90/91-275/276-720/721-1440/1440 非RV分段)
    - 阈值分段 (累计扣减): 5 个区间 1-90 / 91-275 / 276-720 / 721-1440 / ≥1441 天
    - 双口径: AF_2020_* (2020年后) 与 BF_2020_* (2020年前) 并存, 应收减值系数不同
    - YS_1 / YS_1_2 / YS_2_3 / YS_3_4 / YS_4 (年度未逾期应收切片)
    - 应收逾期减值公式 (line 223-225):
        BF 0-90×0.03 + 91-275×0.20 + 276-720×0.45 + 721-1440×0.70 + ≥1441×1.00
      + AF 0-90×0.10 + 91-275×0.25 + 276-720×0.45 + 721-1440×0.70 + ≥1441×1.00
    - 应收未逾期减值公式 (line 227): AF 0-365×0.05 + 366-730×0.10 + 731-1095×0.25 + 1096-1460×0.45 + ≥1461×1.00
  ← 刷新模式: 全量 TRUNCATE + INSERT
```

### DM_AR_OVERDUE_RECEIVABLES_T (逾期监控, 313万行)

```
DM.DM_AR_OVERDUE_RECEIVABLES_T (313万行, 粒度: ed_mon × 公司 × c_num × sale_grp × WBS)
  脚本: huaweiclaude/DWS/DM/BW_RPT/PJob_DWS_DM_AR_OVERDUE_RECEIVABLES_T.txt (~572行)
  ⚠️ 实际路径在 BW_RPT/, 非 DM_INSERT/

  ← 核心数据源 (7 路 CTE UNION ALL + 2 个 CROSS JOIN 月份序列):
    TMP_TK    ← dm.dm_rpt_tradeticket_quota_close_t (商票余额, 笛卡尔积月份补齐 + lead() 下月逾期预测)
    TMP_RE    ← dm.dm_rpt_receivable_quota_close_t (应收余额, UNION 当月 + 上月到期预警拼为 yqe_yc 下月预测)
    TMP_RE_RD ← dm.dm_rpt_receivable_devalue_close_t (应收减值, lag() 取上月 bf_zysjz_1)
    TMP_TK_RD ← dm.dm_rpt_tradeticket_accage_close_t (商票减值, lag() 取上月 bf_zyspjjz_1)
    TMP_IC    ← dm.dm_zzt_xssr_close_t (销售收入, 过滤 distr_chan='06' + lev4_name IN ('直营经营管理板块','工程市场中心'))
    TMP_RP    ← dm.dm_rpt_pjobect_adpay_t (工程代垫款)
    TMP_RT1   ← dm.dm_ar_return_payment_close_t (应收回款, 经 temp_p/temp_px 双路: WBS 非空走 WBS 匹配, WBS 为空走客编+公司匹配)
    笛卡尔积驱动: dm.dm_dim_date_d CROSS JOIN (month_id ≥ '202101' 且 ≤ 当月+1月) 保证月份序列完整

  ← ETL关键逻辑:
    - 7 路 CTE 全部列对齐 (zysye/zyq/spje/yqsp/zysjz/bf_zysjz_1/zyspjjz/bf_zyspjjz_1/yqe_yc/yqsp_yc/zddk/bhszyywsr/yqhk/wyqhk)
    - 回款先进先出: zdqyj>zhk → yqhk=zhk, wyqhk=0; 否则 yqhk=zdqyj, wyqhk=zhk-zdqyj
    - 商票下月逾期预测: lead(yqsp,1) over(partition by comp_code,cust_num order by month_id)
    - 客户剔除硬编码: sales_group_name IN ('中国恒大','华夏幸福','泰禾集团') → is_ignore=1
    - 销售区域 rn=1 优先: distribution_chnl_code='06' 排第一
    - 维度补齐: LEFT JOIN dm_rpt_sale_grp_t (lev2~lev6) + dm_rpt_sales_group_t (node_desc9 销售组名称)
    - 商票兑付 spdf 暂未实现 (line 465 注释 "商票兑付逻辑还没实现", 强制置 0)
  ← 刷新模式: 全量 TRUNCATE + INSERT
```

### DM_AR_ANALYSIS_RPT_F (综合分析报表, 208列, 162万行)

```
DM.DM_AR_ANALYSIS_RPT_F (162万行, 208列, 粒度: CALMONTH × WBS × 客编 × 总账科目 × 公司)
  脚本: huaweiclaude/DM/DM_CT/PJob_DWS_DM_AR_ANALYSIS_RPT_F.txt (~876行, 2025/10/08 DP_15000571)
  ⚠️ 实际路径在 DM/DM_CT/, 非 DWS/DM/DM_INSERT/

  ← 核心数据源 (8+ CTE 链):
    pl_sub  ← DWRFIN.dwr_ar_collection_detail_f (回款明细, WBS 非空/为空两路 UNION)
              LEFT JOIN UPLOAD.UPLOAD_AMB_CREDIT_CUSTODE_T T1 (暴雷客户, 客编+公司+时间窗口匹配)
              LEFT JOIN UPLOAD.UPLOAD_AMB_CREDIT_CUSTODE_T T2 (暴雷客户, 仅客编匹配, T2.COMP_CODE IS NULL)
              WHERE comp_code <> '8000' AND cust_group_code <> 'Z0'
    pl_sub2 ← pl_sub + ROW_NUMBER PARTITION BY wbs,cust_code ORDER BY send_amt DESC (去重)
    tax     ← DWRFIN.DWR_FIN_INV_TAX_DETAIL_T (累计已开税务发票金额, 同样排除 8000/Z0)
    pl_sub_setmet ← pl_sub2 + upload.uplaod_ar_eng_det_t (结算金额 settle_amt) + tax (发票金额)
    item    ← DWRLTC.DWR_LTC_CNTC_ITEM_INFO_T (合同主数据, version_flag/rcpts_st_code/new_flag 三条件)
    WBS_BAS ← DWRDIM.DWR_DIM_WBS_BASIS_INFO_F (WBS 层级 + 销售组/销售雇员/商机号)
    s_emp   ← dwrdim.DWR_DIM_SAP_EMP_INFO_F (销售员工 + 上级员工, stat_month=上月)
    tmp1    ← DWRFIN.DWR_AR_CREDIT_DEVALUE_F (信用减值主表, 提供 100+ 列账龄分段 + 36 列 LTC 节点)
              UNION 当前月 + 历史月 (上月/去年同月/去年12月, 用于同比环比 CASE)
    cust_ar ← DWRDIM.DWR_DIM_CUST_SALES_AREA_D (客户集团名, distribution_chnl_code='06', rn=1)
    cust2   ← dm.dm_rpt_zmaster_cus_t (客户主数据描述)

  ← 最终 INSERT (line 481+):
    LEFT JOIN uplaod_ar_eng_det_t B (工程应收填报, 取 cust_risk_level/pay_grp_cust/is_contract_back)
    LEFT JOIN WBS_BAS zz (wbs_level1_desc)
    LEFT JOIN DWRLTC.DWR_PROJ_BUSI_GATHER_T c (商机项目维度: 省/市/区域/品类)
    LEFT JOIN dm.dm_rpt_sales_group_t d/f (双销售组node_desc1~9: master_file + cust_file)
    LEFT JOIN item g (合同金额 contract_amount2)
    LEFT JOIN s_emp se (销售员工姓名+上级)
    LEFT JOIN DWRFIN.DWR_AR_RISK_LEVEL_F_T RISK (项目风险等级 risk_level)

  ← ETL关键逻辑:
    - 暴雷客户识别: T1 (客编+公司+时间窗口) + T2 (仅客编+时间窗口) COALESCE → is_overdue_cust
    - 月结 1 号特殊日期: 当月 1 号 → 取上月最后一天作为查询日
    - 100+ 列账龄分段: NATOVERD_RECEIVABLES_1_90/91_180/181_365/366_730/731_1095/1095_1460/1461 × 6 子节点
    - 36 列 LTC 节点: N_NATOVERD_{0_90|91_180|181_365|366_730|731_1095|1096_1460|1461}_{1..6}
    - 总账科目双轨: 主科目 IN ('0011310700','0011310300','0011310100','0011310600','0011310800') vs 商票 '0011110100'
    - 通用科目排除: general_ledger_account <> '0011110200' (应收逾期/未逾期合计均排除此科目)
  ← 刷新模式: 增量 DELETE WHERE CALMONTH='${PERIOD_ID_M}' + INSERT
```

### DM_FIN_AR_NODEEXCEPTION_LTC_T (LTC 节点异常, 2247万行)

```
DM.DM_FIN_AR_NODEEXCEPTION_LTC_T (2247万行, 粒度: period_id_m × 商机 × WBS × 合同)
  脚本: huaweiclaude/DM/DM_CT/PJob_DM_FIN_AR_NODEEXCEPTION_LTC_T.txt (~396行, 2023/11/17 chenzhiyong)
  ⚠️ HIVE sql (非 DWS), INSERT OVERWRITE TABLE ... PARTITION(period_id_m) 动态分区

  ← 核心数据源 (10 节点 + 主表 LEFT JOIN 链):
    主表: SDI.SDI_BUSINESS_OPPORTUNITY_1033 BO (商机主表, 提供 business_id/wbs/customer_code)
    节点1 要货单:    SDI.SDI_DELIVER_DEMAND_HEADER_1033 DDH (ON BO.BUSINESS_ID=DDH.BUSINESS_ID)
    节点2 合同:      SDI.SDI_CONTRACT_1033 C (ON BO.BUSINESS_ID=C.BUSINESS_ID)
    节点3 验收设置:  SDI.SDI_CONTRACT_SETTLEMENT_HEAD_1033 CSH (含 4 个 LTC 天数字段)
    节点4 发运委托:  DELIVER_DESPATCH_DATA CTE = SDI_DELIVER_DESPATCH_HEADER_1033 + _LINE_1033 + LOOKUP_VALUES_1029
    节点5 请款单:    SETTLEMENT_REQUEST_PAYOUT_DATA CTE = SDI_SETTLEMENT_REQUEST_PAYOUT_1033 (sum total_request_amount)
    节点6 请款明细:  SETTLEMENT_REQUEST_PAYOUT_DETAIL_DATA CTE = _DETAIL_1033 (max pick_date)
    节点7 签收单:    SDI.SDI_DELIVER_SIGN_HEADER_1033 DSH (sign_status='ALREADY_SIGNED')
    节点8 项目评审:  PROJECT_REVIEW_MATERIAL_PRICE_DATA CTE = SDI_PROJECT_REVIEW_1033 (contract_flag='Y', delete_flag=0)
    节点9 验收明细:  SETTLEMENT_VIRTUAL_CHECK_DETAIL_DATA CTE = _VIRTUAL_CHECK_DETAIL_1033 (4 状态描述 + sum 金额)
    节点10 开票单:   SDI_SETTLEMENT_OPEN_TICKET_DATA CTE = _OPEN_TICKET_1033 (sum current/urplus/un_check 金额)
    补充: 正式验收 SETTLEMENT_FORMAL_CHECK_DATA (affirm_result='GRANT_ACCEPTANCE') + 结算单 _BILL_1033 + WBS签收 SDI_ZTSD_WBS_EERT_1001
    字典: SDI_BASE_LOOKUP_VALUES_1029 × 5 次

  ← ETL关键逻辑:
    - 4 个 LTC 时间节点 (CSH): acceptance_recovery_time2 (验收单回收) / acceptance_request_time2 (验收到请款) / request_invoice_time2 (请款到开票) / invoice_returned_time2 (开票到回款)
    - 待办验收金额: db_accept_amt = total_virtual_amount - total_formal_amount
    - 已核销金额: write_off_amt = current_ticket_amount - urplus_ticket_amount
    - 签收单是否回收: SDI_ZTSD_WBS_EERT_1001.eert='X' → '是'
    - 2024-07-09 增量改全量, 2024-07-11 去掉 C.new_flag='NEW' 过滤, 2024-07-16 签收单只取 ALREADY_SIGNED
  ← 刷新模式: HIVE 全量 INSERT OVERWRITE TABLE ... PARTITION(period_id_m) (动态分区)
```

### 额度日报系列 (DM_RPT_RECEIVABLE_QUOTA_T / _DAILY_T / _DAILY_AFnD_T)

```
DM.DM_RPT_RECEIVABLE_QUOTA_T (月度应收余额, 162万行)
  脚本: huaweiclaude/DWS/DM/DM_INSERT/PJob_DWS_DM_RPT_RECEIVABLE_QUOTA_T.txt (~199行, 2022/08/15 guzhengfeng)
  ← 核心数据源: DM.DM_RPT_RECEIVABLE_QUOTA_T_01 (上游明细, ⚠️ _T_01 的 ETL 脚本未归档)
  ← CTE 链: AAA (HAVING ZYSYE>0) + BBB (HAVING ZYQ>0) + CCC (主聚合) + DDD (HAVING ZYSYE<ZYQ 异常纠正)
  ← 关键逻辑: 三层 CASE 嵌套
       AAA 命中 → SUM(ZYSYE) 否则 0
       AAA+BBB 命中 → 进一步判断 DDD (异常应收<逾期) 命中则取 SUM(ZYSYE) 否则 SUM(ZYQ)
  ← 时间窗口: EDITION_DATE IN (上月最后一天, 本月最后一天) - 双月覆盖
  ← 刷新模式: 增量 DELETE WHERE EDITION_DATE IN (上月末, 本月末) + INSERT

DM.DM_RPT_RECEIVABLE_QUOTA_DAILY_T (每日应收余额, 3672万行, AR 域第二大表)
  脚本: huaweiclaude/DWS/DM/DM_INSERT/PJob_DWS_DM_RPT_RECEIVABLE_QUOTA_DAILY_T.txt (~200行, 2022/10/14)
  ← 与月度版结构完全相同, 但 EDITION_DATE='${start_date}' 单日快照, 粒度多了 SALES_GRP
  ← 刷新模式: 增量 DELETE WHERE EDITION_DATE='${start_date}' + INSERT (按日覆盖)

DM.DM_RPT_RECEIVABLE_QUOTA_DAILY_AFnD_T (5 个 AF 变体, 按日快照不同时点)
  AF6D  (2022/11/19): 每日 6日后应收余额表   - 每月 7 号反映前 6 天累计
  AF7D  (2022/11/19): 每日 7日后应收余额表
  AF14D (2022/11/19): 每日14日后应收余额表   - 月中快照
  AF15D (2022/11/19): 每日15日后应收余额表
  AF30D (2022/11/19): 每日30日后应收余额表   - 月末快照 (跨月视图)
  ← 数据源相同: DM.DM_RPT_RECEIVABLE_QUOTA_DAILY_T_01, WHERE EDITION_DATE='${start_date}'
  ← 用途: 不同业务时点对账 (月初/月中/月末), 各变体独立按日 DELETE+INSERT
```

## 表关联关系

### 应收分析最常用 JOIN 链路

```
dwr_ar_receivable_aging_2023_info_f (事实)
  ├── cust_code → DWRDIM.DWR_DIM_CUST_GENERAL_D / DWR_CUST_LATEST_DIMENSION_T (客户属性)
  ├── comp_code → DWRDIM.DWR_DIM_COMPANY_D (公司信息)
  ├── wbs → SDI.SDI_PROJ_1001 (项目主数据, 取销售员)
  └── sales_grp → DM.DM_RPT_SALES_GROUP_T (NODE_NAME9 销售组织树)

dwr_ar_cust_detail_f (基石表, AR域所有衍生表的源)
  ├── voucher_code+voucher_item → SDI_BKPF/BSEG (凭证头/行)
  ├── kunnr → SDI_BUT000 (客户BP) + SDI_KNVV/KNVP (销售区域)
  ├── zuonr → SDI_ZGATHERING_SG (订单组聚合)
  ├── augdt → CASE WHEN '00000000' THEN '47121231' (清账脏值兜底)
  └── zfbdt → CASE WHEN 空/'00000000' THEN '47121231' (起算日兜底)

dwr_ar_credit_devalue_f (减值表)
  ├── cust_code+wbs+comp_code → DWRFIN_CONTRACT_TERMS_F (合同条款, LTC优先 RN=1)
  ├── cust_code → DWRDIM.DWR_DIM_CUST_GENERAL_D (客户分类决定减值比例)
  └── aging 段 ← DWR_AR_RECEIVABLE_AGING_F + DWR_AR_N_RECEIVABLE_AGING_F + DWR_AR_BILL_AGING_F (三表汇总)

dm_ar_analysis_rpt_f (综合分析, 208列)
  ├── wbs+cust_code → WBS_BAS (WBS层级) + DWR_LTC_CNTC_ITEM_INFO_T (合同主数据)
  ├── cust_code → UPLOAD_AMB_CREDIT_CUSTODE_T (暴雷客户, T1 公司匹配 + T2 仅客编匹配)
  ├── sales_emp → DWR_DIM_SAP_EMP_INFO_F (销售员工+上级)
  └── risk_level → DWRFIN.DWR_AR_RISK_LEVEL_F_T (项目风险等级)
```

### 跨域关联

| 分析场景 | 关联路径 |
|---|---|
| 应收 → 收入 | cust_code → 销售订单 (通过 billing documents VBRK/VBRP) |
| 应收 → 费用 | WBS → 费用成本 (通过 wbs_elemt → dwr_fin_cost_d_compre_subj_t) |
| 应收 → 资金 | 回款金额 → 资金流入 (通过 collection_detail_f) |
| 应收 → 利润 | 坏账减值 → 利润表减值损失科目 (0011310xxx 系列) |
| 应收 → 合同 | contract_amount → LTC 合同 (通过 ar_analysis_rpt_f → DWR_LTC_CNTC_ITEM_INFO_T) |
| 应收 → 商票 | special_general_ledger IN ('W','V') → dwr_ar_bill_aging_f |
| 应收 → 业绩 | cust_code + sales_grp → dm_ambv2_zzt_xssr_t (销售收入源) |
| 应收 → 物料 | 通过销售订单行 → 物料 (跨多表, 不推荐直接关联) |

## 维度表速查

| 维度 | 表名 | Schema | 关联键 | 关键过滤 | 说明 |
|------|------|--------|--------|---------|------|
| 客户通用 | DWR_DIM_CUST_GENERAL_D | dwrdim | cust_num | end_date='4712-12-31' (SCD2) | 客户分类 cust_class_name 决定减值比例 |
| 客户最新维度 | DWR_CUST_LATEST_DIMENSION_T | dwrfin | cust_num + SUBSTR(comp_code,1,2)=sales_org | (无) | 销售员+客户组+销售组组合 |
| 客户BP | DWR_DIM_CUST_PARTNER_D | dwrdim | cust_code / cust_num | (79列) | 客户业务伙伴主数据 |
| 客户销售区域 | DWR_DIM_CUST_SALES_AREA_D / _D2 | dwrdim | cust_num + distribution_chnl_code='06' | rn=1 (按客编) | 含 cust_group_code, 母客编 |
| 公司 | DWR_DIM_COMPANY_D | dwrdim | comp_code | end_date='4712-12-31' | 199家公司 |
| WBS | DWR_DIM_WBS_BASIS_INFO_F | dwrdim | wbs_level3 (主键) / wbs_top_level | sdi_prps_1001.up='00000000' (顶层) | 三层平铺, 含销售组/经销商/商机号 |
| 销售员工 | DWR_DIM_SAP_EMP_INFO_F | dwrdim | sales_emp + stat_month | stat_month=上月 | 销售员工+上级员工 |
| 销售组层级 | DM_RPT_SALES_GROUP_T | dm | node_name9 → node_desc1~9 | data_source IN ('S','T','D') | 全域通用, 10级组织层级 |
| 销售组(AR专用) | DM_RPT_SALE_GRP_T | dm | sale_grp → lev2~lev6 | (无) | AR综合报表/逾期监控用 |
| 合同主数据 | DWR_LTC_CNTC_ITEM_INFO_T | dwrltc | contract_code | version_flag/rcpts_st_code/new_flag 三条件 | 合同金额 contract_amount2 |
| 商机项目 | DWR_PROJ_BUSI_GATHER_T | dwrltc | business_id | (无) | 省/市/区域/品类维度 |
| 合同条款 | DWRFIN_CONTRACT_TERMS_F | dwrfin | customer_code + wbs_number + company_code | RN=1 (LTC源优先) | 进度款/结算款/质保金比例 |
| 暴雷客户 | UPLOAD_AMB_CREDIT_CUSTODE_T | upload | cust_code + comp_code + 月份范围 | del_flag | 时间窗口 STAT_DATE~END_DATE 内生效 |
| 工程应收填报 | UPLOAD_AR_ENG_DET_T | upload | cust_code + stat_month | (无) | cust_risk_level/pay_grp_cust/is_contract_back |
| 客户主数据描述 | DM_RPT_ZMASTER_CUS_T | dm | cust_code | (无) | 客户名称/集团名 |
| 日期 | DM_DIM_DATE_D | dm | day_id / month_id | month_id ≤ 当月 | 笛卡尔积补齐月份序列 |

## ETL 注意事项

### DWR_AR_CUST_DETAIL_F / 衍生表通用 (基石表陷阱)

1. **主源表架构含义**: AR 域 3 张衍生表 (AGING_2023 / DEVALUE / BILL_AGING) 全部以 `DWR_AR_CUST_DETAIL_F` 为唯一上游, 不再读 SAP BSID/BSAD 原表 (2023-10-26 切换底表, 3 个脚本同步变更)。**为什么**：CUST_DETAIL_F 统一了凭证/客户/销售组/暴雷客户的口径, 避免下游重复加工。**如何应用**：CUST_DETAIL_F 的字段口径变更会同时影响下游 3 张表 — 修改时必须回归测试; 排查账龄异常时优先检查 CUST_DETAIL_F 是否有重跑/缺数, 不要直接怀疑 SAP 源。

2. **月结日期切换 (2024-09-05 + 2024-10-08)**: DATE1/QUERY_DATE 的 CASE WHEN 逻辑在 4 个脚本里完全一致 — 当 `substr(current_date,1,7) = substr(${PERIOD_ID_D},1,7) AND SUBSTR(${PERIOD_ID_D},9,2) IN ('01')` 时取上月最后一天, 否则取 `${PERIOD_ID_D}`。2024-09-05 取消了"月结3号跑上月数", 2024-10-08 BIT018-20241008001 把年度划分从过账日期 (BUDAT) 改为凭证日期 (VOUCHER_DATE)。**为什么**：月结当天上游数据未完成, 退而取上月口径; 年度划分改凭证日是因为过账日可能跨月。**如何应用**：跑批日期必须传 `yyyy-MM-dd` 格式 (2023-09-11 统一), 传错会导致月结日切逻辑误判。

3. **销售组取值三次变更 (2023-06-14 / 06-30 / 07-06)**: KNVV 读取逻辑从"VKORG+KUNNR 排序"→"非冻结 FAKSD='' 过滤"→"按 VKORG+KUNNR+VTWEG 排序取首条"。**为什么**：销售组在客户主数据中可能多条, 需要稳定的去重规则。**如何应用**：销售组为空时, 优先检查 KNVV 是否被冻结 (FAKSD 非空), 而非数据缺失。

4. **特别总账 5 值 / 6 值 / 2 值三套口径互斥**:
   - **应收账龄 (AGING_2023)**: `IN ('','U','Q','M','&') OR IS NULL` (5 值)
   - **坏账减值 (DEVALUE)**: ⚠️ ETL 源端写 `IN ('','U','Q','M','O','&')` 6 值，但**实测最终表实际 7 值**：NULL(555万) + V/Q/M/W/U/& 各数百~数千行。原因：CREDIT CTE UNION ALL 了 AGING_F（5 值）+ BILL_AGING_F（W/V），且源端无 'O' 类记录
   - **票据账龄 (BILL_AGING)**: `IN ('W','V')` (仅 2 值, 银行承兑/商业承兑汇票)
   **为什么**：不同业务场景纳入的特别总账范围不同。**如何应用**：用户问"应收总额"必须用 AGING_2023 的 5 值口径, 不要混入票据或 'O' 类; 三套口径不能跨表 JOIN 出应收总额。

5. **CUST_DETAIL_F 同步方式从全量改增量 (2023-09-21)**: 用 `SUBSTR(T.DW_LAST_UPDATE_DATE,1,10) >= ${PERIOD_ID_D}` 增量拉取 ACDOCA, 然后 `_01 临时表 ∪ (旧主表 LEFT ANTI JOIN _01)` 覆盖主表。**为什么**：全量重跑代价高。**如何应用**：修复历史数据不能只重跑当天 ETL, 必须从凭证发生日起回溯重跑, 或手动 UPDATE 主表。

6. **清账日期 / 付款起算日脏值兜底**: ACDOCA.AUGDT 和 BSEG.ZFBDT 出现 `'00000000'` 或空值时, 一律替换为 `'47121231'` (4712年, 远未来日期)。**为什么**：所有"未清账款"(AUGDT=4712-12-31) 在衍生表中表现为"CLEAR_DATE > 查询日期", 被纳入账龄计算。**如何应用**：不要把 AUGDT='47121231' 误判为有效清账日期, 它是脏值占位符。

7. **VOUCHER_ITEM 字段从其他字段切到 BUZEI (2023-08-22)**: 凭证项目早期可能用 RINSC/POSEX 等字段, 2023-08-22 统一切换到 SAP 标准 BUZEI。**为什么**：标准化凭证项目字段。**如何应用**：JOIN BSEG/BKPF/BSED 时, 凭证项目维度固定用 BUZEI, 用错字段会导致 JOIN 放大或丢失。

8. **CUST_DETAIL_F 暴雷客户双分支 D7/D8**: SDI_AMB_CREDIT_CUSTCODE_1037 关联两次 — D7 用 `T.RBUKRS=D7.COMP_CODE AND T.BUDAT BETWEEN D7.STAT_DATE AND D7.END_DATE` (精确公司+时间窗), D8 用 `T.RBUKRS IS NULL` (公司为空的兜底)。`IS_OVERDUE_CUST = COALESCE(D7.DEL_FLAG, D8.DEL_FLAG, 'N')`。**为什么**：部分历史凭证公司字段缺失。**如何应用**：暴雷客户判定按过账日期 BUDAT 落在暴雷区间内, 不是凭证日期; 客户已解禁但历史凭证仍标 Y。

### DWR_AR_RECEIVABLE_AGING_2023_INFO_F (账龄表陷阱)

9. **2023 前后账龄分段口径差异**: 2023-ago (查询年前) 和 2023-after (查询年后) 用 `SUBSTR(VOUCHER_DATE,1,4)` 与 `${PERIOD_ID_Y}` 比较拆分, 同一凭证只能落一边。13 段分桶 (1-30/31-60/61-90/91-120/121-150/151-180/181-210/211-240/241-275/276-365/366-730/731-1095/1096-1460/1461+) 对两边独立计算。**为什么**：2023 年起账龄管理口径调整, 老新数据分开统计。**如何应用**：用户问"2023年前的逾期"必须用 `overdue_receivables_*_2023_ago` 字段, 问"今年新增逾期"用 `_2023_after`; 不要直接用 `overdue_receivables` 总字段。

10. **ysyq/yswyq 双口径使用场景**: `overdue_receivables_*` (逾期应收, AMT>0 且 DUE_DATE<查询日) 与 `n_overdue_receivables_*` (未逾期, DUE_DATE≥查询日) 是两套独立分桶, 字段前缀 `overdue_` vs `n_overdue_`。回款 (AMT<0) 加到逾期侧, 不进未逾期侧。**为什么**：业务上"回款优先冲抵逾期", 所以未清的回款记录视为逾期减项。**如何应用**：用户问"应收余额"= 逾期 + 未逾期; 问"逾期金额"只用 overdue; 问"未到期金额"只用 n_overdue。

11. **bf/af 前缀含义**: 字段后缀 `_2023_ago` (= before, 查询年前) / `_2023_after` (= after, 查询年后), 不是"修改前后"。查询年 `${PERIOD_ID_Y}` 是动态参数, 跑 2025 年数据时 ago=2024 年前, after=2025 年。**为什么**：动态参数方便重刷历史。**如何应用**：看到 `_2023_after` 字段不要误以为是"2023 年之后", 它是"查询年(含2023)之后"。

12. **row_number 去重逻辑 (7 字段 PARTITION)**: AGING CTE 在 AGING_2023 和 BILL_AGING 中都用 `PARTITION BY 公司,客户,WBS,特别总账,总账科目,货币,订单组 ORDER BY DW_LAST_UPDATE_DATE DESC`, 取 rn=1。**为什么**：同维度多条记录只保留最新一条, 避免重复。**如何应用**：凭证被冲销 (cover_flag=X) 又重发时, 旧的会被去重掉, 只看最新状态; 但如果维度不完全一样 (如 WBS 变更), 会保留两条。

13. **回款金额 REPAY_AMT 的符号陷阱**: `REPAY_AMT = SUM(AMT) WHERE AMT < 0` (负数), 然后 `OVERDUE_RECEIVABLES = SUM(AMT>0 且 DUE_DATE<查询日) + REPAY_AMT`, 若合计 <0 则取 0。**为什么**：SAP 凭证回款是负数 (冲抵应收)。**如何应用**：查 REPAY_AMT 时它是负数, 报表展示要取绝对值; 计算"净逾期"必须用 CASE WHEN 兜底 0。

14. **AGING_2023 全量覆盖, 无月份分区**: `INSERT OVERWRITE TABLE DWR_AR_RECEIVABLE_AGING_2023_INFO_F` (不带 PARTITION), 每次跑批重写整张表, 历史查询日数据会被覆盖。**为什么**：表只反映最新查询日状态。**如何应用**：不能从这张表查"上月某天的账龄快照", 必须每次跑批后自行归档; DM 层若需要历史对比, 需要建立带查询日期分区的下游表 (如 DM_AR_RECEIVABLE_ACCAGE_T)。

### DWR_AR_CREDIT_DEVALUE_F (减值表陷阱)

15. **DEVALUE 表 2025-09~10 一个月 5 次密集修改**: 09-12 新增若干字段 (BIT018-20250730008), 09-21 改垫款/扩散/进度款逻辑, 09-29 改回款额和进度款汇总, 10-07 加总账科目汇总, 10-27 改查询日期逻辑, 10-28 加项目阶段款差异字段。9 次变更中 5 次涉及核心计算逻辑。**为什么**：减值政策在 2025 Q3 频繁调整。**如何应用**：用 DEVALUE 表数据时, 必须确认数据日期 ≥ 2025-10-28, 否则字段口径不一致; 不要跨版本对比。

16. **DEVALUE 表 P_NUM1~P_NUM12 减值比例参数化**: 12 个减值比例不是硬编码, 是 ETL 调度参数 (P_NUM1~P_NUM12 / 100), 每次跑批可调。比例变更不需要改 SQL, 只需改调度配置。**为什么**：减值比例随会计政策变化。**如何应用**：用户问"为什么减值金额变了", 先查 P_NUM 参数是否被改, 再查数据源。

17. **DEVALUE 表合同源优先级 LTC**: CONTRACT_TERMS CTE 用 `ORDER BY CASE WHEN contract_source='LTC' THEN 1 ELSE 2 END` + RN=1, 强制 LTC (合同系统) 优先于其他源 (如手工录入)。**为什么**：LTC 是最权威的合同源。**如何应用**：同一客户+WBS+公司有多份合同时, 报表展示的进度款/结算款比例以 LTC 为准; LTC 缺失时回退到其他源, 可能产生比例跳变。

18. **DEVALUE 表实际 7 值特别总账（含 W/V）**: ETL 源端写 `IN ('','U','Q','M','O','&')` 6 值过滤 cust_detail_f，但最终表通过 UNION ALL 合并了 AGING_F（5 值）+ BILL_AGING_F（W/V），且源端无 'O' 类记录。实测 7 值分布：NULL（555万行占 99.6%）+ V/Q/M/W/U/& 各数百~数千行。**为什么**：减值需要把票据（BILL_AGING）合并进来一起计提。**如何应用**：与 AGING_2023 对账时 DEVALUE 会多出 W/V 票据行；'O' 写在过滤但实际无数据，是历史代码遗留，不影响分析结果。

### DWR_AR_BILL_AGING_F (票据账龄陷阱)

19. **票据账龄独立链路**: BILL_AGING 主源是 CUST_DETAIL_F 但只取 `SPECIAL_GENERAL_LEDGER IN ('W','V')` (银行承兑/商业承兑汇票), 与应收账龄的 5 值特别总账互斥。**为什么**：票据独立于一般应收, 有独立的减值政策。**如何应用**：用户问"票据账龄"必须用 BILL_AGING 表, 不要用 AGING_2023; 问"应收总额"不要混入票据金额。

20. **票据自然账龄基准 = 签发日**: 票据的"自然账龄"用签发日 WDATE (BSED 表) 算, 不是到期日。**为什么**：票据的"自然持有时间"从签发开始算, 到期日是兑付节点。**如何应用**：问"票据持有天数"用 `natural_due_days`, 问"票据逾期天数"用 `due_days`。

21. **自然账龄 7×6 矩阵 (BILL_AGING 和 DEVALUE)**: 自然账龄段 (7段: 0-90/91-180/181-365/366-730/731-1095/1096-1460/1461+) × 逾期账龄段 (6段: 1-90/91-180/181-365/1-2年/2-3年/3年以上) = 42 个 `N_NATOVERD_<nat>_<over>` 字段。**为什么**：精细减值需要双维度交叉。**如何应用**：用户问"自然账龄 0-90 天里有多少是逾期 1-90 天的"用 `N_NATOVERD_0_90_1`, 不要用 `NATOVERD_RECEIVABLES_1_90` 总字段。

### DM_AR_RECEIVABLE_ACCAGE_T (账龄月度快照陷阱)

22. **bf/af 双口径分段阈值精确含义** (line 10-125): `AF_2020_*` 表示 2020 年后形成的应收, `BF_2020_*` 表示 2020 年前形成的老应收。5 段阈值固定: 1-90 / 91-275 / 276-720 / 721-1440 / ≥1441 天。**为什么**：2020 年起信用政策调整, 新老应收坏账计提比例不同。**如何应用**：查询账龄金额必须明确口径 (AF vs BF), 减值金额 = 两套分别计提后相加 (line 223-225), 不要直接相加做单口径分析。

23. **逾期/未逾期减值系数不对称** (line 223-228): 逾期段 AF 系数 0.10/0.25/0.45/0.70/1.00, BF 系数 0.03/0.20/0.45/0.70/1.00; 未逾期段 (仅 AF) 系数 0.05/0.10/0.25/0.45/1.00, BF 段无未逾期减值公式 (line 227-228 只算 AF)。**为什么**：2020 年前老应收若未逾期, 视为低风险不计提。**如何应用**：跨 2020 的未逾期 BF 应收金额核对减值为 0 是预期行为。

### DM_AR_OVERDUE_RECEIVABLES_T (逾期监控陷阱)

24. **7 路 CTE 必须列对齐** (line 422-443 TMP_ALL): 每路 CTE 都返回 19 个相同字段, 缺失字段强制置 0。**为什么**：7 个业务源表 (商票/应收/减值/销售收入/代垫/回款) 各管一块, UNION ALL 后按 (ed_mon, comp_code, c_num, sale_grp, wbs_num) 聚合。**如何应用**：查询某月某客编的应收数据, 必须 GROUP BY 全部 5 个维度, 否则回款与应收对不上。

25. **dm.dm_dim_date_d CROSS JOIN 笛卡尔积补齐月份**: 所有源表 LEFT JOIN `dm.dm_dim_date_d` (month_id ≥ '202101' 且 ≤ 当月+1月), 通过 `on 1=1` 做笛卡尔积。**为什么**：客户某些月份可能没有交易, 直接 JOIN 会丢失该月行, 用笛卡尔积保证月份序列完整, 配合 `lead()/lag()` 窗口函数做下月预测。**如何应用**：查询时见到月份数据全 0 是正常的, 该客户该月确实无数据, 但行存在。

26. **lead()/lag() 窗口函数预测逻辑**: `lead(yqsp,1) over(partition by comp_code,cust_num order by month_id)` 取下月逾期商票作为本月预测; `lag(zysjz,1)` 取上月减值。**为什么**："不回款情况下" 的下月预测 = 当月数据 + 自然延后一个月。**如何应用**：yqe_yc 字段是预测值不是实际, 与实际回款对比才能算真实逾期增量。

27. **回款先进先出 (FIFO) 拆分逾期/未逾期** (line 385-386): `zdqyj > zhk` 时 `yqhk=zhk, wyqhk=0`; 否则 `yqhk=zdqyj, wyqhk=zhk-zdqyj`。**为什么**：业务上回款优先冲抵最早到期 (逾期) 的应收。**如何应用**：yqhk + wyqhk = zhk (总回款) 恒成立, 单独看 wyqhk 不能反映实际回款进度。

28. **恒大/华夏幸福/泰禾集团硬编码剔除** (line 509): `sales_group_name IN ('中国恒大','华夏幸福','泰禾集团') → is_ignore=1`。**为什么**：房地产暴雷客户应收单独管理, 不计入正常客编维度统计。**如何应用**：全集团应收汇总时, 应按 is_ignore=0 过滤; 否则金额会重复。

### DM_AR_ANALYSIS_RPT_F (综合分析报表陷阱)

29. **排除 comp_code='8000' 与 cust_group_code='Z0'**: 所有 CTE (pl_sub/pl_sub2/tax/tmp1) 都强制 `coalesce(comp_code,'#')<>'8000' AND coalesce(cust_group_code,'#')<>'Z0'`。**为什么**：'8000' 是集团合并抵销公司 (内部往来), 'Z0' 是集团内客户分组, 不属于对外应收。**如何应用**：全集团应收合计不需要再手动排除内部交易, ETL 已处理; 但若用户问 "8000 公司数据为什么缺失" 是设计如此。

30. **暴雷客户外挂表时间窗口匹配陷阱**: `UPLOAD.UPLOAD_AMB_CREDIT_CUSTODE_T` 通过 `BETWEEN T1.STAT_DATE AND T1.END_DATE` 匹配, 当 ${PERIOD_ID_D} 落在窗口内才生效。**为什么**：暴雷客户状态有生效起止, 不是永久标记。**如何应用**：**若外挂表未及时更新 END_DATE, 历史暴雷客户会失效**, is_overdue_cust 错误置 'N'; T1 (客编+公司) 与 T2 (仅客编, COMP_CODE IS NULL) COALESCE, 表示 "公司级暴雷" 优先于 "客户级暴雷"。

31. **tmp1 UNION 4 个时间点** (line 277-280): 当月 + 上月 + 去年同月 + 去年 12 月, 4 路 UNION ALL。**为什么**：208 列里有大量 `_lm` (上月) / `_ly` (去年) / `_ey` (年初) 同比环比字段, 通过 CASE WHEN SUBSTR(query_date,1,7)=... 取对应时间点。**如何应用**：跨年查询时去年 12 月的数据必须存在, 否则年初字段 (`_ey`) 全为 0。

32. **总账科目双轨制 (主科目 vs 商票)**: 主科目 `IN ('0011310700','0011310300','0011310100','0011310600','0011310800')` 与商票 `'0011110100'` 分两套字段 (`_sp` 后缀为商票)。**为什么**：商票有票据减值单独逻辑, 不能与一般应收混合。**如何应用**：`natural_receivables_1_90` 与 `natural_receivables_1_90_sp` 是两套数据, 不能相加, 必须明确问的是哪个科目。

### DM_FIN_AR_NODEEXCEPTION_LTC_T (LTC 节点异常陷阱)

33. **LTC 节点 10 路 LEFT JOIN 深度**: 主表 BUSINESS_OPPORTUNITY 通过 business_id → contract_id → contract_code → business_code 链式 LEFT JOIN 10 个 SDI 节点表 + 5 个字典表。**为什么**：LTC (Lead Time to Cash) 全链路追踪, 每个节点都可能有数据缺失。**如何应用**：某客户某节点的日期为 NULL 是正常的, 表示该流程未发生; 不要用 INNER JOIN 缩小数据集。

34. **LTC 4 个核心时间节点字段** (来自 CSH): `acceptance_recovery_time2` (验收单回收) / `acceptance_request_time2` (验收到请款) / `request_invoice_time2` (请款到开票) / `invoice_returned_time2` (开票到回款)。**为什么**：这 4 个时间节点是 LTC 分析的核心 KPI, 每个节点超期都意味着流程异常。**如何应用**：计算 LTC 周期 = 4 个字段相加, 单独诊断瓶颈环节用各节点值。

35. **LTC 2024-07-09 增量改全量**: 之前是按 period_id_m 增量, 改为全量 INSERT OVERWRITE PARTITION(period_id_m)。**为什么**：历史月份的节点状态可能延后更新 (如验收单回收滞后), 全量重刷保证历史一致性。**如何应用**：2215 万行的大表, 每次重刷代价大, 查询时要带 period_id_m 分区裁剪。

### 额度日报系列陷阱

36. **DAILY_T 3672 万行的查询性能**: **必须带 EDITION_DATE 过滤**, 该表是按日全量快照, 3672 万行 ≈ 客编 × WBS × 公司 × 销售组 × 天数。**为什么**：每天都保留一份完整快照, 数据量随天数线性增长。**如何应用**：任何查询都要 `WHERE EDITION_DATE = 'YYYYMMDD'`, 否则查询会扫全表超时。

37. **AF6D/AF7D/AF14D/AF15D/AF30D 变体含义**: AF6D = "每日 6 日后应收余额表", AF7D = "7 日后", AF14D = "14 日后", AF15D = "15 日后", AF30D = "30 日后"。**为什么**：业务上需要不同时点的对账 (月初/月中/月末), 各 AF 变体按不同日期范围聚合上游 `_T_01` 表。**如何应用**：月初对账用 AF6D/AF7D, 月中用 AF14D/AF15D, 月末用 AF30D; 不要混用, 数据口径不同。

38. **QUOTA_T 三层 CASE 嵌套异常纠正** (line 124-149, DDD CTE): `HAVING SUM(ZYSYE) < SUM(ZYQ)` 找出 "应收<逾期" 的异常组合, 最终 SELECT 时对这些组合 `ZYQ = SUM(ZYSYE)` (即逾期不超过应收)。**为什么**：上游 _T_01 明细聚合后可能出现单客编应收为 0 但逾期仍有余额的脏数据 (回款过头), DDD 强制纠正。**如何应用**：若发现 QUOTA_T 的 ZYQ 比 _T_01 原始 SUM 小, 是 DDD 纠正生效, 不是 bug。

### 缺失脚本 + 刷新模式总览

39. **3 张表的 ETL 不在 huaweiclaude/**:
    - `dm_ar_return_payment_t` (应收回款主版): ⚠️ 仅有 `dm_ar_return_payment_close_t` (定版) 脚本, 主版本 ETL 未归档
    - `dm_rpt_receivable_devalue_t` (应收减值主版): ⚠️ 仅有 `dm_rpt_receivable_devalue_close_t` (定版) 脚本
    - `dwr_ar_risk_level_f_t` (源): ⚠️ ANALYSIS_RPT_F 中引用的是 `DWRFIN.DWR_AR_RISK_LEVEL_F_T` (大写), 但 huaweiclaude 中只有 DWS 同步脚本, 无 Hive 源脚本
    **为什么**：OVERDUE_RECEIVABLES_T 全部使用 `_close_t` (定版) 数据源, 因为定版数据是月结锁定不可变; 主版本 (`_t`) 是实时变化, 用于日内查询。**如何应用**：跨月历史分析查 `_close_t`, 实时余额查 `_t`; 但 `_t` 主版本 ETL 不在归档中, 字段口径需从 `_close_t` ETL 反推。

40. **全量 TRUNCATE vs 增量 DELETE 模式区分**:
    - **全量 TRUNCATE**: ACCAGE_T (line 6), OVERDUE_RECEIVABLES_T (line 22), NODEEXCEPTION_LTC_T (INSERT OVERWRITE PARTITION)
    - **增量 DELETE+INSERT**: ANALYSIS_RPT_F (按 CALMONTH), QUOTA_T (按 EDITION_DATE 双月), QUOTA_DAILY_T (按 EDITION_DATE 单日), QUOTA_DAILY_AFnD_T (按 EDITION_DATE 单日)
    **为什么**：大表 (DAILY_T 3672 万) 必须增量, 否则刷新代价过高; 分析型小表 (ACCAGE_T 162 万) 全量更简单。**如何应用**：补刷历史数据时, 增量表只需重跑该日期/月份; 全量表必须整体重刷。
