# 管道运维 Runbook（M-i2）

insight 管道 = **worker（每日批量：四雷达→freeze→归因）+ api（只读 HTTP）**，两者共用同一块
insight.db（SQLite WAL）。本文是唯一的日常运维入口；回测另见 `insight/BACKTEST_RUNBOOK.md`，
阈值设计依据见 `docs/superpowers/` 对应 spec/报告。

## 1. 进程与节奏

两个进程角色，均由 pm2 托管：

```bash
# worker：单发日任务（跑完即退，不常驻）
pm2 start python --name insight-worker --no-autorestart -- -m insight.worker_main

# api：常驻只读服务（缺省 127.0.0.1:58095，仅本机，BFF 是唯一客户端）
pm2 start python --name insight-api -- -m insight.api_main
```

**触发节奏：固定 09:05 单发**（pm2 cron 或 Windows 任务计划程序均可，二选一）。
实测四个雷达底表落数时点均 <09:00，09:05 单发已覆盖数据就绪；多轮晨间轮询留 M-i4 生产化。

**双触发推荐配置**：cron 09:05（主跑：就绪探针→雷达→freeze）+ cron **10:05**（二发：
skip-ran 跳过全部雷达，仅执行归因窗口逻辑，代价近零）——单发 09:05 会让归因当天永不触发
（窗口 10:00 后），二发是生产自动归因的最小配置；14:00 前失败重试可再加 12:05 三发（可选）。

**归因窗口提示**：`run_prod` 的归因阶段受 10:00-14:00 窗口门控，09:05 主跑时窗口未开、
自动跳过（worker 打印完简报即退出）。若需**当日**完成归因，在窗口内（如 10:05）用同命令
补发一次即可——雷达部分因同日已 ran 全部自动跳过（见 §4），只做归因，幂等安全；
不补发则事件保持 pending，次日照常。M-i4 多轮轮询会自动化这一步。

## 2. env 清单

worker 与 api 共用的环境变量（pm2 env 或系统级设置；**密钥只走 env，严禁写入任何文件/日志**）：

| 变量 | 必填 | 说明 |
|---|---|---|
| `INSIGHT_DB_PATH` | 是 | db 文件路径；**必须在平台 Temp 树外**（仓规红线：workspace-write 硬编码豁免 os.tmpdir()） |
| `DWS_HOST` / `DWS_PORT` / `DWS_DBNAME` / `DWS_USER` | 否 | 缺省 `121.37.200.214` / `8000` / `DP_DWS` / `aiuser` |
| `DWS_PASSWORD` | 是 | 必须显式设；网关侧同规（stderr 消毒兜底） |
| `GW_URL` | 否 | engine-gateway 地址，缺省 `http://127.0.0.1:58080` |
| `GW_AUTH_TOKEN` | 是（归因） | 网关 Bearer token；只进请求头，异常信息不含 token |
| `INSIGHT_GW_USER` | 否 | 网关 X-User 身份，缺省 `insight-svc` |
| `INSIGHT_PORT` | 否 | api 监听端口，缺省 `58095` |
| `PYTHONUTF8` | 是 | 设 `1`——Windows pm2 下缺省会用 cp936 解码，中文输出（简报 JSON/标题）直接 UnicodeEncodeError 崩任务 |

## 3. 每日时序

单次 worker 运行（`python -m insight.worker_main`，data_date=昨日、brief_date=今日）依次：

1. **就绪探针（watermark）**：逐雷达按 config `deps` 查底表最大数据日期；任一依赖未就绪
   → 该雷达 `ready_check_failed`，**当日该雷达诚实 not_ready**。数据未就绪≠无异常——
   fail-closed，绝不冒充"干净"发空简报。
2. **四雷达串行**（region_sales → gross_margin → ar_risk → target）：单雷达异常只记
   `radar_run error` 行，不炸整日；已 ran 的雷达直接跳过（同日重跑去重）。
3. **09:30 cutoff 语义**：09:30 前到达的 finding 进当日榜；已发布 final 之后才到达的标
   `is_late=1`（发布态判定，见 §4）。
4. **freeze**：当日非晚到 findings → episode → Top 3 榜单快照落 `daily_brief_event`，
   简报置 final。全雷达未就绪 → not_ready（fail-closed）。
5. **归因（10:00-14:00 窗口）**：窗口内对榜上 `attribution_status != 'done'` 的事件
   逐一提交网关（跳过 done 不重复烧 API）；09:05 主跑时窗口未开自动空过，见 §1。

## 4. 重跑语义

同日重跑同命令是**幂等安全**的，各层行为：

