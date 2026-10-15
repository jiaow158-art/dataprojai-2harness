# LIN-1 最小适配计划 v2（审核修订版）

- 日期：2026-10-15；v2 = 按审核 8 条修正重写（修正记录见 §0）
- 前置：[兼容性扫描报告](../reports/2026-10-15-lin-1-linux-compatibility-report.md)（C1-C10 / R1-R20 编号沿用）
- 服务器操作一律走 [dp-server 命令清单](2026-10-15-lin-1-dp-server-runbook.md)（分级标注，人工执行，不远程自动操作）

## §0 审核修正记录（v1 → v2）

| # | 审核意见 | v2 落点 |
|---|---|---|
| 1 | 不允许两个 systemd timer 替换 SCH-1 | §5：单一 `dpit-insight-scheduler.service` 常驻托管 `insight.scheduler_main`（APScheduler 09:05/10:05 + pipeline_lock + trigger_queue + pipeline_run + 对账补漏 + 管理后台手动补跑 全部原样保留）；**不新增 timer、不引入 worker 定时入口**（worker_main 仅为既有手工/管理面入口） |
| 2 | 沙箱安全边界 | §1/§7：kill 负向测试+守护条件；宿主 bash 明确禁用（C6）；exec_script 唯一通道；fs-read-fence 遵循平台大小写语义（R2）；bind mount 权限**仅按任务目录**放行（run_in_sandbox.sh 运行时对本任务 workdir/results 单独 setfacl，废除 v1 的 workroot 级 default ACL——不存在跨任务共享可写目录）；5 要素 flag 不动；每项安全改动附负向攻击测试 + 红队回归 |
| 3 | SQLite 迁移重做 | §6：废弃全表 REPLACE；改为盘点→前缀映射→逐行审计/可回滚→存在性校验；一致性备份用 sqlite backup API；**本轮不执行**（仅设计，待资源扩容后的正式迁移阶段） |
| 4 | Python 锁独立验证 | §4：以 requirements.txt 声明为依据在**干净 Linux venv** 安装验证；服务器侧生成 requirements-linux.lock.txt；Windows freeze 仅作交叉参考不作锁；APScheduler 钉 `>=3.11,<4` |
| 5 | Node 先验证再决定 | §3：默认用系统 Node 22.23.2（npm ci 只写仓内 node_modules；dsh 装进隔离 prefix，**不动系统全局/PM2**）；仅在验证失败且证明需要时才隔离装 Node 24 |
| 6 | 目录修正 | §2：`/srv/dpit/apps`=代码；`/data/dpit`=数据（**vdb 归属确认+安全挂载前不用**，先落现有磁盘持久化目录）；`/etc/dpit`=env+密钥；units=`/etc/systemd/system` |
| 7 | 测试资源限制 | §8：单 Agent、并发=1、沙箱 512m；不启动 live Scheduler（只 shadow+临时库）；不压测；不停既有 PM2/Docker；正式迁移待扩容/容量验收 |
| 8 | 实施顺序 | §9：Windows 先行 C1-C10（安全提交先红队+问数回归）→ GitHub 测试仓 → Ubuntu S0-S6；本轮不迁生产 SQLite、不切流量、不启动 live Scheduler |

## §1 需要修改的文件（Windows 侧，本轮实施）

