# M1-T10 并发冒烟记录（spec §10 验证重点）

- 日期：2026-09-16
- 被测：`engine-gateway`（M1-T9 后工作树，`node src/server/index.ts` 组装形态），产品代码零改动——注入全黑盒（SQLite 直改 cancel_requested，与 `store.requestCancel` 同一条 UPDATE）
- 运行方式：`cd engine-gateway && SOAK_LIVE=1 node test/soak.mjs`（门禁防误跑；可重复执行，本文件每次运行重写为最近一跑）
- 画像：3 批 × 4 画像位 = 12 画像位（2 简单问数 inventory/ar 原文 + 1 报告类 T14 缩水版 + 1 多轮两连问同 session）。多轮第 2 问为独立任务行 → 任务行共 **15**（12 画像位 + 3 个第 2 问），两口径并报
- 池上限 MAX_CONCURRENT_TASKS=3，批内 5 POST 齐发 → 必然排队；user u1~u4（X-User 头）
- 证据目录：`D:\m0-sessions\soak\run-20260916084347`（evidence.json / harness.log / 网关工作树，Temp 树外）

## 任务行明细（15 行）

| 批 | 槽 | 画像 | user | run_id | 终态 | attempt | 墙钟 | 事件数 | 问题（截断） |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | s1 | 简单问数-inventory | u1 | `run-66b1bac8-938…` | succeeded | 1 | 82.5s | 35 | 2026年5月库存量Top10物料 |
| 1 | s2 | 简单问数-ar | u2 | `run-ac7a9925-9c5…` | succeeded | 1 | 126.8s | 46 | 最新应收余额Top10客户 |
| 1 | s3 | 报告类 | u3 | `run-9a4098ed-f9b…` | succeeded | 1 | 185.2s | 58 | 给出2026年8月库存金额与24月以上长龄库… |
| 1 | s4 | 多轮第1问 | u4 | `run-5c5aa93d-e34…` | succeeded | 1 | 233.4s | 38 | 最近三个月库存库龄结构及长库龄占比 |
| 1 | s5 | 多轮第2问(同session) | u4 | `run-9566f1db-0db…` | succeeded | 1 | 307.8s | 23 | 增加去年同期对比 |
| 2 | s1 | 简单问数-inventory | u1 | `run-483d5960-875…` | cancelled | 1 | 8.1s | 4 | 2026年5月长库龄（24月+）物料Top1… |
| 2 | s2 | 简单问数-ar | u2 | `run-347e4f0e-dc8…` | succeeded | 1 | 157.0s | 50 | 最新逾期客户Top10 |
| 2 | s3 | 报告类 | u3 | `run-a785b607-b92…` | succeeded | 1 | 144.9s | 60 | 给出2026年8月库存金额与24月以上长龄库… |
| 2 | s4 | 多轮第1问 | u4 | `run-8cb860c9-9ac…` | succeeded | 1 | 96.6s | 35 | 最近三个月库存库龄结构及长库龄占比 |
| 2 | s5 | 多轮第2问(同session) | u4 | `run-d2a0306b-7ea…` | succeeded | 1 | 179.1s | 20 | 增加去年同期对比 |
| 3 | s1 | 简单问数-inventory | u1 | `run-88e40066-9a0…` | succeeded | 1 | 24.2s | 13 | 2026年5月各工厂库存金额Top10 |
| 3 | s2 | 简单问数-ar | u2 | `run-6bb80498-1f6…` | succeeded | 1 | 42.3s | 25 | 2026年6月回款金额Top10客户 |
| 3 | s3 | 报告类 | u3 | `run-8babf40e-d08…` | succeeded | 1 | 173.0s | 54 | 给出2026年8月库存金额与24月以上长龄库… |
| 3 | s4 | 多轮第1问 | u4 | `run-3341ad83-a1c…` | succeeded | 1 | 82.5s | 21 | 最近三个月库存库龄结构及长库龄占比 |
| 3 | s5 | 多轮第2问(同session) | u4 | `run-d78b24fb-82c…` | succeeded | 1 | 154.9s | 23 | 增加去年同期对比 |

终态分布：{"succeeded":14,"cancelled":1}；批 2 的 s1 为取消注入目标（无 HTTP cancel 端点，DB 直改 `cancel_requested=1`，注入→终态 4.0s）。

## 批次时间线

