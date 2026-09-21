// M4 数据保留清理脚本测试 —— 全程临时 fixture 树，绝不触生产
// （D:\m0-sessions\prod 与 dataplat-ui data-prod；测试一律显式传五个路径参数）。
//
// 覆盖：dry-run 零副作用（含不产生 -wal/-shm）· --apply 三类按期删净且界内保留 ·
// 级联正确（删 task 带 events/publications，与事件自身年龄无关）· --now 时间旅行 ·
// 越界路径拒绝（junction 逃逸不动目标）· 单类失败跳过不中断 ·
// parseArgs 的 env/CLI/生产缺省优先级与用法错误退出码。
//
// fixture 时间用固定注入时钟 NOW，边界行（恰在 cutoff 上）一律保留——严格小于语义。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

import { PROD_DEFAULTS, UsageError, isInside, parseArgs } from "./retention.mjs";

const HERE = fileURLToPath(import.meta.url);
const SCRIPT = join(HERE, "..", "retention.mjs");
const DAY = 86_400_000;
const NOW = 1_800_000_000_000; // 固定注入时钟（2027-01-15T05:40:00Z）

// 网关库直接用真实 schema（src/store/schema.sql）防漂移；
// BFF schema 在独立仓（dataplat-ui/server/src/schema.sql），此处内联最小等价 DDL，
// 仅 ui_sessions.updated_at 放宽为可空——专测 COALESCE 兜底分支（生产为 NOT NULL）。
const GW_SCHEMA = readFileSync(fileURLToPath(new URL("../src/store/schema.sql", import.meta.url)), "utf8");
const BFF_SCHEMA = `
CREATE TABLE ui_sessions (id TEXT PRIMARY KEY, username TEXT NOT NULL, title TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER);
CREATE TABLE messages (id TEXT PRIMARY KEY, ui_session_id TEXT NOT NULL, run_id TEXT NOT NULL,
  gateway_session_id TEXT NOT NULL, question TEXT NOT NULL, answer_md TEXT, report_path TEXT,
  status TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE admin_audit (id TEXT PRIMARY KEY, username TEXT NOT NULL, action TEXT NOT NULL,
  target TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL);
CREATE TABLE login_log (id TEXT PRIMARY KEY, username TEXT NOT NULL, token_prefix TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER, logout_at INTEGER);
`;