| # | 文件 | 改动 | Windows 零退化论证 | 验证门槛 |
|---|---|---|---|---|
| 1 | `m0/sandbox/run_in_sandbox.sh` | ① `winpath()` 加 `command -v cygpath` 守卫（C4）；② Linux 分支运行时对本任务目录 `setfacl`（u:65534:rwx 本任务 workdir；u:65534:rX 本任务 results 与 assets；仅 `uname -s`=Linux 且有 setfacl 时执行） | Git Bash 有 cygpath、非 Linux uname → 两处均为 no-op | 红队 4/4 + 新增负向用例 |
| 2 | `m0/tests/sandbox_redteam.sh` | 新增 t5 负向用例：跨任务挂载隔离（在 WD2 放标记文件，WD1 容器内扫描 `/`、`/tmp`、`/workdir`、`/results`、`/assets` 有界深度，找到即泄漏） | 用例对两平台同语义 | 5/5 |
| 3 | `m0/dsh-plugin/exec-script/exec-script.ts` | `resolveBashExe`：`M0_SANDBOX_BASH` env 优先（不变）；缺省改平台三元 win32 原值 / posix `/bin/bash`（C5） | env 未设时 win32 默认原值 | 红队 |
| 4 | `m0/dsh-plugin/exec-script/cordis.patch.yml` + `engine-gateway/scripts/profile-template/cordis.patch.yml.tmpl` | 补 `- id: tool-bash / disabled: true` 与 `- id: bash-sandbox / disabled: true`（C6：SDK 实测 `disabled: !!js process.platform === 'win32'` → Linux 自动启用宿主 bash，必须显式禁） | Windows 上 SDK 本就禁（幂等 disable） | dump-config 自检 + 红队 |
| 5 | `m0/dsh-plugin/fs-read-fence/fs-read-fence.ts` | `norm()` 分隔符归一保留、**小写仅 win32**（R2：Linux 遵循大小写敏感文件系统语义） | win32 行为不变 | 红队（越界用例） |
| 6 | `engine-gateway/src/backends/dsh-sdk-client.ts` | ① spawn opts 加 `detached: process.platform !== "win32"`（POSIX 进程组，组 ID=子 pid）；② `defaultKillTree` POSIX 分支改 `process.kill(-pid, "SIGKILL")`，附守护：`pid === process.pid` 直接返回；负 pid 失败(ESRCH)时静默（组已亡）；win32 taskkill 分支原样（C1） | win32 两分支语义均不变 | 新增单测（注入 spawnFn 断言 opts.detached/shell 平台规则）+ 红队 + Linux S2 负向 decoy 测试（见 runbook） |
| 7 | `engine-gateway/scripts/setup-dsh-profile.mjs` | ① `MCP_PYTHON` → env 优先 + 平台缺省（win32 保留原字面量，posix `/usr/bin/python3`）（C2）；② `dsh.cmd`/`shell:true` ×2 处 → 平台三元（C3）；③ `REQUIRED_DISABLED` 增 `tool-bash`、`bash-sandbox`（C6） | env 未设时 win32 全为原行为 | Windows 重跑 `--profile sdk` 自检绿 |
| 8 | `engine-gateway/src/server/index.ts` | `GATEWAY_HOST` 可选（设置则 `listen(port, host)`，未设置保持现行为全接口）（R4，可选一行） | env 未设=现行为 | npm test + 冒烟 |
| 9 | `engine-gateway/scripts/retention.mjs` + `retention.test.mjs` | ① `isInside` 归一改为"两种分隔符→`/` + 仅 win32 小写"（Windows 语义等价、Linux 修复恒 false）；② parseArgs 增守护：非 win32 时拒绝盘符形态路径（UsageError，提示传 env/CLI）；③ 测试断言平台分支化（win32 原断言 / posix 新增大小写敏感与盘符拒绝断言）（C7） | win32 语义与断言不变 | npm test 双分支通过（Linux 首过在 S1） |
| 10 | `engine-gateway/scripts/audit.mjs`、`pilot-daily.mjs` | `GATEWAY_DB`/`BFF_DB`/`OUT_DIR` 接 env（`GW_DB_PATH`/`BFF_DB_PATH`/`PILOT_OUT_DIR`）覆盖，缺省保留原值（C8） | env 未设时原行为 | Windows 等价输出对比 |
| 11 | `requirements.txt` + 新增 `requirements-dev.txt` | requirements.txt 增 `APScheduler>=3.11,<4`（钉 3.x，禁 4.x）；dev 拆 pytest/pytest-asyncio（C9） | 只增声明；Windows 环境已装 | S1 干净 venv 安装验证 |
| 12 | `.gitattributes`（新增）+ `.gitignore` | `*.sh text eol=lf`；`eval_dataset.json -text`（冻结 CRLF/无 BOM 字节形态）；.gitignore 增 `/sch*.log` | .sh 在 Git Bash 下 LF 无碍；数据集永不转换 | renormalize 后仅 .sh 行尾差异；`git ls-files --eol eval_dataset.json` 仍 i/crlf |
| 13 | `run_agent_eval.py` | `start_gateway` Popen 加 `start_new_session=`（posix）；`stop_gateway` posix 分支改 `os.killpg(getpgid(pid), SIGTERM)`（工装，R6） | nt 分支不动 | eval 直连冒烟 |
| 14 | 文档：`insight/PIPELINE_RUNBOOK.md`（Linux 节：单 scheduler service、无 timer、shadow 验证）、M1 报告 env 清单勘误注记（在新部署文档中勘误，不改历史报告）、本计划 v2、dp-server 命令清单 | — | — | 评审 |

提交纪律：安全批次（#1-#7）单独提交并附红队回执；全部路径限定提交；推送前 `git grep -E "sk-[A-Za-z0-9]{20,}|ghp_|github_pat_"` 自查（红线）。

## §2 目录布局（v2 修订）

```
/srv/dpit/apps/            # 仅代码（git clone）：harness/、dataplat-ui/
/srv/dpit/runtime/         # 隔离运行时（不进系统 PATH）：dsh/（npm --prefix 安装）；Node24 隔离目录（仅 contingency）
/srv/dpit/data/            # 【过渡】现有磁盘上的持久化目录（本轮验证数据落此）
/data/dpit/                # 【终态】vdb 归属确认+安全挂载后才启用；未确认前不得使用，绝不擅自格式化 vdb
/etc/dpit/                 # env 与密钥文件（600，root:dpit）
/etc/systemd/system/       # systemd units（正式迁移阶段安装；本轮验证不装）
```

