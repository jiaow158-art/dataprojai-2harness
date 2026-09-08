# dsh API 发现记录（实测：2026-09-08，dsh 0.1.2-rc.1，Windows 10 本机）

> M0 Task 2 spike 产出。所有条目均来自**本机实测输出原文**或**官方文档原文引用**（标注出处链接）。
> 未能确认的条目明确标注"需实验确定"。宁缺毋假。
> 重要更正：任务背景称"awesome-deepseek-agent README 有 dsh 条目"——**实测该 README 无此条目**，详见 §0.1。
> API key 配置（Step 3）按计划跳过，留给用户；本机环境已存在可用 key（值不记录），故实测得以实跑。

---

## 0. 安装

### 0.1 官方仓库的发现路径（背景事实纠错）

任务给定的发现路径是 https://github.com/deepseek-ai/awesome-deepseek-agent 。实测抓取其 README 原文（2026-09-08），
目录表内容为：AstrBot / Cherry Studio / Claude Code / Cline / Codex / Crush / Deep Code / DeepSeek-TUI /
GitHub Copilot / GitHub Copilot CLI / Hermes / Kilo Code / Langcli / LobeHub / nanobot / Oh My Pi /
OpenClaw / OpenCode / Pi / Qwen Code / Reasonix / WorkBuddy/CodeBuddy —— **没有 "DeepSeek Harness"/"dsh" 条目**。

实际发现路径：`npm search "deepseek harness" --json` → 命中 `@deepseek-ai` scope 下 20+ 个包
（`@deepseek-ai/dsh-skill`、`@deepseek-ai/dsh-llm-deepseek` 等），全部指向同一仓库：

- 官方仓库：**https://github.com/deepseek-ai/deepseek-harness**（"DeepSeek Harness: Everything is a Plugin."，MIT，215k stars，developer preview）
- 官方文档站：https://deepseek-harness.github.io/deepseek-harness/ （VitePress；正文文档在仓库 `docs/` 目录）
- CLI 包：**`@deepseek-ai/dsh`**（bin 名 `dsh`）

⚠️ 陷阱：npm 上**无 scope 的 `dsh` 包是无关项目**（`infusion/node-dsh`，"A shell written in JavaScript"），不可安装。
另注意部分子包 npm 元数据 license 标 BSD-3-Clause，仓库根 README 声明 **MIT**。

### 0.2 实际执行的安装命令

官方 README 的运行方式（README#run 原文）：

```
npx @deepseek-ai/dsh web
```

本任务执行的全局安装（实测命令与输出原文）：

```
$ npm install -g @deepseek-ai/dsh
npm warn deprecated node-domexception@1.0.0: Use your platform's native DOMException instead

added 522 packages in 3m
```

验证（实测）：

```
$ dsh --version
0.1.2-rc.1

$ which dsh
/c/Users/Administrator/AppData/Roaming/npm/dsh
```

- npm 全局 prefix：`C:\Users\Administrator\AppData\Roaming\npm`（`npm config get prefix` 实测；已在 PATH，无需排查）
- 包元数据（`npm view @deepseek-ai/dsh`）：version `0.1.2-rc.1`，dist-tags `latest: 0.1.2-rc.1, alpha: 0.1.3-alpha.2`，`bin: { dsh: 'lib/bin.js' }`
- 安装在首次运行时自举 `$DSH_HOME`（默认 `~/.dsh`）：生成 `profiles/{web,headless}`（各含 `package.json`+`cordis.yml`+`cordis.patch.yml`）、`sessions/`、`storages/`、`.anonymous-user-id`

### 0.3 顶层命令面（`dsh --help` 实测原文）

```
Usage: dsh [options] [command] [args...]

dsh: boot a DeepSeek Harness profile — an ordered stack of plugin-bundle patch
layers under your own overrides.

Arguments:
  args                        arguments for the booted profile's app (see: dsh
                              --profile <name> --help)

Options:
  -V, --version               output the version number
  --profile <name>            the profile under $DSH_HOME/profiles to boot
  --patch <path>              extra patch-list overlay applied after the profile
                              layer (repeatable)
  --dump-config               print the composed profile tree and exit
  --dump-default-config       print the profile tree without its user layer or
                              --patch overlays and exit

Commands:
  web [options] [args...]     boot the web profile (alias of --profile web); the
                              web app's own flags follow
  plugin [options] [args...]  manage a profile's plugins by forwarding the
                              remaining arguments to pnpm in the profile
                              directory

Examples:
  dsh --profile web                          boot the web profile (same as: dsh web)
  dsh --profile headless "run the tests"     answer one task, print the result, and exit
  dsh --profile tui --patch ./extra.yml      boot a custom profile with one extra overlay
  dsh --profile tui --resume <session>       arguments after the launcher flags reach the app
  dsh --profile web --help                   the web app's own flags and help
  dsh plugin --profile tui add <package>     install a plugin into the tui profile
```

