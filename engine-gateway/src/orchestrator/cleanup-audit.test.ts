// S4-B2-C2-B1：可信审计文件写入、替换检测与 fsync 失败显式化。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareTrustedRuntime } from "../config/trusted-runtime.ts";
import { CleanupAuditLog } from "./cleanup-audit.ts";

const WIN = process.platform === "win32";

async function setup(): Promise<{ base: string; root: string; auditDir: string; logPath: string }> {
  const base = mkdtempSync(join(tmpdir(), "c2b1-audit-"));
  const root = join(base, "runtime");
  const rt = await prepareTrustedRuntime({ root, forbiddenRoots: [] });
  return { base, root: rt.root, auditDir: rt.auditDir, logPath: join(rt.auditDir, "cleanup.jsonl") };
}

async function assertAsyncCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(fn, (e: any) => e?.code === code, `expected ${code}`);
}

test("成功写入：单行 JSON、fsync 调用、auditOk=true", async () => {
  const ctx = await setup();
  try {
    let syncs = 0;
    const log = await CleanupAuditLog.open({
      trustedRuntimeRoot: ctx.root,
      auditLogPath: ctx.logPath,
      syncFile: async (h) => { syncs += 1; await h.sync(); },
      now: () => "2026-10-25T12:00:00.000Z",
    });
    const res = await log.append({ action: "cleanup", phase: "summary", ok: true, found: 0 });
    assert.equal(res.ok, true);
    assert.ok(res.bytes && res.bytes > 0);
    assert.equal(syncs, 1);
    assert.equal(log.auditOk, true);
    assert.equal(log.eventCount, 1);
    const close = await log.close();
    assert.equal(close.ok, true);
    if (!WIN) assert.equal(statSync(ctx.logPath).mode & 0o777, 0o600);
    const lines = readFileSync(ctx.logPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.ts, "2026-10-25T12:00:00.000Z");
    assert.equal(parsed.action, "cleanup");
    assert.equal(parsed.ok, true);
  } finally {
    rmSync(ctx.base, { recursive: true, force: true });
  }
});

test("审计事件必须是扁平 code-only 对象，嵌套/数组拒绝且不算成功", async () => {
  const ctx = await setup();
  try {
    const log = await CleanupAuditLog.open({ trustedRuntimeRoot: ctx.root, auditLogPath: ctx.logPath });
    const r1 = await log.append({ nested: { path: "/srv/secret" } as any });
    assert.equal(r1.ok, false);
    assert.equal(r1.code, "AUDIT_EVENT_INVALID");
    const r2 = await log.append({ list: ["x"] } as any);
    assert.equal(r2.ok, false);
    assert.equal(r2.code, "AUDIT_EVENT_INVALID");
    assert.equal(log.eventCount, 0);
    assert.equal(readFileSync(ctx.logPath, "utf8"), "");
    await log.close();
  } finally {
    rmSync(ctx.base, { recursive: true, force: true });
  }
});

test("审计文件被替换：后续 append 显式失败，替换文件不被写入", { skip: WIN }, async () => {
  const ctx = await setup();
  try {
    const log = await CleanupAuditLog.open({ trustedRuntimeRoot: ctx.root, auditLogPath: ctx.logPath });
    await log.append({ action: "open" });
    unlinkSync(ctx.logPath);
    writeFileSync(ctx.logPath, "replacement\n", { mode: 0o600 });
    const res = await log.append({ action: "after-replace" });
    assert.equal(res.ok, false);
    assert.equal(res.code, "AUDIT_FILE_REPLACED");
    assert.equal(log.auditOk, false);
    assert.equal(log.failureCount, 1);
    assert.equal(readFileSync(ctx.logPath, "utf8"), "replacement\n");
    await log.close();
  } finally {
    rmSync(ctx.base, { recursive: true, force: true });
  }
});

test("fsync 失败：append 不成功且 auditOk=false", async () => {
  const ctx = await setup();
  try {
    const log = await CleanupAuditLog.open({
      trustedRuntimeRoot: ctx.root,
      auditLogPath: ctx.logPath,
      syncFile: async () => { throw new Error("disk sync failed"); },
    });
    const res = await log.append({ action: "cleanup" });
    assert.equal(res.ok, false);
    assert.equal(res.code, "AUDIT_FSYNC_FAILED");
    assert.equal(log.auditOk, false);
    assert.equal(log.failureCount, 1);
    await log.close();
  } finally {
    rmSync(ctx.base, { recursive: true, force: true });
  }
});

