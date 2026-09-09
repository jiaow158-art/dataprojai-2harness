# M0-T16 验证记录：三连问多轮测试（口径/组织/结果引用延续验证）

- 日期：2026-09-09
- 环境：dsh 0.1.2-rc.1（**sdk profile**，含 m0-exec-script-plugin bundle + mcp-dws patch），
  Windows 10 + Git Bash + Docker Desktop（沙箱镜像 `dataplat-script:m0`），模型 deepseek-v4-flash
- 关联：计划 Task 16；spec D14 三层会话模型"上下文正确延续"；前置 T14（单次全链路）/ T13（exec_script）/ T9（MCP）
- 会话取证原材料（不入库）：`/d/m0-sessions/t16/`（driver.log、run-q*.md、sdk_client.mjs、events_dump.txt、取证据脚本）

---

## 1. Status: DONE_WITH_CONCERNS

**多轮延续成立**：同一 session_id 三连问（Q1 独立分析 → Q2 八字追问 → Q3 六字追问+报告生成），
三轮 turn 全部 `completed`、exit 0、全程零人工干预。Q2 仅凭"增加去年同期对比"八个字即正确理解为
"同口径 2023Q3 对比"（时间范围/组织维度/指标口径三延续，且主动发现并披露跨年组织口径变化）；
Q3 仅凭"保留刚才的口径，生成一份报告"即复用 Q1/Q2 结果生成 1.08MB HTML 报告（零新查询，
report-generator skill + exec_script 全链路复用 T14 路径）。
**Concern**：SDK 面为使工具面与 headless 等价，需要把 MCP/exec-script/工具白名单 patch 移植到
sdk profile（见 §8）——这是配置面工作而非引擎能力缺口，但 M1 迁移时必须固化。

## 2. 多轮机制实测结论（先实验，后定型）

计划给定的备选实验（同 cwd 两次 headless 调用是否共享上下文）**无需再做**：findings dsh-api.md §5.1
已有 headless `--resume` 不存在 + README 原文 "One task per run" 的实测记录；且 T14 之前 4 次 headless
运行 4 个独立会话文件。本次直接走 **SDK session_id 路线**（findings §5.3 预案）：

| 机制 | 结论 |
|---|---|
| headless CLI 同 cwd 连续调用 | **不延续**（每次运行独立 session-<uuid>，4 次运行 4 文件，findings §5.3 已实测；本次未重测） |
| **SDK `session/prompt` 复用 sessionId** | **延续成立（本次采用）**。`dsh --profile sdk`（JSON-RPC stdio）下，同一 sessionId 的多次 `session/prompt` 落同一持久会话；协议原文："The SDK-side session id; an unknown id lazily creates the agent+session pair"（dsh-sdk-protocol types.d.ts，本机 npm 包内）；server 实现 `getOrCreateSession`（同 id 取既有 agent） |
| 会话落盘 | `~/.dsh/sessions/--D-m0-sessions-t16-workdir--/t16-ea69d9d3/session.jsonl.zstd`（**cwd slug 与 headless 同规则**；**目录名 = session_id 本身**，不再是 session-<uuid>——SDK 自选 id 直接作为持久化身份，这同时证明"持久化以 id 为键"） |

驱动方式：自写 60 行 Node JSON-RPC stdio 客户端（`dsh --profile sdk` 子进程，initialize → 3×
`session/prompt` → shutdown），每问等待 `turn/end` 通知后发下一问，超时 15 分钟断路。
SDK 事件流（`session.event` 通知）实时拿到 turn/end 与 assistant 终文，无需等进程退出再解会话文件。

## 3. 会话事实

| 项 | 值 |
|---|---|
| session_id | `t16-ea69d9d3`（SDK 侧自选） |
| cwd（会话头） | `D:\m0-sessions\t16\workdir`（Temp 树外，T13 定型规范） |
| provider/model | deepseek-official / deepseek-v4-flash（会话日志 assistant/message source 原文） |
| 三问起止（driver 时钟） | 00:03 Q1 → 01:28 Q1 完（84s）→ 01:28 Q2 → 03:12 Q2 完（104s）→ 03:12 Q3 → 08:45 Q3 完（333s）→ shutdown，全程 528s |
| exit | driver exit 0；三轮 turn/end reason 均 `{"kind":"completed"}` |
| 单问超时 | 84s / 104s / 333s，全部 << 15 min 断路线 |
| token（assistant/message usage 累加） | Q1: in 41,199 / out 8,840；Q2: in 6,823 / out 12,017；Q3: in 29,215 / out 34,665；总计 in 77,237 / out 55,522 / cacheRead 3,517,312 / reasoning 36,545 |
| 工具面 | request/header 26 项，与 T14 完全同集：`pwsh`/`web_fetch`/`web_search`/`workflow`/`ralph` 全部缺席，`exec_script`+`mcp__dws__*`(4) 在列 |

