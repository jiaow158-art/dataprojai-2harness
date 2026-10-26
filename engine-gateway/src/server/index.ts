// M1-T8：网关组装入口（T9 live E2E 的启动命令 = node src/server/index.ts）。
//
// env 清单（spec §5 配置节 + 任务书）：
//   GATEWAY_PORT           监听端口（默认 8080）
//   AUTH_TOKEN             Bearer token（必填，缺省拒绝启动——空 token 等于不设防）
//   MAX_CONCURRENT_TASKS   池并行上限（默认 3，spec D7 压测起点）
//   MAX_QUEUE              全局排队上限（默认 100）
//   RATE_LIMIT_QPM         按 user 每分钟提交上限（默认 30）
//   GW_WORKROOT            dsh workdir 树根（必填；附录 A：Temp 树外）
//   GW_RESULTS_ROOT        查询结果树根（默认 <GW_WORKROOT>/results，RESULT_DIR 同指）
//   GW_ASSETS_DIR          报告模板/静态资源目录（必填）
//   M0_SANDBOX_RUNNER      沙箱 runner 脚本路径（必填，注入 M0_SANDBOX_RUNNER）
//   SKILLS_DIR             Skills 根目录（必填）
//   GATEWAY_REPORTS_DIR    发布树根 <GATEWAY_REPORTS_DIR>/<user>/<run_id>.html（必填）
//   GW_DB_PATH             SQLite 路径（默认 ./gateway.db）
//   DSH_PROFILE            DSH profile（sdk|sdk-s4b，默认 sdk；仅服务端 env）
//   TASK_BUDGET_S          跨 attempt 总预算（默认 1800）
//   MAX_REPAIR_ROUNDS      基础设施故障 attempt 上限（默认 3）
//   GATEWAY_CLEANUP_MODE   off|linux_isolated（默认 off；Windows 强制 off）
//   GATEWAY_CLEANUP_RUNTIME_ROOT / SANDBOX_ACL_STATE_DIR /
//   GATEWAY_CLEANUP_TRUSTED_IMAGE_ID   linux_isolated 必填
//   GATEWAY_CLEANUP_TIME_BUDGET_MS     清理总预算（默认 40000，启动期校验 < 租约窗口）
//   GATEWAY_CLEANUP_AUDIT_TIMEOUT_MS   单次 audit append 硬上界（默认 1000）
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { TaskStore } from "../store/task-store.ts";
import { TaskRunner, type TaskRunnerCleanupConfig, type TaskRunnerPaths } from "../orchestrator/task-runner.ts";
import { DshBackend } from "../backends/dsh-backend.ts";
import { INHERITED_DSH_ENV_KEYS } from "../backends/dsh-env.ts";
import { resolveDshProfile } from "../config/dsh-profile.ts";
import {
  resolveCleanupPolicy,
  type CleanupPolicy,
  type CleanupPolicyEnabled,
} from "../config/cleanup-policy.ts";
import {
  defaultForbiddenRoots,
  prepareTrustedRuntime,
  validateTrustedDirectory,
  type TrustedRuntime,
} from "../config/trusted-runtime.ts";
import { CleanupAuditLog } from "../orchestrator/cleanup-audit.ts";
import {
  SandboxContainerReaper,
  type DockerRunner,
  type DockerRunResult,
} from "../orchestrator/sandbox-container-reaper.ts";
import type { CoordinatorAudit } from "../orchestrator/task-cleanup-coordinator.ts";
import { WorkerPool } from "./worker-pool.ts";
import { createHttpServer } from "./http.ts";
import { randomUUID } from "node:crypto";

function envInt(env: NodeJS.ProcessEnv, name: string, dflt: number): number {
  const v = env[name];
  if (v === undefined || v === "") return dflt;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`[CONFIG] ${name} 必须为正整数，得到: ${v}`);
  return n;
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`[CONFIG] 缺少必填环境变量 ${name}`);
  return v;
}

