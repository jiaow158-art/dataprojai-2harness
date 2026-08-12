-- HIVE sql 
-- ******************************************************************** --
-- author: guzhengfeng
-- create time: 2023/09/25 17:58:29 GMT+08:00
-- description:费用明细、综合科目表 DWRFIN.DWR_FIN_COST_D_COMPRE_SUBJ_T
-- history list:
-- UPDATE FROM guzhengfeng 2023/09/26 ACDOCA表wbs取值逻辑修改
-- update 2023-11-24 zhangpeng  销售组编码取值逻辑有误
-- UPDATE 2024-01-23 ZHZ 新增行项目文本、分配
-- UPDATE 2024-03-23 ZHZ 科目61602000的直接读取成本中心对应的主档直接读取成本中心对应的主档
-- update 2024-04-03 zhz 增加读取销售订单线组以及修改增量条件
-- update2024-04-04 zhz 修改科目61602000的直接读取成本中心 优先级最高
-- update 2025-03-05 zhz 新增订单号、发票号，新增读取TMS运费
-- update 2025-05-07 zhz 新增sap调整值
-- update 2025-06-02 wjh sap调整值取功能范围
-- update 2025-12-22 yangjunhua  alter table DWRFIN.DWR_FIN_COST_D_COMPRE_SUBJ_T add columns(FIN_VOUCHER_REF string comment '凭证参考' )
-- update 2026-01-15 huangwenbin 代码优化
-- ******************************************************************** --
--SQL性能优化设置
set hive.cbo.enable = true;
set hive.mapjoin.smalltable.filesize = 200000000;
set hive.auto.convert.join.noconditionaltask.size = 400000000;
set hive.mapred.local.mem = 4096;
set tez.grouping.max-size=134217728;  -- 128MB（单位字节）

create table if not exists
	DWRFIN.DWR_FIN_CSKT_TMP (
		KOSTL string comment '成本中心编码',
		LTEXT string comment '成本中心描述'
	) comment 'CSKT中间表';

insert
	overwrite table DWRFIN.DWR_FIN_CSKT_TMP
select
	M.KOSTL,
	M.LTEXT
from
	(
		select
			KOSTL,
			LTEXT,
			row_number() over (
				partition by
					KOSTL
				order by
					DATBI desc
			) RN
		from
			SDI.SDI_CSKT_1001
		where
			SPRAS = '1'
			and MANDT = '800'
			and KOKRS = 'DP00'
	) M
where
	M.RN = 1;

create table if not exists
	DWRFIN.DWR_FIN_QCOSTCENTER_TMP (
		COSTCENTER string comment '成本中心',
		SALES_GRP string comment '成本中心的销售组'
	) comment 'QCOSTCENTER中间表';

insert
	overwrite table DWRFIN.DWR_FIN_QCOSTCENTER_TMP (
		select
			COSTCENTER,
			SALES_GRP
		from
			(
				select
					COSTCENTER,
					SALES_GRP,
					row_number() over (
						partition by
							COSTCENTER
						order by
							DATETO desc
					) RN
				from
					SDI.SDI_BI0_QCOSTCENTER_1009 -- 60761
				where
					CO_AREA = 'DP00'
			) M3
		where
			M3.RN = 1
	);

create table if not exists DWRFIN.DWR_FIN_COST_D_COMPRE_SUBJ_TMP1 (
		year string comment '年',
		month string comment '月份',
		voucher_date date comment '凭证日期',
		posting_date date comment '过账日期',
		fin_voucher_code string comment '财务凭证号',
		fin_voucher_line_code string comment '财务凭证行',
		voucher_type_code string comment '凭证类型',
		cost_center_code string comment '成本中心编码',
		cost_center_desc string comment '成本中心描述',
		func_scope_code string comment '功能范围编码',
		func_scope_name string comment '功能范围名称',
		comp_code string comment '公司代码',
		comp_desc string comment '公司代码描述',
		sales_group_code string comment '销售组编码',
		sales_group_desc string comment '销售组描述',
		wbs string comment 'WBS号',
		wbs_desc string comment 'WBS号描述',
		general_ledger_account string comment '总账科目',
		general_ledger_account_desc string comment '总账科目描述',
		sales_org_code string comment '销售组织',
		channel_code string comment '渠道',
		material_code string comment '物料编码',
		material_desc string comment '物料描述',
		cust_code string comment '客户编码',
		cust_name string comment '客户名称',
		supplier_code string comment '供应商编码',
		supplier_name string comment '供应商名称',
		qty string comment '数量',
		local_currency_amt decimal(26, 10) comment '费用本币金额',
		manual_adjust_amt decimal(26, 10) comment '费用手工调整值',
		sum_amt decimal(26, 10) comment '费用合计',
		origin_currency_amt decimal(26, 10) comment '费用原币金额',
		local_currency_unit string comment '本币单位',
		origin_currency_unit string comment '原币单位',
		material_voucher_code string comment '物料凭证',
		profit_center_code string comment '利润中心编码',
		profit_center_desc string comment '利润中心描述',
		dw_last_update_date date comment '数据同步时间'
	) comment '费用明细、综合科目表临时表1';

with AZFISGD1 as (
select
 T.FISCYEAR as year -- 年
,substr(T.FISCPER, 1, 4) || '-' || substr(T.FISCPER, 6, 2) as month -- 月份
,T.COSTCENTER as COST_CENTER_CODE -- 成本中心编码
,D4.LTEXT as COST_CENTER_DESC -- 成本中心描述
,T.FUNC_AREA as FUNC_SCOPE_CODE -- 功能范围编码
,D1.FKBTX as FUNC_SCOPE_NAME -- 功能范围名称
,T.COMP_CODE as COMP_CODE -- 公司代码
,D3.BUTXT as COMP_DESC -- 公司代码描述
,D13.SALES_GRP as SALES_GROUP_CODE -- 成本中心的销售组
,T.GL_ACCOUNT as GENERAL_LEDGER_ACCOUNT -- 总账科目
,case when D6.TXT20 <> ''
 or D6.TXT20 is not null then D6.TXT20
 else D7.TXT20
 end as GENERAL_LEDGER_ACCOUNT_DESC -- 总账科目描述
,T.SALES as MANUAL_ADJUST_AMT -- 费用手工调整值
,T.CURRENCY as LOCAL_CURRENCY_UNIT -- 本币单位
from SDI.SDI_BIC_AZFISGD022_1009 T
left join SDI.SDI_TFKBT_1001 D1 on T.FUNC_AREA = D1.FKBER
and D1.SPRAS = '1' -- 37
left join SDI.SDI_T001_1001 D3 on T.COMP_CODE = D3.BUKRS -- 178
left join DWRFIN.DWR_FIN_CSKT_TMP D4 -- 17126
on T.COSTCENTER = D4.KOSTL
left join SDI.SDI_SKAT_1001 D6 -- 95108
on T.GL_ACCOUNT = D6.SAKNR
and D6.KTOPL = 'CNDP'
left join SDI.SDI_SKAT_1001 D7 -- 95108
on T.GL_ACCOUNT = D7.SAKNR
and D7.KTOPL = 'CND1'
left join DWRFIN.DWR_FIN_QCOSTCENTER_TMP D13 on T.COSTCENTER = D13.COSTCENTER
where T.`/BIC/ZDATAINDX` = 'T'
and T.CHRT_ACCTS = 'CNDP'
and substr(T.FISCPER, 1, 4) || '-' || substr(T.FISCPER, 6, 2) >= '${PERIOD_ID_M}'
)
insert overwrite table DWRFIN.DWR_FIN_COST_D_COMPRE_SUBJ_TMP1
select
 T1.YEAR as year -- 年
,T1.MONTH as month -- 月份
,'' as VOUCHER_DATE -- 凭证日期	
,'' as POSTING_DATE -- 过账日期
,'' as FIN_VOUCHER_CODE -- 财务凭证号
,'' as FIN_VOUCHER_LINE_CODE -- 财务凭证行
,'' as VOUCHER_TYPE_CODE -- 凭证类型	
,T1.COST_CENTER_CODE as COST_CENTER_CODE -- 成本中心编码
,T1.COST_CENTER_DESC as COST_CENTER_DESC -- 成本中心描述
,T1.FUNC_SCOPE_CODE as FUNC_SCOPE_CODE -- 功能范围编码
,T1.FUNC_SCOPE_NAME as FUNC_SCOPE_NAME -- 功能范围名称
,T1.COMP_CODE as COMP_CODE -- 公司代码
,T1.COMP_DESC as COMP_DESC -- 公司代码描述
,T1.SALES_GROUP_CODE as SALES_GROUP_CODE -- 成本中心的销售组
,D16.BEZEI as SALES_GROUP_DESC -- 销售组描述	
,'' as WBS -- WBS号
,'' as WBS_DESC -- WBS号描述
,T1.GENERAL_LEDGER_ACCOUNT as GENERAL_LEDGER_ACCOUNT -- 总账科目
,T1.GENERAL_LEDGER_ACCOUNT_DESC as GENERAL_LEDGER_ACCOUNT_DESC -- 总账科目描述
,'' as SALES_ORG_CODE -- 销售组织
,'' as CHANNEL_CODE -- 渠道		
,'' as MATERIAL_CODE -- 物料编码
,'' as MATERIAL_DESC -- 物料描述
,'' as CUST_CODE -- 客户编码	
,'' as CUST_NAME -- 客户名称
,'' as SUPPLIER_CODE -- 供应商编码
,'' as SUPPLIER_NAME -- 供应商名称
,0 as QTY -- 数量
,0 as LOCAL_CURRENCY_AMT -- 费用本币金额	
,T1.MANUAL_ADJUST_AMT as MANUAL_ADJUST_AMT -- 费用手工调整值
,0 + T1.MANUAL_ADJUST_AMT as SUM_AMT -- 费用合计
,0 as ORIGIN_CURRENCY_AMT -- 费用原币金额
,T1.LOCAL_CURRENCY_UNIT as LOCAL_CURRENCY_UNIT -- 本币单位
,'' as ORIGIN_CURRENCY_UNIT -- 原币单位
,'' as MATERIAL_VOUCHER_CODE -- 物料凭证
,'' as PROFIT_CENTER_CODE -- 利润中心编码
,'' as PROFIT_CENTER_DESC -- 利润中心描述
,current_timestamp () as DW_LAST_UPDATE_DATE -- 数据同步时间	
from AZFISGD1 T1
left join SDI.SDI_TVGRT_1001 D16 -- 1630 
on T1.SALES_GROUP_CODE = D16.VKGRP -- 销售组
and D16.SPRAS = '1';

