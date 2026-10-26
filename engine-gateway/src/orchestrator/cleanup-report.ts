// S4-B2-C2-B1：任务清理结果契约。
//
// 设计原则：
//   - 每个 attempt 一份报告；Docker label / 进程组 / cleanup lock 都是 attempt 级身份。
//   - pending / failed 永远不能产生 overallOk=true。
//   - not_applicable 必须有平台或生命周期依据；Linux ACL 不允许无依据 N/A。
//   - overallOk 只由 seal 规则根据五项真实检查状态计算，调用方不能自行赋值成功。
//   - seal 后深冻结，后续消费方不能篡改清理证据。
//
// 本模块不接触 Docker/进程/ACL，只负责不可变契约与判定。

import { randomUUID } from "node:crypto";

export const CLEANUP_COMPONENTS = ["dsh", "runner", "docker", "acl", "audit"] as const;

export type CleanupComponent = (typeof CLEANUP_COMPONENTS)[number];
export type CleanupStatus = "passed" | "failed" | "pending" | "not_applicable";
export type CleanupPlatform = "linux" | "win32" | "other";
export type CleanupTrigger =
  | "task_success"
  | "cancel"
  | "timeout"
  | "engine_error"
  | "lost_lease"
  | "graceful_shutdown"
  | "lease_reaper"
  | "boot_recovery";

export type CleanupApplicability = {
  basis: "platform" | "lifecycle" | "execution";
  detail: string;
};

/** 只允许 code-only 证据；不得塞入路径、脚本、env、Token/Key。 */
export type CleanupEvidence = {
  pid?: number;
  pgid?: number;
  startTicks?: string;
  directChildExited?: boolean;
  processGroupAbsent?: boolean;
  gracefulTimedOut?: boolean;
  forced?: boolean;
  coveredBy?: "dsh_process_group";
  dockerFound?: number;
  dockerCleaned?: number;
  dockerForced?: number;
  dockerMismatches?: number;
  aclStateFiles?: number;
  aclResidualEntries?: number;
  aclVerifiedWith?: "getfacl";
  auditEvents?: number;
  auditFailures?: number;
  platform?: CleanupPlatform;
};

export type CleanupCheck = {
  component: CleanupComponent;
  required: boolean;
  status: CleanupStatus;
  /** 封闭集风格的状态码，例如 DSH_TERMINATED_VERIFIED / ACL_RESTORE_PENDING_C3。 */
  reason: string;
  evidence: CleanupEvidence;
  applicability?: CleanupApplicability;
};

export type TaskCleanupChecks = {
  dsh: CleanupCheck;
  runner: CleanupCheck;
  docker: CleanupCheck;
  acl: CleanupCheck;
  audit: CleanupCheck;
};

export type TaskCleanupReportDraft = {
  version: 1;
  cleanupId: string;
  runId: string;
  attempt: number;
  trigger: CleanupTrigger;
  platform: CleanupPlatform;
  startedAt: string;
  checks: TaskCleanupChecks;
  finishedAt: null;
  overallOk: false;
};

export type TaskCleanupReport = {
  version: 1;
  cleanupId: string;
  runId: string;
  attempt: number;
  trigger: CleanupTrigger;
  platform: CleanupPlatform;
  startedAt: string;
  checks: TaskCleanupChecks;
  finishedAt: string;
  overallOk: boolean;
};

export type CreatePendingCleanupReportInput = {
  runId: string;
  attempt: number;
  trigger: CleanupTrigger;
  platform: CleanupPlatform;
  cleanupId?: string;
  now?: string;
};

