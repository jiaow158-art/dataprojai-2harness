# M0-T13 验证记录：dsh 受控执行工具插件 exec_script + 完整操作环（本地 Windows）

- 日期：2026-09-08
- 环境：dsh 0.1.2-rc.1（npm 全局 `@deepseek-ai/dsh`），Windows 10 + Git Bash + Docker Desktop 27.5.1（WSL2），
  Node v24.14.0（原生 TS 类型剥离）；沙箱镜像 `dataplat-script:m0`
- 依据：`m0/findings/dsh-api.md` §4（defineTool 插件形态）、§1.1（headless 调用）、§5.3/§5.4（会话取证）
- 关联计划：`docs/superpowers/plans/2026-09-08-dsh-m0-capability-verification.md` Task 13（spec §8.4 执行通道）

---

## 1. 插件与注册方式

**插件源**：`m0/dsh-plugin/exec-script/`（canonical 在仓库内）

| 文件 | 作用 |
|---|---|
| `exec-script.ts` | 工具实现（`defineTool` 注册 `exec_script`，官方契约见 findings §4.2） |
| `cordis.patch.yml` | 包内 bundle 清单（`- insert: m0-exec-script`） |
| `package.json` | 声明 `dsh.bundle.patch` + 依赖 `@deepseek-ai/cordis@^4.0.2`、`@deepseek-ai/dsh-tools@^0.1.2-rc.1` |
| `README.md` | 安装/契约/防越界说明 |
| `.gitignore` | 排除 `node_modules/`（**不进 git**） |

**注册机制（实测定型）**：`dsh plugin --profile headless add "D:/dataprojai-2harness/m0/dsh-plugin/exec-script"`

- 产物一：`~/.dsh/profiles/headless/package.json` 的 `dsh.profile.bundles` 尾插 `"m0-exec-script-plugin"`
  （base → headless → 本插件 三层叠序）；产物二：`~/.dsh/profiles/headless/node_modules/m0-exec-script-plugin`
  → 仓库目录的符号链接。配置全部落在 `$DSH_HOME`（仓库外），与 T9 MCP 注册同一持久层。
- **为何不用 `cordis.patch.yml` 直接 `- insert: name: file:///...`**（findings §4.1 文档样例形态）：
  实测 `ERR_MODULE_NOT_FOUND` —— 仓库内插件文件按 Node 祖先链解析裸包名 `@deepseek-ai/dsh-tools`
  时找不到 node_modules（仓库根无 node_modules，loader 的 `internal.import` 按**插件文件自身位置**
  解析而非 profile 目录）。`dsh plugin add` 的 link 依赖 + 插件目录内 `pnpm install` 是可行且官方的
  持久安装路径（apps/cli/reference/README.md 原文，findings §4.1）。
- 中途插曲（诚实记录）：曾用 throwaway profile `m0-probe` 验证，该 profile boot 挂起（禁用本插件
  仍挂起，与本插件无关，疑似其 `patchReload: live` 模板问题），已删除；headless profile（startup）
  一切正常。**插件启用后 headless 正常 boot 并完成全流程**（§3）。

**环境变量**（dsh 启动前注入，会话级固定，模型不可指定）：

| 变量 | 验证时的值 |
|---|---|
| `M0_SANDBOX_WORKDIR` | `C:\Users\Administrator\AppData\Local\Temp\m0tool-wd`（挂载为容器 `/workdir` 可写） |
| `M0_RESULTS_DIR` | `...\Temp\m0tool-results`（`/results` 只读） |
| `M0_ASSETS_DIR` | `D:\dataprojai-2harness\skills\report-generator`（`/assets` 只读） |
| `M0_SANDBOX_RUNNER` | `D:\dataprojai-2harness\m0\sandbox\run_in_sandbox.sh` |

工具描述中内嵌 workdir 宿主机路径（模型需要用它先把脚本写进 workdir——首版缺失导致模型瞎猜路径，
实测教训）。

## 2. 输入 schema 与路径校验

**schema**（`defineTool` parameters，模型侧经 JSON Schema 校验）：

```jsonc
{
  "script":  "<必填 string，workdir 相对路径>",
  "args":    ["<可选 string 数组，传给脚本>"],
  "language": "<可选 enum: python|bash，默认 python>"
}
```

**路径校验（插件层，不信任模型参数）**——确定性单测（剥离 TS 后加载真模块、stub ctx 捕获
definition、直接调 `execute`，非模型会话）：

