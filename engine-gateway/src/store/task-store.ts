// M1-T4：任务模型与 SQLite 持久层 —— 附录 A 四大不变量的物理载体。
// 技术选型 better-sqlite3：同步 API + 单连接，所有状态迁移都是带围栏的条件写
// （A.0：真相在 SQLite，副作用安全靠"唯一命名 + 围栏发布"，而非"避免并发"）。
//
//   A.1 L1 唯一执行者：全部状态写经围栏条件写（run_id+attempt+lease_owner 三元，
//       rowcount=0 即失权信号，调用方 kill 自身进程树退出）
//   A.2 S1 串行：listRunnable 只放行"会话队首且为 queued"的任务（同会话第二个
//       任务在前一任务终态前永不可被 claim）
//   A.3 幂等：提交层 UNIQUE(client_submission_id) 同事务 catch；事件层 seq=MAX(seq)+1
//       同步事务内分配；结果层 publications INSERT OR IGNORE
//   A.4 恢复：deadline 首次 claim 固化；reapExpired 用同一条围栏条件 UPDATE 原子判定
//
// ---- 事件词表契约（冻结，spec §5 规范事件；T5 归一化/T7 编排/T8 SSE 共同遵守）----
// events.type 只允许以下六类，payload 形状如下（JSON.stringify 后入库，读取一律 parse）：
//   "stage"  → {stage: "queued|analyzing|querying|script_running|report_checking|repairing|publishing", text?}
//              另含内部字段 attempt（接管/围栏自愈时的 claim 事件）
//   "sql"    → {sql, rows, truncated, result_ref, elapsed_ms}
//   "answer" → {markdown}                      最终回答（sessionHistory 摘要即取此）
//   "report" → {path}                          发布后才有
//   "error"  → {code, message}
//   "done"   → {run_id, status, engine, elapsed_ms, tokens, recovered}
// 词表扩充须先改 spec 再改此处——消费方（SSE 前端/历史注入）按 type 分派，私造类型即断线。
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TaskCleanupReport } from "../orchestrator/cleanup-report.ts";

export type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface TaskRow {
  run_id: string;
  client_submission_id: string | null;
  session_id: string;
  user: string;
  scope_group: string;
  question: string;
  status: TaskStatus;
  stage: string | null;
  attempt: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  cancel_requested: number;
  deadline: number | null;
  error_code: string | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
}

/** 围栏写句柄：claimLease 成功后返回，此后一切状态写必须携带它（A.1 L1）。 */
export interface Lease {
  run_id: string;
  attempt: number;
  lease_owner: string;
}

export interface FencedResult {
  fenced: boolean;
}

// ---------- C2-B2：事务性清理终态 ----------

export type CleanupTerminalStatus = "succeeded" | "failed" | "cancelled";

export interface CleanupDoneTokens {
  input: number;
  output: number;
  cache_read: number;
}

/** done 事件 payload 的封闭形状（与 events 词表一致，不让调用方夹带任意字段）。 */
export interface CleanupDoneEvent {
  run_id: string;
  status: CleanupTerminalStatus;
  engine: string;
  elapsed_ms: number;
  tokens: CleanupDoneTokens | null;
  recovered: boolean;
}

export interface FinalizeWithCleanupInput {
  status: CleanupTerminalStatus;
  errorCode?: string;
  errorMessage?: string;
  report: TaskCleanupReport;
  doneEvent: CleanupDoneEvent;
  /** 成功且有报告产物时提供；publication 与 report 事件在同一事务内落库。 */
  publication?: { reportPath: string };
}

export interface ReleaseForRetryWithCleanupInput {
  report: TaskCleanupReport;
}

export interface FinalizeCleanupFailureInput {
  status: "failed" | "cancelled";
  cleanupId: string;
  trigger: string;
  platform: string;
  errorCode: string;
  errorMessage?: string;
  doneEvent: CleanupDoneEvent;
}

export interface CleanupFencedResult extends FencedResult {
  reportStored?: boolean;
  doneSeq?: number;
  publicationPath?: string;
}

export interface CleanupReportRow {
  run_id: string;
  attempt: number;
  cleanup_id: string;
  trigger: string;
  platform: string;
  sealed: boolean;
  overall_ok: boolean;
  report: TaskCleanupReport | null;
  error_code: string | null;
  created_at: number;
}

export class CleanupStoreError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "CleanupStoreError";
    this.code = code;
  }
}

const CLEANUP_COMPONENTS = ["dsh", "runner", "docker", "acl", "audit"] as const;
const CLEANUP_STATUSES = new Set(["passed", "failed", "pending", "not_applicable"]);
const CLEANUP_TRIGGERS = new Set([
  "task_success",
  "cancel",
  "timeout",
  "engine_error",
  "lost_lease",
  "graceful_shutdown",
  "lease_reaper",
  "boot_recovery",
]);
const CLEANUP_PLATFORMS = new Set(["linux", "win32", "other"]);
const CLEANUP_APPLICABILITY_BASES = new Set(["platform", "lifecycle", "execution"]);
const CLEANUP_REASON_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const CLEANUP_ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const CONTROL_RE = /[\x00-\x1f\x7f]/;
const MAX_REPORT_JSON_BYTES = 64 * 1024;
const MAX_CLEANUP_ID_LENGTH = 128;
const REPORT_KEYS = [
  "attempt",
  "checks",
  "cleanupId",
  "finishedAt",
  "overallOk",
  "platform",
  "runId",
  "startedAt",
  "trigger",
  "version",
] as const;

function cleanupFail(code: string, message: string): never {
  throw new CleanupStoreError(code, message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFrozenObject(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && Object.isFrozen(value);
}

function reportBytes(report: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(report);
  } catch {
    cleanupFail("CLEANUP_REPORT_INVALID", "cleanup report is not JSON serializable");
  }
  if (typeof json !== "string") {
    cleanupFail("CLEANUP_REPORT_INVALID", "cleanup report must serialize to a JSON value");
  }
  if (Buffer.byteLength(json, "utf8") > MAX_REPORT_JSON_BYTES) {
    cleanupFail("CLEANUP_REPORT_TOO_LARGE", `cleanup report exceeds ${MAX_REPORT_JSON_BYTES} bytes`);
  }
  return json;
}

function validTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || CONTROL_RE.test(value)) {
    cleanupFail("CLEANUP_REPORT_INVALID", `${field} must be a non-empty timestamp`);
  }
  if (!Number.isFinite(Date.parse(value))) {
    cleanupFail("CLEANUP_REPORT_INVALID", `${field} must be an ISO-parseable timestamp`);
  }
  return value;
}