export class CleanupStartupError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(`[CONFIG] [${code}] ${message}`);
    this.name = "CleanupStartupError";
    this.code = code;
  }
}

function startupFail(code: string, message: string): never {
  throw new CleanupStartupError(code, message);
}

const MAX_AUDIT_APPEND_WINDOW = 16;
const CLEANUP_TERMINAL_MARGIN_MS = 5_000;

export interface CleanupStartupValidationInput {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  policy: CleanupPolicyEnabled;
  runtime: TrustedRuntime;
  paths: TaskRunnerPaths;
  auditLogPath: string;
  reaperAuditLogPath: string;
  leaseTtlMs: number;
  heartbeatIntervalMs: number;
  cleanupTimeBudgetMs: number;
  auditTimeoutMs: number;
  /** 测试注入；生产缺省 execFile("docker", argv)，绝不经 shell。 */
  runDocker?: DockerRunner;
}

function runDockerInspectDefault(
  args: string[],
  opts?: { timeoutMs?: number },
): Promise<DockerRunResult> {
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
          ? typeof (err as { code?: unknown }).code === "number"
            ? (err as { code: number }).code
            : -1
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

function insideOrEqual(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function overlaps(a: string, b: string): boolean {
  return insideOrEqual(a, b) || insideOrEqual(b, a);
}

function assertInsideDir(parent: string, child: string, code: string, label: string): void {
  const rel = relative(resolve(parent), resolve(child));
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    startupFail(code, `${label} must be strictly inside ${parent}`);
  }
}

function validateRunnerLockProtocol(runnerPath: string): void {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(runnerPath);
  } catch {
    startupFail("CLEANUP_RUNNER_MISSING", "M0_SANDBOX_RUNNER cannot be inspected");
  }
  if (!st.isFile() || st.isSymbolicLink()) {
    startupFail("CLEANUP_RUNNER_UNSAFE", "M0_SANDBOX_RUNNER must be a regular non-symlink file");
  }
  let real: string;
  try {
    real = realpathSync(runnerPath);
  } catch {
    startupFail("CLEANUP_RUNNER_UNSAFE", "M0_SANDBOX_RUNNER realpath failed");
  }
  if (real !== resolve(runnerPath)) {
    startupFail("CLEANUP_RUNNER_UNSAFE", "M0_SANDBOX_RUNNER contains symlink components");
  }
  if (st.size > 1024 * 1024) {
    startupFail("CLEANUP_RUNNER_UNSAFE", "M0_SANDBOX_RUNNER is unexpectedly large");
  }
  let source: string;
  try {
    source = readFileSync(runnerPath, "utf8");
  } catch {
    startupFail("CLEANUP_RUNNER_UNSAFE", "M0_SANDBOX_RUNNER cannot be read");
  }
  const markers = [
    'ACL_STATE_DIR="${SANDBOX_ACL_STATE_DIR:-',
    'ACL_KEY="$(printf \'%s\' "${WD_REAL}" | sha256sum | cut -c1-16)"',
    'exec 9>>"${ACL_LOCK}"',
    "flock -n 9",
    'IMAGE="${SANDBOX_IMAGE:-dataplat-script:m0}"',
    'CNAME="${SANDBOX_RUN_ID}-a${SANDBOX_ATTEMPT:-0}-$$"',
    "com.dpit.gateway.managed=true",
    "com.dpit.gateway.task.run_id",
    "com.dpit.gateway.task.attempt",
  ];
  for (const marker of markers) {
    if (!source.includes(marker)) {
      startupFail(
        "CLEANUP_RUNNER_PROTOCOL_UNVERIFIED",
        "M0_SANDBOX_RUNNER does not expose the expected ACL lock / managed-label protocol",
      );
    }
  }
}

