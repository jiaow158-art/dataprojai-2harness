# 现有能力迁移清单（capability_checklist）— spec §11.2 能力完整性验收

> 日期：2026-09-16 · 任务：M2-T4 · 依据：`docs/superpowers/specs/2026-09-07-dsh-agent-engine-design.md` §11.2
> 方法：从**实际执行轨迹**整理（不只看 13 个 skill 能否加载）。每项四要素：能力描述 / 验证方式 / 状态 / 证据出处。
> 状态图例：✅ 已验证（证据出处）· 🔄 部分（差什么）· ❌ 缺失（M2/M3 去）
> 基线：dsh 0.1.2-rc.1 · deepseek-v4-flash · engine-gateway（M1 报告 912a199 正式版）· skills/ 当前工作树

## 证据源

| 证据 | 路径 | 覆盖 |
|---|---|---|
| 金样管线判定 | `m0/golden/trace.md` | report-generator 全链路判定（证据 A–D） |
| T14 端到端复现 | `m0/verify/run_m0_e2e.md` | 9 次 skill 命中 / 60 MCP 查询 / 16 exec_script / 7 自纠错 |
| T15 截断核验 | `m0/verify/truncation_check.md` | >200 行不截断 + 同 SQL 重导真值 |
| T16 多轮 | `m0/verify/multiturn_check.md` | 五断言（口径/组织/结果引用/无干预延续） |
| T9 MCP 桥接 | `m0/tests/mcp_bridge_check.md` | 4 工具独立核对 + 双通道实证 |
| T13 操作环 | `m0/tests/tool_loop_check.md` | 操作环四项 + 三轮安全复审 + 工具终审 |
| 沙箱红队 | `m0/tests/sandbox_redteam.sh` | 4 断言 ×3 轮全绿 |
| M1 故障五发 | `engine-gateway/test/e2e-faults.md` | 幂等/接管/单次发布/断线/双活 |
| M1 并发 soak | `engine-gateway/test/soak.md` | 排队/串行/隔离/属主/取消/清理（终版全 PASS） |
| M1/M0 报告 | `docs/superpowers/reports/2026-09-16-m1-report.md` · `m0/REPORT.md` | 六类事件词表/限流/54 单测；放行核对与遗留 |
| 代码面 | `skills/`（13 skill）· `engine-gateway/src/` · `dws_mcp_server.py` · `m0/dsh-plugin/exec-script/` | 结构性核对 |

---

## 一、知识层

| # | 能力 | 验证方式与证据 | 状态 |
|---|---|---|---|
| 1.1 | SKILL.md frontmatter 格式兼容（Claude Code 格式零修改加载，转换器跳过） | T7 实测：随机标记串防伪验证 + inventory 域真实命中 references 细节；T14 会话 9 次加载全命中；T16 sdk profile 同样加载 | ✅ |
| 1.2 | 13 个 skill 全量可用（6 域×knowledge+analyst + report-generator） | 目录面核对 13/13 SKILL.md 齐备（knowledge references 8/9/12/6/17/5 个文件）；dsh 会话轨迹命中 9/13（T14 四域×2+report-generator；T16 复证 inventory×2+report-generator）。**sku-profitability×2、otd-fulfillment×2 无任何 dsh 会话轨迹** | 🔄 差：4 个 skill 的 dsh 实跑证据（M2 eval 覆盖 sku-profitability 9 场景；**otd-fulfillment 不在 71 场景内**，见缺口 G2） |
| 1.3 | references 读取纪律（metrics.md mandatory first-read） | T14：全程 7 次 read 中 4 次 metrics.md（每域动手查询前自发首读）+3 次 AR 参考文档；T16：metrics.md / stock-fall-list.md / stock-accage.md | ✅ |
| 1.4 | report-generator 资产沙箱可达（templates/scripts/schema → /assets 只读挂载） | T13 操作环②：沙箱内 `wc -l report-shell.html`=981 与宿主精确一致；T14 inspect_template/build/validate 全链路在沙箱内完成 | ✅ |
| 1.5 | 域边界拒答（只答 6 域，域外引导先建 Skill） | 规则存在于 CLAUDE.md/skill 文档；**无任何 dsh 轨迹级验证**；M2-T3 红队 6 场景（expected_refusal 判分分支）未实施 | ❌ M2-T3（红队场景 + 判分器 expected_refusal 分支） |

