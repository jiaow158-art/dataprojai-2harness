// S4-B2-C2-B1：可信运行时根。
//
// 安全约束：
//   - cleanup-locks / audit 目录必须位于显式 trustedRuntimeRoot 内，不得借用源码树、
//     task 工作区或平台 Temp 树。
//   - POSIX：目录非 symlink、属主=当前服务有效 UID/GID、权限严格 0700。
//   - 已存在目录权限错误时拒绝，不静默 chmod 放宽/收紧现场。
//   - 只创建缺失的单层目录（不 recursive 穿过未知父路径），创建后重新 lstat/realpath 验证。
//   - 不接触 Docker、进程、ACL 或任务状态。

import { lstat, mkdir, realpath } from "node:fs/promises";
import type { Stats } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface PrepareTrustedRuntimeOptions {
  root: string;
  cleanupLockDir?: string;
  auditDir?: string;
  /** 默认 true：仅创建缺失目录；已存在目录绝不 chmod。 */
  create?: boolean;
  /** 测试可注入；生产默认 process.platform。 */
  platform?: NodeJS.Platform;
  /** 默认当前服务有效 UID；测试可注入不匹配值验证拒绝路径。 */
  expectedUid?: number | null;
  /** 默认当前服务有效 GID；测试可注入不匹配值验证拒绝路径。 */
  expectedGid?: number | null;
  /** 运行根不得位于这些目录内；默认禁止平台 Temp 树。 */
  forbiddenRoots?: string[];
}

export interface TrustedRuntime {
  root: string;
  cleanupLockDir: string;
  auditDir: string;
  platform: NodeJS.Platform;
  expectedUid: number | null;
  expectedGid: number | null;
}

export class TrustedRuntimeError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "TrustedRuntimeError";
    this.code = code;
  }
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(MODULE_DIR, "../../..");

/**
 * 默认禁止的运行根父域：平台 Temp、当前 workdir、源码仓根。
 * 显式 forbiddenRoots 会替换本默认集合；C2-B2 必须同时包含这三项及
 * workroot/resultsRoot/reportsRoot 等生产任务根，不能只传任务根。
 */
export function defaultForbiddenRoots(): string[] {
  return Array.from(
    new Set(
      [resolve(tmpdir()), resolve(process.cwd()), REPOSITORY_ROOT].filter(
        // forbiddenRoots 含文件系统根会拒绝一切目标；cwd=/ 时不能把整个文件系统封死。
        (p) => p !== parse(p).root,
      ),
    ),
  );
}

function fail(code: string, message: string): never {
  throw new TrustedRuntimeError(code, message);
}

export function currentEffectiveUid(): number | null {
  const fn = (process as any).geteuid ?? (process as any).getuid;
  return typeof fn === "function" ? fn.call(process) : null;
}

export function currentEffectiveGid(): number | null {
  const fn = (process as any).getegid ?? (process as any).getgid;
  return typeof fn === "function" ? fn.call(process) : null;
}

export function posixSecurityApplies(platform: NodeJS.Platform): boolean {
  return platform !== "win32";
}

/**
 * 纯函数：目录 stat 是否满足可信目录要求。
 * - 必须目录，且调用方使用 lstat 保证 symlink 判定有效；
 * - POSIX 下 uid/gid 必须等于期望服务身份，mode 必须严格 0700；
 * - win32 不宣称 POSIX 权限语义（仍需 lstat 类型与 realpath 检查）。
 */
export function isSafeRuntimeDirectory(
  stat: Stats,
  platform: NodeJS.Platform,
  expectedUid: number | null,
  expectedGid: number | null,
): boolean {
  if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  if (!posixSecurityApplies(platform)) return true;
  if (expectedUid === null || expectedGid === null) return false;
  if (stat.uid !== expectedUid || stat.gid !== expectedGid) return false;
  return (stat.mode & 0o777) === 0o700;
}

