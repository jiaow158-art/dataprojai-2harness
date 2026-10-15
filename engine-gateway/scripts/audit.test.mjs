// LIN-1B：audit.mjs（只读审计查询）冒烟与跨平台路径围栏测试——全程临时 fixture，绝不触生产库。
// 平台分支按本机真实平台执行（Linux 上 posix 分支真实跑通；win32 分支在 Windows 上真实跑通，不以 mock 假跑）。
// win32 下"无 env"的缺省指向真实生产库，测试禁止触碰该分支——只测显式 env。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const SCRIPT = fileURLToPath(new URL("./audit.mjs", import.meta.url));
const GW_SCHEMA = readFileSync(fileURLToPath(new URL("../src/store/schema.sql", import.meta.url)), "utf8");

/** 干净 env：剔除外层可能带的 GW_DB_PATH/BFF_DB_PATH（其余继承，保 PATH 等）。 */
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  delete env.GW_DB_PATH;
  delete env.BFF_DB_PATH;
  return Object.assign(env, extra);
}

const run = (args, extraEnv) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: cleanEnv(extraEnv) });

test("路径围栏：posix 盘符形态（缺省/env，两库各自）开库前 exit 2；win32 盘符 env 放行", () => {
  if (process.platform === "win32") {
    // win32：盘符形态即正常生产形态——不被围栏拦，走到开库失败（E: 不存在）exit 1
    const r = run(["--user", "x"], { GW_DB_PATH: "E:\\no\\such.db", BFF_DB_PATH: "E:\\no\\such.db" });
    assert.equal(r.status, 1, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stderr, /网关库不可读/);
    assert.doesNotMatch(r.stderr, /盘符形态/);
    // 无 env 缺省 = 真实 Windows 生产库：禁止在测试中触碰，不设该断言
    return;
  }
  // 缺省即 D:/ 盘符形态 → 拦（C8 缺省保留 Windows 生产值，posix 必须显式传路径）
  const bare = run(["--user", "x"]);
  assert.equal(bare.status, 2, `stdout=${bare.stdout}\nstderr=${bare.stderr}`);
  assert.match(bare.stderr, /gatewayDb 为 Windows 盘符形态（D:\/m0-sessions\/prod\/gateway\.db）/);
  assert.equal(bare.stdout, "");
  // 围栏先于文件访问：不得出现任何开库尝试的痕迹
  assert.doesNotMatch(bare.stderr, /不可读|Cannot open/);

  // env 盘符形态 → 拦（gatewayDb / bffDb 两键各自覆盖）
  const gwDrive = run(["--user", "x"], { GW_DB_PATH: "E:/env/gw.db", BFF_DB_PATH: "E:/env/bff.db" });
  assert.equal(gwDrive.status, 2);
  assert.match(gwDrive.stderr, /gatewayDb 为 Windows 盘符形态（E:\/env\/gw\.db）/);
  assert.doesNotMatch(gwDrive.stderr, /不可读|Cannot open/);

  const dir = mkdtempSync(join(tmpdir(), "audit-fx-"));
  try {
    const bffDrive = run(["--user", "x"], { GW_DB_PATH: join(dir, "gw.db"), BFF_DB_PATH: "E:/env/bff.db" });
    assert.equal(bffDrive.status, 2);
    assert.match(bffDrive.stderr, /bffDb 为 Windows 盘符形态（E:\/env\/bff\.db）/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POSIX 显式路径放行：库不存在 → 只读开库失败 exit 1，且不创建任何目录/文件", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-fx-"));
  try {
    const missing = join(dir, "missing");
    const r = run(["--user", "x"], { GW_DB_PATH: join(missing, "gw.db"), BFF_DB_PATH: join(missing, "bff.db") });
    assert.equal(r.status, 1, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stderr, /网关库不可读/);
    assert.doesNotMatch(r.stderr, /盘符形态/);
    assert.ok(!existsSync(missing), "只读工具不得创建缺失目录");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("只读成功冒烟：fixture 库渲染输出 exit 0；BFF 缺失降级不致命", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-fx-"));
  try {
    const gwPath = join(dir, "gateway.db");
    const gw = new Database(gwPath);
    gw.exec(GW_SCHEMA);
    gw.prepare(
      "INSERT INTO tasks (run_id, session_id, user, question, status, created_at, updated_at) VALUES (?, 'sess-1', 'u1', ?, 'succeeded', ?, ?)",
    ).run("run-smoke", "围栏冒烟问题", 1_800_000_000_000, 1_800_000_000_000);
    gw.close();

    const r = run(["--user", "u1"], { GW_DB_PATH: gwPath, BFF_DB_PATH: join(dir, "no-bff.db") });
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stdout, /# 审计 · 用户 u1/);
    assert.match(r.stdout, /围栏冒烟问题/);
    assert.match(r.stderr, /BFF 库不可读/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
