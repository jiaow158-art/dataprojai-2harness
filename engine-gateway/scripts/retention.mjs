#!/usr/bin/env node
// M4 数据保留清理脚本 —— 分层保留策略（M4 T0 第 5 问裁定，保留期不得改值）：
//
//   | 数据                        | 位置                                   | 保留期 | 清理单位                            |
//   |-----------------------------|----------------------------------------|-------|-------------------------------------|
//   | 网关任务/事件流/发布记录      | gateway.db tasks/events/publications   | 180 天 | 按 tasks.created_at，级联删同 run_id |
//   | BFF 消息记账                 | bff.db messages                        | 180 天 | 按 created_at                        |
//   | BFF 登录史/管理留痕          | bff.db login_log/admin_audit           | 180 天 | 按 created_at                        |
//   | BFF UI 会话                  | bff.db ui_sessions                     |  90 天 | 按 updated_at（无则 created_at）      |
//   | 报告 HTML                    | reports/<user>/*.html                  |  90 天 | 按文件 mtime；空用户目录随手清        |
//   | 双通道结果文件               | results/<sessionId>/results/*.json     |  90 天 | 按 session 目录 mtime 整目录删       |
//   | 会话工作目录                 | work/<sessionId>/workdir               |  14 天 | 整 session 目录删                    |
//
// 用法：
//   node scripts/retention.mjs [--dry-run] [--apply] [--gateway-db <path>] [--bff-db <path>]
//                              [--reports <dir>] [--results <dir>] [--work <dir>] [--now <epoch-ms>]
//
// 安全红线：
//   * 路径优先级 CLI 参数 > env（GW_DB_PATH/BFF_DB_PATH/GATEWAY_REPORTS_DIR/GW_RESULTS_ROOT/
//     GW_WORKROOT）> 生产缺省（D:/m0-sessions/prod/* 与 D:/dataplat-ui/server/data-prod/bff.db）。
//     **缺省即生产值，但无 --apply 时永远 dry-run**：只打印将删清单与计数，不改任何东西
//     （DB 以 readonly 打开，不产生 -wal/-shm）。
//   * 每个删除目标 realpath 解析后必须严格落在对应根内——越界（符号链接/junction 逃逸、
//     realpath 失败）一律拒绝该项并报告；首层符号链接即使指向根内也不递归删除。
//   * DB 清理逐类独立事务（级联先子后主）；单类失败跳过并报告，不中断其余类别，
//     退出码 1 提示部分失败（跳过=目标不存在，不算失败）。

import Database from "better-sqlite3";
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync, rmdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const DAY_MS = 86_400_000;
const LIST_CAP = 20;
const DB_TIMEOUT_MS = 5_000;

/** 保留期（天）——M4 T0 第 5 问裁定：分层保留。不得改值。 */
export const RETENTION_DAYS = {
  gateway: 180,
  bffRows: 180,
  uiSessions: 90,
  reports: 90,
  results: 90,
  work: 14,
};

/** 路径缺省值 = 生产值（可被 env 覆盖，再被 CLI 参数覆盖）。 */
export const PROD_DEFAULTS = {
  gatewayDb: "D:/m0-sessions/prod/gateway.db",
  bffDb: "D:/dataplat-ui/server/data-prod/bff.db",
  reports: "D:/m0-sessions/prod/reports",
  results: "D:/m0-sessions/prod/results",
  work: "D:/m0-sessions/prod/work",
};