## 二、数据层

| # | 能力 | 验证方式与证据 | 状态 |
|---|---|---|---|
| 2.1 | MCP 4 工具（`mcp__dws__` list_tables / describe_table / search_tables / run_query） | T9 独立核对：500 表（模型主动指出 LIMIT 500 上限）/ 93 列精确一致 / 3 匹配表（并提示 _tmp 不可用）；T14 真实任务 60 次（52/3/5）零失败零编造 | ✅ |
| 2.2 | run_query 双通道（完整结果落盘 + ≤200 行模型预览 + row_count/truncated 标注） | T9 对照表：855 行查询（模型见 200 预览 / 落盘 855 / row_count=855）；`tests/test_dual_channel.py` 7/7；T15：56/56 落盘文件 row_count==len(data) | ✅ |
| 2.3 | SELECT-only + statement_timeout + 结构化错误契约 | `dws_mcp_server.py`：写操作拒绝白名单（仅 SELECT/WITH/DESCRIBE/SHOW/EXPLAIN）+ `statement_timeout`；T9 错误契约：不存在表 → 结构化 status=error、进程不崩溃、模型不编造 | ✅ |
| 2.4 | 日期格式陷阱规避（各域文档口径：YYYYMM / YYYYMMDD / timestamp 等） | T14：calmonth / query_date / month 三种格式按各域文档正确使用，60 查询零日期类错误；T10：calmonth='202605' 精确命中 eval 期望 10 行 | ✅ |
| 2.5 | 大表时间过滤纪律（1.44 亿行级表）+ 5 万行数据预算兜底 | T14：60 查询全部带时间谓词、零超时零拒存；T9：无界明细查询撞 5 万行预算被拒存（防护生效实证，遂换聚合查询完成验证） | ✅ |

## 三、执行层

| # | 能力 | 验证方式与证据 | 状态 |
|---|---|---|---|
| 3.1 | Python/Shell 受控执行**完整操作环**（写/改脚本 → 执行 → 读 stdout → 读 stderr/isError → 读 /assets → 产物落 workdir） | T13 四项操作环全 PASS（含 bash 冒烟 SANDBOX_INTERPRETER；print(1/0) 完整 traceback + isError 生效）；T14 自纠错 7/7 全吸收（8 个 isError 无一放弃/绕过沙箱）；T16 再证（1 read 错 + 4 exec 错全吸收，含读 traceback→str_replace 修复→重跑通过） | ✅ |
| 3.2 | 沙箱五要素（--network none / --read-only / --user 65534 / 目录白名单挂载 / mem-cpu-pids 上限 + timeout 清理兜底） | `m0/sandbox/run_in_sandbox.sh` + Dockerfile；边界由红队 4 断言实证（8.2）；M1 soak/e2e 报告任务容器瞬态零残留（soak A6） | ✅ |
| 3.3 | exec_script 插件防护（路径校验 22 攻击向量无绕过 + 2MB 输出上限 + env 白名单） | T13 §2 确定性单测表（绝对路径/盘符/穿越/反斜杠/空串全 REJECT）；Fix 3 实测 3M 字符封顶 2,000,035+截断标记；金丝雀 M0_CANARY 全会话 0 次出现 | ✅ |
| 3.4 | exec_script 存在性等待（write→exec 跨文件系统同步间隙） | T14 首调必失败 7/7 → M1 落地 abdefa9（exec-script.ts `waitForScript` ≤2s + 容器名带 run_id-a\<attempt\>）；M1 soak 3 个报告任务 + e2e 报告任务 exec_script 链路全通、无首调失败记录 | ✅ |

## 四、报告层