内建 profile（apps/cli/README.md 原文表）：`web` / `headless` / `sdk` / `sdk-minimal` / `acp` 首次使用自动初始化；
其他名字需 `dsh plugin --profile <name> add <package>` 创建；`desktop` 名保留给 Electron。

---

## 1. headless / 编程调用

### 1.1 CLI 一次性任务（headless profile）——实测

`dsh --profile headless --help` 原文：

```
Usage: dsh --profile headless [options] [task...]

Answer one task, stream reasoning to stderr, print the final assistant message,
and exit.

Arguments:
  task        the task text; multiple words are joined by spaces

Options:
  -h, --help  show this help

Examples:
  dsh --profile headless "run the tests"     answer one task and exit
```

流分离实测（实跑）：

```
$ dsh --profile headless "Say exactly: hello from dsh" 2>stderr.txt
hello from dsh            ← stdout：仅最终回答
$ cat stderr.txt
dsh: reasoning:
The user asks: "Say exactly: hello from dsh". This is a trivial single-turn request. I should just output the exact text.
                          ← stderr：`dsh: reasoning:` 标题下的推理流
EXIT: 0
```

错误路径实测：无 task 参数 → `error: a task is required, for example: dsh --profile headless "run the tests"`，exit 1。

工具调用实测（Windows 上模型自动选 pwsh 工具执行 `echo DSH-E2E-OK`，成功；中间工具输出**不**打印，仅最终回答上 stdout）。

headless README（packages/bundle/headless/README.md 原文要点）：
- "The exit code tells you the outcome — 0 when the task completed, 1 when it aborted or errored."
- 失败时 stderr 打 `dsh: <code>: <message>`
- 已知限制（原文）："One task per run"；"Only reasoning and the final answer are printed — a run without an assistant message prints an empty stdout line and exits 1; intermediate tool output is not printed."
- **注意**："Reasoning enters stderr logs — redirection and supervisors may retain substantially more and potentially sensitive model output; route stderr to a controlled sink when needed."

### 1.2 SDK / 编程入口（文档原文）

dsh 有四种编程面，均为 profile 而非独立 bin（apps/cli/README.md 原文："SDK and ACP are profiles, not separate public bins"）：

**a) JSON-RPC stdio（`dsh --profile sdk`）** — 线协议（packages/sdk/protocol/README.md 原文表）：

| Direction | Method | Payload types |
|---|---|---|
| client→server | `initialize` | `InitializeParams` → `InitializeResult` |
| client→server | `session/prompt` | `SessionPromptParams` → `SessionPromptResult` (durable enqueue receipt) |
| client→server | `shutdown` | no params → `{}` |
| server→client | `session.event` | `SessionEventNotification` (every session in the runtime, unfiltered) |
| server→client | `session.status` | `SessionStatusNotification` (whole-agent `running`/`idle` transition) |
| server→client | `subagent.started` | `SubagentStartedNotification` |
| server→client | `subagent.finished` | `SubagentFinishedNotification` (in-process runs only) |

帧格式："Wire one JSON-RPC 2.0 message per `\n`-terminated line"；握手身份 `serverInfo.name` 固定为 `deepseek-harness-sdk-runtime`。
限制（原文）："No cancel or session-close methods"、"The wire has no per-session close or prompt-cancel method"。

**b) TypeScript 客户端 `@deepseek-ai/dsh-sdk-client`**（README 原文示例）：

```ts
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

await using harness = new DeepSeekHarness({
  profile: 'sdk',
  patches: ['./automation.cordis.yml'],
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  reasoningEffort: ReasoningEffortId('max'),
  maxTokens: 49_152,
})
const result = await harness.run('say hi')
console.log(result.finalResponse)
```

`run(input, { sessionId?, onNotification? })` 返回 `RunResult { sessionId, finalResponse, events, notifications }`。

**c) Python 客户端 `deepseek-harness-sdk`**（python/sdk/README.md 原文示例）：

