// M1-T5：DshBackend —— spec §5 BackendProvider 的 dsh 实现（SDK 驱动组装层）。
//
// 三条 S3 spike 设计约束（findings dsh-api.md §5.5，非可选）：
//   1. SDK sessionId 每次 spawn 唯一：`gw-<sessionId>-a<attempt+代数>-<6位随机hex>`。
//      跨 spawn 复用同 id 被服务端确定性拒绝（id collision，两次复验；已完成的
//      持久化日志同样撞——S3 进程 C 证据）。唯一性必须**跨实例**成立：a<attempt>
//      段只保证单实例内不重（同逻辑会话的第二个任务以同 attempt 起跑就会撞已
//      持久化日志），故每次 spawn 追加实例无关随机段（randomBytes(3).hex）；
//      a<attempt> 保留为可读段便于日志排查。逻辑会话身份在网关侧（SQLite
//      session_id），不在 dsh 侧。
//   2. cancel/超时 = killTree（协议面仅 initialize/session/prompt/shutdown 三方法，
//      无 cancel；AbortSignal 只放弃客户端等待不终止服务端）。
//   3. spawn env 全量注入（REQUIRED_ENV_KEYS）：少一个 M0_* 变量 → m0-exec-script
//      插件树加载失败 → initialize 报 -32603 inactive context（前代理失败现场）。
//
// 目录布局（附录 A：workdir 必须在 Temp 树外——S3 spike 前代理把 workdir 建进
// Temp 相关路径的教训同类）：`<workroot>/<sessionId>/workdir` 与
// `<resultsRoot>/<sessionId>/results`（RESULT_DIR=M0_RESULTS_DIR 同指后者，
// D13 双通道 result_ref 落点）。
//
// S2 注入点：ask(question, {historyPrefix}) —— 前缀拼进 prompt 文本（历史摘要 +
// result_ref 清单由 T7 TaskRunner 生成；spike 裁定"全量注入必需"，dsh 侧零自恢复）。

import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import type { DbAccount } from "../config/db-accounts.ts";
import { DshSdkClient, REQUIRED_ENV_KEYS, type TurnEnd } from "./dsh-sdk-client.ts";
import { EventNormalizer, type NormEvent, type RawSdkEvent } from "./dsh-events.ts";
import type { ChildProcess } from "node:child_process";

/** spec §5 稳定契约：换引擎 = 新实现 + 改一行注册，Web/API 零改动。 */
export interface BackendProvider {
  id: string;
  createSession(opts: SessionOpts): Promise<EngineSession>;
}

export interface SessionOpts {
  /** 逻辑会话 id（网关持久身份；dsh 侧 SDK id 由其派生且每次 spawn 唯一）。 */
  sessionId: string;
  workroot: string;
  resultsRoot: string;
  assetsDir: string;
  runnerPath: string;
  skillsDir: string;
  db: DbAccount;
  /** 初始 attempt（恢复入口 T7 传入；此后 respawn 自增代数）。 */
  attempt?: number;
  /** 任务 id（T9 L-1 接线：注入 SANDBOX_RUN_ID 使沙箱容器名 <run_id>-a<attempt>-<pid>，
   *  接管者按 run_id+旧 attempt 清理不误杀新 attempt——附录 A.1）。缺省回退 sessionId。 */
  runId?: string;
}

export interface AskOpts {
  /** S2 历史注入前缀（本会话已成功任务的问题+回答摘要+result_ref 清单）。 */
  historyPrefix?: string;
  /** 单问预算（默认 15 分钟，T16 断路线）。 */
  timeoutMs?: number;
}

export interface EngineSession {
  ask(question: string, opts?: AskOpts): AsyncIterable<NormEvent>;
  cancel(): Promise<void>;
}

/** DshBackend 可注入依赖（单测替身；默认真实 spawn/killTree/console.warn）。 */
export interface DshBackendDeps {
  spawnFn?: (command: string, args: string[], opts: any) => ChildProcess;
  killTreeFn?: (pid: number | undefined) => void;
  onWarn?: (message: string) => void;
  provider?: string;
  model?: string;
  maxTokens?: number;
}

const DEFAULT_PROMPT_TIMEOUT_MS = 15 * 60_000;

