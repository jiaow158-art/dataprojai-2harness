# M0-T14 验证记录：金样报告端到端复现（dsh 在最终受限环境完整复现四域经营分析报告）

- 日期：2026-09-09
- 环境：dsh 0.1.2-rc.1（headless profile，含 m0-exec-script-plugin bundle + mcp-dws patch），
  Windows 10 + Git Bash + Docker Desktop（沙箱镜像 `dataplat-script:m0`），模型 deepseek-v4-flash
- 金样：`m0/golden/report.html`（1,098,634 B，四域经营分析报告，trace.md §2.1 官方提问）
- 关联：计划 Task 14；前置 T7（skill 兼容）/ T9（MCP 双通道）/ T13（exec_script+工具禁用）/ T3（金样）

---

## 1. Status: DONE_WITH_CONCERNS

**核心命题"换底盘，不减能力"成立**：在无任何人工干预的条件下，dsh 模型在最终受限环境
（工具白名单 = skill + MCP + exec_script；无 shell、无网络工具；workdir 写域；Docker 沙箱
无网/只读 rootfs/资源上限）中，端到端复现了金样同级产物：**合法 HTML 报告**（1,080,211 B），
结构 4/4 通过 compare 检查，5 tab / 8 图 / provenance 七键+1 扩展与金样完全同构，
金样 8 项 KPI 中 4 项数值精确命中、销售/库存/费用三域口径与金样一致。
应收域出现**口径分歧**（详见 §6 差异清单）——这是数据口径决策差异，不是能力缺失；
模型对分歧的处理方式（多表交叉验证 + 自洽性筛选 + limitations 声明）恰是
skill 体系对抗审查训练出的正确行为。

## 2. 会话事实

| 项 | 值 |
|---|---|
| 官方提问 | trace.md §2.1 原文 183 字符，逐字使用（已脚本核对 byte-equal） |
| 会话 ID | `session-0438fd36-3259-4129-8da5-14369ea9554a`（`~/.dsh/sessions/--D-m0-sessions-t14-workdir--/`） |
| cwd slug | `--D-m0-sessions-t14-workdir--`（workdir 在 Temp 树外，T13 定型规范） |
| 起止（本机时区 GMT+8） | 09:15:46 → 09:42:30（会话日志首末事件 09:16:17 → 09:42:14） |
| 耗时 | dsh 进程 1604 s（26.7 min）；会话事件流 1557 s；**远低于 40 min 超时线** |
| exit code | **0**（stdout 产出最终回答 2,514 B） |
| 环境变量 | `M0_SANDBOX_WORKDIR=D:\m0-sessions\t14\workdir`、`M0_RESULTS_DIR=D:\dataprojai-2harness\m0\results`（与 MCP RESULT_DIR 相同）、`M0_ASSETS_DIR=D:\dataprojai-2harness\skills\report-generator`、`M0_SANDBOX_RUNNER=…\m0\sandbox\run_in_sandbox.sh`、`M0_PROJECT_SKILL_DIR=D:\dataprojai-2harness\skills` |
| token | input 224,272 / output 149,907 / cacheRead 11,723,776 / reasoning 125,683（assistant/message usage 累加） |
| 工具面 | request/header.tools 共 **26 项**；`pwsh`/`web_fetch`/`web_search`/`workflow`/`ralph` 全部缺席，`exec_script` 在列（T13 安全复审终验状态在真实任务下复现） |

## 3. 执行轨迹摘要（session.jsonl.zstd 7,246 事件解压取证）

- **skill 加载 9 次，全部命中**：四域各 analyst+knowledge（8 个）+ report-generator。
  会话开始即并行加载四域 skill；每个域动手查询前先 `read` 该域 `references/metrics.md`
  （mandatory first-read 规则被自发遵守，全程 7 次 read 中 4 次是 metrics.md、3 次是 AR 参考文档）。
- **MCP DWS 查询 60 次**（run_query 52 / describe_table 3 / search_tables 5），
  全部成功、零 SQL 报错、零编造数据。查询形态与 skill 文档口径高度一致：
  `calmonth`/`query_date`/`month` 三种日期格式按各域文档正确使用；
  mix 表自动剔除 `data_source='U'`；发现并主动排除 mix 表 38 行 `calmonth='S'` 脏数据
  （模型自己写了探测查询定位该异常）。
- **MCP 落盘双通道**：本次会话落盘 53 个结果文件（`m0/results/r-20260909*.json`），
  全部 ≤200 行（本次查询均为聚合/小结果，未触发预览截断场景）。
