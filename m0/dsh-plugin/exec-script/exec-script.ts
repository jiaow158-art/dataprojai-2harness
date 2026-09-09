// exec_script — dsh 受控执行工具插件（M0-T13）
//
// 模型执行代码的唯一通道（spec §8.4）：模型把脚本写进 WORKDIR（经 dsh fs 工具，
// 受沙箱策略约束）→ 调本工具 → 脚本在 Docker 沙箱内执行 → stdout/stderr/退出码
// 原样回传 → 模型读输出迭代。
//
// 双层防越界：
//   1. 本插件层做路径校验（不信任模型给的路径）：必须相对、禁 `..`、禁绝对路径。
//   2. m0/sandbox/run_in_sandbox.sh 层做边界隔离：--network none / --read-only /
//      非 root / 目录白名单只读（/results /assets）/ 资源上限 / 超时清理。
//
// WORKDIR / M0_RESULTS_DIR / ASSETS_DIR 全部从插件配置读（配置行用 !!js
// process.env 注入，会话级固定）；模型不可指定任何路径参数。
//
// 插件形态依据 m0/findings/dsh-api.md §4（docs/user/develop/basic/tool.md +
// docs/cookbook/adding-a-tool.md 官方原文样例，dsh 0.1.2-rc.1）。

import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'm0-exec-script'

/** 从 dsh 进程环境解析 Git Bash（dsh 宿主就是 Node，PATH 同源）。 */
function resolveBashExe(): string {
  return process.env.M0_SANDBOX_BASH ?? 'C:/Program Files/Git/bin/bash.exe'
}

/** 从 dsh 进程环境解析 run_in_sandbox.sh 的绝对路径。 */
function resolveRunnerScript(): string {
  const p = process.env.M0_SANDBOX_RUNNER
  if (!p) throw new Error('M0_SANDBOX_RUNNER is not set in the dsh process environment')
  return p
}

/**
 * 路径安全校验（插件层；不信任模型参数）。合法示例：t.py、scripts/build_report.py。
 * 返回错误消息字符串，null 表示通过。
 */
function pathViolation(script: string): string | null {
  if (typeof script !== 'string' || script.length === 0) {
    return 'script must be a non-empty relative path (relative to the sandbox workdir)'
  }
  if (script.startsWith('/') || script.startsWith('\\')) {
    return `invalid script "${script}": must be a relative path inside the sandbox workdir (no absolute paths)`
  }
  if (/^[A-Za-z]:/.test(script)) {
    return `invalid script "${script}": must be a relative path inside the sandbox workdir (no drive letters)`
  }
  // 沙箱内是 Linux 路径；反斜杠先于 .. 检查（a\..\x 报反斜杠而非 traversal）
  if (script.includes('\\')) {
    return `invalid script "${script}": use forward slashes (/) as path separators`
  }
  if (script.includes('..')) {
    return `invalid script "${script}": path traversal (..) is not allowed`
  }
  return null
}

/** 语言 → 沙箱解释器（run_in_sandbox.sh 的 SANDBOX_INTERPRETER）。 */
function interpreterOf(language: string | undefined): string {
  switch (language) {
    case undefined:
    case 'python':
      return 'python'
    case 'bash':
      return 'bash'
    default:
      // defineTool 的 enum 校验在 execute 前拦截未知值；此分支仅为防御。
      return ''
  }
}

interface ExecResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  spawnError?: string
}

/** 每条流（stdout/stderr 各自）的捕获上限（安全复审 LOW：无界捕获实测致 Node RSS 1.46GB）。 */
const MAX_OUTPUT_CHARS = 2_000_000

/** 追加并封顶：超限即丢弃后续内容并置 capped（防 RSS 膨胀），尾部标记由调用方附加。 */
function appendCapped(prev: string, chunk: string): { text: string; capped: boolean } {
  if (prev.length >= MAX_OUTPUT_CHARS) return { text: prev, capped: true }
  if (prev.length + chunk.length <= MAX_OUTPUT_CHARS) return { text: prev + chunk, capped: false }
  return { text: prev + chunk.slice(0, MAX_OUTPUT_CHARS - prev.length), capped: true }
}

const TRUNCATION_MARKER = '\n[sandbox: output truncated at 2MB]'

