# DeepSeek Harness（dsh）引擎接入设计

> 日期：2026-09-07
> 状态：已与用户逐节确认
> 阶段：第一阶段（适配 + 服务化上线）

---

## 1. 背景与动机

当前问数系统的 agent 引擎是 Claude Code（claudecodeui 后台 headless 调用）。DeepSeek Harness（`dsh`）已开源（MIT，Cordis 插件体系：工具/命令/skill/hook/MCP/模型皆插件，官方支持 Web UI / Headless / SDK 场景）。以 dsh 取代 Claude 的动机（用户确认，四条全选）：

1. **数据主权/私有化** —— 阶段一先用 DeepSeek API，自托管权重留作演进（dsh 模型适配器可插拔）
2. **成本压力** —— DeepSeek API 成本远低于 Claude
3. **供应商锁定** —— Claude 彻底退出运行时；且架构要允许"将来别的引擎再取代 dsh"
4. **产品化** —— 系统要散发给外部用户使用，闭源引擎 + 每客户 Anthropic API 依赖不可交付

**关键认知**：本项目最值钱的资产（Layer 2 语义层 + Layer 3 Skills + Layer 4 Eval + MCP server）本就是模型无关的 markdown/Python。换引擎是"换底盘"，不是重做系统。

## 2. 目标与非目标

### 目标（第一阶段交付物）

- skills 适配 dsh，接通 MCP，agent 级 eval 跑通 66 场景并产出差距报告
- headless 服务层（engine-gateway），claudecodeui 后端切换调用，端到端跑通
- 面向用户开放的安全模型与数据权限模型落地
- 试点用户在 dsh 引擎上正常问数

### 非目标（明确排除）

- 自托管 DeepSeek 权重（vLLM/SGLang 部署）—— 留待后续，仅保证一行配置可切
- 多租户/授权计费等产品化基础设施 —— 阶段二
- 修改 skill 的知识内容（metrics.md、决策树、陷阱库一字不改，只适配加载机制）
- 保留 Claude 作为生产备用引擎 —— **Claude 彻底退出线上运行时**，仅以试点期回滚开关形式短暂存在

## 3. 关键决策记录

| 决策点 | 结论 | 理由 |
|---|---|---|
| 方案选型 | 网关 + 可插拔 BackendProvider，单一 DshBackend（原方案 A 修订版） | 唯一同时满足"去 Claude 化"与"未来引擎可再替换"的形态 |
| Claude 的居所 | 只存在于开发环境（Claude Code 用于开发维护本系统），不进运行时 | 用户明确：dsh 是取代，不是并列 |
| 跨引擎兜底 | 不做。dsh 失败 = 同引擎重试 1 次 + 明确报错 | 去 Claude 化的必然代价，用户知情接受 |
| 模型部署 | 阶段一 DeepSeek 官方 API | 不动 GPU 基建，最快见效 |
| eval 门槛 | 先测了再定（M2 决策会依据失败分类定门槛） | 用户明确选择 |
| eval 判分方式 | 绝对判分（对 eval_dataset.json 期望行数），不需要 Claude 参与基线 | 期望结果已录制在数据集里 |
| 权限维度 | 四维全选（职级/公司/数据域/事业部），收敛为有限权限组 | 组合复杂度留在 claudecodeui 映射表，网关与 MCP 只认权限组 |

## 4. 总体架构

```
┌─────────────────────────┐
│  claudecodeui (Web层)    │  现有，仅小改：调用地址换成网关
│  /opt/claudecodeui      │  （用户认证的唯一入口）
└───────────┬─────────────┘
            │ HTTP + SSE（内网，Bearer token + user + scope_group）
            ▼
┌─────────────────────────────────────────────┐
│  engine-gateway（新，Node/TypeScript）        │
│  统一问数 API · 会话管理 · 限流超时 · 重试      │
│  · 审计日志 · 身份透传                        │
│  ┌─────────────────────────────────────┐    │
│  │ BackendProvider 接口（可插拔契约）      │    │
│  │   ▲ 实现                             │    │
│  │   └─ DshBackend（当前唯一引擎）        │    │
│  │      dsh headless + DeepSeek-V4 API  │    │
│  └─────────────────────────────────────┘    │
└─────────────────────────────────────────────┘
            │ MCP stdio（dsh-mcp-client 桥接）
            ▼
   dws_mcp_server.py（复用，按权限组选 DB 账号）
            │
            ▼
   DWS GaussDB（RLS 按权限组过滤行）
```

