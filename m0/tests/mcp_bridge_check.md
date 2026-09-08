# M0-T9 验证记录：MCP 桥接 + 双通道在 dsh 下生效（本地 Windows）

- 日期：2026-09-08
- 环境：dsh 0.1.2-rc.1（npm 全局 `@deepseek-ai/dsh`），Windows 10，Python 3.12.7 + psycopg2 2.9.12
- 依据：`m0/findings/dsh-api.md` §3（配置格式唯一权威）、`m0/findings/environment.md`
- 关联计划：`docs/superpowers/plans/2026-09-08-dsh-m0-capability-verification.md` Task 9（D13 双通道实证）

---

## 1. 注册方式摘要

**配置落点（findings §3.2 单 profile 持久层）：**

```
C:\Users\Administrator\.dsh\profiles\headless\cordis.patch.yml
```

- 非 `.mcp.json` 式独立文件——是一行 Cordis patch entry（`- insert:` 列表），boot headless profile 时自动叠加。
- 该文件在 `$DSH_HOME`（用户目录）下，**不在 git 仓库内**，天然不进暂存区；其完整内容不含任何密钥明文（见下）。

**完整配置内容（无密钥，可直接阅读）：**

```yaml
- insert:
    - id: mcp-dws
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: dws
        transport: stdio
        command: 'C:\Users\Administrator\AppData\Local\Programs\Python\Python312\python.exe'
        args: ['D:\dataprojai-2harness\dws_mcp_server.py']
        env:
          DWS_HOST: '121.37.200.214'
          DWS_PORT: '8000'
          DWS_DBNAME: 'DP_DWS'
          DWS_USER: 'aiuser'
          DWS_PASSWORD: !!js process.env.DWS_PASSWORD
          RESULT_DIR: 'D:\dataprojai-2harness\m0\results'
          RESULT_PREVIEW_ROWS: '200'
```

**env 注入途径（本任务最大不确定点 → 实测结论：显式注入可行，无需绕过洗净机制）：**

- dsh stdio 桥启动子进程前按 `/KEY|PASSWORD|SECRET|TOKEN/i` 与 `DSH_*` 洗净宿主环境变量
（dsh-mcp-client README "Environment scrubbing (stdio)" 原文，与 findings §3.3 一致）——
宿主的 `DWS_PASSWORD` 若不显式注入，MCP 子进程拿不到。
- 解决：`config.env` 里写 `DWS_PASSWORD: !!js process.env.DWS_PASSWORD`——YAML 加载时
从**宿主进程环境**取值合并进子进程 env。**文件里只有表达式，没有值**，因此无需 .gitignore 处理，
配置文件本身可安全展示/复制。
- 注入真正到达 MCP 进程的证据链（三条独立证据）：
  1. headless 运行 stderr 出现 `[dws-mcp] Started. 121.37.200.214:8000/DP_DWS as aiuser`
     （dws_mcp_server.py 的启动日志；脚本默认口令为空串，若 `DWS_PASSWORD` 未注入则所有查询必报认证错误）；
  2. 全部 4 次实测查询均成功返回真实数据（认证通过）；
  3. `RESULT_DIR` 注入生效——查询结果 JSON 确实落盘到 `m0/results/`（该变量无默认值，未注入则不会产生文件）。
- 工具命名与 findings §3.1 一致：`mcp__dws__list_tables` / `mcp__dws__describe_table` /
  `mcp__dws__search_tables` / `mcp__dws__run_query`（模型会话中即以此名调用）。

---

## 2. Step 2：会话内验证 4 工具中的 3 个发现类工具

headless 提问（原文）：

> 请依次使用可用的 dws 工具：先用 list_tables 列出 dm schema 的表数量，再用 describe_table 查看
> dm.dm_fact_finance_cost_f 的列数，最后用 search_tables 搜关键字"跌价"返回前几个匹配表。只报告三个结果。

| 工具 | 模型报告 | 独立核对 | 结论 |
|---|---|---|---|
| `list_tables(schema_name='dm')` | 500 张（模型主动指出这是服务端 `LIMIT 500` 截断上限，真实数 ≥500） | server 端确有 LIMIT 500 | PASS |
| `describe_table('dm.dm_fact_finance_cost_f')` | **93 列** | `information_schema.columns` 实查 = **93** | PASS（精确一致） |
| `search_tables('跌价')` | 3 个匹配表（dm.dm_own_inventory_t 及两个 _tmp 变体），模型主动提示 _tmp 后缀按仓库惯例不可用 | — | PASS |