export class DshBackend implements BackendProvider {
  readonly id = "dsh";
  private onWarn: (message: string) => void;
  private spawnFn?: (command: string, args: string[], opts: any) => ChildProcess;
  private killTreeFn?: (pid: number | undefined) => void;
  private initParams: { provider: string; model: string; maxTokens?: number };

  constructor(deps: DshBackendDeps = {}) {
    this.onWarn = deps.onWarn ?? ((m) => console.warn(m));
    this.spawnFn = deps.spawnFn;
    this.killTreeFn = deps.killTreeFn;
    this.initParams = {
      provider: deps.provider ?? "deepseek-official",
      model: deps.model ?? "deepseek-v4-flash",
      maxTokens: deps.maxTokens ?? 49152,
    };
  }

  async createSession(opts: SessionOpts): Promise<EngineSession> {
    const workdir = join(opts.workroot, opts.sessionId, "workdir");
    const resultsDir = join(opts.resultsRoot, opts.sessionId, "results");
    mkdirSync(workdir, { recursive: true });
    mkdirSync(resultsDir, { recursive: true });
    this.warnIfTempPath(workdir, "workdir");
    this.warnIfTempPath(resultsDir, "results");

    // 密钥经 T3 resolveDbAccount（调用方已解析）；这里只取值进子进程 env，
    // 任何日志/事件不落密钥值（密钥红线）。
    const dwsPassword = process.env[opts.db.passwordEnv];
    if (!dwsPassword) {
      throw new Error(`[CONFIG] ${opts.db.passwordEnv} not set — cannot spawn dsh (db account: ${opts.db.user})`);
    }
    const deepseekKey = process.env.DEEPSEEK_API_KEY;
    if (!deepseekKey) {
      throw new Error("[CONFIG] DEEPSEEK_API_KEY not set — cannot spawn dsh");
    }
    // DWS_USER 注入 db.user：当前 profile patch 暂钉 aiuser（T2 L4 集成注），
    // 受限账号落地改 patch 读 env 时网关侧零改动。
    const env: Record<string, string | undefined> = {
      ...process.env,
      M0_SANDBOX_RUNNER: opts.runnerPath,
      M0_SANDBOX_WORKDIR: workdir,
      M0_RESULTS_DIR: resultsDir,
      M0_ASSETS_DIR: opts.assetsDir,
      M0_PROJECT_SKILL_DIR: opts.skillsDir,
      RESULT_DIR: resultsDir,
      SANDBOX_RUN_ID: opts.runId ?? opts.sessionId,
      SANDBOX_ATTEMPT: String(opts.attempt ?? 1),
      DWS_USER: opts.db.user,
      DWS_PASSWORD: dwsPassword,
      DEEPSEEK_API_KEY: deepseekKey,
    };
    const missing = REQUIRED_ENV_KEYS.filter((k) => !env[k]);
    if (missing.length) {
      throw new Error(`[CONFIG] env injection incomplete, missing: ${missing.join(", ")}`);
    }

    return new DshEngineSession(opts, env, this.spawnFn, this.killTreeFn, this.initParams);
  }

  /** 附录 A：workdir/results 必须在 Temp 树外（Temp 清理会吞产物/围栏证据）。 */
  private warnIfTempPath(p: string, label: string): void {
    const abs = resolve(p);
    const tmp = resolve(tmpdir());
    if (abs.startsWith(tmp + sep) || /[/\\]temp([/\\]|$)/i.test(abs) || /[/\\]tmp([/\\]|$)/i.test(abs)) {
      this.onWarn(`[A-TEMP] ${label} path "${abs}" is inside a Temp tree — appendix A requires task dirs outside Temp`);
    }
  }
}

/** 单逻辑会话的引擎侧句柄：持有一个 dsh 子进程，死亡/超时后按代数 respawn。 */
class DshEngineSession implements EngineSession {
  private generation: number;
  /** 本次 spawn 的实例无关随机段（S3 约束 1：跨实例唯一性；每次 spawn 重掷）。 */
  private spawnNonce: string;
  private client: DshSdkClient | null = null;
  private clientStarted = false;
  private cancelled = false;
  /** 当前 ask() 的原始事件汇入点（串行单 ask；respawn 换代不影响汇入）。 */
  private sink: ((ev: RawSdkEvent, sessionId: string) => void) | null = null;

  private opts: SessionOpts;
  private env: Record<string, string | undefined>;
  private spawnFn?: (command: string, args: string[], opts: any) => ChildProcess;
  private killTreeFn?: (pid: number | undefined) => void;
  private initParams?: { provider: string; model: string; maxTokens?: number };

