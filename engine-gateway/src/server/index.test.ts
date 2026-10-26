// S4-B2-C2-B2-2B-2：Linux isolated 启动校验测试。
// 只做本地路径/Docker inspect 注入校验；不启动 Gateway/BFF、不监听端口。
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  BoundedCleanupAudit,
  CleanupStartupError,
  buildBackendSourceEnv,
  validateCleanupStartup,
  type CleanupStartupValidationInput,
} from "./index.ts";
import { CleanupAuditLog } from "../orchestrator/cleanup-audit.ts";
import { prepareTrustedRuntime } from "../config/trusted-runtime.ts";
import type { CleanupPolicyEnabled } from "../config/cleanup-policy.ts";
import type { TaskRunnerPaths } from "../orchestrator/task-runner.ts";
import type { DockerRunResult } from "../orchestrator/sandbox-container-reaper.ts";

const LINUX = process.platform === "linux";
const IMAGE = `sha256:${"a".repeat(64)}`;
const RUNNER_SOURCE = [
  "#!/usr/bin/env bash",
  'ACL_STATE_DIR="${SANDBOX_ACL_STATE_DIR:-x}"',
  'ACL_KEY="$(printf \'%s\' "${WD_REAL}" | sha256sum | cut -c1-16)"',
  'exec 9>>"${ACL_LOCK}"',
  'flock -n 9 || exit 78',
  'IMAGE="${SANDBOX_IMAGE:-dataplat-script:m0}"',
  'CNAME="${SANDBOX_RUN_ID}-a${SANDBOX_ATTEMPT:-0}-$$"',
  '--label "com.dpit.gateway.managed=true"',
  '--label "com.dpit.gateway.task.run_id=${SANDBOX_RUN_ID}"',
  '--label "com.dpit.gateway.task.attempt=${SANDBOX_ATTEMPT}"',
].join("\n");

interface Ctx {
  root: string;
  env: NodeJS.ProcessEnv;
  policy: CleanupPolicyEnabled;
  paths: TaskRunnerPaths;
  input: CleanupStartupValidationInput;
}