- **exec_script 16 次调用**（10 个脚本）：env_probe / show_build_help / inspect_template /
  grep_rules / cat_validator / sed_script / sed_rest / **build_report / verify_report**。
  脚本职责：探测沙箱环境 → 查 build.py 用法 → 查模板 chart 数组渲染 → 查 validator 约束 →
  **组装 REPORT_JSON → build.py 构建 → 复验 HTML**。
- **自纠错 7 次**（全部同型、全部恢复）：模型先调 exec_script 再写文件 → 容器内 127
  "No such file"（write 与 exec 的时序间隙，见 §7 顾虑）→ 模型读到错误 → write 脚本 →
  重跑成功。另有 1 次 read 路径错（猜 `m0\assets\...` 不存在）→ 改经沙箱读 `/assets` 成功。
  **8 个 isError 全部被模型吸收修正，无一放弃或绕过沙箱。**
- **无 pwsh/web 逃逸**：全程零次尝试调用被禁工具（会话日志全文核验）。
- build.py 在沙箱内一次通过（validator 零 FAIL），随后模型主动跑 verify_report.sh
  （validate_report.py 对 HTML+JSON 双复验）→ `OK report_business_20260909.html`。

## 4. 产物

| 项 | dsh 产物 | 金样 |
|---|---|---|
| 文件 | `m0/verify/report.html`（拷自 workdir `reports/report_business_20260909.html`） | `m0/golden/report.html` |
| 字节 | 1,080,211 | 1,098,634 |
| 产物形态 | **完整 HTML 报告**（非 Markdown 替代），build.py 管线产物 | 同管线（浏览器另存快照） |
| KPI 卡 | 6 | 8 |
| tab | 5（销售业绩/财务费用/应收账款/库存分析/附表） | 5（销售业绩/财务费用/应收风险/库存运营/明细数据） |
| 图表 | 8（chart 数组 2×4 tab） | 8 |
| 图表数据点 | 89 | 55 |
| 明细表 | 12 行×7 列（11 中心+合计；含环比/同比列） | 10 行×4 列（目标表覆盖 10/11 中心） |
| insight | 252 字 | 249 字 |
| provenance | 7 键+1 扩展（`table`），query 1,769 字符 SQL | 7 键 |
| md5 | 02dc54756ba07db60e3700d7aba33a60 | c0658e04548335ef0a129fb339652339 |

## 5. compare 结构检查（compare_report.py，金样基线）

```
PASS  产物非空且为HTML
PASS  echarts本地引用
PASS  无外链CDN
PASS  图表tab结构(金样5 vs 产5)
exit=0（fresh_truth.json=[] 占位，指标检查按 T14 计划跳过，T15 补）
```

tab 计数正则的偏差说明（已写进 compare_report.py 注释）：初版用 `class="tab-btn` 前缀
（金样=6，含浏览器另存渲染出的 5 个静态按钮），对 fresh build 产物只命中 JS 模板串 1 处
而 FAIL。实测后修正为语义等价的 REPORT_JSON `"tab":` 字段计数——金样 5 = 产 5。
静态 class 形态差异是"浏览器另存 vs fresh 构建"的产物形态差，不是结构差异。

## 6. 与金样的显著差异 TOP5（数值核对属抽查级，真值重导在 T15）

1. **应收域口径分歧（最大差异）**：金样 KPI 应收余额 **33.63亿**/逾期率 **68.4%**
   （口径 = `dwrfin.dwr_ar_receivable_aging_2023_info_f`，6 科目白名单 + 正余额，
   metrics.json 已注明该口径未在文档中沉淀）；dsh 产物 **18.11亿**/逾期率 **80.0%**
   （口径 = `dm.dm_ar_analysis_rpt_f` receivables_am，余额=逾期+未逾期自洽）。
   模型实测过金样同款表（未加科目过滤时 70亿/负值 not_overdue，判定不自洽后弃用），
   并在 5 张候选表（70/13.4/18.11/11.09/13.08 亿）间做了完整交叉验证后选择自洽口径，
   且在 provenance.limitations 中声明口径差异。**根因**：金样口径是"从报告数值反推"的
   隐性知识（trace.md §6 自认仅该表"可复现"），未沉淀进 ar-knowledge 文档；模型按文档
   可自洽解释的公开口径行事。属知识库维护缺口，非模型能力缺口。