const USAGE = `用法：node scripts/retention.mjs [选项]
  --apply                真正执行删除（缺省永远 dry-run——只打印将删清单与计数，不改任何东西）
  --dry-run              显式 dry-run（与缺省等价；不可与 --apply 同用）
  --gateway-db <path>    网关 SQLite 路径（env GW_DB_PATH；缺省 ${PROD_DEFAULTS.gatewayDb}）
  --bff-db <path>        BFF SQLite 路径（env BFF_DB_PATH；缺省 ${PROD_DEFAULTS.bffDb}）
  --reports <dir>        报告根（env GATEWAY_REPORTS_DIR；缺省 ${PROD_DEFAULTS.reports}）
  --results <dir>        双通道结果根（env GW_RESULTS_ROOT；缺省 ${PROD_DEFAULTS.results}）
  --work <dir>           会话工作目录根（env GW_WORKROOT；缺省 ${PROD_DEFAULTS.work}）
  --now <epoch-ms>       注入基准时钟（测试用）
  -h, --help             本帮助

保留策略（M4 T0 第 5 问裁定，不得改值）：
  网关 tasks/events/publications 180 天（tasks.created_at，级联同 run_id）
  BFF messages/login_log/admin_audit 180 天（created_at）
  BFF ui_sessions 90 天（updated_at，无则 created_at）
  报告 HTML 与双通道结果 90 天（mtime）；会话工作目录 14 天

输出：markdown 摘要（每类删除行数/文件数/释放字节）到 stdout；退出码 0=全部成功，
1=存在错误或越界拒绝（单类跳过不中断），2=用法错误。`;

export class UsageError extends Error {}

// ---------- 参数解析 ----------

export function parseArgs(argv, env = process.env) {
  const out = { apply: false, dryRun: false, help: false, nowInjected: false };
  const need = (flag) => {
    const v = argv[++out._i];
    if (v === undefined || v.startsWith("--")) throw new UsageError(`${flag} 缺少参数值`);
    return v;
  };
  for (out._i = 0; out._i < argv.length; out._i++) {
    const a = argv[out._i];
    if (a === "--apply") out.apply = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else if (a === "--gateway-db") out.gatewayDb = need(a);
    else if (a === "--bff-db") out.bffDb = need(a);
    else if (a === "--reports") out.reports = need(a);
    else if (a === "--results") out.results = need(a);
    else if (a === "--work") out.work = need(a);
    else if (a === "--now") {
      const v = need(a);
      if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v))) {
        throw new UsageError(`--now 应为 epoch-ms 整数，得到：${v}`);
      }
      out.now = Number(v);
      out.nowInjected = true;
    } else throw new UsageError(`未知参数：${a}`);
  }
  delete out._i;
  if (out.apply && out.dryRun) throw new UsageError("--apply 与 --dry-run 不可同时使用");
  out.gatewayDb = resolve(out.gatewayDb ?? env.GW_DB_PATH ?? PROD_DEFAULTS.gatewayDb);
  out.bffDb = resolve(out.bffDb ?? env.BFF_DB_PATH ?? PROD_DEFAULTS.bffDb);
  out.reports = resolve(out.reports ?? env.GATEWAY_REPORTS_DIR ?? PROD_DEFAULTS.reports);
  out.results = resolve(out.results ?? env.GW_RESULTS_ROOT ?? PROD_DEFAULTS.results);
  out.work = resolve(out.work ?? env.GW_WORKROOT ?? PROD_DEFAULTS.work);
  if (out.now === undefined) out.now = Date.now();
  out.mode = out.apply ? "apply" : "dry-run";
  return out;
}

// ---------- 路径围栏 ----------

/** realpath 围栏：target 解析后必须严格位于 root 内（小写 + 斜杠归一——Windows 盘符/目录名
 *  大小写不敏感，正反斜杠等价；root 自身与同级前缀均不放行）。 */
export function isInside(rootReal, targetReal) {
  const norm = (p) => p.toLowerCase().replaceAll("/", "\\");
  const r = norm(rootReal);
  const t = norm(targetReal);
  return t.startsWith(r.endsWith(sep) ? r : r + sep);
}

function realpathSafe(p) {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

const cutoffOf = (now, days) => now - days * DAY_MS;

/** 目录树字节数（尽力统计；符号链接不计——删除时也不跟随）。 */
function treeSize(p) {
  let total = 0;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const q = join(dir, e.name);
      if (e.isDirectory()) walk(q);
      else {
        try {
          total += statSync(q).size;
        } catch {
          /* 尽力统计 */
        }
      }
    }
  };
  try {
    walk(p);
  } catch {
    /* 尽力统计 */
  }
  return total;
}