test("非法时间戳来源：append 显式失败，不写入审计", async () => {
  const ctx = await setup();
  try {
    const log = await CleanupAuditLog.open({
      trustedRuntimeRoot: ctx.root,
      auditLogPath: ctx.logPath,
      now: () => "2026-10-25\nsecret",
    });
    const res = await log.append({ action: "cleanup" });
    assert.equal(res.ok, false);
    assert.equal(res.code, "AUDIT_TIME_INVALID");
    assert.equal(log.auditOk, false);
    assert.equal(readFileSync(ctx.logPath, "utf8"), "");
    await log.close();
  } finally {
    rmSync(ctx.base, { recursive: true, force: true });
  }
});

test("并发 append：整行写入、顺序不交叉、全部成功", async () => {
  const ctx = await setup();
  try {
    const log = await CleanupAuditLog.open({ trustedRuntimeRoot: ctx.root, auditLogPath: ctx.logPath });
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, seq) => log.append({ action: "cleanup", seq })),
    );
    assert.equal(results.every((r) => r.ok), true);
    assert.equal(log.eventCount, 40);
    const lines = readFileSync(ctx.logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 40);
    assert.deepEqual(lines.map((l) => l.seq), Array.from({ length: 40 }, (_, i) => i));
    await log.close();
  } finally {
    rmSync(ctx.base, { recursive: true, force: true });
  }
});

test("并发 close：两次调用共享同一关闭结果，不提前返回成功", async () => {
  const ctx = await setup();
  try {
    const log = await CleanupAuditLog.open({ trustedRuntimeRoot: ctx.root, auditLogPath: ctx.logPath });
    const p1 = log.close();
    const p2 = log.close();
    const [c1, c2] = await Promise.all([p1, p2]);
    assert.equal(c1.ok, true);
    assert.deepEqual(c1, c2);
    assert.equal((await log.append({ action: "late" })).code, "AUDIT_CLOSED");
  } finally {
    rmSync(ctx.base, { recursive: true, force: true });
  }
});

test("审计事件拒绝路径/脚本/Bearer/凭证键/密钥形态", async () => {
  const ctx = await setup();
  try {
    const log = await CleanupAuditLog.open({ trustedRuntimeRoot: ctx.root, auditLogPath: ctx.logPath });
    assert.equal((await log.append({ action: "cleanup" })).ok, true);
    const bad = [
      { action: "/srv/dpit/secret" },
      { script: "print(1)" },
      { action: "Bearer abc" },
      { token: "abc" },
      { action: `sk-${"A".repeat(24)}` },
      { action: `gh${"p_"}${"b".repeat(24)}` },
      { action: "key=value" },
    ];
    for (const event of bad) {
      const res = await log.append(event);
      assert.equal(res.ok, false, JSON.stringify(event));
      assert.equal(res.code, "AUDIT_EVENT_INVALID");
    }
    assert.equal(log.eventCount, 1);
    const text = readFileSync(ctx.logPath, "utf8");
    assert.equal(text.includes("sk-"), false);
    assert.equal(text.includes("/srv/"), false);
    await log.close();
  } finally {
    rmSync(ctx.base, { recursive: true, force: true });
  }
});

test("打开后 chmod 放宽权限：下一次 append 显式失败且不写入", { skip: WIN }, async () => {
  const ctx = await setup();
  try {
    const log = await CleanupAuditLog.open({ trustedRuntimeRoot: ctx.root, auditLogPath: ctx.logPath });
    await log.append({ action: "cleanup" });
    chmodSync(ctx.logPath, 0o644);
    const before = readFileSync(ctx.logPath, "utf8");
    const res = await log.append({ action: "after-chmod" });
    assert.equal(res.ok, false);
    assert.equal(res.code, "AUDIT_TARGET_UNSAFE");
    assert.equal(readFileSync(ctx.logPath, "utf8"), before);
    assert.equal(log.auditOk, false);
    await log.close();
  } finally {
    rmSync(ctx.base, { recursive: true, force: true });
  }
});