- `run_query` 在 Step 3 单独验证（4 次调用全部成功）。
- 附带观察（不影响本任务结论）：dsh 自身对超长工具输出有 spill 机制——把完整格式化结果存到
  `%TEMP%\dsh-spill-*\` 并在会话内给出路径（模型可自行读取）。这是 dsh 侧的输出预算管理，
  与 D13 的服务端双通道（见下）是两层不同机制，不冲突。

---

## 3. Step 3：双通道（D13）生效验证 —— 核心对照表

前置：`m0/results/` 清空后开始；本节所有数字均为实测。

### 3.1 "模型可见行数 vs 落盘行数"对照表

| # | 查询 | 模型回答的行数 | 工具响应内 `data` 数组行数 | 落盘文件 `row_count` | 落盘文件 `data` 行数 | 落盘文件 |
|---|---|---|---|---|---|---|
| 1 | `SELECT * FROM dm.dm_fin_stock_detail_accage_t_2023 WHERE calmonth='202608' LIMIT 5` | **5** | 5 | **5** | 5 | `r-20260908123742-45988-1.json`（28,484 B，183 列） |
| 2 | `SELECT calmonth, plant, count(*) AS row_cnt FROM … WHERE calmonth>='202601' GROUP BY calmonth, plant`（**无 LIMIT**） | **855**（响应 JSON `row_count`） | **200**（预览截断） | **855** | **855** | `r-20260908123825-44344-1.json`（50,204 B，3 列） |

**验证点逐条：**

1. **行数一致性（LIMIT 5）**：模型回答 5 行 == 落盘 row_count 5 == 落盘 data 5 行。PASS。
2. **落盘完整性**：`ls m0/results/` 出现 `r-*.json`，row_count 与模型报告一致。PASS。
3. **D13 双通道实证（无 LIMIT、>200 行）**：
   - 模型侧 `data` 仅 **200 行**预览（模型逐月清点：202601=37、202602=36、202603=37、202604=36、202605=36、202606=18，合计 200，数组在 202606/plant=1710 处闭合）；
   - 模型侧 `row_count` 报实际 **855**、`truncated=false`（"完整集已落盘，预览截断不算数据丢失"语义正确）；
   - 落盘文件 row_count=855 且 data 实际 855 行（独立用 Python 解盘核对，非模型转述）；
   - **即：模型可见（200 预览）≠ 落盘完整（855）≠ 响应 row_count（855）——双通道行为与设计一致。PASS。**
   - 模型在回答中自行发现并正确解读了 `len(data)=200 ≠ row_count=855` 的关系（"要拿全部明细须读 result_path 文件"）。
4. **错误契约（查不存在的表）**：
   - 提问让模型执行 `SELECT * FROM dm.dm_no_such_table_t9_probe LIMIT 5`；
   - 模型原样复述收到的结构化错误：
     `{"status": "error", "message": "relation \"dm.dm_no_such_table_t9_probe\" does not exist\nLINE 1: ...RE \"mcp_q1\" CURSOR WITHOUT HOLD FOR SELECT * FROM dm.dm_no_s...\n"}`
   - dsh 进程 exit 0、无崩溃，模型明确声明"查询以错误告终，未返回任何数据行"，未编造数据。PASS。

### 3.2 换因说明（查询设计偏离计划的一处）

- 计划假设"calmonth 过滤不加 LIMIT 应数百行"**不成立**：实测 `calmonth='202608'` 单月即 **6,324,581 行**
  （全表 70 个月共约 1.44 亿行）。按计划原文原样执行的无 LIMIT 明细查询会撞 5 万行数据预算被截断拒存，
  无法作为"数百行完整落盘"的双通道实证。
- 处理：保持"带时间过滤的小查询"性质，换为聚合查询
  `SELECT calmonth, plant, count(*) … WHERE calmonth>='202601' GROUP BY calmonth, plant`
  → 实测 **855 行**（>200 触发预览截断、<50000 预算内完整落盘），恰好落在双通道验证窗口。
  LIMIT 5 的明细查询按计划原文未改动执行。

---

## 4. 密钥安全自查

- `DWS_PASSWORD` 的值仅存在于环境变量；本次所有记录、命令输出、commit 内容中**零明文出现**。
- 注入用 `!!js process.env.DWS_PASSWORD` 表达式引用，未把密码写入任何项目内文件
  （配置文件在 `C:\Users\Administrator\.dsh\` 下，不在仓库内，且内容本身无密钥）→ 无需 .gitignore 动作。
- `git status` 自查：本次仅新增 `m0/tests/mcp_bridge_check.md` 进入暂存区；`m0/results/` 的查询结果
  （含业务数据）保持未跟踪、不提交。
- 工作区扫到两处**与本次任务无关的存量** `DWS_PASSWORD` 相关内容，如实上报、未改动：
  1. `.mcp.json`（已跟踪）：值为 `${DWS_PASSWORD}` 环境变量引用占位符，**非明文密钥，安全**；
  2. `_test_mcp.sh`（已跟踪，存量文件）：第 5 行含一处 15 字符的 `export DWS_PASSWORD="…"` 字面量，
     经比对**不等于**当前环境变量值（疑似历史口令或笔误残留）。属存量问题，建议仓库管理员单独处置
     （rotate + 从历史清除），不在本任务范围。

---

## 5. 结论

| 验证项 | 结果 |
|---|---|
| MCP server 注册（stdio，Cordis patch） | 生效，4 工具以 `mcp__dws__*` 出现在模型工具表 |
| list_tables / describe_table / search_tables | 三个工具通，数字经独立核对（93 列精确一致） |
| run_query 基本链路 | 通（4 次实跑全部成功） |
| D13 双通道：模型预览 vs 落盘完整 | 实证成立（200 预览 / 855 完整 / row_count 报真值） |
| 错误契约 | 结构化 `status=error` 返回，不崩溃 |
| 密钥安全 | PASS（零明文、零暂存） |

**Status: DONE**（无 BLOCKED 项；两处存量安全观察见 §4，均非本任务引入）