**换引擎的承接点**：`BackendProvider` 接口 + 第 5 节的 6 种规范 SSE 事件是稳定契约。将来新引擎 = 新写一个 BackendProvider 实现 + 改一行注册配置，Web 层与 API 协议零改动。

### 单元职责边界

| 单元 | 做什么 | 不做什么 |
|---|---|---|
| engine-gateway | 收问题→选引擎→流式转发→限流/超时/重试/审计 | 不解析业务语义、不碰 SQL |
| DshBackend | dsh 会话管理、原生事件→规范事件归一化、超时取消 | 不 fork dsh，只用官方扩展点 |
| dws_mcp_server.py | 4 个只读工具 + 按权限组选 DB 凭据 | 不做 SQL 改写 |
| run_agent_eval.py | 经网关跑 66 场景、抓 SQL、验行数、失败分类 | 不直接调引擎（与线上同路径） |

### 仓库布局（建在本仓库，不另起炉灶）

```
dataprojai-2harness/
├── engine-gateway/          # 新：网关服务（Node/TS）
│   └── src/
│       ├── backends/dsh/      # DshBackend + 事件归一化
│       └── ...                # 路由/限流/审计
├── run_agent_eval.py        # 新：agent 级 eval runner（复用 run_eval.py 验证逻辑）
├── skills/                  # 现有 13 个 skill，单一样本源
├── dws_mcp_server.py        # 原样复用（新增 SCOPE_GROUP 参数）
└── run_eval.py              # 保留（SQL 级回归）
```

skills 单一样本源是命脉：两引擎共享同一份知识库（将来多引擎同理），eval 对比才公平。产品化独立仓是阶段二的事。

## 5. engine-gateway API 设计

### 端点（刻意最小）

| 端点 | 用途 |
|---|---|
| `POST /api/query` | 问数主入口，SSE 流式返回 |
| `GET /api/health` | 存活探查 |

### 请求

```json
POST /api/query
Authorization: Bearer <内网token>
{
  "question": "2024年Q3瓷砖事业部库存跌价TOP10",
  "session_id": "可选，多轮追问时传",
  "user": "zhangsan",
  "scope_group": "tile-fin-manager"
}
```

`scope_group` 由 claudecodeui 依据其用户-权限组映射表解析后传入（四维 scope 的组合运算在 claudecodeui 完成，见第 7 节）；网关不解析、只透传并落审计日志。

### SSE 规范事件（稳定契约，任何引擎都映射到这 6 种）

```
event: step     → {"text": "读取 inventory-knowledge 技能..."}     进度类
event: sql      → {"sql": "SELECT...", "rows": 42, "elapsed_ms": 1200}
event: answer   → {"markdown": "## 结论..."}                      最终结论
event: report   → {"path": "reports/{user}/xxx.html"}             仅生成报告时
event: error    → {"code": "TIMEOUT|ENGINE_ERROR|CONFIG|RATE_LIMIT", "message": "..."}
event: done     → {"engine": "dsh", "elapsed_ms": 45000, "tokens": {...}}
```

### BackendProvider 接口

```typescript
interface BackendProvider {
  id: string;                          // "dsh" / 将来的任意引擎
  createSession(opts): Promise<EngineSession>;
}
interface EngineSession {
  ask(question: string): AsyncIterable<RawEvent>;  // 引擎原生事件流
  cancel(): Promise<void>;
}
// 注册处：registry.register(new DshBackend(env.dsh))
```

### 配置（env，不进代码）

```
GATEWAY_PORT / AUTH_TOKEN
DSH_API_KEY            # DeepSeek API 密钥
DSH_MODEL=deepseek-v4
DSH_BASE_URL           # 将来自托管时指向 vLLM，其余不动
SKILLS_DIR=../skills
QUERY_TIMEOUT_S=300
MAX_RETRY=1            # 同引擎重试一次，不跨引擎
RATE_LIMIT_QPM         # 按 user 的每分钟提问数上限
RATE_LIMIT_CONCURRENCY # 按 user 的并发会话数上限
```

### 错误处理