```sh
python -m pip install deepseek-harness-sdk
```

```py
from deepseek_harness import DeepSeekHarness

with DeepSeekHarness(
    dsh_home="/absolute/path/to/isolated-dsh-home",
    cwd="/absolute/path/to/workspace",
    provider="deepseek-official",
    model="deepseek-v4-flash",
    reasoning_effort="max",
    max_tokens=49_152,
) as harness:
    result = harness.run("Say hi.", session_id="example-001")

print(result.final_response)
```

返回 `RunResult(session_id, final_response, finish_reason, events, notifications)`。
注意原文："Every launch requires an explicit Harness home... The SDK deliberately never discovers `~/.dsh`"。

**d) ACP（`dsh --profile acp`）**：Agent Client Protocol v1 stdio，扩展方法 `session/list` / `session/resume` / `session/close`（见 §5）。

事件流格式说明：headless CLI 的 stdout **不是**结构化事件流（仅最终文本）；结构化事件有两个获取途径：
(a) SDK 的 `session.event` 通知流（durable SessionEvent 词汇，含 `assistant/message`、`turn/end` 等）；
(b) 持久化会话日志（见 §5.4 实测）。"每步 JSON 输出"之类格式开关官方文档未覆盖——**需实验确定**（当前结论：没有 `--json` 类 flag，help 原文中不存在）。

---

## 2. skill 插件

### 2.1 目录约定与清单字段（官方文档原文）

出处：docs/subsystems/skills.md + packages/skill/skill-filesystem/README.md。

本地发现优先级（原文表）：

| Rank | Source | Root |
|---|---|---|
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` |
| 300 | `custom` | `Config.customSkillDirs` |
| 400 | `user-dsh` | `<dshHome>/skills` |
| 500 | `user-agents` | `<agentsHome>/skills` |
| 600 | `bundled` | `Config.bundledSkillDir` when configured |

- project root = "the nearest ancestor containing `.git`"（无则 cwd）
- 默认 roots 对应配置（config-catalog 原文）：`dshHome` 默认 `$DSH_HOME` 或 `~/.dsh`；`agentsHome` 默认 `$DSH_AGENTS_HOME` 或 `~/.agents`；`customSkillDirs: string[]`；bundled 走 `$DSH_BUNDLED_SKILL_DIR`

格式（skill-filesystem README 原文）：

> A skill is either a directory bundle `<name>/SKILL.md` or a flat file `<name>.md` at the top level of a scanned root; nested `**/SKILL.md` files are deliberately not discovered.

> The file starts with YAML frontmatter: required `name` and `description`, plus optional `whenToUse`, `metadata`, `disable-model-invocation`, and `user-invocable`.

- name 必须 kebab-case：`^[a-z0-9]+(?:-[a-z0-9]+)*$`（skills.md 原文）
- 调用控制布尔语法严格（接受 `true/false/yes/no/on/off/1/0`，非法值**丢弃整个 skill 并告警**）
- 目录内 watch 深度为 1：skill 条目增删改触发目录刷新；"edits below `references`, `scripts`, `assets`, and other bundle resources do not"（资源子树不触发，但加载时可读）
- 模型侧 `skill({ name })` 工具返回 `<skill_content>` / `<skill_resources>` / `<skill_instructions>`；"`resourceBase` resolves explicitly referenced scripts, references, and assets only as needed; the loaded result does not enumerate a skill directory."

### 2.2 最小可加载 skill（实测，非文档样例）

官方文档未给完整样例 skill。本任务实测最小样例（Claude Code 风格）：

```
.dsh/skills/probe-skill/SKILL.md     ← 项目根（git 仓库根）下
---
name: probe-skill
description: Probe skill to verify dsh local discovery from Claude Code style SKILL.md
---

# Probe

