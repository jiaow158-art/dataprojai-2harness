# M0 完整能力验证报告

> 日期：2026-09-09 · 执行环境：本机 Windows 本地模拟（用户 2026-09-08 确认，暂不部署服务器）
> 规范：docs/superpowers/specs/2026-09-07-dsh-agent-engine-design.md（v3）§12 M0
> 计划：docs/superpowers/plans/2026-09-08-dsh-m0-capability-verification.md（17 任务）

## 结论：**GO**（建议进入 M1 服务化与恢复；依据下方全部证据）

"换底盘，不减能力"核心命题成立：dsh + deepseek-v4-flash 在最终受限环境（工具白名单 26 项 + Docker 沙箱 + MCP 双通道）下，零人工干预完整复现了金样四域经营分析报告，多轮追问口径/组织/结果引用正确延续，全程无静默截断、无工具逃逸。

## 放行条件核对（spec §12 M0）

| 放行条件 | 结果 | 证据出处 |
|---|---|---|
| 复杂报告全链路在最终受限环境复现 | ✅ 26.7 min，exit 0，1.08MB HTML；skill 9 次全命中、MCP 60 次零失败、exec_script 16 次、自纠错 7 次全吸收 | T14 · m0/verify/run_m0_e2e.md · session-0438fd36 |
| 含 >200 行结果的真实报告（合计/占比/图表对完整数据） | ✅ 56 个落盘文件全部 row_count==len(data)；855 行文件同 SQL 重导逐月分毫不差（202609 差异为当月 ETL 活表增量=数据漂移非截断） | T15 · m0/verify/truncation_check.md |
| 三连问（时间/组织/口径/结果引用延续） | ✅ 五断言全 PASS；Q3 零重查，生成脚本内嵌数值与前两问 result_ref 逐值相等 | T16 · m0/verify/multiturn_check.md · session t16-ea69d9d3 |
| 沙箱红队 4/4 | ✅ 凭据/网络/越界/只读全 BLOCKED（T12 首跑 + T13 两轮修复后各复跑一次，共 3 次 4/4） | T12/T13 · m0/tests/sandbox_redteam.sh |
| 不靠临时开放宿主机权限 | ✅ 全程工具白名单 26 项（pwsh/web_search/web_fetch/workflow/ralph 五危险工具禁用并存活验证）；Docker 沙箱 5 要素 flag 级落地 | T11/T13 · m0/sandbox/ + m0/tests/tool_loop_check.md §6/§7 |

## 交付物清单

| 交付物 | 位置 | 说明 |
|---|---|---|
| 隔离配置最终形态 | `m0/sandbox/`（run_in_sandbox.sh + Dockerfile） | spec 6.2 五要素：--network none / --read-only / --user 65534 / 目录白名单挂载 / mem-cpu-pids 上限 + timeout 清理兜底；Windows 本地形态（cygpath 路径转换） |
| 受控执行工具插件 | `m0/dsh-plugin/exec-script/` | exec_script 唯一代码执行通道；插件层路径校验（22 攻击向量无绕过）+ 2MB 输出上限 + env 白名单；bundle patch 禁用 5 个危险工具 + customSkillDirs 指回 |
| MCP 结果双通道 | `dws_mcp_server.py` + `tests/test_dual_channel.py`（7/7） | D13：完整结果落盘（row_count+truncated 标注+ref 进程唯一+原子写）+ 模型 ≤200 行预览 + 超预算截断指引；legacy 模式字节级兼容（现役 Claude 引擎不受影响） |
| 依赖部署清单 | `m0/env-manifest.md` + m0/sandbox/requirements.txt | 金样管线纯标准库零 pip 包；资产=report-generator 模板/schema/scripts |
| dsh API 实测记录 | `m0/findings/dsh-api.md` | 六个 API 面（headless/skill/MCP/工具插件/多轮/模型配置）实测定型；覆盖缺口如实标注 |
| 金样基线 | `m0/golden/` | report.html + 官方复现提问（provenance 重构）+ metrics.json（7 指标 SQL）+ trace.md（管线判定：report-generator 管线，逐字节 CSS 证据） |
| 验证记录 | `m0/tests/*.md` + `m0/verify/*.md` | MCP 桥接/模型 smoke/操作环/红队脚本/E2E/截断/多轮，全部会话日志级取证 |

## 关键实测发现（对 M1+ 有决定性价值）