function assertExpectedIdentity(
  platform: NodeJS.Platform,
  expectedUid: number | null,
  expectedGid: number | null,
): void {
  if (posixSecurityApplies(platform) && (expectedUid === null || expectedGid === null)) {
    fail("TRUSTED_IDENTITY_UNAVAILABLE", "POSIX trusted directories require the service effective UID/GID");
  }
}

/** 拒绝相对路径、文件系统根和过宽运行根。 */
export function assertRuntimeRootDepth(root: string, platform: NodeJS.Platform = process.platform): void {
  if (!isAbsolute(root)) fail("ROOT_NOT_ABSOLUTE", "trustedRuntimeRoot must be absolute");
  const normalized = resolve(root);
  if (normalized === parse(normalized).root) {
    fail("ROOT_TOO_BROAD", "trustedRuntimeRoot cannot be a filesystem root");
  }
  if (posixSecurityApplies(platform)) {
    const depth = normalized.split(sep).filter(Boolean).length;
    if (depth < 3) fail("ROOT_TOO_BROAD", "trustedRuntimeRoot must have at least 3 path segments");
  }
}

export function assertRootNotForbidden(root: string, forbiddenRoots: readonly string[] = []): void {
  const target = resolve(root);
  for (const raw of forbiddenRoots) {
    const forbidden = resolve(raw);
    const rel = relative(forbidden, target);
    const inside =
      rel === "" ||
      (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    if (inside) {
      fail("ROOT_FORBIDDEN", `trustedRuntimeRoot is inside forbidden root ${forbidden}`);
    }
  }
}

/** target 必须是 base 的严格子路径（不能等于 base）。 */
export function assertPathStrictlyInside(base: string, target: string, label: string): string {
  const b = resolve(base);
  const t = resolve(target);
  const rel = relative(b, t);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    fail("PATH_OUTSIDE_TRUSTED_ROOT", `${label} must be strictly inside trustedRuntimeRoot`);
  }
  return t;
}

async function lstatOrFail(path: string, code: string, label: string): Promise<Stats> {
  try {
    return await lstat(path);
  } catch {
    fail(code, `${label} is missing or not accessible`);
  }
}

async function validateDirectory(
  path: string,
  platform: NodeJS.Platform,
  expectedUid: number | null,
  expectedGid: number | null,
  label: string,
): Promise<Stats> {
  const st = await lstatOrFail(path, "TRUSTED_DIR_MISSING", label);
  if (!st.isDirectory() || st.isSymbolicLink()) {
    fail("TRUSTED_DIR_UNSAFE", `${label} must be a non-symlink directory`);
  }
  if (!isSafeRuntimeDirectory(st, platform, expectedUid, expectedGid)) {
    fail("TRUSTED_DIR_UNSAFE", `${label} must be owned by service UID/GID with mode 0700`);
  }
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    fail("TRUSTED_DIR_UNSAFE", `${label} realpath failed`);
  }
  if (real !== resolve(path)) {
    fail("TRUSTED_DIR_UNSAFE", `${label} contains symlink components`);
  }
  return st;
}

export interface ValidateTrustedDirectoryOptions {
  platform?: NodeJS.Platform;
  expectedUid?: number | null;
  expectedGid?: number | null;
  label?: string;
}

/** 供 audit 等模块复用的单目录校验；不创建、不修改。 */
export async function validateTrustedDirectory(
  path: string,
  opts: ValidateTrustedDirectoryOptions = {},
): Promise<Stats> {
  const platform = opts.platform ?? process.platform;
  const expectedUid = opts.expectedUid === undefined ? currentEffectiveUid() : opts.expectedUid;
  const expectedGid = opts.expectedGid === undefined ? currentEffectiveGid() : opts.expectedGid;
  assertExpectedIdentity(platform, expectedUid, expectedGid);
  return validateDirectory(path, platform, expectedUid, expectedGid, opts.label ?? "trusted directory");
}