function validateDoneEvent(done: unknown, lease: Lease, status: CleanupTerminalStatus): void {
  if (!isPlainObject(done)) {
    cleanupFail("CLEANUP_DONE_INVALID", "doneEvent must be a plain object");
  }
  if (done.run_id !== lease.run_id) {
    cleanupFail("CLEANUP_DONE_INVALID", "doneEvent.run_id must equal the lease run_id");
  }
  if (done.status !== status) {
    cleanupFail("CLEANUP_DONE_INVALID", "doneEvent.status must equal the terminal status");
  }
  if (typeof done.engine !== "string" || done.engine.length === 0 || done.engine.length > 64) {
    cleanupFail("CLEANUP_DONE_INVALID", "doneEvent.engine must be a short non-empty string");
  }
  if (typeof done.elapsed_ms !== "number" || !Number.isFinite(done.elapsed_ms) || done.elapsed_ms < 0) {
    cleanupFail("CLEANUP_DONE_INVALID", "doneEvent.elapsed_ms must be a non-negative finite number");
  }
  if (typeof done.recovered !== "boolean") {
    cleanupFail("CLEANUP_DONE_INVALID", "doneEvent.recovered must be boolean");
  }
  if (done.tokens !== null) {
    if (!isPlainObject(done.tokens)) {
      cleanupFail("CLEANUP_DONE_INVALID", "doneEvent.tokens must be null or an object");
    }
    for (const key of ["input", "output", "cache_read"] as const) {
      const value = done.tokens[key];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        cleanupFail("CLEANUP_DONE_INVALID", `doneEvent.tokens.${key} must be a non-negative finite number`);
      }
    }
  }
}

function validateCleanupId(value: unknown, code: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CLEANUP_ID_LENGTH ||
    CONTROL_RE.test(value)
  ) {
    cleanupFail(code, "cleanupId must be a short control-free string");
  }
  return value;
}

function validateErrorCode(value: unknown, label: string): string {
  if (typeof value !== "string" || !CLEANUP_ERROR_CODE_RE.test(value)) {
    cleanupFail("CLEANUP_ERROR_CODE_INVALID", `${label} must be a closed-set-style error code`);
  }
  return value;
}

/**
 * 校验并通过 checks 重新计算 overallOk，绝不相信调用方传入的 overallOk。
 * 要求 frozen 对象：sealTaskCleanupReport 会深冻结报告，未冻结对象视为未 seal 来源。
 *
 * 注意：frozen 只是结构/来源约束，证明对象未被事后篡改，**不证明物理清理真的发生**。
 * 物理事实由 coordinator 的 DSH/Docker/ACL 检查与 C2-B1 CleanupAuditLog 负责；
 * TaskStore 只做持久化围栏和契约一致性校验。
 */