// ---------- fixture ----------

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "retention-fx-"));
  const p = {
    root,
    gatewayDb: join(root, "gateway.db"),
    bffDb: join(root, "bff.db"),
    reports: join(root, "reports"),
    results: join(root, "results"),
    work: join(root, "work"),
  };

  // 网关：old（181d，删）+ boundary（恰 180d，保留）+ new（5d，保留）
  const gw = new Database(p.gatewayDb);
  gw.exec(GW_SCHEMA);
  const insTask = gw.prepare(
    "INSERT INTO tasks (run_id, session_id, user, question, status, created_at, updated_at) VALUES (?, 'sess-gw', 'u1', 'q', 'succeeded', ?, ?)",
  );
  insTask.run("run-old", NOW - 181 * DAY, NOW - 181 * DAY);
  insTask.run("run-boundary", NOW - 180 * DAY, NOW - 180 * DAY);
  insTask.run("run-new", NOW - 5 * DAY, NOW - 5 * DAY);
  const insEvt = gw.prepare("INSERT INTO events (run_id, seq, type, payload, created_at) VALUES (?, ?, 'stage', '{}', ?)");
  insEvt.run("run-old", 1, NOW - 181 * DAY);
  insEvt.run("run-old", 2, NOW); // 事件很新——级联按 run_id，与事件年龄无关
  insEvt.run("run-boundary", 1, NOW - 180 * DAY);
  insEvt.run("run-new", 1, NOW - 5 * DAY);
  const insPub = gw.prepare("INSERT INTO publications (run_id, report_path, published_at) VALUES (?, ?, ?)");
  insPub.run("run-old", "old.html", NOW - 181 * DAY);
  insPub.run("run-new", "new.html", NOW - 5 * DAY);
  gw.close();

  // BFF：四表各 old/boundary/new；ui_sessions 另有 updated_at 为 NULL 的兜底行
  const bff = new Database(p.bffDb);
  bff.exec(BFF_SCHEMA);
  const insMsg = bff.prepare("INSERT INTO messages (id, ui_session_id, run_id, gateway_session_id, question, status, created_at) VALUES (?, 'us1', ?, 'sess-gw', 'q', 'succeeded', ?)");
  insMsg.run("m-old", "run-old", NOW - 181 * DAY);
  insMsg.run("m-boundary", "run-boundary", NOW - 180 * DAY);
  insMsg.run("m-new", "run-new", NOW - 5 * DAY);
  const insLl = bff.prepare("INSERT INTO login_log (id, username, token_prefix, created_at, expires_at) VALUES (?, 'u1', 'abc123', ?, ?)");
  insLl.run("ll-old", NOW - 181 * DAY, NOW);
  insLl.run("ll-boundary", NOW - 180 * DAY, NOW);
  insLl.run("ll-new", NOW - 5 * DAY, NOW);
  const insAa = bff.prepare("INSERT INTO admin_audit (id, username, action, target, created_at) VALUES (?, 'u1', 'user_create', 'x', ?)");
  insAa.run("aa-old", NOW - 181 * DAY);
  insAa.run("aa-boundary", NOW - 180 * DAY);
  insAa.run("aa-new", NOW - 5 * DAY);
  const insUs = bff.prepare("INSERT INTO ui_sessions (id, username, title, created_at, updated_at) VALUES (?, 'u1', 't', ?, ?)");
  insUs.run("us-old-upd", NOW - 200 * DAY, NOW - 91 * DAY); // updated_at 91d → 删
  insUs.run("us-bound", NOW - 200 * DAY, NOW - 90 * DAY); // 恰 90d → 保留
  insUs.run("us-new", NOW - 5 * DAY, NOW - 1 * DAY);
  insUs.run("us-null-updated", NOW - 100 * DAY, null); // updated_at 缺失 → 兜底 created_at 100d → 删
  bff.close();

  // 报告树：u1 新旧混合；u2 删后变空；u3 本来就空；u4 含非 html 文件
  const html = (user, name, mtimeMs) => {
    mkdirSync(join(p.reports, user), { recursive: true });
    const f = join(p.reports, user, name);
    writeFileSync(f, `<html>${user}/${name}</html>`);
    utimesSync(f, new Date(mtimeMs), new Date(mtimeMs));
  };
  html("u1", "old.html", NOW - 91 * DAY);
  html("u1", "fresh.html", NOW - 89 * DAY);
  html("u2", "old.html", NOW - 91 * DAY);
  mkdirSync(join(p.reports, "u3"));
  html("u4", "fresh.html", NOW - 89 * DAY);
  writeFileSync(join(p.reports, "u4", "note.txt"), "非报告文件，不动");

  // 结果树：整 session 目录删（目录 mtime 为准）+ 游离文件不动
  const jsonResult = (sid, mtimeMs) => {
    mkdirSync(join(p.results, sid, "results"), { recursive: true });
    writeFileSync(join(p.results, sid, "results", "r1.json"), JSON.stringify({ rows: [1, 2] }));
    utimesSync(join(p.results, sid), new Date(mtimeMs), new Date(mtimeMs));
  };
  jsonResult("sess-old", NOW - 91 * DAY);
  jsonResult("sess-new", NOW - 89 * DAY);
  writeFileSync(join(p.results, "stray.txt"), "游离文件，不动");

  // 工作树：14 天线两侧
  const workSession = (sid, mtimeMs) => {
    mkdirSync(join(p.work, sid, "workdir"), { recursive: true });
    writeFileSync(join(p.work, sid, "workdir", "a.txt"), "scratch");
    utimesSync(join(p.work, sid), new Date(mtimeMs), new Date(mtimeMs));
  };
  workSession("w-old", NOW - 15 * DAY);
  workSession("w-new", NOW - 13 * DAY);
  return p;
}

