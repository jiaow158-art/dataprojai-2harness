// S4-B2-C2-B1：终止进程并验证实际退出。
//
// 关键约束：
//   - 直接子进程 exit 事件并不证明进程组为空；必须独立检查 PGID；
//   - Linux 组存活 = /proc 中存在非 Z/X 组员；kill(-pgid,0) 会把僵尸组误报为存活；
//   - 正常路径优先 graceful（默认 SIGTERM 到进程组），有界等待；
//   - 超时后才 SIGKILL，再在 killMs 内验证进程组为空；
//   - leader 已消失但组仍有活组员时，PGID 身份不可证明——pending 且不发信号；
//   - 无法验证（win32/other/身份缺失/探针 unknown）只能 pending，绝不 passed；
//   - 绝不向网关自身进程组发信号。
//
// 本模块不修改 DshSdkClient；C2-B2 由其注入 graceful 回调（SDK shutdown）和 child；
// 组身份强证明（leader 已死但子孙存活）需 C2-B2 的 cgroup/进程注册表补充。

import { readFile, readdir } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";

export type TerminationPlatform = "linux" | "win32" | "other";
export type ProcessTerminationStatus = "passed" | "failed" | "pending";
export type ProcessGroupState = "exists" | "absent" | "unknown";

export interface ProcessIdentity {
  pid: number;
  pgid: number;
  startTicks: string | null;
  platform: TerminationPlatform;
}

export interface LinuxProcStat {
  pid: number;
  state: string;
  pgid: number;
  startTicks: string;
}

export interface ProcessProbe {
  readStat(pid: number): Promise<LinuxProcStat | null>;
  groupState(pgid: number): Promise<ProcessGroupState>;
  signalGroup(pgid: number, signal: NodeJS.Signals): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface TerminateChild {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  once(event: "exit", listener: () => void): unknown;
  off?(event: "exit", listener: () => void): unknown;
}

export interface TerminateAndVerifyOptions {
  identity: ProcessIdentity;
  child?: TerminateChild;
  /** 优先调用该优雅关闭动作；缺省 = SIGTERM 到进程组。 */
  graceful?: () => void | Promise<void>;
  /** 优雅关闭有界等待，默认 3000ms。 */
  gracefulMs?: number;
  /** SIGKILL 后退出验证有界等待，默认 5000ms。 */
  killMs?: number;
  /** 测试注入；未提供的成员使用默认实现。 */
  probe?: Partial<ProcessProbe>;
  /** 测试可显式覆盖；缺省使用 identity.platform。 */
  platform?: TerminationPlatform;
}

export interface ProcessTerminationResult {
  status: ProcessTerminationStatus;
  reason: string;
  pid: number;
  pgid: number;
  startTicks: string | null;
  directChildExited: boolean;
  processGroupAbsent: boolean;
  gracefulTimedOut: boolean;
  forced: boolean;
}

export class ProcessTerminationError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "ProcessTerminationError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ProcessTerminationError(code, message);
}

export function currentTerminationPlatform(): TerminationPlatform {
  if (process.platform === "linux") return "linux";
  if (process.platform === "win32") return "win32";
  return "other";
}

/**
 * 解析 /proc/<pid>/stat。comm 可含空格和括号，故以最后一个 ")" 为边界。
 * 返回字段 3(state)/5(pgrp)/22(starttime)。
 */
export function parseLinuxProcStat(expectedPid: number, raw: string): LinuxProcStat {
  if (!Number.isSafeInteger(expectedPid) || expectedPid <= 0) {
    fail("INVALID_PID", "pid must be a positive integer");
  }
  const close = raw.lastIndexOf(")");
  if (close < 0) fail("PROC_STAT_INVALID", "missing comm terminator");
  const tail = raw.slice(close + 1).trim().split(/\s+/);
  if (tail.length < 20) fail("PROC_STAT_INVALID", "too few /proc stat fields");
  const pid = Number(raw.slice(0, raw.indexOf(" ")));
  const state = tail[0];
  const pgid = Number(tail[2]);
  const startTicks = tail[19];
  // pgid=0 是内核线程（如 kthreadd）；解析器不能因此把整个 /proc 扫描判成不可读。
  if (
    pid !== expectedPid ||
    !state ||
    !Number.isSafeInteger(pgid) ||
    pgid < 0 ||
    !/^[0-9]+$/.test(startTicks)
  ) {
    fail("PROC_STAT_INVALID", "invalid pid/state/pgid/starttime");
  }
  return { pid, state, pgid, startTicks };
}