  constructor(
    opts: SessionOpts,
    env: Record<string, string | undefined>,
    spawnFn?: (command: string, args: string[], opts: any) => ChildProcess,
    killTreeFn?: (pid: number | undefined) => void,
    initParams?: { provider: string; model: string; maxTokens?: number },
  ) {
    this.opts = opts;
    this.env = env;
    this.spawnFn = spawnFn;
    this.killTreeFn = killTreeFn;
    this.initParams = initParams;
    this.generation = opts.attempt ?? 1;
    this.spawnNonce = randomBytes(3).toString("hex");
  }

  /** 当前 spawn 的 SDK 会话 id（每次 spawn 唯一且跨实例唯一——S3 spike 约束 1）。 */
  get sdkSessionId(): string {
    return `gw-${this.opts.sessionId}-a${this.generation}-${this.spawnNonce}`;
  }

  async *ask(question: string, askOpts?: AskOpts): AsyncGenerator<NormEvent> {
    if (this.cancelled) return;
    const text = askOpts?.historyPrefix
      ? `${askOpts.historyPrefix}\n\n---\n\n${question}`
      : question;
    const timeoutMs = askOpts?.timeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;

    let client: DshSdkClient;
    try {
      client = await this.ensureClient();
    } catch (e) {
      yield { type: "error", code: "CONFIG", message: `dsh spawn/initialize failed: ${String(e)}` };
      return;
    }

    const queue = new AsyncQueue<NormEvent>();
    const normalizer = new EventNormalizer();
    this.sink = (ev) => queue.push(...normalizer.push(ev));

    let outcome: { ok?: TurnEnd; err?: Error } | undefined;
    client.prompt(this.sdkSessionId, text, timeoutMs).then(
      (t) => { outcome = { ok: t }; queue.close(); },
      (e) => { outcome = { err: e as Error }; queue.close(); },
    );

    try {
      for await (const ev of queue.drain()) yield ev;
    } finally {
      this.sink = null;
    }

    if (outcome?.err) {
      const err = outcome.err as any;
      // cancel() 触发的击杀不产 error 事件（终态 cancelled 由编排层落库）
      if (!this.cancelled) {
        yield { type: "error", code: err?.code ?? "ENGINE_ERROR", message: err?.message ?? String(err) };
      }
      return;
    }
    // turn/end completed → 流自然终止（done 事件属 T7 编排层）
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    if (this.client) await this.client.kill();
  }

  /** 取活客户端；死亡/未启动则 respawn（新代数 = 新 SDK sessionId）。 */
  private async ensureClient(): Promise<DshSdkClient> {
    if (this.client && this.clientStarted && !this.client.hasExited) return this.client;
    // 旧客户端已死（超时击杀/意外退出）：换代重启；随机段重掷（跨实例唯一）
    if (this.client) this.generation++;
    this.spawnNonce = randomBytes(3).toString("hex");
    const client = new DshSdkClient({
      cwd: join(this.opts.workroot, this.opts.sessionId, "workdir"),
      env: this.env,
      onEvent: (ev, sid) => this.sink?.(ev, sid),
      ...(this.spawnFn ? { spawnFn: this.spawnFn } : {}),
      ...(this.killTreeFn ? { killTreeFn: this.killTreeFn } : {}),
    });
    this.client = client;
    await client.start(this.initParams ?? { provider: "deepseek-official", model: "deepseek-v4-flash" });
    this.clientStarted = true;
    return client;
  }
}

/** 极简异步队列：事件到达即推，close 后 drain 依次吐完再结束（保序）。 */
class AsyncQueue<T> {
  private items: T[] = [];
  private resolvers: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(...xs: T[]): void {
    for (const x of xs) {
      if (this.resolvers.length) this.resolvers.shift()!({ value: x, done: false });
      else this.items.push(x);
    }
  }

  close(): void {
    this.closed = true;
    for (const r of this.resolvers) r({ value: undefined as any, done: true });
  }

  async *drain(): AsyncGenerator<T> {
    while (true) {
      if (this.items.length) {
        yield this.items.shift()!;
        continue;
      }
      if (this.closed) return;
      const r = await new Promise<IteratorResult<T>>((res) => this.resolvers.push(res));
      if (r.done) return;
      yield r.value;
    }
  }
}
