#!/usr/bin/env node
// M3-T3.5 试点期审计查询（只读）——网 gateway.db（tasks/events/publications）
// + BFF bff.db（users/sessions/ui_sessions/messages）拼成时间线，markdown 输出到 stdout。
//
// 用法（输出重定向存档：> audit-xxx.md）：
//   node scripts/audit.mjs --user pilot-01 [--since 2026-09-20]
//   node scripts/audit.mjs --run <run_id>
//   node scripts/audit.mjs --date 2026-09-20
//
// 红线：两库一律 { readonly: true } 打开，脚本无任何写路径；不打印密钥
// （BFF 登录 token 只显示前 6 位；users.password_hash 永不查询）。
//
// Schema 实测备注（2026-09-20，与 db.ts/task-store.ts 一致）：
//   gateway.tasks/events/publications 时间戳均为 ms epoch；
//   events.type ∈ {stage, sql, answer, report, error, done}，payload 为 JSON 字符串；
//   BFF sessions 表无 created_at，登出/过期即 DELETE——历史登录不可考，
//   存活会话的登录时间由 expires_at − SESSION_TTL_MS(7d，app.ts:39 固定) 精确反推。

import Database from "better-sqlite3";

const GATEWAY_DB = "D:/m0-sessions/prod/gateway.db";
const BFF_DB = "D:/dataplat-ui/server/data-prod/bff.db";
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

// ---------- 参数解析（argparse 风格手写） ----------

function usage() {
  console.error(`用法：
  node scripts/audit.mjs --user <name> [--since YYYY-MM-DD]   该用户全部任务 + BFF 登录/会话时间线
  node scripts/audit.mjs --run <run_id>                       单任务全轨迹（任务行 + 事件流 + BFF 关联）
  node scripts/audit.mjs --date YYYY-MM-DD                    当日全部用户行为一览`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) usage();
      return argv[++i];
    };
    if (a === "--user") out.user = next();
    else if (a === "--run") out.run = next();
    else if (a === "--date") out.date = next();
    else if (a === "--since") out.since = next();
    else {
      console.error(`未知参数：${a}`);
      usage();
    }
  }
  const modes = ["user", "run", "date"].filter((k) => out[k] != null);
  if (modes.length !== 1) usage();
  for (const k of ["date", "since"]) {
    if (out[k] != null && !/^\d{4}-\d{2}-\d{2}$/.test(out[k])) {
      console.error(`--${k} 格式应为 YYYY-MM-DD`);
      process.exit(2);
    }
  }
  if (out.since != null && out.user == null) {
    console.error("--since 仅与 --user 搭配使用");
    process.exit(2);
  }
  return out;
}

// ---------- 只读开库 ----------

function openGateway() {
  try {
    return new Database(GATEWAY_DB, { readonly: true });
  } catch (err) {
    console.error(`网关库不可读（${GATEWAY_DB}）：${err.message}`);
    process.exit(1);
  }
}

function openBff() {
  try {
    return new Database(BFF_DB, { readonly: true });
  } catch (err) {
    console.error(`# （BFF 库不可读：${err.message}——以下仅网关侧数据）`);
    return null;
  }
}

// ---------- 格式化 ----------

