# M2-T6 变更清单：知识库加固（fin-cost 口径路由 + 数据集时间窗口固定）

> 依据：T5-evidence.md E4 节——采样失败集中在知识库口径路由与数据集时效性（时间开放式问题的标准答案会过期），非引擎能力。
> 原则：**数据集是标准**。只改 question 文本中时间范围开放的部分，**不改 sql / data / row_count**（既定事实）；若固定窗口与原 SQL 范围不一致，该条不改并记录原因。
> 不替业务拍板新口径：knowledge 侧路由规则只对齐 eval_dataset 既有录制口径。

## 一、eval_dataset.json：18 条问题文本固定（全部逐条核对 SQL 锚点）

场景键公式 = `sha1(domain|pattern|question)[:12]`（run_agent_eval.py）。改问题文本 = 改场景：旧键缓存不再命中，下一轮按新场景实跑（符合预期，场景本身已变）。

| # | idx | 域 / pattern | 旧键 → 新键 | 原问题 | 新问题 | 理由（对齐 SQL 锚点） |
|---|-----|--------------|-------------|--------|--------|----------------------|
| 1 | 7 | fin-cost / ratio_analysis | 0d96b997c4a5 → 6a93e33291fa | 2026年各功能范围期间费用占比 | 2026年1-5月各功能范围期间费用占比 | SQL `month>='2026-01' AND month<='2026-05'`，问题补出窗口 |
| 2 | 11 | inventory / aging_structure | 515dc607498c → 505573221378 | 最近三个月库存库龄结构及长库龄占比 | 2026年4-6月库存库龄结构及长库龄占比 | SQL `calmonth IN ('202604','202605','202606')`，"最近三个月"会漂移 |
| 3 | 21 | ar / aging_structure | 09ae7c7fb83d → 90ec4b05a0dc | 最近三个月应收账龄结构及逾期占比 | 2026年5-6月应收账龄结构及逾期占比 | SQL `query_date IN ('2026-05-02','2026-05-31','2026-06-02','2026-06-07')`，4 个快照日均落在 5-6 月，"最近三个月"会漂移 |
| 4 | 20 | ar / topn_customer | e8d1c3549096 → 788febc07903 | 最新应收余额Top10客户 | 2026年6月7日应收余额Top10客户 | SQL `query_date='2026-06-07'` 固定锚点，"最新"漂移 |
| 5 | 22 | ar / aging_bucket_detail | 4b802e4dcd7a → 83ce3e29fad0 | 最新账龄分段汇总（2023新版） | 2026年6月7日账龄分段汇总（2023新版） | SQL `query_date='2026-06-07'` |
| 6 | 23 | ar / overdue_customer | b44e8cedca17 → a406580ed62e | 最新逾期客户Top10 | 2026年6月逾期客户Top10 | SQL `ed_mon='202606'` |
| 7 | 26 | ar / devalue_by_class | 6ee6fb523245 → 2fb184f2b21d | 最新坏账减值按客户分类汇总 | 2026年6月7日坏账减值按客户分类汇总 | SQL `query_date='2026-06-07'` |
| 8 | 28 | ar / analysis_wbs | 2665c739c83a → c69d69a6e1ca | 最新综合分析按WBS汇总 | 2026年6月综合分析按WBS汇总 | SQL `calmonth='2026-06'` |
| 9 | 30 | sales-performance / org_monthly_achievement | a6bbff3bc0de → c2ac3d42f66a | 今年卫浴事业部业绩情况 | 2026年1-6月卫浴事业部业绩情况 | SQL `calmonth 2026-01~2026-06`，"今年"漂移 |
| 10 | 58 | sku-profitability / sku_trend_mom | da31e668738a → 137a0e7ed74a | 物料FG802702_A近半年销售额环比变化如何？ | 物料FG802702_A 2026年2-7月销售额环比变化如何？ | SQL `calmonth BETWEEN '2026-02' AND '2026-07'`，"近半年"漂移 |
| 11 | 59 | sku-profitability / sku_margin_quadrant | 70d8ae01c0b3 → 59af003014b6 | 近3个月SKU毛利率与销售增长率四象限数据（销售额TOP30） | 2026年5-7月SKU毛利率与销售增长率四象限数据（销售额TOP30） | SQL cur 窗口 `2026-05~07`（增长率对比基期 2026-02~04 由指标定义隐含） |
| 12 | 60 | sku-profitability / sku_turnover_dos | 203e9cf89ff7 → 025680098339 | 7月末库存可售天数最长的50个SKU是哪些？ | 2026年7月末库存可售天数最长的50个SKU是哪些？ | SQL `calmonth='202607'`，问题缺年份 |
| 13 | 63 | sku-profitability / sku_channel_pivot | c5ed87bb3449 → 052b765596fb | 物料FG802702_A在各整合渠道的销售额与毛利率？ | 物料FG802702_A 2026年1-7月各整合渠道的销售额与毛利率？ | SQL `calmonth BETWEEN '2026-01' AND '2026-07'`，问题无时间锚点 |
| 14 | 64 | sku-profitability / sku_fall_top10 | 3f6f6daa2394 → 885950e3c9a1 | 7月末存货跌价TOP10的SKU？ | 2026年7月末存货跌价TOP10的SKU？ | SQL `calmonth='202607'`，问题缺年份 |
| 15 | 65 | sku-profitability / sku_score_top20 | 5a25eba55fc6 → 0465215ae539 | SKU综合效益评分TOP20及处置建议？ | 截至2026年7月SKU综合效益评分TOP20及处置建议？ | SQL 组合窗口：近3月业绩 2026-05~07 + 年内在库 2026-01~07 + 期末库存 202607 |
| 16 | 67 | inventory / inventory_fall_trend | 2190e497d9cf → c74cc9c6d646 | 今年以来存货跌价（减值）每月总额走势？ | 2026年1-7月存货跌价（减值）每月总额走势？ | SQL `calmonth BETWEEN '202601' AND '202607'`，"今年以来"漂移 |
| 17 | 69 | inventory / inventory_impairment_calibers | 109e0b3d45ce → 39d59fa3cb27 | 为什么内部管理减值、阿米巴减值和CHDJ线组分摊的数对不上？各是多少？ | 2026年7月内部管理减值、阿米巴减值和CHDJ线组分摊的数为什么对不上？各是多少？ | SQL `calmonth='202607' / stat_month='2026-07'`，问题无时间锚点（同漂移类） |
| 18 | 70 | inventory / inventory_aging_fall_link | ab755e9b1561 → f4bef513335e | 各事业部2年以上长库龄段的跌价敞口有多大？ | 2026年7月各事业部2年以上长库龄段的跌价敞口有多大？ | SQL `calmonth='202607'`，问题无时间锚点（同漂移类） |

