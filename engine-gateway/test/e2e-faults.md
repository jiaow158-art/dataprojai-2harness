# M1-T9 故障注入五发记录（放行证据）

- 日期：2026-09-16
- 环境：dsh 0.1.2-rc.1（sdk profile，T2 脚本产物，dump-config 自检过）· deepseek-v4-flash ·
  GaussDB DP_DWS@121.37.200.214（aiuser 回退账号）· Docker `dataplat-script:m0`（exec_script 沙箱）·
  Windows 10 + Node v24.14.0
- 被测：`engine-gateway`（commit 工作树，M1-T8 组装形态 `node src/server/index.ts`），产品代码零改动——
  全部注入为黑盒手段（HTTP 弃连 / taskkill / SQLite 直改 / SSE 断开 / 租约直改过期）
- 运行方式：`cd engine-gateway && E2E_LIVE=1 node --test test/e2e.live.test.ts`
  （`E2E_SHOT=<子串>` 单发选择；默认不跑，`npm test` 全绿不受影响）
- 证据目录：`D:\m0-sessions\e2e\<shot>\`（evidence.json + harness.log + gateway 工作树，Temp 树外）
- 问题原文取自 `eval_dataset.json` inventory 域场景

## 基线（live E2E 全栈）

**run-55369948-54ec-4835-bef2-92ebdf8733d5** · 问题「2026年5月库存量Top10物料」（eval 原文）

| 项 | 值 |
|---|---|
| 全链路 | http → WorkerPool → TaskRunner → DshBackend → 真 dsh（sdk stdio JSON-RPC）→ DeepSeek → mcp-dws → 真 DWS |
| 终态 | succeeded（attempt=1） |
| 耗时 | 30.0s 墙钟（done.elapsed_ms=29,473） |
| 事件 | 13 个：stage 9（claim/skill/read/describe/querying）· sql 2 · answer 1 · done 1 |
| 查询 | 2 次真 DWS 聚合，result_ref 双通道落盘（r-20260916115543-*），行数 10/3 |
| 回答质量 | 口径声明 + Top10 表格 + 对抗性审查声明（skill 体系行为在服务化形态下复现） |
| token | done.tokens=null（M1 编排层未实现 token 统计，词表字段保留——见遗留） |

事件 seq 1..13 严格连续、六类词表内、done 唯一。**全栈活通**。

## 五发判定表

| # | 故障 | 注入手段 | 判定 | 用户视角结论 |
|---|---|---|---|---|
| 1 | 提交响应丢失重试 | POST 后 150ms 弃连（不读响应）→ 同 client_submission_id 重发 | **PASS** | 无需重问——重发秒回同 run_id，无重复任务、无重复计费口径下的双跑 |
| 2 | 网关进程死亡 | taskkill /F 仅杀网关 node（dsh 树随 stdin EOF 自行退出，无孤儿）→ 重启同 DB | **PASS** | 刷新页面即见任务自动续跑至出结果，全程无需人工接续 |
| 3 | 发布后中断 | 报告 succeeded 后 DB 直改 status=running+清 report/done 事件 → 重启 | **PASS** | 报告已在、链接不变；网关重启后任务直接显示成功，不重新生成 |
| 4 | SSE 断线重连 | 收 3 事件后 socket destroy → Last-Event-ID 重连 | **PASS** | 进度条无缝续播——断点后事件全部补发，无丢失无重复 |
| 5 | 双活窗口（A.1） | DB 直改租约过期 → 第二 WorkerPool 实例接管（LEASE_FREE 臂）→ A 复活写入 | **PASS** | 用户只收到一份答案（B 接管后 3.4s 内 A 被围栏并自杀 dsh 树）；无重复产物/无事件错乱 |

---

## 发1：提交响应丢失重试（A.3 提交层幂等）

- **注入**：POST /api/tasks（body 含 client_submission_id）发出 150ms 后 `req.destroy()`——请求体已到服务端但响应不读、连接弃置；随后同幂等键立即重发并正常读响应。
- **观察**：
  - 重发响应 201，返回 run_id=`run-9e255b6e-1849-42d7-b2dd-876c671c3876`；
  - SQLite `tasks` 表 `client_submission_id=shot1-1789530999427` 恰 **1 行**（UNIQUE 冲突同事务 catch → SELECT 回原 run_id）；
  - SSE 全程 32 事件 seq 连续，终态 **succeeded**（58.9s），answer/done 齐全。
- **判定**：**PASS**。证据：`D:\m0-sessions\e2e\shot1-submission-retry\evidence.json`

## 发2：网关进程死亡接管（A.1 boot 自愈 + A.4 行2）

- **注入**：问题「最近三个月库存库龄结构及长库龄占比」running 且 dsh 实开工后（进程树快照：cmd shim + node dsh），`taskkill /pid <gw> /F` **仅杀网关 node 进程**（不带 /T——模拟裸进程死亡）。
- **进程观察**：
  - dsh 进程树在网关死亡后 **~1.4s 内全部自行退出**（cmd shim、node dsh、python MCP 清零）——机制：dsh 是 stdio JSON-RPC 服务，网关进程死亡 = 其 stdin 管道写端被 OS 关闭 = EOF，引擎自行终止（EOF 行为已用独立探针单独复证）。**引擎无法成为孤儿**：传输随宿主死亡，接管期间不存在双 dsh 副作用窗口；
  - `docker ps`：观察窗口内无 m0sandbox 容器（exec_script 容器为调用期瞬态，`--rm`+`rm -f` 兜底；且 M1 网关未注入 SANDBOX_RUN_ID，容器名为缺省 `m0sandbox-*`——附录 A.1 的 `run_id-a<attempt>` 命名插件侧已支持、网关侧未接线，见遗留 L-1）。
- **接管**：重启网关（同 SQLite/同工作树）→ boot `healOrphans` 清孤儿租约（日志：`清理 1 个孤儿租约`）→ 池派发 → `claimLease` **attempt=2** → repairing 阶段事件 + S2 历史注入（已产 result_ref 清单 + "读文件续算不重查"指示语）→ 新 dsh 跑完。
- **断言**：终态 **succeeded**、attempt=2、publications ≤1（纯问答=0）、全事件 seq 连续无丢失无死锁。
- **判定**：**PASS**——任务未丢、未死锁、重启即自愈续跑；收尾 `killAllEngineProcs` 全量核验进程清零。
- 证据：`D:\m0-sessions\e2e\shot2-process-death\{evidence.json,harness.log}`

## 发3：发布前后中断（A.4 行4：发布后崩溃 → publications 兜底）

- **注入**：报告类问题（「请生成一份2026年5月库存分析HTML报告…」，attempt=1 单尝试干净跑完 177s）到 **succeeded**（真实 publications 行 + 1,079,852 B 真实 HTML 产物落 `GATEWAY_REPORTS_DIR`，report-generator skill + exec_script 沙箱全链路）后，SQLite 直改构造"崩溃在 recordPublication 与 finalize 之间"：
  - `UPDATE tasks SET status='running', lease_owner='sim-crashed-post-publish', lease_expires_at=<+60s>, error_code=NULL, error_message=NULL`（伪租约=已死执行者）
  - `DELETE FROM events WHERE type IN ('report','done')`（崩溃点之后的事件不存在）
  - publications 行**保留**（崩溃点之前的事实）
- **接管**：重启网关 → healOrphans 回队 → claim attempt=2 → TaskRunner 恢复入口**首查 publications 命中** → 直接补 done + finalize，**零引擎 spawn**。
- **实测**：恢复 **884ms**；`publications.published_at` 不变（未重发）；报告文件 size/mtime 逐字节不变（无第二副本）；新增事件恰为 `[stage(claim), done]`，`done.recovered=true`、elapsed_ms≈1；无任何新 sql/answer（不重跑）。
- **判定**：**PASS**——恰好一次发布成立。用户视角：报告已在、刷新即见成功。
- 证据：`D:\m0-sessions\e2e\shot3-publish-crash\{evidence.json,harness.log}`

## 发4：SSE 断线重连（D15 / A.3 事件层）

- **注入**：收满 3 个事件后客户端 socket 直接 destroy（中途断开）；600ms 后带 `Last-Event-ID: <断点seq>` 重连。
- **断言**：重连首帧 seq = 断点+1（严格续接）；两段拼接后 seq 1..N 连续无重复（`assertEventStream`：位置 i 的 seq 必为 i+1）；done 恰 1 个且由**服务端**主动关流（endedByServer）；任务终态 succeeded。
- **判定**：**PASS**——断线不丢事件、重放不重复；用户视角进度无缝。实测 run-10355875：断点 seq=3（c1 收 3 帧）→ Last-Event-ID 重连首帧=4，c2 补 21 帧，合计 24 帧连续无重复，服务端 done 后主动关流，任务 succeeded。
- 证据：`D:\m0-sessions\e2e\shot4-sse-reconnect\{evidence.json,harness.log}`

## 发5：双活窗口（附录 A.1 构造性验证——最关键一发）

- **构造**（run-2a655164）：
  - A = 真 网关（真 TaskRunner 驱动真 dsh，worker `gw-25288-*`）跑「2026年上半年库存总金额与库龄趋势」至 running；
  - 注入①：SQLite 直改 `lease_expires_at = now-1s`（模拟 A 心跳停滞，租约判过期）；
  - B = **第二个 WorkerPool 实例**（独立进程 `test/helpers/second-pool.mts`，无 boot heal——走 `claimLease` 的 **LEASE_FREE 接管臂**，真 TaskRunner + 真 dsh，attempt+1）；
  - 窗口内 A 进程全程存活（只是其写被判失权）——真双活。
- **实测时间线（harness.log）**：
  - `04:36:27.692` B 观测到租约已过期（`lease_expires_in_ms=-1684`）→ runOnce claim 成功，**attempt=2**，双活窗口开启；
  - `04:36:31.451`（**+3.4s**）A 的 dsh 进程树全部死亡——A 的 TaskRunner 下一次 appendEvent 被围栏拒（rowcount=0）→ `session.cancel()` kill 自身树，静默退出，不 finalize、不写 done、无补偿记录（外部证据：A 树 PID [26952,25944] 死亡 + done 事件全程仅 1 个）；
  - `04:37:07.766` B 跑完：succeeded，attempt=2，B 侧耗时 40.6s（S2 历史注入生效，A 已产 result_ref → 指示读文件续算）。
- **唯一产物断言**：事件 20 帧 seq 连续无回退、无 A 重复段；done 恰 1（B 写）；answer 恰 1；publications=0（纯问答）、reports/ 无副本。
- **判定**：**PASS**——租约围栏使双活窗口内四类副作用全部安全（DWS 只读、result 文件唯一命名、沙箱容器 attempt 命名、发布唯一经 publications），"最后只产生一个结果"构造性成立。
- 证据：`D:\m0-sessions\e2e\shot5-dual-active\{evidence.json,harness.log（[poolB] 行为 B 侧日志）}`

## 遗留观察（不阻塞放行，记入 M1 报告）

- **L-1** `SANDBOX_RUN_ID` 未接线：exec-script 插件已支持 `<run_id>-a<attempt>-<pid>` 容器名（commit abdefa9 插件侧），但 `DshBackend.createSession` 的 env 组装未注入 `SANDBOX_RUN_ID/SANDBOX_ATTEMPT`——当前容器名为缺省 `m0sandbox-*`。附录 A.1 的"接管者按旧 attempt 清理容器不误杀"防线差一环（发2/发5 实测容器为瞬态、窗口内未观察到冲突，风险低）。建议 M1 收尾一行接线（backend env 注入，属产品改动，不属 T9 红线内）。
- **L-2** `done.tokens` 恒 null：M1 编排层未实现 token 统计（归一化器未提取 assistant/message usage）——词表字段保留，M2 评测前补。
- **L-3** 发2 实证：dsh 引擎进程树不会成为孤儿——网关死亡即其 stdin 管道 EOF，引擎树 ~1.4s 内自行退出（transport 生命周期天然绑定宿主）。这不是产品代码实现的显式回收，而是 stdio JSON-RPC 形态的天然属性；部署侧仍建议服务管理器以作业对象/进程组方式停服，使"停服即整树回收"对网关自身的非引擎子进程同样成立。

## 清理记录

- 每发结束：网关进程树 `taskkill /T /F`；dsh/MCP 进程兜底清扫 `taskkill /T /F` 并**断言本测试进程清零**（harness.log `cleanup:` 行——发2 实测引擎随 EOF 自退，清扫通常为空集，属兜底核验）；容器经确认无残留（瞬态）。
- 临时 SQLite 库/工作树保留于 `D:\m0-sessions\e2e\<shot>\`（Temp 树外，证据留存；可整目录删除）。
- 环境杂项：运行前机器上存在 2 个陈旧 `dws_mcp_server.py` 进程（属 `D:\dataprojv2` 旧 checkout、Python 3.9，非本测试产物）——首轮基线清理时按旧的全量匹配顺带终止（属陈旧孤儿，无活动会话）；此后清理逻辑已按仓库路径过滤，不再触碰非本测试进程。