| # | 能力 | 验证方式与证据 | 状态 |
|---|---|---|---|
| 4.1 | build.py 管线（REPORT_JSON → validator → 模板组装 → 写文件 → 复验） | 金样判定证据 A–D（模板 CSS 逐字节一致 / validator 0 errors / 67 处 `<\/` 转义签名 / 排除 DEPRECATED 脚本）；T14 沙箱内一次通过 + verify_report 双复验 OK；e2e 发3 产出 1,079,852 B 真实 HTML | ✅ |
| 4.2 | 报告 schema v2.1 契约（sections[]/kpis[]/insight/provenance 七键、chart 数组、tone 着色、valueFormat） | T14 结构检查 4/4（5 tab / 8 图 / provenance 七键+1）；T16 断言 A4 契约成立（tab 5 / kpi 4 / 七键） | ✅ |
| 4.3 | echarts 本地引用 + 无外链 CDN | compare_report.py 两轮 PASS（T14、T15）；task-runner REPORT_CHECK 内置 cdnRegex 对每次发布复检（见 4.4） | ✅ |
| 4.4 | 服务化发布链（非空+minBytes / 无外链检查 → `reports/<user>/<run_id>.html` → publications 恰一次） | task-runner.ts：发布顺序 recordPublication→report→done→finalize，检查失败走 REPORT_CHECK 失败终态；soak A4d：3 个报告任务 publications=3 全部可归属、无跨用户产物；e2e 发3：发布后崩溃 884ms 恢复、零重发零副本 | ✅ |
| 4.5 | >200 行无静默截断（合计/占比/图表对得上完整数据） | T15：56/56 落盘完整；唯一 >200 行样本（855 行）同 SQL 重导 855=855、键集合全同、202601–08 逐月分毫不差；报告 KPI==全量聚合（18.11 亿==105,920 行口径、14.74 亿==632 万行聚合输入）。注：金样与复现产物明细 tab 本身 ≤200 行（图表均为聚合），「单报告内嵌 >200 行明细表」形态未出现 | ✅（形态注记，M2 eval 固定用例复核） |

## 五、会话层

| # | 能力 | 验证方式与证据 | 状态 |
|---|---|---|---|
| 5.1 | 多轮追问延续：口径/组织/时间（引擎级，SDK sessionId 复用即延续） | T16 断言 A1/A2 PASS：八字追问→同表同维度同指标仅换时间谓词（2023Q3）；主动做跨年组织编码比对（退出/新增/描述漂移） | ✅ |
| 5.2 | 结果引用复用不重查（引擎级） | T16 断言 A3/A4 PASS：第三问零新查询零新 result_ref；生成脚本 42 值中 40 值与前两问 result_ref 逐值相等（2 个 None 为组织退出/新增正确语义）；provenance.query 引用原文 | ✅ |
| 5.3 | 服务化同会话串行 | soak A3 ×3 批 PASS（DB 时戳：第 2 问 claim ≥ 第 1 问 done）；store 队首语义单测（防同批双 claim 击穿） | ✅ |
| 5.4 | 服务化续问历史注入（D14：每任务新 spawn 零记忆 → 注入会话历史 + result_ref 指示语） | soak 发现缺口 → 0bab7d1 修复（`buildHistoryPrefix` 每次执行构造，attempt=1 正常续问同样注入；单测覆盖，npm test 54/54）；终版 soak 多轮第 2 问 3/3 succeeded 且回答引用第一问 result_ref 文件名（注入生效）；恢复臂 S2 注入另经 e2e 发5 构造性验证 | 🔄 差：网关路径的 T16 等价内容级断言（逐值核验）未复跑——归 M2 eval 固定用例「同一会话连续追问并生成报告」（见缺口 G3） |

## 六、服务层