**三问原文逐字核验**（会话日志 user/message 与计划原文 byte-equal，UTF-8 解码比对 True×3；
seq 7 / 8562 / 20471，`source.kind: "user"`）：

```
seq=7     分析2024年Q3各事业部库存跌价准备金额
seq=8562  增加去年同期对比
seq=20471 保留刚才的口径，生成一份报告
```

## 4. 执行轨迹摘要（session.jsonl.zstd 2,643 事件解压取证）

- **skill 加载**：T1 inventory-analyst + inventory-knowledge（动眼前先读 metrics.md / stock-fall-list.md /
  stock-accage.md —— mandatory first-read 自发遵守）；T3 report-generator（读 report-schema.json + build.py +
  validate_report.py）。
- **MCP DWS 查询 6 次，全部成功零报错**：T1 四次（月度总量探测 / 分事业部透视 / 库龄段构成 / 合计对平），
  T2 两次（2023Q3 分事业部透视 + 月度总量——**只查去年同期，未重查 2024**）。
- **MCP 落盘 6 个 result_ref**（`m0/results/r-2026090910*.json`，进程号 34092 全新于 T14 的 4464），
  逐文件 SQL 与会话 tool/call seq 对上：T1 → seq 1656/2162/3520/3522 四件，T2 → seq 9219/9221 两件。
- **exec_script 11 次**：T1 零次（纯 MCP 即可完成）；T2 一次（yoy_calc.py，把两问取数硬编码复核全部同比）；
  T3 九次（探针/生成 REPORT_JSON/调试×2/构建/验证/清理——T14 同款 write→exec 时序错误 1 次后自愈，
  另有 2 次 Python 脚本运行错，模型读 traceback → str_replace 修复 → 重跑通过）。
- **自纠错 5 次（1 read 路径错 + 4 exec 错）全部吸收**，无一次绕过沙箱或放弃。无 pwsh/web 调用尝试。
- T3 期间**零新增 MCP 查询、零新增 result_ref**——报告数据全部来自会话内已取得的结果。

## 5. 五断言判定

| # | 断言 | 判定 | 证据 |
|---|---|---|---|
| A1 | Q2 的 SQL 含同期（去年/同比）条件 | **PASS** | T2 两次查询 seq 9219/9221 均 `WHERE calmonth BETWEEN '202307' AND '202309'`（2023Q3）；落盘件 r-…-5/-6.json sql 字段同值可独立复核；Q2 回答含完整同比表（+10.0% 瓷砖 / -3.1% 集团 / 同代码 +7.5%）与逐月同比趋势 |
| A2 | Q2 的组织维度与 Q1 一致（同为各事业部） | **PASS** | Q2 SQL 与 Q1 主查询（seq 2162）**结构逐字段一致**：同表 `dm.dm_fin_stock_detail_accage_t_2023`、同维度 `zdpsyb`/`zdpsyb___t`、同指标 `jchj_amt`、同 `GROUP BY zdpsyb`；仅时间谓词换成 2023。回答还主动做了跨年编码比对（家居 11000003 退出 / 国际 11240102 新增 / 11000011/12 描述漂移）——组织延续且延续到了编码级 |
| A3 | Q3 未重新定义口径，复用 Q1/Q2 范围 | **PASS** | T3 零次 DWS 查询（事件日志全量核验）= 口径只能来自会话上下文；报告 JSON subtitle/filters 原样写"内部管理口径 jchj_amt … 2024-07 ~ 2024-09（对比基期 2023-07 ~ 2023-09）｜事业部维度 zdpsyb"；provenance.query 引用 Q1/Q2 SQL 原文 |
| A4 | Q3 产出报告且数据引用前两问结果（而非重查全部） | **PASS** | (a) 产物：`workdir/reports/report_inventory_20260909.html` 1,077,583 B + 契约 JSON（sections[5]+kpis[4]+insight+provenance 七键，build.py 管线）；(b) **重查鉴别**：新增 result_ref 计数 Q3=0 vs Q1=4（模型还把 Q1/Q2 SQL 原文写进 provenance.query 备查，进一步证明没有再取数）；(c) **数值级延续**：gen_report_json.py 内嵌的 7 事业部×6 值与 Q1/Q2 result_ref 数据逐值相等（42 值中 40 值全等，2 值为"编码不在对方年份结果集"的正确 None 语义——家居 2024 退出、国际 2023 未出现，见 §7 脚注） |
| A5 | 三问全程无用户干预 | **PASS** | 会话日志 user/message 仅 3 条且逐字等于计划三问（含 2 条系统注入的 runtime-context/skills 快照，非人工）；SDK 通道为纯程序化 JSON-RPC，无审批应答（approval/asked 事件零次——T16 会话无此事件类型出现）；三轮 turn/end reason 均 completed，无 interrupted/error |

