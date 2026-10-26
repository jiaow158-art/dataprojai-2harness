// S4-B2-C1：SandboxContainerReaper 的无 Docker 单元测试。
// 真实 Docker 集成由独立隔离红队脚本执行；本文件只注入 fake runDocker。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SandboxContainerReaper,
  type DockerRunResult,
  type DockerRunner,
} from "./sandbox-container-reaper.ts";

const IMG = `sha256:${"a".repeat(64)}`;
const IMG_OTHER = `sha256:${"b".repeat(64)}`;
const CID = "a".repeat(12);
const CID2 = "b".repeat(12);
const RUN = "run-reaper-test";
const ATTEMPT = 1;
const NAME = `/${RUN}-a${ATTEMPT}-4242`;

interface FakeConfig {
  ps?: DockerRunResult;
  inspect?: DockerRunResult | ((id: string) => DockerRunResult);
  stop?: DockerRunResult;
  rm?: DockerRunResult;
  rmForce?: DockerRunResult;
  finalInspect?: DockerRunResult;
  psGate?: Promise<void>;
  onPs?: () => void;
}

function makeFake(config: FakeConfig = {}): { run: DockerRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: DockerRunner = async (args) => {
    calls.push([...args]);
    if (args[0] === "ps") {
      config.onPs?.();
      if (config.psGate) await config.psGate;
      return config.ps ?? { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "inspect" && args[2] === "{{.Id}}") {
      return config.finalInspect ?? { code: 1, stdout: "", stderr: "Error: No such object" };
    }
    if (args[0] === "inspect") {
      if (typeof config.inspect === "function") return config.inspect(args[3]);
      return config.inspect ?? {
        code: 0,
        stdout: JSON.stringify({
          id: CID,
          name: NAME,
          image: "dataplat-script:m0",
          image_id: IMG,
          labels: {
            "com.dpit.gateway.managed": "true",
            "com.dpit.gateway.task.run_id": RUN,
            "com.dpit.gateway.task.attempt": String(ATTEMPT),
          },
          state: "running",
        }),
        stderr: "",
      };
    }
    if (args[0] === "stop") return config.stop ?? { code: 0, stdout: CID, stderr: "" };
    if (args[0] === "rm" && args[1] === "-f") return config.rmForce ?? config.rm ?? { code: 0, stdout: CID, stderr: "" };
    if (args[0] === "rm") return config.rm ?? { code: 0, stdout: CID, stderr: "" };
    throw new Error(`unexpected docker args: ${args.join(" ")}`);
  };
  return { run, calls };
}

function tempReaper(config: FakeConfig = {}, trustedImageId = IMG): {
  reaper: SandboxContainerReaper;
  calls: string[][];
  root: string;
  trustedRuntimeRoot: string;
  cleanupLockDir: string;
  auditLogPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), "reaper-c1-"));
  chmodSync(root, 0o700);
  const cleanupLockDir = join(root, "cleanup-locks");
  mkdirSync(cleanupLockDir, { recursive: true, mode: 0o700 });
  chmodSync(cleanupLockDir, 0o700);
  const auditLogPath = join(root, "audit", "cleanup.jsonl");
  const fake = makeFake(config);
  const reaper = new SandboxContainerReaper({
    trustedImageId,
    trustedRuntimeRoot: root,
    cleanupLockDir,
    auditLogPath,
    stopTimeoutSec: 5,
    runDocker: fake.run,
  });
  return { reaper, calls: fake.calls, root, trustedRuntimeRoot: root, cleanupLockDir, auditLogPath };
}

function inspectWith(overrides: Record<string, any>): DockerRunResult {
  const labels = overrides.labels ?? {
    "com.dpit.gateway.managed": "true",
    "com.dpit.gateway.task.run_id": RUN,
    "com.dpit.gateway.task.attempt": String(ATTEMPT),
  };
  return {
    code: 0,
    stdout: JSON.stringify({
      id: CID,
      name: NAME,
      image: "dataplat-script:m0",
      image_id: IMG,
      labels,
      state: "running",
      ...overrides,
    }),
    stderr: "",
  };
}