test("打开后文件被换成 symlink：拒绝继续写入", { skip: WIN }, async () => {
  const ctx = await setup();
  try {
    const log = await CleanupAuditLog.open({ trustedRuntimeRoot: ctx.root, auditLogPath: ctx.logPath });
    await log.append({ action: "cleanup" });
    const outside = join(ctx.base, "outside.jsonl");
    writeFileSync(outside, "outside\n", { mode: 0o600 });
    unlinkSync(ctx.logPath);
    symlinkSync(outside, ctx.logPath);
    const res = await log.append({ action: "after-symlink" });
    assert.equal(res.ok, false);
    assert.equal(res.code, "AUDIT_TARGET_UNSAFE");
    assert.equal(readFileSync(outside, "utf8"), "outside\n");
    await log.close();
  } finally {
    rmSync(ctx.base, { recursive: true, force: true });
  }
});

test("关闭后 append 显式失败", async () => {
  const ctx = await setup();
  try {
    const log = await CleanupAuditLog.open({ trustedRuntimeRoot: ctx.root, auditLogPath: ctx.logPath });
    assert.equal((await log.close()).ok, true);
    const res = await log.append({ action: "late" });
    assert.equal(res.ok, false);
    assert.equal(res.code, "AUDIT_CLOSED");
  } finally {
    rmSync(ctx.base, { recursive: true, force: true });
  }
});

test("关闭时先排空已在队列中的 append，再关闭文件", async () => {
  const ctx = await setup();
  try {
    const log = await CleanupAuditLog.open({ trustedRuntimeRoot: ctx.root, auditLogPath: ctx.logPath });
    const pending = log.append({ action: "queued" });
    const closed = log.close();
    const [a, c] = await Promise.all([pending, closed]);
    assert.equal(a.ok, true);
    assert.equal(c.ok, true);
    assert.ok(readFileSync(ctx.logPath, "utf8").includes('"action":"queued"'));
  } finally {
    rmSync(ctx.base, { recursive: true, force: true });
  }
});

test("审计目录权限非 0700：打开拒绝", { skip: WIN }, async () => {
  const base = mkdtempSync(join(tmpdir(), "c2b1-audit-dir-"));
  try {
    const root = join(base, "runtime");
    mkdirSync(root, { mode: 0o700 });
    chmodSync(root, 0o700);
    const audit = join(root, "audit");
    mkdirSync(audit, { mode: 0o755 });
    chmodSync(audit, 0o755);
    await assertAsyncCode(
      () => CleanupAuditLog.open({ trustedRuntimeRoot: root, auditLogPath: join(audit, "cleanup.jsonl") }),
      "TRUSTED_DIR_UNSAFE",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("审计文件权限非 0600：打开拒绝", { skip: WIN }, async () => {
  const ctx = await setup();
  try {
    writeFileSync(ctx.logPath, "", { mode: 0o644 });
    chmodSync(ctx.logPath, 0o644);
    await assertAsyncCode(
      () => CleanupAuditLog.open({ trustedRuntimeRoot: ctx.root, auditLogPath: ctx.logPath }),
      "AUDIT_TARGET_UNSAFE",
    );
  } finally {
    rmSync(ctx.base, { recursive: true, force: true });
  }
});

test("审计文件为 symlink：打开拒绝", { skip: WIN }, async () => {
  const ctx = await setup();
  try {
    const target = join(ctx.base, "target.jsonl");
    writeFileSync(target, "", { mode: 0o600 });
    symlinkSync(target, ctx.logPath);
    await assertAsyncCode(
      () => CleanupAuditLog.open({ trustedRuntimeRoot: ctx.root, auditLogPath: ctx.logPath }),
      "AUDIT_TARGET_UNSAFE",
    );
  } finally {
    rmSync(ctx.base, { recursive: true, force: true });
  }
});

test("审计日志路径越出 trustedRuntimeRoot：打开拒绝", async () => {
  const ctx = await setup();
  try {
    await assertAsyncCode(
      () => CleanupAuditLog.open({
        trustedRuntimeRoot: ctx.root,
        auditLogPath: join(ctx.base, "outside.jsonl"),
      }),
      "PATH_OUTSIDE_TRUSTED_ROOT",
    );
  } finally {
    rmSync(ctx.base, { recursive: true, force: true });
  }
});

test("audit 目录缺失：打开拒绝，不自行创建", async () => {
  const base = mkdtempSync(join(tmpdir(), "c2b1-audit-missing-"));
  try {
    const root = join(base, "runtime");
    mkdirSync(root, { mode: 0o700 });
    chmodSync(root, 0o700);
    await assertAsyncCode(
      () => CleanupAuditLog.open({ trustedRuntimeRoot: root, auditLogPath: join(root, "audit", "cleanup.jsonl") }),
      "TRUSTED_DIR_MISSING",
    );
    assert.equal(existsSync(join(root, "audit")), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