- 路径参数化：env 文件统一引用 `DATA_ROOT` 形态变量（部署时展开为 `/srv/dpit/data` 或终态 `/data/dpit`），切换只改 env 一处。
- 本轮验证的所有库/报告/证据落 `/srv/dpit/data/verify/`（临时库，不碰生产数据）。

## §3 Node 策略：先验证 22.23.2，Node 24 仅 contingency

1. S1/S2 用**系统 Node 22.23.2** 跑：`npm ci`（只写仓内 node_modules，不动全局）+ `npm test`（engine-gateway / dataplat-ui server）+ better-sqlite3 预编译加载。22.18.0 起类型剥离默认开启（[官方发布说明](https://nodejs.org/en/blog/release/v22.18.0)），22.23.2 满足 `node src/*.ts`；better-sqlite3@13（engines node>=22）与 @12.11.1（engines 含 22.x）均在矩阵内。
2. **dsh 安装进隔离 prefix**（不动系统全局包与 PM2）：`npm install --global --prefix /srv/dpit/runtime/dsh @deepseek-ai/dsh` → 产物在 `/srv/dpit/runtime/dsh/{bin,lib/node_modules}`；网关进程 PATH 前插该 bin。
3. 仅当上述出现**明确的 Node 版本性失败**（API/ABI/语法差异）才启用 contingency：Node 24 tarball 装到 `/srv/dpit/runtime/node-v24/`（同隔离方式），systemd/env 引用绝对路径——同样不触碰系统 Node。
4. 红线：不 `npm install -g` 到系统 prefix、不改系统 PATH、不重启/停止任何既有 PM2 应用。

## §4 Python 依赖：声明为准 + Linux 独立验证锁

```bash
# Windows 侧（本轮）：requirements.txt 只做声明修正
psycopg2-binary>=2.9
APScheduler>=3.11,<4        # 钉 3.x——4.x API 不兼容 BlockingScheduler 用法
# requirements-dev.txt（新增）：pytest>=8、pytest-asyncio>=0.24

# Ubuntu 侧（S1，安装级命令见 runbook）：
python3.12 -m venv /srv/dpit/apps/harness/.venv
.venv/bin/pip install -r requirements.txt -r requirements-dev.txt
.venv/bin/pip check && .venv/bin/python -c "import apscheduler, psycopg2; print(apscheduler.version)"
.venv/bin/pip freeze > /srv/dpit/apps/harness/requirements-linux.lock.txt   # 服务器侧生成、入库归档
```

- Windows `pip freeze` 仅作版本交叉参考（附在提交说明），**不作为 Linux 锁**。
- 系统 site-packages 零改动（PEP 668 venv 隔离）。

## §5 服务拓扑：systemd 单一托管 SCH-1（无 timer、无 pm2）

**本轮验证阶段（受控、可清理）**：不装 systemd unit——S3/S5 用手工前台/tmux 方式按 env 文件启动（命令见 runbook，标注【服务启动】），验证完即停。正式迁移阶段（资源扩容+容量验收后）安装以下 units：

```ini
# /etc/systemd/system/dpit-insight-scheduler.service —— 唯一调度托管（SCH-1 原样）
[Service]
Type=simple
User=dpit
Group=dpit
WorkingDirectory=/srv/dpit/apps/harness
EnvironmentFile=/etc/dpit/insight.env
ExecStart=/srv/dpit/apps/harness/.venv/bin/python -m insight.scheduler_main
Restart=on-failure
RestartSec=10
MemoryMax=256M
```

其余（终态，本轮不装）：`dpit-gateway.service`（WorkingDirectory=engine-gateway，PATH 前插 `/srv/dpit/runtime/dsh/bin`，MemoryMax=1280M，TimeoutStopSec=600，KillMode=control-group）、`dpit-bff.service`（384M）、`dpit-insight-api.service`（256M，`Before=` 前有 db-init oneshot）、`dpit-sqlite-backup.timer`（备份 R20）。

**明确不做**：任何 insight-worker systemd timer / cron 入口；Linux 侧 pm2；重复守护。SCH-1 的触发全部来自 scheduler_main 内部 APScheduler（09:05/10:05 CronTrigger）+ trigger_queue（管理后台手动补跑），与 Windows 验收形态一致。

## §6 SQLite 迁移（重设计；本轮不执行，仅定稿方案）

原则（审核 §3）：不批量 REPLACE；先盘点、明确映射；可重复/可审计/可回滚；迁移后校验文件真实存在；一致性备份不直接复制活跃 WAL 主库。

1. **M0 盘点（只读）**：对 gateway.db / bff.db / insight.db 逐库枚举含路径形态值的列（已知候选：BFF `messages.report_path`（疑似相对 REPORTS_DIR 的相对路径）、gateway `publications`/`events.payload`（JSON 内路径）、insight 无路径列待确认），输出《路径字段清单》含样例值与分布计数。
2. **映射表驱动**：`migrate_paths.py` 仅对命中映射表的值改写：
   `D:/m0-sessions/prod/reports/... → {DATA_ROOT}/gateway-reports/...`、`D:\...` 反斜杠仅在已命中前缀的值内归一为 `/`；**相对路径值（如 `reports/user/run.html`）只做分隔符归一、不改语义**。
3. **可审计/可回滚**：整体一个事务；改动行写入旁表 `path_migration_log(db,table,pk,column,old,new,migrated_at)`；提供 `--rollback` 按旁表反向恢复；脚本幂等（重跑对已迁移值无操作）。
4. **一致性备份**：源库用 `sqlite3.connect(src).backup(dst)`（backup API，WAL 活跃库一致性快照），迁移在备份副本上执行，源库不动。
5. **存在性校验**：迁移后逐行 `os.path.exists(target)`，缺失清单输出并阻断放行。
6. 执行窗口：Windows 侧停写后备份；目标机演练先用副本全流程验证，再定正式切换（待资源扩容阶段）。

## §7 Docker 沙箱（安全边界强化）

- 镜像：`docker build -t dataplat-script:m0 m0/sandbox/`（python:3.12-slim，零 pip 依赖）。
- **挂载权限仅按任务目录**（v2 核心）：`run_in_sandbox.sh` 在 docker run 前、仅 Linux 分支，对本任务 `WORKDIR` setfacl `u:65534:rwx`、本任务 `RESULTS_DIR` 与 `ASSETS_DIR` setfacl `u:65534:rX`。**不做 workroot 级 default ACL、不整树放行**——每个容器只能写自己会话的 workdir；其他会话目录对 65534 不可访问（host 级校验命令在 runbook S2，只读）。
- 5 要素 flag 原样：`--network none`、`--read-only`、`--user 65534:65534`、`--memory/--cpus/--pids-limit`、`timeout + --rm + docker rm -f` 兜底。
- 回归门槛：`bash m0/tests/sandbox_redteam.sh` **5/5**（原 4 条 + 新增跨任务隔离负向用例）；C1 进程组击杀附 Linux decoy 负向测试（runbook S2：目标组被杀、异组进程存活）。
- 资源（本轮验证）：`SANDBOX_MEM=512m`、`SANDBOX_CPUS=1`、`MAX_CONCURRENT_TASKS=1`（全部 env，不改码）。

## §8 资源与边界（2c4G 共享机）

- 单 Agent、并发=1、不压测、不起 live Scheduler（shadow + 临时库）、不迁移生产 SQLite、不切流量。
- 端口先查再用（58080/58090/58095，runbook S0 只读命令）；与既有服务冲突即换端口。
- 不停止/重启既有 PM2、Docker 容器与 systemd 单元；docker 组仅新增 `dpit` 用户成员（权限变更，单独列出）。
- 正式生产迁移（数据迁移、流量切换、live Scheduler）待服务器扩容或容量验收后另行审批。

## §9 实施顺序（v2）

**Windows（本轮）**：
1. 计划 v2 + runbook + 报告注记（本文档）。
2. 安全批次：C4/C5/C6+R2+run_in_sandbox ACL 守卫 + 红队 t5 → 红队 5/5 → 提交（附回执）。
3. 引擎批次：C1+C2+C3+GATEWAY_HOST + 单测 → npm test → `setup-dsh-profile --profile sdk` 自检绿 → 提交。
4. 运维批次：C7/C8（retention+audit+pilot+tests）→ npm test → 提交。
5. 依赖与卫生批次：C9 + .gitattributes + .gitignore + renormalize → 提交。
6. eval 工装：run_agent_eval killpg → 提交。
7. 文档批次：RUNBOOK Linux 节、dataplat-ui README env 表（另一仓）→ 提交。
8. 问数回归（Windows 零退化证据）：`npm test` 全量 + `python -m pytest eval/ -q` + ask.py 单问冒烟 + 红队 5/5。
9. 密钥自查 → 推送 GitHub 测试仓库。

**Ubuntu（用户提供执行，按 runbook）**：S0 环境检查（只读）→ S1 隔离依赖安装（安装级）→ S2 单测与沙箱验证（含 decoy/隔离负向测试）→ S3 Gateway/BFF/Insight API 手工启动冒烟（服务启动级）→ S4 DSH Profile 自检 → S5 Scheduler Shadow（临时库）→ S6 非生产数据端到端问数（需测试凭据）。

每阶段不通过即停，Windows 侧修复后重新走阶段；阶段间互不阻塞既有服务。
