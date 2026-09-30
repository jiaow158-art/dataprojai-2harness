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

**cwd 前提**：pm2 进程的工作目录必须是**仓根**——`python -m insight.*` 靠 cwd 找到
`insight` 包，cwd 不对直接 `ModuleNotFoundError: No module named 'insight'`。用
`--cwd`（或 shell 包装先 `cd` 仓根再 exec）：

```bash
pm2 start python --name insight-api --cwd D:/dataprojai-2harness -- -m insight.api_main
```

**首次部署顺序**：先初始化 db 再起 api——api 的 `mode=ro` 连接在 db 文件不存在时
直接打不开（worker 首跑前 api 抢跑会崩）：

```bash
python -c "import os; from insight.db import open_db; open_db(os.environ['INSIGHT_DB_PATH'])"
```

**触发节奏：固定 09:05 单发**（pm2 cron 或 Windows 任务计划程序均可，二选一）。
实测四个雷达底表落数时点均 <09:00，09:05 单发已覆盖数据就绪；多轮晨间轮询留 M-i4 生产化。

**双触发推荐配置**：cron 09:05（主跑：就绪探针→雷达→freeze）+ cron **10:05**（二发：
skip-ran 跳过全部雷达，仅执行归因窗口逻辑，代价近零）——单发 09:05 会让归因当天永不触发
（窗口 10:00 后），二发是生产自动归因的最小配置；14:00 前失败重试可再加 12:05 三发（可选）。

**cron 机制示例**（双触发的落地，任选其一）：

```bash
# pm2 方式：--no-autorestart 退出即停，--cron-restart 到点拉起（与上方单发同一入口，双任务分名）
pm2 start python --name insight-worker-0905 --no-autorestart --cron-restart "5 9 * * *" \
  --cwd D:/dataprojai-2harness -- -m insight.worker_main
pm2 start python --name insight-worker-1005 --no-autorestart --cron-restart "5 10 * * *" \
  --cwd D:/dataprojai-2harness -- -m insight.worker_main
```

Windows 任务计划程序方式：每日两条任务（09:05 / 10:05），操作均为
`python -m insight.worker_main`，**"起始于"必须填仓根**（同 cwd 前提）。

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
5. **归因（10:00-14:00 窗口）**：窗口内对榜上需归因事件（pending，或 done 但分析日期
   落后当日——每日重归因）逐一提交网关；09:05 主跑时窗口未开自动空过，见 §1。

## 4. 重跑语义

同日重跑同命令是**幂等安全**的，各层行为：

- **雷达层**：`radar_run` 中该 data_date 已 `ran` 的雷达直接跳过（freshness 记
  already-ran），不重复执行 SQL、findings 不翻倍；未就绪/出错的雷达会再次尝试。
- **简报层（first-final-wins）**：已 final 的 brief 重跑**只延续事件生命周期，发布面绝不
  静默改变**——晚到高分不夺主发现改写当日榜快照；全失败重跑也不会把已发布 final 回退成
  not_ready。未 final 前同 brief_date 重跑：先删旧快照再写（同输入同输出）。
- **late 判定（发布态）**：`is_late` 只在"该 brief_date 已发布 final 之后到达"时置位；
  **未发布前的首跑（含 09:30 后，如 10:30 补跑）照常发布**，不标 late——防"空 final 假平安"。
- **归因层**：done 且 analysis_date=当日才跳过——done 但分析日期落后当日会重归因
  （每日重归因语义，见下节）；网关侧幂等键 = `event_id:analysis_date`，同日重提
  原样返回旧任务。

### 每日重归因语义

归因循环不只跑 pending：**done 但 `event_analysis_run` 的最新 analysis_date 落后当日
→ 重归因**——持续上榜事件的分析不得冻结在首日；仅 done 且当日已分析才跳过。幂等键
`event_id:analysis_date` 保证当日多次触发（09:05/10:05/12:05）网关侧去重，同日重提
原样返回旧任务、不重复烧 API；窗口（10:00-14:00）外触发一律不跑。

