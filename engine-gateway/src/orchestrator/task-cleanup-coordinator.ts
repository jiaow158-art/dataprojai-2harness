// S4-B2-C2-B2-2B：独立 TaskCleanupCoordinator。
//
// 职责：在业务执行结束后，按有界、可审计的顺序完成：
//   DSH graceful shutdown → 进程身份/进程组验证 → active Runner 否决 →
//   Docker 精确回收 → ACL 只读检查 → 审计 fsync → TaskCleanupReport seal。
//
// 安全边界：
//   - 不写 TaskStore/任务终态，不启动/停止 Gateway；
//   - requestShutdown 只由 DshCleanupHandle 发送 JSON-RPC shutdown，不调用 killTree；
//   - 只有 identity + PGID + startTicks 可验证且无 active Runner 时，才允许
//     terminateAndVerify 升级到 SIGTERM/SIGKILL；
//   - leader 已消失且组仍有活进程、Docker 探针失败、active Runner 存在 → pending，
//     不发进程组信号；
//   - ACL 状态目录必须与 DSH/Runner 的 SANDBOX_ACL_STATE_DIR 同源且通过 0700/属主检查；
//   - CleanupAuditLog append/fsync 失败或 report seal 失败时绝不返回 overallOk=true；
//   - 注入 fence/heartbeat 与总时间预算；不依赖进程内清理状态。

import type { CleanupAuditLog } from "./cleanup-audit.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  checkAclCleanup,
  type AclCleanupDeps,
  type AclCleanupResult,
  type AclCleanupTarget,
} from "./acl-cleanup-checker.ts";
import {
  createPendingTaskCleanupReport,
  sealTaskCleanupReport,
  type CleanupApplicability,
  type CleanupCheck,
  type CleanupEvidence,
  type CleanupPlatform,
  type CleanupStatus,
  type CleanupTrigger,
  type TaskCleanupReport,
  type TaskCleanupReportDraft,
} from "./cleanup-report.ts";
import {
  probeLinuxProcessGroupStateDetailed,
  terminateAndVerify,
  type ProcessGroupProbeResult,
  type ProcessIdentity,
  type ProcessTerminationResult,
  type TerminateChild,
} from "./process-termination.ts";
import type { DshCleanupHandle } from "../backends/dsh-sdk-client.ts";
import type {
  SandboxActiveProbeResult,
  SandboxCleanupResult,
  SandboxCleanupTarget,
  SandboxContainerReaper,
} from "./sandbox-container-reaper.ts";
import { validateTrustedDirectory } from "../config/trusted-runtime.ts";

export interface CleanupFence {
  /** 返回当前 lease 是否仍归本 attempt。 */
  check(): boolean | Promise<boolean>;
  /** 可选续租；返回 false 视为失权。 */
  heartbeat?(): boolean | Promise<boolean>;
}

export interface CoordinatorAudit {
  readonly auditOk: boolean;
  readonly failureCount: number;
  readonly eventCount: number;
  append(event: Record<string, unknown>): Promise<{ ok: boolean; code?: string }>;
}

export interface CleanupCoordinatorPaths {
  workdir: string;
  resultsDir: string;
  assetsDir: string;
  /** 与 Runner SANDBOX_ACL_STATE_DIR 同源的实际目录。 */
  aclStateDir: string;
}

export interface TaskCleanupCoordinatorOptions {
  runId: string;
  attempt: number;
  trigger: CleanupTrigger;
  platform: CleanupPlatform;
  cleanupId?: string;
  paths: CleanupCoordinatorPaths;
  /** null/undefined = DSH 从未 spawn。 */
  dsh?: DshCleanupHandle | null;
  reaper: Pick<SandboxContainerReaper, "cleanup" | "probeActive">;
  audit?: CoordinatorAudit | CleanupAuditLog | null;
  aclChecker?: (target: AclCleanupTarget, deps?: AclCleanupDeps) => Promise<AclCleanupResult>;
  aclDeps?: AclCleanupDeps;
  fence: CleanupFence;
  /** 清理总预算；必须显著小于 lease TTL。默认 60s。 */
  timeBudgetMs?: number;
  gracefulMs?: number;
  killMs?: number;
  runnerDrainMs?: number;
  activeProbeIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 测试注入；默认使用真实 /proc 探针。 */
  probeGroupState?: (pgid: number) => Promise<ProcessGroupProbeResult>;
}

export interface TaskCleanupCoordinatorResult {
  report: TaskCleanupReport | null;
  sealed: boolean;
  overallOk: boolean;
  terminationOwned: boolean;
  fenced: boolean;
  failureCode?: string;
  reason?: string;
  durationMs: number;
}

class CleanupFenceLostError extends Error {}
class CleanupBudgetExceededError extends Error {}

interface ActiveSafety {
  ok: boolean;
  reason?: string;
}

interface RunnerLockLease {
  release(): Promise<void>;
}

type RunnerLockResult =
  | { ok: true; lease: RunnerLockLease }
  | { ok: false; reason: string };

