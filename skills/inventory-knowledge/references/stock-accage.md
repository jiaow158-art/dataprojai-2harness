# 库存账龄明细

## 快速参考

- **DWS 表名**：`dm.dm_fin_stock_detail_accage_t_2023`（1.44亿行，183 列，202012 ~ 202608）
- **业务含义**：按物料+工厂+批次+库存地点+会计期间记录库存余额和金额，并按库龄分段（已包装周期、未包装周期）。库存分析最核心的单表。
- **实体粒度**：一行 = 一个物料在一个工厂/库存地点/批次的月度库存快照
- **ETL 负责人**：见离线脚本 `DM/PJob_DM_FIN_STOCK_DETAIL_ACCAGE_T_2023.txt`

## 核心字段

### 维度字段

| 字段 | 含义 |
|---|---|
| calmonth | 会计期间 YYYYMM（NOT NULL） |
| calyear | 会计年度 |
| material | 物料号 |
| material___t | 物料描述（___t 后缀表示文本描述） |
| plant | 工厂编码 |
| plant___t | 工厂名称 |
| stor_loc | 库存地点 |
| stor_loc___t | 库存地点描述 |
| batch | 批次号 |
| stockcat | 库存类别编码 |
| stockcat___t | 库存类别描述 |
| stocktype | 库存类型编码 |
| stocktype___t | 库存类型描述 |
| comp_code | 公司代码 |
| comp_code___t | 公司描述 |
| extmatlgrp | 外部物料组 |
| matl_group | 物料组 |
| matl_type | 物料类型 |
| zprodh1 ~ zprodh5 | 产品层次 1-5 级（___t 后缀为描述） |
| matl_grp_1 ~ matl_grp_5 | 物料组层级 1-5 级（___t 后缀为描述） |
| wbs_elemt | WBS 要素 |
| vendor | 供应商编码 |
| val_class | 评估类 |
| industry | 行业 |
| unit | 单位 |

### 数量/金额字段

| 字段 | 类型 | 含义 |
|---|---|---|
| quantity | numeric | 库存数量 |
| zsjkcje | numeric | 实际库存金额（管理口径核心字段） |
| bz_flag | varchar | 保质期标识（Y=有保质期，N=无保质期） |
| ybzq_bzdq_amt | numeric | 有保质期产品，保质期到期金额 |
| ybzq_bzdq_3_amt | numeric | 有保质期产品，距到期3个月以内金额 |
| wbzq_6_amt | numeric | 无保质期产品，6个月以内金额 |
| wbzq_6_12_amt | numeric | 无保质期产品，6-12月金额 |
| wbzq_12_24_amt | numeric | 无保质期产品，1-2年金额 |
| wbzq_24_amt | numeric | 无保质期产品，2年以上金额 |
| ybzq_jc_amt | numeric | 有保质期减值 |
| wbzq_jc_amt | numeric | 无保质期减值 |
| jchj_amt | numeric | 减值合计（管理） |
| stock_amt | numeric | 库存金额 |

### 跌价字段（计提比例 0/10/40/70% + 保质期 70/100%）

| 字段 | 含义 |
|---|---|
| wbzq_6_fall_amt / wbzq_6_12_fall_amt / wbzq_12_24_fall_amt / wbzq_24_fall_amt | 无保质期各段跌价（0%/10%/40%/70%） |
| ybzq_bzdq_3_fall_amt / ybzq_bzdq_fall_amt | 有保质期跌价（到期3月内 70% / 已到期 100%） |
| jchj_amt | 减值合计-管理（= 各段之和，可直接 SUM） |
| jchj_aging / wbzq_*_fall_aging / ybzq_*_fall_aging | 同上结构，阿米巴结算价口径（减值合计-阿米巴 3.301亿，202607） |
| stock_amt | 库存金额（阿米巴结算价，202607 合计 17.52亿） |
| clear_inv_flag / clearance_reason / promote_reason | 清库存标识 / 清仓原因 / 促销原因 |
| time_diff / next_mon_date | 时间差（天）/ 下月日期 |

