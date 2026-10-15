# LIN-1 dp-server 命令清单（人工执行版）

- 日期：2026-10-15；配套：[适配计划 v2](2026-10-15-lin-1-minimal-adaptation-plan.md)
- **全部命令由你在 dp-server 上手动执行**，本清单按阶段组织，每条标注性质：【只读】无副作用｜【安装】新增软件/文件（限定在 /srv/dpit、/etc/dpit、仓内 node_modules/venv）｜【权限变更】改属主/ACL/用户组｜【服务启动】拉起新进程｜【服务停止】停 LIN-1 自建进程（**绝不停既有服务**）。
- 红线：不动系统 Node 22 全局包与 PM2 应用；不停止任何既有容器/systemd 单元；不使用 /data（vdb 未确认）；密钥只进 /etc/dpit 的 env 文件（600）。

---

## S0 环境检查（全部【只读】）

```bash
uname -a && cat /etc/os-release | head -2        # Ubuntu 24.04 确认
node --version && npm --version                   # 期望 v22.23.2
python3 --version && docker --version             # 3.12.3 / 29.1.3
timedatectl | grep -E "Time zone|Local time"      # 期望 Asia/Shanghai
df -h /srv /data 2>/dev/null; lsblk -f            # 磁盘与 vdb 现状（只看不操作）
free -m && nproc                                  # 容量摸底（预算校准用）
ss -tlnp | grep -E ':(58080|58090|58095)\b'       # 端口占用（空输出=可用）
pm2 ls 2>/dev/null || true                        # 既有 PM2 清单（只读，记录端口）
docker ps --format '{{.Names}} {{.Ports}}'        # 既有容器（只读）
systemctl list-units --type=service --state=running | head -30   # 既有服务（只读）
```

## S1 隔离依赖安装

```bash
# 【权限变更】创建服务用户与目录骨架（仅新增，不改既有）
sudo useradd -r -m -d /srv/dpit/home/dpit -s /bin/bash dpit
sudo mkdir -p /srv/dpit/apps /srv/dpit/runtime /srv/dpit/data/verify /etc/dpit
sudo chown -R dpit:dpit /srv/dpit/data /srv/dpit/home
sudo chown dpit:dpit /srv/dpit/runtime

# 【安装】拉代码（GitHub 测试仓库，git clone 保证 .sh 为 LF）
sudo -u dpit git clone <测试仓地址> /srv/dpit/apps/harness
sudo -u dpit git clone <测试仓地址-ui> /srv/dpit/apps/dataplat-ui
file /srv/dpit/apps/harness/m0/sandbox/run_in_sandbox.sh   # 【只读】应无 CRLF

# 【安装】Python venv（系统 site-packages 零改动）
sudo apt-get install -y python3.12-venv            # 【安装】apt 增量包
sudo -u dpit python3.12 -m venv /srv/dpit/apps/harness/.venv
sudo -u dpit /srv/dpit/apps/harness/.venv/bin/pip install \
  -r /srv/dpit/apps/harness/requirements.txt -r /srv/dpit/apps/harness/requirements-dev.txt
sudo -u dpit /srv/dpit/apps/harness/.venv/bin/pip check          # 【只读】
sudo -u dpit /srv/dpit/apps/harness/.venv/bin/python -c \
  "import apscheduler, psycopg2; print('APScheduler', apscheduler.version)"   # 【只读】必须 3.x
sudo -u dpit /srv/dpit/apps/harness/.venv/bin/pip freeze \
  > /srv/dpit/apps/harness/requirements-linux.lock.txt           # 【安装】Linux 侧锁（回传入库）

# 【安装】网关/BFF 依赖（npm ci 只写仓内 node_modules）
cd /srv/dpit/apps/harness/engine-gateway && sudo -u dpit npm ci
cd /srv/dpit/apps/dataplat-ui/server && sudo -u dpit npm ci

# 【安装】dsh 装进隔离 prefix（不碰系统全局）
sudo -u dpit npm install --global --prefix /srv/dpit/runtime/dsh @deepseek-ai/dsh
/srv/dpit/runtime/dsh/bin/dsh --version                          # 【只读】
npm ls -g --depth=0 2>/dev/null                                  # 【只读】确认系统全局未增包

# 【权限变更】dpit 加入 docker 组（沙箱 docker run 需要；新开 shell 生效）
sudo usermod -aG docker dpit

# 【安装】沙箱镜像
cd /srv/dpit/apps/harness && sudo -u dpit docker build -t dataplat-script:m0 m0/sandbox/

# 【安装】env 文件（编辑后 chown/chmod；模板值见计划 §2，密钥占位符待你填测试值）
sudo install -o root -g dpit -m 640 /dev/null /etc/dpit/gateway.env   # 然后编辑器写入
sudo install -o root -g dpit -m 640 /dev/null /etc/dpit/bff.env
sudo install -o root -g dpit -m 640 /dev/null /etc/dpit/insight.env
# 本轮验证 env 关键项：DATA_ROOT=/srv/dpit/data/verify；GW_DB_PATH 等全部指向
# /srv/dpit/data/verify/ 下临时库；DEEPSEEK_API_KEY/DWS_* 用测试值；SANDBOX_MEM=512m；
# MAX_CONCURRENT_TASKS=1；PATH 含 /srv/dpit/runtime/dsh/bin；INSIGHT_SCHEDULER_SHADOW=1（S5 用）
```

