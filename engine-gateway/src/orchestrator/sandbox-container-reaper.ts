// S4-B2-C1：受控沙箱容器的精确归属识别与清理。
//
// 安全边界：
//   - 只接受 Gateway 可信调用方提供的 run_id/attempt；不接收任意 Docker 过滤条件。
//   - 先按三个 label 精确查询，再 docker inspect 二次校验：
//       managed=true + run_id + attempt + 严格容器名 + 启动时可信镜像 ID。
//   - 任一候选不匹配 → 不删除任何容器，返回 OWNERSHIP_MISMATCH。
//   - docker ps 查询失败绝不当作“无容器”；inspect 的 No such object 才按已消失处理。
//   - per-attempt cleanup lock 防止并发 reaper 重复 stop/rm。
//   - Docker 命令全部使用 execFile argv，不拼接 shell 字符串。
//   - 审计只记录 run/attempt/container 元数据、动作、退出码与消毒后的短错误；
//     不记录 env、脚本内容、Key/Token/DWS 密码。

import { execFile } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { appendFile, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface DockerRunResult {
  code: number;
  stdout: string;
  stderr: string;
  error?: string;
}

export type DockerRunner = (
  args: string[],
  opts?: { timeoutMs?: number },
) => Promise<DockerRunResult>;

export interface SandboxCleanupTarget {
  /** Gateway 任务 ID（SANDBOX_RUN_ID）。 */
  runId: string;
  /** 本次 attempt（SANDBOX_ATTEMPT）；与 label/名称精确匹配。 */
  attempt: number;
  /** 仅用于审计，不参与 Docker 选择。 */
  sessionId?: string;
}

export interface SandboxOperationOptions {
  /** 本操作绝对截止时间（epoch ms）；超出后不再启动新的 docker 命令。 */
  deadlineAt?: number;
}

export interface SandboxContainerReaperOptions {
  /** Gateway 启动时解析出的可信镜像 ID（sha256:...），不是可变 tag。 */
  trustedImageId: string;
  /** 明确配置的可信运行时根；cleanupLockDir 必须位于其下。 */
  trustedRuntimeRoot: string;
  /** per-attempt cleanup lock 所在的可信目录；必须存在、0700、服务用户所有。 */
  cleanupLockDir: string;
  /** 审计 JSONL 路径；必须是服务端可信路径。 */
  auditLogPath: string;
  /** docker stop 宽限秒数（默认 5）。 */
  stopTimeoutSec?: number;
  /** 测试注入；默认 execFile("docker", ...)，绝不经 shell。 */
  runDocker?: DockerRunner;
}

export interface CleanupContainerInfo {
  id: string;
  name: string;
  image: string;
  imageId: string;
  state?: string;
}

export interface SandboxCleanupResult {
  ok: boolean;
  busy: boolean;
  runId: string;
  attempt: number;
  reason?: string;
  found: number;
  cleaned: string[];
  stopped: string[];
  forced: string[];
  mismatches: string[];
  warnings: string[];
  errors: string[];
  containers: CleanupContainerInfo[];
}

/** C2-B2：只读 active 探针；查询/所有权不可证明时 ok=false，调用方不得据此放行进程组终止。 */
export interface SandboxActiveProbeResult {
  ok: boolean;
  active: number;
  mismatches: number;
  reason?: string;
  containers: CleanupContainerInfo[];
}

const MANAGED_LABEL = "com.dpit.gateway.managed";
const RUN_ID_LABEL = "com.dpit.gateway.task.run_id";
const ATTEMPT_LABEL = "com.dpit.gateway.task.attempt";
const CONTAINER_ID_RE = /^[0-9a-f]{12,64}$/i;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TRUSTED_IMAGE_RE = /^sha256:[0-9a-f]{64}$/i;

const INSPECT_FORMAT =
  '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"image_id":{{json .Image}},"labels":{{json .Config.Labels}},"state":{{json .State.Status}}}';

function defaultRunDocker(args: string[], opts?: { timeoutMs?: number }): Promise<DockerRunResult> {
  return new Promise((resolvePromise) => {
    execFile(
      "docker",
      args,
      {
        encoding: "utf8",
        timeout: opts?.timeoutMs ?? 15_000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const code = err
          ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : -1)
          : 0;
        resolvePromise({
          code,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          ...(err ? { error: String((err as Error).message ?? err) } : {}),
        });
      },
    );
  });
}