function validateExistingAuditFile(
  path: string,
  label: string,
  expectedUid: number | null,
  expectedGid: number | null,
): void {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return;
    startupFail("CLEANUP_AUDIT_PATH_UNSAFE", `${label} cannot be inspected`);
  }
  if (!st.isFile() || st.isSymbolicLink()) {
    startupFail("CLEANUP_AUDIT_PATH_UNSAFE", `${label} must be a regular non-symlink file`);
  }
  if (
    (expectedUid !== null && st.uid !== expectedUid) ||
    (expectedGid !== null && st.gid !== expectedGid) ||
    (st.mode & 0o777) !== 0o600
  ) {
    startupFail(
      "CLEANUP_AUDIT_PATH_UNSAFE",
      `${label} must be service-owned with mode 0600`,
    );
  }
}

function validateExistingTaskAssets(path: string): void {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    startupFail("CLEANUP_TASK_ROOT_UNSAFE", "GW_ASSETS_DIR is missing");
  }
  if (!st.isDirectory() || st.isSymbolicLink()) {
    startupFail("CLEANUP_TASK_ROOT_UNSAFE", "GW_ASSETS_DIR must be a non-symlink directory");
  }
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    startupFail("CLEANUP_TASK_ROOT_UNSAFE", "GW_ASSETS_DIR realpath failed");
  }
  if (real !== resolve(path)) {
    startupFail("CLEANUP_TASK_ROOT_UNSAFE", "GW_ASSETS_DIR contains symlink components");
  }
}