## S2 单测与沙箱验证（进程级，无常驻）

```bash
cd /srv/dpit/apps/harness/engine-gateway && sudo -u dpit npm test   # Node 22.23.2 首过（含 retention 新分支）
cd /srv/dpit/apps/dataplat-ui/server && sudo -u dpit npm test       # 8 个 insight-flag 存量失败为已知基线
cd /srv/dpit/apps/harness && sudo -u dpit .venv/bin/python -m pytest eval/ -q
cd /srv/dpit/apps/harness && sudo -u dpit .venv/bin/python -m pytest insight/tests -q

# 红队 5/5（含新增跨任务隔离负向用例）
cd /srv/dpit/apps/harness && sudo -u dpit bash m0/tests/sandbox_redteam.sh

# 【只读】C1 进程组击杀 decoy 负向测试：目标组死、异组存活
sudo -u dpit bash -c '
set -m; sleep 300 & DECOY=$!;      # 异组 decoy
setsid sleep 300 & TARGET=$!;      # 目标组（组长）
kill -9 -"$TARGET" 2>/dev/null
sleep 0.3
kill -0 "$TARGET" 2>/dev/null && echo "TARGET-ALIVE(BAD)" || echo "TARGET-DEAD(OK)"
kill -0 "$DECOY"  2>/dev/null && echo "DECOY-ALIVE(OK)"  || echo "DECOY-DEAD(BAD)"
kill -9 "$DECOY" 2>/dev/null; true'

# 【只读】跨任务目录隔离（host 级）：WD2 对 65534 不可写
sudo -u dpit bash -c '
W1=$(mktemp -d /srv/dpit/data/verify/w1-XXXX); W2=$(mktemp -d /srv/dpit/data/verify/w2-XXXX)
setfacl -m u:65534:rwx "$W1"     # 模拟 run_in_sandbox.sh 只对 W1 放行
sudo -u nobody test -w "$W1" && echo "W1-WRITABLE(OK)"
sudo -u nobody test -w "$W2" && echo "W2-WRITABLE(BAD)" || echo "W2-NOT-WRITABLE(OK)"
rm -rf "$W1" "$W2"'

# 【只读】fs-read-fence 大小写语义抽查（Linux 上大写变体不得放行）——经 S4 dump-config 后的会话级验证项
```

## S3 Gateway / BFF / Insight API 手工启动冒烟（tmux 前台，验证完即停）

