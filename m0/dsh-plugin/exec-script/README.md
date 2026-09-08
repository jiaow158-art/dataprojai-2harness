# m0-exec-script — dsh 受控执行工具插件（M0-T13）

注册模型工具 `exec_script`：在 Docker 沙箱内执行 workdir 中的脚本，stdout/stderr/退出码
原样回传。这是 Agent 执行代码的唯一通道（spec §8.4）：模型写脚本 → exec_script 进沙箱 →
读输出/错误 → 迭代 → 取产物。

## 双层防越界

1. **插件层路径校验**（不信任模型参数）：`script` 必须是 workdir 相对路径——拒绝绝对路径
   （`/` 开头）、盘符（`C:`）、`..` 穿越、反斜杠。违规直接抛错（→ isError 工具结果）。
2. **沙箱层边界**（`m0/sandbox/run_in_sandbox.sh`，已过红队 4/4）：`--network none`、
   `--read-only` rootfs、非 root（65534）、`/results` `/assets` 只读、`/workdir` 可写、
   mem/cpu/pids 上限、超时强制清理。

WORKDIR / RESULTS / ASSETS / RUNNER 全部来自 dsh 进程环境变量（会话级固定），模型不可指定。

## 工具契约

```jsonc
{
  "script": "t.py",              // 必填，workdir 相对路径
  "args": ["--flag", "value"],   // 可选，传给脚本的参数
  "language": "python"           // 可选，python（默认）| bash
}
```

返回（成功）：`{ exitCode, stdout, stderr }`；退出码非 0 时抛错 → 模型收到 isError 结果，
消息含退出码与完整 stdout/stderr（Traceback 可读回传）。

## 环境变量（dsh 启动前注入）

| 变量 | 含义 |
|---|---|
| `M0_SANDBOX_WORKDIR` | 宿主机 workdir（挂载为容器 /workdir，可写） |
| `M0_RESULTS_DIR` | 结果目录（容器 /results，只读） |
| `M0_ASSETS_DIR` | 资产根（容器 /assets，只读；通常 = `skills/report-generator`） |
| `M0_SANDBOX_RUNNER` | `run_in_sandbox.sh` 绝对路径 |
| `M0_SANDBOX_BASH` | 可选，Git Bash exe（默认 `C:/Program Files/Git/bin/bash.exe`） |

## 安装（$DSH_HOME 内，仓库外）

```bash
# 1. 安装插件自身依赖（仓库内，node_modules 不进 git）
cd m0/dsh-plugin/exec-script && pnpm install

# 2. 注册进 headless profile（官方 bundle 机制，findings dsh-api.md §4.1）
dsh plugin --profile headless add "D:/dataprojai-2harness/m0/dsh-plugin/exec-script"

# 3. 每次会话注入环境变量后运行
M0_SANDBOX_WORKDIR=<wd> M0_RESULTS_DIR=<res> M0_ASSETS_DIR=<assets> \
M0_SANDBOX_RUNNER=<repo>/m0/sandbox/run_in_sandbox.sh \
dsh --profile headless "<task>"
```

注册产物：`~/.dsh/profiles/headless/package.json` 的 `dsh.profile.bundles` 增加本包 +
`node_modules/m0-exec-script-plugin` 符号链接指向仓库目录（源码 canonical 在仓库内）。
包内 `dsh.bundle.patch` 声明使 `cordis.patch.yml` 自动挂为 bundle 层。

> 为何不用 `cordis.patch.yml` 直接 `- insert: name: file:///...`？实测失败：仓库内插件文件
> 无法解析裸包名 `@deepseek-ai/dsh-tools`（祖先链上无 node_modules）；`dsh plugin add`
> 的 link + 依赖声明是官方持久安装路径。验证记录见 `m0/tests/tool_loop_check.md`。

## 验证

- 四项操作环验证：`m0/tests/tool_loop_check.md`
- 沙箱边界红队（4/4）：`m0/tests/sandbox_redteam.sh`