function validateSealedReport(
  report: unknown,
  lease: Lease,
  requireOverallOk: boolean,
): { json: string; overallOk: boolean; report: TaskCleanupReport } {
  if (!isPlainObject(report)) {
    cleanupFail("CLEANUP_REPORT_INVALID", "cleanup report must be a plain object");
  }
  if (!Object.isFrozen(report)) {
    cleanupFail("CLEANUP_REPORT_UNSEALED", "cleanup report must be the frozen result of sealTaskCleanupReport");
  }
  const json = reportBytes(report);
  const keys = Object.keys(report).sort();
  const expected = [...REPORT_KEYS].sort();
  if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) {
    cleanupFail("CLEANUP_REPORT_INVALID", "cleanup report has unexpected fields");
  }

  const r = report as Record<string, unknown>;
  if (r.version !== 1) cleanupFail("CLEANUP_REPORT_INVALID", "unsupported cleanup report version");
  validateCleanupId(r.cleanupId, "CLEANUP_REPORT_INVALID");
  if (typeof r.runId !== "string" || r.runId !== lease.run_id) {
    cleanupFail("CLEANUP_REPORT_RUN_MISMATCH", "report.runId must equal lease.run_id");
  }
  if (typeof r.attempt !== "number" || !Number.isSafeInteger(r.attempt) || r.attempt !== lease.attempt) {
    cleanupFail("CLEANUP_REPORT_ATTEMPT_MISMATCH", "report.attempt must equal lease.attempt");
  }
  if (typeof r.trigger !== "string" || !CLEANUP_TRIGGERS.has(r.trigger)) {
    cleanupFail("CLEANUP_REPORT_INVALID", "report.trigger is invalid");
  }
  if (typeof r.platform !== "string" || !CLEANUP_PLATFORMS.has(r.platform)) {
    cleanupFail("CLEANUP_REPORT_INVALID", "report.platform is invalid");
  }
  const startedAt = validTimestamp(r.startedAt, "startedAt");
  const finishedAt = validTimestamp(r.finishedAt, "finishedAt");
  if (Date.parse(finishedAt) < Date.parse(startedAt)) {
    cleanupFail("CLEANUP_REPORT_INVALID", "finishedAt must not precede startedAt");
  }
  if (typeof r.overallOk !== "boolean") {
    cleanupFail("CLEANUP_REPORT_INVALID", "report.overallOk must be boolean");
  }

  const checks = r.checks;
  if (!isFrozenObject(checks)) {
    cleanupFail("CLEANUP_REPORT_UNSEALED", "report.checks must be a frozen object");
  }
  const checkKeys = Object.keys(checks).sort();
  const expectedChecks = [...CLEANUP_COMPONENTS].sort();
  if (
    checkKeys.length !== expectedChecks.length ||
    checkKeys.some((key, i) => key !== expectedChecks[i])
  ) {
    cleanupFail("CLEANUP_REPORT_INVALID", "report.checks must contain exactly the five cleanup components");
  }

  const byComponent: Record<string, Record<string, unknown>> = {};
  let derivedOverallOk = true;
  for (const component of CLEANUP_COMPONENTS) {
    const check = checks[component];
    if (!isFrozenObject(check)) {
      cleanupFail("CLEANUP_REPORT_UNSEALED", `${component} check must be frozen`);
    }
    if (check.component !== component) {
      cleanupFail("CLEANUP_REPORT_INVALID", `${component}.component must equal "${component}"`);
    }
    if (typeof check.required !== "boolean") {
      cleanupFail("CLEANUP_REPORT_INVALID", `${component}.required must be boolean`);
    }
    if (typeof check.status !== "string" || !CLEANUP_STATUSES.has(check.status)) {
      cleanupFail("CLEANUP_REPORT_INVALID", `${component}.status is invalid`);
    }
    if (typeof check.reason !== "string" || !CLEANUP_REASON_RE.test(check.reason)) {
      cleanupFail("CLEANUP_REPORT_INVALID", `${component}.reason must be a closed-set-style code`);
    }
    if (!isFrozenObject(check.evidence)) {
      cleanupFail("CLEANUP_REPORT_UNSEALED", `${component}.evidence must be frozen`);
    }
    byComponent[component] = check;

    let applicability: Record<string, unknown> | null = null;
    if (check.status === "not_applicable") {
      if (check.required) {
        cleanupFail("CLEANUP_REPORT_INVALID", `${component} cannot be not_applicable while required`);
      }
      if (!isFrozenObject(check.applicability)) {
        cleanupFail("CLEANUP_REPORT_INVALID", `${component} not_applicable requires frozen applicability`);
      }
      applicability = check.applicability;
      if (
        typeof applicability.basis !== "string" ||
        !CLEANUP_APPLICABILITY_BASES.has(applicability.basis) ||
        typeof applicability.detail !== "string" ||
        applicability.detail.length === 0 ||
        applicability.detail.length > 200 ||
        CONTROL_RE.test(applicability.detail)
      ) {
        cleanupFail("CLEANUP_REPORT_INVALID", `${component}.applicability is invalid`);
      }
    } else if (check.applicability !== undefined) {
      cleanupFail("CLEANUP_REPORT_INVALID", `${component}.applicability is only valid for not_applicable`);
    }

    if ((component === "docker" || component === "audit") && check.required !== true) {
      cleanupFail("CLEANUP_REPORT_INVALID", `${component} must always be required`);
    }
    if (component === "docker" || component === "audit") {
      if (check.status === "not_applicable") {
        cleanupFail("CLEANUP_REPORT_INVALID", `${component} can never be not_applicable`);
      }
    }
    if (component === "acl") {
      if (r.platform === "linux") {
        if (check.required !== true || check.status === "not_applicable") {
          cleanupFail("CLEANUP_REPORT_INVALID", "Linux ACL must be required and cannot be not_applicable");
        }
      } else if (r.platform === "win32") {
        if (
          check.required !== false ||
          check.status !== "not_applicable" ||
          !applicability ||
          applicability.basis !== "platform" ||
          applicability.detail !== "win32"
        ) {
          cleanupFail("CLEANUP_REPORT_INVALID", "win32 ACL must be not_applicable with platform/win32 basis");
        }
      } else if (check.required !== true || check.status === "not_applicable" || check.status === "passed") {
        cleanupFail("CLEANUP_REPORT_INVALID", "ACL outside linux/win32 must be required and unverifiable");
      }
    }
    if (component === "dsh" || component === "runner") {
      if (check.status === "not_applicable") {
        if (!applicability || applicability.basis !== "lifecycle") {
          cleanupFail("CLEANUP_REPORT_INVALID", `${component} not_applicable requires lifecycle basis`);
        }
        const allowed = component === "dsh"
          ? new Set(["dsh_not_spawned"])
          : new Set(["dsh_not_spawned", "runner_not_spawned"]);
        if (!allowed.has(String(applicability.detail))) {
          cleanupFail("CLEANUP_REPORT_INVALID", `${component} not_applicable lifecycle detail is invalid`);
        }
      } else if (check.required !== true) {
        cleanupFail("CLEANUP_REPORT_INVALID", `${component} must be required unless not_applicable`);
      }
    }

    if (check.status === "pending" || check.status === "failed") derivedOverallOk = false;
    if (check.required && check.status !== "passed") derivedOverallOk = false;
    if (check.status === "not_applicable" && !applicability) derivedOverallOk = false;
  }

  // C2-B1 的两条进程证据不变量：防止伪造 frozen 对象把未验证进程组说成 passed。
  const dsh = byComponent.dsh;
  const runner = byComponent.runner;
  const dshEvidence = dsh.evidence as Record<string, unknown>;
  const runnerEvidence = runner.evidence as Record<string, unknown>;
  const runnerApplicability = runner.applicability as Record<string, unknown> | undefined;
  if (dsh.status === "not_applicable") {
    if (runner.status !== "not_applicable" || runnerApplicability?.detail !== "dsh_not_spawned") {
      cleanupFail("CLEANUP_REPORT_INVALID", "DSH not spawned requires Runner not_applicable with dsh_not_spawned");
    }
  }
  if (
    runner.status === "not_applicable" &&
    runnerApplicability?.detail === "dsh_not_spawned" &&
    dsh.status !== "not_applicable"
  ) {
    cleanupFail("CLEANUP_REPORT_INVALID", "Runner dsh_not_spawned requires DSH not_applicable");
  }
  if (dsh.status === "passed" && dshEvidence.processGroupAbsent !== true) {
    cleanupFail("CLEANUP_REPORT_INVALID", "DSH passed requires processGroupAbsent=true evidence");
  }
  if (runnerEvidence.coveredBy !== undefined && runnerEvidence.coveredBy !== "dsh_process_group") {
    cleanupFail("CLEANUP_REPORT_INVALID", "Runner coveredBy has an unsupported value");
  }
  if (runner.status === "passed") {
    if (runnerEvidence.coveredBy === "dsh_process_group") {
      if (
        dsh.status !== "passed" ||
        dshEvidence.processGroupAbsent !== true ||
        typeof dshEvidence.pgid !== "number" ||
        typeof runnerEvidence.pgid !== "number" ||
        dshEvidence.pgid !== runnerEvidence.pgid
      ) {
        cleanupFail("CLEANUP_REPORT_INVALID", "Runner coverage by DSH requires passed DSH and identical pgid");
      }
    } else if (
      runnerEvidence.processGroupAbsent !== true ||
      typeof runnerEvidence.pgid !== "number"
    ) {
      cleanupFail("CLEANUP_REPORT_INVALID", "Runner passed requires its own pgid and processGroupAbsent=true");
    }
  }
  if (r.platform === "linux" && byComponent.acl.status === "passed") {
    const aclEvidence = byComponent.acl.evidence as Record<string, unknown>;
    if (
      aclEvidence.aclVerifiedWith !== "getfacl" ||
      aclEvidence.aclResidualEntries !== 0 ||
      aclEvidence.aclStateFiles !== 0
    ) {
      cleanupFail("CLEANUP_REPORT_INVALID", "Linux ACL passed requires getfacl and zero residual/state files");
    }
  }

  if (r.overallOk !== derivedOverallOk) {
    cleanupFail("CLEANUP_REPORT_INCONSISTENT", "report.overallOk does not match its checks");
  }
  if (requireOverallOk && !derivedOverallOk) {
    cleanupFail("CLEANUP_REPORT_NOT_OK", "cleanup report is not overallOk");
  }
  return { json, overallOk: derivedOverallOk, report: report as TaskCleanupReport };
}