| 批 | 起止（相对首跑提交） | 墙钟 |
| --- | --- | --- |
| 1 | +0s → +308s | 307.8s |
| 2 | +308s → +487s | 179.1s |
| 3 | +487s → +660s | 173.0s |

## 每任务耗时分布

| 画像 | n | min | median | max |
| --- | --- | --- | --- | --- |
| 全部 | 15 | 8.1s | 144.9s | 307.8s |
| 简单问数 | 6 | 8.1s | 62.4s | 157.0s |
| 报告类 | 3 | 144.9s | 173.0s | 185.2s |
| 多轮第1问 | 3 | 82.5s | 96.6s | 233.4s |
| 多轮第2问 | 3 | 154.9s | 179.1s | 307.8s |

## health 曲线摘要（/api/health 每 5s 采样，共 131 点）

- max queue_depth=**2**（含排队采样点 81/131）· max running=3（池上限 3）
- timeline 观察到 queued 段的任务：15/15
- 变化点（t 相对起点，q=queue_depth，r=running）：
```
  t+   0s  q=2 r=3
  t+  80s  q=1 r=3
  t+ 125s  q=1 r=2
  t+ 180s  q=1 r=1
  t+ 230s  q=0 r=1
  t+ 305s  q=2 r=3
  t+ 310s  q=1 r=3
  t+ 401s  q=0 r=3
  t+ 451s  q=0 r=2
  t+ 461s  q=0 r=1
  t+ 486s  q=2 r=3
  t+ 506s  q=2 r=2
  t+ 511s  q=1 r=3
  t+ 526s  q=1 r=2
  t+ 566s  q=0 r=2
  t+ 636s  q=0 r=1
```

## 断言结果表

| # | 断言 | 结果 | 证据/实际 |
| --- | --- | --- | --- |
| A1 | 全部任务终态无丢失（15 行：14 succeeded + 1 cancelled） | **PASS** | 分布={"succeeded":14,"cancelled":1} 未终态=0 |
| A2 | 排队可见（health queue_depth>0 且任务 timeline 有 queued 段） | **PASS** | max queue_depth=2, 采样点含排队=81/131, timeline 观察到 queued 的任务=15/15 |
| A3-b1 | 同会话串行：第 2 问开始（claim）不早于第 1 问终态（done） | **PASS** | q1.done@1789548462228 ≤ q2.claim@1789548462729 · poll: q2 首次 running=1789548463936 ≥ q1 终态=1789548463934 |
| A3-b2 | 同会话串行：第 2 问开始（claim）不早于第 1 问终态（done） | **PASS** | q1.done@1789548634616 ≤ q2.claim@1789548635090 · poll: q2 首次 running=1789548636942 ≥ q1 终态=1789548634936 |
| A3-b3 | 同会话串行：第 2 问开始（claim）不早于第 1 问终态（done） | **PASS** | q1.done@1789548799161 ≤ q2.claim@1789548799379 · poll: q2 首次 running=1789548799934 ≥ q1 终态=1789548799933 |
| A4a | 各任务 SSE 事件流互不混杂（seq 严格 1..N · 六类词表 · done 唯一且 run_id 对） | **PASS** | 15/15 流完整 |
| A4b | 抽查 3 任务：answer 内容与自己 question 域相关（不串答） | **PASS** | b1-s1/b2-s2/b3-s3 均命中自身域关键词 |
| A4c | 结果目录隔离：sql result_ref 文件全部落在所属 session 的 results 目录，无跨会话文件（12 个 session） | **PASS** | 12 个 session 全隔离（简单 6 + 报告 3 + 多轮 3） |
| A4d | reports/<user>/ 属主正确（3 个报告任务发布、路径=reports/<user>/<run_id>.html、无跨用户产物） | **PASS** | publications=3，全部可归属 |
| A5 | 取消不拖垮池：被取消任务终态 cancelled（done.status=cancelled），同批其余 4 任务全部 succeeded | **PASS** | 目标=cancelled, done.status=cancelled, 注入→终态=4.0s, 同批其余=succeeded,succeeded,succeeded,succeeded |
| A6 | 资源清理：dsh/MCP 进程清零（0/0 → 0/0）、m0sandbox-/run- 容器清零（0 → 0） | **PASS** | workdir+results 留存 3522.5 KB @ D:\m0-sessions\soak\run-20260916084347\sessions（不删，记录大小） |

**总判定：全部 PASS**

