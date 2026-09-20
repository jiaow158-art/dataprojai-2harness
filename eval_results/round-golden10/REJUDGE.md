# 金点子轮复判报告（判分器校准后，2026-09-20）

> 首判 0/10 全挂 → 定位为判分器系统性缺陷（非引擎全面退化）：
> ① `extra_cols_ok` 对照面=真值全列，agent 缺真值**派生列**（如 gap=actual−budget）即整体 False——idx4 实测 agent 数值与 fresh 真值**分毫不差**仍被判 FAIL；
> ② 指标列改名（amount→中文别名）无兜底；
> ③ CTE 别名（m/d/line_agg）被当表名污染表集合。
> 修复（TDD，91 测试全绿）：交集列对照+共同指标列要求+同键数值多重集兜底+CTE 过滤。复判零 API 成本（`eval/rejudge_round.py`）。
> 已知限制：录播仅存 answer 前 300 字，`number_in_answer` 抽查注记不可靠（不影响判定主干）。

## 修正后记分板

> **2026-09-20 二次更新**：判分器再修一处（采样录制感知——sku/sales-performance 域 data 只录前 N 行样本，严格全量对照必报假漂移；idx58 因此翻 PASS）。同日五域知识库路由加固完成（inventory/ar/sales-performance/sku/otd 各域 metrics.md 新增路由节，六域现已全覆盖）。

| idx | 域/场景 | 首判 | 复判 | 归因 |
|---|---|---|---|---|
| 4 | fin-cost 预算vs实际 | FAIL | **PASS** | 判分器旧病（数值分毫不差） |
| 1 | fin-cost 功能范围拆分 | FAIL | **PASS** | **T6 路由修复见效**（E4 伤疤愈合：1 条 SQL 直取正确表口径） |
| 58 | sku 环比 | DRIFT | **PASS** | 判分器采样录制假漂移（数值逐月一致） |
| 0 | fin-cost 各月费用趋势 | DRIFT | DRIFT | **引擎无责**：agent 与 fresh 一致；drift=E-6 已知（SQL 无上界） |
| 10 | inventory Top10 物料 | FAIL | FAIL | 真差距（排序口径）→ 路由规则已入律 |
| 11 | inventory 库龄结构 | FAIL | FAIL | 口径 + 数据重述混合（202606 录制后重述 -6,087 万）→ 规则已入律，数据侧需重录 |
| 20 | ar 应收Top10客户 | FAIL | FAIL | agent 口径错已入律；但**场景锚定的 06-07 快照已被上游重跑抹掉**（真值恒空）——需数据集重录 |
| 30 | sales-performance 业绩 | FAIL | FAIL | agent 交叉验证偏差已入律；6 月录制值系部分月入库（11.7M→80.8M）——数据侧需重录 |
| 82 | otd 出库率 | FAIL | FAIL | agent UNION 口径对比行 → 规则已入律 |
| 84 | otd 产区走势 | FAIL | FAIL | agent 净额 vs 录制 ABS + 多表重算 → 规则已入律 |

**引擎无责 4/10（3 PASS + 1 DRIFT-matched）；真差距 6/10，其知识库规则全部入律，待复跑验证；其中 3 条（idx 11/20/30）叠加数据集侧过期/消失锚点，复跑前建议先做零成本数据集修复。**

## 结论

1. 判分器缺陷是首判全挂的主因——**回归轮的"0/10"不可作为引擎能力结论**；修正后引擎真差距 6 条，全部呈"口径/路由"形态（表集合基本正确、行数或聚合口径差），与 E4 归因同族：**T6 式知识库路由加固只做了 fin-cost，其余域未轮到**。
2. fin-cost 域金点子 3 条全部无责（含 2 翻绿）——T6 加固效果在金点子轮得到正向验证。
3. 后续（零 API 成本优先）：T6 模式复制到 inventory/ar/sales-performance/sku/otd 五域 → `--only-failed` 复跑 6 条（小成本）→ 用户人工测试并行。