Body of probe skill. references/ and templates/ live beside SKILL.md as plain files.
```

实测结果：`dsh --profile headless "…call the skill tool with the name probe-skill…"` →
模型会话目录中出现 `probe-skill`，且 skill 工具加载成功（模型回报原文）：

> Skill load result for `probe-skill`: **loaded successfully** — instructions and resources were returned from `D:\dataprojai-2harness\.dsh\skills\probe-skill`.

（验证后该 probe 目录已删除。）

### 2.3 与现有 Claude Code 格式 SKILL.md 的兼容性 —— 实测结论：基本直接兼容

实测证据：本机 `~/.agents/skills/` 下已有的 10 个 Claude Code 格式 skill
（agent-browser、brainstorming、skill-creator、test-driven-development 等，frontmatter name/description + 正文 + 资源目录）
在 dsh headless 会话的 available-skills 目录中**全部出现**（走 `user-agents` root，rank 500），无需任何转换：

> Available skills: agent-browser, brainstorming, browser-preview, code-simplifier, find-skills, frontend-design, probe-skill, requesting-code-review, skill-creator, subagent-driven-development, systematic-debugging, test-driven-development, using-superpowers, writing-plans

差异线索（文档对比，供 T7 深测）：
- dsh 认的字段：`name`/`description`/`whenToUse`/`metadata`/`disable-model-invocation`/`user-invocable`；Claude Code 的 `allowed-tools` 等扩展字段文档未提——按 `SkillCandidate.metadata` 定义（"Parsed optional metadata object from provider-specific skill frontmatter"）推测落入 metadata 不致命，**需 T7 实测确认**
- dsh 只扫 root **顶层一层**（不递归 `**/SKILL.md`），与 Claude Code 相同
- 迁移可用字段映射：Claude Code 无 whenToUse；dsh 的 `disable-model-invocation` 语义近似 Claude Code 的禁用面

---

## 3. MCP server 注册

### 3.1 注册方式与字段（官方文档原文）

出处：packages/mcp/mcp-client/README.md（`@deepseek-ai/dsh-mcp-client`）。**没有独立配置文件**——MCP server 是一行 patch 配置（Cordis overlay），非 `.mcp.json` 式独立文件。

stdio 最小配置（原文）：

```yaml
- id: mcp-github
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: github
    transport: stdio
    command: npx
    args: ['-y', '@modelcontextprotocol/server-github']
    env:
      GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN
```

字段表（原文摘要）：

| Field | Default | Meaning |
|---|---|---|
| `transport` | required | `stdio` or `streamable-http` |
| `serverName` | required | 命名空间，`[A-Za-z0-9_-]{1,32}`，注册 scope 内唯一 |
| `command` / `args` / `env` / `cwd` | — | stdio: 可执行文件、参数、额外 env（合并到**洗净后的环境**）、工作目录 |
| `url` / `headers` | — | streamable-http: 端点与请求头 |
| `toolCallTimeoutMs` | 60,000 | 每次 tools/call 超时 |
| `failOnStartupError` | false | 启动失败是否中止 harness |
| `reconnect.*` | enabled, 500ms→30s, 10 次 | 断线重连策略 |

工具命名（原文）："its tools appear as `mcp__<serverName>__<tool>`" —— **与 Claude Code 同形**（例 `mcp__github__create_issue`）。
限制（原文）："Only tools are bridged: MCP resources and prompts are not supported."

### 3.2 配置落盘位置（三选一，mcp-memory.md 原文）

1. 一次性：`dsh web --patch ./overlay.yml`（`--patch` 可重复）
2. 单 profile 持久：`$DSH_HOME/profiles/<name>/cordis.patch.yml`
3. 全机持久：`$DSH_HOME/cordis.patch.yml`

实测仓库官方样例（apps/cli/config/examples/mcp-memory/mcp-reference-memory.cordis.yml 原文）：

```yaml
- insert:
    - id: memory-mcp-reference
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: reference_memory
        transport: stdio
        command: mcp-server-memory
        cwd: !!js process.cwd()
        env:
          MEMORY_FILE_PATH: !!js >-
            process.env.MEMORY_FILE_PATH?.trim() || process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:os').homedir(), '.dsh-mcp-reference-memory.jsonl')
```

### 3.3 环境变量注入方式（原文）

- YAML `env:` map 即注入项；支持 `!!js` 表达式引用进程环境（如 `!!js process.env.GITHUB_TOKEN`）
- **环境洗净**（mcp-memory.md 原文）："The stdio bridge deliberately removes ambient variables whose names usually identify credentials and all `DSH_*` variables before launching a child; other ambient variables remain inherited."——即子进程默认**拿不到**宿主的密钥类变量与 DSH_* 变量，需要哪个就在该行 `config.env` 里显式加

---

## 4. 自定义工具插件

### 4.1 插件形态（官方文档原文）

出处：docs/user/develop/basic/index.md（Your first plugin）。插件 = 导出 `apply(ctx)` 的 TS 模块：

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'my-plugin'

export function apply(ctx: Context) {
  // Register capabilities here.
}
```

加载：写 patch 文件并在启动时挂载（原文，**路径必须绝对**）：