## 清理核验清单

| 项 | 运行前 | 结束后 | 判定 |
| --- | --- | --- | --- |
| dsh 引擎进程（--profile sdk） | 0 | 0 | 清零 |
| MCP 进程（本仓路径过滤） | 0 | 0 | 清零 |
| m0sandbox-* / run-* 容器 | 0 | 0 | 清零 |
| workdir+results 目录 | - | 3522.5 KB（留存不删） | 记录大小 |

- 容器名经 SANDBOX_RUN_ID 接线（T9 遗留 L-1 已修，commit 0b020e6）为 `run-<run_id>-a<attempt>-<pid>`，本跑报告任务 exec_script 容器均为调用期瞬态，结束断言零残留
- 发布记录 publications=3（= 报告任务数 3，恰一次）

## 发现（不修，记入 M1 报告）

1. **多轮第 2 问无历史注入（spec §5 D14 缺口）**：`TaskRunner` 仅在 `attempt>1`（恢复路径）调 `buildHistoryPrefix`——同会话正常续问（attempt=1）不注入第一问的问题/回答/result_ref；而 dsh 侧 SDK 会话 id 每次 spawn 带随机段、零自恢复（S3 spike 结论）。故第 2 问「增加去年同期对比」到达模型时**没有上下文**。spec D14 要求"任务出队开始执行时装载该对话最新已提交的历史……保证连续两问时第二问能读到第一问刚完成的结果"——当前实现只覆盖恢复臂，未覆盖正常多轮臂。串行性（A3）不受影响；任务终态仍 succeeded（模型会澄清或泛答），但回答连续性不符合 D14。修复方向：claim 后按 `sessionHistory` 非空即注入（A.2 S2 原文 "attempt>0"）。第 2 问回答开头摘录：
   - b1-s5: 「已读到上轮 14 个结果文件，并按同一口径补算了去年同期的 **202507–202509**（结果已存 `r-20260916164814-18128-1`、`r-20260916164819-18128-2`、`r-20260916164841-18128-3`）。以下是加上同比后的完整结论。 ⏎ ## 一、结论速览 ⏎ 口径不变：**管理口径库存金额 `zsjkcje` + 标准库龄（无保质期 `wbzq_*`）**，202609 为…」
   - b2-s5: 「已读取上一轮 12 个结果文件并**只补查了去年同期的 2025 年对应月份**（202506–202509），未重跑既有查询。以下在原分析上叠加同比。 ⏎ --- ⏎ # 库存库龄结构及长库龄占比（含去年同期对比） ⏎ ## 一、口径补充说明 ⏎ | 项 | 本次口径 | ⏎ |---|---| ⏎ | 数据表 | `dm.dm_fin_stock_detail_accage_t_2023`（与上一轮**完全一致**，保证可比） | ⏎ | 本期 | *…」
   - b3-s5: 「# 最近三个月库存库龄结构及长库龄占比 —— 补充「去年同期对比」 ⏎ 沿用原口径：`dm.dm_fin_stock_detail_accage_t_2023`，管理口径库存金额 `zsjkcje`，标准无保质期库龄分桶 `wbzq_*_amt`（金额，万元）。本期 **202607–202609**，去年同期 **202507–202509**。 ⏎ --- ⏎ ## 一、总量与长库龄占比同比 ⏎ | 月份 | 库存总额 2026 | 库存总…」
2. `done.tokens` 恒 null（M1 编排层未实现 token 统计，T9 遗留 L-2 复现）——词表字段保留，M2 评测前补。
3. 任务书口径："3 批×每批 4 任务=12" 按画像位计；多轮画像两连问天然是 2 个任务行（D14 三层模型：一次提问=一个 run_id），故任务行 15。断言与记录按 15 行执行，无任务丢失。

## 复跑指引

```bash
cd engine-gateway && SOAK_LIVE=1 node test/soak.mjs
```

- 前置同 T9：进程 env 含 DWS_PASSWORD / DEEPSEEK_API_KEY（值不落任何文件）；dsh sdk profile（T2 产物）；docker 镜像 `dataplat-script:m0`；`SOAK_ROOT`（默认 `D:\m0-sessions\soak`，Temp 树外）
- 单任务普遍超 5 min 时按任务书红线把报告题再缩水（编辑 `soak.mjs` 顶部 `REPORT_Q`，保住"报告+exec_script 路径被走到"）

