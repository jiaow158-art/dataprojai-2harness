// M1-T5：dsh SDK JSON-RPC stdio 客户端（T16 60 行驱动的产品化）。
//
// spawn 形态以 T16 实测可跑通方式为准（m0/verify/multiturn_check.md §2）：
//   spawn("dsh.cmd", ["--profile","sdk"], { shell: win32 }) —— Windows 下 dsh 是
//   npm .cmd shim，无 shell 不可执行；stdio 三管道。
// 协议面三方法全集（dsh-sdk-protocol types.d.ts，S3 spike 已核）：initialize /
// session/prompt / shutdown —— **无 cancel/interrupt**；AbortSignal 仅客户端放弃
// 等待不终止服务端 turn。故超时/取消 = killTree（Windows taskkill /T /F）+
// 等 exit 事件（findings dsh-api.md §5.5）。
// session/prompt 的 JSON-RPC result 只是入队回执；终态以 session.event 通知流中
// 该 sessionId 的 turn/end 为准（completed → resolve；异常 reason → reject）。
//
// stderr 消毒红线（T2 发现）：dsh 启动失败时 stderr 可能含解析后 env map
// （DWS_PASSWORD 明文）。stderr 只进内存环形缓冲（尾 4KB），任何输出前 sanitize
// （已知密钥值 → ***，另加 KEY=value 形态兜底），绝不原样外传。
//
// spawn env 全量注入清单（S3 spike 失败归因：少一个 M0_* 变量 → m0-exec-script
// 插件树加载失败 → initialize 报 -32603 inactive context）：
//   M0_SANDBOX_RUNNER / M0_SANDBOX_WORKDIR / M0_RESULTS_DIR / M0_ASSETS_DIR /
//   M0_PROJECT_SKILL_DIR / RESULT_DIR / DWS_USER / DWS_PASSWORD / DEEPSEEK_API_KEY
// 客户端不组装这份清单（职责在 DshBackend），但以 REQUIRED_ENV_KEYS 导出供
// backend 组装与单测断言。

import { spawn, type ChildProcess } from "node:child_process";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import type { RawSdkEvent } from "./dsh-events.ts";

/** spawn env 必含键（S3 spike 定型；见文件头注释）。 */
export const REQUIRED_ENV_KEYS = [
  "M0_SANDBOX_RUNNER",
  "M0_SANDBOX_WORKDIR",
  "M0_RESULTS_DIR",
  "M0_ASSETS_DIR",
  "M0_PROJECT_SKILL_DIR",
  "RESULT_DIR",
  "DWS_USER",
  "DWS_PASSWORD",
  "DEEPSEEK_API_KEY",
] as const;

/** stderr 环形缓冲上限（尾 4KB——足够诊断、不含多余泄露面）。 */
const STDERR_TAIL_BYTES = 4096;

/** 已知密钥 env 键（值替换 ***；形态兜底 KEY=value → KEY=***）。 */
const SECRET_ENV_KEYS = ["DWS_PASSWORD", "DWS_RUN_PASSWORD", "DEEPSEEK_API_KEY"];

export interface InitializeParams {
  provider: string;
  model: string;
  maxTokens?: number;
}

export interface TurnEnd {
  turn: number;
  reason: { kind: string; error?: { message?: string; code?: string } };
}

export type SdkEventCallback = (event: RawSdkEvent, sessionId: string) => void;

export interface DshSdkClientOpts {
  cwd: string;
  /** 完整子进程 env（须含 REQUIRED_ENV_KEYS；客户端只透传不组装）。 */
  env: Record<string, string | undefined>;
  command?: string;
  args?: string[];
  onEvent?: SdkEventCallback;
  /** 测试注入：替身 spawn（默认真实 spawn）。 */
  spawnFn?: (command: string, args: string[], opts: any) => ChildProcess;
  /** 测试注入：替身进程树击杀（默认 taskkill /T /F 或 SIGKILL）。 */
  killTreeFn?: (pid: number | undefined) => void;
  /** initialize 超时（默认 60s）。 */
  initTimeoutMs?: number;
}

/** prompt 失败的错误载体（code 对齐 spec §5 error 词表）。 */
export class SdkPromptError extends Error {
  code: string;
  stderrTail: string;
  constructor(code: string, message: string, stderrTail = "") {
    super(`[${code}] ${message}${stderrTail ? ` (stderr tail: ${stderrTail})` : ""}`);
    this.code = code;
    this.stderrTail = stderrTail;
  }
}