const pad = (n) => String(n).padStart(2, "0");
const fmtTs = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const fmtClock = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const fmtDur = (ms) =>
  ms == null ? "—" : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60000)}m${pad(Math.round((ms % 60000) / 1000))}s`;
const fmtInt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
/** 压成单行、转义表格竖线、截断。 */
const oneLine = (s, n) =>
  s == null ? "—" : String(s).replace(/\s+/g, " ").replace(/\|/g, "\\|").slice(0, n) + (String(s).length > n ? "…" : "");
const maskToken = (t) => `${t.slice(0, 6)}…`;

// ---------- 网关查询 ----------

function eventsOf(db, runId) {
  return db
    .prepare("SELECT seq, type, payload, created_at FROM events WHERE run_id = ? ORDER BY seq")
    .all(runId)
    .map((r) => {
      let p = null;
      try {
        p = JSON.parse(r.payload);
      } catch {
        /* payload 非法时保留 null，渲染走原始截断 */
      }
      return { seq: r.seq, type: r.type, p, raw: r.payload, created_at: r.created_at };
    });
}

function taskDigest(db, t) {
  const evs = eventsOf(db, t.run_id);
  const sqls = evs.filter((e) => e.type === "sql");
  const done = evs.find((e) => e.type === "done");
  const answer = [...evs].reverse().find((e) => e.type === "answer");
  const report = db.prepare("SELECT report_path FROM publications WHERE run_id = ?").get(t.run_id);
  const reportPath =
    report?.report_path ?? evs.find((e) => e.type === "report")?.p?.path ?? null;
  const elapsed = done?.p?.elapsed_ms ?? t.updated_at - t.created_at;
  return {
    evs,
    sqlCount: sqls.length,
    rowsSeq: sqls.map((e) => `${e.p?.rows ?? "?"}${e.p?.truncated ? "*" : ""}`),
    elapsed,
    elapsedSource: done ? "done" : "wall",
    tokens: done?.p?.tokens ?? null,
    answer: answer?.p?.markdown ?? null,
    reportPath,
  };
}

// ---------- BFF 查询 ----------

function bffUserEvents(bff, username, sinceDay) {
  const out = [];
  const push = (ts, kind, text) => {
    if (sinceDay == null || dayKey(ts) >= sinceDay) out.push({ ts, kind, text });
  };
  const u = bff.prepare("SELECT username, created_at FROM users WHERE username = ?").get(username);
  if (u) push(u.created_at, "开户（BFF）", `账号 ${u.username} 创建`);
  for (const s of bff.prepare("SELECT token, expires_at FROM sessions WHERE username = ?").all(username)) {
    push(s.expires_at - SESSION_TTL_MS, "登录（BFF 存活会话，时间反推）", `token ${maskToken(s.token)} · 有效期至 ${fmtTs(s.expires_at)}`);
  }
  for (const s of bff.prepare("SELECT id, title, created_at FROM ui_sessions WHERE username = ?").all(username)) {
    push(s.created_at, "新会话（BFF）", `「${oneLine(s.title, 30)}」 ${s.id.slice(0, 11)}…`);
  }
  return out;
}

function bffLiveSessionsLine(bff, username) {
  const rows = bff.prepare("SELECT token, expires_at FROM sessions WHERE username = ?").all(username);
  if (rows.length === 0) return "无存活会话（未登录或已登出/过期——历史登录不落库，不可考）";
  return rows.map((s) => `token ${maskToken(s.token)} · 登录 ${fmtTs(s.expires_at - SESSION_TTL_MS)}（反推） · 有效期至 ${fmtTs(s.expires_at)}`).join("；");
}

// ---------- 渲染：--run ----------

function eventSummary(e) {
  const p = e.p;
  switch (e.type) {
    case "stage": {
      if (p?.to) return `${p.stage ?? "?"}→${p.to}（attempt ${p.attempt ?? "?"}）`;
      return p?.text ? `${p.stage ?? "?"} · ${oneLine(p.text, 90)}` : `${p.stage ?? "?"}`;
    }
    case "sql":
      return `${oneLine(p?.sql, 100)} → rows=${p?.rows ?? "?"}${p?.truncated ? "（截断）" : ""} · ${fmtDur(p?.elapsed_ms)} · ref ${p?.result_ref ?? "—"}`;
    case "answer":
      return `markdown ${fmtInt((p?.markdown ?? "").length)} 字 · ${oneLine(p?.markdown, 100)}`;
    case "report":
      return `${p?.path ?? "?"}`;
    case "error":
      return `${p?.code ?? "?"} · ${oneLine(p?.message, 120)}`;
    case "done": {
      const tk = p?.tokens;
      const tkStr = tk ? ` · tokens in ${fmtInt(tk.input ?? 0)} / out ${fmtInt(tk.output ?? 0)} / cache_read ${fmtInt(tk.cache_read ?? 0)}` : "";
      return `${p?.status ?? "?"} · engine ${p?.engine ?? "?"} · ${fmtDur(p?.elapsed_ms)}${tkStr}${p?.recovered ? " · recovered" : ""}`;
    }
    default:
      return oneLine(e.raw, 120);
  }
}

function renderRun(gw, bff, runId) {
  const t = gw.prepare("SELECT * FROM tasks WHERE run_id = ?").get(runId);
  if (!t) {
    console.error(`tasks 中无此 run_id：${runId}`);
    process.exit(1);
  }
  const d = taskDigest(gw, t);
  const L = [];
  L.push(`# 审计 · 单任务全轨迹`, "");
  L.push(`- run_id：\`${t.run_id}\``);
  L.push(`- 用户 / 逻辑会话 / scope：${t.user} / \`${t.session_id}\` / ${t.scope_group}`);
  L.push(`- 问题：${oneLine(t.question, 200)}`);
  L.push(`- 终态：**${t.status}** · attempt ${t.attempt} · 最终 stage ${t.stage ?? "—"} · 耗时 ${fmtDur(d.elapsed)}（${d.elapsedSource}）`);
  L.push(`- 创建 ${fmtTs(t.created_at)} · 更新 ${fmtTs(t.updated_at)} · deadline ${t.deadline ? fmtTs(t.deadline) : "—"}`);
  L.push(`- error：${t.error_code ? `\`${t.error_code}\` ${oneLine(t.error_message, 120)}` : "—"}`);
  L.push(`- 报告：${d.reportPath ?? "—"}`);
  L.push("");
  L.push(`## 事件流（${d.evs.length} 条）`, "");
  L.push(`| seq | 时间 | 类型 | 要点 |`);
  L.push(`|---:|---|---|---|`);
  for (const e of d.evs) L.push(`| ${e.seq} | ${fmtClock(e.created_at)} | ${e.type} | ${eventSummary(e)} |`);
  if (bff) {
    L.push("");
    L.push(`## BFF 关联`, "");
    const msg = bff.prepare("SELECT * FROM messages WHERE run_id = ?").get(runId);
    if (msg) {
      const us = bff.prepare("SELECT * FROM ui_sessions WHERE id = ?").get(msg.ui_session_id);
      L.push(`- UI 会话：${us ? `「${oneLine(us.title, 40)}」（${us.id}，创建 ${fmtTs(us.created_at)}）` : "（ui_session 已删除）"}`);
      L.push(`- 消息记账：${msg.id} · 状态 ${msg.status} · 创建 ${fmtTs(msg.created_at)} · report_path ${msg.report_path ?? "—"}`);
    } else {
      L.push(`- 无消息记账（非 UI 提交，或 BFF 记账缺失）`);
    }
    L.push(`- 该用户存活登录会话：${bffLiveSessionsLine(bff, t.user)}`);
  }
  L.push("");
  return L.join("\n");
}

