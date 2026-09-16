# M1-T10 并发冒烟记录（spec §10 验证重点）

> ## ⛔ 本跑 BLOCKED：DeepSeek API 余额耗尽（HTTP 402 Insufficient Balance / QUOTA）
>
> 20260916051330 跑的 15 个任务中 14 个因模型 API 402 失败（每个烧满 3 attempt，~20-35s 快败）。
> 业务面断言（A1/A4b/A4c/A4d/A5 的成功侧）**不可判**，非产品缺陷；机制面断言（排队/串行/流完整性/清理）
> 在本跑**全部 PASS**。**充值后一条命令重跑**（见文末），本文件将被脚本重写为正式记录。
> 402 独立复证：`curl api.deepseek.com/chat/completions` → `{"error":{"message":"Insufficient Balance","code":...}}`。

- 日期：2026-09-16（blocked 跑 05:13:30Z；同日 05:04:56Z 预跑见"预跑局部证据"节）
- 被测：`engine-gateway`（M1-T9 后工作树，`node src/server/index.ts` 组装形态），产品代码零改动——注入全黑盒
  （SQLite 直改 `cancel_requested=1`，与 `store.requestCancel` 同一条 UPDATE）
- 运行方式：`cd engine-gateway && SOAK_LIVE=1 node test/soak.mjs`（SOAK_LIVE 门禁防误跑；可重复执行）
- 画像：3 批 × 4 画像位 = 12 画像位（2 简单问数 inventory/ar 原文 + 1 报告类 T14 缩水版 + 1 多轮两连问同 session）。
  多轮第 2 问为独立任务行（D14 三层会话：一次提问 = 一个 run_id）→ 任务行共 **15**（12 画像位 + 3 个第 2 问），两口径并报
