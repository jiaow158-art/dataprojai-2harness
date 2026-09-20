# dataprojai-2harness — 东鹏问数系统 · AI 数据层（dsh 引擎）

企业自助问数系统的核心仓库之一：**DeepSeek Harness（dsh）作为 agent 引擎**，取代闭源运行时，对接 GaussDB(DWS) 数据仓库。用户用自然语言提问，系统查数、分析、生成报告。

> 姊妹仓库：`dataplat-ui`（自建 Web 界面：登录 + 对话流 SSE + 报告查看，对接契约见 `docs/superpowers/reports/2026-09-16-m2-integration-check.md`）

## 架构

```
浏览器(dataplat-ui) → UI BFF → engine-gateway(本仓) → dsh → DeepSeek API
                                        │
                                        ├→ Docker 沙箱（受控执行，网络隔离）
                                        └→ DWS MCP（只读查询，双通道落盘）
```

## 目录导览

| 目录 | 内容 |
|---|---|
| `engine-gateway/` | 任务网关：HTTP/SSE API、租约围栏、幂等、断点恢复、读域围栏插件装载（Node 24 + TS strip + better-sqlite3） |
| `skills/` | 6 个业务域知识库/分析师技能对（fin-cost / inventory / ar / sales-performance / otd-fulfillment / sku-profitability）+ report-generator；各域 `metrics.md` 含"pattern → 首选表与字段"路由节 |
| `m0/` | 引擎能力验证产物：Docker 沙箱、dsh 插件（受控执行 exec-script、读域围栏 fs-read-fence）、findings |
| `eval/` | 判分器（纯函数，pytest）+ 红队场景 + 离线复判工具 |
| `eval_dataset.json` | 85 个标准场景（6 域 79 + 红队 6），期望 SQL + 完整数据行 |
| `run_agent_eval.py` | live 评测驱动器（经网关全链路，`--idx` 金点子抽样 / `--fresh` 强制重跑） |
| `sources-of-truth/` | 跨域主数据参考（组织/客户/物料/公司/WBS） |
| `docs/superpowers/` | 全程 spec / plan / report（迁移决策与证据链都在这里） |

## 快速开始

```bash
# 1. dsh profile 装载（幂等，含安全自检：工具白名单 + 读域围栏 + MCP 注入）
cd engine-gateway && node scripts/setup-dsh-profile.mjs --profile sdk

# 2. 起网关（env 清单见 docs/superpowers/reports/2026-09-16-m2-report.md 部署节）
cd engine-gateway && AUTH_TOKEN=... DWS_RUN_PASSWORD=... node src/server/index.ts

# 3. 手动问一轮（同会话可追问）
python engine-gateway/scripts/ask.py "2026年8月瓷砖事业部库存金额多少"

# 4. 评测
python run_eval.py <domain>                                  # 离线（期望 SQL 直连 DWS）
EVAL_LIVE=1 python run_agent_eval.py --idx 0,1,4 --round-tag x  # live（全链路）
python eval/rejudge_round.py eval_results/round-x            # 判分器校准后零成本复判

# 5. 测试
python -m pytest eval/ -q        # 判分器/驱动器（97 用例）
cd engine-gateway && npm test    # 网关单测
```

## 里程碑

| 阶段 | 状态 |
|---|---|
| M0 完整能力验证 | ✅ GO（金样报告 26.7min 零干预复现） |
| M1 服务化与恢复 | ✅ GO（五发故障注入全 PASS：双活围栏/发布恢复/SSE 重连/幂等/进程死亡接管） |
| M2 迁移回归 | ✅ GO with exceptions → 前置全部销账（金点子轮 10/10 引擎全对） |
| M3 内部白名单试点 | 前置清零，待启动 |

## 安全基线

- **密钥只走环境变量**（DWS_PASSWORD / DEEPSEEK_API_KEY / AUTH_TOKEN），任何文件不含值；曾有真实 key 误入旧文档，已全历史清洗（见 `a0cde62`）——新贡献请保持此红线
- 工具白名单 26 项（禁宿主执行/网络/自治循环通道）；**读域围栏**（`m0/dsh-plugin/fs-read-fence`）：模型文件访问限定 工作区/结果/技能/资产/临时 根内；写侧由 fs-sandbox 围栏，执行隔离由 Docker 沙箱承担
- DWS 账号已收紧为只读（写授权全撤）；红队 6 场景（`eval/redteam.md`）持续在评测集内回归