function notFound(result: DockerRunResult): boolean {
  return /no such (?:object|container)/i.test(`${result.stderr}\n${result.stdout}\n${result.error ?? ""}`);
}

function validRunId(runId: string): boolean {
  return RUN_ID_RE.test(runId) && !runId.includes("..");
}

function validAttempt(attempt: number): boolean {
  return Number.isSafeInteger(attempt) && attempt >= 0 && attempt <= 999_999_999;
}

function strictNameMatches(name: string, runId: string, attempt: number): boolean {
  const clean = name.startsWith("/") ? name.slice(1) : name;
  const prefix = `${runId}-a${attempt}-`;
  return clean.startsWith(prefix) && /^[0-9]+$/.test(clean.slice(prefix.length));
}

function currentUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function safeDirPermissions(st: Stats): boolean {
  if (process.platform === "win32") return true; // Windows mode/uid semantics are not POSIX-safe
  const uid = currentUid();
  if (uid !== null && st.uid !== uid) return false;
  return (st.mode & 0o777) === 0o700;
}

/** Validate the configured lock directory before touching Docker. */
async function validateLockEnvironment(root: string, lockDir: string): Promise<
  { ok: true } | { ok: false; reason: string; error: string }
> {
  const rootPath = resolve(root);
  const lockPath = resolve(lockDir);
  const rel = relative(rootPath, lockPath);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return { ok: false, reason: "LOCK_DIR_OUTSIDE_TRUSTED_ROOT", error: "cleanupLockDir is outside trustedRuntimeRoot" };
  }

  let rootStat: Stats;
  let lockStat: Stats;
  try {
    rootStat = await lstat(rootPath);
    lockStat = await lstat(lockPath);
  } catch {
    return { ok: false, reason: "LOCK_DIR_INVALID", error: "trustedRuntimeRoot or cleanupLockDir is missing" };
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !lockStat.isDirectory() || lockStat.isSymbolicLink()) {
    return { ok: false, reason: "LOCK_DIR_UNSAFE", error: "trustedRuntimeRoot/cleanupLockDir must be non-symlink directories" };
  }
  if (!safeDirPermissions(rootStat) || !safeDirPermissions(lockStat)) {
    return { ok: false, reason: "LOCK_DIR_UNSAFE", error: "trustedRuntimeRoot/cleanupLockDir must be owned by service user with mode 0700" };
  }

  // Realpath equality rejects symlink components in either configured path.
  let rootReal: string;
  let lockReal: string;
  try {
    rootReal = await realpath(rootPath);
    lockReal = await realpath(lockPath);
  } catch {
    return { ok: false, reason: "LOCK_DIR_INVALID", error: "realpath failed for trusted lock paths" };
  }
  if (rootReal !== rootPath || lockReal !== lockPath) {
    return { ok: false, reason: "LOCK_DIR_UNSAFE", error: "trusted lock paths contain symlink components" };
  }
  return { ok: true };
}

async function releaseOwnedLock(
  handle: Awaited<ReturnType<typeof open>>,
  lockPath: string,
  dev: string,
  ino: string,
): Promise<{ ok: boolean; reason?: string }> {
  let releaseOk = true;
  let reason: string | undefined;
  try {
    const current = await lstat(lockPath);
    if (current.isSymbolicLink() || !current.isFile() || String(current.dev) !== dev || String(current.ino) !== ino) {
      releaseOk = false;
      reason = "LOCK_INTEGRITY";
    } else {
      try {
        await unlink(lockPath);
      } catch {
        releaseOk = false;
        reason = "LOCK_RELEASE_FAILED";
      }
    }
  } catch {
    // Missing/replaced lock: do not unlink a path we cannot prove is ours.
    releaseOk = false;
    reason = "LOCK_INTEGRITY";
  } finally {
    try { await handle.close(); } catch { /* ignore close error */ }
  }
  return releaseOk ? { ok: true } : { ok: false, ...(reason ? { reason } : {}) };
}

interface InspectedCandidate {
  id: string;
  name: string;
  image: string;
  imageId: string;
  state?: string;
}

export class SandboxContainerReaper {
  private readonly trustedImageId: string;
  private readonly trustedRuntimeRoot: string;
  private readonly cleanupLockDir: string;
  private readonly auditLogPath: string;
  private readonly stopTimeoutSec: number;
  private readonly runDocker: DockerRunner;

