// S4-B2-C2-B2-1：清理模式策略解析。
//
// 约束：
//   - 默认 off；只有显式 linux_isolated 才可能启用；
//   - Windows 无论配置什么一律强制 off，且不读取/校验 Linux 清理配置；
//   - Linux 只有 linux_isolated + DSH_PROFILE=sdk-s4b 才允许解析通过；
//   - 当前只解析策略，不创建可信运行根、不接触 Docker/ACL/进程；
//   - 非法配置 fail-closed（CleanupPolicyError），绝不静默回退到启用；
//   - 不修改 DSH_PROFILE 的默认 sdk 行为，只读取现有解析器结果。
//
// 该模块是纯函数；调用方（server/index.ts）在 C2-B2-2 才负责装配。

import { isAbsolute, parse, relative, resolve, sep } from "node:path";
import { resolveDshProfile } from "./dsh-profile.ts";
import { defaultForbiddenRoots } from "./trusted-runtime.ts";

export type CleanupMode = "off" | "linux_isolated";
export type CleanupOffReason =
  | "default"
  | "explicit_off"
  | "platform_win32"
  | "platform_unsupported";

export interface CleanupPolicyOff {
  mode: "off";
  reason: CleanupOffReason;
  platform: NodeJS.Platform;
}

export interface CleanupPolicyEnabled {
  mode: "linux_isolated";
  reason: "enabled";
  platform: "linux";
  profile: "sdk-s4b";
  runtimeRoot: string;
  aclStateDir: string;
  trustedImageId: string;
}

export type CleanupPolicy = CleanupPolicyOff | CleanupPolicyEnabled;

export interface ResolveCleanupPolicyOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** 测试可注入；默认 platform Temp / cwd / 仓库根。 */
  forbiddenRoots?: string[];
}

export class CleanupPolicyError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(`[CONFIG] [${code}] ${message}`);
    this.name = "CleanupPolicyError";
    this.code = code;
  }
}

const MODE_ENV = "GATEWAY_CLEANUP_MODE";
const RUNTIME_ROOT_ENV = "GATEWAY_CLEANUP_RUNTIME_ROOT";
const ACL_STATE_DIR_ENV = "SANDBOX_ACL_STATE_DIR";
const TRUSTED_IMAGE_ENV = "GATEWAY_CLEANUP_TRUSTED_IMAGE_ID";

const MODES = new Set<CleanupMode>(["off", "linux_isolated"]);
const TRUSTED_IMAGE_RE = /^sha256:[0-9a-f]{64}$/i;
const CONTROL_RE = /[\x00-\x1f\x7f]/;
const MAX_CONFIG_PATH_LENGTH = 4096;

function fail(code: string, message: string): never {
  throw new CleanupPolicyError(code, message);
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * 校验清理模式使用的可信路径。只检查形态，不检查存在性/属主/权限：
 * 那些属于 trusted-runtime 的启动装配阶段。
 */
function validateConfiguredPath(
  raw: unknown,
  label: string,
  code: string,
  forbiddenRoots: readonly string[],
): string {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.length > MAX_CONFIG_PATH_LENGTH ||
    CONTROL_RE.test(raw) ||
    !isAbsolute(raw)
  ) {
    fail(code, `${label} must be a non-empty absolute path`);
  }
  const path = resolve(raw);
  if (path === parse(path).root) {
    fail(code, `${label} cannot be a filesystem root`);
  }
  const depth = path.split(sep).filter(Boolean).length;
  if (depth < 3) {
    fail(code, `${label} is too broad (at least 3 path segments required)`);
  }
  for (const forbidden of forbiddenRoots) {
    if (isInside(forbidden, path)) {
      fail(code, `${label} is inside a forbidden root (Temp/cwd/repository)`);
    }
  }
  return path;
}

function validateTrustedImageId(raw: unknown): string {
  if (typeof raw !== "string" || !TRUSTED_IMAGE_RE.test(raw)) {
    fail(
      "CLEANUP_TRUSTED_IMAGE_INVALID",
      `${TRUSTED_IMAGE_ENV} must be a docker image ID of the form sha256:<64 hex>`,
    );
  }
  return raw.toLowerCase();
}

function configuredMode(env: NodeJS.ProcessEnv): CleanupMode | null {
  const raw = env[MODE_ENV];
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" || !MODES.has(raw as CleanupMode)) {
    fail("CLEANUP_MODE_INVALID", `${MODE_ENV} must be one of: off, linux_isolated`);
  }
  return raw as CleanupMode;
}

/**
 * 解析清理模式。纯函数，无文件系统/网络/进程副作用。
 *
 * Windows 在任何配置下返回 off；这是唯一活跃 Scheduler 的硬边界，避免
 * terminateAndVerify 的 Windows pending 把现有问数任务全部判失败。
 */
export function resolveCleanupPolicy(opts: ResolveCleanupPolicyOptions = {}): CleanupPolicy {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;

  if (platform === "win32") {
    return { mode: "off", reason: "platform_win32", platform };
  }

  const mode = configuredMode(env);
  if (mode === null) {
    return {
      mode: "off",
      reason: platform === "linux" ? "default" : "platform_unsupported",
      platform,
    };
  }
  if (mode === "off") {
    return { mode: "off", reason: "explicit_off", platform };
  }

  if (platform !== "linux") {
    fail("CLEANUP_PLATFORM_UNSUPPORTED", `${MODE_ENV}=linux_isolated is only supported on Linux`);
  }

  // profileRequiresDws=false 的隔离测试 Profile；默认 sdk 不允许启用清理门禁。
  const profile = resolveDshProfile(env);
  if (profile !== "sdk-s4b") {
    fail(
      "CLEANUP_PROFILE_REQUIRED",
      `${MODE_ENV}=linux_isolated requires DSH_PROFILE=sdk-s4b (got ${profile})`,
    );
  }

  const forbiddenRoots = opts.forbiddenRoots ?? defaultForbiddenRoots();
  const runtimeRoot = validateConfiguredPath(
    env[RUNTIME_ROOT_ENV],
    RUNTIME_ROOT_ENV,
    "CLEANUP_RUNTIME_ROOT_INVALID",
    forbiddenRoots,
  );
  const aclStateDir = validateConfiguredPath(
    env[ACL_STATE_DIR_ENV],
    ACL_STATE_DIR_ENV,
    "CLEANUP_ACL_STATE_DIR_INVALID",
    forbiddenRoots,
  );
  if (runtimeRoot === aclStateDir) {
    fail(
      "CLEANUP_PATH_CONFLICT",
      `${RUNTIME_ROOT_ENV} and ${ACL_STATE_DIR_ENV} must be different directories`,
    );
  }
  const trustedImageId = validateTrustedImageId(env[TRUSTED_IMAGE_ENV]);

  return {
    mode: "linux_isolated",
    reason: "enabled",
    platform: "linux",
    profile: "sdk-s4b",
    runtimeRoot,
    aclStateDir,
    trustedImageId,
  };
}