const cleanupFixture = (p) => rmSync(p.root, { recursive: true, force: true });

// ---------- 断言辅助 ----------

function runCli(p, extra = [], nowMs = NOW) {
  const args = [
    "--gateway-db", p.gatewayDb,
    "--bff-db", p.bffDb,
    "--reports", p.reports,
    "--results", p.results,
    "--work", p.work,
    "--now", String(nowMs),
    ...extra,
  ];
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

function dbAll(path, sql) {
  const db = new Database(path, { readonly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

const gwRunIds = (p) => dbAll(p.gatewayDb, "SELECT run_id FROM tasks ORDER BY run_id").map((r) => r.run_id);
const gwEventKeys = (p) => dbAll(p.gatewayDb, "SELECT run_id, seq FROM events ORDER BY run_id, seq").map((r) => `${r.run_id}:${r.seq}`);
const gwPubRunIds = (p) => dbAll(p.gatewayDb, "SELECT run_id FROM publications ORDER BY run_id").map((r) => r.run_id);
const bffCol = (p, table, col) => dbAll(p.bffDb, `SELECT ${col} AS v FROM ${table} ORDER BY v`).map((r) => r.v);

function treeSnap(dir) {
  const out = [];
  const walk = (d, prefix) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      out.push(e.isDirectory() ? `${rel}/` : rel);
      if (e.isDirectory()) walk(join(d, e.name), rel);
    }
  };
  walk(dir, "");
  return out;
}

const dbSnap = (p) => ({
  gwTasks: gwRunIds(p),
  gwEvents: gwEventKeys(p),
  gwPubs: gwPubRunIds(p),
  messages: bffCol(p, "messages", "run_id"),
  loginLog: bffCol(p, "login_log", "id"),
  adminAudit: bffCol(p, "admin_audit", "id"),
  uiSessions: bffCol(p, "ui_sessions", "id"),
});

// ---------- 测试 ----------

test("dry-run 零副作用：无 --apply 只打印清单，库/目录/文件一字不动，不产生 -wal/-shm", () => {
  const p = fixture();
  try {
    const beforeTree = treeSnap(p.root);
    const beforeDb = dbSnap(p);
    for (const extra of [[], ["--dry-run"]]) {
      const r = runCli(p, extra);
      assert.equal(r.status, 0, `exit=${r.status}\nstderr=${r.stderr}`);
      assert.match(r.stdout, /DRY-RUN/);
      assert.match(r.stdout, /将删/);
      assert.doesNotMatch(r.stdout, /APPLY（已执行删除）\)/);
      // dry-run 预告的计数与 fixture 一致
      assert.match(r.stdout, /tasks 1 · events 2 · publications 1/);
    }
    assert.deepEqual(treeSnap(p.root), beforeTree);
    assert.deepEqual(dbSnap(p), beforeDb);
    for (const side of ["-wal", "-shm"]) {
      assert.ok(!existsSync(p.gatewayDb + side), `不应产生 gateway.db${side}`);
      assert.ok(!existsSync(p.bffDb + side), `不应产生 bff.db${side}`);
    }
  } finally {
    cleanupFixture(p);
  }
});

test("--apply 分层删净且界内保留：7 类按各自保留期，恰在边界的一律保留", () => {
  const p = fixture();
  try {
    const r = runCli(p, ["--apply"]);
    assert.equal(r.status, 0, `exit=${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stdout, /APPLY（已执行删除）/);
    assert.match(r.stdout, /tasks 1 · events 2 · publications 1/);
    // 网关：old 删（级联其全部事件——含 created_at 很新的事件——与发布），boundary/new 保留
    assert.deepEqual(gwRunIds(p), ["run-boundary", "run-new"]);
    assert.deepEqual(gwEventKeys(p), ["run-boundary:1", "run-new:1"]);
    assert.deepEqual(gwPubRunIds(p), ["run-new"]);
    // BFF：old 删、boundary/new 保留；ui_sessions 的 NULL updated_at 行走 created_at 兜底
    assert.deepEqual(bffCol(p, "messages", "run_id"), ["run-boundary", "run-new"]);
    assert.deepEqual(bffCol(p, "login_log", "id"), ["ll-boundary", "ll-new"]);
    assert.deepEqual(bffCol(p, "admin_audit", "id"), ["aa-boundary", "aa-new"]);
    assert.deepEqual(bffCol(p, "ui_sessions", "id"), ["us-bound", "us-new"]);
    // 报告：过期 html 删，新 html 与非 html 保留；u2 删后空、u3 原空 → 目录随清；u4 保留
    assert.ok(!existsSync(join(p.reports, "u1", "old.html")));
    assert.ok(existsSync(join(p.reports, "u1", "fresh.html")));
    assert.ok(!existsSync(join(p.reports, "u2")));
    assert.ok(!existsSync(join(p.reports, "u3")));
    assert.ok(existsSync(join(p.reports, "u4", "fresh.html")));
    assert.ok(existsSync(join(p.reports, "u4", "note.txt")));
    // 结果：整 session 目录删（含 results/*.json），界内与游离文件保留
    assert.ok(!existsSync(join(p.results, "sess-old")));
    assert.ok(existsSync(join(p.results, "sess-new", "results", "r1.json")));
    assert.ok(existsSync(join(p.results, "stray.txt")));
    // 工作：15d 删、13d 保留
    assert.ok(!existsSync(join(p.work, "w-old")));
    assert.ok(existsSync(join(p.work, "w-new", "workdir", "a.txt")));
  } finally {
    cleanupFixture(p);
  }
});

test("--now 时间旅行：基准时钟前移 200 天后，原先界内的数据也全部过期", () => {
  const p = fixture();
  try {
    const r = runCli(p, ["--apply"], NOW + 200 * DAY);
    assert.equal(r.status, 0, `exit=${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stdout, /--now 注入/);
    assert.deepEqual(gwRunIds(p), []);
    assert.deepEqual(bffCol(p, "messages", "run_id"), []);
    assert.deepEqual(bffCol(p, "ui_sessions", "id"), []);
    assert.ok(!existsSync(join(p.reports, "u1", "fresh.html")));
    assert.ok(!existsSync(join(p.results, "sess-new")));
    assert.ok(!existsSync(join(p.work, "w-new")));
  } finally {
    cleanupFixture(p);
  }
});

test("越界路径拒绝：results 下的 junction 逃逸到根外 → 拒绝不删、目标完好、其余类别照常清理", () => {
  const p = fixture();
  try {
    const outside = join(p.root, "outside-vault");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "must survive");
    const junc = join(p.results, "sess-escape");
    try {
      symlinkSync(outside, junc, "junction");
    } catch {
      // 无权限建 junction 的环境跳过（Windows 管理员/开发者模式可建）
      cleanupFixture(p);
      return;
    }
    const r = runCli(p, ["--apply"]);
    assert.equal(r.status, 1, "越界=部分失败信号");
    assert.match(r.stdout, /越界拒绝/);
    assert.match(r.stdout, /sess-escape/);
    assert.ok(existsSync(join(outside, "secret.txt")), "逃逸目标内容必须完好");
    assert.ok(existsSync(junc), "越界项本身不被删除（留给人工核查）");
    assert.ok(!existsSync(join(p.results, "sess-old")), "其余清理照常");
    assert.deepEqual(gwRunIds(p), ["run-boundary", "run-new"], "网关清理照常");
  } finally {
    cleanupFixture(p);
  }
});

test("单类失败跳过不中断：bff.db 损坏 → 报错退出 1 但网关/文件类照常；目标缺失 → 跳过退出 0", () => {
  // (a) 损坏的 bff.db：打开可、读取失败 → 四个 BFF 类别报错，其余类别完成
  const p = fixture();
  try {
    rmSync(p.bffDb);
    writeFileSync(p.bffDb, "this is not a sqlite database, not even close to a valid header");
    const r = runCli(p, ["--apply"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /错误（单类跳过，未中断其余类别）/);
    assert.match(r.stdout, /BFF 库读取失败/);
    assert.deepEqual(gwRunIds(p), ["run-boundary", "run-new"]);
    assert.ok(!existsSync(join(p.results, "sess-old")));
    assert.ok(!existsSync(join(p.work, "w-old")));
  } finally {
    cleanupFixture(p);
  }
  // (b) 目标不存在：跳过（不算失败）→ 退出 0，存在的类别照常清理
  const q = fixture();
  try {
    rmSync(q.bffDb);
    rmSync(q.work, { recursive: true });
    const r = runCli(q, ["--apply"]);
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stdout, /跳过/);
    assert.match(r.stdout, /库不存在/);
    assert.match(r.stdout, /目录不存在/);
    assert.deepEqual(gwRunIds(q), ["run-boundary", "run-new"]);
    assert.ok(!existsSync(join(q.results, "sess-old")));
  } finally {
    cleanupFixture(q);
  }
});

test("parseArgs：CLI 参数 > env > 生产缺省；默认 dry-run；用法错误抛 UsageError", () => {
  const env = { GW_DB_PATH: "E:/env/gw.db" };
  // env 覆盖生产缺省
  assert.equal(parseArgs([], env).gatewayDb, "E:\\env\\gw.db");
  // CLI 参数覆盖 env
  assert.equal(parseArgs(["--gateway-db", "C:/x/g.db"], env).gatewayDb, "C:\\x\\g.db");
  // 无 env 无参数 → 生产缺省
  const d = parseArgs([], {});
  assert.equal(d.gatewayDb, parseArgs([], {}).gatewayDb);
  const norm = (s) => s.replaceAll("/", "\\");
  for (const [k, v] of Object.entries(PROD_DEFAULTS)) {
    assert.equal(norm(d[k]), norm(v), `${k} 缺省应为生产值`);
  }
  // 默认 dry-run + now 缺省取当前时钟
  assert.equal(d.mode, "dry-run");
  assert.ok(Math.abs(d.now - Date.now()) < 60_000);
  // 用法错误
  assert.throws(() => parseArgs(["--now", "abc"]), UsageError);
  assert.throws(() => parseArgs(["--bogus"]), UsageError);
  assert.throws(() => parseArgs(["--apply", "--dry-run"]), UsageError);
  assert.throws(() => parseArgs(["--gateway-db"]), UsageError);
});

test("用法错误的 CLI 退出码：--help=0，未知参数/--now 非法/--apply 与 --dry-run 冲突=2（删除前拦截）", () => {
  const p = fixture();
  try {
    const help = spawnSync(process.execPath, [SCRIPT, "--help"], { encoding: "utf8" });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /--apply/);
    for (const bad of [["--bogus"], ["--now", "yesterday"], ["--apply", "--dry-run"], ["--now"]]) {
      const r = spawnSync(process.execPath, [SCRIPT, ...bad, "--gateway-db", p.gatewayDb], { encoding: "utf8" });
      assert.equal(r.status, 2, `args=${bad.join(" ")} 应退出 2`);
      assert.match(r.stderr, /用法/);
    }
    // 用法错误发生在任何删除之前
    assert.deepEqual(gwRunIds(p), ["run-boundary", "run-new", "run-old"]);
  } finally {
    cleanupFixture(p);
  }
});

test("isInside 路径围栏：根内真包含才放行，自身/同级前缀/越界均拒绝（大小写不敏感）", () => {
  assert.ok(isInside("D:/root", "D:/root/child"));
  assert.ok(isInside("D:\\Root", "d:\\root\\CHILD"));
  assert.ok(isInside("D:\\", "D:\\anywhere")); // 盘符根
  assert.ok(!isInside("D:/root", "D:/root")); // 根自身不可删
  assert.ok(!isInside("D:/root", "D:/root2/x")); // 同级前缀
  assert.ok(!isInside("D:/root", "E:/root/child"));
});