const DEFAULT_TIME_BUDGET_MS = 60_000;
const DEFAULT_GRACEFUL_MS = 3_000;
const DEFAULT_KILL_MS = 5_000;
const DEFAULT_RUNNER_DRAIN_MS = 10_000;
const DEFAULT_ACTIVE_PROBE_INTERVAL_MS = 100;
const UNKNOWN_PROBE_RECHECKS = 2;
const UNKNOWN_PROBE_RECHECK_DELAY_MS = 20;
const MAX_AUDIT_PROBE_ISSUES = 8;

function positiveInt(value: number | undefined, label: string, dflt: number): number {
  const v = value ?? dflt;
  if (!Number.isSafeInteger(v) || v <= 0) {
    throw new Error(`[CONFIG] ${label} must be a positive integer`);
  }
  return v;
}

function nonNegativeInt(value: number | undefined, label: string, dflt: number): number {
  const v = value ?? dflt;
  if (!Number.isSafeInteger(v) || v < 0) {
    throw new Error(`[CONFIG] ${label} must be a non-negative integer`);
  }
  return v;
}

function makeCheck(
  component: CleanupCheck["component"],
  status: CleanupStatus,
  reason: string,
  evidence: CleanupEvidence = {},
  required = true,
  applicability?: CleanupApplicability,
): CleanupCheck {
  return {
    component,
    required,
    status,
    reason,
    evidence,
    ...(applicability ? { applicability } : {}),
  };
}

function resultFromChecks(
  draft: TaskCleanupReportDraft,
  sealed: TaskCleanupReport | null,
  terminationOwned: boolean,
  fenced: boolean,
  startedAt: number,
  failureCode?: string,
  reason?: string,
): TaskCleanupCoordinatorResult {
  return {
    report: sealed,
    sealed: sealed !== null,
    overallOk: sealed?.overallOk === true,
    terminationOwned,
    fenced,
    ...(failureCode ? { failureCode } : {}),
    ...(reason ? { reason } : {}),
    durationMs: Math.max(0, Date.now() - startedAt),
  };
}

export class TaskCleanupCoordinator {
  private opts: TaskCleanupCoordinatorOptions;
  private deadline = 0;
  private draft: TaskCleanupReportDraft;
  private terminationOwned = false;
  private fenced = false;
  private auditFailureCode: string | undefined;
  private readonly timeBudgetMs: number;
  private readonly gracefulMs: number;
  private readonly killMs: number;
  private readonly runnerDrainMs: number;
  private readonly activeProbeIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly aclChecker: (target: AclCleanupTarget, deps?: AclCleanupDeps) => Promise<AclCleanupResult>;
  private readonly probeGroupState: (pgid: number) => Promise<ProcessGroupProbeResult>;
  private probeRechecksUsed = 0;

  constructor(opts: TaskCleanupCoordinatorOptions) {
    if (!opts || typeof opts !== "object") throw new Error("[CONFIG] coordinator options are required");
    if (!opts.reaper) throw new Error("[CONFIG] coordinator reaper is required");
    if (!opts.fence) throw new Error("[CONFIG] coordinator fence is required");
    this.opts = opts;
    this.timeBudgetMs = positiveInt(opts.timeBudgetMs, "timeBudgetMs", DEFAULT_TIME_BUDGET_MS);
    this.gracefulMs = nonNegativeInt(opts.gracefulMs, "gracefulMs", DEFAULT_GRACEFUL_MS);
    this.killMs = nonNegativeInt(opts.killMs, "killMs", DEFAULT_KILL_MS);
    this.runnerDrainMs = nonNegativeInt(opts.runnerDrainMs, "runnerDrainMs", DEFAULT_RUNNER_DRAIN_MS);
    this.activeProbeIntervalMs = positiveInt(
      opts.activeProbeIntervalMs,
      "activeProbeIntervalMs",
      DEFAULT_ACTIVE_PROBE_INTERVAL_MS,
    );
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.aclChecker = opts.aclChecker ?? ((target, deps) => checkAclCleanup(target, deps));
    this.probeGroupState = opts.probeGroupState ?? probeLinuxProcessGroupStateDetailed;
    // 构造时只校验入口参数；实际 draft/run 在 run() 内初始化。
    createPendingTaskCleanupReport({
      runId: opts.runId,
      attempt: opts.attempt,
      trigger: opts.trigger,
      platform: opts.platform,
      ...(opts.cleanupId !== undefined ? { cleanupId: opts.cleanupId } : {}),
    });
    this.draft = null as unknown as TaskCleanupReportDraft;
  }

