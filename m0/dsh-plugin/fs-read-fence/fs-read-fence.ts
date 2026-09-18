// m0-fs-read-fence — 读域围栏插件（E-5 修复，2026-09-18）
//
// 红队实弹（T5-evidence E2）：模型经 read 工具真实读出宿主任意文件（.mcp.json）。
// 根因 = dsh 的 ctx.fs 后端读不设界（fs-local 无围栏；fs-sandbox 的 mode fence
// 官方语义 "reads always pass through"——只围写）。官方指路的读收敛通道是
// tools/execute 瀑布上的 permission 插件（fs-local README 明示），本插件即此。
//
// 分层职责（不重叠）：
//   写侧围栏   fs-sandbox workspace-write（M0 既有，workspace+temp 外拒写）
//   读侧围栏   本插件：read/read_image/glob/grep 的目标必须在允许根内
//   执行隔离   exec_script Docker 沙箱（--network none 等 5 要素）
//
// 允许根 = 会话工作区 / 双通道结果目录 / 技能库 / 报告资产 / 平台临时目录，
// 全部经 cordis.patch.yml 的 !!js process.env 注入（与 DWS_PASSWORD 同红线手法，
// 值不落任何文件）。网关 DshBackend 已注入这四个 M0_* env（REQUIRED_ENV_KEYS）。
//
// 已知残余（与 fs-sandbox 同级）：path.resolve 是词法解析，workdir 内指向外部
// 的符号链接可绕过前缀检查——但模型侧无建链通道（write 只产文本文件，exec_script
// 在 Docker 内碰不到宿主盘），风险关闭；服务器部署再叠低权限服务账户（部署层加固）。
//
// 插件形态依据 m0/findings/dsh-api.md §4 与 dsh-tool-call-timeout-policy 官方
// 实现样例（dsh 0.1.2-rc.1）：inject ['tools']，ctx.on('tools/execute') 拦截，
// 不调 next() 即拒（返回 isError 结构化结果，code=FS_READ_FENCE_DENIED）。

import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'm0-fs-read-fence'
export const inject = ['tools']

/** 读侧工具 → 取路径实参的参数名（dsh-tool-fs / dsh-tool-fs-search 官方 schema）。 */
const PATH_ARGS: Record<string, string> = {
  read: 'file_path',
  read_image: 'file_path',
  glob: 'path',
  grep: 'path',
}

/** 归一为小写正斜杠形态（win32 大小写不敏感 + 分隔符统一），供包含判断。 */
function norm(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

/** target 是否落在 root 内（含 root 本身；边界带分隔符防 d:\a 匹配 d:\ab）。 */
function within(root: string, target: string): boolean {
  const r = norm(root).replace(/\/+$/, '')
  const t = norm(target)
  return t === r || t.startsWith(r + '/')
}

function fenceResult(target: string): { content: Array<{ type: string; text: string }>; isError: true; error: { message: string; info: { name: string; code: string } } } {
  const message = `"${target}" is outside the allowed file-access roots (session workdir / results / skills / assets / temp). This is a read fence: if the file is task data you need, ask the user to place it in the session workdir.`
  return {
    content: [{ type: 'text', text: `Error: [fs-fence] ${message}` }],
    isError: true,
    error: { message, info: { name: 'FsReadFenceError', code: 'FS_READ_FENCE_DENIED' } },
  }
}

export interface FenceConfig {
  /** 允许根（绝对路径）；缺省为空 = 仅平台临时目录可读（显式配置见 cordis.patch.yml）。 */
  roots?: string[]
  /** 围栏覆盖的工具名（缺省 PATH_ARGS 全集）。 */
  tools?: string[]
}

export function apply(ctx: Context, config: FenceConfig = {}): void {
  const roots = [...(config.roots ?? []), tmpdir()]
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .map((p) => resolve(p))
  const tools = new Set(config.tools ?? Object.keys(PATH_ARGS))

  ctx.on('tools/execute', async (exec: any, next: () => Promise<any>) => {
    if (!tools.has(exec.name)) return next()
    const argKey = PATH_ARGS[exec.name] ?? 'file_path'
    const args = (exec.arguments ?? {}) as Record<string, unknown>
    const raw = args[argKey]
    // 未带路径实参 = 工具默认从会话 cwd（=工作区）起 —— 放行
    if (typeof raw !== 'string' || raw.length === 0) return next()

    const target = resolve(process.cwd(), raw)
    if (roots.some((r) => within(r, target))) return next()
    // 审计行：仅工具名与被拒路径（无密钥面）
    console.warn(`[m0-fs-read-fence] denied ${exec.name} -> ${target}`)
    return fenceResult(target)
  })
}