- 池上限 MAX_CONCURRENT_TASKS=3，批内 5 POST 齐发 → 必然排队；user u1~u4（X-User 头，spec §6.3 身份信任链）
- 证据目录：`D:\m0-sessions\soak\run-20260916051330\`（evidence.json / harness.log / 网关工作树，Temp 树外）

## 任务行明细（15 行，blocked 跑）

| 批 | 槽 | 画像 | user | run_id | 终态 | attempt | 墙钟 | 事件数 |
|---|---|---|---|---|---|---|---|---|
| 1 | s1 | 简单问数-inventory「2026年5月库存量Top10物料」 | u1 | `run-ef2c9e4e…` | failed | 3 | 25.0s | 15 |
| 1 | s2 | 简单问数-ar「最新应收余额Top10客户」 | u2 | `run-e2b1ac86…` | failed | 3 | 25.0s | 15 |
| 1 | s3 | 报告类（T14 缩水版） | u3 | `run-40cf637f…` | failed | 3 | 25.0s | 15 |
| 1 | s4 | 多轮第1问「最近三个月库存库龄结构及长龄占比」 | u4 | `run-a599d27e…` | failed | 3 | 39.3s | 15 |
| 1 | s5 | 多轮第2问(同session)「增加去年同期对比」 | u4 | `run-5f4a0900…` | failed | 3 | 53.3s | 15 |
| 2 | s1 | 简单问数-inventory「2026年5月长库龄（24月+）物料Top10」 | u1 | `run-db2c4b41…` | **cancelled** | 1 | 10.1s | 4 |
| 2 | s2 | 简单问数-ar「最新逾期客户Top10」 | u2 | `run-e38fb7e8…` | failed | 3 | 28.9s | 15 |
| 2 | s3 | 报告类 | u3 | `run-1fbbeb8f…` | failed | 3 | 29.2s | 15 |
| 2 | s4 | 多轮第1问 | u4 | `run-e1daf960…` | failed | 3 | 39.7s | 15 |
| 2 | s5 | 多轮第2问(同session) | u4 | `run-22d315d3…` | failed | 3 | 63.9s | 15 |
| 3 | s1 | 简单问数-inventory「2026年5月各工厂库存金额Top10」 | u1 | `run-45ea59bc…` | failed | 3 | 34.4s | 15 |
| 3 | s2 | 简单问数-ar「2026年6月回款金额Top10客户」 | u2 | `run-1500f6dc…` | failed | 3 | 34.4s | 15 |
| 3 | s3 | 报告类 | u3 | `run-b88b745d…` | failed | 3 | 34.4s | 15 |
| 3 | s4 | 多轮第1问 | u4 | `run-90eba668…` | failed | 3 | 55.2s | 15 |
| 3 | s5 | 多轮第2问(同session) | u4 | `run-a46c4f59…` | failed | 3 | 81.3s | 15 |

终态分布：`{"failed":14,"cancelled":1}`（全部 failed 的 error_message 均为
`turn/end reason: {"kind":"error","error":{"message":"Insufficient Balance","code":"QUOTA","status":402}}`）。
批 2 s1 为取消注入目标：注入 → cancelled 落地 **2.0s**（事件边界检查点生效，done.status=cancelled）。

## 批次时间线与 health 曲线（/api/health 每 5s，39 采样点）

| 批 | 墙钟 | 说明 |
|---|---|---|
| 1 | 53.3s | 提交即 3 running + 2 queued；s4 在槽位释放后起跑，s5 等 s4 终态后起跑 |
| 2 | 63.9s | 同上；s1 注入取消 2.0s 落地 |
| 3 | ~85s | 同上 |

变化点序列（dt=s, q=queue_depth, r=running）——每批提交即 `q=2,r=3`，排空后进下一批，三批循环清晰：

```
dt=  0  q=2 r=3      dt= 50  q=2 r=3      dt=115  q=2 r=3
dt= 20  q=1 r=1      dt= 60  q=1 r=3      dt=150  q=1 r=1
dt= 35  q=0 r=1      dt= 80  q=1 r=1      dt=170  q=0 r=1
dt= 90  q=0 r=1
```

max queue_depth=**2**（26/39 采样点含排队）· max running=**3**（=池上限，无超卖）·
timeline 观察到 queued 段的任务 **15/15**（第 2 问排队到第 1 问终态，排队状态对用户可见）。

## 断言结果表（blocked 跑）

| # | 断言 | 结果 | 证据/实际 |
|---|---|---|---|
| A1 | 全部任务终态无丢失（目标 14 succeeded + 1 cancelled） | **FAIL(402)** | 分布 `{"failed":14,"cancelled":1}`，未终态=0（无丢失/无悬挂成立，成功数被 402 清零） |
| A2 | 排队可见 | **PASS** | max q=2 · 26/39 采样点 · 15/15 任务 timeline 有 queued 段 |
| A3-b1/b2/b3 | 同会话串行：第 2 问 claim ≥ 第 1 问 done | **PASS ×3** | DB 事件 created_at：如 b1 `q1.done@…51944 ≤ q2.claim@…52126`；轮询辅证同向；三批全过 |
| A4a | 事件流互不混杂（seq 严格 1..N · 六类词表 · done 唯一且 run_id 对） | **PASS** | 15/15 流完整（含 14 个失败流：stage×N + error + done(status=failed)） |
| A4b | 抽查 3 任务 answer 与问题域相关 | **FAIL(402)** | 模型未产出任何 answer（0B ×15） |
| A4c | result_ref 文件落所属 session 的 results 目录 | **FAIL(402)** | 全部会话 0 sql 产出（模型没跑成任何查询） |
| A4d | reports/<user>/ 属主正确 + 发布记录 | **FAIL(402)** | 0 publications（报告任务未达发布） |
| A5 | 取消不拖垮池 | **FAIL(402)** | 取消本身成立：目标 cancelled + done.status=cancelled + 注入→终态 2.0s；但同批其余 4 任务均因 402 failed（非取消拖垮） |
| A6 | 资源清理 | **PASS** | 结束后 dsh/MCP 进程 0/0、m0sandbox-/run- 容器 0；workdir+results 留存 0.0 KB（引擎未写任何文件） |

**总判定：BLOCKED（业务断言不可判；机制断言 A2/A3×3/A4a/A6 全 PASS）**

## 预跑局部证据（20260916050456 跑，因宿主会话中断被终止；目录后又被测试侧误删，仅存观测值）

充值前最后一个健康窗口的实测（harness.log 原始记录已失，以下为本会话观测转录，DB 对账可复现部分已核）：

- **批 1 全 5 任务 succeeded，墙钟 205.2s**（含报告类任务走完 publishing 发布、20 次真 DWS 查询、
  reports/u3/ 落真实 HTML 产物；DB 对账时 publications 行与产物文件均在场）
- **批 2 取消路径：注入 → cancelled 落地 4.06s**，同批 s2/s3/s4/s5 继续正常执行（不拖垮池的活证据）
- 简单问数单任务 2-3 次查询、多轮第 1 问 5 次、报告类 20 次查询的 result_ref 全部落各自 session 目录（对账 0 缺失 0 外来）
- 该跑中途被宿主中断 → 证明：**网关被 taskkill 后 dsh 树随 stdin EOF 自退（T9 L-3 复现），无孤儿**

## 清理核验清单（blocked 跑收尾后独立复验）

| 项 | 运行前 | 结束后 | 判定 |
|---|---|---|---|
| dsh 引擎进程（--profile sdk） | 0 | 0 | 清零 |
| MCP 进程（本仓路径过滤） | 0 | 0 | 清零 |
| m0sandbox-* / run-* 容器 | 0 | 0 | 清零 |
| workdir+results 目录 | - | 0.0 KB 留存 | 记录（引擎未写文件） |

## 发现（不修，记入 M1 报告）

1. **QUOTA/402 被归类 ENGINE_ERROR，烧满 3 attempt**（产品级，A.4 分类缺口）：DeepSeek 计费类错误
   （`Insufficient Balance / QUOTA / 402`）进入 `TIMEOUT|ENGINE_ERROR` 续跑臂——每任务 3 次无意义重试
   （本跑 15 任务 × 3 = 45 次引擎 turn，好在每次 ~7s 快败）。A.4 行 6 的"凭据无效/权限不足→CONFIG 零重试"
   应涵盖计费/配额类：修复方向——dsh-events 归一化或 TaskRunner 分类器对 `QUOTA|402|balance` 识别为 CONFIG。
   红线内不修，M1 报告转产品待办。
2. **多轮第 2 问无历史注入（spec §5 D14 缺口，代码级确认）**：`TaskRunner` 仅 `attempt>1`（恢复路径）调
   `buildHistoryPrefix`；同会话正常续问（attempt=1）不注入前问的问题/回答/result_ref，而 dsh 侧 SDK 会话 id
   每次 spawn 带随机段、零自恢复（S3 spike 结论）——第 2 问到达模型时无上下文。spec D14"第二问能读到第一问
   刚完成的结果"当前只覆盖恢复臂。串行性不受影响（A3 三批全过）。修复方向：claim 后 `sessionHistory` 非空即注入。
3. `done.tokens` 恒 null（T9 遗留 L-2 复现）——M2 评测前补。
4. 测试侧教训（已在 soak.mjs 修复，供复跑者知悉）：① renderReport 引用 try 块局部 `batchMeta` 致收尾
   ReferenceError（已提为模块级；evidence.json 在崩溃前已落盘，故本记录数据完整）；② 运行中的 run 目录不可
   手工 rm（本会话曾误删预跑目录导致其 A4c 证据损失）；③ Windows 目录名不可尾点（RUN_TS 曾切出
   `run-20260916050223.`，已改为 14 位无点）。
5. 口径说明：任务书"3 批×每批 4 任务=12"按画像位计；多轮画像两连问天然 2 任务行（D14），故任务行 15。

## 复跑指引（充值后）

```bash
cd engine-gateway && SOAK_LIVE=1 node test/soak.mjs
```

- 前置同 T9：进程 env 含 DWS_PASSWORD / DEEPSEEK_API_KEY；dsh sdk profile（T2 产物）；docker 镜像 `dataplat-script:m0`；
  `SOAK_ROOT`（默认 `D:\m0-sessions\soak`，Temp 树外）。跑完自动重写本文件为正式记录。
- 参考预算：健康态下批墙钟 ~205s（预跑实测），三批 + 断言 ≈ 12-15 min。
- 单任务普遍超 5 min 时按任务书红线把报告题再缩水（编辑 soak.mjs 顶部 `REPORT_Q`，保住"报告+exec_script 路径被走到"）。