export class DshSdkClient {
  private child: ChildProcess | null = null;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private stderrBuf = "";
  private secretValues: string[] = [];
  private exited = false;
  private timedOut = false;
  private onEvent?: SdkEventCallback;
  private spawnFn: (command: string, args: string[], opts: any) => ChildProcess;
  private killTreeFn: (pid: number | undefined) => void;
  private initTimeoutMs: number;
  /** 当前 prompt 的终态裁定器（同进程串行单 prompt；backend 侧按序驱动）。 */
  private activePrompt: {
    sessionId: string;
    resolve: (t: TurnEnd) => void;
    reject: (e: Error) => void;
    timeoutTimer: NodeJS.Timeout | null;
  } | null = null;

  private opts: DshSdkClientOpts;
  constructor(opts: DshSdkClientOpts) {
    this.opts = opts;
    this.onEvent = opts.onEvent;
    this.spawnFn = opts.spawnFn ?? defaultSpawn;
    this.killTreeFn = opts.killTreeFn ?? defaultKillTree;
    this.initTimeoutMs = opts.initTimeoutMs ?? 60_000;
    for (const k of SECRET_ENV_KEYS) {
      const v = opts.env[k];
      if (v) this.secretValues.push(v);
    }
  }

  /** spawn 子进程并完成 initialize 握手（含 init 超时）。 */
  async start(initParams: InitializeParams): Promise<{ serverInfo: { name: string; version: string } }> {
    if (this.child) throw new Error("client already started");
    const command = this.opts.command ?? (process.platform === "win32" ? "dsh.cmd" : "dsh");
    const args = this.opts.args ?? ["--profile", "sdk"];
    // T16 形态：win32 必须 shell:true（npm .cmd shim）；stdio 三管道。
    const child = this.spawnFn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.opts.cwd,
      env: this.opts.env,
      shell: process.platform === "win32",
    });
    this.child = child;

    child.stderr?.on("data", (d: Buffer) => this.appendStderr(d.toString()));
    child.on("exit", () => {
      this.exited = true;
      this.rejectAllPending(new SdkPromptError(
        this.timedOut ? "TIMEOUT" : "ENGINE_ERROR",
        this.timedOut ? "prompt timeout exceeded — process tree killed" : "dsh process exited",
        this.stderrTail(),
      ));
    });
    // 单行 JSON 分帧（T16 驱动同款 readline）
    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line: string) => this.handleLine(line));

    // initialize 失败/超时 → 必须杀掉已 spawn 的子进程（env 携密钥的 dsh 不得
    // 成为孤儿泄漏），再向上抛错。
    try {
      const result = await this.withTimeout(
        this.send("initialize", { cwd: this.opts.cwd, ...initParams }),
        this.initTimeoutMs,
        () => new SdkPromptError("TIMEOUT", `initialize no response in ${this.initTimeoutMs}ms`, this.stderrTail()),
      );
      return result as { serverInfo: { name: string; version: string } };
    } catch (e) {
      this.killTree();
      throw e;
    }
  }

  get hasExited(): boolean {
    return this.exited;
  }

  /**
   * 发起一轮 prompt 并等到该 sessionId 的 turn/end。
   * resolve：turn/end reason=completed；reject：JSON-RPC 错误响应 / turn/end 异常
   * reason / 超时（killTree + 等 exit）/ 进程死亡。
   */
  async prompt(sessionId: string, text: string, timeoutMs: number): Promise<TurnEnd> {
    if (!this.child || this.exited) throw new SdkPromptError("ENGINE_ERROR", "dsh process not running");
    if (this.activePrompt) throw new Error("another prompt is in flight on this client");
    this.timedOut = false;

    const timeoutTimer = setTimeout(() => {
      // 协议面无取消方法（S3 spike）：唯一终止手段 = killTree，然后等 exit 事件拒掉
      // pending（code 标 TIMEOUT——exit 路径按 timedOut 旗标区分超时击杀 vs 意外死亡）。
      this.timedOut = true;
      this.killTree();
      // 兜底：exit 事件 5s 内未到也必须拒（防孤儿句柄悬挂）；unref 不阻塞进程退出。
      const grace = setTimeout(() => {
        if (this.activePrompt) {
          this.rejectAllPending(new SdkPromptError("TIMEOUT", "prompt timeout — process tree killed, no exit event", this.stderrTail()));
        }
      }, 5000);
      grace.unref?.();
    }, timeoutMs);

    try {
      return await new Promise<TurnEnd>((resolve, reject) => {
        this.activePrompt = { sessionId, resolve, reject, timeoutTimer };
        this.send("session/prompt", {
          sessionId,
          contentBlocks: [{ type: "text", text }],
        }).catch(reject);
      });
    } finally {
      if (this.activePrompt?.timeoutTimer) clearTimeout(this.activePrompt.timeoutTimer);
      this.activePrompt = null;
    }
  }

  /** 优雅关闭（shutdown → 等 exit；超时强杀）。 */
  async stop(graceMs = 5000): Promise<void> {
    if (!this.child || this.exited) return;
    try {
      await this.withTimeout(this.send("shutdown", {}), graceMs, new Error("shutdown timeout"));
    } catch {
      // shutdown 无响应 → 直接 killTree
    }
    this.killTree();
    await this.waitExit(graceMs);
  }

  /** 立即击杀进程树（超时/取消路径；cancel 语义 = 这个）。 */
  killTree(): void {
    if (!this.child || this.exited) return;
    try {
      this.killTreeFn((this.child as any).pid);
    } catch { /* 已死则无事 */ }
  }

  /** 击杀并等 exit（cancel 的完整语义：进程树确实终止后才返回）。 */
  async kill(graceMs = 5000): Promise<void> {
    this.killTree();
    await this.waitExit(graceMs);
  }

  /** 消毒后的 stderr 尾部（仅内存环形缓冲，绝不外传原文）。 */
  stderrTail(): string {
    return this.sanitize(this.stderrBuf);
  }

  private async waitExit(ms: number): Promise<void> {
    if (this.exited) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      this.child?.once("exit", () => { clearTimeout(t); resolve(); });
    });
  }

  private appendStderr(chunk: string): void {
    this.stderrBuf += chunk;
    if (this.stderrBuf.length > STDERR_TAIL_BYTES) {
      this.stderrBuf = this.stderrBuf.slice(-STDERR_TAIL_BYTES);
    }
  }

  /** 消毒：已知密钥值 → ***；KEY=value / KEY: value 形态兜底（键名含
   *  PASSWORD/TOKEN/SECRET/KEY 即遮蔽——与 dsh 自身 env 洗净机制同款宽度，
   *  findings §3.1；网关全环境透传时 AUTH_TOKEN 等未预知键的崩溃 dump 不外泄）。 */
  private sanitize(text: string): string {
    let out = text;
    for (const v of this.secretValues) {
      if (v) out = out.split(v).join("***");
    }
    out = out.replace(/(\w*(?:PASSWORD|TOKEN|SECRET|KEY)\w*)(\s*[=:]\s*)\S+/gi, "$1$2***");
    return out;
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }

    // 应答：匹配 pending
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) {
          p.reject(new SdkPromptError(
            String(msg.error.code ?? "ENGINE_ERROR"),
            `${msg.error.message}${msg.error.data ? ` ${JSON.stringify(msg.error.data)}` : ""}`,
          ));
        } else {
          p.resolve(msg.result);
        }
      }
      return;
    }

    // 通知：session.event（事件流）
    if (msg.method === "session.event" && msg.params?.event) {
      const ev = msg.params.event as RawSdkEvent;
      const sid = String(msg.params.sessionId ?? "");
      // 先推事件（backend 归一化入队），再裁定 prompt 终态——保证 turn/end 前的
      // 事件（含 answer）已全部到达消费方。
      this.onEvent?.(ev, sid);
      if (ev.type === "turn/end" && this.activePrompt && sid === this.activePrompt.sessionId) {
        const data = ev.data ?? {};
        const reason = data.reason ?? { kind: "unknown" };
        if (reason.kind === "completed") this.activePrompt.resolve({ turn: data.turn, reason });
        else {
          this.activePrompt.reject(new SdkPromptError(
            "ENGINE_ERROR",
            `turn/end reason: ${JSON.stringify(reason)}`,
            this.stderrTail(),
          ));
        }
      }
      return;
    }
    // session.status 等其他通知：当前不消费
  }

  private send(method: string, params: unknown): Promise<any> {
    if (!this.child || this.exited) {
      return Promise.reject(new SdkPromptError("ENGINE_ERROR", "dsh process not running"));
    }
    const id = `c${this.nextId++}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.child!.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      } catch (e) {
        this.pending.delete(id);
        reject(new SdkPromptError("ENGINE_ERROR", `stdin write failed: ${String(e)}`));
      }
    });
  }

  private rejectAllPending(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
    if (this.activePrompt) {
      const ap = this.activePrompt;
      if (ap.timeoutTimer) clearTimeout(ap.timeoutTimer);
      ap.reject(err);
      this.activePrompt = null;
    }
  }

  private withTimeout<T>(p: Promise<T>, ms: number, makeError: () => Error): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(makeError()), ms);
      p.then(
        (v) => { clearTimeout(t); resolve(v); },
        (e) => { clearTimeout(t); reject(e); },
      );
    });
  }
}

/** 真实 spawn（测试注入 spawnFn 替身）。 */
function defaultSpawn(command: string, args: string[], opts: any): ChildProcess {
  return spawn(command, args, opts) as ChildProcess;
}

/** 跨平台进程树击杀：Windows taskkill /T /F；POSIX SIGKILL（进程组由 backend 落地）。 */
export function defaultKillTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try { process.kill(pid, "SIGKILL"); } catch { /* 已死 */ }
  }
}