| 故障 | 网关行为 |
|---|---|
| DeepSeek API 网络/5xx | 同引擎重试 1 次（新会话）→ 仍失败发 `error` 事件 |
| 单问超时（默认 300s） | cancel 会话 + 进程级兜底 kill → `error: TIMEOUT` |
| API key 无效/配额尽 | 不重试，`error: CONFIG`，日志高亮 |
| DWS 查询报错 | 不归网关管——agent 经 MCP 看到报错自纠（与今天行为一致） |
| 引擎进程死亡 | 网关捕获、重建会话，自身不崩 |

### 报告产物

report-generator 生成的 HTML 写入 `reports/{user}/`（按用户隔离），`report` 事件给相对路径，claudecodeui 静态托管时校验属主 + 加 CSP。

## 6. 面向用户开放的安全模型

### 核心原则：给引擎"去四肢"，而不是"关笼子"

问数 agent 合法需要的全部能力：

| 需要的能力 | 对应工具 |
|---|---|
| 读领域知识 | skill 插件（只读 skills/） |
| 查数 | MCP 4 工具：run_query / list_tables / describe_table / search_tables |
| 产出报告 | 写 reports/{user}/（唯一可写位置） |

**除此之外一概不加载**：不注册文件系统、shell/命令执行、网络访问插件。dsh 工具是插件制——不加载就是不存在，不是"有权限但禁止"。用户提问注入"读 .mcp.json"——引擎手里没有任何能读任意文件的工具，注入无从生效。

### 威胁 → 对策

| 威胁 | 对策 |
|---|---|
| 诱导 agent 读文件/执行命令 | 工具白名单（无 fs/shell 插件） |
| 诱导拿 DWS 凭据 | 密码只在 MCP server 进程 env；run_query 强制 SELECT-only + LIMIT 200 + statement_timeout |
| 恶意问题打爆资源 | 网关按 user 限流：并发会话数 + 每分钟提问数 + 单问 300s 超时 |
| 提示注入篡改行为边界 | 域边界规则（skill 内置）+ 无可用越权工具兜底 |
| 报告 HTML 藏脚本 | reports/ 静态托管加 CSP，ECharts 本地引用是模板约定 |
| 出事无法追责 | 审计日志：user / question / 引擎 / 全部 SQL / 耗时 / token |

### 身份与信任链

```
用户 ──登录──▶ claudecodeui（用户认证唯一入口，现有机制）
                    │ 内网转发：Bearer 网关token + user + scope_group
                    ▼
              engine-gateway（信任转发身份，按 user 限流/审计）
                    │ 受限工具集
                    ▼
              dsh 会话（无 fs、无 shell，只有 4 个 MCP 工具 + 只读知识）
```

网关不重复做用户认证（单一事实源在 claudecodeui），但执行授权后管制：限流、审计、超时。

### 会话隔离

每个用户会话 = 独立 dsh 进程/会话实例，cwd 指向各自临时沙箱（空目录 + skills 只读链接 + `reports/{user}/` 可写）。用户间进程级互不可见。

## 7. 数据权限模型

### 威胁现状

单一 `aiuser` 数据库账号 = 任何登录用户拿到全库可见性，开放给用户前必须补上。

### 设计原则：权限在数据库层硬执行，agent 只是"不知情的执行者"

| 层 | 机制 | 性质 |
|---|---|---|
| DB 层（硬边界） | GaussDB RLS：事实表按 node_desc* 过滤，权限组→独立 DB 账号 | 提示注入、SQL 花活都绕不过 |
| MCP 层（凭据选择） | dws_mcp_server 按权限组选 DB 账号 | agent 无法通过 SQL 改变 DB 身份 |
| Agent 层（软体验） | 会话上下文告知可见范围，避免"神秘为零" | 仅 UX，不承担安全责任 |

### 已否决的替代方案

- 提示词写"你只能查X" —— 提示注入一句破，只配当 UX 层
- MCP 改写 SQL 注入 WHERE —— 可靠改写任意 LLM 生成 SQL（CTE/子查询/别名）太脆
- 会话变量（GUC）传权限范围 —— agent 能在 SELECT 里调 `set_config()` 越权，存在真实绕过路径
- **选定：权限组 → 独立 DB 账号 + RLS 按 current_user 映射** —— SQL 层无法伪造身份

### 复合权限 → 有限权限组（防组合爆炸）

