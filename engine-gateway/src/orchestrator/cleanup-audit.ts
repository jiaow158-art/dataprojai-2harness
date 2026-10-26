// S4-B2-C2-B1：可信 JSONL 清理审计。
//
// 约束：
//   - 审计目录必须是 trustedRuntimeRoot 下 0700、服务有效 UID/GID 所有的目录；
//   - 审计文件 0600、普通文件、非 symlink；打开时持 fd 并记录 dev/ino；
//   - 每次写入前复核目录与文件身份，路径被替换时拒绝继续并显式失败；
//   - 每次 append 都写整行并 fsync；失败通过返回值暴露，绝不当成功；
//   - 事件只接受扁平 code-only 值，不接受路径/脚本/嵌套对象。
//
// 本模块不清理资源；物理清理在审计写失败后仍应继续（由上层保证），但不得产生成功终态。

import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  assertPathStrictlyInside,
  currentEffectiveGid,
  currentEffectiveUid,
  posixSecurityApplies,
  validateTrustedDirectory,
} from "../config/trusted-runtime.ts";

export interface CleanupAuditOptions {
  trustedRuntimeRoot: string;
  auditLogPath: string;
  platform?: NodeJS.Platform;
  expectedUid?: number | null;
  expectedGid?: number | null;
  /** 测试注入；默认 handle.sync()。失败会显式返回 AUDIT_FSYNC_FAILED。 */
  syncFile?: (handle: FileHandle) => Promise<void>;
  /** 测试注入；默认 new Date().toISOString()。 */
  now?: () => string;
}

export interface AuditAppendResult {
  ok: boolean;
  code?: string;
  bytes?: number;
}

export class CleanupAuditError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "CleanupAuditError";
    this.code = code;
  }
}

const AUDIT_EVENT_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const AUDIT_STRING_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,255}$/;
const SENSITIVE_KEY_RE = /(^|_)(password|passwd|pwd|token|secret|api_?key|authorization|credential)(_|$)/i;
const GITHUB_PAT_PREFIX = "git" + "hub_pat_";
const SECRET_VALUE_RE = new RegExp(
  `(?:sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|${GITHUB_PAT_PREFIX}[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})`,
  "i",
);
const CONTROL_RE = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
);
const MAX_EVENT_LINE_BYTES = 64 * 1024;

function fail(code: string, message: string): never {
  throw new CleanupAuditError(code, message);
}

function validateFileStat(
  st: Stats,
  platform: NodeJS.Platform,
  expectedUid: number | null,
  expectedGid: number | null,
): boolean {
  if (!st.isFile() || st.isSymbolicLink()) return false;
  if (!posixSecurityApplies(platform)) return true;
  if (expectedUid !== null && st.uid !== expectedUid) return false;
  if (expectedGid !== null && st.gid !== expectedGid) return false;
  return (st.mode & 0o777) === 0o600;
}

function validateAuditEvent(event: unknown): Record<string, string | number | boolean | null> {
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    fail("AUDIT_EVENT_INVALID", "audit event must be a flat object");
  }
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(event)) {
    if (!AUDIT_EVENT_KEY_RE.test(key)) {
      fail("AUDIT_EVENT_INVALID", "audit event keys must be safe identifiers");
    }
    if (SENSITIVE_KEY_RE.test(key)) {
      fail("AUDIT_EVENT_INVALID", "audit event keys must not be credential fields");
    }
    if (key === "ts") fail("AUDIT_EVENT_INVALID", "audit event must not supply ts");
    if (value === undefined) continue;
    if (value === null) {
      out[key] = null;
    } else if (typeof value === "string") {
      // code-only：拒绝路径、脚本、空格/等号/Bearer 形态和已知密钥前缀。
      if (
        value.length > 256 ||
        CONTROL_RE.test(value) ||
        !AUDIT_STRING_RE.test(value) ||
        SECRET_VALUE_RE.test(value)
      ) {
        fail("AUDIT_EVENT_INVALID", "audit string values must be short code-only tokens");
      }
      out[key] = value;
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) fail("AUDIT_EVENT_INVALID", "audit numbers must be finite");
      out[key] = value;
    } else if (typeof value === "boolean") {
      out[key] = value;
    } else {
      fail("AUDIT_EVENT_INVALID", "audit values must be string/number/boolean/null");
    }
  }
  return out;
}

