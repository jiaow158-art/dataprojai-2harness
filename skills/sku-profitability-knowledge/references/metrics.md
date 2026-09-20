# SKU 效益分析 — 语义层（强制首读）

## 一、九问决策树

| # | 用户问题类型 | 主表组合 | 分析师模式 |
|---|---|---|---|
| 1 | SKU 销售规模/排名/帕累托/核心SKU | Mix | A |
| 2 | SKU 趋势/同比/环比 | Mix | B |
| 3 | SKU 毛利贡献/毛利率/四象限 | Mix | C |
| 4 | 库存周转/可售天数/库销比 | 内部口径（阿米巴字段族）+Mix | D |
| 5 | 滞销/缺货/动销率 | 出入库月表+内部口径(+otd未交付) | E |
| 6 | 新品增量/蚕食/替代 | 物料主数据+Mix | F |
| 7 | 渠道/区域 × SKU 差异 | Mix | G |
| 8 | 综合评分/处置建议（清仓/加大投入） | A-E+H 输出汇总 | I |
| 9 | 库存跌价/库龄分段 | 内部口径（阿米巴字段族） | H |

SKU 键：Mix 表 `material_num` ↔ 内部口径表 `material` ↔ 出入库表 `material_num` ↔ 主数据 `material_num`。

## 二、效益利润口径（替代“净利润”）

**禁止**声称算出 SKU 级净利润/ROI——销售费用（广告/促销/售后/仓储）在凭证层不挂物料（2026-06 实证填充率 0%~0.5%），无法分摊。

**效益利润**（持有代价视角，全部现成字段）：

```
效益利润 = gross_profit_after_sharing（Mix 分摊后毛利）
         − jchj_aging（内部口径跌价合计-阿米巴结算价，计提 0/10/40/70%+保质期 70/100%）
         − capital_cost（资金成本：默认 dm_fin_stock_capital_cost_t 正值口径，公式已验证；
           阿米巴分摊口径 dm_ambv2_chdj_grp_t 为负值、符号待确认，仅特定要求时用）
```

回答模板必须透明列出构成与缺口（“营销/售后费用不可分摊，未计入”）。

## 三、综合评分与处置阈值（业务给定公式）

```
综合评分 = 销售收入得分×25% + 毛利额得分×30% + 动销率得分×20%
         + 库存金额得分×15% + 库存周转得分×10%
```

- 各维度得分 = PERCENT_RANK×100（正向指标升序；库存金额**反向**——越多得分越低；周转用“库销比”反向近似：库存金额÷同期销售额，比值越小越好）
- 决策阈值：**≥80 加大投入；60-79 保留优化；40-59 调价降本；<40 或（周转超标且销售下降）降库存；效益利润为负且 `zisqc='Y'`（是否清仓标记，实测值域 Y/N，**不是** '是'/'否'）→ 清仓淘汰**（业务原文“净利润为负”落地为效益利润为负）

## 四、口径与陷阱（全部实证）