  constructor(opts: SandboxContainerReaperOptions) {
    this.trustedImageId = opts.trustedImageId;
    this.trustedRuntimeRoot = resolve(opts.trustedRuntimeRoot);
    this.cleanupLockDir = resolve(opts.cleanupLockDir);
    this.auditLogPath = resolve(opts.auditLogPath);
    this.stopTimeoutSec = opts.stopTimeoutSec ?? 5;
    this.runDocker = opts.runDocker ?? defaultRunDocker;
  }

  /**
   * 只读探测本 attempt 是否有运行中的 managed 容器。
   * - docker ps 失败 / inspect 失败 / 所有权不匹配均返回 ok=false；
   * - ok=false 时调用方不得向 DSH 进程组发信号，也不得声称 Runner 已退出。
   */
  async probeActive(
    target: SandboxCleanupTarget,
    opts: SandboxOperationOptions = {},
  ): Promise<SandboxActiveProbeResult> {
    const result: SandboxActiveProbeResult = {
      ok: false,
      active: 0,
      mismatches: 0,
      containers: [],
    };
    const run = this.boundedDockerRunner(opts.deadlineAt);
    const runId = String(target?.runId ?? "");
    const attempt = Number(target?.attempt);
    if (!validRunId(runId) || !validAttempt(attempt)) {
      result.reason = "INVALID_TARGET";
      return result;
    }
    if (!TRUSTED_IMAGE_RE.test(this.trustedImageId)) {
      result.reason = "NO_TRUSTED_IMAGE";
      return result;
    }

    let ps: DockerRunResult;
    try {
      ps = await run([
        "ps", "-q",
        "--filter", `label=${MANAGED_LABEL}=true`,
        "--filter", `label=${RUN_ID_LABEL}=${runId}`,
        "--filter", `label=${ATTEMPT_LABEL}=${attempt}`,
      ]);
    } catch {
      result.reason = "DOCKER_QUERY_FAILED";
      return result;
    }
    if (ps.code !== 0) {
      result.reason = ps.error === "CLEANUP_TIME_BUDGET_EXCEEDED"
        ? "CLEANUP_TIME_BUDGET_EXCEEDED"
        : "DOCKER_QUERY_FAILED";
      return result;
    }
    const ids = [...new Set(ps.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))];
    if (ids.some((id) => !CONTAINER_ID_RE.test(id))) {
      result.reason = "DOCKER_QUERY_FAILED";
      return result;
    }