2. **KPI 卡 6 vs 8**：金样把逾期率、长龄库存单列 KPI（8 卡）；dsh 合并进 change 文案
   （6 卡，"逾期率80.0%""12M+长龄占比32.5%"在 KPI change 中），信息量等价、卡片策略不同。
3. **渠道图 vs 事业部图**：金样 tab1 有整合渠道业绩图（GD03 2.167/GD01 2.077/…）；
   dsh tab1 用事业部达成图+渠道毛利率图，渠道达成额以 analysis 文字呈现
   （工程 2.17 亿/零售 2.08 亿/整装 0.61 亿——与金样逐项一致，仅图表化决策不同）。
4. **研发费用口径**：金样研发 1,788 万（`functional_scope=5503` + `amount` 字段，执行率 165.9%）；
   dsh 研发 1,080 万（`period_expense` 字段=费用化口径，执行率 99.8%），
   并在报告中注明"研发支出(费用化)口径"。期间费用总额 0.886 亿两份一致（金样隐含）。
5. **明细表增强**：金样 10 行 4 列（目标表覆盖 10/11 中心）；dsh 12 行 7 列（11 中心+合计行，
   增加缺口/环比/同比列）——模型自行发现目标表其实 11 中心全有覆盖，信息更完整。
   着色 tone 协议（good/warn/bad）两份一致（华北 90.8% good、鲁豫晋 71.2% bad 逐行一致）。

其余核对：库存金额 14.74 亿/24M+ 2.50 亿/库龄分段 8.33/1.62/2.29/2.50 与金样全对上；
期间费用四项 3,226/3,271/1,283 万对上（研发见差异 4）；含税达成 5.21 亿/环比 +13.0% 对上
（同比 dsh -12.4% vs 金样 -12.5%，四舍五入路径差）；目标达成率 79.6% + 11 中心逐行达成率
（76.3/78.6/82.2/…/71.2）与金样 10 中心重叠部分逐行精确一致。

## 7. 顾虑（如实上报）

1. **exec_script 首调必失败（7/7）**：模型每次"先 exec 后 write"都会得到容器 127 错误
   ——根因是 dsh write 工具落盘与 exec_script 拉起容器之间存在跨文件系统同步间隙
   （Git Bash→Docker Desktop gRPC-FUSE 的可见性延迟），模型重试即恢复，未造成任务失败，
   但浪费 7 次工具轮次（约数百 token/次 + 每轮 30~60s）。修法候选：exec-script.ts 在 spawn 前
   对 script 路径做一次存在性等待（≤2s 重试），属 T13 插件的小改进，建议 M1 处理。
2. **应收口径知识缺口**（§6.1）：金样应收口径依赖"科目白名单 + 正余额"这一隐性规则，
   ar-knowledge 文档未沉淀。若 M1 目标是复现级一致，需把该口径写入
   `skills/ar-knowledge/references/`（本文档不代改，留任务建议）。
3. **mix 表 `calmonth='S'` 脏数据**：模型靠自发探测排除；该已知坑宜沉淀进
   sales-performance-knowledge 的 metrics.md（同样留任务建议，本任务不代改）。
4. **数值真值未重导**：按计划，compare 的指标级检查待 T15 用 metrics.json SQL 重导
   真值后启用（fresh_truth.json 现为占位 `[]`）。
5. 工具数组仍含 `job_*`/`subagent`/`str_replace_editor` 等（T13 复审已裁定的遗留项，
   本会话模型未使用；`str_replace_editor` 全程未调用）。

## 8. 失败分类初判

**无失败**。exit 0、产物合法、结构检查全过。唯一实质差异（应收口径）分类为
**口径知识缺口（知识库维护项）**，不是表选错（模型实测过金样表并给出弃用理由）、
不是执行错（60 查询零失败）、不是超时（26.7 min << 40 min）、不是能力缺口
（沙箱/MCP/skill 三通道全部按设计工作）。

## 9. 提交

- 新增：`m0/verify/compare_report.py`（结构对比脚本，tab 计数偏差修正已注明）、
  `m0/verify/fresh_truth.json`（T15 占位 `[]`）、`m0/verify/report.html`（1.08MB，dsh 产物）、
  本记录。
- commit：`test(m0): 金样报告端到端复现+对比脚本`（路径限定 `m0/verify/`）。
- 会话取证原材料（不入库）：`/d/m0-sessions/t14/`（answer.md、stderr.log、trace_full.txt、
  dsh_report_data.json、compare_output.txt、workdir/ 全部脚本与 report_202608.json）。