## 6. 失败归因

**本轮无失败。** 需要如实记录的两次**前置试跑失败**（均在正式取数前定位并排除，不影响结论）：

1. **首跑（session t16-bfe55bde）三轮全废**：驱动脚本 JS 字符串 `cwd` 写成单反斜杠，`\t` 被转义成制表符，
   会话头 cwd 变成 `...\workdir\m0-sessions<TAB>16workdir`；模型穷尽环境排查后如实报告"工作区不存在、无数据"，
   **未编造任何数字**（Q3 给出占位框架并声明数据缺失）——错误在驱动不在模型，但该轮同时暴露
   sdk profile 缺 MCP/exec_script patch（模型当时唯一可用的执行通道 pwsh 因路径坏而不可用）。
   记录价值：模型的"拒绝编造"行为在多轮下保持稳定。
2. **sdk profile 初始化竞态**：`dsh --profile sdk --help`（本任务早期探测）会自举 profile 并把 package.json
   重写为空 bundles，覆盖已写入的 patch——正式运行前必须"先写好三件套（package.json / cordis.yml /
   cordis.patch.yml）→ pnpm install（本地 link 插件）→ 诊断客户端验证 initialize 应答"，再跑正式三轮。

## 7. 备注（如实上报）

- **A4 的 2 处"不等"是正确语义而非失配**：11000003（家居）不在 Q1 2024 年结果集中（该编码 2024Q3 已不存在），
  11240102（国际营销中心）不在 Q2 2023 年结果集中（2023 无此编码）；脚本均置 None 并在报告中以
  "组织退出/新增"双口径披露——这正是 A2 组织延续到位的副作用。
- **exec_script 跨文件系统时序错误率下降**：T14 为 7/7 首调必失败，本次 T3 仅 1 次踩中（同一 write→exec 间隙），
  其余 8 次脚本调用首调即成功；不改变 T14 结论（M1 建议在 exec-script.ts 加 ≤2s 存在性等待），样本量小仅作记录。
- **报告质量不在本任务范围**（计划原文）：报告结构对 REPORT_JSON v2 契约成立（tab 5 / kpi 4 / provenance 七键），
  数值与 Q1/Q2 会话内结果自洽即视为达标；与金样的指标级对齐属 T15 范畴。
- 会话日志 user/message 事件在控制台显示为乱码系 GBK 终端显示问题，字节内容为合法 UTF-8（verify_prompts.py
  byte-equal 三连 True 为准）。

## 8. 对 M1 的移交项（配置固化）

sdk profile 要达到 headless 同等工具面，需固化三件事（本次 `~/.dsh/profiles/sdk/` 已按此配置，
但 profile 目录不入库，需在 M1 落为脚本/文档）：

1. `package.json` bundles = `dsh-base + dsh-sdk-app + m0-exec-script-plugin`（本地 link 依赖需 `pnpm install`）；
2. `cordis.patch.yml` = mcp-dws 插入 + tool-pwsh/web/workflow/ralph 禁用 + skill-filesystem customSkillDirs
   （与 headless patch 逐条同源）；
3. 启动校验：initialize 应答 `serverInfo.name = deepseek-harness-sdk-runtime` 且 request/header 工具集 26 项
   与 T14 同集（pwsh/web 缺席、exec_script/mcp__dws 在列）。

## 9. 提交

- 新增：本记录 `m0/verify/multiturn_check.md`。
- commit：`test(m0): 三连问多轮—口径/组织/结果引用延续验证`（路径限定 `m0/verify/multiturn_check.md`）。
- 会话取证原材料（不入库）：`/d/m0-sessions/t16/`——driver.log（三轮时序）、run-q1/q2/q3-answer.md（三轮终文）、
  run-meta.json（session_id/turn_ends）、sdk_client.mjs（JSON-RPC 驱动）、events_dump.txt、
  verify_prompts.py / verify_results.py（断言取证脚本）；
  会话文件：`~/.dsh/sessions/--D-m0-sessions-t16-workdir--/t16-ea69d9d3/session.jsonl.zstd`（2,643 事件）；
  产物（不入库，workdir 属沙箱白名单）：`/d/m0-sessions/t16/workdir/reports/report_inventory_20260909.html`（1,077,583 B）。