**补归因**：机器在窗口内宕机错过当日归因时，窗口内补跑
`python -m insight.worker_main --brief-date YYYY-MM-DD`（data_date 自动=前一日；
雷达 skip-ran、freeze first-final-wins 均幂等，实际效果=补该日归因；窗口门控仍
生效——整个窗口已错过则次日 10:05 二发自然重分析）。

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

## 9. UI 接入（M-i3）

### BFF 接线
- env：insight-api 默认监听 127.0.0.1:58095；BFF 的 `INSIGHT_URL` 未设 → /api/insight/* 返回 503 INSIGHT_UNAVAILABLE（无缺省值，必须显式设）
- 灰度：`cd server && npm run insight:flag -- on <username>`（off/list 同理；flag 默认全关——只控驾驶舱入口，不做数据权限）
- 部署顺序：insight-worker 首跑（建 insight.db）→ insight-api → BFF（INSIGHT_URL）→ web build（`cd web && npm run build`，静态产物由 BFF 托管）
- 验证：`curl http://127.0.0.1:58095/api/insight/health`（经 BFF：登录态 + flag on 后 GET /api/insight/daily 应 200）

### 前端
- flag off 用户：登录默认落 chat 页，侧栏无驾驶舱入口——现状零变化
- flag on 用户：登录默认落驾驶舱（今日经营关注）；事件详情 → 追问 → 自动跳聊天页并发送种子问题（走现有问数链路，SSE 流式照旧）
- 人工验收：见 dataplat-ui 仓 `INSIGHT_UI_SMOKE.md`

## §M-i5 趋势/健康度端点（2026-09-30）

- insight-api 新增 4 端点：`/api/insight/health-score`、`/api/insight/events?state=active`、`/api/insight/events/:id/trend?months=12`（区间 [1,24] 否则 400 BAD_MONTHS）、`/api/insight/events/:id/related`（同类/同区域各 5 条）。
- trend/health-score **需要 DWS_PASSWORD**（ecosystem.config.cjs insight-api 块已配，同 worker）；缺失时进程照常起（db 端点正常），这两个端点 503 DWS_UNAVAILABLE——BFF 显示降级态不炸页。
- 缓存进程内（key 含数据日/事件锚点，as_of 变更自然失效；health 三数据环全降级时不缓存，恢复后自动重查）；重启即冷；多线程下 DWS 查询持锁串行。
- 健康度因子：`insight/config/health.json`（sales×2.0 / margin×10.0 / ar=100−占比）——改动留台账 eval_results/insight-gray/（D-c2）。分数地板 0。
- **口径裁定（2026-09-30 用户，D-c2 台账）**：ar 环=100−nat90 占应收余额比例，生产实测 2026-09 占比 85.6%（receivables_am=分段和精确成立，公式无误）——工程渠道长账期致结构性偏高，健康度 14.4。**裁定：保持公式不动，要真实**——数字难看但真实，分数点开可见公式与输入；后续不再就此复议除非口径本身有错。
- 目标环 time_pct=年日内自然日占比（与事件/雷达的月度工作日进度是两个窗口，spec v1.0.2）。
- 冒烟（2026-09-30 实测全绿）：health ok / active 200 / trend 真序列（target 事件 cumulative_dual 1-9 月）/ health-score 三环+target 82.8% vs 时间 74.5%。

## §M-i6 经营事件中心（2026-09-30）

- `/api/insight/events?state=all`：事件中心页专用——服务端返回 summary（近30新发 vs 前30，分母0→delta null）/trend（30点补零）/类型与生命周期分布（全量）/全量事件列表（500 截断标记 truncated）。统计口径唯一权威在服务端（D-e5）。
- lifecycle / attribution_status / is_late 三概念分立：两列两筛选，late 仅 Badge（D-e2）。
- org 展示归一：锚点串取首段、"瓷砖"短名回显范围字段（数据与 event_key 不动）。