async function makeCtx(t: { after(fn: () => void | Promise<void>): void }): Promise<Ctx> {
  const root = mkdtempSync(join(tmpdir(), "c2b22b2-startup-"));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const trusted = await prepareTrustedRuntime({
    root: join(root, "trusted"),
    create: true,
    forbiddenRoots: [],
    platform: "linux",
  });
  const aclDir = join(root, "acl-state");
  mkdirSync(aclDir, { mode: 0o700 });
  const workroot = join(root, "work");
  const resultsRoot = join(root, "results");
  const assetsDir = join(root, "assets");
  const skillsDir = join(root, "skills");
  const reportsRoot = join(root, "reports");
  for (const d of [workroot, resultsRoot, assetsDir, skillsDir, reportsRoot]) mkdirSync(d, { recursive: true });
  const runnerPath = join(root, "run_in_sandbox.sh");
  writeFileSync(runnerPath, RUNNER_SOURCE, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = {
    DSH_PROFILE: "sdk-s4b",
    SANDBOX_ACL_STATE_DIR: aclDir,
    SANDBOX_IMAGE: "dataplat-script:m0",
  };
  const policy: CleanupPolicyEnabled = {
    mode: "linux_isolated",
    reason: "enabled",
    platform: "linux",
    profile: "sdk-s4b",
    runtimeRoot: trusted.root,
    aclStateDir: aclDir,
    trustedImageId: IMAGE,
  };
  const paths: TaskRunnerPaths = {
    workroot,
    resultsRoot,
    assetsDir,
    runnerPath,
    skillsDir,
    reportsRoot,
  };
  const input: CleanupStartupValidationInput = {
    env,
    platform: "linux",
    policy,
    runtime: trusted,
    paths,
    auditLogPath: join(trusted.auditDir, "cleanup-audit.jsonl"),
    reaperAuditLogPath: join(trusted.auditDir, "container-reaper-audit.jsonl"),
    leaseTtlMs: 90_000,
    heartbeatIntervalMs: 10_000,
    cleanupTimeBudgetMs: 5_000,
    auditTimeoutMs: 500,
    runDocker: async (args): Promise<DockerRunResult> => {
      assert.deepEqual(args.slice(0, 2), ["image", "inspect"]);
      return { code: 0, stdout: `${IMAGE}\n`, stderr: "" };
    },
  };
  return { root, env, policy, paths, input };
}

async function expectCode(fn: () => Promise<void>, code: string): Promise<void> {
  try {
    await fn();
    assert.fail(`expected ${code}`);
  } catch (e) {
    assert.ok(e instanceof CleanupStartupError, String(e));
    assert.equal((e as CleanupStartupError).code, code, String(e));
  }
}

test("合法启动前提通过；Docker inspect 使用 SANDBOX_IMAGE 并比对可信 image ID", { skip: !LINUX }, async (t) => {
  const c = await makeCtx(t);
  let seenImage = "";
  const input = {
    ...c.input,
    runDocker: async (args: string[]): Promise<DockerRunResult> => {
      seenImage = args[2];
      return { code: 0, stdout: `${IMAGE}\n`, stderr: "" };
    },
  };
  await validateCleanupStartup(input);
  assert.equal(seenImage, "dataplat-script:m0");
});

test("image ID 不匹配：拒绝启用", { skip: !LINUX }, async (t) => {
  const c = await makeCtx(t);
  await expectCode(
    () => validateCleanupStartup({
      ...c.input,
      runDocker: async () => ({ code: 0, stdout: `sha256:${"b".repeat(64)}\n`, stderr: "" }),
    }),
    "CLEANUP_IMAGE_MISMATCH",
  );
});

test("Docker image 不可检查：拒绝启用", { skip: !LINUX }, async (t) => {
  const c = await makeCtx(t);
  await expectCode(
    () => validateCleanupStartup({
      ...c.input,
      runDocker: async () => ({ code: 1, stdout: "", stderr: "no image", error: "exit 1" }),
    }),
    "CLEANUP_IMAGE_UNVERIFIABLE",
  );
});

test("ACL 状态目录缺失/不安全：拒绝启用", { skip: !LINUX }, async (t) => {
  const c = await makeCtx(t);
  rmSync(c.policy.aclStateDir, { recursive: true, force: true });
  await expectCode(() => validateCleanupStartup(c.input), "CLEANUP_ACL_STATE_UNSAFE");
});

test("ACL env 与 policy 不同源：拒绝启用", { skip: !LINUX }, async (t) => {
  const c = await makeCtx(t);
  await expectCode(
    () => validateCleanupStartup({
      ...c.input,
      env: { ...c.env, SANDBOX_ACL_STATE_DIR: join(c.root, "other-acl") },
    }),
    "CLEANUP_ACL_SOURCE_MISMATCH",
  );
});

test("仓库真实 run_in_sandbox.sh 通过 ACL flock / managed-label 协议校验", { skip: !LINUX }, async (t) => {
  const c = await makeCtx(t);
  const actual = resolve(process.cwd(), "../m0/sandbox/run_in_sandbox.sh");
  await validateCleanupStartup({
    ...c.input,
    paths: { ...c.paths, runnerPath: actual },
  });
});

test("Runner 缺少 ACL flock 协议标记：拒绝启用", { skip: !LINUX }, async (t) => {
  const c = await makeCtx(t);
  writeFileSync(c.paths.runnerPath, "#!/usr/bin/env bash\necho no-lock\n", { mode: 0o755 });
  await expectCode(() => validateCleanupStartup(c.input), "CLEANUP_RUNNER_PROTOCOL_UNVERIFIED");
});

test("Runner 为 symlink：拒绝启用", { skip: !LINUX }, async (t) => {
  const c = await makeCtx(t);
  const link = join(c.root, "runner-link.sh");
  symlinkSync(c.paths.runnerPath, link);
  await expectCode(
    () => validateCleanupStartup({ ...c.input, paths: { ...c.paths, runnerPath: link } }),
    "CLEANUP_RUNNER_UNSAFE",
  );
});

test("cleanup 预算 + audit 上界超过租约安全窗口：拒绝启用", { skip: !LINUX }, async (t) => {
  const c = await makeCtx(t);
  await expectCode(
    () => validateCleanupStartup({ ...c.input, cleanupTimeBudgetMs: 80_000 }),
    "CLEANUP_BUDGET_TOO_LARGE",
  );
});

test("runtime root 与任务根重叠：拒绝启用", { skip: !LINUX }, async (t) => {
  const c = await makeCtx(t);
  await expectCode(
    () => validateCleanupStartup({
      ...c.input,
      paths: { ...c.paths, workroot: join(c.policy.runtimeRoot, "work") },
    }),
    "CLEANUP_RUNTIME_ROOT_OVERLAP",
  );
});

test("cleanup 模式把 SANDBOX_IMAGE 钉为已验证 image ID；off 原样保留", { skip: !LINUX }, async (t) => {
  const c = await makeCtx(t);
  const on = buildBackendSourceEnv({ ...c.env, SANDBOX_IMAGE: "dataplat-script:m0" }, c.policy);
  assert.equal(on.SANDBOX_IMAGE, IMAGE);
  assert.equal(on.SANDBOX_ACL_STATE_DIR, c.policy.aclStateDir);
  const offEnv = { SANDBOX_IMAGE: "dataplat-script:m0" };
  const off = buildBackendSourceEnv(offEnv, {
    mode: "off",
    reason: "default",
    platform: "linux",
  });
  assert.equal(off.SANDBOX_IMAGE, "dataplat-script:m0");
  assert.equal(off, offEnv);
});

test("审计路径不在审计目录内：拒绝启用", { skip: !LINUX }, async (t) => {
  const c = await makeCtx(t);
  await expectCode(
    () => validateCleanupStartup({ ...c.input, auditLogPath: join(c.root, "outside-audit.jsonl") }),
    "CLEANUP_AUDIT_PATH_UNSAFE",
  );
});

test("CleanupAuditLog fsync 卡死：BoundedCleanupAudit 有界失败且 auditOk 永久 false", { skip: !LINUX }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "c2b22b2-audit-bound-"));
  chmodSync(root, 0o700);
  const auditDir = join(root, "audit");
  mkdirSync(auditDir, { mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = await CleanupAuditLog.open({
    trustedRuntimeRoot: root,
    auditLogPath: join(auditDir, "cleanup-audit.jsonl"),
    platform: "linux",
    syncFile: () => new Promise<void>(() => { /* 永不完全 */ }),
  });
  const bounded = new BoundedCleanupAudit(log, 200);
  const started = Date.now();
  const result = await bounded.append({ action: "cleanup_start" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "AUDIT_APPEND_TIMEOUT");
  assert.ok(Date.now() - started < 2_000);
  assert.equal(bounded.auditOk, false);
  assert.equal(bounded.failureCount >= 1, true);

  // 超时后必须短路上层调用：不等待 200ms 超时，也不向挂起的底层 log 再排事件。
  const secondStarted = Date.now();
  const second = await bounded.append({ action: "cleanup_summary" });
  assert.equal(second.ok, false);
  assert.equal(second.code, "AUDIT_APPEND_TIMEOUT");
  assert.ok(Date.now() - secondStarted < 100, "timed-out audit must reject new appends immediately");
  assert.equal(log.eventCount, 0);
  // 不等待 close：底层 append tail 故意永久挂起；进程退出时丢弃 fd，绝不影响终态判定。
});

test("BoundedCleanupAudit 超时后底层仍可完成：写入可能落盘但成功语义永久失败", { skip: !LINUX }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "c2b22b2-audit-late-"));
  chmodSync(root, 0o700);
  const auditDir = join(root, "audit");
  mkdirSync(auditDir, { mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = await CleanupAuditLog.open({
    trustedRuntimeRoot: root,
    auditLogPath: join(auditDir, "cleanup-audit.jsonl"),
    platform: "linux",
    syncFile: async () => {
      await new Promise((r) => setTimeout(r, 100));
    },
  });
  t.after(async () => { await log.close().catch(() => undefined); });
  const bounded = new BoundedCleanupAudit(log, 20);
  const first = await bounded.append({ action: "cleanup_start" });
  assert.equal(first.ok, false);
  assert.equal(first.code, "AUDIT_APPEND_TIMEOUT");

  // Promise 超时不等于 I/O 取消：底层 append 仍可能在超时后完成并计数。
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(log.eventCount, 1, "底层写入可以在超时后完成");
  assert.equal(bounded.auditOk, false, "sticky 失败不得被迟到完成翻成成功");
  const second = await bounded.append({ action: "cleanup_summary" });
  assert.equal(second.ok, false);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(log.eventCount, 1, "超时后新 append 必须被短路，不再写底层");
});