/**
 * 创建前检查所有已存在的父路径段，拒绝任何 symlink/非目录段。
 * 避免 mkdir 先穿过符号链接在真实目标里创建目录，再靠 realpath 发现。
 */
async function assertSafeAncestors(path: string, label: string): Promise<void> {
  const target = resolve(path);
  const root = parse(target).root;
  const parts = relative(root, target).split(sep).filter(Boolean);
  let current = root;
  for (let i = 0; i < parts.length - 1; i++) {
    current = join(current, parts[i]);
    let st: Stats;
    try {
      st = await lstat(current);
    } catch (e) {
      if ((e as { code?: string }).code === "ENOENT") return;
      fail("TRUSTED_DIR_UNSAFE", `${label} parent cannot be inspected`);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      fail("TRUSTED_DIR_UNSAFE", `${label} parent contains symlink/non-directory component`);
    }
  }
}

async function ensureDirectory(
  path: string,
  create: boolean,
  platform: NodeJS.Platform,
  expectedUid: number | null,
  expectedGid: number | null,
  label: string,
): Promise<Stats> {
  let st: Stats | null = null;
  try {
    st = await lstat(path);
  } catch (e) {
    if ((e as { code?: string }).code !== "ENOENT") {
      fail("TRUSTED_DIR_UNSAFE", `${label} cannot be inspected`);
    }
  }
  if (st) {
    return validateDirectory(path, platform, expectedUid, expectedGid, label);
  }
  if (!create) fail("TRUSTED_DIR_MISSING", `${label} is missing (create=false)`);
  try {
    // 单层创建：父目录必须已存在且可信；不可 recursive 穿过未知父路径。
    await mkdir(path, { mode: 0o700 });
  } catch {
    fail("TRUSTED_DIR_CREATE_FAILED", `${label} cannot be created without traversing unsafe parents`);
  }
  return validateDirectory(path, platform, expectedUid, expectedGid, label);
}

/**
 * 创建并校验可信运行根及 cleanup-locks / audit 子目录。
 * 已存在目录绝不修改权限；任何不安全现场 fail-closed。
 */
export async function prepareTrustedRuntime(opts: PrepareTrustedRuntimeOptions): Promise<TrustedRuntime> {
  if (opts === null || typeof opts !== "object" || typeof opts.root !== "string" || !opts.root) {
    fail("ROOT_INVALID", "trustedRuntimeRoot is required");
  }
  if (!isAbsolute(opts.root)) fail("ROOT_NOT_ABSOLUTE", "trustedRuntimeRoot must be absolute");
  const platform = opts.platform ?? process.platform;
  const root = resolve(opts.root);
  const cleanupLockDir = resolve(opts.cleanupLockDir ?? join(root, "cleanup-locks"));
  const auditDir = resolve(opts.auditDir ?? join(root, "audit"));
  const create = opts.create ?? true;
  const expectedUid = opts.expectedUid === undefined ? currentEffectiveUid() : opts.expectedUid;
  const expectedGid = opts.expectedGid === undefined ? currentEffectiveGid() : opts.expectedGid;
  const forbiddenRoots = opts.forbiddenRoots ?? defaultForbiddenRoots();
  assertExpectedIdentity(platform, expectedUid, expectedGid);

  assertRuntimeRootDepth(root, platform);
  assertRootNotForbidden(root, forbiddenRoots);
  assertPathStrictlyInside(root, cleanupLockDir, "cleanupLockDir");
  assertPathStrictlyInside(root, auditDir, "auditDir");
  await assertSafeAncestors(root, "trustedRuntimeRoot");

  await ensureDirectory(root, create, platform, expectedUid, expectedGid, "trustedRuntimeRoot");
  await ensureDirectory(cleanupLockDir, create, platform, expectedUid, expectedGid, "cleanupLockDir");
  await ensureDirectory(auditDir, create, platform, expectedUid, expectedGid, "auditDir");

  return {
    root,
    cleanupLockDir,
    auditDir,
    platform,
    expectedUid,
    expectedGid,
  };
}