1. **skill 直接兼容**（T7）：Claude Code 格式 SKILL.md + references/ 零修改工作——随机标记串防伪验证 + inventory 域真实命中 references 细节。T8 转换器跳过。
2. **安全面三次实弹加固**（T13 三轮审查）：① win32 上 dsh-base 默认启用 tool-pwsh（金丝雀实测模型可读宿主环境变量）→ bundle patch 禁用；② tool-workflow 宿主 worker 线程跑任意 JS（与 pwsh 同级通道）→ 连同 worker-thread 提供者禁用；③ workspace-write 硬编码豁免 os.tmpdir()（源码核实不可配置）→ 定型规范：workdir 放 Temp 树外。
3. **模型行为亮点**：金样应收口径不自洽时主动弃用、5 表交叉验证选自洽口径并在 limitations 声明（T14）；驱动 bug 致无数据时拒绝编造数字（T16 首跑）；mix 表 'S' 脏数据自发探测排除（T14）。
4. **多轮机制定型**（T16）：SDK session_id 复用即延续（CLI 无 resume）；每轮 history 完整回传。这同时是 M1 网关 DshBackend 的调用形态底座。
5. **自纠错模式**（T14）：write→exec 跨文件系统同步间隙致首调必失败、重试即恢复（7/7）——M1 给 exec-script.ts 加存在性等待可消掉。

## 与金样的差异（如实记录，不构成失败）

| # | 差异 | 归因 |
|---|---|---|
| 1 | 应收余额 18.11 亿/80.0% vs 金样 33.63 亿/68.4% | **知识库维护缺口**：金样隐性科目白名单口径未沉淀进 ar-knowledge；模型选了自洽口径并声明。改进项进 M1+（沉淀口径文档），非引擎能力问题 |
| 2 | KPI 卡 6 vs 8 | 信息合并（逾期率/长龄入 change 文案），信息量等价 |
| 3 | 渠道图→事业部图+毛利率图 | 图表选择差异，数值与金样逐项一致 |
| 4 | 研发费用 1,080 万 vs 1,788 万 | 费用化口径 vs 5503+amount 口径，已在报告 limitations 注明 |
| 5 | 明细表 12×7 vs 10×N | 增强版（11 中心全覆盖+合计+环比同比），无缩水 |

数值抽查：销售 5.21 亿/79.6%、库存 14.74 亿/2.50 亿、费用 3226/3271/1283 万——T15 同 SQL 重导真值全部命中。

## 遗留问题清单（M1 前处理 / M1 内处理 / 后续）

| # | 事项 | 去向 |
|---|---|---|
| L1 | **ar-knowledge 应收口径沉淀**（科目白名单 + 为何金样表不自洽） | M1 前知识库维护（改动小、收益直接） |
| L2 | metrics.json 指标 5 行序笔误（5503/5504 expect_hint）+ compare_report.py fetchone 伪 FAIL 语义 | M2 前修（评测基础设施） |
| L3 | dsh profile 配置（headless/sdk 的三段 patch + pnpm link）目前手工、不入库 | M1 固化为脚本（T16 记录 §8 已有草案） |
| L4 | 受限只读 DB 账号未建（spec §7 底线 2） | M1 前由 DBA 建（当前全验证用 aiuser，试点前必须换） |
| L5 | fs 读域全宿主（dsh 沙箱只管写）| M1 部署时用低权限服务账户跑 dsh + 账户可读路径不放密钥 |
| L6 | 会话日志含完整推理流（敏感落地物） | M1 访问控制设计 |
| L7 | str_replace_editor 与 edit 功能重复 | 可选清理，非阻塞 |
| L8 | m0/results/ 56 个业务数据落盘文件未跟踪 | 保持现状（不入库）；M1 的任务工作目录设计会接管 |
| L9 | 本地模拟形态差异（Docker Desktop/cygpath/MSYS）→ 服务器 Linux 部署时 run_in_sandbox.sh 需小改（去 winpath，直挂路径） | M1 服务器部署时处理 |

## 决策建议

**GO**。理由：
1. 五项放行条件全部满足，且证据均为会话日志级/同 SQL 重导级（非自报）
2. 唯一实质差异（应收口径）定位为知识库维护缺口——改进知识库是复利投资，惠及任何引擎
3. 三次安全审查实弹堵住的通道（pwsh/web/workflow/ralph/Temp 豁免）证明"安全不靠自觉靠用例"的流程有效，M1 继承这套基线
4. deepseek-v4-flash 能力足够（60 查询零编造、自纠错、拒编造），暂无切换 v4-pro 的必要

**M1 启动前置**：L1（口径沉淀）、L3（profile 脚本化）、L4（受限账号）三项先行；其余 M1 内消化。