实现方式：文本级精确替换（每条原问题串全文件唯一，替换前断言 count==1），未触碰文件其余字节；改后 parse 前后对照断言**仅 question 字段变化**、CRLF/尾换行/无 BOM 保持；`git diff` = 18 insertions / 18 deletions，全部为 question 行。

## 二、核对后保持原样的条目（开放但不可改 / 已一致）

| idx | 域 / pattern | 问题 | 保持原因 |
|-----|--------------|------|----------|
| 0 | fin-cost / trend_monthly | 2026年各月费用总额趋势 | SQL `year='2026'` **无上界**——改固定窗口（如 1-6 月）会与 SQL 范围不一致。E4 观察到的漂移（录制 6 个月→现 9 个月）根因在 SQL 侧开放式，根治需改 SQL，超出本次"只改 question"边界，**遗留至 M3 前完整回归轮裁定** |
| 9 | fin-cost / summary_year | 2024-2026年各年费用总额汇总 | 问题已固定（2024-2026）；SQL `year>='2024'` 无上界但 dwrfin 表当前无 2027 数据，行数稳定=3。潜在 2027 上界问题记观察 |
| 24 | ar / collection_monthly | 2026年上半年回款月度趋势 | 问题已固定（上半年=1-6月），但 SQL `year='2026'` 无上界——7 月后月份会长出预期外行。漂移在 SQL 侧，本次不可改，遗留同上 |
| 25 | ar / balance_trend | 2026年应收余额月度趋势 | 问题=2026 自然年，SQL=`year='2026'`，两者一致；年内逐月累积属预期行为，非口径漂移 |
| 27 | ar / turnover_days | 应收周转天数趋势（2022年数据） | 问题点名 2022；SQL `calmonth>='202201'` ORDER BY calmonth LIMIT 20 恒取最早 20 行，随数据增长稳定 |
| 14 | inventory / cxc_daily | 2026年6月第一周各基地仓协销日报 | 固定年月+周序号，SQL `BETWEEN '20260601' AND '20260606'`；语义固定无漂移 |
| 18 | inventory / warehouse_type | 仓库库存按类型+财务类别汇总（面积） | 快照表无时间维度，问题与 SQL 一致 |
| 19 | inventory / defective_factory | 各工厂残次品出库量Top10 | 全量表无时间维度，问题与 SQL 一致 |
| 71-76 | redteam 6 条 | — | 红队场景不动（T6 范围外） |

其余 ~45 条问题的窗口表述与 SQL 锚点已一致（如"2026年5月"↔`calmonth='202605'`、"2026年上半年"↔BETWEEN 01~06），未改动。

## 三、skills/fin-cost-knowledge/references/metrics.md：新增"九、pattern → 首选表与字段路由"

- 10 类 pattern（trend_monthly / summary_year / topn_costcenter / account_topn / breakdown_category / topn_mfg_cost / budget_vs_actual / yoy_comparison / ratio_analysis / profit_region）各一条规则：首选表 + 金额字段 + 一句理由。
- 依据 = eval_dataset fin-cost 10 场景期望 SQL（录制口径）+ round-sample2 实测证据；DM 宽表与 dwrfin 明细表都讲得通时一律标注"以 eval_dataset 录制口径为准"，不新拍板口径。
- 已知分歧点写明两表差异：费用总额 dm.amount（报表整合口径，2026-05 实测 4.25 亿）vs dwrfin.local_currency_amt（记账原值口径，同月 2.59 亿）；并援引 E1 手动实测先例（capital_cost.closing_balance 11.86 亿 vs 明细表 zsjkcje 12.43 亿）的辨析方法。
- 实测教训入规则：breakdown_category 勿加 `functional_scope IS NOT NULL`、勿双列分组（9 行变 8 行，E4）。

## 四、验证

- `python -m pytest eval/ -v`：**86 passed**（改前基线同为 86 passed，判定器不受影响）。
- 全 77 条 question↔SQL 时间锚点核对脚本（提取 SQL 时间谓词 → 归一为年/月/日/区间 → 与问题文本窗口表述比对，**仅核对不再改**）：
  - 一致 69 / 无时间维度 N.A. 8（idx 18、19 为快照/全量表；idx 71-76 为 redteam 无 SQL）/ **不一致 0**。
  - `git diff eval_dataset.json` = 18 insertions / 18 deletions，非 question 行改动 0 行。
