// M4 知识库管理入口·发布通道测试——临时 fixture 仓库 + eval 替身，绝不触碰本仓库工作区/staged。
// 被测对象：scripts/knowledge-publish.mjs（真脚本 + env 注入 fixture 仓库）。
// 契约：写文件 → git add → git commit（过 C2 门）→ 成功 {ok,sha,eval 摘要}；
//       门拒 → 还原干净 {ok:false,reason:"gate",gate_output 尾部}；路径越界 exit 2；
//       并发 lockfile 互斥；脏 index 拒绝；门未安装拒绝。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REAL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REAL_HOOKS = join(REAL_ROOT, ".githooks");
const SCRIPT = join(REAL_ROOT, "scripts", "knowledge-publish.mjs");

function sh(cmd, cwd, env = {}) {
  return spawnSync("sh", ["-c", cmd], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
}

/** 造 fixture 仓库：结构与 knowledge-gate.test.mjs 同款（hooksPath 指向真钩子，eval/台账双注入）。 */
function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "kpub-"));
  mkdirSync(join(dir, "skills", "demo-knowledge", "references"), { recursive: true });
  writeFileSync(join(dir, "skills", "demo-knowledge", "SKILL.md"), "# demo skill\n");
  writeFileSync(join(dir, "skills", "demo-knowledge", "references", "metrics.md"), "# demo\nv1\n");
  writeFileSync(join(dir, "skills", "demo-knowledge", "references", "notes.txt"), "非 md 不在白名单\n");
  writeFileSync(join(dir, "eval_dataset.json"), "{}\n");
  writeFileSync(join(dir, "README.md"), "x\n");
  // 观测文件（counter/台账/内容临时件/lock 目录）不入 fixture 状态；关 autocrlf 保证断言按 LF 逐字比
  writeFileSync(join(dir, ".gitignore"), "counter\nledger.jsonl\ncontent.tmp\neval_results/\n");
  writeFileSync(join(dir, "eval-double.mjs"),
    `import { appendFileSync } from 'node:fs';` +
    `appendFileSync(process.env.COUNTER, 'x');` +
    `console.log('PASS a\\nPASS b\\nPASS c');` +
    `if (process.env.DOUBLE_FAIL === '1') { console.error('FAIL scenario-1 数值不对\\nFAIL scenario-2 口径不对'); process.exit(1); }\n`);
  sh("git init -q && git config user.email t@t && git config user.name t && git config core.autocrlf false", dir);
  sh("git add -A && git commit -qm init", dir);
  sh(`git config core.hooksPath "${REAL_HOOKS.replace(/\\/g, "/")}"`, dir);
  writeFileSync(join(dir, "counter"), "");
  writeFileSync(join(dir, "ledger.jsonl"), "");
  return dir;
}

function cleanup(dir) { rmSync(dir, { recursive: true, force: true }); }

function fixtureEnv(dir, extra = {}) {
  return {
    KNOWLEDGE_PUBLISH_REPO: dir,
    KNOWLEDGE_GATE_LEDGER: join(dir, "ledger.jsonl"),
    KNOWLEDGE_EVAL_CMD: `node ${join(dir, "eval-double.mjs").replace(/\\/g, "/")}`,
    COUNTER: join(dir, "counter"),
    ...extra,
  };
}

/** 跑发布脚本（内容落临时文件，模拟 BFF 调用形态）。 */
function publish(dir, file, content, message, extraEnv = {}) {
  const contentFile = join(dir, "content.tmp");
  writeFileSync(contentFile, content);
  return spawnSync(process.execPath, [SCRIPT, "--file", file, "--content-file", contentFile, "--message", message], {
    cwd: dir, encoding: "utf8", env: { ...process.env, ...fixtureEnv(dir, extraEnv) },
  });
}

const parseOut = (r) => JSON.parse(r.stdout.trim().split("\n").pop());

