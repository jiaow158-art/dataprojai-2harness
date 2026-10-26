// S4-B2-C2-B1：可信运行时根目录创建/校验。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertRootNotForbidden,
  assertRuntimeRootDepth,
  currentEffectiveGid,
  currentEffectiveUid,
  defaultForbiddenRoots,
  isSafeRuntimeDirectory,
  posixSecurityApplies,
  prepareTrustedRuntime,
  validateTrustedDirectory,
  type TrustedRuntimeError,
} from "./trusted-runtime.ts";

const WIN = process.platform === "win32";

function base(): string {
  return mkdtempSync(join(tmpdir(), "c2b1-trusted-"));
}

function code(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return (e as TrustedRuntimeError).code;
  }
}

async function asyncCode(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return (e as TrustedRuntimeError).code;
  }
}

test("创建 runtime/cleanup-locks/audit：0700、真实属主、幂等", { skip: WIN }, async () => {
  const b = base();
  try {
    const root = join(b, "runtime");
    const rt = await prepareTrustedRuntime({ root, forbiddenRoots: [] });
    assert.equal(rt.root, resolve(root));
    assert.equal(rt.cleanupLockDir, join(resolve(root), "cleanup-locks"));
    assert.equal(rt.auditDir, join(resolve(root), "audit"));
    assert.equal(rt.expectedUid, currentEffectiveUid());
    assert.equal(rt.expectedGid, currentEffectiveGid());
    for (const p of [rt.root, rt.cleanupLockDir, rt.auditDir]) {
      const st = lstatSync(p);
      assert.equal(st.isDirectory(), true);
      assert.equal(st.isSymbolicLink(), false);
      assert.equal(st.mode & 0o777, 0o700);
      assert.equal(st.uid, currentEffectiveUid());
      assert.equal(st.gid, currentEffectiveGid());
    }
    const again = await prepareTrustedRuntime({ root, forbiddenRoots: [] });
    assert.deepEqual(again, rt);
  } finally {
    rmSync(b, { recursive: true, force: true });
  }
});

test("缺失根且 create=false fail closed", async () => {
  const b = base();
  try {
    const c = await asyncCode(() =>
      prepareTrustedRuntime({ root: join(b, "missing"), create: false, forbiddenRoots: [] }),
    );
    assert.equal(c, "TRUSTED_DIR_MISSING");
  } finally {
    rmSync(b, { recursive: true, force: true });
  }
});

test("相对路径 / 文件系统根 / 过宽根拒绝", () => {
  assert.equal(code(() => assertRuntimeRootDepth("relative/runtime")), "ROOT_NOT_ABSOLUTE");
  assert.equal(code(() => assertRuntimeRootDepth("/")), "ROOT_TOO_BROAD");
  if (!WIN) {
    assert.equal(code(() => assertRuntimeRootDepth("/srv")), "ROOT_TOO_BROAD");
    assert.equal(code(() => assertRuntimeRootDepth("/srv/dpit")), "ROOT_TOO_BROAD");
  }
});

test("默认拒绝平台 Temp 树；显式 forbiddenRoots 生效", () => {
  assert.equal(code(() => assertRootNotForbidden(join(tmpdir(), "c2b1-x"), [tmpdir()])), "ROOT_FORBIDDEN");
  assert.equal(code(() => assertRootNotForbidden("/srv/dpit/runtime/gateway", [tmpdir()])), undefined);
  assert.equal(
    code(() => assertRootNotForbidden("/srv/dpit/apps/harness/runtime", ["/srv/dpit/apps/harness"])),
    "ROOT_FORBIDDEN",
  );
  assert.equal(
    code(() => assertRootNotForbidden("/srv/dpit/runtime/gateway", ["/srv/dpit/runtime/gateway"])),
    "ROOT_FORBIDDEN",
  );
});

test("默认 forbiddenRoots 包含 Temp、cwd、源码仓根，避免误创建生产源码目录", () => {
  const defaults = defaultForbiddenRoots().map((p) => resolve(p));
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  assert.ok(defaults.includes(resolve(tmpdir())));
  assert.ok(defaults.includes(resolve(process.cwd())));
  assert.ok(defaults.includes(repoRoot));
  assert.equal(defaults.some((p) => p === parse(p).root), false, "不得用文件系统根禁掉所有目标");
  assert.equal(code(() => assertRootNotForbidden(process.cwd(), defaults)), "ROOT_FORBIDDEN");
  assert.equal(code(() => assertRootNotForbidden(join(process.cwd(), "runtime"), defaults)), "ROOT_FORBIDDEN");
  assert.equal(code(() => assertRootNotForbidden(join(repoRoot, "runtime"), defaults)), "ROOT_FORBIDDEN");
});