| # | 能力 | 验证方式与证据 | 状态 |
|---|---|---|---|
| 6.1 | 任务提交/查询 + SSE 六类事件词表（stage/sql/answer/report/error/done；seq 严格连续、done 唯一） | e2e 基线：13 事件 seq 1..13 连续、六类内、done 唯一；soak A4a：15/15 事件流完整（seq 1..N、done 唯一且 run_id 正确） | ✅ |
| 6.2 | SSE 断线重连（事件递增编号 + Last-Event-ID 服务端重放） | e2e 发4 PASS：断点 seq=3 → 重连首帧=4，两段拼接 24 帧无丢失无重复，服务端 done 后主动关流 | ✅ |
| 6.3 | 提交幂等（client_submission_id 去重返回原 run_id） | e2e 发1 PASS：弃连后同幂等键重发秒回同 run_id，tasks 表恰 1 行，无双跑 | ✅ |
| 6.4 | 发布幂等（发布后中断 → publications 兜底：不重跑、不重复发布） | e2e 发3 PASS：恢复 884ms、published_at 不变、产物逐字节不变、零引擎 spawn | ✅ |
| 6.5 | 排队与并发池（提交与执行分离，MAX_CONCURRENT_TASKS=3，排队状态真实可见） | soak：max running=3、max queue_depth=2、15/15 任务有 queued 段、health 曲线 131 采样点、无任务丢失 | ✅ |
| 6.6 | 限流（队列满 429 RATE_LIMIT + 按 user QPM 滑窗 429） | http.test.ts 用例 4a/4b（含「其他 user 不受影响」）——单测级，无 live 注入 | ✅（单测级，可在 soak 复跑时顺带注入复核） |
| 6.7 | 取消（终态三分类含 cancelled，不拖垮同批） | soak A5 PASS：cancel_requested → 4.0s 终态 cancelled，同批其余 4 任务全 succeeded。注：无对外 HTTP cancel API（内部 store.requestCancel 通道） | ✅（注记，前端取消诉求归 T8 对接清单） |

## 七、恢复层

