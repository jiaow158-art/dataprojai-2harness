# 本机环境盘点（本地模拟执行模式，2026-09-08）

> M0 Task 1 前置条件盘点。执行环境：`D:\dataprojai-2harness`（本机 Windows，Git Bash）。
> 原则：只盘点，不安装。命令不存在即记 NOT INSTALLED。
> 盘点时间：2026-09-08 10:25 (+0800)

## 结果总览

| 项目 | 实际值 | 状态 |
|---|---|---|
| OS | Windows 10 Pro, 10.0.19045.6466（`cmd //c ver`） | OK |
| Docker | Docker version 27.5.1, build 9f9e405 | OK |
| Docker 运行状态 | `docker ps` 成功，Docker Desktop 在运行（4+ 容器 Up，含 postgres:16） | OK |
| Node | v24.14.0 | OK |
| npm | 11.9.0 | OK |
| Python | Python 3.12.7 | OK |
| 磁盘剩余（D 盘） | 196 GB 可用（共 276 GB，已用 81 GB，30%） | OK |
| 内存（物理总量） | 16,555,320 kB ≈ 15.8 GB（空闲约 2.8 GB） | OK |
| 出网-DeepSeek API | HTTP 401（可达；无 Key 时 401 属预期，网络链路通） | OK |
| 出网-npm registry | curl 原样执行 FAIL（见下方诊断）；npm 实际可用（`npm ping` PONG） | OK（有注记） |
| git（本地化新增） | git version 2.53.0.windows.1 | OK |
| ssh（本地化新增） | OpenSSH_10.2p1, OpenSSL 3.5.5 | OK |

## 明细与诊断

### OS
- `cmd //c ver` → `Microsoft Windows [版本 10.0.19045.6466]`（即 Windows 10 Pro 19045，与 env 声明一致）。

### Docker
- `docker --version` → `Docker version 27.5.1, build 9f9e405`
- `docker ps` 成功（exit 0），列出多个运行中容器：
  - `inventory-runtime:v0.1.0`（Up 2 hours）
  - `postgres:16`（Up 4 days，端口 5433→5432）
  - `malibang-app`（Up 2 weeks，端口 3001→3000）
- 结论：Docker Desktop 正在运行，容器创建/运行能力可用 → **Task 11 沙箱隔离可走 Docker 形态**。

### Node / npm / Python
- `node --version` → `v24.14.0`
- `npm --version` → `11.9.0`
- `python --version` → `Python 3.12.7`
- 结论：**dsh 可本地安装**（node/npm 均满足）。

### 磁盘（D 盘）
- `df -h /d` → `D: 276G total, 81G used, 196G avail (30%)`。空间充裕。

### 内存
- `wmic` 在本机不可用（Git Bash 与 `cmd //c wmic` 均报"不是内部或外部命令"——Windows 10 19045 已移除/未装 wmic），改用等价来源 `/proc/meminfo`：
  - `MemTotal: 16555320 kB` ≈ **15.8 GB**；`MemFree: 2952624 kB` ≈ 2.8 GB（盘点时刻）。

### 出网：DeepSeek API
- `curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://api.deepseek.com/` → **401**（exit 0）
- 401 = 服务器应答"未认证"，属无 API Key 时的预期响应 → **网络可达，TLS 正常**。

### 出网：npm registry（含重要注记）
- 原样执行任务给定命令：`curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://registry.npmjs.org/` → **`000`，curl exit 35**（SSL connect error）。
- 根因诊断（`curl -sv`）：DNS 解析与 TCP 均通，失败于 `schannel: CRYPT_E_REVOCATION_OFFLINE (0x80092013)` —— Windows curl (schannel) 的证书吊销检查服务器不可达，**并非 registry 断网**。
- 验证（证明 npm 实际可用）：
  - `curl --ssl-revoke-best-effort ... https://registry.npmjs.org/` → **200**
  - `npm ping` → `PONG 822ms`（npm 配置 registry = `https://registry.npmjs.org/`）
  - 备用镜像 `https://registry.npmmirror.com/` → 200（应急可选）
- 结论：**npm registry 实际可用**；curl 原样命令的失败是 schannel 吊销检查工件。后续任务若用 curl 直连 npmjs.org，需加 `--ssl-revoke-best-effort`（或改用 `npm ping` 验证）。

### 本地化新增项
- `git --version` → `git version 2.53.0.windows.1`
- `ssh -V` → `OpenSSH_10.2p1, OpenSSL 3.5.5 27 Jan 2026`（可用）

## 对后续任务（M0）的含义

| 后续任务 | 前置条件结论 |
|---|---|
| dsh 本地安装（node/npm） | 满足：Node v24.14.0 + npm 11.9.0，registry 实测可用 |
| Docker 沙箱（Task 11 形态决策） | Docker Desktop 27.5.1 运行中，`docker ps` 正常 → 走 Docker 沙箱形态 |
| 模型 API 访问（DeepSeek） | 链路可达（401 待配 Key）；需在后续任务配置 `DEEPSEEK_API_KEY` |
| 磁盘/内存余量 | D 盘剩 196 GB、物理内存 15.8 GB，满足本地验证规模 |
