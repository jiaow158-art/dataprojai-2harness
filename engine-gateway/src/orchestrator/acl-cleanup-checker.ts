// S4-B2-C2-B1：Linux ACL 只读清理检查。
//
// 不做 restore、不改 ACL；只判断是否可安全宣称 ACL 已无 65534 残留。
//   - .acl.bak / .acl.snap 任一存在 → pending（C3 restore-only 未实现）；
//   - 只有空闲 .lock → 不算残留；
//   - Linux 用 getfacl -RPncp 扫描 workdir/results/assets 的 user:65534 条目（-P 不跟随 symlink）；
//   - Linux 永远 required，不得 not_applicable；win32 仅 platform 依据 N/A。
//
// 注意：passed 只代表「当前扫描无 65534 残留」，不等于与执行前 ACL 全量完全相同；
// 全量基线比对属于 Runner 成功恢复时的 acl_verify（删除 .snap 前完成），本模块不重做。
//
// 本模块不连接 DWS，不启动 Runner，不触碰任务状态。

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  currentEffectiveGid,
  currentEffectiveUid,
  isSafeRuntimeDirectory,
  posixSecurityApplies,
} from "../config/trusted-runtime.ts";
import type { CleanupApplicability, CleanupEvidence, CleanupStatus } from "./cleanup-report.ts";

export interface AclCleanupTarget {
  workdir: string;
  resultsDir: string;
  assetsDir: string;
  aclStateDir: string;
}

export interface GetfaclResult {
  code: number;
  stdout: string;
  stderr: string;
  errorCode?: string;
  timedOut?: boolean;
}

export interface AclCleanupDeps {
  platform?: NodeJS.Platform;
  expectedUid?: number | null;
  expectedGid?: number | null;
  getfaclPath?: string;
  runGetfacl?: (path: string) => Promise<GetfaclResult>;
  getfaclTimeoutMs?: number;
  getfaclMaxBuffer?: number;
}

export interface AclCleanupResult {
  status: CleanupStatus;
  required: boolean;
  reason: string;
  evidence: CleanupEvidence;
  applicability?: CleanupApplicability;
}

export class AclCleanupError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "AclCleanupError";
    this.code = code;
  }
}

const DEFAULT_GETFACL_TIMEOUT_MS = 60_000;
const DEFAULT_GETFACL_MAX_BUFFER = 32 * 1024 * 1024;
const RESIDUAL_RE = /^(?:default:)?user:65534:/gm;

function result(
  status: CleanupStatus,
  required: boolean,
  reason: string,
  evidence: CleanupEvidence = {},
  applicability?: CleanupApplicability,
): AclCleanupResult {
  return {
    status,
    required,
    reason,
    evidence,
    ...(applicability ? { applicability } : {}),
  };
}

function aclKey(workdirReal: string): string {
  return createHash("sha256").update(workdirReal).digest("hex").slice(0, 16);
}

async function defaultRunGetfacl(
  path: string,
  getfaclPath: string,
  timeoutMs: number,
  maxBuffer: number,
): Promise<GetfaclResult> {
  return new Promise((resolvePromise) => {
    execFile(
      getfaclPath,
      ["-R", "-P", "-n", "-p", "-c", "--absolute-names", "--", path],
      { encoding: "utf8", timeout: timeoutMs, maxBuffer, windowsHide: true },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null;
        const code = e ? (typeof (e as { code?: unknown }).code === "number" ? (e as { code: number }).code : -1) : 0;
        resolvePromise({
          code,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          ...(typeof e?.code === "string" ? { errorCode: e.code } : {}),
          ...(e?.killed ? { timedOut: true } : {}),
        });
      },
    );
  });
}

async function realDir(path: string): Promise<string | null> {
  try {
    const st = await lstat(path);
    if (!st.isDirectory() || st.isSymbolicLink()) return null;
    const real = await realpath(path);
    return real === resolve(path) ? real : null;
  } catch {
    return null;
  }
}

async function inspectStateFile(path: string): Promise<"missing" | "file" | "unsafe"> {
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink() || !st.isFile()) return "unsafe";
    return "file";
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return "missing";
    return "unsafe";
  }
}

type StateInspection =
  | { kind: "missing" }
  | { kind: "unsafe" }
  | { kind: "pending"; stateFiles: number }
  | { kind: "clean" };

/**
 * 检查 ACL 状态目录及本轮 key 的 .bak/.snap/.lock。
 * 非 ENOENT 的 lstat 失败一律 unsafe（不能当成“没有备份”）。
 */
async function inspectAclState(
  stateDir: string,
  workdirReal: string,
  key: string,
  platform: NodeJS.Platform,
  uid: number | null,
  gid: number | null,
): Promise<StateInspection> {
  let stateStat: Stats;
  try {
    stateStat = await lstat(stateDir);
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return { kind: "missing" };
    return { kind: "unsafe" };
  }
  if (!isSafeRuntimeDirectory(stateStat, platform, uid, gid)) return { kind: "unsafe" };
  let stateReal: string;
  try {
    stateReal = await realpath(stateDir);
  } catch {
    return { kind: "unsafe" };
  }
  if (stateReal !== resolve(stateDir)) return { kind: "unsafe" };
  // 状态目录不得位于任务可写 workdir 内，否则模型可篡改恢复证据。
  const wdPrefix = workdirReal.endsWith("/") ? workdirReal : `${workdirReal}/`;
  if (stateReal === workdirReal || stateReal.startsWith(wdPrefix)) return { kind: "unsafe" };

  const bak = await inspectStateFile(`${stateDir}/${key}.acl.bak`);
  const snap = await inspectStateFile(`${stateDir}/${key}.acl.snap`);
  const lock = await inspectStateFile(`${stateDir}/${key}.lock`);
  if (bak === "unsafe" || snap === "unsafe" || lock === "unsafe") return { kind: "unsafe" };
  const stateFiles = (bak === "file" ? 1 : 0) + (snap === "file" ? 1 : 0);
  // .lock 是长期协调文件，单独存在不构成残留。
  if (stateFiles > 0) return { kind: "pending", stateFiles };
  return { kind: "clean" };
}

