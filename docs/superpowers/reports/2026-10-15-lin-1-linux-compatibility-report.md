# LIN-1 Linux（Ubuntu 24.04）部署兼容性扫描报告

- 日期：2026-10-15
- 方法：5 路并行子代理扫描（engine-gateway / dsh 插件与 Docker 沙箱 / insight+eval Python 栈 / skills / dataplat-ui），覆盖命题 12 项检查点；"必须修改"级结论全部经人工读源码二次复核（含已装 dsh SDK 包取证、Node 官方发布说明核查）。
- 目标环境：Ubuntu 24.04.4 LTS，2 vCPU / 4GB RAM，Python 3.12.3，Node 22.23.2（不可动），Docker 29.1.3，部署根 `/srv/dpit/apps`，Asia/Shanghai。
- 结论速览：**必须修改 10 项（8 项代码 + requirements.txt + 部署文档），需测试 20 项，其余已兼容**。SCH-1 全部核心逻辑（幂等/锁/发布/归因）与 skills 六步法零 Windows 耦合，无需任何改动。
- **修订注记（2026-10-15 审核后）**：本报告为扫描事实记录，处置方案以[适配计划 v2](../plans/2026-10-15-lin-1-minimal-adaptation-plan.md) 为准。v2 修正了本报告三处处置建议：① R9 不得全表 REPLACE（改为盘点→前缀映射→审计/回滚→存在性校验，且本轮不迁移生产库）；② Linux 调度为单一 `dpit-insight-scheduler.service` 常驻托管 SCH-1（不新增 systemd timer、不设 worker 定时入口）；③ R3 处置改为"先用系统 Node 22.23.2 验证完整测试，仅证明确有需要才隔离装 Node 24"；④ Python 锁以 Linux 干净 venv 独立验证生成，Windows freeze 仅作参考。

---

## 一、已兼容，无需修改（按子系统）

### engine-gateway（Node 24 + TS strip + better-sqlite3）

| 证据 | 位置 |
|---|---|
| src/ 业务代码零盘符、零反斜杠拼接、零 `\r\n` 字面量；路径全部 env 化 | `src/server/index.ts:42-61` |
| 路径正则双分隔符兼容（`[/\\]`），产物路径反斜杠归一 | `src/backends/dsh-backend.ts:149`、`src/backends/dsh-events.ts:73,169` |
| dsh 主 spawn 已平台分支（`win32 ? dsh.cmd : dsh`，`shell` 仅 win32） | `src/backends/dsh-sdk-client.ts:123,130` |
| stderr 密钥消毒平台无关（值替换 + PASSWORD/TOKEN/SECRET/KEY 模式） | `dsh-sdk-client.ts:253-260` |
| TS strip 无违例语法（无 enum/namespace/参数属性；import 显式 `.ts`） | 全仓 grep 零命中 |
| better-sqlite3@13.0.3 npm 包内置 8 平台 prebuilds（含 linux-x64），npm ci 免编译 | `node_modules/better-sqlite3/prebuilds/` |
| WAL 断言、UNIQUE 冲突消息判定跨平台一致 | `index.ts:44-49`、`task-store.ts:141-143` |
| SIGINT/SIGTERM 优雅停机（pool 排空→server.close→db.close→exit 0） | `index.ts:102-111` |
| 读写文本全部显式 utf8；报告发布为字节级 `copyFileSync` | `task-store.ts:104`、`task-runner.ts:336` |

### DSH Runtime 与 Docker 沙箱