export interface CreateTaskInput {
  client_submission_id?: string;
  session_id: string;
  user: string;
  scope_group?: string;
  question: string;
}

export interface EventRow {
  seq: number;
  type: string;
  payload: unknown;
  created_at: number;
}

/** A.2 S2：会话历史注入结构（T7 恢复路径消费）。 */
export interface SessionHistoryEntry {
  run_id: string;
  question: string;
  status: TaskStatus;
  /** 成功任务：全部 sql 事件的 result_ref 清单；失败任务：[] */
  result_refs: string[];
  /** 成功任务：final answer 事件 payload 摘要；失败任务：null */
  final_answer: string | null;
}

export interface ReapedTask {
  run_id: string;
  status: TaskStatus;
}

const FENCE = "run_id = ? AND attempt = ? AND lease_owner = ?";
const LEASE_FREE = "(lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at < ?)";
const WITHIN_BUDGET = "(deadline IS NULL OR deadline >= ?)";

export class TaskStore {
  private db: Database.Database;
  private now: () => number;

  constructor(db: Database.Database, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
    db.exec(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "schema.sql"), "utf8"));
  }

  // ---------- A.3 提交层：幂等创建 ----------

  createTask(input: CreateTaskInput): { run_id: string; created: boolean } {
    const run_id = `run-${randomUUID()}`;
    const ts = this.now();
    try {
      return this.db.transaction(() => {
        this.db
          .prepare(
            `INSERT INTO tasks (run_id, client_submission_id, session_id, user, scope_group,
                                question, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
          )
          .run(
            run_id,
            input.client_submission_id ?? null,
            input.session_id,
            input.user,
            input.scope_group ?? "default",
            input.question,
            ts,
            ts,
          );
        return { run_id, created: true };
      })();
    } catch (err) {
      // UNIQUE(client_submission_id) 冲突：同事务内 catch 并 SELECT 返回原 run_id（A.3）。
      if (!this.isUniqueViolation(err) || input.client_submission_id == null) throw err;
      const existing = this.getTaskBySubmission(input.client_submission_id);
      if (!existing) throw err;
      return { run_id: existing.run_id, created: false };
    }
  }

  private isUniqueViolation(err: unknown): boolean {
    return err instanceof Error && err.message.includes("UNIQUE constraint failed");
  }

  getTask(runId: string): TaskRow | undefined {
    return this.db.prepare("SELECT * FROM tasks WHERE run_id = ?").get(runId) as TaskRow | undefined;
  }

  getTaskBySubmission(id: string): TaskRow | undefined {
    return this.db
      .prepare("SELECT * FROM tasks WHERE client_submission_id = ?")
      .get(id) as TaskRow | undefined;
  }

  // ---------- A.1 核心：租约与围栏写 ----------

  /**
   * A.1 boot 自愈（T8 WorkerPool.start 首步调用）：单服务部署不变量下，进程启动时
   * 不可能有合法租约持有者——上一次进程死亡残留的 running 任务全部回队（status→queued、
   * 清租约与 stage；attempt 不动，下次 claim 时 +1 走恢复路径）。
   * 必须回队而非仅清租约：listRunnable 只放行 queued，而 reaper 的围栏 UPDATE 绑定
   * lease_owner，对 NULL 属主行永不匹配——"清租约但保持 running"的任务会永久卡死，
   * 既不可被 claim 也不可被收尸（M1 计划 T7 的"boot 自愈后 queued→恢复路径"语义）。
   * 超预算的回队任务由 reaper 的 queued-zombie 分支终态（A.4 接管臂拒绝 claim）。
   * 返回回队任务数（0 = 干净启动）。
   */
  healOrphans(): number {
    return this.db
      .prepare(
        `UPDATE tasks SET status='queued', lease_owner=NULL, lease_expires_at=NULL, stage=NULL
         WHERE status='running'`,
      )
      .run().changes;
  }

  /** 全局 queued 水位（T8：MAX_QUEUE 队列上限判定 + /api/health 队列深度）。 */
  countQueued(): number {
    return this.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status='queued'").get().n as number;
  }

  /**
   * 原子获权（A.1 L1）：单条条件 UPDATE——status='queued'，或 status='running' 但租约
   * 已过期/无主（接管与 boot 自愈路径），且租约空闲、未过 deadline（A.4 接管臂：超预算
   * 任务不可被接管续跑，只能走 reaper 的 deadline 分支终态 failed）才放行。
   * rowcount 判定胜负；成功时 attempt+1、deadline 首次固化（A.4）、同步写 stage 事件
   * （seq 在同一同步事务内 MAX(seq)+1 分配，A.3 事件层）。
   */
  claimLease(runId: string, workerId: string, ttlMs: number, budgetS: number): Lease | false {
    const ts = this.now();
    return this.db.transaction(() => {
      const r = this.db
        .prepare(
          `UPDATE tasks
           SET status='running', lease_owner=?, lease_expires_at=?,
               attempt=attempt+1, deadline=COALESCE(deadline, created_at + ? * 1000), updated_at=?
           WHERE run_id=? AND status IN ('queued','running') AND ${LEASE_FREE} AND ${WITHIN_BUDGET}`,
        )
        .run(workerId, ts + ttlMs, budgetS, ts, runId, ts, ts);
      if (r.changes === 0) return false;
      const attempt = this.getTask(runId)!.attempt;
      this.insertEventUnfenced(runId, "stage", { stage: "queued", to: "running", attempt }, ts);
      return { run_id: runId, attempt, lease_owner: workerId };
    })();
  }

  heartbeat(lease: Lease, ttlMs: number): FencedResult {
    const ts = this.now();
    const r = this.db
      .prepare(
        `UPDATE tasks SET lease_expires_at = ?, updated_at = ? WHERE ${FENCE} AND status='running'`,
      )
      .run(ts + ttlMs, ts, lease.run_id, lease.attempt, lease.lease_owner);
    return { fenced: r.changes === 0 };
  }

  updateStage(lease: Lease, stage: string): FencedResult {
    const ts = this.now();
    const r = this.db
      .prepare(`UPDATE tasks SET stage = ?, updated_at = ? WHERE ${FENCE} AND status='running'`)
      .run(stage, ts, lease.run_id, lease.attempt, lease.lease_owner);
    return { fenced: r.changes === 0 };
  }

  /**
   * 终态写入（A.3：先到先得）——WHERE 追加 status='running'，二次 finalize 自然被拒。
   * 终态同时清租约与 cancel_requested（终态后 requestCancel 不再生效）。
   */
  finalize(
    lease: Lease,
    status: "succeeded" | "failed" | "cancelled",
    errorCode?: string,
    errorMessage?: string,
  ): FencedResult {
    const ts = this.now();
    const r = this.db
      .prepare(
        `UPDATE tasks SET status=?, error_code=?, error_message=?, lease_owner=NULL,
                          lease_expires_at=NULL, cancel_requested=0, updated_at=?
         WHERE ${FENCE} AND status='running'`,
      )
      .run(status, errorCode ?? null, errorMessage ?? null, ts, lease.run_id, lease.attempt, lease.lease_owner);
    return { fenced: r.changes === 0 };
  }

  // ---------- C2-B2：清理证据 + 终态/重试的单一事务 ----------

  /**
   * 成功/失败终态 + cleanup_reports + 可选 publication/report 事件 + done
   * 必须在同一 SQLite 事务内提交。succeeded 只接受 seal 成功且 overallOk=true 的报告。
   */
  finalizeWithCleanup(lease: Lease, input: FinalizeWithCleanupInput): CleanupFencedResult {
    if (!isPlainObject(input) || input === null) {
      cleanupFail("CLEANUP_INPUT_INVALID", "finalizeWithCleanup input is required");
    }
    const status = input.status;
    if (status !== "succeeded" && status !== "failed" && status !== "cancelled") {
      cleanupFail("CLEANUP_INPUT_INVALID", "invalid terminal status");
    }
    if (status !== "succeeded" && input.publication !== undefined) {
      cleanupFail("CLEANUP_PUBLICATION_STATUS_INVALID", "publication is only valid for succeeded tasks");
    }
    if (status === "succeeded" && input.errorCode !== undefined && input.errorCode !== "") {
      cleanupFail("CLEANUP_SUCCESS_ERROR_CODE", "succeeded cleanup finalize must not carry an error code");
    }
    if (input.errorCode !== undefined) {
      if (
        typeof input.errorCode !== "string" ||
        input.errorCode.length === 0 ||
        input.errorCode.length > 128 ||
        CONTROL_RE.test(input.errorCode)
      ) {
        cleanupFail("CLEANUP_ERROR_CODE_INVALID", "errorCode must be a short control-free string");
      }
    }
    if (input.publication !== undefined) {
      if (
        !isPlainObject(input.publication) ||
        typeof input.publication.reportPath !== "string" ||
        input.publication.reportPath.length === 0 ||
        input.publication.reportPath.length > 4096 ||
        CONTROL_RE.test(input.publication.reportPath)
      ) {
        cleanupFail("CLEANUP_PUBLICATION_INVALID", "publication.reportPath must be a non-empty path");
      }
    }

    const validated = validateSealedReport(input.report, lease, status === "succeeded");
    if (status === "succeeded" && validated.report.trigger !== "task_success") {
      cleanupFail(
        "CLEANUP_TRIGGER_STATUS_INVALID",
        "succeeded finalize requires a task_success cleanup report",
      );
    }
    validateDoneEvent(input.doneEvent, lease, status);
    const ts = this.now();
    const tx = this.db.transaction((): CleanupFencedResult => {
      if (!this.leaseHeldInTransaction(lease)) return { fenced: true };
      if (this.countDoneEvents(lease.run_id) > 0) {
        cleanupFail("CLEANUP_DONE_ALREADY_EXISTS", "a done event already exists for this run");
      }

      this.insertCleanupReportRow({
        runId: lease.run_id,
        attempt: lease.attempt,
        cleanupId: String(validated.report.cleanupId),
        trigger: String(validated.report.trigger),
        platform: String(validated.report.platform),
        sealed: true,
        overallOk: validated.overallOk,
        reportJson: validated.json,
        errorCode: input.errorCode ?? null,
        createdAt: ts,
      });

      let publicationPath: string | undefined;
      if (input.publication) {
        const existingPublication = this.db
          .prepare("SELECT 1 AS present FROM publications WHERE run_id = ?")
          .get(lease.run_id) as { present: number } | undefined;
        if (existingPublication) {
          cleanupFail(
            "CLEANUP_PUBLICATION_ALREADY_EXISTS",
            "publication must be written by finalizeWithCleanup, not before it",
          );
        }
        const existingReportEvent = this.db
          .prepare("SELECT 1 AS present FROM events WHERE run_id = ? AND type = 'report' LIMIT 1")
          .get(lease.run_id) as { present: number } | undefined;
        if (existingReportEvent) {
          cleanupFail(
            "CLEANUP_REPORT_EVENT_ALREADY_EXISTS",
            "report event must be written by finalizeWithCleanup, not before it",
          );
        }
        this.db
          .prepare("INSERT INTO publications (run_id, report_path, published_at) VALUES (?, ?, ?)")
          .run(lease.run_id, input.publication.reportPath, ts);
        publicationPath = input.publication.reportPath;
        this.insertEventUnfenced(lease.run_id, "report", { path: publicationPath }, ts);
      }

      const doneSeq = this.insertEventUnfenced(lease.run_id, "done", input.doneEvent, ts);
      if (!this.updateTerminalInTransaction(lease, status, input.errorCode, input.errorMessage, ts)) {
        cleanupFail("CLEANUP_FENCED", "lease fence lost while committing cleanup terminal");
      }
      return {
        fenced: false,
        reportStored: true,
        doneSeq,
        ...(publicationPath !== undefined ? { publicationPath } : {}),
      };
    });
    return tx.immediate();
  }

  /**
   * 可续跑失败释放租约：只接受 sealed + overallOk=true 的报告；不写 done、不改终态。
   * cleanup pending/failed 永远不能进入下一 attempt。
   */
  releaseForRetryWithCleanup(lease: Lease, input: ReleaseForRetryWithCleanupInput): CleanupFencedResult {
    if (!isPlainObject(input)) {
      cleanupFail("CLEANUP_INPUT_INVALID", "releaseForRetryWithCleanup input is required");
    }
    const validated = validateSealedReport(input.report, lease, true);
    if (validated.report.trigger !== "timeout" && validated.report.trigger !== "engine_error") {
      cleanupFail(
        "CLEANUP_RETRY_TRIGGER_INVALID",
        "releaseForRetryWithCleanup only accepts timeout/engine_error cleanup reports",
      );
    }
    const ts = this.now();
    const tx = this.db.transaction((): CleanupFencedResult => {
      if (!this.leaseHeldInTransaction(lease)) return { fenced: true };
      if (this.countDoneEvents(lease.run_id) > 0) {
        cleanupFail("CLEANUP_DONE_ALREADY_EXISTS", "cannot release for retry after a done event");
      }
      const published = this.db
        .prepare("SELECT 1 AS present FROM publications WHERE run_id = ?")
        .get(lease.run_id) as { present: number } | undefined;
      if (published) {
        cleanupFail("CLEANUP_PUBLICATION_ALREADY_EXISTS", "cannot release a published task for retry");
      }
      this.insertCleanupReportRow({
        runId: lease.run_id,
        attempt: lease.attempt,
        cleanupId: String(validated.report.cleanupId),
        trigger: String(validated.report.trigger),
        platform: String(validated.report.platform),
        sealed: true,
        overallOk: validated.overallOk,
        reportJson: validated.json,
        errorCode: null,
        createdAt: ts,
      });
      const r = this.db
        .prepare(
          `UPDATE tasks SET lease_owner=NULL, lease_expires_at=NULL, updated_at=?
           WHERE ${FENCE} AND status='running'`,
        )
        .run(ts, lease.run_id, lease.attempt, lease.lease_owner);
      if (r.changes === 0) {
        cleanupFail("CLEANUP_FENCED", "lease fence lost while releasing for retry");
      }
      return { fenced: false, reportStored: true };
    });
    return tx.immediate();
  }

  /**
   * 无法生成合法 sealed 报告时的明确失败终态（sealed=0）。
   * 只允许 failed/cancelled；绝不产生 succeeded。
   */
  finalizeCleanupFailure(lease: Lease, input: FinalizeCleanupFailureInput): CleanupFencedResult {
    if (!isPlainObject(input)) {
      cleanupFail("CLEANUP_INPUT_INVALID", "finalizeCleanupFailure input is required");
    }
    if (input.status !== "failed" && input.status !== "cancelled") {
      cleanupFail("CLEANUP_SUCCESS_FORBIDDEN", "finalizeCleanupFailure cannot produce succeeded");
    }
    const cleanupId = validateCleanupId(input.cleanupId, "CLEANUP_FAILURE_INVALID");
    if (typeof input.trigger !== "string" || !CLEANUP_TRIGGERS.has(input.trigger)) {
      cleanupFail("CLEANUP_FAILURE_INVALID", "cleanup trigger is invalid");
    }
    if (typeof input.platform !== "string" || !CLEANUP_PLATFORMS.has(input.platform)) {
      cleanupFail("CLEANUP_FAILURE_INVALID", "cleanup platform is invalid");
    }
    const errorCode = validateErrorCode(input.errorCode, "errorCode");
    validateDoneEvent(input.doneEvent, lease, input.status);
    const ts = this.now();
    const tx = this.db.transaction((): CleanupFencedResult => {
      if (!this.leaseHeldInTransaction(lease)) return { fenced: true };
      if (this.countDoneEvents(lease.run_id) > 0) {
        cleanupFail("CLEANUP_DONE_ALREADY_EXISTS", "a done event already exists for this run");
      }
      this.insertCleanupReportRow({
        runId: lease.run_id,
        attempt: lease.attempt,
        cleanupId,
        trigger: input.trigger,
        platform: input.platform,
        sealed: false,
        overallOk: false,
        reportJson: null,
        errorCode,
        createdAt: ts,
      });
      const doneSeq = this.insertEventUnfenced(lease.run_id, "done", input.doneEvent, ts);
      if (!this.updateTerminalInTransaction(lease, input.status, errorCode, input.errorMessage, ts)) {
        cleanupFail("CLEANUP_FENCED", "lease fence lost while committing cleanup failure");
      }
      return { fenced: false, reportStored: true, doneSeq };
    });
    return tx.immediate();
  }

  /** 内部证据读取；sealed=0 返回 report=null。 */
  getCleanupReport(runId: string, attempt: number): CleanupReportRow | undefined {
    const row = this.db
      .prepare(
        `SELECT run_id, attempt, cleanup_id, trigger, platform, sealed, overall_ok,
                report_json, error_code, created_at
         FROM cleanup_reports WHERE run_id = ? AND attempt = ?`,
      )
      .get(runId, attempt) as
      | {
          run_id: string;
          attempt: number;
          cleanup_id: string;
          trigger: string;
          platform: string;
          sealed: number;
          overall_ok: number;
          report_json: string | null;
          error_code: string | null;
          created_at: number;
        }
      | undefined;
    if (!row) return undefined;
    let report: TaskCleanupReport | null = null;
    if (row.report_json !== null) {
      try {
        report = JSON.parse(row.report_json) as TaskCleanupReport;
      } catch {
        cleanupFail("CLEANUP_REPORT_CORRUPT", "stored cleanup report is not valid JSON");
      }
    }
    return {
      run_id: row.run_id,
      attempt: row.attempt,
      cleanup_id: row.cleanup_id,
      trigger: row.trigger,
      platform: row.platform,
      sealed: row.sealed === 1,
      overall_ok: row.overall_ok === 1,
      report,
      error_code: row.error_code,
      created_at: row.created_at,
    };
  }

  private leaseHeldInTransaction(lease: Lease): boolean {
    const held = this.db
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE ${FENCE} AND status='running'`)
      .get(lease.run_id, lease.attempt, lease.lease_owner).n as number;
    return held > 0;
  }

  private countDoneEvents(runId: string): number {
    return this.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND type = 'done'")
      .get(runId).n as number;
  }

  private insertCleanupReportRow(row: {
    runId: string;
    attempt: number;
    cleanupId: string;
    trigger: string;
    platform: string;
    sealed: boolean;
    overallOk: boolean;
    reportJson: string | null;
    errorCode: string | null;
    createdAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO cleanup_reports
           (run_id, attempt, cleanup_id, trigger, platform, sealed, overall_ok,
            report_json, error_code, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.runId,
        row.attempt,
        row.cleanupId,
        row.trigger,
        row.platform,
        row.sealed ? 1 : 0,
        row.overallOk ? 1 : 0,
        row.reportJson,
        row.errorCode,
        row.createdAt,
      );
  }

  private updateTerminalInTransaction(
    lease: Lease,
    status: CleanupTerminalStatus,
    errorCode: string | undefined,
    errorMessage: string | undefined,
    ts: number,
  ): boolean {
    const r = this.db
      .prepare(
        `UPDATE tasks SET status=?, error_code=?, error_message=?, lease_owner=NULL,
                          lease_expires_at=NULL, cancel_requested=0, updated_at=?
         WHERE ${FENCE} AND status='running'`,
      )
      .run(
        status,
        errorCode ?? null,
        errorMessage ?? null,
        ts,
        lease.run_id,
        lease.attempt,
        lease.lease_owner,
      );
    return r.changes > 0;
  }

  /**
   * A.3 事件层：seq 在同一同步事务内 MAX(seq)+1 分配（better-sqlite3 同步调用天然原子
   * 单调），写事件前先验围栏——失权者连事件都写不进（A.1）。
   */
  appendEvent(lease: Lease, type: string, payload: unknown): FencedResult & { seq?: number } {
    const ts = this.now();
    return this.db.transaction(() => {
      const held = this.db
        .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE ${FENCE} AND status='running'`)
        .get(lease.run_id, lease.attempt, lease.lease_owner).n as number;
      if (held === 0) return { fenced: true };
      const seq = this.insertEventUnfenced(lease.run_id, type, payload, ts);
      this.db
        .prepare(`UPDATE tasks SET updated_at=? WHERE ${FENCE}`)
        .run(ts, lease.run_id, lease.attempt, lease.lease_owner);
      return { fenced: false, seq };
    })();
  }

  /** seq 分配唯一入口：仅限已验证围栏/已获权的同步事务内调用（A.3）。 */
  private insertEventUnfenced(runId: string, type: string, payload: unknown, ts: number): number {
    const seq = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events WHERE run_id = ?")
      .get(runId).seq as number;
    this.db
      .prepare("INSERT INTO events (run_id, seq, type, payload, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(runId, seq, type, JSON.stringify(payload ?? null), ts);
    return seq;
  }

  listEvents(runId: string, afterSeq: number): EventRow[] {
    return this.db
      .prepare(
        "SELECT seq, type, payload, created_at FROM events WHERE run_id = ? AND seq > ? ORDER BY seq",
      )
      .all(runId, afterSeq)
      .map((r: any) => ({
        seq: r.seq,
        type: r.type,
        payload: JSON.parse(r.payload as string),
        created_at: r.created_at,
      }));
  }

  // ---------- A.3 结果层：恰好一次发布 ----------

  recordPublication(runId: string, reportPath: string): { published: boolean; report_path: string } {
    return this.db.transaction((): { published: boolean; report_path: string } => {
      const r = this.db
        .prepare("INSERT OR IGNORE INTO publications (run_id, report_path, published_at) VALUES (?, ?, ?)")
        .run(runId, reportPath, this.now());
      if (r.changes > 0) return { published: true, report_path: reportPath };
      const existing = this.db
        .prepare("SELECT report_path FROM publications WHERE run_id = ?")
        .get(runId) as { report_path: string };
      return { published: false, report_path: existing.report_path };
    })();
  }

  /** A.4 行4 恢复入口查询：run_id 是否已发布（只读，无需围栏——恢复路径的判定事实源）。 */
  getPublication(runId: string): { report_path: string; published_at: number } | undefined {
    return this.db
      .prepare("SELECT report_path, published_at FROM publications WHERE run_id = ?")
      .get(runId) as { report_path: string; published_at: number } | undefined;
  }

  /**
   * 重试释放（A.4 行1 的接续臂，T7 编排器专用）：可续跑的基础设施故障后，本执行者
   * 主动让出租约（status 保持 running、清 lease 字段）——紧随其后的 claimLease 才能以
   * attempt+1 接管（同 worker 或接管者均可；释放与重 claim 的窗口内被抢走属 A.1 允许
   * 的正确形态）。围栏条件写：失权返回 fenced，调用方不得再续跑。
   */
  releaseForRetry(lease: Lease): FencedResult {
    const ts = this.now();
    const r = this.db
      .prepare(
        `UPDATE tasks SET lease_owner=NULL, lease_expires_at=NULL, updated_at=?
         WHERE ${FENCE} AND status='running'`,
      )
      .run(ts, lease.run_id, lease.attempt, lease.lease_owner);
    return { fenced: r.changes === 0 };
  }

  // ---------- A.3 取消标志 / A.4 Reaper ----------

  /** 无围栏（A.3：无执行权者只置标志，不直接写终态）。终态任务上无效。 */
  requestCancel(runId: string): boolean {
    return (
      this.db
        .prepare(
          "UPDATE tasks SET cancel_requested=1, updated_at=? WHERE run_id=? AND status IN ('queued','running')",
        )
        .run(this.now(), runId).changes > 0
    );
  }

  /**
   * A.1 Reaper：对 running 且租约过期的任务，用同一条围栏条件 UPDATE 原子判定——
   *   cancel_requested → cancelled；attempt 达 maxAttempts 或 deadline<now → failed/UNRECOVERABLE；
   *   否则回 queued（lease 清空、stage 复位、attempt 不动，下次 claim 时 +1）。
   * 围栏含 lease_expires_at < now：过期瞬间被原主 heartbeat 续上的任务自动落空。
   * 另处理 queued 且 deadline 已过的任务（接管臂拒 claim 后的僵尸收尾：boot 自愈回队
   * 或回队后过预算——否则永久卡 queued 且堵死会话队首）→ failed/UNRECOVERABLE。
   */
  reapExpired(now: number, maxAttempts: number): ReapedTask[] {
    const expired = this.db
      .prepare(
        `SELECT run_id, lease_owner, attempt, cancel_requested, deadline
         FROM tasks WHERE status='running' AND ${LEASE_FREE}`,
      )
      .all(now) as { run_id: string; lease_owner: string; attempt: number; cancel_requested: number; deadline: number | null }[];
    const out: ReapedTask[] = [];
    for (const t of expired) {
      const overLimit = t.attempt >= maxAttempts;
      const overDeadline = t.deadline != null && t.deadline < now;
      const verdict: TaskStatus =
        t.cancel_requested === 1 ? "cancelled" : overLimit || overDeadline ? "failed" : "queued";
      // 逐行事务包裹：围栏判定基于行快照（cancel_requested/deadline）与条件 UPDATE 必须
      // 原子成立——未来第二连接场景下防止 requestCancel 落在 SELECT→UPDATE 窗口被清（取消丢失）。
      const applied = this.db.transaction((): boolean => {
        const r = this.db
          .prepare(
            `UPDATE tasks SET status=?, error_code=?, error_message=?, cancel_requested=0,
                              lease_owner=NULL, lease_expires_at=NULL, stage=NULL, updated_at=?
             WHERE ${FENCE} AND status='running' AND lease_expires_at < ?`,
          )
          .run(
            verdict,
            verdict === "failed" ? "UNRECOVERABLE" : null,
            verdict === "failed" ? (overLimit ? "reaper: attempt 超限" : "reaper: deadline 已过") : null,
            now,
            t.run_id,
            t.attempt,
            t.lease_owner,
            now,
          );
        return r.changes > 0;
      })();
      if (applied) out.push({ run_id: t.run_id, status: verdict });
    }
    // queued 且已过 deadline：接管臂使 claim 永远 false，此处是唯一终态出口
    const zombies = this.db
      .prepare("SELECT run_id FROM tasks WHERE status='queued' AND deadline IS NOT NULL AND deadline < ?")
      .all(now) as { run_id: string }[];
    for (const z of zombies) {
      const r = this.db
        .prepare(
          `UPDATE tasks SET status='failed', error_code='UNRECOVERABLE',
                            error_message='reaper: deadline 已过（queued）', updated_at=?
           WHERE run_id=? AND status='queued' AND deadline < ?`,
        )
        .run(now, z.run_id, now);
      if (r.changes > 0) out.push({ run_id: z.run_id, status: "failed" });
    }
    return out;
  }

  // ---------- A.2 S1：同会话串行 + S2 历史查询 ----------

  /**
   * A.2 S1：只放行"会话队首（最早的未终态任务）且恰为 queued"的任务——同会话第二个
   * 任务在前一任务终态前不可见、不可 claim（reap 回队路径同理：回 queued 即重新成为
   * 队首候选）。created_at 同毫秒用隐式 rowid 保持严格 FIFO。
   */
  listRunnable(limit: number): TaskRow[] {
    return this.db
      .prepare(
        `SELECT * FROM tasks t
         WHERE t.status='queued'
           AND t.rowid = (
             SELECT r.rowid FROM tasks r
             WHERE r.session_id = t.session_id AND r.status IN ('queued','running')
             ORDER BY r.created_at, r.rowid LIMIT 1
           )
         ORDER BY t.created_at, t.rowid
         LIMIT ?`,
      )
      .all(limit) as TaskRow[];
  }

  /** 本会话全部任务（按创建序）：A.2 S2 历史注入的事实源查询（T7 恢复路径消费）。 */
  sessionHistory(sessionId: string): SessionHistoryEntry[] {
    const tasks = this.db
      .prepare(
        "SELECT run_id, question, status FROM tasks WHERE session_id = ? ORDER BY created_at, rowid",
      )
      .all(sessionId) as { run_id: string; question: string; status: TaskStatus }[];
    const sqlRefs = this.db.prepare(
      "SELECT payload FROM events WHERE run_id = ? AND type='sql' ORDER BY seq",
    );
    const answerStmt = this.db.prepare(
      "SELECT payload FROM events WHERE run_id = ? AND type='answer' ORDER BY seq DESC LIMIT 1",
    );
    return tasks.map((t) => {
      // 失败任务仅保留问题文本（S2：模型知道问过什么、结果不可信）
      const failed = t.status === "failed" || t.status === "cancelled";
      const refs: string[] = [];
      if (!failed) {
        for (const e of sqlRefs.all(t.run_id) as { payload: string }[]) {
          const ref = (JSON.parse(e.payload) as { result_ref?: string }).result_ref;
          if (ref != null) refs.push(ref);
        }
      }
      const ansRow = failed ? undefined : (answerStmt.get(t.run_id) as { payload: string } | undefined);
      // spec §5：answer 事件 payload 形状为 {markdown}——摘要取 markdown 字段
      const final_answer = ansRow ? ((JSON.parse(ansRow.payload) as { markdown?: string }).markdown ?? null) : null;
      return { run_id: t.run_id, question: t.question, status: t.status, result_refs: refs, final_answer };
    });
  }
}