async function readLinuxProcStat(pid: number): Promise<LinuxProcStat | null> {
  try {
    const raw = await readFile(`/proc/${pid}/stat`, "utf8");
    return parseLinuxProcStat(pid, raw);
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return null;
    if (e instanceof ProcessTerminationError) throw e;
    fail("PROC_STAT_READ_FAILED", "cannot read /proc stat");
  }
}

/** Z/X 仍可能被 kill(-pgid, 0) 看到，但已不可执行，不能算存活组员。 */
export function isLiveLinuxState(state: string): boolean {
  return state !== "Z" && state !== "X" && state !== "x";
}

/**
 * Linux 进程组存活判定：遍历 /proc，只有存在非 Z/X 组员才算 exists。
 * /proc 任一相关读取失败时返回 unknown（绝不把不可见误判成 absent）。
 * 这是对 kill(-pgid, 0) 的替代——后者会把仅剩僵尸的组误报为存活。
 */
export async function probeLinuxProcessGroupState(pgid: number): Promise<ProcessGroupState> {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return "unknown";
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return "unknown";
  }
  let unreadable = false;
  for (const name of entries) {
    if (!/^[0-9]+$/.test(name)) continue;
    let st: LinuxProcStat | null;
    try {
      st = await readLinuxProcStat(Number(name));
    } catch {
      unreadable = true;
      continue;
    }
    if (!st) continue;
    if (st.pgid === pgid && isLiveLinuxState(st.state)) return "exists";
  }
  return unreadable ? "unknown" : "absent";
}

export async function captureProcessIdentity(
  pid: number,
  opts: { platform?: TerminationPlatform } = {},
): Promise<ProcessIdentity> {
  if (!Number.isSafeInteger(pid) || pid <= 0) fail("INVALID_PID", "pid must be a positive integer");
  const platform = opts.platform ?? currentTerminationPlatform();
  if (platform !== "linux") {
    // 非 Linux 不宣称知道 PGID；C2-B1 不提供 Windows 实机验证。
    return { pid, pgid: pid, startTicks: null, platform };
  }
  const st = await readLinuxProcStat(pid);
  if (!st) fail("PROCESS_NOT_FOUND", "process does not exist");
  if (st.pgid <= 1) fail("PROCESS_IDENTITY_UNVERIFIABLE", "process has no usable process group");
  return { pid, pgid: st.pgid, startTicks: st.startTicks, platform };
}

function hasChildExited(child: TerminateChild | undefined): boolean {
  if (!child) return false;
  return child.exitCode !== null || child.signalCode !== null;
}

function defaultProbe(platform: TerminationPlatform): ProcessProbe {
  return {
    readStat: async (pid: number) => {
      if (platform !== "linux") return null;
      return readLinuxProcStat(pid);
    },
    groupState: async (pgid: number) => {
      if (platform !== "linux") return "unknown";
      return probeLinuxProcessGroupState(pgid);
    },
    signalGroup: async (pgid: number, signal: NodeJS.Signals) => {
      if (platform !== "linux") fail("PLATFORM_VERIFICATION_UNAVAILABLE", "group signaling is not supported");
      try {
        process.kill(-pgid, signal);
      } catch (e) {
        if ((e as { code?: string }).code === "ESRCH") return;
        fail("PROCESS_SIGNAL_FAILED", "group signal failed");
      }
    },
    sleep: (ms: number) => new Promise((res) => setTimeout(res, ms)),
    now: () => Date.now(),
  };
}

function makeResult(
  identity: ProcessIdentity,
  status: ProcessTerminationStatus,
  reason: string,
  extra: Partial<Pick<ProcessTerminationResult, "directChildExited" | "processGroupAbsent" | "gracefulTimedOut" | "forced">> = {},
): ProcessTerminationResult {
  return {
    status,
    reason,
    pid: identity.pid,
    pgid: identity.pgid,
    startTicks: identity.startTicks,
    directChildExited: extra.directChildExited ?? false,
    processGroupAbsent: extra.processGroupAbsent ?? false,
    gracefulTimedOut: extra.gracefulTimedOut ?? false,
    forced: extra.forced ?? false,
  };
}