create table if not exists DWRFIN.DWR_FIN_COST_D_COMPRE_SUBJ_TMP2 (
		GJAHR string comment '年',
		FISCYEARPER string comment '月份',
		BLDAT date comment '凭证日期',
		BUDAT date comment '过账日期',
		BELNR string comment '财务凭证号',
		BUZEI string comment '财务凭证行',
		BLART string comment '凭证类型',
		RCNTR string comment '成本中心编码',
		LTEXT string comment '成本中心描述',
		RFAREA string comment '功能范围编码',
		FKBTX string comment '功能范围名称',
		RBUKRS string comment '公司代码',
		BUTXT string comment '公司代码描述',
		VKGRP_PA string comment '销售组编码',
		--sales_group_desc string COMMENT '销售组描述',
		PS_POSID string comment 'WBS号',
		--wbs_desc string COMMENT 'WBS号描述',
		RACCT string comment '总账科目',
		TXT20 string comment '总账科目描述',
		VKORG string comment '销售组织',
		VTWEG string comment '渠道',
		MATNR string comment '物料编码',
		MAKTX string comment '物料描述',
		KUNNR string comment '客户编码',
		--cust_name string COMMENT '客户名称',
		LIFNR string comment '供应商编码',
		NAME1 string comment '供应商名称',
		MSL string comment '数量',
		HSL decimal(26, 10) comment '费用本币金额',
		manual_adjust_amt decimal(38,10) COMMENT '费用手工调整值',
		--sum_amt decimal(26,10) COMMENT '费用合计',
		WSL decimal(26, 10) comment '费用原币金额',
		RHCUR string comment '本币单位',
		RWCUR string comment '原币单位',
		AWREF string comment '物料凭证',
		PRCTR string comment '利润中心编码',
		KTEXT string comment '利润中心描述',
		CUST_GROUP_CODE string comment '客户组', --20241019新增字段
		ITEM_TEXT string comment '行项目文本',
		ALLOCATION string comment '分配',
		ORDER_NUM string comment '订单号'
		--dw_last_update_date date COMMENT '数据同步时间'
	) comment '费用明细、综合科目表临时表2';