test("默认 forbiddenRoots 包含 tmpdir：Temp 下可信根拒绝", async () => {
  const b = base();
  try {
    const c = await asyncCode(() => prepareTrustedRuntime({ root: join(b, "runtime") }));
    assert.equal(c, "ROOT_FORBIDDEN");
  } finally {
    rmSync(b, { recursive: true, force: true });
  }
});

test("根为 symlink 拒绝", { skip: WIN }, async () => {
  const b = base();
  try {
    const real = join(b, "real");
    mkdirSync(real, { mode: 0o700 });
    const link = join(b, "runtime-link");
    symlinkSync(real, link);
    const c = await asyncCode(() => prepareTrustedRuntime({ root: link, forbiddenRoots: [] }));
    assert.equal(c, "TRUSTED_DIR_UNSAFE");
  } finally {
    rmSync(b, { recursive: true, force: true });
  }
});

test("cleanup-locks 为 symlink 拒绝", { skip: WIN }, async () => {
  const b = base();
  try {
    const root = join(b, "runtime");
    mkdirSync(root, { mode: 0o700 });
    chmodSync(root, 0o700);
    const realLock = join(b, "real-lock");
    mkdirSync(realLock, { mode: 0o700 });
    symlinkSync(realLock, join(root, "cleanup-locks"));
    const c = await asyncCode(() => prepareTrustedRuntime({ root, forbiddenRoots: [] }));
    assert.equal(c, "TRUSTED_DIR_UNSAFE");
  } finally {
    rmSync(b, { recursive: true, force: true });
  }
});

test("父路径含 symlink：创建前拒绝，真实目标内不得产生目录", { skip: WIN }, async () => {
  const b = base();
  try {
    const real = join(b, "real");
    mkdirSync(real, { mode: 0o700 });
    chmodSync(real, 0o700);
    symlinkSync(real, join(b, "link"));
    const targetRoot = join(b, "link", "runtime");
    const c = await asyncCode(() => prepareTrustedRuntime({ root: targetRoot, forbiddenRoots: [] }));
    assert.equal(c, "TRUSTED_DIR_UNSAFE");
    assert.equal(existsSync(join(real, "runtime")), false, "不得先穿过 symlink 创建目录");
  } finally {
    rmSync(b, { recursive: true, force: true });
  }
});

test("POSIX 无法取得有效 UID/GID：创建前 fail closed", { skip: WIN }, async () => {
  const b = base();
  try {
    const root = join(b, "runtime-uid-null");
    assert.equal(
      await asyncCode(() => prepareTrustedRuntime({ root, forbiddenRoots: [], expectedUid: null })),
      "TRUSTED_IDENTITY_UNAVAILABLE",
    );
    assert.equal(existsSync(root), false);
    const root2 = join(b, "runtime-gid-null");
    assert.equal(
      await asyncCode(() => prepareTrustedRuntime({ root: root2, forbiddenRoots: [], expectedGid: null })),
      "TRUSTED_IDENTITY_UNAVAILABLE",
    );
    assert.equal(existsSync(root2), false);
  } finally {
    rmSync(b, { recursive: true, force: true });
  }
});

test("cleanup-locks 权限非 0700 拒绝且不 chmod", { skip: WIN }, async () => {
  const b = base();
  try {
    const root = join(b, "runtime");
    mkdirSync(root, { mode: 0o700 });
    chmodSync(root, 0o700);
    const lock = join(root, "cleanup-locks");
    mkdirSync(lock, { mode: 0o755 });
    chmodSync(lock, 0o755);
    const c = await asyncCode(() => prepareTrustedRuntime({ root, forbiddenRoots: [] }));
    assert.equal(c, "TRUSTED_DIR_UNSAFE");
    assert.equal(lstatSync(lock).mode & 0o777, 0o755, "已存在目录不得被静默 chmod");
  } finally {
    rmSync(b, { recursive: true, force: true });
  }
});