```bash
# 【服务启动】gateway（sudo -u dpit -i 取得 docker 组）
sudo -u dpit -i bash -c 'tmux new -d -s gw "cd /srv/dpit/apps/harness/engine-gateway && \
  set -a && . /etc/dpit/gateway.env && set +a && \
  node src/server/index.ts 2>&1 | tee /srv/dpit/data/verify/gateway.log"'
sleep 3; curl -s http://127.0.0.1:58080/api/health               # 【只读】期望 {"ok":true,...}

# 【服务启动】BFF
sudo -u dpit -i bash -c 'tmux new -d -s bff "cd /srv/dpit/apps/dataplat-ui/server && \
  set -a && . /etc/dpit/bff.env && set +a && \
  node src/index.ts 2>&1 | tee /srv/dpit/data/verify/bff.log"'
sleep 2; curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:58090/   # 【只读】期望 200（登录页）

# 【服务启动】insight api（先初始化临时库）
sudo -u dpit bash -c 'cd /srv/dpit/apps/harness && set -a && . /etc/dpit/insight.env && set +a && \
  .venv/bin/python -c "import os; from insight.db import open_db; open_db(os.environ[\"INSIGHT_DB_PATH\"])"'
sudo -u dpit -i bash -c 'tmux new -d -s ins "cd /srv/dpit/apps/harness && \
  set -a && . /etc/dpit/insight.env && set +a && \
  .venv/bin/python -m insight.api_main 2>&1 | tee /srv/dpit/data/verify/insight-api.log"'

# 【服务停止】验证完即停（只停 LIN-1 自建）
sudo -u dpit tmux kill-session -t gw 2>/dev/null; sudo -u dpit tmux kill-session -t bff 2>/dev/null; sudo -u dpit tmux kill-session -t ins 2>/dev/null
```

## S4 DSH Profile 自检

```bash
# 【安装】装 profile（渲染 env：MCP_PYTHON=/srv/dpit/apps/harness/.venv/bin/python）
sudo -u dpit -i bash -c 'cd /srv/dpit/apps/harness/engine-gateway && \
  set -a && . /etc/dpit/gateway.env && set +a && \
  PATH=/srv/dpit/runtime/dsh/bin:$PATH node scripts/setup-dsh-profile.mjs --profile sdk'
# 通过标准：SELF-CHECK OK——含 tool-bash/bash-sandbox 禁用断言与密钥红线断言
sudo -u dpit cat /srv/dpit/home/dpit/.dsh/profiles/*/cordis.patch.yml | grep -A1 "tool-bash"   # 【只读】disabled: true
```

## S5 Scheduler Shadow 验证（临时库，不连生产）

```bash
# 【服务启动】shadow 模式（只记账不执行不领队列；INSIGHT_DB_PATH 指向 /srv/dpit/data/verify 临时库）
sudo -u dpit -i bash -c 'tmux new -d -s sch "cd /srv/dpit/apps/harness && \
  set -a && . /etc/dpit/insight.env && set +a && export INSIGHT_SCHEDULER_SHADOW=1 && \
  .venv/bin/python -m insight.scheduler_main 2>&1 | tee /srv/dpit/data/verify/scheduler.log"'
sleep 5; grep -E "\[sched\]|shadow" /srv/dpit/data/verify/scheduler.log   # 【只读】期望看到 09:05/10:05/reconcile 注册 + shadow 标识
# 观察一个触发点后：【服务停止】sudo -u dpit tmux kill-session -t sch
```

## S6 端到端问数（非生产数据）

- 前提：你提供测试凭据（测试 DeepSeek key；DWS 测试账号或明确授权的只读账号）后执行。
- 方式：`engine-gateway/scripts/ask.py` 单问冒烟 + BFF 页面一次完整提问→报告流；全程 MAX_CONCURRENT_TASKS=1。
- 【服务停止】结束后停 gw/bff 会话；`docker ps` 确认无残留沙箱容器。

## 收尾（可选清理，均限定 LIN-1 自建）

```bash
# 【服务停止】tmux 会话全部（如上）
# 【安装-回滚】如需重来：rm -rf /srv/dpit/data/verify/*（仅验证数据）
# 【权限变更-回滚】sudo gpasswd -d dpit docker；sudo userdel -r dpit（终局清理时）
# 既有 PM2/Docker/systemd：全程未动
```