  async run(): Promise<TaskCleanupCoordinatorResult> {
    const startMs = this.now();
    this.deadline = startMs + this.timeBudgetMs;
    this.draft = createPendingTaskCleanupReport({
      runId: this.opts.runId,
      attempt: this.opts.attempt,
      trigger: this.opts.trigger,
      platform: this.opts.platform,
      ...(this.opts.cleanupId !== undefined ? { cleanupId: this.opts.cleanupId } : {}),
      now: new Date(startMs).toISOString(),
    });
    this.resetChecks();
    this.probeRechecksUsed = 0;

    try {
      await this.renewFence();
      await this.audit({
        action: "cleanup_start",
        phase: "start",
        attempt: this.opts.attempt,
        trigger: this.opts.trigger,
      });

      // 本 coordinator 只为 Linux cleanup 模式实现；其他平台一律不返回成功，
      // 也不调用任何进程组终止或 Docker 清理。
      if (this.opts.platform !== "linux") {
        if (!this.opts.dsh) {
          this.markDshNotSpawned();
        } else {
          this.setDshPending("PLATFORM_VERIFICATION_UNAVAILABLE", this.opts.dsh);
          this.setRunnerPending("PLATFORM_VERIFICATION_UNAVAILABLE", this.opts.dsh);
        }
        this.setDockerPending("PLATFORM_UNSUPPORTED");
        this.setAclPending("PLATFORM_UNSUPPORTED");
        return await this.finish(startMs, "PLATFORM_UNSUPPORTED");
      }

      if (!this.opts.dsh) {
        this.markDshNotSpawned();
        await this.runDockerAndAcl();
      } else {
        await this.runDshPhase(this.opts.dsh);
        if (this.draft.checks.dsh.status === "passed") {
          await this.runDockerAndAcl();
        } else {
          this.setDockerPending("PROCESS_NOT_VERIFIED");
          this.setAclPending("PROCESS_NOT_VERIFIED");
        }
      }
    } catch (e) {
      if (e instanceof CleanupFenceLostError) {
        this.fenced = true;
        await this.audit({ action: "cleanup_fence_lost", phase: "fence", attempt: this.opts.attempt });
        return resultFromChecks(
          this.draft,
          null,
          this.terminationOwned,
          true,
          startMs,
          "CLEANUP_FENCED",
          "CLEANUP_FENCED",
        );
      }
      if (e instanceof CleanupBudgetExceededError) {
        this.fillPending("CLEANUP_TIME_BUDGET_EXCEEDED");
        return await this.finish(startMs, "CLEANUP_TIME_BUDGET_EXCEEDED");
      }
      this.fillPending("CLEANUP_INTERNAL");
      return await this.finish(startMs, "CLEANUP_INTERNAL");
    }

    return await this.finish(startMs);
  }

  private async finish(
    startMs: number,
    failureCode?: string,
  ): Promise<TaskCleanupCoordinatorResult> {
    await this.audit({
      action: "cleanup_summary",
      phase: "summary",
      attempt: this.opts.attempt,
      dsh: this.draft.checks.dsh.status,
      runner: this.draft.checks.runner.status,
      docker: this.draft.checks.docker.status,
      acl: this.draft.checks.acl.status,
      audit: this.draft.checks.audit.status,
      dsh_reason: this.draft.checks.dsh.reason,
      runner_reason: this.draft.checks.runner.reason,
      docker_reason: this.draft.checks.docker.reason,
      acl_reason: this.draft.checks.acl.reason,
      audit_reason: this.draft.checks.audit.reason,
    });
    this.setAuditCheck();

    try {
      await this.renewFence();
    } catch (e) {
      if (e instanceof CleanupFenceLostError) {
        this.fenced = true;
        await this.audit({ action: "cleanup_fence_lost", phase: "fence", attempt: this.opts.attempt });
        return resultFromChecks(
          this.draft,
          null,
          this.terminationOwned,
          true,
          startMs,
          "CLEANUP_FENCED",
          "CLEANUP_FENCED",
        );
      }
      throw e;
    }

    try {
      const sealed = sealTaskCleanupReport(this.draft);
      return resultFromChecks(
        this.draft,
        sealed,
        this.terminationOwned,
        false,
        startMs,
        failureCode,
        failureCode,
      );
    } catch (e) {
      await this.audit({
        action: "report_seal_failed",
        phase: "seal",
        attempt: this.opts.attempt,
        reason: "CLEANUP_REPORT_SEAL_FAILED",
      });
      return resultFromChecks(
        this.draft,
        null,
        this.terminationOwned,
        false,
        startMs,
        "CLEANUP_REPORT_SEAL_FAILED",
        (e as { code?: string }).code ?? "CLEANUP_REPORT_SEAL_FAILED",
      );
    }
  }

  private resetChecks(): void {
    const c = this.draft.checks;
    c.dsh = makeCheck("dsh", "pending", "CLEANUP_NOT_ATTEMPTED", {}, true);
    c.runner = makeCheck("runner", "pending", "CLEANUP_NOT_ATTEMPTED", {}, true);
    c.docker = makeCheck("docker", "pending", "CLEANUP_NOT_ATTEMPTED", {}, true);
    c.acl = makeCheck("acl", "pending", "CLEANUP_NOT_ATTEMPTED", {}, this.opts.platform !== "win32");
    c.audit = makeCheck("audit", "pending", "CLEANUP_NOT_ATTEMPTED", {}, true);
  }

  private fillPending(reason: string): void {
    for (const key of ["dsh", "runner", "docker", "acl", "audit"] as const) {
      const check = this.draft.checks[key];
      if (check.status === "pending" && check.reason === "CLEANUP_NOT_ATTEMPTED") {
        this.draft.checks[key] = makeCheck(
          key,
          "pending",
          reason,
          check.evidence,
          check.required,
          check.applicability,
        );
      }
    }
  }

  private markDshNotSpawned(): void {
    this.draft.checks.dsh = makeCheck(
      "dsh",
      "not_applicable",
      "DSH_NOT_SPAWNED",
      { platform: this.opts.platform },
      false,
      { basis: "lifecycle", detail: "dsh_not_spawned" },
    );
    this.draft.checks.runner = makeCheck(
      "runner",
      "not_applicable",
      "RUNNER_NOT_SPAWNED",
      { platform: this.opts.platform },
      false,
      { basis: "lifecycle", detail: "dsh_not_spawned" },
    );
  }