function mkCat(key, label, days, basis) {
  return { key, label, days, basis, status: "ok", counts: {}, bytes: 0, list: [], rejected: [], notes: [], errors: [], error: null };
}

// ---------- 类别 1：网关 tasks/events/publications（180 天，级联） ----------

function cleanupGateway(opts) {
  const c = mkCat("gateway", "网关任务/事件流/发布记录", RETENTION_DAYS.gateway, "tasks.created_at，级联删同 run_id 的 events+publications");
  if (!existsSync(opts.gatewayDb)) {
    c.status = "skipped";
    c.error = `库不存在：${opts.gatewayDb}`;
    return c;
  }
  const cutoff = cutoffOf(opts.now, c.days);
  let db;
  try {
    db = new Database(opts.gatewayDb, { readonly: true, timeout: DB_TIMEOUT_MS });
  } catch (err) {
    c.status = "error";
    c.error = `网关库打开失败：${err.message}`;
    return c;
  }
  try {
    c.list = db
      .prepare("SELECT run_id FROM tasks WHERE created_at < ? ORDER BY created_at, rowid")
      .all(cutoff)
      .map((r) => r.run_id);
    c.counts.tasks = c.list.length;
    c.counts.events = db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE run_id IN (SELECT run_id FROM tasks WHERE created_at < ?)")
      .get(cutoff).n;
    c.counts.publications = db
      .prepare("SELECT COUNT(*) AS n FROM publications WHERE run_id IN (SELECT run_id FROM tasks WHERE created_at < ?)")
      .get(cutoff).n;
  } catch (err) {
    c.status = "error";
    c.error = `网关库读取失败：${err.message}`;
    db.close();
    return c;
  }
  db.close();
  if (opts.mode === "apply") {
    let dbw;
    try {
      dbw = new Database(opts.gatewayDb, { timeout: DB_TIMEOUT_MS });
    } catch (err) {
      c.status = "error";
      c.error = `网关库写打开失败：${err.message}`;
      return c;
    }
    try {
      // 级联顺序先子后主：子查询依赖 tasks 行仍在，须在同一事务内先删 events/publications
      c.counts = dbw.transaction(() => ({
        events: dbw
          .prepare("DELETE FROM events WHERE run_id IN (SELECT run_id FROM tasks WHERE created_at < ?)")
          .run(cutoff).changes,
        publications: dbw
          .prepare("DELETE FROM publications WHERE run_id IN (SELECT run_id FROM tasks WHERE created_at < ?)")
          .run(cutoff).changes,
        tasks: dbw.prepare("DELETE FROM tasks WHERE created_at < ?").run(cutoff).changes,
      }))();
    } catch (err) {
      c.status = "error";
      c.error = `网关库删除失败（事务已回滚）：${err.message}`;
    } finally {
      dbw.close();
    }
  }
  return c;
}

// ---------- 类别 2-5：BFF 三类表 ----------

const BFF_TABLES = [
  { key: "bff-messages", label: "BFF 消息记账", days: RETENTION_DAYS.bffRows, basis: "messages.created_at", table: "messages", expr: "created_at", idCol: "run_id" },
  { key: "bff-login-log", label: "BFF 登录史（login_log）", days: RETENTION_DAYS.bffRows, basis: "login_log.created_at", table: "login_log", expr: "created_at", idCol: "id" },
  { key: "bff-admin-audit", label: "BFF 管理留痕（admin_audit）", days: RETENTION_DAYS.bffRows, basis: "admin_audit.created_at", table: "admin_audit", expr: "created_at", idCol: "id" },
  { key: "bff-ui-sessions", label: "BFF UI 会话", days: RETENTION_DAYS.uiSessions, basis: "ui_sessions：updated_at（无则 created_at）", table: "ui_sessions", expr: "COALESCE(updated_at, created_at)", idCol: "id" },
];