const STATUSES = new Set<CleanupStatus>(["passed", "failed", "pending", "not_applicable"]);
const TRIGGERS = new Set<CleanupTrigger>([
  "task_success",
  "cancel",
  "timeout",
  "engine_error",
  "lost_lease",
  "graceful_shutdown",
  "lease_reaper",
  "boot_recovery",
]);
const PLATFORMS = new Set<CleanupPlatform>(["linux", "win32", "other"]);
const BASES = new Set(["platform", "lifecycle", "execution"]);
const LIFECYCLE_DETAILS: Record<"dsh" | "runner", Set<string>> = {
  dsh: new Set(["dsh_not_spawned"]),
  runner: new Set(["dsh_not_spawned", "runner_not_spawned"]),
};
const REASON_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const CONTROL_RE = /[\x00-\x1f\x7f]/;

const EVIDENCE_KEYS = new Set([
  "pid",
  "pgid",
  "startTicks",
  "directChildExited",
  "processGroupAbsent",
  "gracefulTimedOut",
  "forced",
  "coveredBy",
  "dockerFound",
  "dockerCleaned",
  "dockerForced",
  "dockerMismatches",
  "aclStateFiles",
  "aclResidualEntries",
  "aclVerifiedWith",
  "auditEvents",
  "auditFailures",
  "platform",
]);

const NUMBER_EVIDENCE = new Set([
  "pid",
  "pgid",
  "dockerFound",
  "dockerCleaned",
  "dockerForced",
  "dockerMismatches",
  "aclStateFiles",
  "aclResidualEntries",
  "auditEvents",
  "auditFailures",
]);

const BOOLEAN_EVIDENCE = new Set([
  "directChildExited",
  "processGroupAbsent",
  "gracefulTimedOut",
  "forced",
]);

const STRING_EVIDENCE = new Set(["startTicks", "coveredBy", "aclVerifiedWith", "platform"]);

export class CleanupReportError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "CleanupReportError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new CleanupReportError(code, message);
}

function nonEmptyString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || CONTROL_RE.test(value)) {
    fail("REPORT_FIELD_INVALID", `${field} must be a non-empty string (max ${max}, no control chars)`);
  }
  return value;
}

function isoTime(value: unknown, field: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    fail("REPORT_TIME_INVALID", `${field} must be an ISO-parseable timestamp`);
  }
  return value;
}

function pendingCheck(component: CleanupComponent, required: boolean): CleanupCheck {
  return {
    component,
    required,
    status: "pending",
    reason: "PENDING",
    evidence: {},
  };
}

/**
 * 创建可变草稿。dsh/runner 默认 required=true；若确认从未 spawn，调用方可在 seal 前
 * 改为 required=false + not_applicable（必须附 lifecycle 依据）。
 */
export function createPendingTaskCleanupReport(input: CreatePendingCleanupReportInput): TaskCleanupReportDraft {
  const now = isoTime(input.now ?? new Date().toISOString(), "now");
  if (typeof input.runId !== "string" || !input.runId || input.runId.length > 256 || CONTROL_RE.test(input.runId)) {
    fail("REPORT_RUN_ID_INVALID", "runId must be a non-empty string without control chars");
  }
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 0) {
    fail("REPORT_ATTEMPT_INVALID", "attempt must be a non-negative safe integer");
  }
  if (!TRIGGERS.has(input.trigger)) fail("REPORT_TRIGGER_INVALID", "unknown cleanup trigger");
  if (!PLATFORMS.has(input.platform)) fail("REPORT_PLATFORM_INVALID", "unknown cleanup platform");

  const cleanupId = nonEmptyString(input.cleanupId ?? randomUUID(), "cleanupId", 128);

  return {
    version: 1,
    cleanupId,
    runId: input.runId,
    attempt: input.attempt,
    trigger: input.trigger,
    platform: input.platform,
    startedAt: now,
    checks: {
      dsh: pendingCheck("dsh", true),
      runner: pendingCheck("runner", true),
      docker: pendingCheck("docker", true),
      acl: pendingCheck("acl", input.platform !== "win32"),
      audit: pendingCheck("audit", true),
    },
    finishedAt: null,
    overallOk: false,
  };
}

