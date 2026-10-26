// S4-B2-C2-B1：Linux ACL 只读检查；不执行恢复、不修改 ACL。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { checkAclCleanup, type AclCleanupTarget } from "./acl-cleanup-checker.ts";

const LINUX = process.platform === "linux";
const HAS_ACL = spawnSync("getfacl", ["--version"], { stdio: "ignore" }).status === 0
  && spawnSync("setfacl", ["--version"], { stdio: "ignore" }).status === 0;

interface Setup {
  base: string;
  target: AclCleanupTarget;
  key: string;
}

function setup(): Setup {
  const base = mkdtempSync(join(tmpdir(), "c2b1-acl-"));
  const work = join(base, "work");
  const results = join(base, "results");
  const assets = join(base, "assets");
  const state = join(base, "state");
  for (const d of [work, results, assets, state]) {
    mkdirSync(d, { mode: 0o700 });
    chmodSync(d, 0o700);
  }
  writeFileSync(join(work, "answer.py"), "print(1)\n", { mode: 0o600 });
  const workReal = realpathSync(work);
  const key = createHash("sha256").update(workReal).digest("hex").slice(0, 16);
  return {
    base,
    key,
    target: { workdir: work, resultsDir: results, assetsDir: assets, aclStateDir: state },
  };
}