  private async runDshPhase(dsh: DshCleanupHandle): Promise<void> {
    try {
      dsh.markTerminationOwned();
    } catch {
      this.terminationOwned = false;
      this.setDshPending("TERMINATION_OWNERSHIP_UNPROVEN", dsh);
      this.setRunnerPending("TERMINATION_OWNERSHIP_UNPROVEN", dsh);
      await this.audit({
        action: "dsh_ownership",
        phase: "dsh",
        attempt: this.opts.attempt,
        ok: false,
        reason: "TERMINATION_OWNERSHIP_UNPROVEN",
      });
      return;
    }
    this.terminationOwned = true;
    await this.audit({ action: "dsh_ownership", phase: "dsh", attempt: this.opts.attempt, ok: true });

    if (dsh.promptActive) {
      this.setDshPending("PROMPT_ACTIVE", dsh);
      this.setRunnerPending("PROMPT_ACTIVE", dsh);
      return;
    }
    if (!dsh.identity || !dsh.child) {
      this.setDshPending("PROCESS_IDENTITY_UNVERIFIABLE", dsh);
      this.setRunnerPending("PROCESS_IDENTITY_UNVERIFIABLE", dsh);
      return;
    }
    if (dsh.identity.platform !== "linux" || this.opts.platform !== "linux") {
      this.setDshPending("PLATFORM_VERIFICATION_UNAVAILABLE", dsh);
      this.setRunnerPending("PLATFORM_VERIFICATION_UNAVAILABLE", dsh);
      return;
    }

    await this.assertBudget();
    await this.renewFence();
    const graceMs = Math.min(this.gracefulMs, this.remainingMs());
    let shutdownOk = false;
    try {
      shutdownOk = await dsh.requestShutdown(graceMs);
    } catch {
      shutdownOk = false;
    }
    await this.audit({
      action: "dsh_shutdown",
      phase: "dsh",
      attempt: this.opts.attempt,
      ok: shutdownOk,
    });

    const group = await this.waitGroupGone(dsh.identity, graceMs);
    if (group === "unknown") {
      this.setDshPending("PROCESS_GROUP_STATE_UNKNOWN", dsh);
      this.setRunnerPending("PROCESS_GROUP_STATE_UNKNOWN", dsh);
      return;
    }
    await this.assertBudget();

    const safe = await this.ensureNoActiveRunners();
    if (!safe.ok) {
      const reason = safe.reason ?? "CLEANUP_RUNNER_ACTIVE";
      this.setDshPending(reason, dsh);
      this.setRunnerPending(reason, dsh);
      await this.audit({ action: "runner_probe", phase: "runner", attempt: this.opts.attempt, ok: false, reason });
      return;
    }

    await this.assertBudget();
    await this.renewFence();
    const finalProbe = await this.probeGroupStateWithRechecks(dsh.identity.pgid, "dsh_final");
    const finalGroup = finalProbe.state;
    if (finalGroup === "unknown") {
      this.setDshPending("PROCESS_GROUP_STATE_UNKNOWN", dsh);
      this.setRunnerPending("PROCESS_GROUP_STATE_UNKNOWN", dsh);
      return;
    }

    let lockLease: RunnerLockLease | null = null;
    if (finalGroup === "exists") {
      await this.assertBudget();
      await this.renewFence();
      const lock = await this.acquireRunnerLock(dsh);
      if (!lock.ok) {
        this.setDshPending(lock.reason, dsh);
        this.setRunnerPending(lock.reason, dsh);
        await this.audit({
          action: "runner_lock",
          phase: "runner",
          attempt: this.opts.attempt,
          ok: false,
          reason: lock.reason,
        });
        return;
      }
      lockLease = lock.lease;
      await this.audit({
        action: "runner_lock",
        phase: "runner",
        attempt: this.opts.attempt,
        ok: true,
        reason: "RUNNER_LOCK_ACQUIRED",
      });
    }

    try {
      await this.assertBudget();
      await this.renewFence();
      // 最终发信号前的最后一道 veto：active Runner 出现/探针失败都不得杀进程组。
      const finalSafe = await this.ensureNoActiveRunners();
      if (!finalSafe.ok) {
        const reason = finalSafe.reason ?? "CLEANUP_RUNNER_ACTIVE";
        this.setDshPending(reason, dsh);
        this.setRunnerPending(reason, dsh);
        return;
      }

      await this.assertBudget();
      await this.renewFence();
      let term: ProcessTerminationResult;
      try {
        term = await terminateAndVerify({
          identity: dsh.identity,
          child: dsh.child as unknown as TerminateChild,
          gracefulMs: 0,
          killMs: Math.min(this.killMs, this.remainingMs()),
        });
      } catch (e) {
        this.setDshFailed("PROCESS_TERMINATION_ERROR", dsh, {
          ...(dsh.identity ? { pid: dsh.identity.pid, pgid: dsh.identity.pgid } : {}),
        });
        this.setRunnerFailed("PROCESS_TERMINATION_ERROR", dsh);
        await this.audit({
          action: "dsh_terminate",
          phase: "dsh",
          attempt: this.opts.attempt,
          ok: false,
          reason: "PROCESS_TERMINATION_ERROR",
        });
        return;
      }
      await this.audit({
        action: "dsh_terminate",
        phase: "dsh",
        attempt: this.opts.attempt,
        ok: term.status === "passed",
        reason: term.reason,
      });

      const evidence: CleanupEvidence = {
        pid: term.pid,
        pgid: term.pgid,
        directChildExited: term.directChildExited,
        processGroupAbsent: term.processGroupAbsent,
        gracefulTimedOut: term.gracefulTimedOut,
        forced: term.forced,
        ...(term.startTicks ? { startTicks: term.startTicks } : {}),
      };
      if (term.status === "passed") {
        this.draft.checks.dsh = makeCheck("dsh", "passed", "DSH_TERMINATED_VERIFIED", evidence);
        this.draft.checks.runner = makeCheck(
          "runner",
          "passed",
          "RUNNER_COVERED_BY_DSH_PGID",
          {
            pgid: term.pgid,
            processGroupAbsent: true,
            coveredBy: "dsh_process_group",
          },
        );
      } else if (term.status === "pending") {
        this.draft.checks.dsh = makeCheck("dsh", "pending", term.reason, evidence);
        this.draft.checks.runner = makeCheck(
          "runner",
          "pending",
          "RUNNER_NOT_VERIFIED",
          { pgid: term.pgid, processGroupAbsent: term.processGroupAbsent },
        );
      } else {
        this.draft.checks.dsh = makeCheck("dsh", "failed", term.reason, evidence);
        this.draft.checks.runner = makeCheck(
          "runner",
          "failed",
          "RUNNER_NOT_VERIFIED",
          { pgid: term.pgid, processGroupAbsent: term.processGroupAbsent },
        );
      }
    } finally {
      if (lockLease) await lockLease.release();
    }
  }