function validateEvidence(evidence: unknown, component: CleanupComponent): CleanupEvidence {
  if (evidence === null || typeof evidence !== "object" || Array.isArray(evidence)) {
    fail("REPORT_EVIDENCE_INVALID", `${component}.evidence must be a plain object`);
  }
  const out: CleanupEvidence = {};
  for (const [key, value] of Object.entries(evidence)) {
    if (value === undefined) continue;
    if (!EVIDENCE_KEYS.has(key)) {
      fail("REPORT_EVIDENCE_INVALID", `${component}.evidence.${key} is not an allowed code-only field`);
    }
    if (NUMBER_EVIDENCE.has(key)) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        fail("REPORT_EVIDENCE_INVALID", `${component}.evidence.${key} must be a non-negative finite number`);
      }
      (out as Record<string, unknown>)[key] = value;
    } else if (BOOLEAN_EVIDENCE.has(key)) {
      if (typeof value !== "boolean") {
        fail("REPORT_EVIDENCE_INVALID", `${component}.evidence.${key} must be boolean`);
      }
      (out as Record<string, unknown>)[key] = value;
    } else if (STRING_EVIDENCE.has(key)) {
      if (typeof value !== "string" || value.length === 0 || value.length > 128 || CONTROL_RE.test(value)) {
        fail("REPORT_EVIDENCE_INVALID", `${component}.evidence.${key} must be a short string without control chars`);
      }
      if (key === "startTicks" && !/^[0-9]+$/.test(value)) {
        fail("REPORT_EVIDENCE_INVALID", `${component}.evidence.startTicks must be numeric`);
      }
      if (key === "coveredBy" && value !== "dsh_process_group") {
        fail("REPORT_EVIDENCE_INVALID", `${component}.evidence.coveredBy has an unsupported value`);
      }
      if (key === "aclVerifiedWith" && value !== "getfacl") {
        fail("REPORT_EVIDENCE_INVALID", `${component}.evidence.aclVerifiedWith has an unsupported value`);
      }
      if (key === "platform" && !PLATFORMS.has(value as CleanupPlatform)) {
        fail("REPORT_EVIDENCE_INVALID", `${component}.evidence.platform has an unsupported value`);
      }
      (out as Record<string, unknown>)[key] = value;
    }
  }
  if (out.coveredBy !== undefined && component !== "runner") {
    fail("REPORT_EVIDENCE_INVALID", "coveredBy is only valid on the runner check");
  }
  return out;
}

function validateApplicability(
  applicability: unknown,
  component: CleanupComponent,
  platform: CleanupPlatform,
  required: boolean,
  status: CleanupStatus,
): CleanupApplicability | undefined {
  if (status !== "not_applicable") {
    if (applicability !== undefined) {
      fail("REPORT_APPLICABILITY_INVALID", `${component}.applicability is only valid for not_applicable`);
    }
    return undefined;
  }

  if (required) fail("REPORT_NA_REQUIRED", `${component} cannot be not_applicable while required=true`);
  if (applicability === null || typeof applicability !== "object" || Array.isArray(applicability)) {
    fail("REPORT_NA_BASIS_REQUIRED", `${component} not_applicable requires an applicability basis`);
  }
  const rec = applicability as Record<string, unknown>;
  if (!BASES.has(String(rec.basis))) {
    fail("REPORT_NA_BASIS_REQUIRED", `${component} applicability.basis is invalid`);
  }
  const detail = nonEmptyString(rec.detail, `${component}.applicability.detail`, 200);
  const basis = rec.basis as CleanupApplicability["basis"];

  if (component === "docker" || component === "audit") {
    fail("REPORT_NA_FORBIDDEN", `${component} can never be not_applicable`);
  }
  if (component === "acl") {
    if (platform === "linux") fail("ACL_NA_FORBIDDEN_LINUX", "Linux ACL cannot be not_applicable");
    if (platform !== "win32") fail("ACL_NA_BASIS_INVALID", "ACL not_applicable is only supported on win32");
    if (basis !== "platform" || detail !== "win32") {
      fail("ACL_NA_BASIS_INVALID", "win32 ACL not_applicable requires basis=platform, detail=win32");
    }
  }
  if (component === "dsh" || component === "runner") {
    if (basis !== "lifecycle") {
      fail("REPORT_NA_BASIS_INVALID", `${component} not_applicable requires a lifecycle basis`);
    }
    if (!LIFECYCLE_DETAILS[component].has(detail)) {
      fail("REPORT_NA_BASIS_INVALID", `${component} not_applicable lifecycle detail is not recognised`);
    }
  }
  return { basis, detail };
}