export class CleanupAuditLog {
  private readonly root: string;
  private readonly auditDir: string;
  private readonly auditLogPath: string;
  private readonly platform: NodeJS.Platform;
  private readonly expectedUid: number | null;
  private readonly expectedGid: number | null;
  private readonly syncFile: (handle: FileHandle) => Promise<void>;
  private readonly now: () => string;
  private handle: FileHandle | null = null;
  private dev = "";
  private ino = "";
  private failures = 0;
  private successfulEvents = 0;
  private fatal = false;
  private closed = false;
  private closeQueued = false;
  private closePromise: Promise<AuditAppendResult> | null = null;
  private tail: Promise<unknown> = Promise.resolve();

  private constructor(opts: CleanupAuditOptions, handle: FileHandle, dev: string, ino: string) {
    this.root = resolve(opts.trustedRuntimeRoot);
    this.auditDir = resolve(dirname(opts.auditLogPath));
    this.auditLogPath = resolve(opts.auditLogPath);
    this.platform = opts.platform ?? process.platform;
    this.expectedUid = opts.expectedUid === undefined ? currentEffectiveUid() : opts.expectedUid;
    this.expectedGid = opts.expectedGid === undefined ? currentEffectiveGid() : opts.expectedGid;
    this.syncFile = opts.syncFile ?? ((h: FileHandle) => h.sync());
    this.now = opts.now ?? (() => new Date().toISOString());
    this.handle = handle;
    this.dev = dev;
    this.ino = ino;
  }

  static async open(opts: CleanupAuditOptions): Promise<CleanupAuditLog> {
    if (opts === null || typeof opts !== "object") fail("AUDIT_OPTIONS_INVALID", "audit options are required");
    if (!opts.trustedRuntimeRoot || !opts.auditLogPath) {
      fail("AUDIT_OPTIONS_INVALID", "trustedRuntimeRoot and auditLogPath are required");
    }
    const root = resolve(opts.trustedRuntimeRoot);
    const auditLogPath = assertPathStrictlyInside(root, opts.auditLogPath, "auditLogPath");
    const platform = opts.platform ?? process.platform;
    const expectedUid = opts.expectedUid === undefined ? currentEffectiveUid() : opts.expectedUid;
    const expectedGid = opts.expectedGid === undefined ? currentEffectiveGid() : opts.expectedGid;
    const auditDir = resolve(dirname(auditLogPath));

    // 根和 audit 目录都必须已经由 trusted-runtime 预创建并通过同一套规则校验。
    await validateTrustedDirectory(root, { platform, expectedUid, expectedGid, label: "trustedRuntimeRoot" });
    await validateTrustedDirectory(auditDir, { platform, expectedUid, expectedGid, label: "auditDir" });

    let before: Stats | null = null;
    try {
      before = await lstat(auditLogPath);
    } catch (e) {
      if ((e as { code?: string }).code !== "ENOENT") {
        fail("AUDIT_TARGET_UNSAFE", "audit log cannot be inspected");
      }
    }
    if (before && !before.isFile()) {
      fail("AUDIT_TARGET_UNSAFE", "audit log must be a regular file (symlinks rejected)");
    }
    // 拒绝路径末段 symlink；O_NOFOLLOW / O_CLOEXEC 仅 POSIX 提供。
    const noFollow = typeof (constants as any).O_NOFOLLOW === "number" ? (constants as any).O_NOFOLLOW : 0;
    const cloExec = typeof (constants as any).O_CLOEXEC === "number" ? (constants as any).O_CLOEXEC : 0;
    const flags =
      constants.O_APPEND | constants.O_WRONLY | (before ? 0 : constants.O_CREAT) | noFollow | cloExec;
    let handle: FileHandle;
    try {
      handle = await open(auditLogPath, flags, 0o600);
    } catch {
      fail("AUDIT_OPEN_FAILED", "audit log cannot be opened with 0600/no-follow");
    }

    try {
      const fst = await handle.stat();
      if (!validateFileStat(fst, platform, expectedUid, expectedGid)) {
        fail("AUDIT_TARGET_UNSAFE", "audit log ownership/type/mode is unsafe");
      }
      const after = await lstat(auditLogPath);
      if (
        !validateFileStat(after, platform, expectedUid, expectedGid) ||
        String(after.dev) !== String(fst.dev) ||
        String(after.ino) !== String(fst.ino)
      ) {
        fail("AUDIT_TARGET_UNSAFE", "audit log path changed during open");
      }
      return new CleanupAuditLog(opts, handle, String(fst.dev), String(fst.ino));
    } catch (e) {
      try { await handle.close(); } catch { /* ignore */ }
      throw e;
    }
  }