  private async waitGroupGone(
    identity: ProcessIdentity,
    graceMs: number,
  ): Promise<"absent" | "exists" | "unknown"> {
    const end = Math.min(this.now() + Math.max(0, graceMs), this.deadline);
    const maxIterations = Math.max(1, Math.ceil(Math.max(1, graceMs) / 10) + 5);
    let probe = await this.probeGroupStateWithRechecks(identity.pgid, "dsh_wait");
    let state = probe.state;
    let iterations = 0;
    while (state === "exists" && this.now() < end && iterations < maxIterations) {
      iterations += 1;
      await this.sleep(Math.min(50, Math.max(1, end - this.now())));
      probe = await this.probeGroupStateWithRechecks(identity.pgid, "dsh_wait");
      state = probe.state;
    }
    return state;
  }

  /**
   * unknown 只做有限复核：每次仍然是完整 /proc 安全扫描；预算/lease fence 照常检查。
   * 复核总次数按单次 cleanup 封顶 2 次；最终仍 unknown 时保持 pending，绝不改为 absent。
   */
  private async probeGroupStateWithRechecks(
    pgid: number,
    phase: "dsh_wait" | "dsh_final",
  ): Promise<ProcessGroupProbeResult> {
    let result = await this.probeGroupState(pgid);
    while (
      result.state === "unknown" &&
      this.probeRechecksUsed < UNKNOWN_PROBE_RECHECKS
    ) {
      await this.assertBudget();
      await this.renewFence();
      const remaining = this.remainingMs();
      if (remaining <= 0) {
        await this.assertBudget();
        break;
      }
      await this.sleep(Math.min(UNKNOWN_PROBE_RECHECK_DELAY_MS, remaining));
      await this.assertBudget();
      await this.renewFence();
      this.probeRechecksUsed += 1;
      result = await this.probeGroupState(pgid);
    }
    if (result.state === "unknown") {
      // CleanupAuditLog only accepts flat code-only values: flatten issue data.
      const issues = result.issues.slice(0, MAX_AUDIT_PROBE_ISSUES);
      const auditEvent: Record<string, unknown> = {
        action: "cleanup_probe_unknown",
        phase,
        code: "PROCESS_GROUP_STATE_UNKNOWN",
        pgid,
        issue_count: issues.length,
        issue_total: result.issues.length,
        truncated: result.issues.length > issues.length,
      };
      issues.forEach((issue, index) => {
        auditEvent[`issue_${index}_pid`] = issue.pid;
        auditEvent[`issue_${index}_code`] = issue.code;
        if (issue.errno) auditEvent[`issue_${index}_errno`] = issue.errno;
      });
      await this.audit(auditEvent);
    }
    return result;
  }