type WaitState = ProcessGroupState | "timeout";

async function waitGroupGone(probe: ProcessProbe, pgid: number, durationMs: number): Promise<WaitState> {
  const deadline = probe.now() + Math.max(0, durationMs);
  for (;;) {
    let state: ProcessGroupState;
    try {
      state = await probe.groupState(pgid);
    } catch {
      return "unknown";
    }
    if (state !== "exists") return state;
    if (probe.now() >= deadline) return "timeout";
    await probe.sleep(Math.min(25, Math.max(1, deadline - probe.now())));
  }
}

function validMs(value: number | undefined, label: string, dflt: number): number {
  const v = value ?? dflt;
  if (!Number.isSafeInteger(v) || v < 0) fail("INVALID_TIMEOUT", `${label} must be a non-negative integer`);
  return v;
}

/**
 * 终止身份所属进程组并验证实际退出。
 * - Linux：直接子进程 exit 只作为辅助证据，最终以 PGID 探针为准；
 * - 优雅阶段超时才强制 SIGKILL；强制后仍须再次验证；
 * - Windows/other 或探针无法判定：pending，绝不当作成功。
 */
export async function terminateAndVerify(opts: TerminateAndVerifyOptions): Promise<ProcessTerminationResult> {
  if (opts === null || typeof opts !== "object" || opts.identity === null || typeof opts.identity !== "object") {
    fail("INVALID_IDENTITY", "identity is required");
  }
  const identity = opts.identity;
  if (
    !Number.isSafeInteger(identity.pid) ||
    identity.pid <= 1 ||
    !Number.isSafeInteger(identity.pgid) ||
    identity.pgid <= 1
  ) {
    fail("INVALID_IDENTITY", "pid/pgid must be positive integers");
  }
  const platform = opts.platform ?? identity.platform;
  if (platform !== identity.platform) fail("PLATFORM_IDENTITY_MISMATCH", "platform override does not match identity");
  if (identity.pid === process.pid) fail("REFUSE_SELF_GROUP", "refusing to terminate the gateway process");
  if (platform === "linux") {
    let own: LinuxProcStat | null;
    try {
      own = await readLinuxProcStat(process.pid);
    } catch {
      return makeResult(identity, "pending", "GATEWAY_GROUP_UNVERIFIABLE");
    }
    if (!own) return makeResult(identity, "pending", "GATEWAY_GROUP_UNVERIFIABLE");
    if (own.pgid === identity.pgid) {
      fail("REFUSE_SELF_GROUP", "refusing to terminate the gateway process group");
    }
    if (!identity.startTicks || !/^[0-9]+$/.test(identity.startTicks)) {
      fail("INVALID_IDENTITY", "Linux identity requires startTicks");
    }
  }
  const gracefulMs = validMs(opts.gracefulMs, "gracefulMs", 3000);
  const killMs = validMs(opts.killMs, "killMs", 5000);

  if (platform === "win32") {
    return makeResult(identity, "pending", "WINDOWS_TREE_UNVERIFIABLE", {
      directChildExited: hasChildExited(opts.child),
    });
  }
  if (platform !== "linux") {
    return makeResult(identity, "pending", "PLATFORM_VERIFICATION_UNAVAILABLE", {
      directChildExited: hasChildExited(opts.child),
    });
  }

  const defaults = defaultProbe(platform);
  const probe: ProcessProbe = {
    readStat: opts.probe?.readStat ?? defaults.readStat,
    groupState: opts.probe?.groupState ?? defaults.groupState,
    signalGroup: opts.probe?.signalGroup ?? defaults.signalGroup,
    sleep: opts.probe?.sleep ?? defaults.sleep,
    now: opts.probe?.now ?? defaults.now,
  };

  // PID / PGID 复用保护：同一 pid 的 starttime 与 pgrp 必须与捕获时一致；不一致绝不盲杀。
  let before: LinuxProcStat | null;
  try {
    before = await probe.readStat(identity.pid);
  } catch {
    return makeResult(identity, "pending", "PROCESS_IDENTITY_UNVERIFIABLE");
  }
  if (before && afterStartMismatch(before, identity)) {
    return makeResult(identity, "failed", "PROCESS_IDENTITY_MISMATCH");
  }
  if (before && before.pgid !== identity.pgid) {
    return makeResult(identity, "failed", "PROCESS_IDENTITY_MISMATCH");
  }
  const leaderLive = before !== null && isLiveLinuxState(before.state);

  let childExited = hasChildExited(opts.child);
  const onExit = () => { childExited = true; };
  opts.child?.once("exit", onExit);
  try {
    const initial = await probe.groupState(identity.pgid).catch(() => "unknown" as const);
    if (initial === "absent") {
      if (leaderLive) {
        // 存活 leader 不可能不在自己的进程组；探针与 /proc 矛盾时不得报成功。
        return makeResult(identity, "pending", "PROCESS_GROUP_STATE_INCONSISTENT", {
          directChildExited: childExited || hasChildExited(opts.child),
        });
      }
      // leader 已消失或仅剩僵尸：没有可执行组员，可安全判定组已退出。
      return makeResult(identity, "passed", "PROCESS_GROUP_ABSENT", {
        directChildExited: true,
        processGroupAbsent: true,
      });
    }
    if (initial === "unknown") {
      // 组状态不可判定时不得发送任何信号（可能命中复用的 PGID）。
      return makeResult(identity, "pending", "PROCESS_GROUP_STATE_UNKNOWN", {
        directChildExited: childExited || hasChildExited(opts.child),
      });
    }
    if (!leaderLive) {
      // leader 已退出但组仍有存活组员：没有 leader startTicks 可证明该 PGID 未被复用。
      // C2-B2 需用进程注册表/cgroup 补足组身份后，才可安全强杀。
      return makeResult(identity, "pending", "PROCESS_LEADER_GONE_UNVERIFIABLE", {
        directChildExited: childExited || hasChildExited(opts.child),
      });
    }

    let gracefulTimedOut = false;
    let forced = false;
    let gracefulError = false;
    const graceStarted = probe.now();
    try {
      if (opts.graceful) {
        // 优雅动作本身也必须有界：SDK shutdown 不得无限阻塞清理流程。
        let gracefulCompleted = false;
        await Promise.race([
          Promise.resolve()
            .then(() => opts.graceful!())
            .then(() => { gracefulCompleted = true; }, () => { gracefulError = true; }),
          probe.sleep(gracefulMs).then(() => { /* timeout */ }),
        ]);
        if (!gracefulCompleted) gracefulTimedOut = true;
      } else {
        // SIGTERM 前最后一次复核 leader：组状态扫描后到发信号之间仍可能发生退出/复用。
        let signalStat: LinuxProcStat | null;
        try {
          signalStat = await probe.readStat(identity.pid);
        } catch {
          return makeResult(identity, "pending", "PROCESS_IDENTITY_UNVERIFIABLE");
        }
        if (signalStat && (afterStartMismatch(signalStat, identity) || signalStat.pgid !== identity.pgid)) {
          return makeResult(identity, "failed", "PROCESS_IDENTITY_MISMATCH");
        }
        if (!signalStat || !isLiveLinuxState(signalStat.state)) {
          return makeResult(identity, "pending", "PROCESS_LEADER_GONE_UNVERIFIABLE", {
            directChildExited: childExited || hasChildExited(opts.child),
          });
        }
        await probe.signalGroup(identity.pgid, "SIGTERM");
      }
    } catch {
      gracefulError = true;
    }
    const elapsed = Math.max(0, probe.now() - graceStarted);
    const remaining = gracefulError || gracefulTimedOut ? 0 : Math.max(0, gracefulMs - elapsed);
    const gracefulState = await waitGroupGone(probe, identity.pgid, remaining);
    if (gracefulState === "absent") {
      let afterGraceful: LinuxProcStat | null;
      try {
        afterGraceful = await probe.readStat(identity.pid);
      } catch {
        return makeResult(identity, "pending", "PROCESS_IDENTITY_UNVERIFIABLE", {
          gracefulTimedOut,
          forced,
        });
      }
      if (afterGraceful && (afterStartMismatch(afterGraceful, identity) || afterGraceful.pgid !== identity.pgid)) {
        return makeResult(identity, "pending", "PROCESS_IDENTITY_CHANGED", {
          gracefulTimedOut,
          forced,
        });
      }
      if (afterGraceful && isLiveLinuxState(afterGraceful.state)) {
        return makeResult(identity, "pending", "PROCESS_GROUP_STATE_INCONSISTENT", {
          gracefulTimedOut,
          forced,
        });
      }
      return makeResult(identity, "passed", "PROCESS_GROUP_EXITED", {
        directChildExited: true,
        processGroupAbsent: true,
        gracefulTimedOut,
        forced,
      });
    }
    if (gracefulState === "unknown") {
      return makeResult(identity, "pending", "PROCESS_GROUP_STATE_UNKNOWN", {
        directChildExited: childExited || hasChildExited(opts.child),
        gracefulTimedOut,
        forced,
      });
    }
    if (gracefulState === "timeout" || gracefulState === "exists") gracefulTimedOut = true;

    // 强杀前再次核对 leader：若 leader 在优雅阶段退出，PGID 身份不可再证明，停止强杀。
    let beforeForce: LinuxProcStat | null;
    try {
      beforeForce = await probe.readStat(identity.pid);
    } catch {
      return makeResult(identity, "pending", "PROCESS_IDENTITY_UNVERIFIABLE", {
        gracefulTimedOut,
        forced,
      });
    }
    if (beforeForce && (afterStartMismatch(beforeForce, identity) || beforeForce.pgid !== identity.pgid)) {
      return makeResult(identity, "failed", "PROCESS_IDENTITY_MISMATCH", {
        gracefulTimedOut,
        forced,
      });
    }
    if (!beforeForce || !isLiveLinuxState(beforeForce.state)) {
      return makeResult(identity, "pending", "PROCESS_LEADER_GONE_UNVERIFIABLE", {
        directChildExited: childExited || hasChildExited(opts.child),
        gracefulTimedOut,
        forced,
      });
    }

    forced = true;
    try {
      await probe.signalGroup(identity.pgid, "SIGKILL");
    } catch {
      // 如果组已经消失，signalGroup 默认实现吞 ESRCH；这里只剩真实失败。
      return makeResult(identity, "failed", "PROCESS_SIGNAL_FAILED", {
        directChildExited: childExited || hasChildExited(opts.child),
        gracefulTimedOut,
        forced,
      });
    }
    const killedState = await waitGroupGone(probe, identity.pgid, killMs);
    let finalStat: LinuxProcStat | null;
    try {
      finalStat = await probe.readStat(identity.pid);
    } catch {
      return makeResult(identity, "pending", "PROCESS_IDENTITY_UNVERIFIABLE", {
        directChildExited: childExited || hasChildExited(opts.child),
        gracefulTimedOut,
        forced,
      });
    }
    if (finalStat && (afterStartMismatch(finalStat, identity) || finalStat.pgid !== identity.pgid)) {
      return makeResult(identity, "pending", "PROCESS_IDENTITY_CHANGED", {
        gracefulTimedOut,
        forced,
      });
    }
    const finalLeaderLive = finalStat !== null && isLiveLinuxState(finalStat.state);
    const directGone = childExited || hasChildExited(opts.child) || !finalLeaderLive;

    if (killedState === "absent") {
      if (finalLeaderLive) {
        return makeResult(identity, "pending", "PROCESS_GROUP_STATE_INCONSISTENT", {
          directChildExited: directGone,
          gracefulTimedOut,
          forced,
        });
      }
      return makeResult(identity, "passed", "PROCESS_GROUP_EXITED", {
        directChildExited: true,
        processGroupAbsent: true,
        gracefulTimedOut,
        forced,
      });
    }
    if (killedState === "unknown") {
      return makeResult(identity, "pending", "PROCESS_GROUP_STATE_UNKNOWN", {
        directChildExited: directGone,
        gracefulTimedOut,
        forced,
      });
    }
    if (killedState === "timeout" || killedState === "exists") {
      const reason = gracefulError ? "PROCESS_SIGNAL_FAILED" : "PROCESS_GROUP_ALIVE";
      return makeResult(identity, "failed", reason, {
        directChildExited: directGone,
        gracefulTimedOut,
        forced,
      });
    }
    return makeResult(identity, "pending", "PROCESS_GROUP_STATE_UNKNOWN", {
      directChildExited: directGone,
      gracefulTimedOut,
      forced,
    });
  } finally {
    opts.child?.off?.("exit", onExit);
  }
}

function afterStartMismatch(stat: LinuxProcStat, identity: ProcessIdentity): boolean {
  return identity.startTicks !== null && stat.startTicks !== identity.startTicks;
}