- **雷达层**：`radar_run` 中该 data_date 已 `ran` 的雷达直接跳过（freshness 记
  already-ran），不重复执行 SQL、findings 不翻倍；未就绪/出错的雷达会再次尝试。
- **简报层（first-final-wins）**：已 final 的 brief 重跑**只延续事件生命周期，发布面绝不
  静默改变**——晚到高分不夺主发现改写当日榜快照；全失败重跑也不会把已发布 final 回退成
  not_ready。未 final 前同 brief_date 重跑：先删旧快照再写（同输入同输出）。
- **late 判定（发布态）**：`is_late` 只在"该 brief_date 已发布 final 之后到达"时置位；
  **未发布前的首跑（含 09:30 后，如 10:30 补跑）照常发布**，不标 late——防"空 final 假平安"。
- **归因层**：只处理 `attribution_status != 'done'` 的事件（重跑跳 done 不重复烧 API）；
  网关侧幂等键 = `event_id:analysis_date`，同日重提原样返回旧任务。

## 5. 观测

- **worker stdout**（pm2 logs insight-worker）：一行简报 JSON（status/event_count）+
  逐事件 `[attribution] <event_id> -> <status>` 行。
- **`radar_run.error` 列** = watermark detail（如 `ready; eff=2026-09-27`）——**排查"为什么
  今天某雷达没跑"的第一入口**；`status` 列区分 `ready_check_failed|ran|error`。
- **`event_analysis_run`** 逐版本留档（analysis_id/status/answer_md/parsed_json）：
  `done|degraded|failed` 三态持久化，`parsed_json IS NULL` 即降级态；归因历史可回看。
- **`daily_brief.freshness_json`**：当日各雷达就绪明细（api daily 接口的
  `dataFreshness.radars` 同源）。
- **api `/api/insight/health`**：探活 + db 只读连接自检（期望 `{"ok": true, "db": "open"}`）。
- **管道自检**：`python -m pytest insight/tests/test_e2e_smoke.py` —— 全链路 smoke
  （fixture→worker→freeze→归因 mock→api 读），发版/换机后先跑它再上 pm2。

## 6. 已知边界

- **月末数天 region_sales 可能 not_ready**：ct 月末快照（`ct_sales_performance_t.calday`）
  落库滞后于自然月末，watermark 要求"上个完整月末已在表中"，月末后数天内可能未就绪——
  诚实跳过（not_ready），等 ETL 补齐次日自然恢复，**不要**为凑 ready 放宽 watermark。
- **归因 degraded/failed 当日不重刷**：网关幂等键（event_id:日期）同日不变，重提只会
  原样拿回旧任务，当日重试无意义；次日 analysis_date 变化自然产生新分析。事件本身
  照常在榜（归因是增强不是阻塞），api 侧如实展示三态。
- **api WAL 只读连接冷启动**：`mode=ro` 连接要求 `-shm` 文件已存在或 db 目录可写；
  worker 与 api 同机（worker 每日触碰 db 保持 WAL 热）即满足。若把 db 放到只读挂载，
  api 冷启动可能打不开——部署时保证同机即可。
- **radars 字段形状对齐留 M-i3**：当前 `freshness_json.radars` 每项为
  `{detector, ready, detail}` 三键；spec §11.1 的全字段（effective_data_date/watermark/
  checked_at 等）对齐在 M-i3 BFF 握手时统一，BFF 对接前勿按全字段写死消费端。

## 7. 阈值/权重纪律

`insight/config/ranking.json`（五因子权重、`publish_min_score=55`、Top 3、severity 分带、
resolve 天数等）与各雷达 `radar-*.json`（yoy 阈值、norm baseline_wan、min_ly_amt、
consecutive_months 等）是**榜单正确性的口径契约**：任何改动必须

1. 重跑回测并做确定性对拍（流程见 `insight/BACKTEST_RUNBOOK.md`——手动触发、逐月推进、
   stderr 逐条过目）；
2. 留台账（改动原因/前后对比/回测结论），对齐 C2 门精神——**禁止凭单日体感直接调参**。

## 8. 红线

- **密钥只走 env**（DWS_PASSWORD / GW_AUTH_TOKEN）：任何文件/日志/测试输出不得含值；
  推送前 `git grep -E "sk-[A-Za-z0-9]{20,}|ghp_|github_pat_"` 自查。
- **提交必须路径限定**（`git commit -m msg -- <paths>`），防卷入并行作业暂存。
- **api 只读**：sqlite `mode=ro`、绑定 127.0.0.1、BFF 是唯一客户端；api 侧禁止任何写路径。
- **engine-gateway / skills / 现有 chat 零改动**：insight 是旁路增量，归因经网关标准
  `/api/tasks` 契约提交（X-User=insight-svc），不碰既有会话与评测体系。