| 证据 | 位置 |
|---|---|
| 沙箱 5 要素 flag（`--network none`/`--read-only`/非 root/资源上限/timeout+`--rm`+兜底 `rm -f`）Linux 语义等价或更严格 | `m0/sandbox/run_in_sandbox.sh:52-63` |
| 卷源路径推导 `$(cd "$1" && pwd)` 原生 POSIX；资源参数全部 env 可调（SANDBOX_MEM/CPUS/PIDS/TIMEOUT_S） | `run_in_sandbox.sh:12,19-22` |
| 沙箱镜像为本地 build 的 `python:3.12-slim`（无 pip 依赖），`dataplat-script:m0` | `m0/sandbox/Dockerfile` |
| fs-read-fence 域根 = env 注入 + `path.resolve`（与网关注入值同源同形，Linux 上不会落出域外）；tmpdir 附加域根在 Linux 即 `/tmp` | `m0/dsh-plugin/fs-read-fence/fs-read-fence.ts:69,82` |
| SDK dsh-sandbox `writableRoots()` 在 Linux 上 `"/tmp"===tmpdir()`，两条豁免合一——"workdir/results 放平台 Temp 树外"规范继续成立 | SDK 源码取证（`dsh-sandbox/lib/index.js` writableRoots） |
| MCP 密钥仅 `!!js process.env.DWS_PASSWORD` 注入不落值 + setup 自检红线断言 | `profile-template/cordis.patch.yml.tmpl:24`、`setup-dsh-profile.mjs:204` |
| read/read_image/glob/grep 为 SDK 纯 Node 实现（node:fs/node:path）；工具白名单已禁 pwsh/web/workflow/ralph | SDK 取证 + `cordis.patch.yml.tmpl:32-41` |
| Temp 树警告用通用正则，`/srv/dpit/...` 不误报 | `dsh-backend.ts:146-152` |

### Insight / SCH-1 / eval（Python 3.12）

| 证据 | 位置 |
|---|---|
| **SCH-1 全部核心机制构建于 SQLite/epoch/ZoneInfo/stdlib-HTTP 之上，零 Windows 耦合**：执行互斥=单行锁表+心跳+CAS 夺回；队列=CAS UPDATE；幂等=UNIQUE 索引+INSERT OR IGNORE；崩溃恢复=stale 心跳回收+对账 | `insight/pipeline_log.py:105-219`、`insight/db.py:111,144-145`、`insight/scheduler_main.py:173-192` |
| APScheduler：MemoryJobStore（无 jobstore 路径）、misfire/coalesce 显式、时区 `ZoneInfo("Asia/Shanghai")` 显式注入不依赖系统 TZ | `scheduler_main.py:29,36,78-80,286` |
| 无 msvcrt/win32api/pywin32/taskkill；holder=`hostname:pid:uuid` 平台无关 | insight/ 全目录 grep 零命中 |
| 所有文本 open 显式 utf-8；BOM/行尾显式处理（utf-8-sig、`newline="\n"`） | `gray_report.py:56`、`backtest.py:97` 等 |
| 归因走 stdlib http.client，不 spawn 子进程 | `insight/attribution.py:132-167` |
| judge.py 纯函数、`\r?\n` 双态正则、零平台耦合 | `eval/judge.py` |
| dsh 探测跨平台（`shutil.which("dsh") or "dsh.cmd"`，shell 仅 nt） | `run_agent_eval.py:534-540` |

### dataplat-ui（BFF + Web）

| 证据 | 位置 |
|---|---|
| 源码零盘符/零 taskkill/零 CRLF 假设；目录全 env 化 + resolve | `server/src/index.ts:26-33` |
| 唯一子进程用 `process.execPath`（自动 Linux node），无 shell | `server/src/app.ts:478-482` |
| `HOST` 缺省 127.0.0.1（反代同机即安全）；express 5/bcryptjs 纯 JS；better-sqlite3@12.11.1 engines 含 22.x，官方 linux-x64 预编译 | `index.ts:25`、`server/package.json` |
| 报告下载三道闸（记账属主→网关 X-User 复核→resolve+sep 路径遏制）Linux 等价（`../` 与绝对路径逃逸同样被拦） | `app.ts:1163-1185` |
| SSE：`flushHeaders` + 逐 chunk pipe + 15s 心跳透传 + 看门狗 + Last-Event-ID；分帧 `\n\n` 与网关契约固定 | `app.ts:1113-1151`、`sse-parser.ts` |
| 会话踢旧/吊销/SSE 掐流为事务+定时复查，平台无关 | `app.ts:202-207,1126-1132` |
| WAL 强制断言；迁移注意三件套（见风险 R9） | `db.ts:177-182` |
| 前端零 `VITE_*` 引用、EventSource 相对 URL、同源架构、dist 产物平台中立 | `web/vite.config.ts`、`web/src/**` |