```yaml
- insert:
    - id: hello
      name: '/absolute/path/to/deepseek-harness/scratch-plugin/src/my-plugin.ts'
```

```sh
pnpm dsh web --patch ./scratch-plugin/cordis.yml
```

三种形态：函数 / 对象（`export default { name, inject, apply }`）/ 类（`extends Service`）。
依赖声明 `export const inject = ['tools']`；清理用 `ctx.effect(() => { …; return disposer })`。
持久安装第三方/本地插件包：`dsh plugin --profile <name> add <package>`（转发 pnpm；带 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` 声明的依赖自动进 bundle 层——apps/cli/reference/README.md 原文）。

### 4.2 最小工具样例（官方示例原文）

出处：docs/user/develop/basic/tool.md（Build a tool）+ docs/cookbook/adding-a-tool.md（Tool authoring reference）：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'greet-tool'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'greet',
    description: 'Greet someone by name.',
    parameters: {
      name: { type: 'string', required: true, description: 'The name to greet' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      return `Hello, ${args.name}!`
    },
  }))
}
```

契约要点（cookbook 原文）：`defineTool` 按 `parameters` 校验模型参数并类型化 `args`；`execute` 只返回 `output.schema` 声明的 canonical JSON 值，`output.render` 转模型可见内容；必须响应 `exec.signal`；生产级三包范例是 `packages/shell/tool-bash`。

本地样例文件路径：全局安装为**构建产物**（`lib/*.js`），无 TS 源码样例。
- 本机插件目录（运行时生成）：`C:\Users\Administrator\.dsh\profiles\node_modules\@deepseek-ai\`（含 `dsh-tools`、`dsh-tool-bash` 等 lib-only 包，可作接口参照但非样例）
- 完整样例以官方仓库为准：`docs/user/develop/basic/tool.md`、`docs/cookbook/adding-a-tool.md`、源码 `packages/shell/tool-bash`
- `defineTool` 签名参照（本机已装包 README 同文）：`https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/README.md`

---

## 5. 多轮会话

### 5.1 headless —— 无会话延续（实测 + 文档一致）

实测：`dsh --profile headless --resume xxx` → `error: unknown option '--resume'`。
文档一致（headless README 原文）："One task per run — after the task is answered the process exits; there is no interactive follow-up"。

### 5.2 交互面延续机制（官方文档原文）

- **TUI**（launcher help 原文示例）：`dsh --profile tui --resume <session>`。tui 非内建 profile，本机实测报
  `Error: dsh: profile "tui" does not exist; create it with 'dsh plugin --profile tui add <package>'`；
  CLI 参考给出安装方式：`dsh plugin --profile tui add github:deepseek-harness/turtle-ui`。
  ——**tui 路径本次未装未实测，需后续实验确定**。
- **Web**：浏览器 GUI 自带 session history（web-app README："interactive chat, model and settings management, and session history"）。
- **ACP**（acp-app README 原文）："Another process can use `session/list` and `session/resume` against the same profile persistence root; resume reconnects the MCP declarations supplied by that request and does not replay history."（dsh-acp 是唯一有显式 resume 方法的面）
- **SDK**：TS `run(input, { sessionId? })` / Python `harness.run(..., session_id=...)`。Python README 原文：
  "Reusing both a harness and session id continues the durable conversation and session-owned resources."——**自选 session_id 即是延续机制**。

### 5.3 会话持久化位置（实测）

```
~/.dsh/sessions/<cwd-slug>/session-<uuid>/session.jsonl.zstd
例：C:\Users\Administrator\.dsh\sessions\--D-dataprojai-2harness--\session-df6ec6b2-…\session.jsonl.zstd
```

每次 headless 运行都落一个持久会话文件（实测 4 次运行 4 个文件）。

### 5.4 会话日志事件结构（实测：zstd 解压后 JSONL，首尾事件原文）

首事件：
```json
{"type": "session", "version": 0, "id": "session-df6ec6b2-09ba-4d01-b74a-2c0b4e13f7cf", "createdAt": 1788836821826, "cwd": "D:\\dataprojai-2harness", "delegationDepth": 0}
```
事件序列实测类型：`session → permission/preset → sandbox/mode → approval/policy → agent/inbox/spliced → turn/start → step/start → … → assistant/message → step/end → turn/end`。

末事件（assistant/message 含 provider/model/usage 原文节选）：
```json
{"type": "assistant/message", "seq": 23, …"message": {"role": "assistant", "content": [{"type": "text", "text": "PERSIST"}], "source": {"kind": "model", "provider": "deepseek-official", "model": "deepseek-v4-flash"}, …}, "usage": {"inputTokens": 4023, "outputTokens": 4, …}}
{"type": "turn/end", "seq": 25, "data": {"turn": 1, "reason": {"kind": "completed"}}}
```

T16（多轮）结论：程序化多轮走 **SDK session_id 复用**或 **ACP session/resume**；headless 单发模式无 resume；
会话文件为 zstd 压缩 JSONL，可离线解析（Python `zstandard` 库实测可解）。

---

## 6. 模型配置

### 6.1 DeepSeek 适配器（官方文档原文）

出处：packages/llm/llm-deepseek/README.md（`@deepseek-ai/dsh-llm-deepseek`，默认已挂载，route 名 `deepseek-official`）。

```yaml
- name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY  # credential reference, resolved per request
    baseURL: https://api.deepseek.com # optional; $DEEPSEEK_BASE_URL then this default
    reasoningEffort: high        # optional; off | low | high | max
    maxTokens: 256000            # optional per-request output cap