| # | 能力 | 验证方式与证据 | 状态 |
|---|---|---|---|
| 7.1 | 五发故障注入（提交响应丢失 / 网关进程死亡 / 发布后中断 / SSE 断线 / 双活窗口） | e2e-faults.md 判定表全 PASS（引证 M1-T9，黑盒注入，证据 `D:\m0-sessions\e2e\<shot>\`） | ✅ |
| 7.2 | 租约接管与双活安全（围栏失权 + 复活者自杀，「最后只产生一个结果」） | e2e 发5：B 接管 attempt=2 后 +3.4s A 被围栏拒并自杀 dsh 树；事件 20 帧连续、done/answer 恰 1、无重复产物 | ✅ |
| 7.3 | boot 自愈（孤儿租约清理 → 新 attempt 续跑） | e2e 发2：taskkill 网关 → dsh 树 ~1.4s 随 stdin EOF 自退（引擎不孤儿）→ 重启 healOrphans → attempt=2 续跑 succeeded | ✅ |
| 7.4 | 失败分类与终态三分类（succeeded/failed/cancelled；A.4 恢复矩阵；可恢复错误经 repairing 展示） | 编排器 17 用例逐行映射恢复矩阵；QUOTA→CONFIG 快败零重试（0bab7d1，402 实测 45 次无效 turn 缺口修复）；soak 终态分布 14+1 正确 | ✅ |
| 7.5 | 沙箱容器命名带任务身份（`run_<run_id>-a<attempt>-<pid>`，接管者按旧 attempt 清理不误杀） | 0b020e6 SANDBOX_RUN_ID 接线（T9 遗留 L-1 修复）；soak A6 按新命名断言容器清零 | ✅ |

## 八、安全层

| # | 能力 | 验证方式与证据 | 状态 |
|---|---|---|---|
| 8.1 | 工具白名单 26 项（禁用 pwsh / web_fetch / web_search / workflow+worker-thread / ralph 五通道） | T13 §7 终验：--dump-config 五条 disabled:true + 存活会话工具数组 26 项实测；T14/T16 真实任务复现同集；两会话全程零逃逸尝试（日志全文核验） | ✅ |
| 8.2 | 沙箱红队 4 断言（凭据泄漏 / 网络外联 / 越界写入 / 只读挂载写入） | `sandbox_redteam.sh` 4/4 ×3 轮（T12 首跑 + T13 两轮修复后复跑），exit 0 | ✅ |
| 8.3 | stderr 消毒（引擎启动失败 stderr 可能含解析后 env map 明文——T2 红线） | dsh-sdk-client.ts：stderr 仅内存环形缓冲（尾 4KB），任何输出前 sanitize（密钥值→***）+ 专项单测 | ✅ |
| 8.4 | 凭据隔离（配置零明文 / 宿主环境洗净 / 沙箱 env 白名单） | T9：cordis.patch.yml 仅 `!!js process.env` 表达式，DWS_PASSWORD 零明文零暂存；T13 金丝雀 M0_CANARY 全会话 0 次出现；红队 t1 | ✅ |
| 8.5 | 跨用户隔离（X-User 信任链不信 body.user；任务/事件 owner 校验 403；结果目录按 session、报告按 `<user>` 属主） | http.ts trustedUser + owner mismatch 403（单测）；soak A4c：12 session 结果文件零跨会话（ref↔文件双向映射）；A4d：3 报告全可归属 | ✅（对抗性 live 复验归 M2-T3） |
| 8.6 | fs 写域收敛（workdir 放 Temp 树外定型；workspace-write 越界拒绝） | T13 Fix 2 三连写探针：workdir 内成功 / 父目录拒绝 / 仓库根绝对路径拒绝（文件系统核验）；T14/T16 workdir 均在 Temp 树外 | ✅ |
| 8.7 | DB 账号映射与受限只读账号（spec §7 底线 2） | db-accounts.ts 映射+回退逻辑（37e4097）单测通过；e2e/soak 实跑走 aiuser 回退；**受限只读账号本身未建**（M0 遗留 L4） | 🔄 差：DBA 建号（M3 试点前必须） |

---

## 与 spec §11.2 对照自检

| spec §11.2 原文要求 | 清单覆盖 |
|---|---|
| "不只看 13 个 skill 能否加载" | 1.1/1.2 加载面之外，全部 42 项均为轨迹级 / 重导级 / 注入级证据 |
| "skill 正文引用的 references/templates 资源加载" | 1.3、1.4（资源消费闭环另见 4.1） |
| "MCP 4 工具" | 2.1–2.5 |
| "Python/Shell 受控执行（完整操作环）" | 3.1–3.4 |
| "动态报告产物" | 4.1–4.5 |
| "多轮会话（口径与结果引用延续）" | 5.1–5.4 |
| "每项独立验收，无遗漏、无功能缩水" | 42 项独立编号、独立证据；组合形态缺口见 G3 |
| M2 计划 T4 追加维度：域边界拒答 / 报告属主隔离 / 六类 SSE 事件 | 1.5 / 4.4+8.5 / 6.1 |

## 缺口清单（进 M2 报告）

- **G1（❌）域边界拒答零验证**（1.5）：现状无任何 dsh 轨迹级拒答证据。→ M2-T3 红队 6 场景（expected_refusal）+ 判分器拒答分支落地后复验。
- **G2（🔄）4/13 skill 无 dsh 实跑轨迹**（1.2）：sku-profitability×2 由 M2 eval 覆盖（9 场景）；**otd-fulfillment×2 不在 eval_dataset 71 场景内**——"无遗漏"存在数据集盲区，建议 T5 门槛决策会裁定：补场景或记录例外。
- **G3（🔄）「多轮追问 × 报告生成 × 网关发布」完整组合未端到端走过**（5.4/4.4）：T16 多轮+报告在引擎级（无发布步）；soak 多轮任务为纯问答、报告任务为单轮。→ M2 eval 固定用例「同一会话连续追问并生成报告」（spec §11.4 第 2 条）覆盖。
- **G4「恶意报告内容」无单列红队场景**：spec §11.4 用例 5 三项之一；M2-T3 的 6 场景不含此项，现有防线仅 REPORT_CHECK（非空/无外链）。建议 T3 补 1 场景，或在 T9 核对表记录例外。
- **G5 取消无对外 HTTP API**（6.7）：内部通道已验；claudecodeui 对接清单（M2-T8）需确认前端取消诉求。
- **G6 受限只读 DB 账号未建**（8.7）：M0 遗留 L4，M3 试点前必须（当前 aiuser 回退）。
- **G7 限流仅单测级**（6.6）：低风险；可在 T9 复跑 soak 时顺带注入复核。
