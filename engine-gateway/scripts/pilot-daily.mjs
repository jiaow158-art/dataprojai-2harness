#!/usr/bin/env node
// M3-T3 试点日报（只读）——网关 gateway.db 任务/事件全量汇总，BFF bff.db 用户面。
// 无参数运行，汇总"截至当前"，markdown 写 eval_results/pilot/daily-<yyyymmdd>.md
// （目录不存在则建；目录相对本仓库根）并同步打到 stdout。
//
// 用法：node scripts/pilot-daily.mjs
//
// 红线：两库一律 { readonly: true } 打开，脚本无任何写路径（唯一写动作是
// eval_results/ 下的日报文件本身）；不打印密钥（BFF 登录 token 只显示前 6 位）。
// 失败归因入口：`node scripts/audit.mjs --run <run_id>` 查单任务全轨迹。

import Database from "better-sqlite3";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const GATEWAY_DB = "D:/m0-sessions/prod/gateway.db";
const BFF_DB = "D:/dataplat-ui/server/data-prod/bff.db";
const OUT_DIR = join(fileURLToPath(new URL("../../eval_results/pilot/", import.meta.url)));

const pad = (n) => String(n).padStart(2, "0");
const fmtTs = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const fmtInt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const fmtDur = (ms) =>
  ms == null ? "—" : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60000)}m${pad(Math.round((ms % 60000) / 1000))}s`;
const oneLine = (s, n) =>
  s == null ? "—" : String(s).replace(/\s+/g, " ").replace(/\|/g, "\\|").slice(0, n) + (String(s).length > n ? "…" : "");
const maskToken = (t) => `${t.slice(0, 6)}…`;

const now = Date.now();
const today = dayKey(now);

let gw;
try {
  gw = new Database(GATEWAY_DB, { readonly: true });
} catch (err) {
  console.error(`网关库不可读（${GATEWAY_DB}）：${err.message}`);
  process.exit(1);
}
let bff = null;
try {
  bff = new Database(BFF_DB, { readonly: true });
} catch (err) {
  process.stderr.write(`（BFF 库不可读：${err.message}——用户面数据省略）\n`);
}

// ---------- 网关汇总 ----------

const tasks = gw.prepare("SELECT * FROM tasks ORDER BY created_at, rowid").all();
const byStatus = {};
for (const t of tasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
const nOf = (s) => byStatus[s] ?? 0;
const terminal = nOf("succeeded") + nOf("failed") + nOf("cancelled");
const successRate = terminal > 0 ? ((nOf("succeeded") / terminal) * 100).toFixed(1) : "—";

// done 事件 tokens（每 run 一条；无 done 的任务计入不了 tokens，属预期）
const doneRows = gw.prepare("SELECT run_id, payload FROM events WHERE type = 'done'").all();
const tokens = { input: 0, output: 0, cache_read: 0 };
const tokensByRun = new Map();
for (const r of doneRows) {
  try {
    const tk = JSON.parse(r.payload)?.tokens ?? {};
    tokens.input += tk.input ?? 0;
    tokens.output += tk.output ?? 0;
    tokens.cache_read += tk.cache_read ?? 0;
    tokensByRun.set(r.run_id, tk);
  } catch {
    /* 非法 payload 跳过（计数不动） */
  }
}

const failed = tasks.filter((t) => t.status === "failed" || t.status === "cancelled");
const failByCode = {};
for (const t of failed) {
  const k = t.error_code ?? "(无 error_code)";
  (failByCode[k] ??= []).push(t);
}

const users = [...new Set(tasks.map((t) => t.user))];
const perUser = users
  .map((u) => {
    const ts = tasks.filter((t) => t.user === u);
    const tk = { input: 0, output: 0, cache_read: 0 };
    for (const t of ts) {
      const x = tokensByRun.get(t.run_id);
      if (x) {
        tk.input += x.input ?? 0;
        tk.output += x.output ?? 0;
        tk.cache_read += x.cache_read ?? 0;
      }
    }
    return { user: u, n: ts.length, s: ts.filter((t) => t.status === "succeeded").length, f: ts.filter((t) => t.status === "failed").length, c: ts.filter((t) => t.status === "cancelled").length, tk };
  })
  .sort((a, b) => b.n - a.n);

const todayTasks = tasks.filter((t) => dayKey(t.created_at) === today);

// ---------- 输出 ----------

const L = [];
L.push(`# 试点日报 · 截至 ${fmtTs(now)}`, "");
L.push(`> 数据源（只读）：${GATEWAY_DB}${bff ? ` + ${BFF_DB}` : ""}`);
L.push("");
L.push(`## 汇总`);
L.push(`- 任务总量 **${tasks.length}**：succeeded ${nOf("succeeded")} / failed ${nOf("failed")} / cancelled ${nOf("cancelled")} / running ${nOf("running")} / queued ${nOf("queued")}`);
L.push(`- 成功率（succeeded ÷ 已终态 ${terminal}）：**${successRate}%**`);
L.push(`- 今日新增（${today}）：**${todayTasks.length}** 条${todayTasks.length ? `（${[...new Set(todayTasks.map((t) => t.user))].join("、")}）` : ""}`);
L.push(`- 活跃用户 **${users.length}** 人 · 人均 ${(tasks.length / Math.max(users.length, 1)).toFixed(1)} 任务`);
L.push(`- tokens 合计（done 事件累计）：input ${fmtInt(tokens.input)} / output ${fmtInt(tokens.output)} / cache_read ${fmtInt(tokens.cache_read)}`);
L.push("");
L.push(`## 失败/取消 按 error_code 分布`);
L.push("");
L.push(`| error_code | 条数 | error_message 样例 |`);
L.push(`|---|---:|---|`);
if (Object.keys(failByCode).length === 0) L.push(`| — | 0 | 无 |`);
for (const [code, ts] of Object.entries(failByCode)) {
  const sample = ts.find((t) => t.error_message)?.error_message;
  L.push(`| ${code === "(无 error_code)" ? code : `\`${code}\``} | ${ts.length} | ${oneLine(sample, 80)} |`);
}
L.push("");
L.push(`## 失败任务清单（逐例归因：\`node scripts/audit.mjs --run <run_id>\`）`);
L.push("");
L.push(`| run_id | 用户 | 问题 | error_code | attempt | 创建 |`);
L.push(`|---|---|---|---|---:|---|`);
if (failed.length === 0) L.push(`| — | — | 无失败/取消任务 | — | — | — |`);
for (const t of failed) {
  L.push(`| \`${t.run_id}\` | ${t.user} | ${oneLine(t.question, 40)} | ${t.error_code ? `\`${t.error_code}\`` : "—"} | ${t.attempt} | ${fmtTs(t.created_at)} |`);
}
L.push("");
L.push(`## 用户面`);
L.push("");
L.push(`| 用户 | 任务 | 成 | 败 | 取消 | tokens(in/out/cache_read) |`);
L.push(`|---|---:|---:|---:|---:|---|`);
for (const u of perUser) {
  L.push(`| ${u.user} | ${u.n} | ${u.s} | ${u.f} | ${u.c} | ${fmtInt(u.tk.input)} / ${fmtInt(u.tk.output)} / ${fmtInt(u.tk.cache_read)} |`);
}
if (bff) {
  const todayUsers = bff
    .prepare("SELECT username, created_at FROM users WHERE created_at >= ? AND created_at < ? ORDER BY created_at")
    .all(new Date(`${today}T00:00:00`).getTime(), new Date(`${today}T00:00:00`).getTime() + 86400000);
  const live = bff.prepare("SELECT username, COUNT(*) n, MAX(expires_at) maxExp FROM sessions GROUP BY username ORDER BY username").all();
  const neverAsked = bff.prepare("SELECT username FROM users").all().map((u) => u.username).filter((u) => !users.includes(u));
  L.push("");
  L.push(`- BFF 账号今日开户 ${todayUsers.length} 人${todayUsers.length ? `：${todayUsers.map((u) => u.username).join("、")}` : ""}`);
  L.push(`- 存活登录会话：${live.map((s) => `${s.username}×${s.n}（最晚到期 ${fmtTs(s.maxExp)}）`).join("、") || "无"}`);
  L.push(`- 已开户但零任务：${neverAsked.join("、") || "无"}`);
}
L.push("");
L.push(`## 今日行为一览（${today}）`);
L.push("");
L.push(`| 时间 | 用户 | 问题 | 终态 | SQL | 耗时 |`);
L.push(`|---|---|---|---|---|---|`);
if (todayTasks.length === 0) L.push(`| — | — | 今日无任务 | — | — | — |`);
for (const t of todayTasks) {
  const sql = gw.prepare("SELECT COUNT(*) n FROM events WHERE run_id = ? AND type = 'sql'").get(t.run_id).n;
  const doneRow = doneRows.find((r) => r.run_id === t.run_id);
  let elapsed = t.updated_at - t.created_at;
  try {
    if (doneRow) elapsed = JSON.parse(doneRow.payload)?.elapsed_ms ?? elapsed;
  } catch {
    /* 保持 wall 时长 */
  }
  L.push(`| ${fmtTs(t.created_at).slice(11)} | ${t.user} | ${oneLine(t.question, 40)} | ${t.status}${t.error_code ? `(\`${t.error_code}\`)` : ""} | ×${sql} | ${fmtDur(elapsed)} |`);
}
L.push("");
const md = L.join("\n");

mkdirSync(OUT_DIR, { recursive: true });
const outFile = join(OUT_DIR, `daily-${today.replace(/-/g, "")}.md`);
writeFileSync(outFile, md, "utf8");
process.stderr.write(`已写入 ${outFile}\n`);
console.log(md);
gw.close();
bff?.close();