/** 启动期 fail-closed：任一前提不满足都不得装配 Linux cleanup 模式。 */
export async function validateCleanupStartup(input: CleanupStartupValidationInput): Promise<void> {
  if (input.platform !== "linux" || input.policy.platform !== "linux") {
    startupFail("CLEANUP_PLATFORM_UNSUPPORTED", "linux_isolated cleanup requires Linux");
  }
  if (resolveDshProfile(input.env) !== "sdk-s4b") {
    startupFail("CLEANUP_PROFILE_REQUIRED", "linux_isolated cleanup requires DSH_PROFILE=sdk-s4b");
  }

  const rawAclDir = input.env.SANDBOX_ACL_STATE_DIR;
  if (!rawAclDir || resolve(rawAclDir) !== input.policy.aclStateDir) {
    startupFail("CLEANUP_ACL_SOURCE_MISMATCH", "SANDBOX_ACL_STATE_DIR is not the resolved policy directory");
  }
  if (!INHERITED_DSH_ENV_KEYS.includes("SANDBOX_ACL_STATE_DIR")) {
    startupFail("CLEANUP_ACL_SOURCE_MISMATCH", "DSH env whitelist no longer carries SANDBOX_ACL_STATE_DIR");
  }
  if (!INHERITED_DSH_ENV_KEYS.includes("SANDBOX_IMAGE")) {
    startupFail("CLEANUP_IMAGE_SOURCE_MISMATCH", "DSH env whitelist no longer carries SANDBOX_IMAGE");
  }

  try {
    await validateTrustedDirectory(input.policy.aclStateDir, {
      platform: "linux",
      label: "SANDBOX_ACL_STATE_DIR",
    });
  } catch {
    startupFail(
      "CLEANUP_ACL_STATE_UNSAFE",
      "SANDBOX_ACL_STATE_DIR must exist as a service-owned 0700 non-symlink directory",
    );
  }
  for (const [path, label] of [
    [input.runtime.root, "trustedRuntimeRoot"],
    [input.runtime.auditDir, "auditDir"],
    [input.runtime.cleanupLockDir, "cleanupLockDir"],
  ] as const) {
    try {
      await validateTrustedDirectory(path, { platform: "linux", label });
    } catch {
      startupFail("CLEANUP_RUNTIME_DIR_UNSAFE", `${label} failed trusted-directory validation`);
    }
  }

  assertInsideDir(input.runtime.root, input.auditLogPath, "CLEANUP_AUDIT_PATH_UNSAFE", "cleanup audit log");
  assertInsideDir(
    input.runtime.root,
    input.reaperAuditLogPath,
    "CLEANUP_AUDIT_PATH_UNSAFE",
    "container reaper audit log",
  );
  assertInsideDir(
    input.runtime.auditDir,
    input.auditLogPath,
    "CLEANUP_AUDIT_PATH_UNSAFE",
    "cleanup audit log",
  );
  assertInsideDir(
    input.runtime.auditDir,
    input.reaperAuditLogPath,
    "CLEANUP_AUDIT_PATH_UNSAFE",
    "container reaper audit log",
  );
  validateExistingAuditFile(
    input.auditLogPath,
    "cleanup audit log",
    input.runtime.expectedUid,
    input.runtime.expectedGid,
  );
  validateExistingAuditFile(
    input.reaperAuditLogPath,
    "container reaper audit log",
    input.runtime.expectedUid,
    input.runtime.expectedGid,
  );
  validateExistingTaskAssets(input.paths.assetsDir);

  const taskRoots = [
    input.paths.workroot,
    input.paths.resultsRoot,
    input.paths.reportsRoot,
    input.paths.assetsDir,
    input.paths.skillsDir,
  ];
  if (taskRoots.some((p) => overlaps(input.runtime.root, p))) {
    startupFail(
      "CLEANUP_RUNTIME_ROOT_OVERLAP",
      "trustedRuntimeRoot must not overlap work/results/reports/assets/skills roots",
    );
  }
  if (taskRoots.some((p) => overlaps(input.policy.aclStateDir, p))) {
    startupFail(
      "CLEANUP_ACL_STATE_OVERLAP",
      "SANDBOX_ACL_STATE_DIR must not overlap task roots",
    );
  }
  if (overlaps(input.runtime.root, input.policy.aclStateDir)) {
    startupFail(
      "CLEANUP_RUNTIME_ROOT_OVERLAP",
      "trustedRuntimeRoot and SANDBOX_ACL_STATE_DIR must be separate",
    );
  }

  validateRunnerLockProtocol(input.paths.runnerPath);

  if (
    !Number.isSafeInteger(input.cleanupTimeBudgetMs) ||
    input.cleanupTimeBudgetMs <= 0 ||
    !Number.isSafeInteger(input.auditTimeoutMs) ||
    input.auditTimeoutMs <= 0 ||
    !Number.isSafeInteger(input.leaseTtlMs) ||
    input.leaseTtlMs <= 0 ||
    !Number.isSafeInteger(input.heartbeatIntervalMs) ||
    input.heartbeatIntervalMs < 0
  ) {
    startupFail("CLEANUP_BUDGET_INVALID", "cleanup/lease/audit budgets must be positive integers");
  }
  const hardUpper =
    input.cleanupTimeBudgetMs +
    input.auditTimeoutMs * MAX_AUDIT_APPEND_WINDOW +
    CLEANUP_TERMINAL_MARGIN_MS;
  const leaseWindow = input.leaseTtlMs - input.heartbeatIntervalMs;
  if (hardUpper >= leaseWindow) {
    startupFail(
      "CLEANUP_BUDGET_TOO_LARGE",
      `cleanup budget (${hardUpper}ms incl. audit bound/margin) must be below lease safety window (${leaseWindow}ms)`,
    );
  }

  const imageRef = input.env.SANDBOX_IMAGE || "dataplat-script:m0";
  const docker = input.runDocker ?? runDockerInspectDefault;
  let inspected: DockerRunResult;
  try {
    inspected = await docker(["image", "inspect", imageRef, "--format", "{{.Id}}"], {
      timeoutMs: 15_000,
    });
  } catch {
    startupFail("CLEANUP_IMAGE_UNVERIFIABLE", "trusted Docker image cannot be inspected");
  }
  if (inspected.code !== 0) {
    startupFail("CLEANUP_IMAGE_UNVERIFIABLE", "trusted Docker image does not exist locally");
  }
  const actual = inspected.stdout.trim().split(/\r?\n/)[0]?.toLowerCase() ?? "";
  if (actual !== input.policy.trustedImageId.toLowerCase()) {
    startupFail(
      "CLEANUP_IMAGE_MISMATCH",
      "GATEWAY_CLEANUP_TRUSTED_IMAGE_ID does not match the configured SANDBOX_IMAGE",
    );
  }
}