function cleanupBffTable(opts, cfg) {
  const c = mkCat(cfg.key, cfg.label, cfg.days, cfg.basis);
  if (!existsSync(opts.bffDb)) {
    c.status = "skipped";
    c.error = `库不存在：${opts.bffDb}`;
    return c;
  }
  const cutoff = cutoffOf(opts.now, c.days);
  let db;
  try {
    db = new Database(opts.bffDb, { readonly: true, timeout: DB_TIMEOUT_MS });
  } catch (err) {
    c.status = "error";
    c.error = `BFF 库打开失败：${err.message}`;
    return c;
  }
  try {
    c.list = db
      .prepare(`SELECT ${cfg.idCol} AS id FROM ${cfg.table} WHERE ${cfg.expr} < ? ORDER BY rowid`)
      .all(cutoff)
      .map((r) => r.id);
    c.counts[cfg.table] = c.list.length;
  } catch (err) {
    c.status = "error";
    c.error = `BFF 库读取失败（${cfg.table}）：${err.message}`;
    db.close();
    return c;
  }
  db.close();
  if (opts.mode === "apply") {
    let dbw;
    try {
      dbw = new Database(opts.bffDb, { timeout: DB_TIMEOUT_MS });
    } catch (err) {
      c.status = "error";
      c.error = `BFF 库写打开失败：${err.message}`;
      return c;
    }
    try {
      c.counts[cfg.table] = dbw
        .transaction(() => dbw.prepare(`DELETE FROM ${cfg.table} WHERE ${cfg.expr} < ?`).run(cutoff).changes)();
    } catch (err) {
      c.status = "error";
      c.error = `BFF 删除失败（事务已回滚，${cfg.table}）：${err.message}`;
    } finally {
      dbw.close();
    }
  }
  return c;
}

// ---------- 类别 6：报告 HTML（90 天，文件 mtime；空用户目录随手清） ----------

function cleanupReports(opts) {
  const c = mkCat("reports", "报告 HTML", RETENTION_DAYS.reports, "reports/<user>/*.html 文件 mtime；空用户目录随手清");
  if (!existsSync(opts.reports)) {
    c.status = "skipped";
    c.error = `目录不存在：${opts.reports}`;
    return c;
  }
  const rootReal = realpathSafe(opts.reports);
  if (rootReal == null) {
    c.status = "error";
    c.error = `根目录不可解析：${opts.reports}`;
    return c;
  }
  const cutoff = cutoffOf(opts.now, c.days);
  const victims = [];
  const emptyDirs = [];
  let level1;
  try {
    level1 = readdirSync(opts.reports, { withFileTypes: true });
  } catch (err) {
    c.status = "error";
    c.error = `扫描失败：${err.message}`;
    return c;
  }
  for (const e1 of level1) {
    const userDir = join(opts.reports, e1.name);
    const real = realpathSafe(userDir);
    if (real == null || !isInside(rootReal, real)) {
      c.rejected.push(`${e1.name} → ${real ?? "(realpath 失败)"}`);
      continue;
    }
    let lst;
    try {
      lst = lstatSync(userDir);
    } catch {
      continue;
    }
    if (lst.isSymbolicLink()) {
      c.notes.push(`${e1.name}：符号链接，跳过（不递归删）`);
      continue;
    }
    if (!lst.isDirectory()) {
      c.notes.push(`${e1.name}：非目录，跳过`);
      continue;
    }
    let level2;
    try {
      level2 = readdirSync(userDir, { withFileTypes: true });
    } catch (err) {
      c.notes.push(`${e1.name}：读取失败 ${err.message}`);
      continue;
    }
    const hits = [];
    for (const e2 of level2) {
      if (!e2.isFile() || !e2.name.endsWith(".html")) continue; // 非 html/子目录/链接不动，但计入判空
      const f = join(userDir, e2.name);
      try {
        const st = statSync(f);
        if (st.mtimeMs < cutoff) hits.push({ rel: `${e1.name}/${e2.name}`, path: f, size: st.size });
      } catch (err) {
        c.notes.push(`${e1.name}/${e2.name}：stat 失败 ${err.message}`);
      }
    }
    victims.push(...hits);
    if (level2.length === hits.length) emptyDirs.push({ rel: e1.name, path: userDir }); // 删后为空（含本来就空）
  }
  c.counts.files = victims.length;
  c.counts.emptyDirs = emptyDirs.length;
  c.bytes = victims.reduce((s, v) => s + v.size, 0);
  c.list = victims.map((v) => v.rel);
  for (const d of emptyDirs) c.notes.push(`空用户目录随清：${d.rel}`);
  if (opts.mode === "apply") {
    for (const v of victims) {
      try {
        rmSync(v.path);
      } catch (err) {
        c.errors.push(`删除失败 ${v.rel}：${err.message}`);
      }
    }
    for (const d of emptyDirs) {
      try {
        rmdirSync(d.path); // 仅空目录可删（ENOTEMPTY 即并发写入，留待下轮）
      } catch (err) {
        c.notes.push(`空目录未清 ${d.rel}：${err.message}`);
      }
    }
  }
  return c;
}