/**
 * 脚本宿主侧存在性等待（M1-T6）：M0-T14 实测 write→exec_script 跨文件系统同步间隙
 * （dsh fs write 落盘 vs 本插件读盘）导致"首调必失败、重试即恢复"，浪费模型轮次。
 * 执行前对 workdir 拼出的最终宿主路径轮询 fs access：最多 2s、50ms 间隔；超时不报
 * 新错——保持既有行为（沙箱内 python 报 file not found，文件级错误归沙箱层）。
 * 与沙箱路径解析规则同源（run_in_sandbox.sh）：`/` 开头 = 容器内绝对路径（非 workdir
 * 文件，如 /assets/scripts/build.py），无从等待，直接放行。
 */
const SCRIPT_WAIT_TIMEOUT_MS = 2_000
const SCRIPT_WAIT_INTERVAL_MS = 50

async function waitForScript(
  workdir: string,
  script: string,
  signal: AbortSignal,
): Promise<void> {
  if (script.startsWith('/')) return // 容器内绝对路径（/assets/...），不归本插件等待
  const hostPath = `${workdir.replace(/[\\/]+$/, '')}/${script}`
  const deadline = Date.now() + SCRIPT_WAIT_TIMEOUT_MS
  for (;;) {
    try {
      await access(hostPath)
      return
    } catch {
      if (Date.now() >= deadline || signal.aborted) return
      await new Promise((r) => setTimeout(r, SCRIPT_WAIT_INTERVAL_MS))
    }
  }
}

/**
 * 沙箱容器名参数（M1-T6，附录 A.1 双活安全）：run_id/attempt 环境变量（可选，M1 网关
 * 注入）存在时透传给 run_in_sandbox.sh，容器名带 attempt 后缀——接管者清理旧 attempt
 * 容器（docker rm -f <run_id>-a<旧attempt>-*）不会误杀新 attempt 的容器。
 */
function sandboxRunIdEnv(): { SANDBOX_RUN_ID?: string; SANDBOX_ATTEMPT?: string } {
  const runId = process.env.SANDBOX_RUN_ID
  if (!runId) return {}
  return {
    SANDBOX_RUN_ID: runId,
    ...(process.env.SANDBOX_ATTEMPT !== undefined
      ? { SANDBOX_ATTEMPT: process.env.SANDBOX_ATTEMPT }
      : {}),
  }
}

/** 拉起 run_in_sandbox.sh，收集 stdout/stderr/退出码；exec.signal 贯穿子进程。 */
function runSandbox(
  runner: string,
  workdir: string,
  resultsDir: string,
  assetsDir: string,
  script: string,
  args: string[],
  interpreter: string,
  signal: AbortSignal,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(
      resolveBashExe(),
      [runner, workdir, script, ...args],
      {
        windowsHide: true,
        signal,
        env: {
          PATH: process.env.PATH ?? '',
          SYSTEMROOT: process.env.SYSTEMROOT ?? 'C:\\Windows',
          RESULTS_DIR: resultsDir,
          ASSETS_DIR: assetsDir,
          SANDBOX_WORKDIR: workdir,
          SANDBOX_INTERPRETER: interpreter,
          ...sandboxRunIdEnv(),
        },
      },
    )
    let stdout = ''
    let stderr = ''
    let stdoutCapped = false
    let stderrCapped = false
    let spawnError: string | undefined
    child.stdout!.on('data', (d: Buffer) => {
      const r = appendCapped(stdout, d.toString('utf8'))
      stdout = r.text
      stdoutCapped = stdoutCapped || r.capped
    })
    child.stderr!.on('data', (d: Buffer) => {
      const r = appendCapped(stderr, d.toString('utf8'))
      stderr = r.text
      stderrCapped = stderrCapped || r.capped
    })
    child.on('error', (err) => { spawnError = String(err) })
    child.on('close', (code, sig) => resolve({
      code,
      signal: sig,
      stdout: stdoutCapped ? stdout + TRUNCATION_MARKER : stdout,
      stderr: stderrCapped ? stderr + TRUNCATION_MARKER : stderr,
      spawnError,
    }))
  })
}

export const inject = ['tools']