test("正常 managed 容器：精确查询 → inspect → stop → rm → 消失确认", async () => {
  const ctx = tempReaper({ ps: { code: 0, stdout: `${CID}\n`, stderr: "" } });
  try {
    const r = await ctx.reaper.cleanup({ runId: RUN, attempt: ATTEMPT });
    assert.equal(r.ok, true);
    assert.equal(r.busy, false);
    assert.equal(r.found, 1);
    assert.deepEqual(r.cleaned, [CID]);
    assert.deepEqual(r.stopped, [CID]);
    assert.deepEqual(r.forced, []);
    assert.deepEqual(r.mismatches, []);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(ctx.calls.map((a) => a[0]), ["ps", "inspect", "stop", "rm", "inspect"]);
    const ps = ctx.calls[0]!;
    assert.ok(ps.includes("label=com.dpit.gateway.managed=true"));
    assert.ok(ps.includes(`label=com.dpit.gateway.task.run_id=${RUN}`));
    assert.ok(ps.includes(`label=com.dpit.gateway.task.attempt=${ATTEMPT}`));
    assert.ok(!ps.some((a) => a.startsWith("name=")), "不得用 name 前缀作为候选选择器");
    assert.ok(existsSync(ctx.auditLogPath));
    assert.ok(readFileSync(ctx.auditLogPath, "utf8").includes('"action":"cleanup"'));
    assert.equal(existsSync(join(ctx.cleanupLockDir, `${RUN}-a${ATTEMPT}.reaper.lock`)), false);
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

function secureReaperAt(root: string, lockDir: string, config: FakeConfig = {}): {
  reaper: SandboxContainerReaper;
  calls: string[][];
  auditLogPath: string;
} {
  const fake = makeFake(config);
  const auditLogPath = join(root, "audit.jsonl");
  const reaper = new SandboxContainerReaper({
    trustedImageId: IMG,
    trustedRuntimeRoot: root,
    cleanupLockDir: lockDir,
    auditLogPath,
    runDocker: fake.run,
  });
  return { reaper, calls: fake.calls, auditLogPath };
}

test("probeActive/cleanup：deadline 已过不启动新的 docker 命令", async () => {
  const ctx = tempReaper({ ps: { code: 0, stdout: `${CID}\n`, stderr: "" } });
  try {
    const probe = await ctx.reaper.probeActive(
      { runId: RUN, attempt: ATTEMPT },
      { deadlineAt: Date.now() - 1 },
    );
    assert.equal(probe.ok, false);
    assert.equal(probe.reason, "CLEANUP_TIME_BUDGET_EXCEEDED");
    assert.equal(ctx.calls.length, 0);

    const cleanup = await ctx.reaper.cleanup(
      { runId: RUN, attempt: ATTEMPT },
      { deadlineAt: Date.now() - 1 },
    );
    assert.equal(cleanup.ok, false);
    assert.equal(cleanup.found, 0);
    assert.equal(ctx.calls.length, 0);
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("probeActive：有效运行中容器 active=1，只读不删除", async () => {
  const ctx = tempReaper({ ps: { code: 0, stdout: `${CID}\n`, stderr: "" } });
  try {
    const r = await ctx.reaper.probeActive({ runId: RUN, attempt: ATTEMPT });
    assert.equal(r.ok, true);
    assert.equal(r.active, 1);
    assert.equal(r.mismatches, 0);
    assert.equal(r.containers.length, 1);
    assert.deepEqual(ctx.calls.map((a) => a[0]), ["ps", "inspect"]);
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("probeActive：无运行中容器 active=0", async () => {
  const ctx = tempReaper({ ps: { code: 0, stdout: "", stderr: "" } });
  try {
    const r = await ctx.reaper.probeActive({ runId: RUN, attempt: ATTEMPT });
    assert.equal(r.ok, true);
    assert.equal(r.active, 0);
    assert.deepEqual(ctx.calls.map((a) => a[0]), ["ps"]);
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("probeActive：docker ps 失败 → ok=false，绝不当无容器", async () => {
  const ctx = tempReaper({ ps: { code: 1, stdout: "", stderr: "docker daemon down" } });
  try {
    const r = await ctx.reaper.probeActive({ runId: RUN, attempt: ATTEMPT });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "DOCKER_QUERY_FAILED");
    assert.equal(r.active, 0);
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("probeActive：所有权/镜像不匹配 → ok=false", async () => {
  const ctx = tempReaper({
    ps: { code: 0, stdout: `${CID}\n`, stderr: "" },
    inspect: inspectWith({ image_id: IMG_OTHER }),
  });
  try {
    const r = await ctx.reaper.probeActive({ runId: RUN, attempt: ATTEMPT });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "OWNERSHIP_MISMATCH");
    assert.equal(r.mismatches, 1);
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("真实 Docker：probeActive 识别本 attempt 容器，cleanup 精确回收", async () => {
  let imageId: string;
  try {
    imageId = execFileSync("docker", ["image", "inspect", "dataplat-script:m0", "--format", "{{.Id}}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return; // 无 Docker/隔离镜像时跳过（本地 CI 环境不强制）
  }
  const root = mkdtempSync(join(tmpdir(), "reaper-real-"));
  const lockDir = join(root, "cleanup-locks");
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  chmodSync(lockDir, 0o700);
  const runId = "run-c2b22b-real";
  const attempt = 1;
  const name = `${runId}-a${attempt}-${Date.now()}`;
  const auditLogPath = join(root, "audit", "cleanup.jsonl");
  const reaper = new SandboxContainerReaper({
    trustedImageId: imageId,
    trustedRuntimeRoot: root,
    cleanupLockDir: lockDir,
    auditLogPath,
    stopTimeoutSec: 5,
  });
  try {
    execFileSync("docker", [
      "run", "-d", "--name", name,
      "--label", "com.dpit.gateway.managed=true",
      "--label", `com.dpit.gateway.task.run_id=${runId}`,
      "--label", `com.dpit.gateway.task.attempt=${attempt}`,
      "--network", "none",
      "--read-only",
      "--user", "65534:65534",
      "dataplat-script:m0",
      "python3", "-c", "import time; time.sleep(30)",
    ], { stdio: "ignore" });

    let probe = await reaper.probeActive({ runId, attempt });
    for (let i = 0; i < 20 && probe.active === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
      probe = await reaper.probeActive({ runId, attempt });
    }
    assert.equal(probe.ok, true);
    assert.equal(probe.active, 1);

    const cleaned = await reaper.cleanup({ runId, attempt });
    assert.equal(cleaned.ok, true);
    assert.equal(cleaned.found, 1);
    assert.equal(cleaned.cleaned.length, 1);
    assert.throws(() => execFileSync("docker", ["inspect", "--format", "{{.Id}}", name], { stdio: "ignore" }));
  } finally {
    try {
      execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    } catch {
      /* already removed */
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanupLockDir symlink 拒绝，且不调用 Docker", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "reaper-symlink-"));
  try {
    chmodSync(root, 0o700);
    const real = join(root, "real-lock");
    mkdirSync(real, { mode: 0o700 });
    chmodSync(real, 0o700);
    const link = join(root, "link-lock");
    symlinkSync(real, link);
    const ctx = secureReaperAt(root, link);
    const r = await ctx.reaper.cleanup({ runId: RUN, attempt: ATTEMPT });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "LOCK_DIR_UNSAFE");
    assert.equal(ctx.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanupLockDir 越出 trustedRuntimeRoot 拒绝", async () => {
  const root = mkdtempSync(join(tmpdir(), "reaper-root-"));
  const outside = mkdtempSync(join(tmpdir(), "reaper-outside-"));
  try {
    chmodSync(root, 0o700);
    chmodSync(outside, 0o700);
    const ctx = secureReaperAt(root, outside);
    const r = await ctx.reaper.cleanup({ runId: RUN, attempt: ATTEMPT });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "LOCK_DIR_OUTSIDE_TRUSTED_ROOT");
    assert.equal(ctx.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("cleanupLockDir 错误属主/不安全根拒绝", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "reaper-owner-"));
  try {
    chmodSync(root, 0o700);
    const fake = makeFake();
    // "/" is root-owned and not 0700; audit remains in the isolated temp root.
    const reaper = new SandboxContainerReaper({
      trustedImageId: IMG,
      trustedRuntimeRoot: "/",
      cleanupLockDir: "/",
      auditLogPath: join(root, "audit.jsonl"),
      runDocker: fake.run,
    });
    const r = await reaper.cleanup({ runId: RUN, attempt: ATTEMPT });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "LOCK_DIR_UNSAFE");
    assert.equal(fake.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanupLockDir 不安全权限拒绝", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "reaper-mode-"));
  try {
    chmodSync(root, 0o700);
    const lockDir = join(root, "unsafe-lock");
    mkdirSync(lockDir, { mode: 0o755 });
    chmodSync(lockDir, 0o755);
    const ctx = secureReaperAt(root, lockDir);
    const r = await ctx.reaper.cleanup({ runId: RUN, attempt: ATTEMPT });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "LOCK_DIR_UNSAFE");
    assert.equal(ctx.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanupLockDir 缺失 fail-closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "reaper-missing-"));
  try {
    chmodSync(root, 0o700);
    const ctx = secureReaperAt(root, join(root, "not-created"));
    const r = await ctx.reaper.cleanup({ runId: RUN, attempt: ATTEMPT });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "LOCK_DIR_INVALID");
    assert.equal(ctx.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("已存在 lock → CLEANUP_BUSY；stale lock 保留且不调用 Docker", async () => {
  const ctx = tempReaper();
  try {
    const lockPath = join(ctx.cleanupLockDir, `${RUN}-a${ATTEMPT}.reaper.lock`);
    writeFileSync(lockPath, "stale-owner-pid\n", { mode: 0o600 });
    const r = await ctx.reaper.cleanup({ runId: RUN, attempt: ATTEMPT });
    assert.equal(r.ok, false);
    assert.equal(r.busy, true);
    assert.equal(r.reason, "CLEANUP_BUSY");
    assert.equal(ctx.calls.length, 0);
    assert.equal(readFileSync(lockPath, "utf8"), "stale-owner-pid\n");
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("lock 路径被替换：不误删新文件，cleanup 不报成功", async () => {
  let ctx!: ReturnType<typeof tempReaper>;
  let lockPath = "";
  ctx = tempReaper({
    ps: { code: 0, stdout: "", stderr: "" },
    onPs: () => {
      lockPath = join(ctx.cleanupLockDir, `${RUN}-a${ATTEMPT}.reaper.lock`);
      unlinkSync(lockPath);
      writeFileSync(lockPath, "replacement-lock\n", { mode: 0o600 });
    },
  });
  try {
    const r = await ctx.reaper.cleanup({ runId: RUN, attempt: ATTEMPT });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "LOCK_INTEGRITY");
    assert.equal(readFileSync(lockPath, "utf8"), "replacement-lock\n");
    assert.ok(ctx.auditLogPath && readFileSync(ctx.auditLogPath, "utf8").includes("LOCK_INTEGRITY"));
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("stop 成功后 --rm 已移除容器：rm not-found 按成功且 forced=false", async () => {
  const ctx = tempReaper({
    ps: { code: 0, stdout: `${CID}\n`, stderr: "" },
    stop: { code: 0, stdout: CID, stderr: "" },
    rm: { code: 1, stdout: "", stderr: "Error: No such container: " + CID },
    rmForce: { code: 0, stdout: CID, stderr: "" },
  });
  try {
    const r = await ctx.reaper.cleanup({ runId: RUN, attempt: ATTEMPT });
    assert.equal(r.ok, true);
    assert.deepEqual(r.stopped, [CID]);
    assert.deepEqual(r.forced, []);
    assert.deepEqual(r.cleaned, [CID]);
    assert.equal(r.warnings.length, 0);
    assert.equal(ctx.calls.some((a) => a[0] === "rm" && a[1] === "-f"), false);
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("无候选容器：查询成功空结果 = 幂等成功，不 inspect/stop/rm", async () => {
  const ctx = tempReaper({ ps: { code: 0, stdout: "", stderr: "" } });
  try {
    const r = await ctx.reaper.cleanup({ runId: RUN, attempt: ATTEMPT });
    assert.equal(r.ok, true);
    assert.equal(r.found, 0);
    assert.deepEqual(ctx.calls.map((a) => a[0]), ["ps"]);
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("docker ps 查询失败不能当作不存在", async () => {
  const ctx = tempReaper({ ps: { code: 1, stdout: "", stderr: "daemon unavailable" } });
  try {
    const r = await ctx.reaper.cleanup({ runId: RUN, attempt: ATTEMPT });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "DOCKER_QUERY_FAILED");
    assert.equal(r.found, 0);
    assert.deepEqual(ctx.calls.map((a) => a[0]), ["ps"]);
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("inspect 失败：拒绝删除", async () => {
  const ctx = tempReaper({
    ps: { code: 0, stdout: `${CID}\n`, stderr: "" },
    inspect: { code: 1, stdout: "", stderr: "daemon inspect failure" },
  });
  try {
    const r = await ctx.reaper.cleanup({ runId: RUN, attempt: ATTEMPT });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "INSPECT_FAILED");
    assert.ok(!ctx.calls.some((a) => a[0] === "stop" || a[0] === "rm"));
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("inspect 返回 invalid JSON：拒绝删除", async () => {
  const ctx = tempReaper({
    ps: { code: 0, stdout: `${CID}\n`, stderr: "" },
    inspect: { code: 0, stdout: "{not-json", stderr: "" },
  });
  try {
    const r = await ctx.reaper.cleanup({ runId: RUN, attempt: ATTEMPT });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "INSPECT_FAILED");
    assert.ok(!ctx.calls.some((a) => a[0] === "stop" || a[0] === "rm"));
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("run_id 不匹配：OWNERSHIP_MISMATCH，不删除", async () => {
  const ctx = tempReaper({
    ps: { code: 0, stdout: `${CID}\n`, stderr: "" },
    inspect: inspectWith({
      labels: {
        "com.dpit.gateway.managed": "true",
        "com.dpit.gateway.task.run_id": "run-other",
        "com.dpit.gateway.task.attempt": String(ATTEMPT),
      },
    }),
  });
  try {
    const r = await ctx.reaper.cleanup({ runId: RUN, attempt: ATTEMPT });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "OWNERSHIP_MISMATCH");
    assert.ok(r.mismatches.some((m) => m.includes("label.run_id")));
    assert.ok(!ctx.calls.some((a) => a[0] === "stop" || a[0] === "rm"));
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("attempt 不匹配：OWNERSHIP_MISMATCH，不删除", async () => {
  const ctx = tempReaper({
    ps: { code: 0, stdout: `${CID}\n`, stderr: "" },
    inspect: inspectWith({
      name: `/${RUN}-a2-4242`,
      labels: {
        "com.dpit.gateway.managed": "true",
        "com.dpit.gateway.task.run_id": RUN,
        "com.dpit.gateway.task.attempt": "2",
      },
    }),
  });
  try {
    const r = await ctx.reaper.cleanup({ runId: RUN, attempt: ATTEMPT });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "OWNERSHIP_MISMATCH");
    assert.ok(r.mismatches.some((m) => m.includes("label.attempt")));
    assert.ok(!ctx.calls.some((a) => a[0] === "stop" || a[0] === "rm"));
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("managed/label 缺失或伪造：OWNERSHIP_MISMATCH", async () => {
  const ctx = tempReaper({
    ps: { code: 0, stdout: `${CID}\n`, stderr: "" },
    inspect: inspectWith({
      labels: {
        "com.dpit.gateway.task.run_id": RUN,
        "com.dpit.gateway.task.attempt": String(ATTEMPT),
      },
    }),
  });
  try {
    const r = await ctx.reaper.cleanup({ runId: RUN, attempt: ATTEMPT });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "OWNERSHIP_MISMATCH");
    assert.ok(r.mismatches.some((m) => m.includes("label.managed")));
    assert.ok(!ctx.calls.some((a) => a[0] === "stop" || a[0] === "rm"));
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("镜像 ID 不匹配（tag 名称相同也不可信）：拒绝删除", async () => {
  const ctx = tempReaper({
    ps: { code: 0, stdout: `${CID}\n`, stderr: "" },
    inspect: inspectWith({ image_id: IMG_OTHER }),
  });
  try {
    const r = await ctx.reaper.cleanup({ runId: RUN, attempt: ATTEMPT });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "OWNERSHIP_MISMATCH");
    assert.ok(r.mismatches.some((m) => m.includes("image_id")));
    assert.ok(!ctx.calls.some((a) => a[0] === "stop" || a[0] === "rm"));
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("容器名不匹配：拒绝删除", async () => {
  const ctx = tempReaper({
    ps: { code: 0, stdout: `${CID}\n`, stderr: "" },
    inspect: inspectWith({ name: `/${RUN}-a1-notnumeric` }),
  });
  try {
    const r = await ctx.reaper.cleanup({ runId: RUN, attempt: ATTEMPT });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "OWNERSHIP_MISMATCH");
    assert.ok(r.mismatches.some((m) => m.includes("container_name")));
    assert.ok(!ctx.calls.some((a) => a[0] === "stop" || a[0] === "rm"));
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("旧 attempt 查询参数精确，不会触碰新 attempt", async () => {
  const ctx = tempReaper({
    ps: { code: 0, stdout: "", stderr: "" },
  }, IMG);
  try {
    const r = await ctx.reaper.cleanup({ runId: RUN, attempt: 2 });
    assert.equal(r.ok, true);
    const ps = ctx.calls[0]!;
    assert.ok(ps.includes(`label=com.dpit.gateway.task.attempt=2`));
    assert.ok(!ps.some((a) => a.endsWith("attempt=1")));
    assert.ok(!ps.some((a) => a.startsWith("name=")));
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("stop 失败后 force remove 成功：清理成功并记录 warning/forced", async () => {
  const ctx = tempReaper({
    ps: { code: 0, stdout: `${CID}\n`, stderr: "" },
    stop: { code: 1, stdout: "", stderr: "cannot stop" },
    rmForce: { code: 0, stdout: CID, stderr: "" },
  });
  try {
    const r = await ctx.reaper.cleanup({ runId: RUN, attempt: ATTEMPT });
    assert.equal(r.ok, true);
    assert.deepEqual(r.stopped, []);
    assert.deepEqual(r.forced, [CID]);
    assert.deepEqual(r.cleaned, [CID]);
    assert.equal(r.warnings.length, 1);
    assert.equal(r.errors.length, 0);
    const calls = ctx.calls.map((a) => a.slice(0, 2).join(" "));
    assert.ok(calls.includes("stop --time"));
    assert.ok(calls.includes("rm -f"));
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("stop/force remove 均失败且容器仍存在：cleanup failure", async () => {
  const ctx = tempReaper({
    ps: { code: 0, stdout: `${CID}\n`, stderr: "" },
    stop: { code: 1, stdout: "", stderr: "cannot stop" },
    rmForce: { code: 1, stdout: "", stderr: "cannot remove" },
    finalInspect: { code: 0, stdout: CID, stderr: "" },
  });
  try {
    const r = await ctx.reaper.cleanup({ runId: RUN, attempt: ATTEMPT });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "CLEANUP_FAILED");
    assert.ok(r.errors.some((e) => e.includes("still exists")));
    const audit = readFileSync(ctx.auditLogPath, "utf8");
    assert.ok(audit.includes('"phase":"summary"'));
    assert.ok(audit.includes('"ok":false'));
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("候选在 inspect 阶段消失：按幂等成功处理", async () => {
  const ctx = tempReaper({
    ps: { code: 0, stdout: `${CID}\n`, stderr: "" },
    inspect: { code: 1, stdout: "", stderr: "Error: No such object" },
  });
  try {
    const r = await ctx.reaper.cleanup({ runId: RUN, attempt: ATTEMPT });
    assert.equal(r.ok, true);
    assert.deepEqual(r.cleaned, []);
    assert.ok(!ctx.calls.some((a) => a[0] === "stop" || a[0] === "rm"));
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("两个 reaper 并发：per-attempt lock 阻止第二个执行", async () => {
  let releasePs!: () => void;
  let psStarted!: () => void;
  const started = new Promise<void>((r) => { psStarted = r; });
  const gate = new Promise<void>((r) => { releasePs = r; });
  const ctx = tempReaper({
    ps: { code: 0, stdout: "", stderr: "" },
    psGate: gate,
    onPs: psStarted,
  });
  try {
    const firstPromise = ctx.reaper.cleanup({ runId: RUN, attempt: ATTEMPT });
    await started;
    const second = await ctx.reaper.cleanup({ runId: RUN, attempt: ATTEMPT });
    assert.equal(second.busy, true);
    assert.equal(second.ok, false);
    assert.equal(second.reason, "CLEANUP_BUSY");
    releasePs();
    const first = await firstPromise;
    assert.equal(first.ok, true);
    assert.equal(first.busy, false);
  } finally {
    releasePs?.();
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("非法 target / 非法可信镜像：fail closed 且不调用 docker", async () => {
  const root = mkdtempSync(join(tmpdir(), "reaper-c1-bad-"));
  try {
    const calls: string[][] = [];
    const run: DockerRunner = async (args) => { calls.push([...args]); return { code: 0, stdout: "", stderr: "" }; };
    mkdirSync(join(root, "locks"), { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    chmodSync(join(root, "locks"), 0o700);
    const reaper = new SandboxContainerReaper({
      trustedImageId: "not-a-sha",
      trustedRuntimeRoot: root,
      cleanupLockDir: join(root, "locks"),
      auditLogPath: join(root, "audit.jsonl"),
      runDocker: run,
    });
    const badTarget = await reaper.cleanup({ runId: "../bad", attempt: 1 });
    assert.equal(badTarget.ok, false);
    assert.equal(badTarget.reason, "INVALID_TARGET");
    assert.equal(calls.length, 0);
    const badImage = await reaper.cleanup({ runId: RUN, attempt: 1 });
    assert.equal(badImage.ok, false);
    assert.equal(badImage.reason, "NO_TRUSTED_IMAGE");
    assert.equal(calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("audit 不含 Key/Token/脚本内容", async () => {
  const ctx = tempReaper({
    ps: { code: 0, stdout: `${CID}\n`, stderr: "" },
    stop: { code: 1, stdout: "", stderr: "DEEPSEEK_API_KEY=super-secret AUTH_TOKEN=tok script: print('secret')" },
    rmForce: { code: 0, stdout: CID, stderr: "" },
  });
  try {
    const r = await ctx.reaper.cleanup({ runId: RUN, attempt: ATTEMPT });
    assert.equal(r.ok, true);
    const audit = readFileSync(ctx.auditLogPath, "utf8");
    assert.ok(!audit.includes("super-secret"));
    assert.ok(!audit.includes("tok"));
    assert.ok(!audit.includes("print('secret')"));
    assert.ok(!audit.includes("DEEPSEEK_API_KEY="));
    assert.ok(audit.includes("docker stop failed"));
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});