test("成功路径：白名单文件过门提交——exit 0 / ok:true / sha / eval 摘要；台账照常由 post-commit 记（脚本不动台账）", () => {
  const dir = makeFixture();
  try {
    const r = publish(dir, "skills/demo-knowledge/references/metrics.md", "# demo\nv2 via ui\n", "ui: 更新 metrics 口径");
    assert.equal(r.status, 0, r.stderr);
    const out = parseOut(r);
    assert.equal(out.ok, true);
    assert.match(out.sha, /^[0-9a-f]{40}$/);
    assert.match(out.eval_summary, /\[knowledge-gate\] ✓.*PASS/, "含 eval 摘要行");
    assert.equal(out.reason, undefined);
    // 文件已提交：worktree 干净、HEAD 内容即新内容
    assert.equal(sh("git status --short", dir).stdout.trim(), "");
    assert.equal(sh("git show HEAD:skills/demo-knowledge/references/metrics.md", dir).stdout, "# demo\nv2 via ui\n");
    assert.equal(sh("git log -1 --format=%an", dir).stdout.trim(), "knowledge-ui", "提交人 knowledge-ui");
    // 台账行为不动：post-commit 钩子照常追加一行（脚本自身零台账写入）
    assert.equal(readFileSync(join(dir, "counter"), "utf8").length, 1, "eval 替身被调用一次");
    const row = JSON.parse(readFileSync(join(dir, "ledger.jsonl"), "utf8"));
    assert.equal(row.sha, out.sha);
    assert.equal(row.eval.passed, 3);
    // lockfile 用后即删
    assert.equal(existsSync(join(dir, "eval_results", "knowledge-publish.lock")), false);
  } finally { cleanup(dir); }
});

test("门拒路径：eval 失败 → 文件还原干净（worktree 与 HEAD 一致）、tree 无残留、{ok:false,reason:gate,gate_output 尾部}", () => {
  const dir = makeFixture();
  try {
    const r = publish(dir, "skills/demo-knowledge/references/metrics.md", "# demo\nv3-bad\n", "ui: 坏改动", { DOUBLE_FAIL: "1" });
    assert.equal(r.status, 1);
    const out = parseOut(r);
    assert.equal(out.ok, false);
    assert.equal(out.reason, "gate");
    assert.ok(Array.isArray(out.gate_output) && out.gate_output.length > 0, "gate_output 是行数组");
    assert.ok(out.gate_output.some((l) => l.includes("FAIL")), "尾部含 FAIL 清单");
    assert.ok(out.gate_output.some((l) => l.includes("拒绝提交")), "尾部含拒绝提示");
    // 还原干净：worktree 内容回到 HEAD，index 无暂存
    assert.equal(sh("git status --short", dir).stdout.trim(), "", "git status 完全干净");
    assert.equal(readFileSync(join(dir, "skills", "demo-knowledge", "references", "metrics.md"), "utf8"), "# demo\nv1\n");
    // 门拒不记台账（与 knowledge-gate 语义一致）
    assert.equal(readFileSync(join(dir, "ledger.jsonl"), "utf8"), "");
  } finally { cleanup(dir); }
});

test("白名单拒绝：../../ 逃逸 / 根路径 / 非 md / 域根散置 md / 缺参数 → exit 2 且不写文件", () => {
  const dir = makeFixture();
  try {
    for (const file of [
      "../../evil.md",                                  // 逃逸
      "README.md",                                      // 根路径
      "skills/demo-knowledge/references/notes.txt",    // 非 md
      "skills/foo.md",                                  // 域根散置（须在 references/ 或为 SKILL.md）
      "skills/demo-knowledge/other.md",                // 同上
      "eval_dataset.json",                              // 数据集不提供脚本通道（UI 红线）
      "Skills/Demo/SKILL.md",                           // 大小写形态
    ]) {
      const r = publish(dir, file, "x\n", "ui: 越界尝试");
      assert.equal(r.status, 2, `${file} → exit 2`);
      const out = parseOut(r);
      assert.equal(out.ok, false);
      assert.equal(out.reason, "path", `${file} → reason:path`);
    }
    // 缺参数同为 exit 2（usage）
    const noMsg = spawnSync(process.execPath, [SCRIPT, "--file", "skills/demo-knowledge/SKILL.md", "--content-file", join(dir, "content.tmp")], {
      cwd: dir, encoding: "utf8", env: { ...process.env, ...fixtureEnv(dir) },
    });
    writeFileSync(join(dir, "content.tmp"), "x\n"); // 上面命令先跑后写不影响（usage 先拒）
    assert.equal(noMsg.status, 2);
    assert.equal(parseOut(noMsg).reason, "usage");
    assert.equal(sh("git status --short", dir).stdout.trim(), "", "仓库零污染");
  } finally { cleanup(dir); }
});

test("新文件允许：落在新域目录 references/ 与既有域新 SKILL.md 均可建（门过即提交）；门拒则新文件被整删、tree 干净", () => {
  const dir = makeFixture();
  try {
    const ok1 = publish(dir, "skills/new-domain/references/metrics.md", "# new domain\n", "ui: 新域落地页");
    assert.equal(ok1.status, 0, ok1.stderr);
    assert.equal(parseOut(ok1).ok, true);
    assert.equal(readFileSync(join(dir, "skills", "new-domain", "references", "metrics.md"), "utf8"), "# new domain\n");

    const bad = publish(dir, "skills/another-domain/SKILL.md", "# bad\n", "ui: 新 SKILL 门拒", { DOUBLE_FAIL: "1" });
    assert.equal(bad.status, 1);
    assert.equal(sh("git status --short", dir).stdout.trim(), "", "门拒后新文件被删干净");
    assert.equal(existsSync(join(dir, "skills", "another-domain", "SKILL.md")), false);
    // 第一次成功提交不受第二次失败影响
    assert.equal(sh("git show HEAD:skills/new-domain/references/metrics.md", dir).stdout, "# new domain\n");
  } finally { cleanup(dir); }
});

