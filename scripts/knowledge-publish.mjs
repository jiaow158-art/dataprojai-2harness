#!/usr/bin/env node
// M4 知识库管理入口·发布通道——UI 写知识的唯一合法方式：写文件 → git commit 过 C2 门。
// 语义编辑不经此脚本（或不经 git commit）一律非法；eval_dataset.json 不在本通道白名单内。
//
// 用法：node scripts/knowledge-publish.mjs --file <相对路径> --content-file <tmp> --message <msg>
//   --file         目标文件（仓库相对、正斜杠；须命中路径白名单）
//   --content-file 新内容所在的临时文件（调用方负责生成与清理）
//   --message      commit message（非空）
//
// 结果（stdout 最后一行 JSON；子进程 git 输出不外泄）：
//   exit 0  {ok:true, sha, eval_summary}                     发布成功（台账由 post-commit 照常记）
//   exit 1  {ok:false, reason:"gate", gate_output:[尾部行]}   门拒——文件已还原干净
//           {ok:false, reason:"busy"|"dirty_index"|"no_gate"|"no_change"|"git", ...}
//   exit 2  {ok:false, reason:"path"|"usage"}                 路径白名单/参数拒绝
//
// env（测试注入；生产缺省即本仓库）：
//   KNOWLEDGE_PUBLISH_REPO   目标仓库根（缺省 = 本脚本所在仓库）
//   KNOWLEDGE_PUBLISH_LOCK   lockfile 路径（缺省 <repo>/eval_results/knowledge-publish.lock）
//   KNOWLEDGE_EVAL_CMD / KNOWLEDGE_GATE_LEDGER / SKIP_KNOWLEDGE_GATE 透传给钩子（C2 既有机能）
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** 路径白名单：域目录（含新城名）下的 references/*.md 或 SKILL.md；无嵌套子目录、无其他后缀。 */
const PATH_RE = /^skills\/[a-z0-9-]+\/(references\/[A-Za-z0-9_.-]+\.md|SKILL\.md)$/;
/** lockfile 过期接管阈值：真实 79 场景 eval 可达分钟级，30 分钟视为持锁方已死。 */
const LOCK_STALE_MS = 30 * 60 * 1000;
/** 门拒时透传给 UI 的输出尾部行数（pre-commit 最多打 20 条 FAIL + 提示行）。 */
const GATE_TAIL_LINES = 30;

const emit = (payload) => console.log(JSON.stringify(payload));

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: r.status, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
}

/** 抢 lockfile（独占创建）；被占且未过期 → false，过期 → 接管。同一时刻仅一个发布。 */
function acquireLock(lockPath) {
  mkdirSync(dirname(lockPath), { recursive: true });
  try {
    closeSync(openSync(lockPath, "wx"));
    return true;
  } catch {
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
        rmSync(lockPath, { force: true });
        closeSync(openSync(lockPath, "wx"));
        return true;
      }
    } catch { /* 竞态：另一进程先接管/删除——按占用处理 */ }
    return false;
  }
}

/** C2 门安装检查：core.hooksPath 已配置且其下存在 pre-commit（无门 = 拒绝发布，绝不静默绕过）。 */
function gateInstalled(repo) {
  const cfg = git(["config", "core.hooksPath"], repo);
  if (cfg.status !== 0 || !cfg.stdout) return false;
  const hooksDir = isAbsolute(cfg.stdout) ? cfg.stdout : join(repo, cfg.stdout);
  return existsSync(join(hooksDir, "pre-commit"));
}

/** 门拒还原：index 与 worktree 一并回到 HEAD（新文件被整删）；失败则兜底 unstage + 删文件。 */
function restoreClean(repo, file) {
  const r = git(["restore", "--staged", "--worktree", "--", file], repo);
  if (r.status === 0) return;
  git(["reset", "-q", "HEAD", "--", file], repo);
  if (git(["cat-file", "-e", `HEAD:${file}`], repo).status !== 0) rmSync(join(repo, file), { force: true });
}

// ── 参数与白名单 ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const file = opt("--file");
const contentFile = opt("--content-file");
const message = opt("--message");

if (!file || !contentFile || !message || !message.trim()) {
  emit({ ok: false, reason: "usage" });
  process.exit(2);
}
if (!PATH_RE.test(file) || isAbsolute(file) || file.includes("\\")) {
  emit({ ok: false, reason: "path", file });
  process.exit(2);
}

let content;
try {
  content = readFileSync(resolve(contentFile), "utf8");
} catch {
  emit({ ok: false, reason: "usage" });
  process.exit(2);
}

const repo = process.env.KNOWLEDGE_PUBLISH_REPO ? resolve(process.env.KNOWLEDGE_PUBLISH_REPO) : SELF_ROOT;
const lockPath = process.env.KNOWLEDGE_PUBLISH_LOCK
  ? resolve(process.env.KNOWLEDGE_PUBLISH_LOCK)
  : join(repo, "eval_results", "knowledge-publish.lock");

if (!acquireLock(lockPath)) {
  emit({ ok: false, reason: "busy" });
  process.exit(1);
}

/** 发布主体：返回退出码（0 成功）。注意 process.exit 会跳过 finally——锁的释放在外层。 */
function main() {
  if (!gateInstalled(repo)) {
    emit({ ok: false, reason: "no_gate" });
    return 1;
  }

  // 脏 index 拒绝：git commit 提交整个 index——他人暂存的改动绝不被搭车提交
  const staged = git(["diff", "--cached", "--name-only"], repo);
  if (staged.status === 0 && staged.stdout) {
    emit({ ok: false, reason: "dirty_index", staged: staged.stdout.split("\n") });
    return 1;
  }

  // 写文件 → add → commit（pre-commit 门在 commit 内触发；env 原样透传给钩子）
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), content, "utf8");
  if (git(["add", "--", file], repo).status !== 0) {
    restoreClean(repo, file);
    emit({ ok: false, reason: "git" });
    return 1;
  }

  const c = spawnSync(
    "git",
    ["-c", "user.name=knowledge-ui", "-c", "user.email=ui@local", "commit", "-m", message],
    { cwd: repo, encoding: "utf8" },
  );
  const out = `${c.stdout ?? ""}\n${c.stderr ?? ""}`.trim();

  if (c.status === 0) {
    const sha = git(["rev-parse", "HEAD"], repo).stdout;
    const evalLine = out.split("\n").find((l) => l.includes("[knowledge-gate] ✓")) ?? null;
    emit({ ok: true, sha, eval_summary: evalLine ? evalLine.trim() : null });
    return 0;
  }

  // 提交未成：无论门拒还是其他，一律还原干净再分类上报
  restoreClean(repo, file);
  if (/nothing to commit/.test(out)) {
    emit({ ok: false, reason: "no_change" });
    return 1;
  }
  const lines = out.split("\n").filter((l) => l.trim() !== "");
  emit({ ok: false, reason: "gate", gate_output: lines.slice(-GATE_TAIL_LINES) });
  return 1;
}

let code = 1;
try {
  code = main();
} finally {
  rmSync(lockPath, { force: true });
}
process.exit(code);