/**
 * 对 CleanupAuditLog.append 加硬上界。fsync 卡死时：
 *   - 本次 append 按失败返回，绝不产生 audit passed；
 *   - 后续 append 继续有界返回失败（底层队列可能阻塞，但调用方不跟随挂起）；
 *   - sticky 失败保证即使底层稍后恢复，本进程也不再把已有超时视为成功。
 */
export class BoundedCleanupAudit implements CoordinatorAudit {
  private log: CleanupAuditLog;
  private timeoutMs: number;
  private timedOut = false;
  private timeoutCount = 0;

  constructor(log: CleanupAuditLog, timeoutMs: number) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("[CONFIG] cleanup audit timeout must be a positive integer");
    }
    this.log = log;
    this.timeoutMs = timeoutMs;
  }

  get auditOk(): boolean {
    return !this.timedOut && this.log.auditOk;
  }

  get failureCount(): number {
    return this.log.failureCount + this.timeoutCount;
  }

  get eventCount(): number {
    return this.log.eventCount;
  }

  async append(event: Record<string, unknown>): Promise<{ ok: boolean; code?: string }> {
    // 首次超时后本进程不再向同一底层 log 追加任何事件：底层 append/fsync 没有被
    // 取消（JS/Promise 做不到），继续排队只会增加未完成 I/O，不会恢复成功语义。
    if (this.timedOut) return { ok: false, code: "AUDIT_APPEND_TIMEOUT" };
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<{ ok: false; code: string }>((resolvePromise) => {
      timer = setTimeout(() => {
        resolvePromise({ ok: false, code: "AUDIT_APPEND_TIMEOUT" });
      }, this.timeoutMs);
    });
    const underlying = this.log.append(event);
    // 超时后底层仍可能 reject；显式吸收，避免 unhandledRejection。
    underlying.catch(() => undefined);
    try {
      const result = await Promise.race([underlying, timeout]);
      if (!result.ok && result.code === "AUDIT_APPEND_TIMEOUT") {
        this.timedOut = true;
        this.timeoutCount += 1;
        return { ok: false, code: "AUDIT_APPEND_TIMEOUT" };
      }
      return result;
    } catch {
      return { ok: false, code: "AUDIT_WRITE_FAILED" };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** cleanup 模式把 SANDBOX_IMAGE 钉成启动期已验证的不可变 image ID。off 原样返回。 */
export function buildBackendSourceEnv(
  env: NodeJS.ProcessEnv,
  policy: CleanupPolicy,
): NodeJS.ProcessEnv {
  return policy.mode === "linux_isolated"
    ? { ...env, SANDBOX_IMAGE: policy.trustedImageId }
    : env;
}

export async function startGateway(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  // S4-B2-B1：profile 只来自可信服务端 env。必须在打开 SQLite / 监听端口之前失败，
  // 非法值不得产生 DB 文件或半启动服务。缺省/空串 = sdk（Windows 现有行为不变）。
  const dshProfile = resolveDshProfile(env);
  // 默认 off；Windows/非 Linux 强制 off。显式 linux_isolated 的形态错误在任何副作用前拒绝。
  const cleanupPolicy = resolveCleanupPolicy({ env, platform: process.platform });

  // 所有执行路径与预算在 DB/listen 前解析；缺 env 不再产生半初始化进程。
  const runnerPaths: TaskRunnerPaths = {
    workroot: requiredEnv(env, "GW_WORKROOT"),
    resultsRoot: env.GW_RESULTS_ROOT || resolve(requiredEnv(env, "GW_WORKROOT"), "results"),
    assetsDir: requiredEnv(env, "GW_ASSETS_DIR"),
    runnerPath: requiredEnv(env, "M0_SANDBOX_RUNNER"),
    skillsDir: requiredEnv(env, "SKILLS_DIR"),
    reportsRoot: requiredEnv(env, "GATEWAY_REPORTS_DIR"),
  };
  const taskBudgetS = envInt(env, "TASK_BUDGET_S", 1800);
  const maxAttempts = envInt(env, "MAX_REPAIR_ROUNDS", 3);
  const leaseTtlMs = 90_000;
  const heartbeatIntervalMs = 15_000;
  const cleanupTimeBudgetMs = envInt(env, "GATEWAY_CLEANUP_TIME_BUDGET_MS", 40_000);
  const cleanupAuditTimeoutMs = envInt(env, "GATEWAY_CLEANUP_AUDIT_TIMEOUT_MS", 1_000);
  const maxConcurrent = envInt(env, "MAX_CONCURRENT_TASKS", 3);
  const authToken = requiredEnv(env, "AUTH_TOKEN");
  const maxQueue = envInt(env, "MAX_QUEUE", 100);
  const rateLimitQpm = envInt(env, "RATE_LIMIT_QPM", 30);
  const gatewayPort = envInt(env, "GATEWAY_PORT", 8080);
  const gatewayHost = env.GATEWAY_HOST;

  let cleanupConfig: TaskRunnerCleanupConfig | undefined;
  let cleanupAuditLog: CleanupAuditLog | null = null;

  if (cleanupPolicy.mode === "linux_isolated") {
    if (process.platform !== "linux") {
      startupFail("CLEANUP_PLATFORM_UNSUPPORTED", "linux_isolated cleanup requires Linux");
    }
    const runtime = await prepareTrustedRuntime({
      root: cleanupPolicy.runtimeRoot,
      create: true,
      platform: "linux",
      forbiddenRoots: [
        ...defaultForbiddenRoots(),
        runnerPaths.workroot,
        runnerPaths.resultsRoot,
        runnerPaths.reportsRoot,
        runnerPaths.assetsDir,
        runnerPaths.skillsDir,
      ],
    });
    const auditLogPath = join(runtime.auditDir, "cleanup-audit.jsonl");
    const reaperAuditLogPath = join(runtime.auditDir, "container-reaper-audit.jsonl");
    await validateCleanupStartup({
      env,
      platform: process.platform,
      policy: cleanupPolicy,
      runtime,
      paths: runnerPaths,
      auditLogPath,
      reaperAuditLogPath,
      leaseTtlMs,
      heartbeatIntervalMs,
      cleanupTimeBudgetMs,
      auditTimeoutMs: cleanupAuditTimeoutMs,
    });
    try {
      cleanupAuditLog = await CleanupAuditLog.open({
        trustedRuntimeRoot: runtime.root,
        auditLogPath,
        platform: "linux",
      });
    } catch {
      startupFail("CLEANUP_AUDIT_OPEN_FAILED", "trusted cleanup audit log cannot be opened safely");
    }
    const boundedAudit = new BoundedCleanupAudit(cleanupAuditLog, cleanupAuditTimeoutMs);
    const reaper = new SandboxContainerReaper({
      trustedImageId: cleanupPolicy.trustedImageId,
      trustedRuntimeRoot: runtime.root,
      cleanupLockDir: runtime.cleanupLockDir,
      auditLogPath: reaperAuditLogPath,
    });
    cleanupConfig = {
      platform: "linux",
      aclStateDir: cleanupPolicy.aclStateDir,
      timeBudgetMs: cleanupTimeBudgetMs,
      reaper,
      audit: boundedAudit,
    };
  }

  // ── 建库 + WAL（T4 审查 Minor-3：WAL 断言——读回 journal_mode 必须 'wal'）──────────
  const dbPath = env.GW_DB_PATH || "./gateway.db";
  const db = new Database(resolve(dbPath));
  db.pragma("journal_mode = WAL");
  const journalMode = db.pragma("journal_mode", { simple: true });
  if (journalMode !== "wal") {
    db.close();
    if (cleanupAuditLog) void cleanupAuditLog.close().catch(() => undefined);
    throw new Error(`[CONFIG] WAL 未生效（journal_mode=${journalMode}）——网络盘/旧文件系统会导致并发写丢更新，拒绝启动`);
  }
  const store = new TaskStore(db, Date.now, {
    cleanupHoldMode: cleanupPolicy.mode === "linux_isolated",
  });

  // ── 执行层组装：DshBackend → TaskRunner 工厂（池的注入点）──────────────────────────
  // cleanup 模式把 SANDBOX_IMAGE 钉成启动期已验证的不可变 image ID：既防 tag 在运行期
  // 漂移到其他镜像，也保证 Runner 创建容器的 Image 与 reaper 精确归属检查完全一致。
  const backendEnv = buildBackendSourceEnv(env, cleanupPolicy);
  const backend = new DshBackend({ profile: dshProfile, sourceEnv: backendEnv });
  const runnerFactory = (runId: string): Promise<void> =>
    new TaskRunner(store, backend, {
      // 单服务部署：workerId 唯一即可，per-run 随机段防跨启动复用（A.1 围栏语义只要求
      // 同一时刻不同执行者 id 不同）
      workerId: `gw-${process.pid}-${randomUUID().slice(0, 8)}`,
      taskBudgetS,
      maxAttempts,
      leaseTtlMs,
      heartbeatIntervalMs,
      paths: runnerPaths,
      ...(cleanupConfig ? { cleanup: cleanupConfig } : {}),
    }).runOnce(runId);

  // ── 池 + HTTP ─────────────────────────────────────────────────────────────────────
  const pool = new WorkerPool({
    store,
    runner: runnerFactory,
    config: {
      maxConcurrent,
      pollIntervalMs: 500,
      reapIntervalMs: 30_000,
      maxAttempts,
      cleanupHoldMode: cleanupPolicy.mode === "linux_isolated",
    },
  });

  const server = createHttpServer({
    store,
    pool,
    config: {
      authToken,
      maxQueue,
      rateLimitQpm,
    },
  });

  // boot hold 恢复必须先于派发；失败时 start() 抛出，服务不启动。
  pool.start();
  // LIN-1 R4：GATEWAY_HOST 可选绑定地址（生产建议 127.0.0.1，由同机 BFF/反代访问）；
  // 未设置 = 现行为（全接口监听），Windows 开发零变化。
  const onListening = () => {
    console.log(
      `[gateway] listening on ${gatewayHost ? `${gatewayHost}:${gatewayPort}` : `:${gatewayPort}`} ` +
        `db=${dbPath} workroot=${runnerPaths.workroot} dsh_profile=${dshProfile} ` +
        `cleanup_mode=${cleanupPolicy.mode}`,
    );
  };
  if (gatewayHost) server.listen(gatewayPort, gatewayHost, onListening);
  else server.listen(gatewayPort, onListening);

  // ── 优雅停：停入流 → 停池（等在途 runner）→ 停 HTTP → 关库 ─────────────────────────
  async function shutdown(sig: string): Promise<void> {
    console.log(`[gateway] ${sig} — graceful shutdown`);
    await pool.stop();
    server.close();
    server.closeAllConnections?.(); // SSE 长连接会挂住 close()——终态之外的流直接断开，客户端按 seq 重连
    if (cleanupAuditLog) {
      // fsync 卡死时不能阻塞停机；关闭失败只会让本进程审计最终失败，绝不影响已落库终态。
      void cleanupAuditLog.close().catch(() => undefined);
    }
    db.close();
    process.exit(0);
  }
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (import.meta.main) {
  startGateway().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