  get auditLogPathValue(): string {
    return this.auditLogPath;
  }

  get auditOk(): boolean {
    return this.failures === 0 && !this.fatal;
  }

  get failureCount(): number {
    return this.failures;
  }

  get eventCount(): number {
    return this.successfulEvents;
  }

  async append(event: Record<string, unknown>): Promise<AuditAppendResult> {
    if (this.closeQueued) return this.failWrite("AUDIT_CLOSED");
    const run = async (): Promise<AuditAppendResult> => this.appendSerialized(event);
    const result = this.tail.then(run, run);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async appendSerialized(event: Record<string, unknown>): Promise<AuditAppendResult> {
    if (this.closed || !this.handle) return this.failWrite("AUDIT_CLOSED");
    if (this.fatal) return this.failWrite("AUDIT_DISABLED");

    let validated: Record<string, string | number | boolean | null>;
    try {
      validated = validateAuditEvent(event);
    } catch (e) {
      return this.failWrite((e as CleanupAuditError).code ?? "AUDIT_EVENT_INVALID");
    }

    try {
      await validateTrustedDirectory(this.auditDir, {
        platform: this.platform,
        expectedUid: this.expectedUid,
        expectedGid: this.expectedGid,
        label: "auditDir",
      });
      const current = await lstat(this.auditLogPath);
      if (!validateFileStat(current, this.platform, this.expectedUid, this.expectedGid)) {
        this.fatal = true;
        return this.failWrite("AUDIT_TARGET_UNSAFE");
      }
      if (String(current.dev) !== this.dev || String(current.ino) !== this.ino) {
        this.fatal = true;
        return this.failWrite("AUDIT_FILE_REPLACED");
      }
    } catch {
      this.fatal = true;
      return this.failWrite("AUDIT_TARGET_UNSAFE");
    }

    let line: string;
    try {
      line = `${JSON.stringify({ ts: this.nowValue(), ...validated })}\n`;
    } catch {
      return this.failWrite("AUDIT_TIME_INVALID");
    }
    const buf = Buffer.from(line, "utf8");
    if (buf.length > MAX_EVENT_LINE_BYTES) {
      return this.failWrite("AUDIT_EVENT_TOO_LARGE");
    }

    try {
      let offset = 0;
      while (offset < buf.length) {
        const { bytesWritten } = await this.handle.write(buf, offset, buf.length - offset, null);
        if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0) {
          throw new Error("short audit write");
        }
        offset += bytesWritten;
      }
    } catch {
      return this.failWrite("AUDIT_WRITE_FAILED");
    }

    try {
      await this.syncFile(this.handle);
    } catch {
      return this.failWrite("AUDIT_FSYNC_FAILED");
    }

    this.successfulEvents += 1;
    return { ok: true, bytes: buf.length };
  }

  private failWrite(code: string): AuditAppendResult {
    this.failures += 1;
    return { ok: false, code };
  }

  private nowValue(): string {
    const ts = this.now();
    if (typeof ts !== "string" || ts.length === 0 || ts.length > 64 || CONTROL_RE.test(ts)) {
      throw new CleanupAuditError("AUDIT_TIME_INVALID", "audit timestamp must be a short control-free string");
    }
    return ts;
  }

  async close(): Promise<AuditAppendResult> {
    if (this.closePromise) return this.closePromise;
    if (this.closed) {
      return { ok: this.failures === 0, ...(this.failures ? { code: "AUDIT_CLOSE_FAILED" } : {}) };
    }
    // 先在 tail 末尾排队关闭，保证此前已入队的 append 完整执行；新 append 立即被拒。
    const run = async (): Promise<AuditAppendResult> => {
      this.closed = true;
      if (!this.handle) return this.failWrite("AUDIT_CLOSE_FAILED");
      const h = this.handle;
      this.handle = null;
      try {
        await h.close();
        return this.failures === 0 ? { ok: true } : { ok: false, code: "AUDIT_CLOSE_FAILED" };
      } catch {
        return this.failWrite("AUDIT_CLOSE_FAILED");
      }
    };
    this.closeQueued = true;
    const result = this.tail.then(run, run);
    this.closePromise = result;
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