| 字段 | 类型 | 含义 |
|---|---|---|
| ybzq_bzdq_area | numeric | 已包装周期-标准地区面积 |
| wbzq_6_area / 6_12 / 12_24 / 24 | numeric | 各库龄段面积 |
| ybzq_bzdq_qty | numeric | 已包装周期-标准地区数量 |
| wbzq_6_qty / 6_12 / 12_24 / 24 | numeric | 各库龄段数量 |
| xydj_7_12_amt / _12_24_ / _24_ | numeric | 协议单价分段金额 |
| zrzlcp_* | numeric | 自然日历产品相关字段 |
| amb_* | numeric | 爱米巴相关字段 |

### 其他 SAP 字段

| 字段 | 含义 |
|---|---|
| zdpsyb | 盘点损益 |
| zdpzgsdq | 在制品核算地区 |
| zisqc | 是否切裁 |
| ziswx | 是否维修 |
| zmatltype | 物料类型编码 |
| zyl01 / zyl06 | 预留相关 |
| zww010 | 物料评估 |
| zmmm_o017_zbatch_date | 批次日期 |
| zmmm_o017_zzqj | 在制期间 |
| z_vfdat | 有效日期 |
| reqtsn | 需求追踪号 |
| doc_currcy | 凭证货币 |
| dw_last_update_date | DW 最后更新日期 |

## 陷阱

1. **表名是 `dm_fin_stock_detail_accage_t_2023`**：虽然有 `_2023` 后缀，但实际覆盖 202012 ~ 202606 全量数据，不需要跨表 UNION。不要错误使用 `dm_fin_stock_detail_accage_t`（旧表）或 `dm_fin_stock_detail_accage_others_t`。
2. **SAP 风格命名**：大量 `z` 开头字段和 `___t` 后缀描述字段。`___t` 表示三下划线 + t 的文本描述（如 `plant` 是编码，`plant___t` 是名称）。
3. **库龄字段众多**：表包含 183 列，库龄从多维度拆分——金额/数量/面积、已包装/未包装、标准库龄/协议单价/自然日历/爱米巴，查询时需确认用哪个口径。
4. **跌价两套字段族**：管理（jchj_amt/wbzq_*_fall_amt）与阿米巴（jchj_aging/*_fall_aging）金额不同（2.877 vs 3.301亿，202607），查询显式选族。
4. **calmonth 格式**：YYYYMM 字符串（如 '202606'），该表 calmonth 可能为空。
5. **产品层次维度**：zprodh1~5 和 matl_grp_1~5 两个层级体系并存，过滤产品时优先用 matl_grp_*。

## 常见查询模式

### 当前库存账龄汇总（按工厂）
```sql
SELECT plant, plant___t,
       SUM(quantity) as total_qty,
       SUM(zsjkcje) as total_amount,
       SUM(wbzq_6_amt) as aged_0_6m,
       SUM(wbzq_6_12_amt) as aged_6_12m,
       SUM(wbzq_12_24_amt) as aged_12_24m,
       SUM(wbzq_24_amt) as aged_24m_plus
FROM dm.dm_fin_stock_detail_accage_t_2023
WHERE calmonth = '202606'
GROUP BY plant, plant___t
ORDER BY total_amount DESC;
```

### 单物料库龄下钻
```sql
SELECT calmonth, plant___t, stor_loc___t, batch,
       quantity, zsjkcje,
       wbzq_6_amt, wbzq_6_12_amt,
       wbzq_12_24_amt, wbzq_24_amt
FROM dm.dm_fin_stock_detail_accage_t_2023
WHERE material = '物料号' AND calmonth >= '202601'
ORDER BY calmonth;
```

### 跨年度库龄对比
```sql
SELECT calmonth, SUM(quantity) as qty, SUM(zsjkcje) as amt
FROM dm.dm_fin_stock_detail_accage_t_2023
WHERE calmonth IN ('202312', '202412', '202512')
GROUP BY calmonth
ORDER BY calmonth;
```

## 交叉引用

- 库存统计月报（库龄分段汇总）→ [stock-stat-month.md](stock-stat-month.md)
- 仓协销日报 → [cxc-daily.md](cxc-daily.md)
- 全类型库存 → [warehouse-stock.md](warehouse-stock.md)
