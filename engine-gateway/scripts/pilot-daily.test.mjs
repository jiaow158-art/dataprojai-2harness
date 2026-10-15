// LIN-1B：pilot-daily.mjs（只读日报）跨平台路径围栏与冒烟测试——DB 一律临时 fixture。
// 平台分支按本机真实平台执行（Linux 上 posix 分支真实跑通；win32 分支在 Windows 上真实跑通，不以 mock 假跑）。
// win32 下"无 env"的缺省指向真实生产库，测试禁止触碰该分支——只测显式 env。
// 唯一仓库内写入点：eval_results/pilot/daily-<yyyymmdd>.md（.gitignore 覆盖）——成功冒烟前置确认
// 当日文件不存在，断言后即删除本测试生成的副本；真实日报不被覆盖。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const SCRIPT = fileURLToPath(new URL("./pilot-daily.mjs", import.meta.url));
const PILOT_DIR = fileURLToPath(new URL("../../eval_results/pilot/", import.meta.url));
const GW_SCHEMA = readFileSync(fileURLToPath(new URL("../src/store/schema.sql", import.meta.url)), "utf8");

/** 干净 env：剔除外层可能带的 GW_DB_PATH/BFF_DB_PATH（其余继承，保 PATH 等）。 */
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  delete env.GW_DB_PATH;
  delete env.BFF_DB_PATH;
  return Object.assign(env, extra);
}

const run = (extraEnv) =>
  spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", env: cleanEnv(extraEnv) });

/** 与脚本同源（本地时区）的当日日报路径。 */
function todayFile() {
  const d = new Date();
  const compact = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return join(PILOT_DIR, `daily-${compact}.md`);
}

test("路径围栏：posix 盘符形态（缺省/env，两库各自）开库前 exit 2 且不写日报；win32 盘符 env 放行", () => {
  if (process.platform === "win32") {
    // win32：盘符形态即正常生产形态——不被围栏拦，走到开库失败（E: 不存在）exit 1
    const r = run({ GW_DB_PATH: "E:\\no\\such.db", BFF_DB_PATH: "E:\\no\\such.db" });
    assert.equal(r.status, 1, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stderr, /网关库不可读/);
    assert.doesNotMatch(r.stderr, /盘符形态/);
    // 无 env 缺省 = 真实 Windows 生产库：禁止在测试中触碰，不设该断言
    return;
  }
  const bare = run();
  assert.equal(bare.status, 2, `stdout=${bare.stdout}\nstderr=${bare.stderr}`);
  assert.match(bare.stderr, /gatewayDb 为 Windows 盘符形态（D:\/m0-sessions\/prod\/gateway\.db）/);
  assert.equal(bare.stdout, "");
  // 围栏先于文件访问与日报写入：不得出现任何开库/写盘痕迹
  assert.doesNotMatch(bare.stderr, /不可读|Cannot open|已写入/);

  const gwDrive = run({ GW_DB_PATH: "E:/env/gw.db", BFF_DB_PATH: "E:/env/bff.db" });
  assert.equal(gwDrive.status, 2);
  assert.match(gwDrive.stderr, /gatewayDb 为 Windows 盘符形态（E:\/env\/gw\.db）/);
  assert.doesNotMatch(gwDrive.stderr, /不可读|Cannot open|已写入/);

  const dir = mkdtempSync(join(tmpdir(), "pilot-fx-"));
  try {
    const bffDrive = run({ GW_DB_PATH: join(dir, "gw.db"), BFF_DB_PATH: "E:/env/bff.db" });
    assert.equal(bffDrive.status, 2);
    assert.match(bffDrive.stderr, /bffDb 为 Windows 盘符形态（E:\/env\/bff\.db）/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POSIX 显式路径放行：库不存在 → 只读开库失败 exit 1（不写日报）", () => {
  const dir = mkdtempSync(join(tmpdir(), "pilot-fx-"));
  try {
    const r = run({ GW_DB_PATH: join(dir, "missing", "gw.db"), BFF_DB_PATH: join(dir, "missing", "bff.db") });
    assert.equal(r.status, 1, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stderr, /网关库不可读/);
    assert.doesNotMatch(r.stderr, /盘符形态|已写入/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("成功冒烟：fixture 库 → exit 0，日报写入 eval_results/pilot/ 且与 stdout 一致（测试后清理自产文件）", (t) => {
  const outFile = todayFile();
  if (existsSync(outFile)) {
    t.skip(`当日日报已存在（${outFile}）——不覆盖，跳过写入冒烟`);
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "pilot-fx-"));
  try {
    const gwPath = join(dir, "gateway.db");
    const gw = new Database(gwPath);
    gw.exec(GW_SCHEMA);
    const ins = gw.prepare(
      "INSERT INTO tasks (run_id, session_id, user, question, status, created_at, updated_at) VALUES (?, 'sess-1', 'u1', ?, ?, ?, ?)",
    );
    ins.run("run-s1", "成功冒烟", "succeeded", 1_800_000_000_000, 1_800_000_000_000);
    ins.run("run-f1", "失败冒烟", "failed", 1_800_000_000_001, 1_800_000_000_001);
    gw.close();

    const r = run({ GW_DB_PATH: gwPath, BFF_DB_PATH: join(dir, "no-bff.db") });
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stdout, /# 试点日报/);
    assert.match(r.stdout, /任务总量 \*\*2\*\*/);
    assert.match(r.stderr, /BFF 库不可读/);
    assert.ok(existsSync(outFile), "日报应写入 eval_results/pilot/");
    assert.equal(readFileSync(outFile, "utf8"), r.stdout.replace(/\n$/, ""));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    // 清理本测试生成的日报（前置已确认当日文件不存在——绝不删除真实日报）
    if (existsSync(outFile)) rmSync(outFile);
  }
});