权限按四个维度定义（rank / company / domains / org），由 claudecodeui 的用户-权限组映射表把四维组合解析为有限权限组（预计 8~15 个，如"瓷砖-财务-经理组"），每组 ↔ 一个 DB 账号 + 一套 RLS 策略。组合复杂度留在 claudecodeui（其本职），API 上只传 `scope_group`，网关与 MCP 只认权限组。

### 落地链路

```
claudecodeui 认证 ──▶ user + scope_group（由用户-权限组映射表解析）
   ▼ gateway 透传 scope_group，写审计日志
   ▼ DshBackend → MCP 启动参数 SCOPE_GROUP
   ▼ dws_mcp_server.py：组→DB 凭据映射（aiuser_tile_fin / aiuser_bath / aiuser_group…）
   ▼ GaussDB RLS：事实表 policy 按 node_desc 过滤该账号可见行
```

### 分阶段节奏（不阻塞上线）

- **第一天就做**：身份线程贯穿（user/scope_group → SCOPE_GROUP → DB 账号）+ 审计日志——架构地埋线，后补动骨
- **试点期可接受**：先 1~2 个权限组，RLS 策略随后逐域收紧，架构不变

### 开放验证项

GaussDB(DWS) 对 RLS 的支持需实测验证（华为云有行级安全特性，版本需确认）。不可用时的等价退化：按权限组建**过滤视图**，只授权视图不给基表。

## 8. DshBackend 适配细节

### 8.1 Skill 格式兼容 —— 第一个实施动作是 spike，不是开发

现有 13 个 skill 为 Claude Code 格式（SKILL.md frontmatter + body + references/ + templates/）。dsh skill 是 Cordis 插件，格式细节需实测：

| spike 结果 | 应对 |
|---|---|
| 直接读 SKILL.md 格式 | 零成本，skills/ 保持单一样本源 |
| 格式小差异（frontmatter 字段名等） | 转换脚本 `skills/ → build/dsh-skills/`，CI 跑，源头一份 |
| 插件 API 完全不同 | 只适配加载机制，skill 正文内容一字不改 |

### 8.2 MCP 桥接

- `dsh-mcp-client` 以 stdio 拉起 `dws_mcp_server.py`，每用户会话一个 MCP 进程
- env 注入 DWS 凭据；`SCOPE_GROUP` 参数触发组→DB 账号映射
- 修复现状：本仓库 .mcp.json 的 args 指向旧目录 `D:\dataprojai\dws_mcp_server.py` 的绝对路径，改为仓库内相对引用
- 4 工具原样暴露

### 8.3 模型接入

```
DSH_MODEL_ADAPTER=deepseek-api
DSH_API_KEY=<env>
DSH_MODEL=deepseek-v4
# 自托管演进：DSH_BASE_URL=http://vllm内网地址:8000  ← 只改这一行
```

### 8.4 工具白名单落地

dsh 插件注册配置只加载：skill 插件（skills/ 只读）+ MCP 桥接（4 工具）。不注册 fs / shell / 网络插件。白名单配置进版本库受审，是第 6 节安全模型的物理载体。

### 8.5 会话与事件归一化

- 每问独立 dsh 会话，cwd = 临时沙箱
- dsh 原生事件 → 6 种规范事件，映射集中在 DshBackend 一处
- 网关超时调 `cancel()`，进程级兜底 kill

### 8.6 知识路由不受影响

域边界规则（只答 6 个已覆盖域）写在 Knowledge skill 内容里，随 skill 原样迁移——引擎换了，纪律不换。

## 9. Agent 级 Eval

### 现状缺口

`run_eval.py` 只重放录制 SQL 验行数，不跑 agent。引擎对比需要"自然语言 → agent → SQL → 验证"，需新建 `run_agent_eval.py`。

### 流程

```
66 场景 ──▶ 经网关 /api/query（与线上同路径）──▶ 捕获事件流
──▶ 抽取 SQL + answer ──▶ ① SQL 可执行 ② 行数符合期望
──▶ 失败自动分类 ──▶ 按域通过率 + 失败模式分布（JSON+Markdown 报告）
```

工程细节：并发限制 2~3 路；按场景 ID 缓存支持断点续跑；支持按域过滤（对齐 run_eval.py 用法）；记录每场景耗时/token 作为成本测算输入。

### 失败分类法