// ---------- 类别 7/8：results 与 work 的 session 目录树 ----------

function cleanupSessionTree(opts, rootPath, key, label, days, basis) {
  const c = mkCat(key, label, days, basis);
  if (!existsSync(rootPath)) {
    c.status = "skipped";
    c.error = `目录不存在：${rootPath}`;
    return c;
  }
  const rootReal = realpathSafe(rootPath);
  if (rootReal == null) {
    c.status = "error";
    c.error = `根目录不可解析：${rootPath}`;
    return c;
  }
  const cutoff = cutoffOf(opts.now, c.days);
  let entries;
  try {
    entries = readdirSync(rootPath, { withFileTypes: true });
  } catch (err) {
    c.status = "error";
    c.error = `扫描失败：${err.message}`;
    return c;
  }
  const victims = [];
  for (const e of entries) {
    const p = join(rootPath, e.name);
    const real = realpathSafe(p);
    if (real == null || !isInside(rootReal, real)) {
      c.rejected.push(`${e.name} → ${real ?? "(realpath 失败)"}`);
      continue;
    }
    let lst;
    try {
      lst = lstatSync(p);
    } catch {
      continue;
    }
    if (lst.isSymbolicLink()) {
      c.notes.push(`${e.name}：符号链接，跳过（不递归删）`);
      continue;
    }
    if (!lst.isDirectory()) {
      c.notes.push(`${e.name}：非目录，跳过`);
      continue;
    }
    if (lst.mtimeMs < cutoff) victims.push({ rel: e.name, path: p, bytes: treeSize(p) });
  }
  c.counts.dirs = victims.length;
  c.bytes = victims.reduce((s, v) => s + v.bytes, 0);
  c.list = victims.map((v) => v.rel);
  if (opts.mode === "apply") {
    for (const v of victims) {
      try {
        rmSync(v.path, { recursive: true }); // fs.rm 不跟随符号链接，只删链接本身
      } catch (err) {
        c.errors.push(`删除失败 ${v.rel}：${err.message}`);
      }
    }
  }
  return c;
}

// ---------- 汇总 ----------

export function runCleanup(opts) {
  const categories = [
    cleanupGateway(opts),
    ...BFF_TABLES.map((cfg) => cleanupBffTable(opts, cfg)),
    cleanupReports(opts),
    cleanupSessionTree(opts, opts.results, "results", "双通道结果文件", RETENTION_DAYS.results, "results/<sessionId>/ session 目录 mtime，整目录删"),
    cleanupSessionTree(opts, opts.work, "work", "会话工作目录", RETENTION_DAYS.work, "work/<sessionId>/ session 目录 mtime，整目录删"),
  ];
  const hasError = categories.some((c) => c.status === "error" || c.errors.length > 0 || c.rejected.length > 0);
  return {
    mode: opts.mode,
    now: opts.now,
    nowInjected: opts.nowInjected,
    paths: { gatewayDb: opts.gatewayDb, bffDb: opts.bffDb, reports: opts.reports, results: opts.results, work: opts.work },
    categories,
    exitCode: hasError ? 1 : 0,
  };
}

// ---------- markdown 渲染 ----------

const fmtInt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const pad2 = (n) => String(n).padStart(2, "0");
const fmtTs = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