test("Linux 无备份、无 65534：passed，actual getfacl 证据", { skip: !LINUX }, async () => {
  const s = setup();
  try {
    const r = await checkAclCleanup(s.target);
    assert.equal(r.status, "passed");
    assert.equal(r.required, true);
    assert.equal(r.reason, "ACL_NO_65534_RESIDUAL");
    assert.equal(r.evidence.aclStateFiles, 0);
    assert.equal(r.evidence.aclResidualEntries, 0);
    assert.equal(r.evidence.aclVerifiedWith, "getfacl");
    assert.equal(r.evidence.platform, "linux");
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("空闲 .lock 不算残留；无 .bak/.snap 仍 passed", { skip: !LINUX }, async () => {
  const s = setup();
  try {
    writeFileSync(join(s.target.aclStateDir, `${s.key}.lock`), "idle\n", { mode: 0o600 });
    const r = await checkAclCleanup(s.target);
    assert.equal(r.status, "passed");
    assert.equal(r.reason, "ACL_NO_65534_RESIDUAL");
    assert.equal(r.evidence.aclStateFiles, 0);
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("存在 .acl.bak → pending（C3 restore-only 未实现），不做恢复", { skip: !LINUX }, async () => {
  const s = setup();
  try {
    writeFileSync(join(s.target.aclStateDir, `${s.key}.acl.bak`), "backup\n", { mode: 0o600 });
    let scanned = false;
    const r = await checkAclCleanup(s.target, {
      runGetfacl: async () => { scanned = true; return { code: 0, stdout: "", stderr: "" }; },
    });
    assert.equal(r.status, "pending");
    assert.equal(r.required, true);
    assert.equal(r.reason, "ACL_RESTORE_PENDING_C3");
    assert.equal(r.evidence.aclStateFiles, 1);
    assert.equal(scanned, false, "有备份时不应假装完成扫描/恢复");
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("存在 .acl.snap → pending", { skip: !LINUX }, async () => {
  const s = setup();
  try {
    writeFileSync(join(s.target.aclStateDir, `${s.key}.acl.snap`), "snap\n", { mode: 0o600 });
    const r = await checkAclCleanup(s.target);
    assert.equal(r.status, "pending");
    assert.equal(r.reason, "ACL_RESTORE_PENDING_C3");
    assert.equal(r.evidence.aclStateFiles, 1);
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("实际 65534 残留 → failed", { skip: !LINUX || !HAS_ACL }, async () => {
  const s = setup();
  try {
    execFileSync("setfacl", ["-m", "u:65534:r--", join(s.target.workdir, "answer.py")]);
    const r = await checkAclCleanup(s.target);
    assert.equal(r.status, "failed");
    assert.equal(r.reason, "ACL_RESIDUAL_GRANT");
    assert.ok((r.evidence.aclResidualEntries ?? 0) > 0);
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("状态目录权限非 0700 → failed", { skip: !LINUX }, async () => {
  const s = setup();
  try {
    chmodSync(s.target.aclStateDir, 0o755);
    const r = await checkAclCleanup(s.target);
    assert.equal(r.status, "failed");
    assert.equal(r.reason, "ACL_STATE_UNSAFE");
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("状态目录为 symlink → failed", { skip: !LINUX }, async () => {
  const s = setup();
  try {
    const real = join(s.base, "real-state");
    mkdirSync(real, { mode: 0o700 });
    chmodSync(real, 0o700);
    const link = join(s.base, "state-link");
    symlinkSync(real, link);
    const r = await checkAclCleanup({ ...s.target, aclStateDir: link });
    assert.equal(r.status, "failed");
    assert.equal(r.reason, "ACL_STATE_UNSAFE");
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("状态目录位于可写 workdir 内 → failed", { skip: !LINUX }, async () => {
  const s = setup();
  try {
    const inside = join(s.target.workdir, "state");
    mkdirSync(inside, { mode: 0o700 });
    chmodSync(inside, 0o700);
    const r = await checkAclCleanup({ ...s.target, aclStateDir: inside });
    assert.equal(r.status, "failed");
    assert.equal(r.reason, "ACL_STATE_UNSAFE");
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test(".lock 为 symlink → failed", { skip: !LINUX }, async () => {
  const s = setup();
  try {
    const target = join(s.base, "lock-target");
    writeFileSync(target, "x", { mode: 0o600 });
    symlinkSync(target, join(s.target.aclStateDir, `${s.key}.lock`));
    const r = await checkAclCleanup(s.target);
    assert.equal(r.status, "failed");
    assert.equal(r.reason, "ACL_STATE_UNSAFE");
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test(".acl.bak 为 symlink → failed，不按 pending 处理", { skip: !LINUX }, async () => {
  const s = setup();
  try {
    const target = join(s.base, "bak-target");
    writeFileSync(target, "x", { mode: 0o600 });
    symlinkSync(target, join(s.target.aclStateDir, `${s.key}.acl.bak`));
    const r = await checkAclCleanup(s.target);
    assert.equal(r.status, "failed");
    assert.equal(r.reason, "ACL_STATE_UNSAFE");
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("workdir 缺失 → failed", { skip: !LINUX }, async () => {
  const s = setup();
  try {
    const r = await checkAclCleanup({ ...s.target, workdir: join(s.base, "missing-work") });
    assert.equal(r.status, "failed");
    assert.equal(r.reason, "ACL_WORKDIR_MISSING");
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("getfacl 不可用 → failed，不当作 clean", { skip: !LINUX }, async () => {
  const s = setup();
  try {
    const r = await checkAclCleanup(s.target, { getfaclPath: join(s.base, "missing-getfacl") });
    assert.equal(r.status, "failed");
    assert.equal(r.reason, "ACL_GETFACL_UNAVAILABLE");
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("getfacl 非零退出 → failed", { skip: !LINUX }, async () => {
  const s = setup();
  try {
    const r = await checkAclCleanup(s.target, {
      runGetfacl: async () => ({ code: 2, stdout: "", stderr: "permission denied" }),
    });
    assert.equal(r.status, "failed");
    assert.equal(r.reason, "ACL_CHECK_FAILED");
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("状态目录不存在：没有备份仍可做实际 ACL 扫描", { skip: !LINUX }, async () => {
  const s = setup();
  try {
    const r = await checkAclCleanup({ ...s.target, aclStateDir: join(s.base, "no-state") });
    assert.equal(r.status, "passed");
    assert.equal(r.reason, "ACL_NO_65534_RESIDUAL");
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("扫描期间新出现 .acl.bak：必须 pending，不能只用初始快照判定", { skip: !LINUX }, async () => {
  const s = setup();
  const stateDir = join(s.base, "no-state-yet");
  try {
    let calls = 0;
    const r = await checkAclCleanup({ ...s.target, aclStateDir: stateDir }, {
      runGetfacl: async () => {
        if (calls++ === 0) {
          mkdirSync(stateDir, { mode: 0o700 });
          chmodSync(stateDir, 0o700);
          writeFileSync(join(stateDir, `${s.key}.acl.bak`), "backup\n", { mode: 0o600 });
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(r.status, "pending");
    assert.equal(r.reason, "ACL_RESTORE_PENDING_C3");
    assert.equal(r.evidence.aclStateFiles, 1);
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("扫描期间状态目录消失：不能当 clean", { skip: !LINUX }, async () => {
  const s = setup();
  try {
    let calls = 0;
    const r = await checkAclCleanup(s.target, {
      runGetfacl: async () => {
        if (calls++ === 0) rmSync(s.target.aclStateDir, { recursive: true, force: true });
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(r.status, "failed");
    assert.equal(r.reason, "ACL_STATE_CHANGED");
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("getfacl -P：不跟随任务树内 symlink 扫描外部 ACL", { skip: !LINUX || !HAS_ACL }, async () => {
  const s = setup();
  try {
    const outside = join(s.base, "outside");
    mkdirSync(outside, { mode: 0o700 });
    chmodSync(outside, 0o700);
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "x\n", { mode: 0o600 });
    execFileSync("setfacl", ["-m", "u:65534:r--", secret]);
    symlinkSync(outside, join(s.target.workdir, "outside-link"));
    const r = await checkAclCleanup(s.target);
    assert.equal(r.status, "passed");
    assert.equal(r.reason, "ACL_NO_65534_RESIDUAL");
    assert.equal(r.evidence.aclResidualEntries, 0);
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("Windows 规则 mock：ACL not_applicable，required=false，platform 依据", async () => {
  const bogus: AclCleanupTarget = {
    workdir: join(tmpdir(), "nonexistent-work"),
    resultsDir: join(tmpdir(), "nonexistent-results"),
    assetsDir: join(tmpdir(), "nonexistent-assets"),
    aclStateDir: join(tmpdir(), "nonexistent-state"),
  };
  const r = await checkAclCleanup(bogus, { platform: "win32" });
  assert.equal(r.status, "not_applicable");
  assert.equal(r.required, false);
  assert.equal(r.reason, "ACL_NOT_APPLICABLE_PLATFORM");
  assert.deepEqual(r.applicability, { basis: "platform", detail: "win32" });
  assert.equal(r.evidence.platform, "win32");
});

test("other 平台：pending，不无依据 N/A", async () => {
  const r = await checkAclCleanup({
    workdir: join(tmpdir(), "x-work"),
    resultsDir: join(tmpdir(), "x-results"),
    assetsDir: join(tmpdir(), "x-assets"),
    aclStateDir: join(tmpdir(), "x-state"),
  }, { platform: "aix" });
  assert.equal(r.status, "pending");
  assert.equal(r.required, true);
  assert.equal(r.reason, "ACL_PLATFORM_UNVERIFIABLE");
});
