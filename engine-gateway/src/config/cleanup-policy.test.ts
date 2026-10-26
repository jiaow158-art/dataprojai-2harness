// S4-B2-C2-B2-1：清理策略解析单测。
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CleanupPolicyError,
  resolveCleanupPolicy,
} from "./cleanup-policy.ts";

const WIN = process.platform === "win32";
const RUNTIME = "/srv/dpit/cleanup-test-runtime";
const ACL_STATE = "/srv/dpit/cleanup-test-acl";
const IMAGE = `sha256:${"a".repeat(64)}`;

function baseEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    GATEWAY_CLEANUP_MODE: "linux_isolated",
    DSH_PROFILE: "sdk-s4b",
    GATEWAY_CLEANUP_RUNTIME_ROOT: RUNTIME,
    SANDBOX_ACL_STATE_DIR: ACL_STATE,
    GATEWAY_CLEANUP_TRUSTED_IMAGE_ID: IMAGE,
    ...extra,
  };
}

function policyCode(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

test("默认 off：未配置时 Linux 不启用", () => {
  const p = resolveCleanupPolicy({ env: {}, platform: "linux" });
  assert.equal(p.mode, "off");
  assert.equal(p.reason, "default");
});

test("显式 off：不要求任何 Linux 清理配置", () => {
  const p = resolveCleanupPolicy({
    env: { GATEWAY_CLEANUP_MODE: "off" },
    platform: "linux",
  });
  assert.equal(p.mode, "off");
  assert.equal(p.reason, "explicit_off");
});

test("非法模式 fail-closed", () => {
  assert.equal(
    policyCode(() => resolveCleanupPolicy({ env: { GATEWAY_CLEANUP_MODE: "on" }, platform: "linux" })),
    "CLEANUP_MODE_INVALID",
  );
  assert.equal(
    policyCode(() => resolveCleanupPolicy({ env: { GATEWAY_CLEANUP_MODE: "LINUX_ISOLATED" }, platform: "linux" })),
    "CLEANUP_MODE_INVALID",
  );
});

test("Windows 无论配置什么都强制 off，且不校验 Linux 配置", () => {
  const p = resolveCleanupPolicy({
    platform: "win32",
    env: {
      GATEWAY_CLEANUP_MODE: "linux_isolated",
      DSH_PROFILE: "not-a-profile",
      GATEWAY_CLEANUP_RUNTIME_ROOT: "relative",
      SANDBOX_ACL_STATE_DIR: "relative",
      GATEWAY_CLEANUP_TRUSTED_IMAGE_ID: "bad",
    },
  });
  assert.equal(p.mode, "off");
  assert.equal(p.reason, "platform_win32");
  assert.equal(p.platform, "win32");
});

test("Windows 非法模式也不抛错", () => {
  const p = resolveCleanupPolicy({
    platform: "win32",
    env: { GATEWAY_CLEANUP_MODE: "not-a-mode" },
  });
  assert.equal(p.mode, "off");
});

test("非 Linux/Windows：默认 off，显式 linux_isolated 拒绝", () => {
  const off = resolveCleanupPolicy({ env: {}, platform: "darwin" });
  assert.equal(off.mode, "off");
  assert.equal(off.reason, "platform_unsupported");
  assert.equal(
    policyCode(() =>
      resolveCleanupPolicy({ env: { GATEWAY_CLEANUP_MODE: "linux_isolated" }, platform: "darwin" }),
    ),
    "CLEANUP_PLATFORM_UNSUPPORTED",
  );
});

test("Linux 非 sdk-s4b 不可启用（默认 sdk 与显式 sdk 都拒绝）", { skip: WIN }, () => {
  assert.equal(
    policyCode(() =>
      resolveCleanupPolicy({
        env: baseEnv({ DSH_PROFILE: undefined }),
        platform: "linux",
      }),
    ),
    "CLEANUP_PROFILE_REQUIRED",
  );
  assert.equal(
    policyCode(() =>
      resolveCleanupPolicy({
        env: baseEnv({ DSH_PROFILE: "sdk" }),
        platform: "linux",
      }),
    ),
    "CLEANUP_PROFILE_REQUIRED",
  );
});

test("合法配置：linux_isolated + sdk-s4b + 可信路径 + 镜像 ID", { skip: WIN }, () => {
  const p = resolveCleanupPolicy({ env: baseEnv(), platform: "linux" });
  assert.equal(p.mode, "linux_isolated");
  if (p.mode !== "linux_isolated") return;
  assert.equal(p.reason, "enabled");
  assert.equal(p.profile, "sdk-s4b");
  assert.equal(p.runtimeRoot, RUNTIME);
  assert.equal(p.aclStateDir, ACL_STATE);
  assert.equal(p.trustedImageId, IMAGE);
});

test("镜像 ID 大小写归一化", { skip: WIN }, () => {
  const p = resolveCleanupPolicy({
    env: baseEnv({ GATEWAY_CLEANUP_TRUSTED_IMAGE_ID: `SHA256:${"A".repeat(64)}` }),
    platform: "linux",
  });
  assert.equal(p.mode, "linux_isolated");
  if (p.mode !== "linux_isolated") return;
  assert.equal(p.trustedImageId, IMAGE);
});

test("可信运行根缺失/相对/根/过宽/落在 Temp 或仓库内均拒绝", { skip: WIN }, () => {
  const cases: Array<[NodeJS.ProcessEnv, string]> = [
    [baseEnv({ GATEWAY_CLEANUP_RUNTIME_ROOT: undefined }), "CLEANUP_RUNTIME_ROOT_INVALID"],
    [baseEnv({ GATEWAY_CLEANUP_RUNTIME_ROOT: "relative/runtime" }), "CLEANUP_RUNTIME_ROOT_INVALID"],
    [baseEnv({ GATEWAY_CLEANUP_RUNTIME_ROOT: "/" }), "CLEANUP_RUNTIME_ROOT_INVALID"],
    [baseEnv({ GATEWAY_CLEANUP_RUNTIME_ROOT: "/srv" }), "CLEANUP_RUNTIME_ROOT_INVALID"],
    [baseEnv({ GATEWAY_CLEANUP_RUNTIME_ROOT: join(tmpdir(), "cleanup-runtime") }), "CLEANUP_RUNTIME_ROOT_INVALID"],
    [baseEnv({ GATEWAY_CLEANUP_RUNTIME_ROOT: process.cwd() }), "CLEANUP_RUNTIME_ROOT_INVALID"],
  ];
  for (const [env, code] of cases) {
    assert.equal(policyCode(() => resolveCleanupPolicy({ env, platform: "linux" })), code, String(env.GATEWAY_CLEANUP_RUNTIME_ROOT));
  }
});

test("ACL 状态目录缺失/相对/根/落在 Temp 内均拒绝", { skip: WIN }, () => {
  const cases: Array<[NodeJS.ProcessEnv, string]> = [
    [baseEnv({ SANDBOX_ACL_STATE_DIR: undefined }), "CLEANUP_ACL_STATE_DIR_INVALID"],
    [baseEnv({ SANDBOX_ACL_STATE_DIR: "relative/acl" }), "CLEANUP_ACL_STATE_DIR_INVALID"],
    [baseEnv({ SANDBOX_ACL_STATE_DIR: "/" }), "CLEANUP_ACL_STATE_DIR_INVALID"],
    [baseEnv({ SANDBOX_ACL_STATE_DIR: join(tmpdir(), "acl-state") }), "CLEANUP_ACL_STATE_DIR_INVALID"],
  ];
  for (const [env, code] of cases) {
    assert.equal(policyCode(() => resolveCleanupPolicy({ env, platform: "linux" })), code, String(env.SANDBOX_ACL_STATE_DIR));
  }
});

test("运行根与 ACL 状态目录不可相同", { skip: WIN }, () => {
  assert.equal(
    policyCode(() =>
      resolveCleanupPolicy({
        env: baseEnv({ SANDBOX_ACL_STATE_DIR: RUNTIME }),
        platform: "linux",
      }),
    ),
    "CLEANUP_PATH_CONFLICT",
  );
});

test("可信镜像 ID 缺失/非 sha256/长度错误拒绝", { skip: WIN }, () => {
  for (const image of [undefined, "dataplat-script:m0", "sha256:abc", `sha256:${"g".repeat(64)}`]) {
    assert.equal(
      policyCode(() =>
        resolveCleanupPolicy({
          env: baseEnv({ GATEWAY_CLEANUP_TRUSTED_IMAGE_ID: image }),
          platform: "linux",
        }),
      ),
      "CLEANUP_TRUSTED_IMAGE_INVALID",
      String(image),
    );
  }
});

test("非法 DSH_PROFILE 由现有解析器 fail-closed", { skip: WIN }, () => {
  assert.throws(
    () =>
      resolveCleanupPolicy({
        env: baseEnv({ DSH_PROFILE: "../sdk" }),
        platform: "linux",
      }),
    /DSH_PROFILE/,
  );
});

test("CleanupPolicyError 带 [CONFIG] 前缀与 code", () => {
  try {
    resolveCleanupPolicy({ env: { GATEWAY_CLEANUP_MODE: "on" }, platform: "linux" });
    assert.fail("should throw");
  } catch (e) {
    assert.ok(e instanceof CleanupPolicyError);
    assert.equal((e as CleanupPolicyError).code, "CLEANUP_MODE_INVALID");
    assert.match((e as Error).message, /^\[CONFIG\]/);
  }
});