| 类别 | 判定 |
|---|---|
| 表选错 | SQL 执行成功但查错表 |
| 口径错 | 表对但过滤条件/口径不符（行数不符主因） |
| 执行错 | SQL 语法/权限报错 |
| 日期格式错 | 已知陷阱类（YYYYMM vs YYYY-MM-DD 等），单列统计 |
| 超时 | 300s 未完成 |
| 域外误答 | 该拒答的域外问题答了（安全回归） |

分类价值：表选错/口径错多 → 加固 references 与决策树（知识库改进，任何引擎受益）；纯能力差距 → 引擎问题。这就是 M2 门槛决策会的决策依据。

## 10. 测试策略

| 层级 | 内容 |
|---|---|
| 单元 | 网关事件归一化、scope→权限组映射、SQL 抽取 |
| 集成 | dsh 加载真实 skill + 调 MCP 查数 + 报告写入沙箱 |
| E2E 金样 | 每域 1 问，走完整链路（claudecodeui→网关→dsh→DWS） |
| 红队场景集 | eval_dataset 新增对抗场景（"读服务器配置"/"执行rm"/"查权限外数据"），断言全被拒/被 RLS 挡。安全不靠自觉，靠用例证明 |
| 并发冒烟 | 5~10 并发用户提问 |

## 11. 上线节奏与决策门

```
M0 spike      dsh hello-world（skill加载+MCP调用）──────▶ 格式兼容 go/no-go
M1 网关MVP    DshBackend 跑通，每域 1 问 E2E 金样
M2 评测       run_agent_eval 66 场景 ──▶ 差距报告 ──▶ 门槛决策会（先测了再定）
M3 试点       claudecodeui 切网关，1~2 个权限组真实用户
M4 收紧       RLS 逐域上线、扩权限组、正式开放
```

- M2 不达标不是失败：按失败分类加固知识库后重测（知识改进是复利）
- 试点期回滚杠杆：claudecodeui 保留旧调用路径的配置开关直至试点稳定，之后删除——Claude 只以回滚开关形式存在于过渡期，试点结束彻底退场

## 12. 项目验收标准

1. E2E 金样在 dsh 上全绿
2. 66 场景差距报告产出，门槛决策有书面记录
3. 红队场景集全部通过（无工具可越权 + RLS 拦截有效）
4. 审计日志可查每问的 user/scope_group/SQL/耗时
5. 试点用户在 dsh 引擎上正常问数

## 13. 假设、依赖与风险

| # | 内容 | 性质 |
|---|---|---|
| A1 | claudecodeui 在 Linux 服务器（/opt/claudecodeui），本设计不可见其调用协议细节；网关 API 即接口契约，其侧对接改动在服务器实施 | 唯一跨仓依赖 |
| A2 | dsh skill 插件对 SKILL.md 格式的兼容性未实测（M0 spike 首要验证项） | 技术风险 |
| A3 | GaussDB(DWS) RLS 支持需版本验证；退化方案为权限组过滤视图 | 技术风险 |
| A4 | DeepSeek-V4 在 agentic SQL 任务上的能力未经本数据集验证——整个 M2 就是为此设的 | 已被流程覆盖 |
| A5 | 现状痛点：仓库 .mcp.json 指向旧目录绝对路径，M1 期间修复 | 待办 |
| A6 | 放弃跨引擎兜底后，若个别场景 DeepSeek-V4 持续不行，线上无别引擎接盘，只能靠上线前门槛 + 知识库加固 | 用户已知情接受 |

## 14. 外部参考

- [DeepSeek Harness 知乎详解](https://zhuanlan.zhihu.com/p/2075286409884258399)
- [The New Stack: DeepSeek open sources an agent harness](https://thenewstack.io/deepseek-harness-open-source-plugins/)
- [阿里云：DeepSeek Harness 首发深度实测](https://developer.aliyun.com/article/1759881)
- [awesome-deepseek-agent（官方）](https://github.com/deepseek-ai/awesome-deepseek-agent)
- [36氪：DeepSeek Harness 报道](https://m.36kr.com/p/3937964598590855)
- [DataCamp：DSH vs Claude Code](https://www.datacamp.com/zh/blog/deepseek-harness-vs-claude-code)
- [七牛云：DSH 选型指南](https://news.qiniu.com/archives/1787712582030)
- [GitHub Discussion #3997（MCP 桥接）](https://github.com/deepseek-ai/deepseek-harness/discussions/3997)
- [CSDN：DSH Cordis 架构解析](https://deepseek.csdn.net/6a87dd5a10ee7a33f29d6acf.html)