with tmp0 as (
select substr(zcost_center,5,10) as ZZ from dwimd.dwi_md_cost_center_info_t 
where cost_center_code_4 like '%GWEA%' or cost_center_code_4 like '%GCFE%'
)
,tmp as (
select T.BELNR||T.GJAHR||T.RBUKRS as AA
from SDI.SDI_ACDOCA_1001 T 
where T.BUDAT <> '' and T.BUDAT <> '00000000'
and T.RCNTR in (select ZZ from tmp0) 
and T.PERIOD_ID_M >= '202604'
and T.PERIOD_ID_M >= substr('${PERIOD_ID_M}',1,4)||substr('${PERIOD_ID_M}',6,2)
group by T.BELNR||T.GJAHR||T.RBUKRS
)
,tmp1 as (
select T.BELNR||T.GJAHR||T.RBUKRS as AA 
from SDI.SDI_ACDOCA_1001 T 
where T.BELNR||T.GJAHR||T.RBUKRS IN (select AA from tmp )
and T.PERIOD_ID_M >= substr('${PERIOD_ID_M}',1,4)||substr('${PERIOD_ID_M}',6,2)
group by T.BELNR||T.GJAHR||T.RBUKRS having sum(case when substr(T.RACCT,1,3) in ('004','006') then 1 else 0 end) = count(*)
)
,tmp2 as (
select T.BELNR||T.GJAHR||T.RBUKRS AS BB
FROM SDI.SDI_ACDOCA_1001 T 
WHERE T.BELNR||T.GJAHR||T.RBUKRS IN (select AA from tmp )
and T.PERIOD_ID_M >= substr('${PERIOD_ID_M}',1,4)||substr('${PERIOD_ID_M}',6,2)
group by T.BELNR||T.GJAHR||T.RBUKRS having sum(case when substr(T.RACCT,1,3) in ('004','006') then 1 else 0 end) < count(*)
)
--WITH ACDOCA AS (
insert overwrite table DWRFIN.DWR_FIN_COST_D_COMPRE_SUBJ_TMP2
select
 T.GJAHR -- 年
,substr(T.FISCYEARPER, 1, 4) || '-' || substr(T.FISCYEARPER, 6, 2) FISCYEARPER -- 月份
,to_date(from_unixtime(unix_timestamp(T.BLDAT, 'yyyyMMdd'))) BLDAT -- 凭证日期	
,to_date(from_unixtime(unix_timestamp(T.BUDAT, 'yyyyMMdd'))) BUDAT -- 过账日期
,T.BELNR -- 财务凭证号
,T.BUZEI -- 财务凭证行
,T.BLART -- 凭证类型
,T.RCNTR -- 成本中心编码
,D4.LTEXT -- 成本中心描述
,T.RFAREA -- 功能范围编码
,D1.FKBTX -- 功能范围名称
,T.RBUKRS -- 公司代码
,D3.BUTXT -- 公司代码描述
,T.VKGRP_PA -- 销售组编码
,T.PS_POSID -- WBS	
,T.RACCT -- 总账科目
,case  when D6.TXT20 <> ''
		or D6.TXT20 is not null then D6.TXT20
		else D7.TXT20
	end TXT20 -- 总账科目描述
,T.VKORG -- 销售组织
,T.VTWEG -- 渠道
,T.MATNR -- 物料编码
,D8.MAKTX -- 物料描述	
,T.KUNNR -- 客户编码
,T.LIFNR -- 供应商编码
,D9.NAME1 -- 供应商名称
,T.MSL -- 数量
,T.HSL -- 费用本币金额
,0 AS MANUAL_ADJUST_AMT --费用手工调整
,T.WSL -- 费用原币金额
,T.RHCUR -- 本币单位
,T.RWCUR -- 原币单位
,T.AWREF -- 物料凭证
,T.PRCTR -- 利润中心编码
,D2.KTEXT -- 利润中心描述
,T.KDGRP as CUST_GROUP_CODE --客户组(20240119新增)
,T.SGTXT as ITEM_TEXT --行项目文本
,T.ZUONR as ALLOCATION --分配
,T.KDAUF as ORDER_NUM --订单号
from SDI.SDI_ACDOCA_1001 T
left join SDI.SDI_TFKBT_1001 D1 on T.RFAREA = D1.FKBER
and D1.SPRAS = '1' -- 37
left join SDI.SDI_CEPCT_1001 D2 -- 100
on T.PRCTR = D2.PRCTR
and D2.KOKRS = 'DP00'
left join SDI.SDI_T001_1001 D3 on T.RBUKRS = D3.BUKRS -- 178
left join DWRFIN.DWR_FIN_CSKT_TMP D4 -- 17126
on T.RCNTR = D4.KOSTL
left join SDI.SDI_LFA1_1001 D9 -- 44001
on T.LIFNR = D9.LIFNR
left join SDI.SDI_SKAT_1001 D6 -- 95108
on T.RACCT = D6.SAKNR
and D6.KTOPL = 'CNDP'
left join SDI.SDI_SKAT_1001 D7 -- 95108
on T.RACCT = D7.SAKNR
and D7.KTOPL = 'CND1'
left join SDI.SDI_MAKT_1001 D8 -- 196187
on T.MATNR = D8.MATNR
and D8.SPRAS = '1'
where  T.KOART = 'S'
and T.BUDAT <> ''
and T.BUDAT <> '00000000'
and concat(substr(budat, 1, 4), '-', substr(budat, 5, 2)) >= '${PERIOD_ID_M}'
and (T.RACCT NOT IN ('0054010600','0054010700')
or (T.RACCT IN ('0054010600','0054010700') AND T.USNAM <> 'TMS'))
union all --研发费用还原生产成本或制造费用
select
 T.GJAHR -- 年
,substr(T.FISCYEARPER, 1, 4) || '-' || substr(T.FISCYEARPER, 6, 2) FISCYEARPER -- 月份
,to_date(from_unixtime(unix_timestamp(T.BLDAT, 'yyyyMMdd'))) BLDAT -- 凭证日期	
,to_date(from_unixtime(unix_timestamp(T.BUDAT, 'yyyyMMdd'))) BUDAT -- 过账日期
,T.BELNR -- 财务凭证号
,T.BUZEI -- 财务凭证行
,T.BLART -- 凭证类型
,T.RCNTR -- 成本中心编码
,D4.LTEXT -- 成本中心描述
,CASE WHEN T.RCNTR <> '' THEN T.RFAREA ELSE '4101' END AS RFAREA -- 功能范围编码
,D1.FKBTX -- 功能范围名称
,T.RBUKRS -- 公司代码
,D3.BUTXT -- 公司代码描述
,T.VKGRP_PA -- 销售组编码
,T.PS_POSID -- WBS	
,T.RACCT -- 总账科目
,case  when D6.TXT20 <> ''
		or D6.TXT20 is not null then D6.TXT20
		else D7.TXT20
	end TXT20 -- 总账科目描述
,T.VKORG -- 销售组织
,T.VTWEG -- 渠道
,T.MATNR -- 物料编码
,D8.MAKTX -- 物料描述	
,T.KUNNR -- 客户编码
,T.LIFNR -- 供应商编码
,D9.NAME1 -- 供应商名称
,-T.MSL -- 数量
,0 AS HSL -- 费用本币金额
,-T.HSL AS MANUAL_ADJUST_AMT --费用手工调整
,0 AS WSL -- 费用原币金额
,T.RHCUR -- 本币单位
,T.RWCUR -- 原币单位
,T.AWREF -- 物料凭证
,T.PRCTR -- 利润中心编码
,D2.KTEXT -- 利润中心描述
,T.KDGRP as CUST_GROUP_CODE --客户组(20240119新增)
,T.SGTXT as ITEM_TEXT --行项目文本
,T.ZUONR as ALLOCATION --分配
,T.KDAUF as ORDER_NUM --订单号
from SDI.SDI_ACDOCA_1001 T
left join SDI.SDI_TFKBT_1001 D1 
on CASE WHEN RCNTR <> '' THEN T.RFAREA ELSE '4101' END = D1.FKBER
and D1.SPRAS = '1' -- 37
left join SDI.SDI_CEPCT_1001 D2 -- 100
on T.PRCTR = D2.PRCTR
and D2.KOKRS = 'DP00'
left join SDI.SDI_T001_1001 D3 on T.RBUKRS = D3.BUKRS -- 178
left join DWRFIN.DWR_FIN_CSKT_TMP D4 -- 17126
on T.RCNTR = D4.KOSTL
left join SDI.SDI_LFA1_1001 D9 -- 44001
on T.LIFNR = D9.LIFNR
left join SDI.SDI_SKAT_1001 D6 -- 95108
on T.RACCT = D6.SAKNR
and D6.KTOPL = 'CNDP'
left join SDI.SDI_SKAT_1001 D7 -- 95108
on T.RACCT = D7.SAKNR
and D7.KTOPL = 'CND1'
left join SDI.SDI_MAKT_1001 D8 -- 196187
on T.MATNR = D8.MATNR
and D8.SPRAS = '1'
WHERE T.PERIOD_ID_M >= substr('${PERIOD_ID_M}',1,4)||substr('${PERIOD_ID_M}',6,2)
and T.BELNR||T.GJAHR||T.RBUKRS in (SELECT AA FROM TMP1)
union all --研发费用还原生产成本或制造费用
select
 T.GJAHR -- 年
,substr(T.FISCYEARPER, 1, 4) || '-' || substr(T.FISCYEARPER, 6, 2) FISCYEARPER -- 月份
,to_date(from_unixtime(unix_timestamp(T.BLDAT, 'yyyyMMdd'))) BLDAT -- 凭证日期	
,to_date(from_unixtime(unix_timestamp(T.BUDAT, 'yyyyMMdd'))) BUDAT -- 过账日期
,T.BELNR -- 财务凭证号
,T.BUZEI -- 财务凭证行
,T.BLART -- 凭证类型
,T.RCNTR -- 成本中心编码
,D4.LTEXT -- 成本中心描述
,CASE WHEN T.RCNTR <> '' THEN T.RFAREA ELSE '4101' END AS RFAREA -- 功能范围编码
,D1.FKBTX -- 功能范围名称
,T.RBUKRS -- 公司代码
,D3.BUTXT -- 公司代码描述
,T.VKGRP_PA -- 销售组编码
,T.PS_POSID -- WBS	
,T.RACCT -- 总账科目
,case  when D6.TXT20 <> ''
		or D6.TXT20 is not null then D6.TXT20
		else D7.TXT20
	end TXT20 -- 总账科目描述
,T.VKORG -- 销售组织
,T.VTWEG -- 渠道
,T.MATNR -- 物料编码
,D8.MAKTX -- 物料描述	
,T.KUNNR -- 客户编码
,T.LIFNR -- 供应商编码
,D9.NAME1 -- 供应商名称
,-T.MSL -- 数量
,0 AS HSL -- 费用本币金额
,-T.HSL AS MANUAL_ADJUST_AMT --费用手工调整
,0 AS WSL -- 费用原币金额
,T.RHCUR -- 本币单位
,T.RWCUR -- 原币单位
,T.AWREF -- 物料凭证
,T.PRCTR -- 利润中心编码
,D2.KTEXT -- 利润中心描述
,T.KDGRP as CUST_GROUP_CODE --客户组(20240119新增)
,T.SGTXT as ITEM_TEXT --行项目文本
,T.ZUONR as ALLOCATION --分配
,T.KDAUF as ORDER_NUM --订单号
from SDI.SDI_ACDOCA_1001 T
left join SDI.SDI_TFKBT_1001 D1 
on CASE WHEN RCNTR <> '' THEN T.RFAREA ELSE '4101' END = D1.FKBER
and D1.SPRAS = '1' -- 37
left join SDI.SDI_CEPCT_1001 D2 -- 100
on T.PRCTR = D2.PRCTR
and D2.KOKRS = 'DP00'
left join SDI.SDI_T001_1001 D3 on T.RBUKRS = D3.BUKRS -- 178
left join DWRFIN.DWR_FIN_CSKT_TMP D4 -- 17126
on T.RCNTR = D4.KOSTL
left join SDI.SDI_LFA1_1001 D9 -- 44001
on T.LIFNR = D9.LIFNR
left join SDI.SDI_SKAT_1001 D6 -- 95108
on T.RACCT = D6.SAKNR
and D6.KTOPL = 'CNDP'
left join SDI.SDI_SKAT_1001 D7 -- 95108
on T.RACCT = D7.SAKNR
and D7.KTOPL = 'CND1'
left join SDI.SDI_MAKT_1001 D8 -- 196187
on T.MATNR = D8.MATNR
and D8.SPRAS = '1'
join tmp0 D10
on T.RCNTR = D10.ZZ
WHERE T.PERIOD_ID_M >= substr('${PERIOD_ID_M}',1,4)||substr('${PERIOD_ID_M}',6,2)
and T.BELNR||T.GJAHR||T.RBUKRS in (SELECT BB FROM TMP2) 
-- and T.RCNTR in (select ZZ from tmp0) 
union all --研发费用还原生产成本或制造费用
select
 T.GJAHR -- 年
,substr(T.FISCYEARPER, 1, 4) || '-' || substr(T.FISCYEARPER, 6, 2) FISCYEARPER -- 月份
,to_date(from_unixtime(unix_timestamp(T.BLDAT, 'yyyyMMdd'))) BLDAT -- 凭证日期	
,to_date(from_unixtime(unix_timestamp(T.BUDAT, 'yyyyMMdd'))) BUDAT -- 过账日期
,T.BELNR -- 财务凭证号
,T.BUZEI -- 财务凭证行
,T.BLART -- 凭证类型
,'' as RCNTR  -- 成本中心编码
,'' as LTEXT-- 成本中心描述
,'4101' AS RFAREA -- 功能范围编码
,D1.FKBTX -- 功能范围名称
,T.RBUKRS -- 公司代码
,D3.BUTXT -- 公司代码描述
,T.VKGRP_PA -- 销售组编码
,T.PS_POSID -- WBS	
,T.RACCT -- 总账科目
,case  when D6.TXT20 <> ''
		or D6.TXT20 is not null then D6.TXT20
		else D7.TXT20
	end TXT20 -- 总账科目描述
,T.VKORG -- 销售组织
,T.VTWEG -- 渠道
,T.MATNR -- 物料编码
,D8.MAKTX -- 物料描述	
,T.KUNNR -- 客户编码
,T.LIFNR -- 供应商编码
,D9.NAME1 -- 供应商名称
,T.MSL -- 数量
,0 AS HSL -- 费用本币金额
,T.HSL AS MANUAL_ADJUST_AMT --费用手工调整
,0 AS WSL -- 费用原币金额
,T.RHCUR -- 本币单位
,T.RWCUR -- 原币单位
,T.AWREF -- 物料凭证
,T.PRCTR -- 利润中心编码
,D2.KTEXT -- 利润中心描述
,T.KDGRP as CUST_GROUP_CODE --客户组(20240119新增)
,T.SGTXT as ITEM_TEXT --行项目文本
,T.ZUONR as ALLOCATION --分配
,T.KDAUF as ORDER_NUM --订单号
from SDI.SDI_ACDOCA_1001 T
left join SDI.SDI_TFKBT_1001 D1 
on  D1.FKBER = '4101'
and D1.SPRAS = '1' -- 37
left join SDI.SDI_CEPCT_1001 D2 -- 100
on T.PRCTR = D2.PRCTR
and D2.KOKRS = 'DP00'
left join SDI.SDI_T001_1001 D3 on T.RBUKRS = D3.BUKRS -- 178
-- left join DWRFIN.DWR_FIN_CSKT_TMP D4 -- 17126
-- on T.RCNTR = D4.KOSTL
left join SDI.SDI_LFA1_1001 D9 -- 44001
on T.LIFNR = D9.LIFNR
left join SDI.SDI_SKAT_1001 D6 -- 95108
on T.RACCT = D6.SAKNR
and D6.KTOPL = 'CNDP'
left join SDI.SDI_SKAT_1001 D7 -- 95108
on T.RACCT = D7.SAKNR
and D7.KTOPL = 'CND1'
left join SDI.SDI_MAKT_1001 D8 -- 196187
on T.MATNR = D8.MATNR
and D8.SPRAS = '1'
join tmp0 D10
on T.RCNTR = D10.ZZ
WHERE T.PERIOD_ID_M >= substr('${PERIOD_ID_M}',1,4)||substr('${PERIOD_ID_M}',6,2)
and T.BELNR||T.GJAHR||T.RBUKRS in (SELECT BB FROM TMP2) 
-- and T.RCNTR in (select ZZ from tmp0) 
;

create table if not exists DWRFIN.DWR_FIN_COST_D_COMPRE_SUBJ_TMP3 (
		GJAHR string comment '年',
		FISCYEARPER string comment '月份',
		BLDAT date comment '凭证日期',
		BUDAT date comment '过账日期',
		BELNR string comment '财务凭证号',
		BUZEI string comment '财务凭证行',
		BLART string comment '凭证类型',
		RCNTR string comment '成本中心编码',
		LTEXT string comment '成本中心描述',
		RFAREA string comment '功能范围编码',
		FKBTX string comment '功能范围名称',
		RBUKRS string comment '公司代码',
		BUTXT string comment '公司代码描述',
		VKGRP_PA string comment '销售组编码',
		--sales_group_desc string COMMENT '销售组描述',
		PS_POSID string comment 'WBS号',
		POST1 string comment 'WBS号描述',
		RACCT string comment '总账科目',
		TXT20 string comment '总账科目描述',
		VKORG string comment '销售组织',
		VTWEG string comment '渠道',
		MATNR string comment '物料编码',
		MAKTX string comment '物料描述',
		KUNNR string comment '客户编码',
		CUST_NAME string comment '客户名称',
		LIFNR string comment '供应商编码',
		SUPPLIER_NAME string comment '供应商名称',
		MSL string comment '数量',
		HSL decimal(26, 10) comment '费用本币金额',
		--sum_amt decimal(26,10) COMMENT '费用合计',
		WSL decimal(26, 10) comment '费用原币金额',
		RHCUR string comment '本币单位',
		RWCUR string comment '原币单位',
		AWREF string comment '物料凭证',
		PRCTR string comment '利润中心编码',
		KTEXT string comment '利润中心描述',
		PSPHI string comment '项目号',
		VKGRP string comment '客户主档的销售组',
		SALES_GRP string comment '成本中心的销售组',
		CUST_GROUP_CODE string comment '客户组', --20241019新增字段
		ITEM_TEXT string comment '行项目文本',
		ALLOCATION string comment '分配',
		ORD_SALES_GRP string comment '销售订单的销售组',
		manual_adjust_amt decimal(26,10) COMMENT '费用手工调整值'
		--dw_last_update_date date COMMENT '数据同步时间'
	) comment '费用明细、综合科目表临时表3';


--WITH ACDOCA AS (
insert overwrite table DWRFIN.DWR_FIN_COST_D_COMPRE_SUBJ_TMP3
	--ACDOCA1 AS (
select
 T1.GJAHR -- 年
,T1.FISCYEARPER -- 月份
,T1.BLDAT -- 凭证日期	
,T1.BUDAT -- 过账日期
,T1.BELNR -- 财务凭证号
,T1.BUZEI -- 财务凭证行
,T1.BLART -- 凭证类型
,T1.RCNTR -- 成本中心编码
,T1.LTEXT -- 成本中心描述
,T1.RFAREA -- 功能范围编码
,T1.FKBTX -- 功能范围名称
,T1.RBUKRS -- 公司代码
,T1.BUTXT -- 公司代码描述	
,T1.VKGRP_PA -- 销售组编码
,T1.PS_POSID -- WBS
,D11.POST1 -- wbs号描述
,T1.RACCT -- 总账科目
,T1.TXT20 -- 总账科目描述
,T1.VKORG -- 销售组织
,T1.VTWEG -- 渠道		
,T1.MATNR -- 物料编码
,T1.MAKTX -- 物料描述
,T1.KUNNR -- 客户编码	
,D12.NAME1 as CUST_NAME -- 客户名称
,T1.LIFNR -- 供应商编码
,T1.NAME1 as SUPPLIER_NAME -- 供应商名称
,T1.MSL -- 数量
,T1.HSL -- 费用本币金额
,T1.WSL -- 费用原币金额
,T1.RHCUR -- 本币单位
,T1.RWCUR -- 原币单位
,T1.AWREF -- 物料凭证
,T1.PRCTR -- 利润中心编码
,T1.KTEXT -- 利润中心描述
,D11.PSPHI -- 项目号
--,D15.ZVKGRP     					-- WBS-销售组
,D14.VKGRP -- 客户主档的销售组
,D13.SALES_GRP -- 成本中心的销售组
,case when ( T1.CUST_GROUP_CODE is not null and T1.CUST_GROUP_CODE <> '') then t1.CUST_GROUP_CODE else D14.KDGRP
	end as CUST_GROUP_CODE --客户组（20241019新增字段）
,T1.ITEM_TEXT --行项目文本
,T1.ALLOCATION --分配
,D15.VKGRP as ORD_SALES_GRP ---销售订单上的销售组
,T1.MANUAL_ADJUST_AMT --费用手工调整
from DWRFIN.DWR_FIN_COST_D_COMPRE_SUBJ_TMP2 T1
left join SDI.SDI_KNA1_1001 D12 -- 17781
on T1.KUNNR = D12.KUNNR
left join DWRFIN.DWR_FIN_QCOSTCENTER_TMP D13 on T1.RCNTR = D13.COSTCENTER
left join SDI.SDI_KNVV_1001 D14 -- 38690 
on T1.KUNNR = D14.KUNNR
and T1.VKORG = D14.VKORG
and T1.VTWEG = D14.VTWEG
left join SDI.SDI_PRPS_1001 D11 -- 644958
on case when T1.PS_POSID = '00000000' OR COALESCE(T1.PS_POSID,'') = '' then concat(rand(10),'#*#')  else T1.PS_POSID end = D11.POSID
left join SDI.sdi_vbak_1001 D15 on case when T1.ORDER_NUM = '' then concat(rand(10),'#*#') else T1.ORDER_NUM end = D15.VBELN;

-- 2月份tms与sap的差异数据
insert OVERWRITE table    DWRFIN.DWR_FIN_COST_D_COMPRE_SUBJ_T_00
select '2025', '2025-02', NULL, NULL, '1300003135', '', 'SA', '107AKA0006', '', '', '', '1000', '', '', '', '', '', '0054010600', '', '', '', '', '', '', '', '', '', NULL, 10157.842, NULL, 10157.842, NULL, '', '', '', '', '', NULL, '', '', '', '', ''
union all 
select '2025', '2025-02', NULL, NULL, '1300003519', '', 'SA', '107AKA0060', '', '', '', '1000', '', '', '', '', '', '0054010600', '', '', '', '', '', '', '', '', '', NULL, 5873.7791, NULL, 5873.7791, NULL, '', '', '', '', '', NULL, '', '', '', '', ''
union all 
select '2025', '2025-02', NULL, NULL, '1300003521', '', 'SA', '107AKA0012', '', '', '', '1000', '', '', '', '', '', '0054010600', '', '', '', '', '', '', '', '', '', NULL, 21090.0678, NULL, 21090.0678, NULL, '', '', '', '', '', NULL, '', '', '', '', ''
union all 
select '2025', '2025-02', NULL, NULL, '1300003523', '', 'SA', '107AKA0007', '', '', '', '1000', '', '', '', '', '', '0054010600', '', '', '', '', '', '', '', '', '', NULL, 10686.2328, NULL, 10686.2328, NULL, '', '', '', '', '', NULL, '', '', '', '', ''
union all 
select '2025', '2025-02', NULL, NULL, '1300003529', '', 'SA', '107AKA0011', '', '', '', '1000', '', '', '', '', '', '0054010600', '', '', '', '', '', '', '', '', '', NULL, 2466.0575, NULL, 2466.0575, NULL, '', '', '', '', '', NULL, '', '', '', '', ''
union all 
select '2025', '2025-02', NULL, NULL, '1300003533', '', 'SA', '107AKA0065', '', '', '', '1000', '', '', '', '', '', '0054010600', '', '', '', '', '', '', '', '', '', NULL, 4195.1784, NULL, 4195.1784, NULL, '', '', '', '', '', NULL, '', '', '', '', ''
union all 
select '2025', '2025-02', NULL, NULL, '1300003537', '', 'SA', '107AKA0061', '', '', '', '1000', '', '', '', '', '', '0054010600', '', '', '', '', '', '', '', '', '', NULL, 2868.2545, NULL, 2868.2545, NULL, '', '', '', '', '', NULL, '', '', '', '', ''
union all 
select '2025', '2025-02', NULL, NULL, '1300000189', '', 'SA', '3338QA0001', '', '', '', '3300', '', '', '', '', '', '0054010600', '', '', '', '', '', '', '', '', '', NULL, 0.3737, NULL, 0.3737, NULL, '', '', '', '', '', NULL, '', '', '', '', ''
union all 
select '2025', '2025-02', NULL, NULL, '1300000416', '', 'SA', '8383DA0031', '', '', '', '8300', '', '', '', '', '', '0054010600', '', '', '', '', '', '', '', '', '', NULL, 0.1859, NULL, 0.1859, NULL, '', '', '', '', '', NULL, '', '', '', '', ''
union all 
select '2025', '2025-02', NULL, NULL, '1300000417', '', 'SA', '8383DA0030', '', '', '', '8300', '', '', '', '', '', '0054010600', '', '', '', '', '', '', '', '', '', NULL, 0.128, NULL, 0.128, NULL, '', '', '', '', '', NULL, '', '', '', '', ''
union all 
select '2025', '2025-02', NULL, NULL, '1300000417', '', 'SA', '8383DA0031', '', '', '', '8300', '', '', '', '', '', '0054010600', '', '', '', '', '', '', '', '', '', NULL, 0.2001, NULL, 0.2001, NULL, '', '', '', '', '', NULL, '', '', '', '', ''
union all 
select '2025', '2025-02', NULL, NULL, '1300000418', '', 'SA', '8383DA0031', '', '', '', '8300', '', '', '', '', '', '0054010600', '', '', '', '', '', '', '', '', '', NULL, 0.1816, NULL, 0.1816, NULL, '', '', '', '', '', NULL, '', '', '', '', ''
union all 
select '2025', '2025-02', NULL, NULL, '1300000419', '', 'SA', '8383DA0031', '', '', '', '8300', '', '', '', '', '', '0054010600', '', '', '', '', '', '', '', '', '', NULL, 0.1418, NULL, 0.1418, NULL, '', '', '', '', '', NULL, '', '', '', '', ''
union all 
select '2025', '2025-02', NULL, NULL, '1300000439', '', 'SA', '8383DA0030', '', '', '', '8300', '', '', '', '', '', '0054010600', '', '', '', '', '', '', '', '', '', NULL, 0.1772, NULL, 0.1772, NULL, '', '', '', '', '', NULL, '', '', '', '', ''
union all 
select '2025', '2025-02', NULL, NULL, '1300000439', '', 'SA', '8383DA0031', '', '', '', '8300', '', '', '', '', '', '0054010600', '', '', '', '', '', '', '', '', '', NULL, 0.2322, NULL, 0.2322, NULL, '', '', '', '', '', NULL, '', '', '', '', ''
union all 
select '2025', '2025-02', NULL, NULL, '1300000440', '', 'SA', '8383DA0030', '', '', '', '8300', '', '', '', '', '', '0054010600', '', '', '', '', '', '', '', '', '', NULL, 0.2006, NULL, 0.2006, NULL, '', '', '', '', '', NULL, '', '', '', '', ''
union all 
select '2025', '2025-02', NULL, NULL, '1300000440', '', 'SA', '8383DA0031', '', '', '', '8300', '', '', '', '', '', '0054010600', '', '', '', '', '', '', '', '', '', NULL, 0.4283, NULL, 0.4283, NULL, '', '', '', '', '', NULL, '', '', '', '', ''
union all 
select '2025', '2025-02', NULL, NULL, '1300000444', '', 'SA', '8585DA0001', '', '', '', '8500', '', '', '', '', '', '0054010600', '', '', '', '', '', '', '', '', '', NULL, -0.0573, NULL, -0.0573, NULL, '', '', '', '', '', NULL, '', '', '', '', ''
union all 
select '2025', '2025-02', NULL, NULL, '1300000445', '', 'SA', '8585DA0016', '', '', '', '8500', '', '', '', '', '', '0054010600', '', '', '', '', '', '', '', '', '', NULL, 0.0356, NULL, 0.0356, NULL, '', '', '', '', '', NULL, '', '', '', '', ''
union all 
select '2025', '2025-02', NULL, NULL, '1300000449', '', 'SA', '8585DA0001', '', '', '', '8500', '', '', '', '', '', '0054010600', '', '', '', '', '', '', '', '', '', NULL, 0.1316, NULL, 0.1316, NULL, '', '', '', '', '', NULL, '', '', '', '', ''
union all 
select '2025', '2025-02', NULL, NULL, '1300000450', '', 'SA', '8585DA0001', '', '', '', '8500', '', '', '', '', '', '0054010600', '', '', '', '', '', '', '', '', '', NULL, -0.0542, NULL, -0.0542, NULL, '', '', '', '', '', NULL, '', '', '', '', ''
union all 
select '2025', '2025-02', NULL, NULL, '1300001504', '', 'SA', '8A81TA0001', '', '', '', '8A00', '', '', '', '', '', '0054010600', '', '', '', '', '', '', '', '', '', NULL, 73.4013, NULL, 73.4013, NULL, '', '', '', '', '', NULL, '', '', '', '', ''
union all 
select '2025', '2025-02', NULL, NULL, '1300000420', '', 'SA', '8383DA0030', '', '', '', '8300', '', '', '', '', '', '0054010700', '', '', '', '', '', '', '', '', '', NULL, 0.3227, NULL, 0.3227, NULL, '', '', '', '', '', NULL, '', '', '', '', ''
union all 
select '2025', '2025-02', NULL, NULL, '1300000443', '', 'SA', '8383DA0030', '', '', '', '8300', '', '', '', '', '', '0054010700', '', '', '', '', '', '', '', '', '', NULL, 0.1449, NULL, 0.1449, NULL, '', '', '', '', '', NULL, '', '', '', '', ''
union all 
select '2025', '2025-02', NULL, NULL, '1300000444', '', 'SA', '8585DA0001', '', '', '', '8500', '', '', '', '', '', '0054010700', '', '', '', '', '', '', '', '', '', NULL, 0.1495, NULL, 0.1495, NULL, '', '', '', '', '', NULL, '', '', '', '', ''
union all 
select '2025', '2025-02', NULL, NULL, '1300000445', '', 'SA', '8585DA0016', '', '', '', '8500', '', '', '', '', '', '0054010700', '', '', '', '', '', '', '', '', '', NULL, 0.151, NULL, 0.151, NULL, '', '', '', '', '', NULL, '', '', '', '', ''
union all 
select '2025', '2025-02', NULL, NULL, '1300000449', '', 'SA', '8585DA0001', '', '', '', '8500', '', '', '', '', '', '0054010700', '', '', '', '', '', '', '', '', '', NULL, -0.0283, NULL, -0.0283, NULL, '', '', '', '', '', NULL, '', '', '', '', ''
union all 
select '2025', '2025-02', NULL, NULL, '1300000450', '', 'SA', '8585DA0001', '', '', '', '8500', '', '', '', '', '', '0054010700', '', '', '', '', '', '', '', '', '', NULL, 0.1805, NULL, 0.1805, NULL, '', '', '', '', '', NULL, '', '', '', '', ''
union all 
select '2025', '2025-02', NULL, NULL, '1300000455', '', 'SA', '8585DA0016', '', '', '', '8500', '', '', '', '', '', '0054010700', '', '', '', '', '', '', '', '', '', NULL, 0.1495, NULL, 0.1495, NULL, '', '', '', '', '', NULL, '', '', '', '', ''
union all 
select '2025', '2025-02', NULL, NULL, '1300000488', '', 'SA', '8888DA0013', '', '', '', '8800', '', '', '', '', '', '0054010700', '', '', '', '', '', '', '', '', '', NULL, 0.5064, NULL, 0.5064, NULL, '', '', '', '', '', NULL, '', '', '', '', ''
union all 
select '2025', '2025-02', NULL, NULL, '1300000488', '', 'SA', '8888DA0025', '', '', '', '8800', '', '', '', '', '', '0054010700', '', '', '', '', '', '', '', '', '', NULL, 0.2528, NULL, 0.2528, NULL, '', '', '', '', '', NULL, '', '', '', '', '';

create table if not exists DWRFIN.DWR_FIN_COST_D_COMPRE_SUBJ_T_01 (
		year string comment '年',
		month string comment '月份',
		voucher_date date comment '凭证日期',
		posting_date date comment '过账日期',
		fin_voucher_code string comment '财务凭证号',
		fin_voucher_line_code string comment '财务凭证行',
		voucher_type_code string comment '凭证类型',
		cost_center_code string comment '成本中心编码',
		cost_center_desc string comment '成本中心描述',
		func_scope_code string comment '功能范围编码',
		func_scope_name string comment '功能范围名称',
		comp_code string comment '公司代码',
		comp_desc string comment '公司代码描述',
		sales_group_code string comment '销售组编码',
		sales_group_desc string comment '销售组描述',
		wbs string comment 'WBS号',
		wbs_desc string comment 'WBS号描述',
		general_ledger_account string comment '总账科目',
		general_ledger_account_desc string comment '总账科目描述',
		sales_org_code string comment '销售组织',
		channel_code string comment '渠道',
		material_code string comment '物料编码',
		material_desc string comment '物料描述',
		cust_code string comment '客户编码',
		cust_name string comment '客户名称',
		supplier_code string comment '供应商编码',
		supplier_name string comment '供应商名称',
		qty string comment '数量',
		local_currency_amt decimal(26, 10) comment '费用本币金额',
		manual_adjust_amt decimal(26, 10) comment '费用手工调整值',
		sum_amt decimal(26, 10) comment '费用合计',
		origin_currency_amt decimal(26, 10) comment '费用原币金额',
		local_currency_unit string comment '本币单位',
		origin_currency_unit string comment '原币单位',
		material_voucher_code string comment '物料凭证',
		profit_center_code string comment '利润中心编码',
		profit_center_desc string comment '利润中心描述',
		dw_last_update_date date comment '数据同步时间',
		CUST_GROUP_CODE string comment '客户组', --客户组（20241019新增字段）
		ITEM_TEXT string comment '行项目文本',
		ALLOCATION string comment '分配',
		doc_number string comment '订单号',
		bill_num string comment '发票号',
		VKGRP_PA string comment '销售组(会计凭证)'
	) comment '费用明细、综合科目表01';

with ACDOCA2 as (
select
 T2.GJAHR -- 年
,T2.FISCYEARPER -- 月份
,T2.BLDAT -- 凭证日期	
,T2.BUDAT -- 过账日期
,T2.BELNR -- 财务凭证号
,T2.BUZEI -- 财务凭证行
,T2.BLART -- 凭证类型
,T2.RCNTR -- 成本中心编码
,T2.LTEXT -- 成本中心描述
,T2.RFAREA -- 功能范围编码
,T2.FKBTX -- 功能范围名称
,T2.RBUKRS -- 公司代码
,T2.BUTXT -- 公司代码描述
,case  when T2.RACCT = '0061602000' then T2.SALES_GRP --科目61602000的直接读取成本中心对应的主档 2024-03-23
	   when T2.ORD_SALES_GRP <> ''
	   and T2.ORD_SALES_GRP is not null then T2.ORD_SALES_GRP
	   when T2.VKGRP_PA <> ''
	   and T2.VKGRP_PA is not null then T2.VKGRP_PA
	   else case when (
						T2.PS_POSID <> ''
						and T2.PS_POSID is not null
					)
					and (
						D15.ZVKGRP <> ''
						and D15.ZVKGRP is not null
					) then D15.ZVKGRP
					else case
						when (
							T2.KUNNR <> ''
							and T2.KUNNR is not null
						)
						and (
							T2.VKORG <> ''
							and T2.VKORG is not null
						)
						and (
							T2.VTWEG <> ''
							and T2.VTWEG is not null
						) then T2.VKGRP
						else T2.SALES_GRP
					end
				end
			end VKGRP_PA -- 销售组编码
			--,T2.VKGRP_PA						-- 销售组编码
,T2.PS_POSID -- WBS
,T2.POST1 -- wbs号描述
,T2.RACCT -- 总账科目
,T2.TXT20 -- 总账科目描述
,T2.VKORG -- 销售组织
,T2.VTWEG -- 渠道		
,T2.MATNR -- 物料编码
,T2.MAKTX -- 物料描述
,T2.KUNNR -- 客户编码	
,T2.CUST_NAME -- 客户名称
,T2.LIFNR -- 供应商编码
,T2.SUPPLIER_NAME -- 供应商名称
,T2.MSL -- 数量
,T2.HSL -- 费用本币金额
,T2.WSL -- 费用原币金额
,T2.RHCUR -- 本币单位
,T2.RWCUR -- 原币单位
,T2.AWREF -- 物料凭证
,T2.PRCTR -- 利润中心编码
,T2.KTEXT -- 利润中心描述
,T2.PSPHI -- 项目号
,D15.ZVKGRP -- WBS-销售组
,T2.VKGRP -- 客户主档的销售组
,T2.SALES_GRP -- 成本中心的销售组
,T2.CUST_GROUP_CODE -- 客户组
,T2.ITEM_TEXT -- 行项目文本
,T2.ALLOCATION -- 分配
,T2.VKGRP_PA --销售组(会计凭证)
,T2.manual_adjust_amt --费用手工调整值
from  DWRFIN.DWR_FIN_COST_D_COMPRE_SUBJ_TMP3 T2
left join SDI.SDI_PROJ_1001 D15 -- 29042 
on T2.PSPHI = D15.PSPNR -- 项目号
)
--sap调整值取功能范围
,CT_MAIN AS (select
ROW_NUMBER() OVER (PARTITION by cost_center order by create_date desc)  RN,
cost_center,
func_scope
from DWIFIN.DWI_COST_CENTER_MAIN_T
where
control_scope = 'DP00'
and (func_scope IS NOT NULL OR func_scope <> '')
)
	--,
	--ACDOCA3 AS (
insert overwrite table DWRFIN.DWR_FIN_COST_D_COMPRE_SUBJ_T_01
select
 T3.GJAHR as year -- 年
,T3.FISCYEARPER as month -- 月份
,T3.BLDAT as VOUCHER_DATE -- 凭证日期	
,T3.BUDAT as POSTING_DATE -- 过账日期
,T3.BELNR as FIN_VOUCHER_CODE -- 财务凭证号
,T3.BUZEI as FIN_VOUCHER_LINE_CODE -- 财务凭证行
,T3.BLART as VOUCHER_TYPE_CODE -- 凭证类型
,T3.RCNTR as COST_CENTER_CODE -- 成本中心编码
,T3.LTEXT as COST_CENTER_DESC -- 成本中心描述
,T3.RFAREA as FUNC_SCOPE_CODE -- 功能范围编码
,T3.FKBTX as FUNC_SCOPE_NAME -- 功能范围名称
,T3.RBUKRS as COMP_CODE -- 公司代码
,T3.BUTXT as COMP_DESC -- 公司代码描述
,T3.VKGRP_PA as SALES_GROUP_CODE -- 销售组编码
,D16.BEZEI as SALES_GROUP_DESC -- 销售组描述
,T3.PS_POSID as WBS -- WBS号
,T3.POST1 as WBS_DESC -- WBS号描述
,T3.RACCT as GENERAL_LEDGER_ACCOUNT -- 总账科目
,T3.TXT20 as GENERAL_LEDGER_ACCOUNT_DESC -- 总账科目描述
,T3.VKORG as SALES_ORG_CODE -- 销售组织
,T3.VTWEG as CHANNEL_CODE -- 渠道		
,T3.MATNR as MATERIAL_CODE -- 物料编码
,T3.MAKTX as MATERIAL_DESC -- 物料描述
,T3.KUNNR as CUST_CODE -- 客户编码	
,T3.CUST_NAME as CUST_NAME -- 客户名称
,T3.LIFNR as SUPPLIER_CODE -- 供应商编码
,T3.SUPPLIER_NAME as SUPPLIER_NAME -- 供应商名称
,T3.MSL as QTY -- 数量
,T3.HSL as LOCAL_CURRENCY_AMT -- 费用本币金额
,T3.MANUAL_ADJUST_AMT -- 费用手工调整值
,T3.HSL + T3.MANUAL_ADJUST_AMT as SUM_AMT -- 费用合计
,T3.WSL as ORIGIN_CURRENCY_AMT -- 费用原币金额
,T3.RHCUR as LOCAL_CURRENCY_UNIT -- 本币单位
,T3.RWCUR as ORIGIN_CURRENCY_UNIT -- 原币单位
,T3.AWREF as MATERIAL_VOUCHER_CODE -- 物料凭证
,T3.PRCTR as PROFIT_CENTER_CODE -- 利润中心编码
,T3.KTEXT as PROFIT_CENTER_DESC -- 利润中心描述
,current_timestamp () as DW_LAST_UPDATE_DATE -- 数据同步时间
,T3.CUST_GROUP_CODE as CUST_GROUP_CODE --客户组
,T3.ITEM_TEXT as ITEM_TEXT --行项目文本
,T3.ALLOCATION as ALLOCATION --分配
,'' as doc_number --订单号
,'' as bill_num --发票号
,T3.VKGRP_PA --销售组(会计凭证)
from ACDOCA2 T3
left join SDI.SDI_TVGRT_1001 D16 -- 1630 
on T3.VKGRP_PA = D16.VKGRP -- 销售组
and D16.SPRAS = '1'
union all
select
	T.YEAR,
	T.MONTH,
	T.VOUCHER_DATE,
	T.POSTING_DATE,
	T.FIN_VOUCHER_CODE,
	T.FIN_VOUCHER_LINE_CODE,
	T.VOUCHER_TYPE_CODE,
	T.COST_CENTER_CODE,
	T.COST_CENTER_DESC,
	T.FUNC_SCOPE_CODE,
	T.FUNC_SCOPE_NAME,
	T.COMP_CODE,
	T.COMP_DESC,
	T.SALES_GROUP_CODE,
	T.SALES_GROUP_DESC,
	T.WBS,
	T.WBS_DESC,
	T.GENERAL_LEDGER_ACCOUNT,
	T.GENERAL_LEDGER_ACCOUNT_DESC,
	T.SALES_ORG_CODE,
	T.CHANNEL_CODE,
	T.MATERIAL_CODE,
	T.MATERIAL_DESC,
	T.CUST_CODE,
	T.CUST_NAME,
	T.SUPPLIER_CODE,
	T.SUPPLIER_NAME,
	T.QTY,
	T.LOCAL_CURRENCY_AMT,
	T.MANUAL_ADJUST_AMT,
	T.SUM_AMT,
	T.ORIGIN_CURRENCY_AMT,
	T.LOCAL_CURRENCY_UNIT,
	T.ORIGIN_CURRENCY_UNIT,
	T.MATERIAL_VOUCHER_CODE,
	T.PROFIT_CENTER_CODE,
	T.PROFIT_CENTER_DESC,
	T.DW_LAST_UPDATE_DATE,
	'' as CUST_GROUP_CODE, --客户组
	'' as ITEM_TEXT, --行项目文本
    '' as ALLOCATION, --分配
	'' as doc_number, --订单号
	'' as bill_num, --发票号
    '' as VKGRP_PA --销售组(会计凭证)
from DWRFIN.DWR_FIN_COST_D_COMPRE_SUBJ_TMP1 T
union all
select
	substr(T.calmonth, 1, 4) as year,
	substr(T.calmonth, 1, 4) || '-' || substr(T.calmonth, 5, 2) as month,
	substr(T.calday, 1, 4) || '-' || substr(T.calday, 5, 2) || '-' || substr(T.calday, 7, 2) as voucher_date,
	substr(T.calday, 1, 4) || '-' || substr(T.calday, 5, 2) || '-' || substr(T.calday, 7, 2) as posting_date,
	T.zasd_p001_zcbpz as fin_voucher_code,
	'' as fin_voucher_line_code,
	'' as voucher_type_code,
	T.cost_center_code,
	T.cost_center_name,
	case when substr(T.general_ledger_account,1,3) = '005' then '' else T.func_scope_code end func_scope_code,
	case when substr(T.general_ledger_account,1,3) = '005' then '' else T.func_scope_name end func_scope_name,
	T.comp_code,
	T.comp_name,
	case when T.zasd_p001_0sales_grp_0 <> '' AND T.zasd_p001_0sales_grp_0 IS NOT NULL THEN T.zasd_p001_0sales_grp_0
	     WHEN L.sales_group_code <> '' AND L.sales_group_code IS NOT NULL THEN L.sales_group_code
	     ELSE T.sales_grp END as sales_group_code,
	case when T.wbs_sales_grp_name <> '' AND T.wbs_sales_grp_name IS NOT NULL THEN T.wbs_sales_grp_name
	     WHEN L.sales_group_name <> '' AND L.sales_group_name IS NOT NULL THEN L.sales_group_name
	     ELSE T.sales_grp_name END as sales_group_desc,
	T.wbs_elemt as wbs,
	T.wbs_elemt_name as wbs_desc,
	T.general_ledger_account,
	T.general_ledger_account_desc,
	T.salesorg as sales_org_code,
	T.distr_chan as channel_code,
	T.material as material_code,
	T.material_name as material_desc,
	T.customer as cust_code,
	T.customer_name as cust_name,
	'' as supplier_code,
	'' as supplier_name,
	T.actual_billed_qty as QTY,
	T.confirm_amounts as local_currency_amt,
	0 as manual_adjust_amt,
	T.confirm_amounts as sum_amt,
	T.confirm_amounts as origin_currency_amt,
	'RMB' as local_currency_unit,
	'RMB' as origin_currency_unit,
	T.ztmswldh as material_voucher_code,
	'' as PROFIT_CENTER_CODE,
	'' as PROFIT_CENTER_DESC,
	current_timestamp () as DW_LAST_UPDATE_DATE,
	'' as CUST_GROUP_CODE, --客户组
	'' as ITEM_TEXT, --行项目文本
	'' as ALLOCATION, --分配
	T.doc_number, --订单号
	T.bill_num, --发票号
	'' as VKGRP_PA --销售组(会计凭证)
from DWROTD.DWR_TRA_TMS_FEE_T T
LEFT JOIN DWRDIM.DWR_DIM_CUST_SALES_AREA_D2 L 
ON T.customer = L.cust_num AND T.distr_chan = L.distribution_chnl_code AND T.salesorg = L.sales_org_code  
AND L.end_date = '4712-12-31' and L.del_flag = 'N'
where period_id_m >= substr('${PERIOD_ID_M}', 1, 4) || substr('${PERIOD_ID_M}', 6, 2)
-- and general_ledger_account <> ''
and T.general_ledger_account IN ('0054010600','0054010700')
union all  
-- tms修改了2月份的明细数据，在这里手工补上与sap的差额
select 
    T1.YEAR,
	T1.MONTH,
	T1.VOUCHER_DATE,
	T1.POSTING_DATE,
	T1.FIN_VOUCHER_CODE,
	T1.FIN_VOUCHER_LINE_CODE,
	T1.VOUCHER_TYPE_CODE,
	T1.COST_CENTER_CODE,
	D4.LTEXT as COST_CENTER_DESC,
	T1.FUNC_SCOPE_CODE,
	T1.FUNC_SCOPE_NAME,
	T1.COMP_CODE,
	D3.BUTXT as COMP_DESC,
	D13.SALES_GRP as SALES_GROUP_CODE,
	D16.BEZEI as SALES_GROUP_DESC,
	T1.WBS,
	T1.WBS_DESC,
	T1.GENERAL_LEDGER_ACCOUNT,
	case when D6.TXT20 <> ''or D6.TXT20 is not null then D6.TXT20
    else D7.TXT20 end as GENERAL_LEDGER_ACCOUNT_DESC,
	T1.SALES_ORG_CODE,
	T1.CHANNEL_CODE,
	T1.MATERIAL_CODE,
	T1.MATERIAL_DESC,
	T1.CUST_CODE,
	T1.CUST_NAME,
	T1.SUPPLIER_CODE,
	T1.SUPPLIER_NAME,
	T1.QTY,
	T1.LOCAL_CURRENCY_AMT,
	T1.MANUAL_ADJUST_AMT,
	T1.SUM_AMT,
	T1.ORIGIN_CURRENCY_AMT,
	T1.LOCAL_CURRENCY_UNIT,
	T1.ORIGIN_CURRENCY_UNIT,
	T1.MATERIAL_VOUCHER_CODE,
	T1.PROFIT_CENTER_CODE,
	T1.PROFIT_CENTER_DESC,
	current_timestamp () as DW_LAST_UPDATE_DATE,
	T1.CUST_GROUP_CODE,
	T1.ITEM_TEXT, --行项目文本
    T1.ALLOCATION ,--分配
	T1.doc_number, --订单号
	T1.bill_num, --发票号
	'' as VKGRP_PA --销售组(会计凭证)
from  DWRFIN.DWR_FIN_COST_D_COMPRE_SUBJ_T_00 T1  
left join SDI.SDI_T001_1001 D3 on T1.COMP_CODE = D3.BUKRS -- 178
left join DWRFIN.DWR_FIN_CSKT_TMP D4 -- 17126
on T1.COST_CENTER_CODE = D4.KOSTL
left join SDI.SDI_SKAT_1001 D6 -- 95108
on T1.GENERAL_LEDGER_ACCOUNT = D6.SAKNR
and D6.KTOPL = 'CNDP'
left join SDI.SDI_SKAT_1001 D7 -- 95108
on T1.GENERAL_LEDGER_ACCOUNT = D7.SAKNR
and D7.KTOPL = 'CND1'
left join DWRFIN.DWR_FIN_QCOSTCENTER_TMP D13 on T1.COST_CENTER_CODE = D13.COSTCENTER
left join SDI.SDI_TVGRT_1001 D16 -- 1630 
on D13.SALES_GRP = D16.VKGRP -- 销售组
and D16.SPRAS = '1'
where T1.MONTH >=substr('${PERIOD_ID_M}', 1, 7)
UNION ALL -- SAP 调整值
select
 T.RLN as year
,T.RLNY as MONTH
,T.POST_DATE as voucher_date
,T.POST_DATE as posting_date
,T.TZBZH  AS fin_voucher_code
,'' AS fin_voucher_line_code
,T.VBTYP AS voucher_type_code
,T.KOSTL AS cost_center_code
,T.KOSTL_T AS cost_center_desc
,T2.FUNC_SCOPE AS func_scope_code
,T3.config_name AS func_scope_name
,T.BUKRS AS comp_code
,T.BUKRS_T AS comp_desc
,case when T.C_VKGRP = '' OR T.C_VKGRP IS NULL THEN T.VKGRP ELSE T.C_VKGRP END sales_group_code
,case when T.C_VKGRP_T = '' OR T.C_VKGRP_T IS NULL THEN T.VKGRP_T ELSE T.C_VKGRP_T END sales_group_desc
,T.POSID AS wbs
,T.POSID_T AS wbs_desc
,T.HKONT AS general_ledger_account
,T.HKONT_T AS general_ledger_account_desc 
,T.VKORG AS sales_org_code
,T.VTWEG AS channel_code
,T.MATNR AS material_code   
,T1.material_name AS material_desc
,T.KUNNR AS cust_code
,T.KUNNR_T AS cust_name
,'' AS supplier_code
,'' AS supplier_name
,T.FKIMG AS  qty
,0 AS local_currency_amt
,T.FYTZ AS manual_adjust_amt
,T.FYTZ AS sum_amt
,0 AS origin_currency_amt
,T.WAERS AS local_currency_unit
,T.WAERS AS origin_currency_unit
,'' AS material_voucher_code
,T.PRCTR AS profit_center_code
,T.PRCTR_T AS profit_center_desc
,T.dw_last_update_date
,'' AS cust_group_code
,T.WBMS AS item_text
,T.ERNAM AS allocation
,T.VBEL2 AS doc_number
,T.VBELN AS bill_num
,'' AS VKGRP_PA --销售组(会计凭证)
from DWRFIN.DWR_SAP_ADJUST_DATA_T T 
left join dwimd.dwi_md_data_material_general_t  T1 
on T.MATNR = T1.MATERIAL_NUM
left join CT_MAIN T2 
on t.KOSTL = T2.cost_center
AND T2.RN = 1
LEFT JOIN DWIMD.DWI_MD_GENERAL_CONFIG_CODE_R  T3 -- 17126
on T2.FUNC_SCOPE = T3.src_sys_config_code
   AND T3.source_code = 'TFKBT'
   AND T3.GROUP_NUM = 800
   AND T3.LANG_CODE = '1' 
WHERE T.period_id_m >= '${PERIOD_ID_M}'
AND T.FYTZ <> 0
;

create table if not exists DWRFIN.DWR_FIN_COST_D_COMPRE_SUBJ_T (
		year string comment '年',
		month string comment '月份',
		voucher_date date comment '凭证日期',
		posting_date date comment '过账日期',
		fin_voucher_code string comment '财务凭证号',
		fin_voucher_line_code string comment '财务凭证行',
		voucher_type_code string comment '凭证类型',
		cost_center_code string comment '成本中心编码',
		cost_center_desc string comment '成本中心描述',
		func_scope_code string comment '功能范围编码',
		func_scope_name string comment '功能范围名称',
		comp_code string comment '公司代码',
		comp_desc string comment '公司代码描述',
		sales_group_code string comment '销售组编码',
		sales_group_desc string comment '销售组描述',
		wbs string comment 'WBS号',
		wbs_desc string comment 'WBS号描述',
		general_ledger_account string comment '总账科目',
		general_ledger_account_desc string comment '总账科目描述',
		sales_org_code string comment '销售组织',
		channel_code string comment '渠道',
		material_code string comment '物料编码',
		material_desc string comment '物料描述',
		cust_code string comment '客户编码',
		cust_name string comment '客户名称',
		supplier_code string comment '供应商编码',
		supplier_name string comment '供应商名称',
		qty string comment '数量',
		local_currency_amt decimal(26, 10) comment '费用本币金额',
		manual_adjust_amt decimal(26, 10) comment '费用手工调整值',
		sum_amt decimal(26, 10) comment '费用合计',
		origin_currency_amt decimal(26, 10) comment '费用原币金额',
		local_currency_unit string comment '本币单位',
		origin_currency_unit string comment '原币单位',
		material_voucher_code string comment '物料凭证',
		profit_center_code string comment '利润中心编码',
		profit_center_desc string comment '利润中心描述',
		dw_last_update_date date comment '数据同步时间',
		CUST_GROUP_CODE string comment '客户组', --客户组（20241019新增字段）
		ITEM_TEXT string comment '行项目文本',
		ALLOCATION string comment '分配',
		doc_number string comment '订单号',
		bill_num string comment '发票号',
		VKGRP_PA STRING comment '销售组(会计凭证)'
	) comment '费用明细、综合科目表';


insert overwrite table DWRFIN.DWR_FIN_COST_D_COMPRE_SUBJ_T
select
	T1.YEAR,
	T1.MONTH,
	T1.VOUCHER_DATE,
	T1.POSTING_DATE,
	T1.FIN_VOUCHER_CODE,
	T1.FIN_VOUCHER_LINE_CODE,
	T1.VOUCHER_TYPE_CODE,
	T1.COST_CENTER_CODE,
	T1.COST_CENTER_DESC,
	T1.FUNC_SCOPE_CODE,
	T1.FUNC_SCOPE_NAME,
	T1.COMP_CODE,
	T1.COMP_DESC,
	case when (T1.SALES_GROUP_CODE = '' or T1.SALES_GROUP_CODE is null ) and (T1.COST_CENTER_CODE = '' or T1.COST_CENTER_CODE is null ) and T1.FUNC_SCOPE_CODE in ('4101','4105') then nvl(D3.sales_grp,D3.sales_grp_l) else T1.sales_group_code end as SALES_GROUP_CODE ,
	case when (T1.SALES_GROUP_CODE = '' or T1.SALES_GROUP_CODE is null) and (T1.COST_CENTER_CODE = '' or T1.COST_CENTER_CODE is null )  and T1.FUNC_SCOPE_CODE in ('4101','4105') then D16.BEZEI else T1.SALES_GROUP_DESC end as SALES_GROUP_DESC,
	T1.WBS,
	T1.WBS_DESC,
	T1.GENERAL_LEDGER_ACCOUNT,
	T1.GENERAL_LEDGER_ACCOUNT_DESC,
	T1.SALES_ORG_CODE,
	T1.CHANNEL_CODE,
	T1.MATERIAL_CODE,
	T1.MATERIAL_DESC,
	T1.CUST_CODE,
	T1.CUST_NAME,
	T1.SUPPLIER_CODE,
	T1.SUPPLIER_NAME,
	T1.QTY,
	T1.LOCAL_CURRENCY_AMT,
	T1.MANUAL_ADJUST_AMT,
	T1.SUM_AMT,
	T1.ORIGIN_CURRENCY_AMT,
	T1.LOCAL_CURRENCY_UNIT,
	T1.ORIGIN_CURRENCY_UNIT,
	T1.MATERIAL_VOUCHER_CODE,
	T1.PROFIT_CENTER_CODE,
	T1.PROFIT_CENTER_DESC,
	current_timestamp () as DW_LAST_UPDATE_DATE,
	T1.CUST_GROUP_CODE,
	T1.ITEM_TEXT, --行项目文本
    T1.ALLOCATION ,--分配
	T1.doc_number, --订单号
	T1.bill_num, --发票号
	D2.xblnr as FIN_VOUCHER_REF, -- 凭证参考
	T1.vkgrp_pa --销售组(会计凭证)
from DWRFIN.DWR_FIN_COST_D_COMPRE_SUBJ_T_01 T1
LEFT JOIN SDI.SDI_BKPF_1001 D2
		   ON T1.YEAR = D2.GJAHR
		  AND T1.COMP_CODE = D2.BUKRS
		  AND T1.FIN_VOUCHER_CODE = D2.BELNR
left join SDI.SDI_DIVISION_COMP_T_1037 D3
on T1.COMP_CODE = D3.comp_code
and substr(D3.end_date,1,10) = '9999-12-31'
left join SDI.SDI_TVGRT_1001 D16 -- 1630 
on nvl(D3.sales_grp,D3.sales_grp_l) = D16.VKGRP -- 销售组
and D16.SPRAS = '1'
union all
select
	T2.YEAR,
	T2.MONTH,
	T2.VOUCHER_DATE,
	T2.POSTING_DATE,
	T2.FIN_VOUCHER_CODE,
	T2.FIN_VOUCHER_LINE_CODE,
	T2.VOUCHER_TYPE_CODE,
	T2.COST_CENTER_CODE,
	T2.COST_CENTER_DESC,
	T2.FUNC_SCOPE_CODE,
	T2.FUNC_SCOPE_NAME,
	T2.COMP_CODE,
	T2.COMP_DESC,
	T2.SALES_GROUP_CODE,
	T2.SALES_GROUP_DESC,
	T2.WBS,
	T2.WBS_DESC,
	T2.GENERAL_LEDGER_ACCOUNT,
	T2.GENERAL_LEDGER_ACCOUNT_DESC,
	T2.SALES_ORG_CODE,
	T2.CHANNEL_CODE,
	T2.MATERIAL_CODE,
	T2.MATERIAL_DESC,
	T2.CUST_CODE,
	T2.CUST_NAME,
	T2.SUPPLIER_CODE,
	T2.SUPPLIER_NAME,
	T2.QTY,
	T2.LOCAL_CURRENCY_AMT,
	T2.MANUAL_ADJUST_AMT,
	T2.SUM_AMT,
	T2.ORIGIN_CURRENCY_AMT,
	T2.LOCAL_CURRENCY_UNIT,
	T2.ORIGIN_CURRENCY_UNIT,
	T2.MATERIAL_VOUCHER_CODE,
	T2.PROFIT_CENTER_CODE,
	T2.PROFIT_CENTER_DESC,
	T2.DW_LAST_UPDATE_DATE,
	T2.CUST_GROUP_CODE,
	T2.ITEM_TEXT,
	T2.ALLOCATION,
	T2.doc_number, --订单号
	T2.bill_num, --发票号
	T2.FIN_VOUCHER_REF,
	T2.vkgrp_pa --销售组(会计凭证)
from DWRFIN.DWR_FIN_COST_D_COMPRE_SUBJ_T T2
where T2.GENERAL_LEDGER_ACCOUNT || T2.MONTH || T2.COMP_CODE || T2.FIN_VOUCHER_CODE || T2.YEAR not in (
		select T1.GENERAL_LEDGER_ACCOUNT || T1.MONTH || T1.COMP_CODE || T1.FIN_VOUCHER_CODE || T1.YEAR
		from DWRFIN.DWR_FIN_COST_D_COMPRE_SUBJ_T_01 T1 ) ---鉴于手工调整值没有凭证号，所以加上月份和总账科目确定唯一
;