    for (const id of ids) {
      let inspected: DockerRunResult;
      try {
        inspected = await run(["inspect", "--format", INSPECT_FORMAT, id]);
      } catch {
        result.reason = "INSPECT_FAILED";
        return result;
      }
      if (inspected.code !== 0) {
        if (inspected.error === "CLEANUP_TIME_BUDGET_EXCEEDED") {
          result.reason = "CLEANUP_TIME_BUDGET_EXCEEDED";
          return result;
        }
        if (notFound(inspected)) continue;
        result.reason = "INSPECT_FAILED";
        return result;
      }
      let raw: any;
      try {
        raw = JSON.parse(inspected.stdout);
      } catch {
        result.reason = "INSPECT_FAILED";
        return result;
      }
      const name = String(raw?.name ?? "");
      const image = String(raw?.image ?? "");
      const imageId = String(raw?.image_id ?? "");
      const state = raw?.state === undefined ? undefined : String(raw.state);
      const labels = raw?.labels && typeof raw.labels === "object" ? raw.labels : {};
      const info: CleanupContainerInfo = {
        id,
        name,
        image,
        imageId,
        ...(state !== undefined ? { state } : {}),
      };
      const mismatch: string[] = [];
      if (labels[MANAGED_LABEL] !== "true") mismatch.push("label.managed");
      if (labels[RUN_ID_LABEL] !== runId) mismatch.push("label.run_id");
      if (labels[ATTEMPT_LABEL] !== String(attempt)) mismatch.push("label.attempt");
      if (!strictNameMatches(name, runId, attempt)) mismatch.push("container_name");
      if (imageId.toLowerCase() !== this.trustedImageId.toLowerCase()) mismatch.push("image_id");
      if (mismatch.length > 0) {
        result.mismatches += 1;
        result.containers.push(info);
        result.reason = "OWNERSHIP_MISMATCH";
        return result;
      }
      result.containers.push(info);
      result.active += 1;
    }
    result.ok = true;
    return result;
  }

  private boundedDockerRunner(deadlineAt?: number): DockerRunner {
    return async (args, opts) => {
      if (deadlineAt === undefined) return this.runDocker(args, opts);
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) {
        return {
          code: -1,
          stdout: "",
          stderr: "",
          error: "CLEANUP_TIME_BUDGET_EXCEEDED",
        };
      }
      return this.runDocker(args, {
        ...opts,
        timeoutMs: Math.min(opts?.timeoutMs ?? 15_000, remaining),
      });
    };
  }

  async cleanup(
    target: SandboxCleanupTarget,
    opts: SandboxOperationOptions = {},
  ): Promise<SandboxCleanupResult> {
    const run = this.boundedDockerRunner(opts.deadlineAt);
    const result: SandboxCleanupResult = {
      ok: false,
      busy: false,
      runId: String(target?.runId ?? ""),
      attempt: Number(target?.attempt),
      found: 0,
      cleaned: [],
      stopped: [],
      forced: [],
      mismatches: [],
      warnings: [],
      errors: [],
      containers: [],
    };

    if (!validRunId(result.runId) || !validAttempt(result.attempt)) {
      result.reason = "INVALID_TARGET";
      result.errors.push("invalid run_id or attempt");
      await this.audit({ action: "cleanup", phase: "validate", ok: false, run_id: result.runId, attempt: result.attempt, error: result.errors[0] });
      return result;
    }
    if (!TRUSTED_IMAGE_RE.test(this.trustedImageId)) {
      result.reason = "NO_TRUSTED_IMAGE";
      result.errors.push("trusted image ID is missing or malformed");
      await this.audit({ action: "cleanup", phase: "validate", ok: false, run_id: result.runId, attempt: result.attempt, error: result.errors[0] });
      return result;
    }

    const lockEnv = await validateLockEnvironment(this.trustedRuntimeRoot, this.cleanupLockDir);
    if (!lockEnv.ok) {
      result.reason = lockEnv.reason;
      result.errors.push(lockEnv.error);
      await this.audit({ action: "cleanup", phase: "lock", ok: false, run_id: result.runId, attempt: result.attempt, error: lockEnv.error });
      return result;
    }

    let lockHandle: Awaited<ReturnType<typeof open>> | null = null;
    let lockDev = "";
    let lockIno = "";
    const lockPath = join(this.cleanupLockDir, `${result.runId}-a${result.attempt}.reaper.lock`);
    try {
      try {
        lockHandle = await open(
          lockPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
          0o600,
        );
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === "EEXIST") {
          result.busy = true;
          result.reason = "CLEANUP_BUSY";
          await this.audit({ action: "cleanup", phase: "lock", ok: false, run_id: result.runId, attempt: result.attempt, error: "another reaper holds the cleanup lock" });
          return result;
        }
        result.reason = "LOCK_CREATE_FAILED";
        result.errors.push("cleanup lock creation failed");
        await this.audit({ action: "cleanup", phase: "lock", ok: false, run_id: result.runId, attempt: result.attempt, error: result.errors[0] });
        return result;
      }

      const fst = await lockHandle.stat();
      lockDev = String(fst.dev);
      lockIno = String(fst.ino);
      const uid = currentUid();
      const lockFileSafe = fst.isFile() && !fst.isSymbolicLink()
        && (uid === null || fst.uid === uid)
        && (process.platform === "win32" || (fst.mode & 0o077) === 0);
      if (!lockFileSafe) {
        const released = await releaseOwnedLock(lockHandle, lockPath, lockDev, lockIno);
        lockHandle = null;
        result.reason = "LOCK_FILE_UNSAFE";
        result.errors.push("cleanup lock file ownership/type/mode invalid");
        if (!released.ok) result.errors.push(released.reason ?? "LOCK_RELEASE_FAILED");
        await this.audit({ action: "cleanup", phase: "lock", ok: false, run_id: result.runId, attempt: result.attempt, error: result.reason });
        return result;
      }
      await lockHandle.writeFile(`${process.pid}\n`, "utf8");

      const ps = await run([
        "ps", "-aq",
        "--filter", `label=${MANAGED_LABEL}=true`,
        "--filter", `label=${RUN_ID_LABEL}=${result.runId}`,
        "--filter", `label=${ATTEMPT_LABEL}=${result.attempt}`,
      ]);
      if (ps.code !== 0) {
        result.reason = "DOCKER_QUERY_FAILED";
        result.errors.push(`docker ps failed code=${ps.code}`);
        await this.audit({ action: "cleanup", phase: "query", ok: false, run_id: result.runId, attempt: result.attempt, error: result.errors[0] });
        return result;
      }
      const ids = [...new Set(ps.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))];
      result.found = ids.length;
      if (ids.some((id) => !CONTAINER_ID_RE.test(id))) {
        result.reason = "DOCKER_QUERY_FAILED";
        result.errors.push("docker ps returned an invalid container ID");
        await this.audit({ action: "cleanup", phase: "query", ok: false, run_id: result.runId, attempt: result.attempt, error: result.errors[0] });
        return result;
      }
      if (ids.length === 0) {
        result.ok = true;
        await this.audit({ action: "cleanup", phase: "query", ok: true, run_id: result.runId, attempt: result.attempt, found: 0, container_count: 0 });
        return result;
      }

      const candidates: InspectedCandidate[] = [];
      for (const id of ids) {
        const inspected = await run(["inspect", "--format", INSPECT_FORMAT, id]);
        if (inspected.code !== 0) {
          if (notFound(inspected)) {
            await this.audit({ action: "inspect", phase: "inspect", ok: true, run_id: result.runId, attempt: result.attempt, container_id: id, vanished: true });
            continue;
          }
          result.reason = "INSPECT_FAILED";
          result.errors.push(`docker inspect failed for ${id} code=${inspected.code}`);
          await this.audit({ action: "inspect", phase: "inspect", ok: false, run_id: result.runId, attempt: result.attempt, container_id: id, error: result.errors[result.errors.length - 1] });
          return result;
        }

        let raw: any;
        try { raw = JSON.parse(inspected.stdout); } catch {
          result.reason = "INSPECT_FAILED";
          result.errors.push(`docker inspect returned invalid JSON for ${id}`);
          await this.audit({ action: "inspect", phase: "inspect", ok: false, run_id: result.runId, attempt: result.attempt, container_id: id, error: result.errors[result.errors.length - 1] });
          return result;
        }
        const name = String(raw?.name ?? "");
        const image = String(raw?.image ?? "");
        const imageId = String(raw?.image_id ?? "");
        const state = raw?.state === undefined ? undefined : String(raw.state);
        const labels = raw?.labels && typeof raw.labels === "object" ? raw.labels : {};
        const info: CleanupContainerInfo = { id, name, image, imageId, ...(state !== undefined ? { state } : {}) };
        result.containers.push(info);

        const mismatch: string[] = [];
        if (labels[MANAGED_LABEL] !== "true") mismatch.push("label.managed");
        if (labels[RUN_ID_LABEL] !== result.runId) mismatch.push("label.run_id");
        if (labels[ATTEMPT_LABEL] !== String(result.attempt)) mismatch.push("label.attempt");
        if (!strictNameMatches(name, result.runId, result.attempt)) mismatch.push("container_name");
        if (imageId.toLowerCase() !== this.trustedImageId.toLowerCase()) mismatch.push("image_id");
        if (mismatch.length > 0) {
          const detail = `${id} (${name}) mismatch=${mismatch.join(",")}`;
          result.mismatches.push(detail);
          await this.audit({ action: "inspect", phase: "ownership", ok: false, run_id: result.runId, attempt: result.attempt, container_id: id, container_name: name, image_id: imageId, error: `OWNERSHIP_MISMATCH ${mismatch.join(",")}` });
        } else {
          candidates.push({ id, name, image, imageId, ...(state !== undefined ? { state } : {}) });
        }
      }

      if (result.mismatches.length > 0) {
        result.reason = "OWNERSHIP_MISMATCH";
        result.errors.push(`${result.mismatches.length} container(s) failed ownership verification`);
        await this.audit({ action: "cleanup", phase: "ownership", ok: false, run_id: result.runId, attempt: result.attempt, error: result.reason, mismatch_count: result.mismatches.length });
        return result;
      }

      for (const c of candidates) {
        const stop = await run(["stop", "--time", String(this.stopTimeoutSec), c.id], {
          timeoutMs: (this.stopTimeoutSec + 10) * 1000,
        });
        if (stop.code !== 0 && notFound(stop)) {
          result.cleaned.push(c.id);
          await this.audit({ action: "stop", phase: "stop", ok: true, run_id: result.runId, attempt: result.attempt, container_id: c.id, container_name: c.name, vanished: true });
          continue;
        }
        const stopOk = stop.code === 0;
        if (stopOk) {
          result.stopped.push(c.id);
        } else {
          // Graceful stop failure is recoverable if forced removal still succeeds.
          // It is a warning, not a final cleanup failure.
          const warning = `docker stop failed for ${c.id} code=${stop.code}`;
          result.warnings.push(warning);
          await this.audit({ action: "stop", phase: "stop", ok: false, run_id: result.runId, attempt: result.attempt, container_id: c.id, container_name: c.name, error: warning });
        }

        let remove: DockerRunResult;
        if (stopOk) {
          remove = await run(["rm", c.id]);
          // `docker run --rm` may remove the container as soon as stop completes.
          // A "No such container" from rm is already-success; do not force or warn.
          if (remove.code !== 0 && !notFound(remove)) {
            result.forced.push(c.id);
            remove = await run(["rm", "-f", c.id]);
          }
        } else {
          result.forced.push(c.id);
          remove = await run(["rm", "-f", c.id]);
        }

        const finalInspect = await run(["inspect", "--format", "{{.Id}}", c.id]);
        if (finalInspect.code === 0) {
          result.errors.push(`container still exists after removal: ${c.id}`);
          await this.audit({ action: "verify", phase: "verify", ok: false, run_id: result.runId, attempt: result.attempt, container_id: c.id, container_name: c.name, error: "container still exists" });
        } else if (!notFound(finalInspect)) {
          result.errors.push(`docker inspect verification failed for ${c.id} code=${finalInspect.code}`);
          await this.audit({ action: "verify", phase: "verify", ok: false, run_id: result.runId, attempt: result.attempt, container_id: c.id, container_name: c.name, error: result.errors[result.errors.length - 1] });
        } else {
          result.cleaned.push(c.id);
          if (remove.code !== 0 && !notFound(remove)) {
            result.warnings.push(`docker remove failed for ${c.id} code=${remove.code}`);
          }
          await this.audit({
            action: "remove",
            phase: "remove",
            ok: true,
            run_id: result.runId,
            attempt: result.attempt,
            container_id: c.id,
            container_name: c.name,
            image: c.image,
            image_id: c.imageId,
            stopped: stopOk,
            forced: !stopOk || result.forced.includes(c.id),
          });
        }
      }

      result.ok = result.errors.length === 0 && result.mismatches.length === 0;
      if (!result.ok && !result.reason) result.reason = "CLEANUP_FAILED";
      await this.audit({
        action: "cleanup",
        phase: "summary",
        ok: result.ok,
        run_id: result.runId,
        attempt: result.attempt,
        found: result.found,
        cleaned: result.cleaned.length,
        forced: result.forced.length,
        warnings: result.warnings.length,
        errors: result.errors.length,
        reason: result.reason ?? null,
      });
      return result;
    } catch (e) {
      result.reason = "DOCKER_EXCEPTION";
      result.errors.push(`cleanup exception: ${String((e as Error)?.name ?? "Error")}`);
      await this.audit({ action: "cleanup", phase: "exception", ok: false, run_id: result.runId, attempt: result.attempt, error: result.errors[result.errors.length - 1] });
      return result;
    } finally {
      if (lockHandle) {
        const released = await releaseOwnedLock(lockHandle, lockPath, lockDev, lockIno);
        if (!released.ok) {
          // Do not unlink a path whose inode was replaced. Conservative failure:
          // C2 must not report full cleanup success if the lock cannot be proven ours.
          result.ok = false;
          result.reason = released.reason ?? "LOCK_RELEASE_FAILED";
          result.errors.push(released.reason ?? "cleanup lock release failed");
          await this.audit({ action: "cleanup", phase: "lock", ok: false, run_id: result.runId, attempt: result.attempt, error: result.reason });
        }
      }
    }
  }

  private async audit(event: Record<string, unknown>): Promise<void> {
    try {
      await mkdir(dirname(this.auditLogPath), { recursive: true });
      await appendFile(
        this.auditLogPath,
        `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    } catch {
      // Audit write failure must not make a deletion look successful. The caller sees
      // result.ok based on docker outcomes; C2 should surface AUDIT_WRITE_FAILED when
      // it requires auditable cleanup. Do not write raw error text (may contain paths).
    }
  }
}