test("并发互斥：lockfile 已被占用 → {ok:false,reason:busy}，不写文件不动仓库；锁过期可接管", () => {
  const dir = makeFixture();
  try {
    mkdirSync(join(dir, "eval_results"), { recursive: true });
    const lock = join(dir, "eval_results", "knowledge-publish.lock");
    writeFileSync(lock, "held-by-other\n");
    const r = publish(dir, "skills/demo-knowledge/references/metrics.md", "# 抢占\n", "ui: 并发");
    assert.equal(r.status, 1);
    const out = parseOut(r);
    assert.equal(out.ok, false);
    assert.equal(out.reason, "busy");
    assert.equal(readFileSync(join(dir, "skills", "demo-knowledge", "references", "metrics.md"), "utf8"), "# demo\nv1\n", "未写文件");
    assert.equal(sh("git status --short", dir).stdout.trim(), "", "仓库零污染");
    assert.equal(readFileSync(join(dir, "counter"), "utf8").length, 0, "未触 eval");

    // 过期锁（30 分钟前）可被接管：正常发布成功
    const old = new Date(Date.now() - 31 * 60 * 1000);
    spawnSync(process.execPath, ["-e", `require('fs').utimesSync(process.argv[1], new Date(${old.getTime()}/1000), new Date(${old.getTime()}/1000))`, lock.replace(/\\/g, "/")]);
    const r2 = publish(dir, "skills/demo-knowledge/references/metrics.md", "# demo\n接管后\n", "ui: 过期锁接管");
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(parseOut(r2).ok, true);
  } finally { cleanup(dir); }
});

test("脏 index 拒绝：他人已暂存改动 → {ok:false,reason:dirty_index}，不 add 不提交、既有暂存原样保留", () => {
  const dir = makeFixture();
  try {
    writeFileSync(join(dir, "README.md"), "他人已暂存的改动\n");
    sh("git add README.md", dir);
    const r = publish(dir, "skills/demo-knowledge/references/metrics.md", "# demo\nv2\n", "ui: 应被拒");
    assert.equal(r.status, 1);
    const out = parseOut(r);
    assert.equal(out.ok, false);
    assert.equal(out.reason, "dirty_index");
    assert.equal(readFileSync(join(dir, "skills", "demo-knowledge", "references", "metrics.md"), "utf8"), "# demo\nv1\n", "未写文件");
    assert.match(sh("git status --short", dir).stdout, /^M  README\.md/, "既有暂存原样保留（不被搭车提交）");
    assert.equal(readFileSync(join(dir, "counter"), "utf8").length, 0, "未触 eval");
  } finally { cleanup(dir); }
});

test("门未安装拒绝：hooksPath 未配置 → {ok:false,reason:no_gate}（发布通道绝不在无门状态下静默过）", () => {
  const dir = makeFixture();
  try {
    sh("git config --unset core.hooksPath", dir);
    const r = publish(dir, "skills/demo-knowledge/references/metrics.md", "# demo\nv2\n", "ui: 无门");
    assert.equal(r.status, 1);
    const out = parseOut(r);
    assert.equal(out.ok, false);
    assert.equal(out.reason, "no_gate");
    assert.equal(readFileSync(join(dir, "skills", "demo-knowledge", "references", "metrics.md"), "utf8"), "# demo\nv1\n", "未写文件");
    assert.equal(sh("git status --short", dir).stdout.trim(), "");
    assert.equal(readFileSync(join(dir, "counter"), "utf8").length, 0, "未触 eval");
  } finally { cleanup(dir); }
});

test("无变化提交：内容与 HEAD 相同 → {ok:false,reason:no_change}（非门拒误报）", () => {
  const dir = makeFixture();
  try {
    const r = publish(dir, "skills/demo-knowledge/references/metrics.md", "# demo\nv1\n", "ui: 原样重发");
    assert.equal(r.status, 1);
    const out = parseOut(r);
    assert.equal(out.ok, false);
    assert.equal(out.reason, "no_change");
    assert.equal(sh("git status --short", dir).stdout.trim(), "", "index 还原干净");
  } finally { cleanup(dir); }
});