function sealCheck(
  key: CleanupComponent,
  raw: unknown,
  platform: CleanupPlatform,
): CleanupCheck {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail("REPORT_CHECK_INVALID", `${key} must be a check object`);
  }
  const check = raw as Record<string, unknown>;
  if (check.component !== key) {
    fail("REPORT_COMPONENT_MISMATCH", `${key}.component must equal "${key}"`);
  }
  if (typeof check.required !== "boolean") {
    fail("REPORT_FIELD_INVALID", `${key}.required must be boolean`);
  }
  if (!STATUSES.has(check.status as CleanupStatus)) {
    fail("REPORT_STATUS_INVALID", `${key}.status is invalid`);
  }
  const reason = nonEmptyString(check.reason, `${key}.reason`, 64);
  if (!REASON_RE.test(reason)) {
    fail("REPORT_REASON_INVALID", `${key}.reason must be a closed-set-style code`);
  }
  const evidence = validateEvidence(check.evidence, key);
  const required = check.required;
  const status = check.status as CleanupStatus;
  const applicability = validateApplicability(check.applicability, key, platform, required, status);

  if (key === "docker" || key === "audit") {
    if (!required) fail("REPORT_REQUIRED_INVALID", `${key} must always be required`);
  }
  if (key === "acl") {
    if (platform === "win32") {
      if (status !== "not_applicable" || required) {
        fail("ACL_NA_REQUIRED_WIN32", "win32 ACL must be not_applicable with required=false");
      }
    } else {
      if (!required) {
        if (platform === "linux") fail("ACL_REQUIRED_LINUX", "Linux ACL check must be required");
        fail("ACL_REQUIRED_NON_WIN32", "ACL check must be required outside win32");
      }
      if (platform === "other" && status === "passed") {
        fail("ACL_PLATFORM_UNVERIFIABLE", "ACL cannot be passed on an unsupported platform");
      }
      if (
        platform === "linux" &&
        status === "passed" &&
        (evidence.aclVerifiedWith !== "getfacl" ||
          evidence.aclResidualEntries !== 0 ||
          evidence.aclStateFiles !== 0)
      ) {
        fail("ACL_EVIDENCE_INVALID", "Linux ACL passed requires getfacl verification and zero residual/state files");
      }
    }
  }

  return {
    component: key,
    required,
    status,
    reason,
    evidence,
    ...(applicability ? { applicability } : {}),
  };
}

function validateLifecycleConsistency(checks: TaskCleanupChecks): void {
  const dshNa = checks.dsh.status === "not_applicable";
  const runnerNa = checks.runner.status === "not_applicable";
  if (dshNa) {
    if (!runnerNa || checks.runner.applicability?.detail !== "dsh_not_spawned") {
      fail("REPORT_LIFECYCLE_INCONSISTENT", "DSH not spawned requires Runner not_applicable with dsh_not_spawned");
    }
  }
  if (runnerNa && checks.runner.applicability?.detail === "dsh_not_spawned" && !dshNa) {
    fail("REPORT_LIFECYCLE_INCONSISTENT", "Runner dsh_not_spawned requires DSH not_applicable");
  }
}