  private async ensureNoActiveRunners(): Promise<ActiveSafety> {
    let probe: SandboxActiveProbeResult;
    try {
      probe = await this.opts.reaper.probeActive({
        runId: this.opts.runId,
        attempt: this.opts.attempt,
      }, { deadlineAt: this.deadline });
    } catch {
      return { ok: false, reason: "DOCKER_PROBE_UNVERIFIED" };
    }
    if (!probe.ok) {
      return {
        ok: false,
        reason: probe.reason === "CLEANUP_TIME_BUDGET_EXCEEDED"
          ? "CLEANUP_TIME_BUDGET_EXCEEDED"
          : "DOCKER_PROBE_UNVERIFIED",
      };
    }
    if (probe.active === 0) return { ok: true };

    const end = Math.min(this.now() + this.runnerDrainMs, this.deadline);
    const maxIterations = Math.max(
      1,
      Math.ceil(this.runnerDrainMs / Math.max(1, this.activeProbeIntervalMs)) + 1,
    );
    let iterations = 0;
    while (this.now() < end && iterations < maxIterations) {
      iterations += 1;
      await this.assertBudget();
      await this.renewFence();
      await this.sleep(Math.min(this.activeProbeIntervalMs, Math.max(1, end - this.now())));
      try {
        probe = await this.opts.reaper.probeActive({
          runId: this.opts.runId,
          attempt: this.opts.attempt,
        }, { deadlineAt: this.deadline });
      } catch {
        return { ok: false, reason: "DOCKER_PROBE_UNVERIFIED" };
      }
      if (!probe.ok) {
        return {
          ok: false,
          reason: probe.reason === "CLEANUP_TIME_BUDGET_EXCEEDED"
            ? "CLEANUP_TIME_BUDGET_EXCEEDED"
            : "DOCKER_PROBE_UNVERIFIED",
        };
      }
      if (probe.active === 0) return { ok: true };
    }
    return { ok: false, reason: "CLEANUP_RUNNER_ACTIVE" };
  }

  /**
   * Host Runner 生命周期闸门：Runner 在整个 run_in_sandbox.sh 生命周期（含 Docker 退出后
   * 的 ACL rollback）持有 <aclStateDir>/<sha256(workdir)[0:16]>.lock 的 flock。
   * 在向 DSH 进程组发信号前，Coordinator 必须取得同一把锁：
   *   - 锁被占用 → 认为 Runner 仍活跃，pending，不发信号；
   *   - 取得锁 → Runner 不可能同时执行 ACL rollback，且新的 Runner 无法在本 gate 期间启动。
   * 锁 holder 进程独立于 DSH 进程组，并带 holdSeconds 上界，避免 Gateway 崩溃后永久占锁。
   */
  private async acquireRunnerLock(dsh: DshCleanupHandle): Promise<RunnerLockResult> {
    if (dsh.aclStateDir === null) {
      return { ok: false, reason: "ACL_STATE_DIR_UNPROVEN" };
    }
    if (dsh.aclStateDir !== this.opts.paths.aclStateDir) {
      return { ok: false, reason: "ACL_STATE_DIR_MISMATCH" };
    }
    let workdirReal: string;
    try {
      workdirReal = await realpath(this.opts.paths.workdir);
    } catch {
      return { ok: false, reason: "RUNNER_LOCK_UNVERIFIABLE" };
    }
    try {
      await validateTrustedDirectory(this.opts.paths.aclStateDir, {
        platform: "linux",
        label: "aclStateDir",
      });
    } catch (e) {
      const code = (e as { code?: string }).code;
      return {
        ok: false,
        reason: code === "TRUSTED_DIR_MISSING"
          ? "ACL_STATE_DIR_MISSING"
          : "ACL_STATE_DIR_UNSAFE",
      };
    }
    const key = createHash("sha256").update(workdirReal).digest("hex").slice(0, 16);
    return await this.spawnRunnerLock(join(this.opts.paths.aclStateDir, `${key}.lock`));
  }

  private async spawnRunnerLock(lockPath: string): Promise<RunnerLockResult> {
    const holdSeconds = Math.max(1, Math.ceil(this.timeBudgetMs / 1000) + 5);
    let child: ChildProcess;
    try {
      child = spawn(
        "flock",
        ["-n", lockPath, "sh", "-c", `printf CLEANUP_LOCK_ACQUIRED\\n; sleep ${holdSeconds}`],
        {
          detached: true,
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        },
      );
    } catch {
      return { ok: false, reason: "RUNNER_LOCK_UNVERIFIABLE" };
    }

    const outcome = await new Promise<"acquired" | "busy" | "error">((resolve) => {
      let settled = false;
      const finish = (value: "acquired" | "busy" | "error") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish("error"), 1_000);
      child.stdout?.on("data", (d) => {
        if (String(d).includes("CLEANUP_LOCK_ACQUIRED")) finish("acquired");
      });
      child.once("error", () => finish("error"));
      child.once("exit", (code) => finish(code === 1 ? "busy" : "error"));
    });

    if (outcome !== "acquired") {
      this.killRunnerLockHolder(child);
      return {
        ok: false,
        reason: outcome === "busy" ? "RUNNER_LOCK_BUSY" : "RUNNER_LOCK_UNVERIFIABLE",
      };
    }

