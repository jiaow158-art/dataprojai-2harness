# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目定位 — 东鹏问数系统 · AI 数据层（dsh 引擎）

企业自助问数系统：业务用户经 Web 提问，agent 查 GaussDB(DWS) 数仓、分析、出报告。本仓已完成 **DeepSeek Harness（dsh）引擎迁移**（M0-M2 全 GO，M3 前置清零）——**Claude Code 在本仓只做开发工具，不是运行时**。

| 仓库 | 角色 |
|---|---|
| **`D:\dataprojai-2harness`**（本仓） | 引擎网关 + Skills 知识库 + 评测体系 |
| **`D:\dataplat-ui`** | 自建 Web UI（登录/对话 SSE/报告；claudecodeui 已弃用） |

全程决策与证据链在 `docs/superpowers/{specs,plans,reports}/`——动架构前先读对应文档。设计依据 Anthropic 4-layer Agentic Analytics Stack（Skills/参考面/语义层/评测）。

## 架构（大图）

```
浏览器(dataplat-ui) → UI BFF → engine-gateway → dsh SDK 子进程 → DeepSeek API
                                        │
                                        ├→ Docker 沙箱执行脚本（--network none 等 5 要素）
                                        └→ DWS MCP 子进程（只读 SELECT，双通道落盘）
```