/**
 * 只读检查；会实际调用 getfacl 验证 65534 残留。
 * 任何无法验证的 Linux 现场都返回 failed/pending，不返回 passed。
 */
export async function checkAclCleanup(
  target: AclCleanupTarget,
  deps: AclCleanupDeps = {},
): Promise<AclCleanupResult> {
  if (target === null || typeof target !== "object") {
    throw new AclCleanupError("ACL_TARGET_INVALID", "target is required");
  }
  for (const key of ["workdir", "resultsDir", "assetsDir", "aclStateDir"] as const) {
    if (typeof target[key] !== "string" || !target[key] || !isAbsolute(target[key])) {
      throw new AclCleanupError("ACL_TARGET_INVALID", `${key} must be an absolute path`);
    }
  }

  const platform = deps.platform ?? process.platform;
  if (platform === "win32") {
    return result(
      "not_applicable",
      false,
      "ACL_NOT_APPLICABLE_PLATFORM",
      { platform: "win32" },
      { basis: "platform", detail: "win32" },
    );
  }
  if (platform !== "linux") {
    return result("pending", true, "ACL_PLATFORM_UNVERIFIABLE", { platform: "other" });
  }

  const uid = deps.expectedUid === undefined ? currentEffectiveUid() : deps.expectedUid;
  const gid = deps.expectedGid === undefined ? currentEffectiveGid() : deps.expectedGid;
  if (!posixSecurityApplies(platform) || uid === null || gid === null) {
    return result("pending", true, "ACL_IDENTITY_UNVERIFIABLE", { platform: "linux" });
  }

  const workdirReal = await realDir(target.workdir);
  if (!workdirReal) return result("failed", true, "ACL_WORKDIR_MISSING", { platform: "linux" });
  const resultsReal = await realDir(target.resultsDir);
  if (!resultsReal) return result("failed", true, "ACL_RESULTS_MISSING", { platform: "linux" });
  const assetsReal = await realDir(target.assetsDir);
  if (!assetsReal) return result("failed", true, "ACL_ASSETS_MISSING", { platform: "linux" });

  const stateDir = resolve(target.aclStateDir);
  const key = aclKey(workdirReal);
  const initial = await inspectAclState(stateDir, workdirReal, key, platform, uid, gid);
  if (initial.kind === "unsafe") {
    return result("failed", true, "ACL_STATE_UNSAFE", { platform: "linux" });
  }
  if (initial.kind === "pending") {
    // C3 restore-only 未实现：有备份/快照只能 pending，不能假装已恢复。
    return result("pending", true, "ACL_RESTORE_PENDING_C3", {
      platform: "linux",
      aclStateFiles: initial.stateFiles,
    });
  }

  const runGetfacl = deps.runGetfacl ?? ((path: string) =>
    defaultRunGetfacl(
      path,
      deps.getfaclPath ?? "getfacl",
      deps.getfaclTimeoutMs ?? DEFAULT_GETFACL_TIMEOUT_MS,
      deps.getfaclMaxBuffer ?? DEFAULT_GETFACL_MAX_BUFFER,
    ));

  let residual = 0;
  for (const path of [workdirReal, resultsReal, assetsReal]) {
    let scan: GetfaclResult;
    try {
      scan = await runGetfacl(path);
    } catch {
      return result("failed", true, "ACL_CHECK_FAILED", { platform: "linux" });
    }
    if (scan.errorCode === "ENOENT") {
      return result("failed", true, "ACL_GETFACL_UNAVAILABLE", { platform: "linux" });
    }
    if (scan.timedOut) {
      return result("failed", true, "ACL_CHECK_FAILED", { platform: "linux" });
    }
    if (scan.code !== 0) {
      return result("failed", true, "ACL_CHECK_FAILED", { platform: "linux" });
    }
    const matches = scan.stdout.match(RESIDUAL_RE);
    residual += matches ? matches.length : 0;
  }

  // 扫描期间状态目录/备份可能变化；不能只在开始时看一次。
  const after = await inspectAclState(stateDir, workdirReal, key, platform, uid, gid);
  if (after.kind === "unsafe") {
    return result("failed", true, "ACL_STATE_UNSAFE", { platform: "linux", aclResidualEntries: residual });
  }
  if (after.kind === "pending") {
    return result("pending", true, "ACL_RESTORE_PENDING_C3", {
      platform: "linux",
      aclStateFiles: after.stateFiles,
      aclResidualEntries: residual,
    });
  }
  if (initial.kind !== "missing" && after.kind === "missing") {
    // 开始的 ACL 状态目录在扫描期间消失：无法证明恢复完成，不能当 clean。
    return result("failed", true, "ACL_STATE_CHANGED", { platform: "linux", aclResidualEntries: residual });
  }

  if (residual > 0) {
    return result("failed", true, "ACL_RESIDUAL_GRANT", {
      platform: "linux",
      aclResidualEntries: residual,
      aclVerifiedWith: "getfacl",
    });
  }
  // 只证明“本次 getfacl 无 65534 残留”；不代表与执行前 ACL 全量完全相同。
  return result("passed", true, "ACL_NO_65534_RESIDUAL", {
    platform: "linux",
    aclStateFiles: 0,
    aclResidualEntries: 0,
    aclVerifiedWith: "getfacl",
  });
}
