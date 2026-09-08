# M0-T10 验证记录：deepseek-v4-flash 问数 smoke（本地 Windows）

- 日期：2026-09-08
- 环境：dsh 0.1.2-rc.1（npm 全局 `@deepseek-ai/dsh`），Windows 10；MCP 桥接 = M0-T9 配置
  （`C:\Users\Administrator\.dsh\profiles\headless\cordis.patch.yml`，见 `m0/tests/mcp_bridge_check.md`）
- 依据：`m0/findings/dsh-api.md` §1（headless 调用）、§5.3/§5.4（会话落盘与事件结构）、§6（模型路由）
- 关联计划：`docs/superpowers/plans/2026-09-08-dsh-m0-capability-verification.md` Task 10

---

## 1. 问题（eval 场景原文）

| 项 | 值 |
|---|---|
| eval 场景定位 | `eval_dataset.json` → `questions[]`，**inventory 域第 1 个场景**（数据集无显式 id 字段，以 domain+pattern 定位） |
| domain | `inventory` |
| pattern | `topn_material`（非 report 类简单问数） |
| question 原文 | `2026年5月库存量Top10物料` |
| 期望 row_count | **10**（checksum `rows=10`） |
| 期望基准 SQL 要点 | `dm.dm_fin_stock_detail_accage_t_2023`，`calmonth='202605'`，按 `SUM(quantity)` 排序取 Top10 |

## 2. 执行（Step 2 原样计时）

```bash
start=$(date +%s)
dsh --profile headless "2026年5月库存量Top10物料"
end=$(date +%s)
```

- Git Bash 实跑，**exit 0**，wall clock **22s**（stdout 重定向至文件取证，见 §4）。

## 3. 模型回答摘要

回答为 Markdown 表格，**10 行数据**，字段：排名 / 物料编码 / 物料描述 / 库存数量(PC) / 库存金额(元)。

- 模型明确声明口径：内部库存账龄明细表 `dm.dm_fin_stock_detail_accage_t_2023`、账期 `calmonth='202605'`、按 `SUM(quantity)` 汇总。
- 结论具体合理：榜首 LN63111_A（600X300瓷片白砖）232.9 万片；并指出第 4 名 QFG801034_A（800X800卡帕灰）数量仅 88 万片但金额 1352.7 万元为 Top10 最高（大规格高值产品）。

## 4. 正确性初判 —— 行数吻合，数值逐行一致

对照 `eval_dataset.json` 该场景的 `data`（期望 10 行）：

| # | 物料 | 模型数量 | 期望数量 | 模型金额 | 期望金额 |
|---|---|---|---|---|---|
| 1 | LN63111_A | 2,328,784 | 2328784.0 | 7,164,980.41 | 7164980.408748 |
| 2 | LN63720_A | 1,277,599 | 1277599.0 | 3,743,476.80 | 3743476.80448 |
| 3 | LN63290_A | 1,148,591 | 1148591.0 | 3,490,833.49 | 3490833.4944 |
| 4 | QFG801034_A | 880,670 | 880670.0 | 13,527,090.30 | 13527090.3 |
| 5 | LN630742_A | 825,528 | 825528.0 | 2,559,154.94 | 2559154.94 |
| 6 | CFG800653_A | 692,429 | 692429.0 | 9,891,398.29 | 9891398.289556 |
| 7 | LX630734_A | 563,458 | 563458.0 | 1,546,289.73 | 1546289.730504 |
| 8 | FG607064_A | 551,767 | 551767.0 | 4,153,769.66 | 4153769.66 |
| 9 | CFG800641_A | 550,380 | 550380.0 | 7,839,587.96 | 7839587.961761 |
| 10 | LX630731_A | 540,398 | 540398.0 | 1,605,866.48 | 1605866.475309 |

- **行数吻合**：模型报告 10 行 == 期望 row_count 10 == 工具响应 `row_count: 10, truncated: false`。
- **排序与数值逐行一致**：10 行物料、数量、金额与 eval 期望数据完全相同（金额四舍五入到分位）。
- 会话日志中模型实际执行的 SQL（seq 1059，`mcp__dws__run_query`）：

```sql
SELECT material,
       MAX(material___t) AS material_desc,
       MAX(unit) AS unit,
       SUM(quantity) AS stock_qty,
       SUM(zsjkcje) AS stock_amt
FROM dm.dm_fin_stock_detail_accage_t_2023
WHERE calmonth = '202605'
GROUP BY material
ORDER BY stock_qty DESC
LIMIT 10
```

与基准 SQL 同表、同过滤、同聚合口径（`SUM(quantity)` 排序）。工具响应落盘
`m0/results/r-20260908124633-41404-1.json`（双通道完整结果，未跟踪、不提交）。

## 5. 耗时与 token（会话日志取证）

会话：`C:\Users\Administrator\.dsh\sessions\--D-dataprojai-2harness--\session-da59c2ff-8572-4087-8e49-ffe7d778b33f\session.jsonl.zstd`
（Python `zstandard` 0.25.0 解压 JSONL，逐事件解析）

**耗时：**

| 项 | 值 |
|---|---|
| wall clock（Git Bash 计时，含进程启动/MCP 子进程拉起） | **22s** |
| 会话日志跨度（session.createdAt → turn/end，`time` 字段） | **17.0s**（1788842781492 → 1788842798444 ms） |
| 总事件数 | **140**（session 1 / turn 1 / step 5 / tool/call 4 / tool/result 4 / assistant/message 5 等） |

**token（`assistant/message` 事件的 `data.usage` 字段，5 条累加）：**

| 字段 | 累计值 |
|---|---|
| inputTokens | 24,130 |
| outputTokens | 1,830 |
| totalTokens | 116,968 |
| cacheReadTokens | 91,008 |
| reasoningTokens | 932 |

- usage 字段**存在**（在 `data.usage`，非事件顶层；findings §5.4 所记位置略有偏差，实为嵌套一层）。
- 每步明细：step1 input 4,098 / output 125；step2 1,312 / 158；step3 7,743 / 338；step4 10,258 / 536；step5 719 / 673。
  totalTokens 累计(116,968) 大于 input+output 之和，因 total 含 cacheReadTokens——高缓存命中率（91,008）是 5 步多轮工具循环未爆炸的主因。

**工具调用链（证据，均为会话日志原文）：**

1. `skill({"name": "inventory-knowledge"})` → 加载项目根 `.dsh/skills/inventory-knowledge`（T7 验证过的零修改迁移副本）
2. `read(.dsh/skills/inventory-knowledge/references/metrics.md)` → 遵守"必须首先查阅 metrics.md"规则
3. `mcp__dws__describe_table("dm.dm_fin_stock_detail_accage_t_2023")`
4. `mcp__dws__run_query(上方 SQL)` → 10 行真实数据

即 skill 路由 → 语义层 → MCP 表结构 → MCP 查询的完整链路在一次 headless 运行内走通。

## 6. 结论

**smoke 通过。** deepseek-v4-flash 经 dsh headless 完成一次真实问数：行数与期望 row_count（10）吻合、
10 行数值与 eval 基准逐行一致、口径选择正确（内部账龄明细表 + calmonth 过滤）；wall clock 22s
（会话日志内跨度 17.0s），token 有据（input 24,130 / output 1,830 / cacheRead 91,008）。

---

## 附：密钥与仓库卫生自查

- `DEEPSEEK_API_KEY` / `DWS_PASSWORD` 值在本次所有输出与文件中**零明文出现**。
- `m0/results/` 查询结果（含业务数据）保持未跟踪、不提交；commit 仅含 `m0/tests/model_smoke.md`（路径限定提交）。