    return {
      ok: true,
      lease: {
        release: async () => {
          this.killRunnerLockHolder(child);
          if (child.exitCode !== null || child.signalCode !== null) return;
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 2_000);
            child.once("exit", () => {
              clearTimeout(timer);
              resolve();
            });
          });
        },
      },
    };
  }

  private killRunnerLockHolder(child: ChildProcess): void {
    try {
      if (typeof child.pid === "number" && child.pid > 1) {
        process.kill(-child.pid, "SIGKILL");
      } else {
        child.kill("SIGKILL");
      }
    } catch {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
  }

  private async runDockerAndAcl(): Promise<void> {
    await this.assertBudget();
    await this.renewFence();
    const safe = await this.ensureNoActiveRunners();
    if (!safe.ok) {
      const reason = safe.reason ?? "CLEANUP_RUNNER_ACTIVE";
      this.setDockerPending(reason);
      this.setAclPending(reason);
      if (this.draft.checks.dsh.status === "passed") {
        this.setRunnerPending(reason, this.opts.dsh ?? undefined);
      }
      await this.audit({ action: "runner_probe", phase: "runner", attempt: this.opts.attempt, ok: false, reason });
      return;
    }

    await this.assertBudget();
    await this.renewFence();
    let cleanup: SandboxCleanupResult;
    try {
      cleanup = await this.opts.reaper.cleanup({
        runId: this.opts.runId,
        attempt: this.opts.attempt,
      }, { deadlineAt: this.deadline });
    } catch {
      this.setDockerFailed("DOCKER_EXCEPTION", { dockerFound: 0, dockerCleaned: 0 });
      this.setAclPending("DOCKER_NOT_CLEANED");
      await this.audit({
        action: "docker_cleanup",
        phase: "docker",
        attempt: this.opts.attempt,
        ok: false,
        reason: "DOCKER_EXCEPTION",
      });
      return;
    }
    const evidence: CleanupEvidence = {
      dockerFound: cleanup.found,
      dockerCleaned: cleanup.cleaned.length,
      dockerForced: cleanup.forced.length,
      dockerMismatches: cleanup.mismatches.length,
    };
    if (cleanup.ok) {
      this.draft.checks.docker = makeCheck("docker", "passed", "DOCKER_CLEAN", evidence);
    } else if (cleanup.busy) {
      this.draft.checks.docker = makeCheck("docker", "pending", "CLEANUP_BUSY", evidence);
    } else if (cleanup.mismatches.length > 0) {
      this.draft.checks.docker = makeCheck("docker", "failed", "OWNERSHIP_MISMATCH", evidence);
    } else {
      const reason = cleanup.reason ?? "CLEANUP_FAILED";
      this.draft.checks.docker = makeCheck("docker", "failed", reason, evidence);
    }
    await this.audit({
      action: "docker_cleanup",
      phase: "docker",
      attempt: this.opts.attempt,
      ok: cleanup.ok,
      found: cleanup.found,
      cleaned: cleanup.cleaned.length,
      forced: cleanup.forced.length,
      mismatches: cleanup.mismatches.length,
      reason: cleanup.reason ?? (cleanup.ok ? "DOCKER_CLEAN" : "CLEANUP_FAILED"),
    });
    if (this.draft.checks.docker.status !== "passed") {
      this.setAclPending("DOCKER_NOT_CLEANED");
      return;
    }
    await this.runAclPhase();
  }

  private async runAclPhase(): Promise<void> {
    await this.assertBudget();
    await this.renewFence();

    if (this.opts.platform === "win32") {
      this.draft.checks.acl = makeCheck(
        "acl",
        "not_applicable",
        "ACL_NOT_APPLICABLE_PLATFORM",
        { platform: "win32" },
        false,
        { basis: "platform", detail: "win32" },
      );
      return;
    }
    if (this.opts.platform !== "linux") {
      this.draft.checks.acl = makeCheck("acl", "pending", "ACL_PLATFORM_UNVERIFIABLE", {
        platform: "other",
      });
      return;
    }

    const dsh = this.opts.dsh;
    if (dsh) {
      if (dsh.aclStateDir === null) {
        this.draft.checks.acl = makeCheck("acl", "pending", "ACL_STATE_DIR_UNPROVEN", {
          platform: "linux",
        });
        return;
      }
      if (dsh.aclStateDir !== this.opts.paths.aclStateDir) {
        this.draft.checks.acl = makeCheck("acl", "failed", "ACL_STATE_DIR_MISMATCH", {
          platform: "linux",
        });
        return;
      }
    }

    try {
      await validateTrustedDirectory(this.opts.paths.aclStateDir, {
        platform: "linux",
        label: "aclStateDir",
      });
    } catch (e) {
      const code = (e as { code?: string }).code;
      const reason = code === "TRUSTED_DIR_MISSING"
        ? "ACL_STATE_DIR_MISSING"
        : "ACL_STATE_DIR_UNSAFE";
      this.draft.checks.acl = makeCheck("acl", "failed", reason, { platform: "linux" });
      await this.audit({
        action: "acl_check",
        phase: "acl",
        attempt: this.opts.attempt,
        ok: false,
        reason,
      });
      return;
    }

    const remaining = this.remainingMs();
    const configuredGetfaclTimeout = this.opts.aclDeps?.getfaclTimeoutMs ?? remaining;
    const aclDeps: AclCleanupDeps = {
      ...(this.opts.aclDeps ?? {}),
      platform: "linux",
      ...(remaining > 0
        ? {
            // checkAclCleanup 依次扫描 workdir/results/assets 三次；每路平分剩余预算，
            // 使三次 getfacl 的总上界不超过本阶段剩余预算。
            getfaclTimeoutMs: Math.max(
              1,
              Math.min(configuredGetfaclTimeout, Math.floor(remaining / 3)),
            ),
          }
        : {}),
    };
    let acl: AclCleanupResult;
    try {
      acl = await this.aclChecker(
        {
          workdir: this.opts.paths.workdir,
          resultsDir: this.opts.paths.resultsDir,
          assetsDir: this.opts.paths.assetsDir,
          aclStateDir: this.opts.paths.aclStateDir,
        },
        aclDeps,
      );
    } catch {
      this.draft.checks.acl = makeCheck("acl", "failed", "ACL_CHECK_EXCEPTION", {
        platform: "linux",
      });
      await this.audit({
        action: "acl_check",
        phase: "acl",
        attempt: this.opts.attempt,
        ok: false,
        reason: "ACL_CHECK_EXCEPTION",
      });
      return;
    }
    this.draft.checks.acl = makeCheck(
      "acl",
      acl.status,
      acl.reason,
      acl.evidence,
      acl.required,
      acl.applicability,
    );
    await this.audit({
      action: "acl_check",
      phase: "acl",
      attempt: this.opts.attempt,
      ok: acl.status === "passed",
      reason: acl.reason,
      residual: acl.evidence.aclResidualEntries ?? 0,
      state_files: acl.evidence.aclStateFiles ?? 0,
    });
  }

  private setDshPending(reason: string, dsh: DshCleanupHandle): void {
    this.draft.checks.dsh = makeCheck("dsh", "pending", reason, this.dshEvidence(dsh));
  }

  private setDshFailed(reason: string, dsh: DshCleanupHandle, evidence?: CleanupEvidence): void {
    this.draft.checks.dsh = makeCheck("dsh", "failed", reason, evidence ?? this.dshEvidence(dsh));
  }

  private setRunnerPending(reason: string, dsh?: DshCleanupHandle): void {
    this.draft.checks.runner = makeCheck(
      "runner",
      "pending",
      reason,
      dsh?.identity ? { pgid: dsh.identity.pgid } : {},
    );
  }

  private setRunnerFailed(reason: string, dsh?: DshCleanupHandle): void {
    this.draft.checks.runner = makeCheck(
      "runner",
      "failed",
      reason,
      dsh?.identity ? { pgid: dsh.identity.pgid } : {},
    );
  }

  private dshEvidence(dsh: DshCleanupHandle): CleanupEvidence {
    const identity = dsh.identity;
    if (!identity) return {};
    return {
      pid: identity.pid,
      pgid: identity.pgid,
      ...(identity.startTicks ? { startTicks: identity.startTicks } : {}),
    };
  }

  private setDockerPending(reason: string): void {
    this.draft.checks.docker = makeCheck("docker", "pending", reason, {});
  }

  private setDockerFailed(reason: string, evidence: CleanupEvidence): void {
    this.draft.checks.docker = makeCheck("docker", "failed", reason, evidence);
  }

  private setAclPending(reason: string): void {
    if (this.opts.platform === "win32") {
      this.draft.checks.acl = makeCheck(
        "acl",
        "not_applicable",
        "ACL_NOT_APPLICABLE_PLATFORM",
        { platform: "win32" },
        false,
        { basis: "platform", detail: "win32" },
      );
      return;
    }
    this.draft.checks.acl = makeCheck("acl", "pending", reason, {
      platform: this.opts.platform,
    }, true);
  }

  private setAuditCheck(): void {
    const audit = this.opts.audit;
    const events = audit?.eventCount ?? 0;
    const failures = audit ? audit.failureCount : 1;
    const evidence: CleanupEvidence = { auditEvents: events, auditFailures: failures };
    if (!audit) {
      this.draft.checks.audit = makeCheck("audit", "failed", "AUDIT_UNAVAILABLE", evidence);
      return;
    }
    if (this.auditFailureCode || !audit.auditOk) {
      this.draft.checks.audit = makeCheck(
        "audit",
        "failed",
        this.auditFailureCode ?? "AUDIT_WRITE_FAILED",
        evidence,
      );
      return;
    }
    this.draft.checks.audit = makeCheck("audit", "passed", "AUDIT_WRITTEN", evidence);
  }

  private async audit(event: Record<string, unknown>): Promise<boolean> {
    const audit = this.opts.audit;
    if (!audit) {
      this.auditFailureCode ??= "AUDIT_UNAVAILABLE";
      return false;
    }
    try {
      const result = await audit.append(event);
      if (!result.ok) {
        this.auditFailureCode ??= result.code ?? "AUDIT_WRITE_FAILED";
        return false;
      }
      return true;
    } catch {
      this.auditFailureCode ??= "AUDIT_WRITE_FAILED";
      return false;
    }
  }

  private async renewFence(): Promise<void> {
    try {
      if (this.opts.fence.heartbeat) {
        const renewed = await this.opts.fence.heartbeat();
        if (!renewed) throw new CleanupFenceLostError();
      }
      const held = await this.opts.fence.check();
      if (!held) throw new CleanupFenceLostError();
    } catch (e) {
      if (e instanceof CleanupFenceLostError) throw e;
      throw new CleanupFenceLostError();
    }
  }

  private async assertBudget(): Promise<void> {
    if (this.now() >= this.deadline) throw new CleanupBudgetExceededError();
  }

  private remainingMs(): number {
    return Math.max(0, this.deadline - this.now());
  }
}