### skills

- **0 项必须修改**。无盘符路径、无会被照抄的 Windows 命令（`start /B` 仅为并列示例文案）、无反斜杠路径；全部 `open()` 显式 utf-8；git index 侧全部 LF（Linux clone 即 LF）；13 个 SKILL.md frontmatter 干净；sources-of-truth 相对链接目标全部实测存在。六步法/口径判定零触碰。
- 待实测确认项见风险 R16（全部为 1-2 行文本级修复，实测失败后才动）。

---

## 二、存在兼容风险，需要测试（R1-R20）

| # | 风险 | 位置 | 处置 |
|---|---|---|---|
| R1 | **Docker 挂载权限（最大实测点）**：`--user 65534:65534` × Linux 原生 bind mount 严格保留宿主 uid。Docker Desktop(WSL2) 宽松、Linux 严格——workdir 由网关服务用户创建，容器内 nobody 可能写不了 `/workdir`、读不了 `/results`/`/assets` → exec_script 全线失败 | `run_in_sandbox.sh:55-59` | ACL 配方（`setfacl` u:65534:rwX + default ACL），复跑红队 4/4 + 真实 exec_script 回归（见适配计划 §7） |
| R2 | fs-read-fence `norm()` 无条件小写是 win32 假设：Linux 大小写敏感下域判定偏宽（越域放行的攻击面受限于"模型无法在域外建目录"，风险低但语义错） | `fs-read-fence.ts:41-43` | 一行修复（仅 win32 lowercase），随 C6 一并改 + 红队复跑 |
| R3 | Node 版本门槛：`node src/*.ts` 依赖类型剥离默认开启（≥22.18.0 或 ≥23.6）。服务器 22.23.2 **满足**（已核实官方发布说明）；风险仅在换机/降级场景 | 两个仓 package.json scripts | 部署 SOP 固化"网关/BFF 用私有 Node 24"；systemd 不依赖系统 Node |
| R4 | 网关 `listen(port)` 未绑 host → 0.0.0.0 全接口暴露，Bearer 是唯一防线 | `index.ts:97` | 最小改：读 `GATEWAY_HOST` env（缺省不传=现行为，Windows 零退化）；或防火墙只放 127.0.0.1 |
| R5 | SIGHUP 未处理：Linux 终端挂断会直杀进程（不走优雅停机）。systemd 托管后无控制终端，风险自然消除 | `index.ts:102-111` | systemd 托管即可，不加 handler（boot 自愈兜底） |
| R6 | e2e/soak 测试工装为 Windows 专属（PowerShell Get-CimInstance/taskkill 观测与收尾清理器）；`run_agent_eval.py` 的 `stop_gateway` Linux 分支只 terminate 主进程无进程树语义 | `test/e2e.live.test.ts:437-510`、`test/soak.mjs:112-143`、`run_agent_eval.py:621-637` | 服务本体不受影响；Linux 复测五发/soak 前需为观测/清理器加 `/proc`+`pgrep` 分支（工装级，可延后） |
| R7 | 无 `.gitattributes` 且开发机 `core.autocrlf=true`：从 Windows 工作区直接拷贝/scp 会让 `.sh` 带 CRLF（`$'\r': command not found`）；Linux 全新 git clone 安全（blob 均 LF） | 仓根 | 加 `.gitattributes`（`*.sh text eol=lf` + `eval_dataset.json -text` 冻结字节形态）+ 部署 SOP 固定"Linux 侧 git clone，禁拷工作区" |
| R8 | `.mcp.json` 硬编码 Windows python.exe 与盘符——但这是 **Claude Code 开发工具链配置，非生产运行时路径**（生产不跑 Claude Code）。文件已用 `${DWS_PASSWORD}` env 展开先例 | `.mcp.json:2-4` | 不改（避免破坏 Windows 开发机）；如未来 Linux 侧开发需要，改 `${MCP_PYTHON}` 等 env 展开 |
| R9 | SQLite 迁移三件套：现网 `bff.db-wal` 已 4MB 未 checkpoint；`insight.db` 含 SCH-1 watermark/雷达历史必须迁；Windows 网关历史 `report_path` 为反斜杠形态，Linux 上旧报告消息会 404（安全但不可用） | `data-prod/`、BFF `messages` 表 | 迁移流程含 `wal_checkpoint(TRUNCATE)` + 三件套同拷 + `REPLACE(report_path,'\','/')` 一次性清洗（见计划 §6） |
| R10 | BFF 跨进程只读直连网关 WAL 库（`readonly:true` 打开）：要求 BFF 与网关同用户/同组且对 `-shm/-wal` 有写权限；网关停机时审计端点 500 | `server/src/gw-audit.ts:36-38` | 两服务同用户 `dpit` 运行（计划 §5）；可接受停机审计 500 |
| R11 | 反代 SSE：BFF 未发 `X-Accel-Buffering: no`，nginx 默认 `proxy_buffering on` 会缓冲 SSE 挂死；需保持前后端同源 | `app.ts:1113-1119` | nginx `location /api/` 设 `proxy_buffering off`（配置层，不改码）；可选补响应头一行 |
| R12 | 时区/编码 env：worker/api 用朴素本地时间（窗口 10:00-14:00 随系统 TZ 漂移）、报告文件名日期用本地时区；中文 stdout 需 UTF-8 locale | `worker_main.py:98,128`、`report-generator/scripts/build.py:78` | 服务器已是 Asia/Shanghai（再 `timedatectl` 核实）；systemd 统一 `TZ=Asia/Shanghai`、`PYTHONUTF8=1`、`LANG=C.UTF-8` |
| R13 | 资源预算：4GB 机上缺省 `MAX_CONCURRENT_TASKS=3` × 沙箱 `--memory 2g` 理论超限；还需给既有服务留量 | `index.ts` 缺省、`run_in_sandbox.sh:21` | `MAX_CONCURRENT_TASKS=1` + `SANDBOX_MEM=512m`（纯 env，不改码）+ systemd MemoryMax（预算表见计划 §5） |
| R14 | 沙箱镜像需在服务器 build（`python:3.12-slim` 需 registry 可达） | `m0/sandbox/Dockerfile` | 在线 `docker build`；离线 `docker save/load` |
| R15 | dsh SDK 需在 Linux 重装 + profile `sdk` 重建（`dsh plugin add` 的 pnpm link 在 Linux 正常）；`~/.dsh` 落服务用户 HOME | `setup-dsh-profile.mjs`（修复后） | 服务器按计划 §3/§5 以私有 Node24 prefix 安装，DSH_HOME/HOME 显式化 |
| R16 | skills 5 项实测点：`/usr/bin/python3` 在沙箱镜像内的可用性；`Read`/`Write` 工具名与引擎注册名大小写；MCP `run_query` 实名；沙箱 cwd 是否为挂载的 workdir 根；report-generator 全流程 | `report-generator/SKILL.md:45,57,59`、5 个 knowledge SKILL.md、`sku-profitability-analyst/SKILL.md:95` | Linux 首跑后按需 1-2 行文本修（不触六步法/口径） |
| R17 | BFF better-sqlite3@12 走 prebuild-install（安装时需外网拉 linux-x64 预编译；失败则需 build-essential+python3 编译兜底）；网关 @13 自带 prebuilds 无此问题 | 两 package.json | 在线 npm ci；或 apt 装 build-essential 兜底 |
| R18 | eval 直连模式的 `GW_RESULTS_ROOT`/`E2E_ROOT`/`SOAK_ROOT` 等必须传 POSIX 形态（照抄 `D:\...` 会失效）；`huaweiclaude/` ETL 镜像目录 etl_watch 需随迁或 `--mirror` | `run_agent_eval.py:978`、`eval/etl_watch.py:23-27` | eval/运维面 env 全部用 POSIX 路径 |
| R19 | 停机等待在途任务最长可达任务预算（1800s），systemd `TimeoutStopSec` 到点 SIGKILL——WAL+boot 自愈下数据安全 | `worker-pool.ts:81-86` | `TimeoutStopSec=600` 折中；文档标注 |
| R20 | 网关/BFF 无 SQLite 备份机制（全仓无 backup/VACUUM）；retention 只 DELETE 不 VACUUM | 全仓 grep 零命中 | 加备份 timer（计划 §5，python sqlite3 backup API，免装 sqlite3 CLI） |