// ---------- 渲染：--user ----------

function taskCard(t, d) {
  const L = [];
  L.push(`### ${fmtTs(t.created_at)} · ${oneLine(t.question, 40)}`);
  L.push(`- run_id \`${t.run_id.slice(0, 16)}…\` · 终态 **${t.status}** · attempt ${t.attempt} · 耗时 ${fmtDur(d.elapsed)}（${d.elapsedSource}）`);
  L.push(`- SQL×${d.sqlCount} rows=[${d.rowsSeq.join(",")}] · 报告 ${d.reportPath ? `\`${d.reportPath}\`` : "—"}`);
  if (t.error_code) L.push(`- error_code \`${t.error_code}\` ${oneLine(t.error_message, 100)}`);
  if (d.answer) L.push(`- 答案摘要：${oneLine(d.answer, 120)}`);
  return L.join("\n");
}

function renderUser(gw, bff, username, sinceDay) {
  let tasks = gw.prepare("SELECT * FROM tasks WHERE user = ? ORDER BY created_at, rowid").all(username);
  if (sinceDay != null) tasks = tasks.filter((t) => dayKey(t.created_at) >= sinceDay);
  const byStatus = {};
  for (const t of tasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
  const L = [];
  L.push(`# 审计 · 用户 ${username}${sinceDay ? `（since ${sinceDay}）` : ""}`);
  L.push("");
  L.push(`> 生成于 ${fmtTs(Date.now())} · 网关库 ${GATEWAY_DB} · 只读`);
  L.push("");
  L.push(`## 总览`);
  L.push(`- 任务 ${tasks.length} 条：${Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(" / ") || "无"}`);
  if (bff) {
    const u = bff.prepare("SELECT created_at FROM users WHERE username = ?").get(username);
    L.push(`- BFF 开户：${u ? fmtTs(u.created_at) : "无此账号（任务可能来自脚本直连网关）"}`);
    const uiSess = bff.prepare("SELECT COUNT(*) n FROM ui_sessions WHERE username = ?").get(username).n;
    L.push(`- UI 会话 ${uiSess} 个 · 存活登录会话：${bffLiveSessionsLine(bff, username)}`);
  }
  L.push("");
  // 时间线：网关任务卡 + BFF 记录（开户/登录/新会话）按时间排序
  const bffEvents = bff ? bffUserEvents(bff, username, sinceDay) : [];
  const merged = [
    ...tasks.map((t) => ({ ts: t.created_at, card: true, t })),
    ...bffEvents.map((e) => ({ ts: e.ts, card: false, e })),
  ].sort((a, b) => a.ts - b.ts);
  L.push(`## 时间线（任务 + BFF 记录）`, "");
  if (merged.length === 0) L.push("（无记录）");
  for (const m of merged) {
    if (m.card) L.push(taskCard(m.t, taskDigest(gw, m.t)), "");
    else L.push(`### ${fmtTs(m.ts)} · ${m.e.kind}`, `${m.e.text}`, "");
  }
  return L.join("\n");
}

// ---------- 渲染：--date ----------

function renderDate(gw, bff, date) {
  const tasks = gw.prepare("SELECT * FROM tasks ORDER BY created_at, rowid").all().filter((t) => dayKey(t.created_at) === date);
  const byStatus = {};
  const byUser = {};
  for (const t of tasks) {
    byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
    byUser[t.user] = (byUser[t.user] ?? 0) + 1;
  }
  const L = [];
  L.push(`# 审计 · ${date} 当日行为一览`);
  L.push("");
  L.push(`> 生成于 ${fmtTs(Date.now())} · 只读`);
  L.push("");
  L.push(`## 总览`);
  L.push(`- 任务 ${tasks.length} 条：${Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(" / ") || "无"}`);
  L.push(`- 活跃用户 ${Object.keys(byUser).length} 人：${Object.entries(byUser).map(([u, n]) => `${u}(${n})`).join("、") || "无"}`);
  if (bff) {
    const newUsers = bff.prepare("SELECT username, created_at FROM users WHERE created_at >= ? AND created_at < ? ORDER BY created_at").all(
      new Date(`${date}T00:00:00`).getTime(),
      new Date(`${date}T00:00:00`).getTime() + 86400000,
    );
    const liveCnt = bff.prepare("SELECT username, COUNT(*) n FROM sessions GROUP BY username").all();
    L.push(`- BFF 当日开户 ${newUsers.length} 人${newUsers.length ? `：${newUsers.map((u) => u.username).join("、")}` : ""}`);
    L.push(`- BFF 存活登录会话（不限于当日）：${liveCnt.map((s) => `${s.username}×${s.n}`).join("、") || "无"}`);
  }
  L.push("");
  L.push(`## 时间线`);
  L.push("");
  L.push(`| 时间 | 来源 | 用户 | 事件 |`);
  L.push(`|---|---|---|---|`);
  const rows = tasks.map((t) => {
    const d = taskDigest(gw, t);
    return {
      ts: t.created_at,
      line: `| ${fmtClock(t.created_at)} | 网关 | ${t.user} | 任务 ${oneLine(t.question, 40)} → **${t.status}** · attempt ${t.attempt} · SQL×${d.sqlCount} rows=[${d.rowsSeq.join(",")}] · ${fmtDur(d.elapsed)}${t.error_code ? ` · \`${t.error_code}\`` : ""} |`,
    };
  });
  if (bff) {
    for (const u of bff.prepare("SELECT username, created_at FROM users ORDER BY created_at").all()) {
      if (dayKey(u.created_at) === date) rows.push({ ts: u.created_at, line: `| ${fmtClock(u.created_at)} | BFF | ${u.username} | 开户 |` });
    }
    for (const s of bff.prepare("SELECT token, username, expires_at FROM sessions").all()) {
      const loginAt = s.expires_at - SESSION_TTL_MS;
      if (dayKey(loginAt) === date) rows.push({ ts: loginAt, line: `| ${fmtClock(loginAt)} | BFF | ${s.username} | 登录（存活会话 ${maskToken(s.token)}，时间反推） |` });
    }
    for (const s of bff.prepare("SELECT id, username, title, created_at FROM ui_sessions ORDER BY created_at").all()) {
      if (dayKey(s.created_at) === date) rows.push({ ts: s.created_at, line: `| ${fmtClock(s.created_at)} | BFF | ${s.username} | 新会话「${oneLine(s.title, 30)}」 |` });
    }
  }
  rows.sort((a, b) => a.ts - b.ts);
  if (rows.length === 0) L.push(`| — | — | — | 当日无记录 |`);
  for (const r of rows) L.push(r.line);
  L.push("");
  return L.join("\n");
}

// ---------- main ----------

const args = parseArgs(process.argv.slice(2));
const gw = openGateway();
const bff = openBff();
let md;
if (args.run != null) md = renderRun(gw, bff, args.run);
else if (args.user != null) md = renderUser(gw, bff, args.user, args.since);
else md = renderDate(gw, bff, args.date);
gw.close();
bff?.close();
console.log(md);