function countsCell(c) {
  switch (c.key) {
    case "gateway":
      return `tasks ${c.counts.tasks} · events ${c.counts.events} · publications ${c.counts.publications}`;
    case "reports":
      return `${c.counts.files} 个文件${c.counts.emptyDirs ? ` · ${c.counts.emptyDirs} 个空目录` : ""}`;
    case "results":
    case "work":
      return `${c.counts.dirs} 个 session 目录`;
    default:
      return Object.entries(c.counts)
        .map(([t, n]) => `${t} ${n} 行`)
        .join(" · ") || "0";
  }
}

export function renderMarkdown(r) {
  const dry = r.mode !== "apply";
  const verb = dry ? "将删" : "已删";
  const L = [];
  L.push(dry ? "# 数据保留清理 · DRY-RUN（未删除任何数据）" : "# 数据保留清理 · APPLY（已执行删除）", "");
  L.push(
    `> 基准时间 now=${fmtTs(r.now)}${r.nowInjected ? "（--now 注入）" : ""} · 模式=${dry ? "dry-run（未传 --apply，不做任何修改）" : "apply（已执行删除）"}`,
    "",
  );
  L.push(`- 网关库：\`${r.paths.gatewayDb}\``);
  L.push(`- BFF 库：\`${r.paths.bffDb}\``);
  L.push(`- 报告根：\`${r.paths.reports}\``);
  L.push(`- 结果根：\`${r.paths.results}\``);
  L.push(`- 工作根：\`${r.paths.work}\``);
  L.push("", "## 汇总", "");
  L.push(`| 类别 | 保留期 | 清理口径 | ${verb} | 释放字节 |`);
  L.push("|---|---|---|---|---|");
  for (const c of r.categories) {
    let cell;
    if (c.status === "skipped") cell = `**跳过**（${c.error}）`;
    else if (c.status === "error" || c.errors.length > 0) {
      const msgs = [...(c.error ? [c.error] : ""), ...c.errors].filter(Boolean);
      cell = `**错误**（${msgs.join("；")}${msgs.length > 1 ? `（共 ${msgs.length} 项）` : ""}）`;
    } else cell = countsCell(c);
    const bytes = c.status === "ok" && c.bytes > 0 ? `${fmtInt(c.bytes)} B` : "—";
    L.push(`| ${c.label} | ${c.days} 天 | ${c.basis} | ${cell} | ${bytes} |`);
  }
  const withList = r.categories.filter((c) => c.list.length > 0);
  if (withList.length > 0) {
    L.push("", `## ${verb}清单（每类至多列 ${LIST_CAP} 项）`, "");
    for (const c of withList) {
      L.push(
        `- **${c.label}**（${c.list.length} 项）：${c.list.slice(0, LIST_CAP).map((s) => `\`${s}\``).join("、")}${
          c.list.length > LIST_CAP ? ` …等 ${c.list.length} 项` : ""
        }`,
      );
    }
  }
  const rejected = r.categories.filter((c) => c.rejected.length > 0);
  if (rejected.length > 0) {
    L.push("", "## ⚠ 越界拒绝（resolve 后不在对应根内，未删除）", "");
    for (const c of rejected) for (const x of c.rejected) L.push(`- ${c.label}：\`${x}\``);
  }
  const errored = r.categories.filter((c) => c.status === "error" || c.errors.length > 0);
  if (errored.length > 0) {
    L.push("", "## 错误（单类跳过，未中断其余类别）", "");
    for (const c of errored) {
      const msgs = [...(c.error ? [c.error] : ""), ...c.errors].filter(Boolean);
      L.push(`- ${c.label}：${msgs.join("；")}`);
    }
  }
  const noted = r.categories.filter((c) => c.notes.length > 0);
  if (noted.length > 0) {
    L.push("", "## 备注", "");
    for (const c of noted) for (const n of c.notes.slice(0, LIST_CAP)) L.push(`- ${c.label}：${n}`);
  }
  L.push("");
  return L.join("\n");
}

// ---------- CLI 入口（被 import 时不执行） ----------

export function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(err.message);
      console.error(USAGE);
      process.exit(2);
    }
    throw err;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  const report = runCleanup(opts);
  console.log(renderMarkdown(report));
  return report.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(main());
}