test("audit 目录权限非 0700 拒绝", { skip: WIN }, async () => {
  const b = base();
  try {
    const root = join(b, "runtime");
    mkdirSync(root, { mode: 0o700 });
    chmodSync(root, 0o700);
    const audit = join(root, "audit");
    mkdirSync(audit, { mode: 0o750 });
    chmodSync(audit, 0o750);
    const c = await asyncCode(() => prepareTrustedRuntime({ root, forbiddenRoots: [] }));
    assert.equal(c, "TRUSTED_DIR_UNSAFE");
  } finally {
    rmSync(b, { recursive: true, force: true });
  }
});

test("错误预期 UID / GID 拒绝", { skip: WIN }, async () => {
  const b = base();
  try {
    const root = join(b, "runtime-uid");
    const uid = currentEffectiveUid();
    const c1 = await asyncCode(() =>
      prepareTrustedRuntime({ root, forbiddenRoots: [], expectedUid: (uid ?? 0) + 1 }),
    );
    assert.equal(c1, "TRUSTED_DIR_UNSAFE");

    const root2 = join(b, "runtime-gid");
    const gid = currentEffectiveGid();
    const c2 = await asyncCode(() =>
      prepareTrustedRuntime({ root: root2, forbiddenRoots: [], expectedGid: (gid ?? 0) + 1 }),
    );
    assert.equal(c2, "TRUSTED_DIR_UNSAFE");
  } finally {
    rmSync(b, { recursive: true, force: true });
  }
});

test("cleanupLockDir 越出 trustedRuntimeRoot 拒绝", { skip: WIN }, async () => {
  const b = base();
  try {
    const root = join(b, "runtime");
    const outside = join(b, "outside");
    mkdirSync(outside, { mode: 0o700 });
    const c = await asyncCode(() =>
      prepareTrustedRuntime({ root, cleanupLockDir: outside, forbiddenRoots: [] }),
    );
    assert.equal(c, "PATH_OUTSIDE_TRUSTED_ROOT");
  } finally {
    rmSync(b, { recursive: true, force: true });
  }
});

test("目录校验：普通目录通过；文件/symlink/错误属主/错误 mode 拒绝", { skip: WIN }, async () => {
  const b = base();
  try {
    const dir = join(b, "d");
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
    const st = lstatSync(dir);
    const uid = currentEffectiveUid();
    const gid = currentEffectiveGid();
    assert.equal(isSafeRuntimeDirectory(st, "linux", uid, gid), true);
    assert.equal(isSafeRuntimeDirectory(st, "linux", (uid ?? 0) + 1, gid), false);
    assert.equal(isSafeRuntimeDirectory(st, "linux", uid, (gid ?? 0) + 1), false);
    assert.equal(isSafeRuntimeDirectory(st, "linux", null, gid), false, "null UID 不得跳过属主校验");
    assert.equal(isSafeRuntimeDirectory(st, "linux", uid, null), false, "null GID 不得跳过属组校验");
    chmodSync(dir, 0o750);
    assert.equal(isSafeRuntimeDirectory(lstatSync(dir), "linux", uid, gid), false);
    const file = join(b, "f");
    writeFileSync(file, "x", { mode: 0o600 });
    assert.equal(isSafeRuntimeDirectory(lstatSync(file), "linux", uid, gid), false);
    const link = join(b, "l");
    symlinkSync(dir, link);
    assert.equal(isSafeRuntimeDirectory(lstatSync(link), "linux", uid, gid), false);

    await assert.rejects(
      () => validateTrustedDirectory(dir, { platform: "linux", expectedUid: uid, expectedGid: gid }),
      (e: any) => e.code === "TRUSTED_DIR_UNSAFE",
    );
  } finally {
    rmSync(b, { recursive: true, force: true });
  }
});

test("Windows 规则 mock：posix 安全位不适用，但仍拒绝文件/非目录", () => {
  const b = base();
  try {
    const dir = join(b, "d");
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    const st = lstatSync(dir);
    assert.equal(posixSecurityApplies("win32"), false);
    assert.equal(isSafeRuntimeDirectory(st, "win32", 12345, 67890), true);
    const file = join(b, "f");
    writeFileSync(file, "x");
    assert.equal(isSafeRuntimeDirectory(lstatSync(file), "win32", 12345, 67890), false);
  } finally {
    rmSync(b, { recursive: true, force: true });
  }
});