function validateProcessEvidence(checks: TaskCleanupChecks): void {
  const dsh = checks.dsh;
  const runner = checks.runner;
  if (dsh.status === "passed" && dsh.evidence.processGroupAbsent !== true) {
    fail("DSH_EVIDENCE_INVALID", "DSH passed requires processGroupAbsent=true evidence");
  }
  if (runner.status !== "passed") return;
  if (runner.evidence.coveredBy === "dsh_process_group") {
    if (
      dsh.status !== "passed" ||
      dsh.evidence.processGroupAbsent !== true ||
      typeof dsh.evidence.pgid !== "number" ||
      typeof runner.evidence.pgid !== "number" ||
      dsh.evidence.pgid !== runner.evidence.pgid
    ) {
      fail("RUNNER_COVERAGE_UNPROVEN", "Runner coverage by DSH requires passed DSH and identical pgid evidence");
    }
    return;
  }
  if (runner.evidence.processGroupAbsent !== true || typeof runner.evidence.pgid !== "number") {
    fail("RUNNER_EVIDENCE_INVALID", "Runner passed requires its own pgid and processGroupAbsent=true evidence");
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * 封存报告并计算最终结果。调用方此前给 overallOk 的任何值都不会被信任。
 */
export function sealTaskCleanupReport(
  draft: TaskCleanupReportDraft,
  now: string = new Date().toISOString(),
): TaskCleanupReport {
  if (draft === null || typeof draft !== "object" || Array.isArray(draft)) {
    fail("REPORT_INVALID", "draft must be an object");
  }
  if (draft.version !== 1) fail("REPORT_VERSION_INVALID", "unsupported cleanup report version");
  if (draft.finishedAt !== null) fail("REPORT_ALREADY_SEALED", "draft is already sealed");
  const cleanupId = nonEmptyString(draft.cleanupId, "cleanupId", 128);
  if (typeof draft.runId !== "string" || !draft.runId || draft.runId.length > 256 || CONTROL_RE.test(draft.runId)) {
    fail("REPORT_RUN_ID_INVALID", "runId must be a non-empty string without control chars");
  }
  if (!Number.isSafeInteger(draft.attempt) || draft.attempt < 0) {
    fail("REPORT_ATTEMPT_INVALID", "attempt must be a non-negative safe integer");
  }
  if (!TRIGGERS.has(draft.trigger)) fail("REPORT_TRIGGER_INVALID", "unknown cleanup trigger");
  if (!PLATFORMS.has(draft.platform)) fail("REPORT_PLATFORM_INVALID", "unknown cleanup platform");
  const startedAt = isoTime(draft.startedAt, "startedAt");
  const finishedAt = isoTime(now, "finishedAt");
  if (Date.parse(finishedAt) < Date.parse(startedAt)) {
    fail("REPORT_TIME_INVALID", "finishedAt must not precede startedAt");
  }

  const checks = draft.checks;
  if (checks === null || typeof checks !== "object" || Array.isArray(checks)) {
    fail("REPORT_CHECKS_INVALID", "checks must be an object");
  }

  const sealedChecks: TaskCleanupChecks = {
    dsh: sealCheck("dsh", checks.dsh, draft.platform),
    runner: sealCheck("runner", checks.runner, draft.platform),
    docker: sealCheck("docker", checks.docker, draft.platform),
    acl: sealCheck("acl", checks.acl, draft.platform),
    audit: sealCheck("audit", checks.audit, draft.platform),
  };
  validateLifecycleConsistency(sealedChecks);
  validateProcessEvidence(sealedChecks);

  let overallOk = true;
  for (const key of CLEANUP_COMPONENTS) {
    const c = sealedChecks[key];
    // pending/failed never succeed, even on an optional component.
    if (c.status === "pending" || c.status === "failed") overallOk = false;
    if (c.required && c.status !== "passed") overallOk = false;
    if (c.status === "not_applicable" && !c.applicability) overallOk = false;
  }

  const report: TaskCleanupReport = {
    version: 1,
    cleanupId,
    runId: draft.runId,
    attempt: draft.attempt,
    trigger: draft.trigger,
    platform: draft.platform,
    startedAt,
    checks: sealedChecks,
    finishedAt,
    overallOk,
  };
  return deepFreeze(report);
}