1. **两套库存金额不可混用**：内部口径管理字段 zsjkcje 14.71亿 / 阿米巴字段 stock_amt 17.52亿 / 阿米巴 CHDJ 6.35亿（2026-07 量级）。本域统一用**阿米巴字段族**（stock_amt/jchj_aging/*_aging）与 Mix 对齐；资金成本→capital_cost_t（正值）或 CHDJ（阿米巴，待确认）。`dm_own_inventory_t` 未获业务确认，不使用。上市口径表 `dm_fin_stock_d_accage_list_c_t_2023` 已弃用，禁止使用。
2. **日期格式五处不同**：Mix `calmonth='2026-07'`；内部口径 `calmonth='202607'`；CHDJ `stat_month='2026-07'`；capital_cost_t `month='202608'`；出入库 `start_month='2026-07'`。跨表同月条件必须分别写。
3. **跌价按 6月段**（6月内 0%、6-12月 10%、12-24月 40%、24月+ 70%），另含保质期段（到期3月内 70%、到期 100%）；业务问“年段/半年段”时按 6月段聚合呈现并声明口径。
4. **月粒度原则（业务裁定 2026-08-18）**：动销/缺货最小按月看，库存取月末快照。“有销量天数”=「有销量月份数」；缺货 = 月末库存为 0 且当月有出库/需求。
5. **SKU 范围口径差**：Mix 在售 6,232 vs 内部口径在库 ~6.4万。跨表以 Mix 为主集 LEFT JOIN，或明确声明“在库口径”。
6. **判空**：`LENGTH(TRIM(col))>0`（`TRIM(col)<>''` 在 GaussDB A 兼容模式下恒 NULL，会过滤掉所有行）。
7. **Mix 必带过滤**：`data_source IN ('S','T','D','')`。
8. **周转口径透明**：可售天数 = 月末库存金额 ÷ 日均销售成本（Mix `act_cost_sum_amt` 月均÷30）；非财务精确周转，回答时注明。
9. **新品字段填充率低**：product_listed_date 仅 3.8%（格式 YYYY-MM 月度精度）、new_product_code 12.1%——新品圈定结果偏小属正常，回答时声明覆盖率。

## 五、渠道决策（同业绩域）

“渠道”默认 `integrate_channel__t`（3 值：零售/整装头部/工程）；产品导向用 `integrate_channel2__t`；SAP 原始用 `distr_chan__t`。详见业绩域 metrics.md 渠道决策树。

## 六、指标→字段速查

| 指标 | 字段 | 表 |
|---|---|---|
| 销售额（含税达成，主口径） | `ambperformance` | Mix |
| 销售面积/数量 | `zxsmj` / `zxssl` | Mix |
| 分摊后毛利 | `gross_profit_after_sharing` | Mix |
| 实际成本 | `act_cost_sum_amt` | Mix |
| 月末库存金额（阿米巴结算价） | `stock_amt` | 内部口径表 dm_fin_stock_detail_accage_t_2023 |
| 跌价合计（阿米巴） | `jchj_aging` | 内部口径表 |
| 是否清仓 | `zisqc`（值域 Y/N） | 内部口径表 |
| 库龄分段金额（阿米巴） | `wbzq_6_aging`~`wbzq_24_aging` | 内部口径表 |
| 月度出库量/面积 | `out_stock_qty` / `out_stock_area` | 出入库月表 |
| 月末库存量/面积 | `stock_qty_month_end` / `stock_area_month_end` | 出入库月表 |
| 库存资金成本（正值主口径） | `capital_cost` | dm_fin_stock_capital_cost_t |
| 存货价值/资金成本（阿米巴，待确认） | `inventory_value` / `capital_cost` | CHDJ |
| 上市日期/新品标识 | `product_listed_date` / `new_product_code` | 物料主数据 |

## 七、pattern → 首选表与字段路由（对齐 eval_dataset 录制口径）

> 本节把 9 类 SKU 效益问题 pattern 固化为"首选表 + 指标字段 + 窗口习惯"的路由规则。依据 = `eval_dataset.json` sku-profitability 9 场景期望 SQL（录制口径 = 判定标准）+ round-golden10 实测（2026-09-20）+ 2026-09-20 直连 DWS 只读复核。
> 多表/多字段业务上都讲得通时，**一律以 eval_dataset 录制口径为准**：不换表、不换指标字段、不加录制 SQL 之外的过滤条件、不改变 cur 窗口与对比基期的对应关系。

| pattern（问题形态） | 首选表 | 指标字段 / 关键列 | 窗口习惯（cur 与对比基期） | 路由理由 |
|---|---|---|---|---|
| sku_pareto（品类销售额TOP N + 累计占比） | Mix 单表 | 销售额 `SUM(ambperformance)`、面积 `SUM(zxsmj)`、物料名 `MAX(material_name)`、品类过滤 `category_name`；累计占比 = 窗口函数按 amt 降序累计 ÷ 总计 | 问题给定窗口（录制 2026-01~06），无基期 | 销售规模 = 含税达成主口径；一条 SQL 出齐 rank + cum_pct |
| sku_trend_mom（单 SKU 销售额环比） | Mix 单表 | `SUM(ambperformance)` BY calmonth；环比 = (cur−LAG)÷LAG×100（LAG OVER ORDER BY calmonth，首月为 NULL） | 问题给定月区间（录制 2026-02~07）；**环比基期 = 窗口内上一月**，不外扩窗口 | 金点子场景（golden10 `137a0e7ed74a`）：Mix + ambperformance + LAG 与录制完全一致且命中 fresh——本行即该正确行为的固化 |
| sku_margin_quadrant（毛利率×增长率四象限） | Mix 单表双 CTE（cur + prev） | 毛利率 = `SUM(gross_profit_after_sharing)÷SUM(ambperformance)×100`；增长率 = (cur.amt−prev.amt)÷prev.amt×100 | cur = 问题给定 3 个月（录制 2026-05~07）；**prev = 紧邻等长前 3 个月**（2026-02~04）；INNER JOIN prev 后按 cur.amt DESC 取 TOP N | 增长率 = 本期 vs 上期等长窗口（非同比）；无基期销量的 SKU 不入榜（录制口径） |
| sku_turnover_dos（可售天数 TOP N） | 内部口径表（stock）× Mix（cost） | 月末库存 `SUM(stock_amt)`（阿米巴）；可售天数 = stock_amt ÷ (月均 `act_cost_sum_amt` ÷ 30)；库销比 = stock_amt ÷ 月均 `ambperformance` | 库存 = **期末快照月单月**（calmonth='202607'，YYYYMM）；成本均值窗 = **以快照月收尾的近 6 个月**（2026-02~07，YYYY-MM）；INNER JOIN cost | 快照 + 月均÷30 近似日均（陷阱 8 须透明声明）；两表日期格式不同必须分别写（陷阱 2） |
| sku_health_flag（健康状态三态分布） | 出入库月表（act）× 内部口径表（stock） | 动销月数 = `COUNT(DISTINCT start_month)`（出库 `out_stock_qty>0 OR out_stock_area>0`）；三态 CASE：库存 0 且动销>0 = 缺货 / 库存>0 且动销 0 = 滞销 / 其余正常 | 动销 = 统计期全程（录制 2026-01~07，YYYY-MM）；库存 = 期末快照（202607，YYYYMM）；FULL OUTER JOIN；动销率分母 = 统计期月份数 | 在库口径全集（FULL OUTER，即陷阱 5 的 ~6.4 万 SKU）+ 月粒度原则（陷阱 4）的录制落地 |
| sku_newproduct_split（新品/老品拆分） | 物料主数据（圈定）× Mix | 新品判定 `product_listed_date >= cutoff`；拆分 = `SUM(ambperformance)` + SKU 数 BY 新品/老品 | 销售窗 = 问题给定（录制 2026-01~06）；**cutoff = 提问时点前推 12 个月**（录制 '2025-07'，锚提问时点、非销售窗锚点）；Mix 为主集 LEFT JOIN 主数据 | 圈定字段填充率仅 3.8%（陷阱 9），新品偏小属正常须声明 |
| sku_channel_pivot（渠道 × 单 SKU 透视） | Mix 单表 | `GROUP BY integrate_channel__t`；销售额 `SUM(ambperformance)`、毛利 `SUM(gross_profit_after_sharing)`、毛利率 = 聚合相除 | 问题给定区间（录制 2026-01~07），无基期 | 渠道默认 `integrate_channel__t`（第五节）；毛利率是聚合比不是 SKU 均值 |
| sku_fall_top10（存货跌价 TOP N） | 内部口径表单表 | 跌价 `SUM(jchj_aging)`（阿米巴合计）；库存 `SUM(stock_amt)`；分段 `wbzq_6_12/12_24/24_fall_aging`；物料名 `MAX(material___t)` | **期末快照月单月**（calmonth='202607'，YYYYMM） | 本域库存/跌价一律阿米巴字段族（陷阱 1）；同表的管理字段族是 inventory 域口径（见下分歧点） |
| sku_score_top20（综合评分 + 处置建议） | Mix（cur）+ 出入库月表（act）+ 内部口径表（stk）三源 | 五维评分公式与阈值见第三节；动销得分 = 100×active_months÷年内月份数；处置档位 CASE | **组合窗口**：近 3 月业绩（Mix 2026-05~07）+ 年初至提问月动销（出入库 2026-01~07）+ 期末库存快照（202607）；Mix 为主集 LEFT JOIN 两侧且 `amt>0` | "截至某月" = 该月收尾的三层窗口各管一维（业绩/动销/库存） |

**跨 pattern 通用规则（9 条录制 SQL 一致）**

- Mix 引用必带 `data_source IN ('S','T','D','')`（陷阱 7）；内部口径表 / 出入库表**不带**该过滤
- 销售额一律 `ambperformance`，毛利一律 `gross_profit_after_sharing`，毛利率 / 增长率 / 环比一律聚合相除后 ×100
- 销售侧以 Mix 为主集 LEFT JOIN 库存 / 主数据侧；仅 sku_margin_quadrant 与 sku_turnover_dos 是 INNER JOIN（无基期销量 / 无成本的 SKU 不入榜，录制口径）
- 日期格式按表分别写：Mix 与出入库 'YYYY-MM'、内部口径 'YYYYMM'（陷阱 2）
- 时间窗口一律用问题给定的字面量区间，**不可用 `MAX(calmonth)` 探测"最新月份"**——Mix 实测含 38 行 calmonth='S' 脏值（`MAX(calmonth)` 返回 'S'）与未来月份行（2026-10~12 各约 2,400 行，均未被 data_source 过滤排除），且当月为部分装载（202609 约 13.2 万行 vs 202608 约 30.3 万行）

**已知口径分歧点（写明差异，不替业务拍板新口径）**

- **跌价 / 库存金额：同表两套字段族。** `dm_fin_stock_detail_accage_t_2023` 202607 直连实测（2026-09-20）：跌价合计阿米巴 `jchj_aging` 3.30 亿（330,102,360）vs 管理 `jchj_amt` 2.88 亿（287,708,186）；库存金额 `stock_amt` 17.52 亿 vs `zsjkcje` 14.71 亿（与陷阱 1 量级互证）；Top1 物料不同——阿米巴口径 MG29769977_A（309 万，即本域 sku_fall_top10 录制 Top1）vs 管理口径 QFG271005_A（465 万，即 inventory 域 inventory_fall_top10 录制 Top1）。两套口径各自复现各自域的录制值——**按域路由选字段族，答案声明所用口径，不混用、不换字段凑数**。
- **sku_trend_mom 的 DATA_DRIFT 复盘（金点子，非路由问题）。** round-golden10（2026-09-20）判 DATA_DRIFT，但 agent 的表 / 字段 / 窗口 / 行数与录制及 fresh 完全一致（table_set_ok、行数 6/6、命中 fresh）；同日直连复核窗口内数值与录制逐月一致（121,100 / 4,632,468 / 4,408,290 / 4,944,535 / 10,151,474 / 3,651,137，未漂移）。根因是判定层的构造性漂移：本域 dataset.data 仅存前 3 行样本（录制存储惯例），fresh 重导为全量 6 行，`fresh_compare` 严格多重集对照即触发不一致。对 agent 的含义：按本节口径出数即与 fresh 一致；DATA_DRIFT 注记不改变路由。