---

## 三、确认不兼容，必须修改（C1-C10）

| # | 文件:位置 | 问题 | 修复方案 | Windows 零退化 |
|---|---|---|---|---|
| C1 | `engine-gateway/src/backends/dsh-sdk-client.ts:126-131, 351-358` | **POSIX killTree 只杀根 pid，无进程组**（M1 报告 L-2 自证"服务器部署前修"）。注释称"进程组由 backend 落地"但全仓无 `detached`。影响链：取消/超时/围栏自杀 → Linux 上 dsh 子孙（MCP python、docker exec）孤儿化 | posix 分支 spawn 加 `detached: true`；`defaultKillTree` POSIX 分支改 `process.kill(-pid, "SIGKILL")`（进程组击杀） | win32 分支（taskkill /T /F）原样不动 |
| C2 | `engine-gateway/scripts/setup-dsh-profile.mjs:56` | `MCP_PYTHON` 硬编码 `C:\Users\Administrator\...\python.exe`，渲染进 profile 的 MCP `command:` → Linux 上 MCP 子进程起不来（**生产阻断**） | `process.env.MCP_PYTHON` 优先；win32 缺省保留原值；posix 缺省 `/usr/bin/python3`（部署时指向 venv python） | env 未设时 win32 行为不变 |
| C3 | `setup-dsh-profile.mjs:149,167` | `spawnSync("dsh.cmd", {shell:true})` 无条件——Linux 无 `dsh.cmd`（**profile 装不上/自检跑不了**） | 照抄 `dsh-sdk-client.ts:123,130` 三元式：`win32 ? "dsh.cmd" : "dsh"`、`shell` 仅 win32 | win32 路径等价 |
| C4 | `m0/sandbox/run_in_sandbox.sh:32,57-59` | `winpath() { cygpath -w }` 无条件用于三个 `-v` 挂载源——Linux 无 cygpath → 挂载源为空 → docker run 报错（**exec_script 全线失败，生产阻断**） | `winpath()` 加 `command -v cygpath` 守卫：存在才转换，否则透传原路径 | Git Bash 下 cygpath 存在，行为不变 |
| C5 | `m0/dsh-plugin/exec-script/exec-script.ts:27-29` | `resolveBashExe()` 默认 `C:/Program Files/Git/bin/bash.exe`——Linux ENOENT（**生产阻断**） | `M0_SANDBOX_BASH` env 优先级不变；缺省改平台三元：win32 原值 / posix `/bin/bash` | env 未设时 win32 默认不变 |
| C6 | `engine-gateway/scripts/profile-template/cordis.patch.yml.tmpl:32-41` + `m0/dsh-plugin/exec-script/cordis.patch.yml`（+ `setup-dsh-profile.mjs:163` 自检清单） | **工具白名单缺 `tool-bash` 禁用项**：SDK dsh-base 用 `disabled: !!js process.platform === 'win32'` 只在 Windows 禁（已在已装 SDK 包中取证）→ Linux 上自动启用宿主 bash 工具 + bash-sandbox，破"exec_script 唯一执行通道"与 26 项白名单不变量 | 两处 patch 增加 `- id: tool-bash / disabled: true`（并禁 `bash-sandbox`）；`REQUIRED_DISABLED` 自检清单同步加。**红线：改插件必须复跑 `m0/tests/sandbox_redteam.sh`** | Windows 上 SDK 本就禁（幂等 disable），工具数不变 |
| C7 | `engine-gateway/scripts/retention.mjs:48-54,122-127`（+ `retention.test.mjs:336-382`） | ① `PROD_DEFAULTS` 全 `D:/` 盘符；② `isInside` 用 `replaceAll("/","\\") + sep`——Linux 上 sep="/"，归一后字符串永不含 "/" → **恒 false，`--apply` 全部拒绝删除**（fail-safe 但功能失效）；测试断言平台锁死（Linux 上 npm test 必挂） | ①缺省改读 env（已有覆盖通道）+ 缺省值平台化或必填校验；②`isInside` 按 `path.sep` 归一；③测试断言改平台感知 | env/CLI 传 Windows 路径时行为等价 |
| C8 | `engine-gateway/scripts/audit.mjs:21-22`、`pilot-daily.mjs:17-18` | `D:/m0-sessions/prod/*`、`D:/dataplat-ui/...` 硬编码 const，无覆盖通道 → Linux 上审计/失败归因/试点日报脚本不可用 | 接 env（复用 `GW_DB_PATH`/`BFF_DB_PATH` 等既有名）+ CLI 参数，缺省保留现值 | env 未设时原行为 |
| C9 | `requirements.txt:1` | 仅 `psycopg2-binary>=2.9`，**缺 APScheduler**（`scheduler_main` 硬依赖，Windows 现机是手工装的）→ 干净 Linux 环境装完依赖 scheduler 起不来 | 增 `APScheduler>=3.11,<4`（3.x BlockingScheduler API，勿升 4.x）；并从 Windows 现机 `pip freeze` 生成 `requirements.lock.txt` 锁全量传递依赖（含 pytest/pytest-asyncio 测试面） | Windows 已装，仅补清单 |
| C10 | `insight/PIPELINE_RUNBOOK.md:49,70-77`；`docs/superpowers/reports/2026-09-16-m1-report.md:82-84` | 部署文档 Windows 专属（pm2 `--cwd D:/`、任务计划程序章节）；M1 报告 env 清单漏代码必填的 `GW_ASSETS_DIR`/`M0_SANDBOX_RUNNER`/`SKILLS_DIR` | RUNBOOK 补 Linux/systemd 章节（本报告配套适配计划落地后回填）；env 清单以 `index.ts:3-17` 为准补齐 | — |

### 附带披露（存量问题，非 LIN-1 范围，不顺手修）

- `insight/api_main.py:302,307`：`do_GET` 的 subscriptions/notifications 端点引用未定义变量 `rw`（仅 POST/DELETE 分支赋值）→ 任何平台 GET 必 NameError 被 404 兜成 500。
- dataplat-ui `README.md` env 表落后于 `index.ts` 实际（缺 HOST/STATIC_DIR/GW_DB_PATH/INSIGHT_*）。
- 仓根 `sch2-5.log` 手工调试残留未被 .gitignore 覆盖。

### 事实核查记录

- Node 22.18.0（2025-07-31）起 type stripping 默认开启（自 23.6.0 回移）；服务器 Node 22.23.2 与私有 Node 24 均可直接 `node src/*.ts`。来源：[Node v22.18.0 release](https://nodejs.org/en/blog/release/v22.18.0)、[Node TypeScript API 文档](https://nodejs.org/api/typescript.html)。
- dsh-base `tool-bash` 平台条件：`C:\Users\Administrator\.dsh\profiles\node_modules\@deepseek-ai\dsh-base\cordis.patch.yml:252-254`（`disabled: !!js process.platform === 'win32'`）。