```

模型目录（原文）："Omitted `models` advertises `deepseek-v4-flash` as the fast, economical choice for focused work, `deepseek-v4-pro` as the stronger, higher-cost choice for complex or quality-critical work, and the image-capable `deepseek-v4-flash-vision-exp`; each has a 1,000,000-token context window."
——**模型 id 直接透传**（"the model id passes through to the wire, so new DeepSeek models need no re-registration"）。

### 6.2 key 存放位置与优先级（官方文档原文）

出处：packages/credentials/credentials-local/README.md + docs/user/guide/providers.md。

- Web UI 配置入口：Settings → Models → DeepSeek 卡片填 key（providers.md 原文："The key is stored in `$DSH_HOME/.credentials.yaml`, while settings retain only its credential reference."）
- 四层解析优先级（原文表）：

| Place | Writable? | Wins over |
|---|---|---|
| The environment you launched in (`DEEPSEEK_API_KEY=… dsh`) | no | everything |
| The stored file | yes (`set`/`unset`) | both `.env` files |
| Your project's `.env` (`<invocation cwd>/.env`) | not here | your home `.env` |
| Your home `.env` (`$DSH_HOME/.env`) | not here | nothing |

- 其他用户设置：`$DSH_HOME/settings.yaml`（settings-file 原文："Settings document path; defaults to `settings.yaml` under the harness home"），改后下一请求生效无需重启
- key 解析失败错误码：`MISSING_CREDENTIAL`（无 key）/ `INVALID_CREDENTIAL`（credential 引用损坏，原文"naming the reference to fix — never any part of the key"）

### 6.3 本机实测状态

- **本机环境已存在 `DEEPSEEK_API_KEY`**（环境变量层，值按 Step 3 约定不记录）→ headless 实跑直接成功，无需任何 key 配置动作
- 实测路由证据（会话日志原文）：`"provider": "deepseek-official", "model": "deepseek-v4-flash"`（默认模型即 deepseek-v4-flash）
- 环境层 key 为**只读**（credentials-local 原文：environment 层 "cannot be edited from inside the product"）——后续若要在 dsh 内换 key，需写入 `.credentials.yaml`（该操作留给用户，本任务未创建任何含密钥文件）

---

## 覆盖缺口汇总（诚实清单）

| 项 | 状态 |
|---|---|
| headless JSON/结构化事件流输出开关 | **官方文档未覆盖，需实验确定**；当前最小结论：help 中无 `--json` 类 flag；结构化事件走 SDK `session.event` 通知或离线解析 `session.jsonl.zstd` |
| Claude Code 扩展 frontmatter 字段（如 allowed-tools）在 dsh 下的行为 | 需 T7 实测（推测落入 metadata，见 §2.3） |
| tui profile（`--resume` 实际行为） | 未安装未实测（安装命令已记录，§5.2），需后续实验确定 |
| MCP server 桥接的端到端实跑 | 配置格式与样例为文档原文；本机未实跑外部 MCP server（留 T9） |
| 自定义工具插件的端到端实跑 | 插件形态/样例为文档原文；本机未实跑自定义插件加载（留 T13） |
| awesome-deepseek-agent 收录 dsh | **背景事实不成立**（README 无此条目，§0.1）；官方仓库经 npm scope 反查确认 |