**engine-gateway/**（Node 24 + TS strip 模式 + better-sqlite3 WAL）
- `src/store/task-store.ts` 围栏条件写（run_id+attempt+lease_owner，rowcount=0→静默杀自身进程树）；`src/backends/dsh-backend.ts` 每次 spawn 的 SDK sessionId 必须全局唯一 `gw-<sid>-a<attempt>-<nonce>`（同 id 跨进程必撞）；`src/orchestrator/task-runner.ts` D14 历史注入（每次执行都注入，非仅 attempt>1）、失败分类（TIMEOUT/ENGINE_ERROR 重试，CONFIG/QUOTA 快败，REPORT_CHECK 终态）
- BackendProvider 接口可插拔换引擎；Web/API 契约冻结在 `docs/superpowers/reports/2026-09-16-m2-integration-check.md`（改契约须代码+文档双改）
- e2e 五发故障注入 `test/e2e.live.test.ts`：**必须串行跑**（收尾清理器全机扫杀 dsh 进程），且 Docker Desktop 必须在跑

**dsh 插件**（`m0/dsh-plugin/`，经 `engine-gateway/scripts/setup-dsh-profile.mjs` 装入 ~/.dsh/profiles——脚本+模板是 profile 唯一权威，含 dump-config 自检）
- `exec-script/`：模型执行代码唯一通道（Docker 沙箱）
- `fs-read-fence/`：tools/execute 瀑布拦 read/read_image/glob/grep 路径域（工作区/结果/技能/资产/临时）；写侧归 fs-sandbox，分层不重叠
- 工具白名单 26 项（pwsh/web×2/workflow/ralph 已禁）；改沙箱/插件必须复跑 `m0/tests/sandbox_redteam.sh`

**skills/**：6 域配对 `{domain}-knowledge`（路由+references）+ `{domain}-analyst`（6 步工作流+对抗审查，+6% 准确率不可跳）+ `report-generator`。各域 `metrics.md` 的 **"pattern → 首选表与字段路由"节是口径判定标准**（以 eval_dataset 录制口径为准，不替业务拍板）——修口径问题先看这节。

**评测体系**
- `eval_dataset.json`：85 场景（6 域 79 + 红队 6）= 业务正确性标准；**数据集是标准**——改问题/SQL/data 都要逐条记变更清单（先例：`eval_results/round-manual/T6-changes.md`、`dataset-repair-20260920.md`），文本级替换保字节形态（CRLF/无 BOM）
- `eval/judge.py` 纯函数判分（97 pytest）：多事件最佳匹配 / 拒答词表 / 采样录制前缀感知 / 列改名数值多重集兜底 / CTE 表名过滤——实弹校准出来的语义，改前先读测试
- `run_agent_eval.py` live 驱动器（`EVAL_LIVE=1` 门禁防误烧 API；`--idx` 精确选场；`--fresh` 自动给 submission_id 加盐——网关幂等键不变会原样返回旧任务）；`eval/rejudge_round.py` 判分器校准后零成本复判录播

## 常用命令

```bash
# 测试
python -m pytest eval/ -q                    # 判分器/驱动器全量
python -m pytest eval/test_judge.py -v      # 单文件
cd engine-gateway && npm test               # 网关单测

# 离线评测（期望 SQL 直连 DWS，不烧 API）
python run_eval.py [domain|留空全量]

# live 评测（需网关在跑 + GATEWAY_URL/AUTH_TOKEN/GW_RESULTS_ROOT env）
EVAL_LIVE=1 GATEWAY_URL=http://127.0.0.1:58080 AUTH_TOKEN=... \
  GW_RESULTS_ROOT=<网关结果根> python run_agent_eval.py --idx 0,1,4 --round-tag x

# 网关（env 清单见 M1 报告部署节；DWS_RUN_PASSWORD 必须显式设）
cd engine-gateway && node scripts/setup-dsh-profile.mjs --profile sdk   # 先装 profile（幂等）
node src/server/index.ts

# 手动问数（同会话追问；/new 重开）
python engine-gateway/scripts/ask.py "2026年8月瓷砖事业部库存金额多少"

# e2e（真 dsh/DeepSeek/DWS；串行！）
cd engine-gateway && E2E_LIVE=1 E2E_SHOT=shot4 node --test test/e2e.live.test.ts
```

Python = `python`（3.12）；Node = v24（TS strip：**禁** parameter properties/enum/namespace）。Shell 是 Git Bash。

## 红线（违反=返工）

- **密钥只走 env**（DWS_PASSWORD / DEEPSEEK_API_KEY / AUTH_TOKEN）：任何文件/日志/测试输出不得含值；曾有真实 key 误入文档被 GitHub 推送保护拦截后全历史清洗（`a0cde62`）——推送前 `git grep -E "sk-[A-Za-z0-9]{20,}|ghp_|github_pat_"` 自查
- 网关 stderr 消毒（PASSWORD|TOKEN|SECRET|KEY 模式）不得回退
- 后台代理并行作业时**提交必须路径限定**（`git commit -m msg -- <paths>`），防卷入他人暂存
- workdir/results 目录必须在平台 Temp 树外（workspace-write 硬编码豁免 os.tmpdir()）
- UI 侧身份只信 BFF 注入的 X-User；报告属主校验+路径遏制不可绕过

## 数仓关键事实

- **日期格式混乱**：同概念各表用 YYYYMM / YYYY-MM / YYYYMMDD / YYYY-MM-DD / timestamp，逐表核
- **`___t` 后缀** = SAP 风格文本描述字段；**双命名**：`cust_code`(DWR) vs `debitor`(SAP)、`material` vs `material_num`、`plant` vs `factory_werks_code`
- **备份变体表**（`_bak/_tmp/_wjh/_01/_close/_2024*` 后缀）勿用；判分器见此形态直接判表选错
- **大表**（>10M 行）必须带时间过滤：`dm_fin_stock_detail_accage_t_2023` 144M、`dwr_ar_account_detail_f` 103M、otd det 899M/track 794M
- **同名组织维表**：`dm_rpt_sale_grp_t`（关联键 sale_grp=vkgrp，otd 用）≠ `dm_rpt_sales_group_t`（10 级树，node_name10，sales-performance 用；**实测其 org_code 100% 属瓷砖事业部**，非瓷砖 JOIN 必空）
- 跨域主数据在 `sources-of-truth/business-context/`（组织/客户/物料/公司/WBS）
- DWS：`121.37.200.214:8000` / `DP_DWS` / `aiuser`（已收紧只读：写授权全撤、全 schema CREATE=False）；密码 env DWS_PASSWORD