export function apply(ctx: Context) {
  const runner = resolveRunnerScript()
  const workdir = process.env.M0_SANDBOX_WORKDIR
  const resultsDir = process.env.M0_RESULTS_DIR
  const assetsDir = process.env.M0_ASSETS_DIR
  for (const [k, v] of [['M0_SANDBOX_WORKDIR', workdir], ['M0_RESULTS_DIR', resultsDir], ['M0_ASSETS_DIR', assetsDir]] as const) {
    if (!v) throw new Error(`m0-exec-script: ${k} must be set in the dsh process environment`)
  }

  ctx.tools.register(defineTool({
    name: 'exec_script',
    description: [
      'Execute a script inside the M0 controlled sandbox and return its stdout/stderr and exit code.',
      `The sandbox workdir is the HOST directory ${workdir!.replace(/\\/g, '/')} — it is mounted as /workdir inside the sandbox.`,
      'Create the script file in that host directory with your file tools first, then pass its workdir-relative path here.',
      '`script` is the workdir-relative path of the script file (e.g. "t.py" or "scripts/step1.sh");',
      'absolute paths, drive letters, ".." and backslashes are rejected.',
      '`language` selects the interpreter: "python" (default) or "bash".',
      'The sandbox has NO network, a read-only root filesystem, read-only /results and /assets',
      '(/assets is the report-generator skill root: /assets/templates/report-shell.html,',
      '/assets/scripts/build.py, /assets/references/report-schema.json), and /workdir writable.',
      'Print results to stdout — whatever the script prints comes back to you verbatim;',
      'a non-zero exit code is returned as an error result with the full stdout/stderr (e.g. a Python traceback);',
      'output over 2MB per stream is truncated with an explicit marker.',
    ].join(' '),
    parameters: {
      script: {
        type: 'string',
        required: true,
        description: 'Workdir-relative path of the script file, e.g. "t.py" or "scripts/step1.sh"',
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional command-line arguments passed to the script',
      },
      language: {
        type: 'string',
        enum: ['python', 'bash'],
        description: 'Interpreter for the script; defaults to python',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          exitCode: { type: 'integer' },
          killedBySignal: { type: 'string' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value as { exitCode?: number; killedBySignal?: string; stdout?: string; stderr?: string }
        const parts: string[] = []
        if (v.killedBySignal) parts.push(`[sandbox: killed by signal ${v.killedBySignal}]`)
        else if (typeof v.exitCode === 'number') parts.push(`[sandbox: exit code ${v.exitCode}]`)
        if (v.stdout && v.stdout.length > 0) parts.push(`stdout:\n${v.stdout}`)
        if (v.stderr && v.stderr.length > 0) parts.push(`stderr:\n${v.stderr}`)
        return [{ type: 'text', text: parts.join('\n') || '[sandbox: no output]' }]
      },
    },
    timeoutMs: 150_000, // 沙箱自身 TMO=120s 先超时，此值只兜底进程链
    async execute(args, exec) {
      const violation = pathViolation(args.script)
      if (violation) throw new Error(violation)
      const interpreter = interpreterOf(args.language)
      await waitForScript(workdir!, args.script, exec.signal)
      const res = await runSandbox(
        runner, workdir!, resultsDir!, assetsDir!,
        args.script, args.args ?? [], interpreter, exec.signal,
      )
      if (res.spawnError !== undefined) {
        throw new Error(`exec_script: failed to launch the sandbox runner: ${res.spawnError}`)
      }
      // 退出码非 0：isError 生效（throw → registry 转 isError 结果），消息携带全部输出
      if (res.code !== 0) {
        const tail: string[] = []
        if (res.stdout) tail.push(`stdout:\n${res.stdout}`)
        if (res.stderr) tail.push(`stderr:\n${res.stderr}`)
        throw new Error(
          `exec_script: script ${args.script} failed with exit code ${res.code ?? 'signal ' + String(res.signal)}`
          + (tail.length > 0 ? `\n${tail.join('\n')}` : ''),
        )
      }
      return {
        exitCode: res.code ?? 1,
        ...(res.signal ? { killedBySignal: res.signal } : {}),
        stdout: res.stdout,
        stderr: res.stderr,
      }
    },
  }))

  // 仅用于启动日志排查：不打印任何值，只打印已配置事实。
  ctx.logger.info(`m0-exec-script: registered exec_script (workdir=${pathToFileURL(workdir).href}, results=${pathToFileURL(resultsDir).href}, assets=${pathToFileURL(assetsDir).href})`)
}
