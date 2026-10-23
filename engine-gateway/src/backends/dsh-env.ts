// S4-B2-B1：DSH 子进程环境白名单。
//
// 旧实现用 `{ ...process.env, ... }` 全量透传：AUTH_TOKEN、DWS_RUN_PASSWORD、父进程
// DWS_PASSWORD 等都会进入 DSH。这里改为「继承白名单 + 服务端显式注入」：
//   - 继承白名单只放行运行 DSH/插件/沙箱所需的非敏感配置；
//   - 任务/沙箱路径、run_id、DWS 运行账号、DeepSeek Key 由服务端显式注入；
//   - DWS_RUN_*、父 DWS_PASSWORD、AUTH_TOKEN、NODE_OPTIONS、LD_PRELOAD、BASH_ENV
//     等永不继承。
//
// sdk-s4b（无 mcp-dws）完全不注入 DWS_*；sdk 仅注入当前选定的 DWS_USER/DWS_PASSWORD。

import { profileRequiresDws, type DshProfile } from "../config/dsh-profile.ts";

/**
 * 允许从 Gateway 进程 env 继承的键（显式清单）。
 * 不在这里的键一律不复制；新增键必须经过安全评审并补测试。
 */
export const INHERITED_DSH_ENV_KEYS = [
  // POSIX / 通用运行环境
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  // Windows 必需系统环境（Git Bash/Node/dsh.cmd 依赖）
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "WINDIR",
  "SystemDrive",
  "ComSpec",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "COMMONPROGRAMFILES",
  // 代理 / TLS（API 出站可能需要；值来自可信服务端配置）
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  // DSH 自身配置与插件解析路径
  "DSH_HOME",
  "DSH_AGENTS_HOME",
  "DSH_BUNDLED_SKILL_DIR",
  "DSH_TELEMETRY_DISABLED",
  "MCP_PYTHON",
  // 沙箱可信服务端配置（插件白名单消费）
  "M0_SANDBOX_BASH",
  "SANDBOX_TASK_ROOTS",
  "SANDBOX_ASSETS_ROOTS",
  "SANDBOX_ACL_STATE_DIR",
  "SANDBOX_MEM",
  "SANDBOX_CPUS",
  "SANDBOX_PIDS",
  "SANDBOX_TIMEOUT_S",
  "SANDBOX_IMAGE",
] as const;

/** 所有 profile 都必须存在的显式注入键。 */
export const COMMON_REQUIRED_DSH_ENV_KEYS = [
  "M0_SANDBOX_RUNNER",
  "M0_SANDBOX_WORKDIR",
  "M0_RESULTS_DIR",
  "M0_ASSETS_DIR",
  "M0_PROJECT_SKILL_DIR",
  "RESULT_DIR",
  "DEEPSEEK_API_KEY",
] as const;

/** 仅 sdk profile（mcp-dws）需要。 */
export const DWS_REQUIRED_DSH_ENV_KEYS = ["DWS_USER", "DWS_PASSWORD"] as const;

export function requiredDshEnvKeys(profile: DshProfile): readonly string[] {
  return profileRequiresDws(profile)
    ? [...COMMON_REQUIRED_DSH_ENV_KEYS, ...DWS_REQUIRED_DSH_ENV_KEYS]
    : [...COMMON_REQUIRED_DSH_ENV_KEYS];
}

export interface DshRuntimeEnvInput {
  /** 仅白名单键会被读取；绝不整包展开。 */
  source: NodeJS.ProcessEnv;
  profile: DshProfile;
  workdir: string;
  resultsDir: string;
  assetsDir: string;
  skillsDir: string;
  runnerPath: string;
  runId: string;
  attempt: number;
  /** 仅创建 DSH 会话时由 DshBackend 读取并传入；不在继承白名单中。 */
  deepseekApiKey: string;
  /** sdk 才使用；sdk-s4b 传入也会被忽略。 */
  dbUser?: string;
  dbPassword?: string;
}

/** 只复制显式白名单键；undefined 不写入，空串保持原样。 */
export function selectInheritedDshEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED_DSH_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * 构建 DSH 子进程 env。
 * 先继承白名单，再覆盖服务端计算的注入项；注入项不接受任务/模型覆盖。
 */
export function buildDshRuntimeEnv(input: DshRuntimeEnvInput): Record<string, string> {
  const env = selectInheritedDshEnv(input.source);

  // 服务端计算项：路径全部来自 TaskRunner/Backend，不接受 Agent 参数。
  env.M0_SANDBOX_RUNNER = input.runnerPath;
  env.M0_SANDBOX_WORKDIR = input.workdir;
  env.M0_RESULTS_DIR = input.resultsDir;
  env.M0_ASSETS_DIR = input.assetsDir;
  env.M0_PROJECT_SKILL_DIR = input.skillsDir;
  env.RESULT_DIR = input.resultsDir;
  env.SANDBOX_RUN_ID = input.runId;
  env.SANDBOX_ATTEMPT = String(input.attempt);

  if (!input.deepseekApiKey) {
    throw new Error("[CONFIG] DEEPSEEK_API_KEY not set — cannot build dsh env");
  }
  env.DEEPSEEK_API_KEY = input.deepseekApiKey;

  if (profileRequiresDws(input.profile)) {
    if (!input.dbUser || !input.dbPassword) {
      throw new Error("[CONFIG] DWS account/password not set — cannot build dsh env for sdk profile");
    }
    // 只注入选定运行账号；DWS_RUN_USER/DWS_RUN_PASSWORD 原名不进入子进程。
    env.DWS_USER = input.dbUser;
    env.DWS_PASSWORD = input.dbPassword;
  }

  return env;
}
