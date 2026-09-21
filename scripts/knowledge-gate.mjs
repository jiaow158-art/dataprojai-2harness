#!/usr/bin/env node
// M4-C2 知识发布门——安装/台账/查询入口（钩子在 .githooks/，本文件提供共享逻辑）。
//
// 用法：
//   node scripts/knowledge-gate.mjs --install          # 设 core.hooksPath=.githooks（幂等）+ chmod 钩子
//   node scripts/knowledge-gate.mjs --record <sha> --state <file> --files "a b c"
//                                                       # post-commit 调：追加台账行
//   node scripts/knowledge-gate.mjs --history [n]      # 打印最近 n 条（默认 10）
//
// env：
//   KNOWLEDGE_GATE_LEDGER  台账路径（缺省 eval_results/knowledge-versions.jsonl；测试注入用）
//   KNOWLEDGE_EVAL_CMD     pre-commit 的 eval 命令替身（缺省 python run_eval.py；测试注入用）
//
// 台账行（JSONL）：{sha, ts, skills_hash, files:[...], eval:{passed, elapsed_ms} | skipped:true | gate:"missed"}
// skills_hash = sha256("git ls-files -s skills eval_dataset.json" 的输出)——内容寻址，
// 同内容同 hash、改一字即变（测试固化该语义）。

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, appendFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER = process.env.KNOWLEDGE_GATE_LEDGER ?? join(ROOT, "eval_results", "knowledge-versions.jsonl");

export function git(args, cwd = ROOT) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** 内容寻址的知识指纹：对 git index 中 skills + 数据集的 (mode,hash,path) 行做 sha256。 */
export function skillsHash(cwd = ROOT) {
  let listing;
  try {
    listing = git(["ls-files", "-s", "skills", "eval_dataset.json"], cwd);
  } catch {
    listing = "";
  }
  return createHash("sha256").update(listing).digest("hex").slice(0, 16);
}

/** pre-commit 状态文件 → 台账 eval 字段（"skip" | "passed|elapsed_ms"）。 */
export function parseState(raw) {
  if (!raw) return { gate: "missed" };
  if (raw.trim() === "skip") return { skipped: true };
  const m = /^(\d+)\|(\d+)$/.exec(raw.trim());
  return m ? { eval: { passed: Number(m[1]), elapsed_ms: Number(m[2]) } } : { gate: "missed" };
}

export function recordRow({ sha, stateRaw, files, cwd = ROOT, ledger = LEDGER }) {
  const row = {
    sha,
    ts: Date.now(),
    skills_hash: skillsHash(cwd),
    files: files.split(/\s+/).filter(Boolean),
    ...parseState(stateRaw),
  };
  mkdirSync(dirname(ledger), { recursive: true });
  appendFileSync(ledger, JSON.stringify(row) + "\n", "utf8");
  return row;
}

function install() {
  const hooksDir = join(ROOT, ".githooks");
  for (const h of ["pre-commit", "post-commit"]) {
    const p = join(hooksDir, h);
    if (!existsSync(p)) throw new Error(`缺少钩子文件 ${p}`);
    try { chmodSync(p, 0o755); } catch { /* Windows 磁盘位可能不可设，git 经 sh 调钩子不依赖它 */ }
  }
  git(["config", "core.hooksPath", ".githooks"]);
  const cur = git(["config", "core.hooksPath"]);
  if (cur !== ".githooks") throw new Error(`core.hooksPath 设置失败（实际: ${cur}）`);
  console.log("[knowledge-gate] 已安装：core.hooksPath=.githooks（幂等，重复执行无害）");
}

function history(n = 10) {
  if (!existsSync(LEDGER)) return console.log(`（台账尚无记录：${LEDGER}）`);
  const rows = readFileSync(LEDGER, "utf8").trim().split("\n").filter(Boolean).slice(-n);
  for (const r of rows) {
    const d = JSON.parse(r);
    const outcome = d.eval ? `eval ${d.eval.passed} PASS / ${d.eval.elapsed_ms}ms`
      : d.skipped ? "SKIPPED（逃生口）" : `gate:${d.gate}`;
    const when = new Date(d.ts).toLocaleString("zh-CN", { hour12: false });
    console.log(`${d.sha.slice(0, 8)}  ${when}  ${outcome}  ${d.files.length} 文件  hash=${d.skills_hash}`);
  }
}

const args = process.argv.slice(2);
if (args.includes("--install")) install();
else if (args.includes("--record")) {
  const sha = args[args.indexOf("--record") + 1];
  const stateFile = args[args.indexOf("--state") + 1];
  const files = args[args.indexOf("--files") + 1] ?? "";
  let stateRaw = null;
  try { stateRaw = readFileSync(stateFile, "utf8"); } catch { /* 无状态 → missed */ }
  recordRow({ sha, stateRaw, files });
} else if (args.includes("--history")) {
  const i = args.indexOf("--history");
  history(Number(args[i + 1]) || 10);
} else {
  console.log("用法: node scripts/knowledge-gate.mjs --install | --record <sha> --state <f> --files <..> | --history [n]");
}
