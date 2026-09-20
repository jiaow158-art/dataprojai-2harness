# M3 试点 SOP（一页）

> 适用：本机常驻形态（pm2，`http://172.20.166.47:58090`）。服务器上线时本页升级为运维手册。

## 用户须知（发给白名单同事的三句话）

1. 入口 `http://172.20.166.47:58090`，账号找管理员领；登录后直接输入问题（覆盖：费用成本/库存/应收/销售业绩/订单履约/SKU 效益六域），可追问、可"生成报告"
2. 一次提问约 0.5-3 分钟（复杂报告更久），过程实时可见；排到队里会显示排队
3. 问不了的（六域之外/要求改数据/读服务器文件）会被拒答——这是边界不是故障；异常情况截图+时间点发管理员

## 管理员日常（每天 5 分钟）

```bash
# 1. 日报：任务量/成功率/失败清单/tokens
node engine-gateway/scripts/pilot-daily.mjs

# 2. 有失败任务时逐例归因（run_id 在日报里）
node engine-gateway/scripts/audit.mjs --run <run_id>

# 3. 查某位用户全部行为 / 某天全员行为
node engine-gateway/scripts/audit.mjs --user pilot-01
node engine-gateway/scripts/audit.mjs --date 2026-09-20
```

- 巡检项：pm2 两 app online（`pm2 status`）→ 日报无未归因失败 → DeepSeek 余额（平台页面；低于预算阈值充值）
- 建号/改密：`cd D:\dataplat-ui\server && printf '密码\n密码\n' | DATA_DIR=./data-prod npm run admin:add <用户名>`，凭据记入 `D:\m0-sessions\prod\whitelist-credentials.txt` 并更新发放状态

## 异常处理

| 症状 | 处置 |
|---|---|
| 同事打不开页面 | `pm2 status` 看 dataplat-ui；挂了 `pm2 restart dataplat-ui` |
| 提问秒失败 | `audit.mjs --run` 看 error_code：CONFIG=环境/凭据问题（查 pm2 env）；QUOTA=DeepSeek 余额（充值） |
| 沙箱类失败（exec 报错） | 确认 Docker Desktop 在跑（开机自启）；`docker images | grep dataplat-script` |
| 服务重启 | `pm2 restart all`；断电后开机 pm2 自动 resurrect（Docker 随登录起，期间沙箱任务会失败属预期） |

## 例行红线

- 红队 6 场景每周一跑：`EVAL_LIVE=1 GATEWAY_URL=http://127.0.0.1:58080 AUTH_TOKEN=$(见 token.txt) GW_RESULTS_ROOT=D:\m0-sessions\prod\results python run_agent_eval.py redteam --round-tag weekly`（注意 prod 网关 AUTH_TOKEN 是强随机值，从 `D:\m0-sessions\prod\token.txt` 读）
- 密钥轮换：改 DeepSeek/DWS 密码后同步更新 pm2 env（`pm2 restart engine-gateway`）+ token.txt
- 试点期产品代码不热改：问题记 `eval_results/pilot/incidents.md` → 修复过 eval 回归 → 再上线

## 已知限制（试点期接受）

- 无角色区分（所有账号平权）；无 HTTPS（内网 http）；BFF 登出记录不落史（审计只有存活会话反推）；v1 无改密功能