| 输入 | 结果 |
|---|---|
| `/etc/passwd` | REJECT：`must be a relative path inside the sandbox workdir (no absolute paths)` |
| `C:/Windows/system32/x.py` | REJECT：`(no drive letters)` |
| `../escape.py` | REJECT：`path traversal (..) is not allowed` |
| `sub/../../x.py` | REJECT：`path traversal (..) is not allowed` |
| `a\b.py`（真实反斜杠，`String.fromCharCode(92)` 构造） | REJECT：`use forward slashes (/) as path separators` |
| 空串 | REJECT：`must be a non-empty relative path` |
| `definitely-missing.py`（合法相对路径） | 通过校验 → 进沙箱 → python 退出码 2"file not found"可读回传（正确：文件级错误归沙箱层报） |

**行为链**：`bash run_in_sandbox.sh <workdir> <script> [args...]`（语言经 `SANDBOX_INTERPRETER`
传入）；stdout/stderr 原样回传；退出码非 0 → 抛错 → registry 转 **isError 工具结果**，消息含退出码
与完整输出。

## 3. 四项操作环验证（单次 dsh headless 会话，两阶段）

会话：`session-31ec75e9-19ce-4c87-95d6-0ab13752df4f`（`session.jsonl.zstd` 解压 142 事件），
wall clock **33s**，exit 0，模型 deepseek-v4-flash。
**工具调用序列（会话日志）：`write → exec_script → write → exec_script`** —— 正是设计闭环。

### ① 模型成功创建/修改 workdir 内脚本 — PASS

- seq 1046 `tool/result`（write 工具）：`<path>C:\Users\Administrator\AppData\Local\Temp\m0tool-wd\t.py</path> ... Created file`
- seq 1246 `tool/result`（write 工具，第二阶段修改）：`meta.diffs[0].path = ...m0tool-wd\t.py`，
  `oldText` 为第一阶段三行脚本、新文本 `print(1/0)`
- 文件系统证据：验证后 `/tmp/m0tool-wd/t.py` 内容恰为 `print(1/0)`

### ② 脚本能读 /assets — PASS

- seq 1127 `tool/result`（exec_script）：`[sandbox: exit code 0]\nstdout:\nshell-lines=981`，`isError: false`
- 独立核对：`wc -l skills/report-generator/templates/report-shell.html` = **981** —— 模型无法编造的行数吻合

### ③ exec_script 返回 stdout 给模型 — PASS

- seq 1127 工具结果文本（上行）进入模型上下文；模型最终回答（stdout 原文节选）：
  > 执行 `exec_script`（script: `t.py`，language: `python`）返回的原样输出：
  > `[sandbox: exit code 0]` / `stdout:` / `shell-lines=981`

### ④ print(1/0) 错误可读回传 + isError 生效 — PASS

- seq 1293 `tool/call` exec_script `{"language": "python", "script": "t.py"}`
- seq 1294 `tool/result` **`isError: true`**，内容原文：

  ```
  Error: exec_script: script t.py failed with exit code 1
  stderr:
  Traceback (most recent call last):
    File "/workdir/t.py", line 1, in <module>
      print(1/0)
          ~^~
  ZeroDivisionError: division by zero
  ```

- 模型最终回答复述了完整 Traceback 与退出码 1 结论。

token（`assistant/message` usage 累加）：input 12,253 / output 1,837 / cacheRead 59,648。

## 4. run_in_sandbox.sh 改动与红队回归

改动（最小）：新增 `SANDBOX_INTERPRETER` 环境变量（默认 `python`，`bash` 时容器内以 bash 执行），
容器命令 `python "${SCRIPT_PATH}"` → `"${INTERP}" "${SCRIPT_PATH}"`。缺省行为与既有调用完全一致。

- bash 支持冒烟：`SANDBOX_INTERPRETER=bash ... t.sh arg1 arg2` → `BASH-SANDBOX-OK args=arg1 arg2`，exit 0
- python 缺省回归：`PY-SANDBOX-OK`，exit 0

**红队回归（改动后实跑）：`bash m0/tests/sandbox_redteam.sh` → 4/4，exit 0**

```
[BLOCKED-OK] 凭据泄漏
[BLOCKED-OK] 网络外联
[BLOCKED-OK] 越界写入
[BLOCKED-OK] 只读挂载写入
passed=4 failed=0
```

## 5. 密钥与仓库卫生自查

- 本次全部输出与文件中 `DEEPSEEK_API_KEY` / `DWS_PASSWORD` **零明文出现**；插件与配置不含任何密钥。
- `m0/dsh-plugin/exec-script/node_modules/` 已被包内 `.gitignore` 排除且未 `git add`（提交前 `git status` 自查）。
- commit 仅含 `m0/dsh-plugin/`、`m0/tests/tool_loop_check.md`、`m0/sandbox/run_in_sandbox.sh`（路径限定）。
- 临时目录（`/tmp/m0tool-*`）与 throwaway profile（`~/.dsh/profiles/m0-probe`）已清理；仓库根的验证残留 `t.py` 已删除。
