// M4-C2 知识发布门测试——临时 fixture 仓库 + eval 替身，绝不触碰本仓库工作区/staged。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { skillsHash, parseState, recordRow } from "./knowledge-gate.mjs";

const REAL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REAL_HOOKS = join(REAL_ROOT, ".githooks");

function sh(cmd, cwd, env = {}) {
  return spawnSync("sh", ["-c", cmd], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
}

/** 造一个 fixture 仓库：hooksPath 指向真钩子（$0 定位真 gate 脚本），台账/eval 双注入。 */
function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "kgate-"));
  mkdirSync(join(dir, "skills", "demo-knowledge", "references"), { recursive: true });
  writeFileSync(join(dir, "skills", "demo-knowledge", "references", "metrics.md"), "# demo\nv1\n");
  writeFileSync(join(dir, "eval_dataset.json"), "{}\n");
  writeFileSync(join(dir, "README.md"), "x\n");
  // eval 替身：按环境变量决定成败，并落计数文件证明被调用
  writeFileSync(join(dir, "eval-double.mjs"),
    `import { appendFileSync } from 'node:fs';` +
    `appendFileSync(process.env.COUNTER, 'x');` +
    `console.log('PASS a\\nPASS b\\nPASS c');` +
    `process.exit(process.env.DOUBLE_FAIL === '1' ? 1 : 0);\n`);
  sh("git init -q && git config user.email t@t && git config user.name t", dir);
  sh("git add -A && git commit -qm init", dir); // 首提交（无钩子状态，正常过）
  sh(`git config core.hooksPath "${REAL_HOOKS.replace(/\\/g, "/")}"`, dir);
  // 观测文件预置为空（"未触发"= 空文件，而非文件不存在）
  writeFileSync(join(dir, "counter"), "");
  writeFileSync(join(dir, "ledger.jsonl"), "");
  return dir;
}

function cleanup(dir) { rmSync(dir, { recursive: true, force: true }); }

function fixtureEnv(dir, extra = {}) {
  return {
    KNOWLEDGE_GATE_LEDGER: join(dir, "ledger.jsonl"),
    KNOWLEDGE_EVAL_CMD: `node ${join(dir, "eval-double.mjs").replace(/\\/g, "/")}`,
    COUNTER: join(dir, "counter"),
    ...extra,
  };
}

test("无关文件提交零触发（eval 替身未被调用）", () => {
  const dir = makeFixture();
  try {
    writeFileSync(join(dir, "README.md"), "y\n");
    const r = sh("git add README.md && git commit -qm doc", dir, fixtureEnv(dir));
    assert.equal(r.status, 0);
    assert.equal(readFileSync(join(dir, "counter"), "utf8").length, 0);
    assert.equal(readFileSync(join(dir, "ledger.jsonl"), "utf8"), "");
  } finally { cleanup(dir); }
});

test("知识文件提交：eval 通过 → 放行 + 台账记 eval 摘要与 hash", () => {
  const dir = makeFixture();
  try {
    writeFileSync(join(dir, "skills", "demo-knowledge", "references", "metrics.md"), "# demo\nv2\n");
    const r = sh("git add skills && git commit -qm knowledge", dir, fixtureEnv(dir));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(dir, "counter"), "utf8").length, 1);
    const row = JSON.parse(readFileSync(join(dir, "ledger.jsonl"), "utf8"));
    assert.match(row.sha, /^[0-9a-f]{40}$/);
    assert.equal(row.files.length, 1);
    assert.equal(row.eval.passed, 3);
    assert.match(row.skills_hash, /^[0-9a-f]{16}$/);
  } finally { cleanup(dir); }
});

test("知识文件提交：eval 失败 → 拒绝（stderr 含失败提示），台账不记", () => {
  const dir = makeFixture();
  try {
    writeFileSync(join(dir, "skills", "demo-knowledge", "references", "metrics.md"), "# demo\nv3-bad\n");
    const r = sh("git add skills && git commit -qm bad-knowledge", dir, fixtureEnv(dir, { DOUBLE_FAIL: "1" }));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /拒绝提交/);
    assert.equal(readFileSync(join(dir, "ledger.jsonl"), "utf8"), "");
    // 仓库回到未提交状态，知识文件仍在 staged
    assert.match(sh("git status --short", dir).stdout, /^[AM]/);
  } finally { cleanup(dir); }
});

test("SKIP_KNOWLEDGE_GATE=1：放行 + 台账记 skipped", () => {
  const dir = makeFixture();
  try {
    writeFileSync(join(dir, "eval_dataset.json"), '{"x":1}\n');
    const r = sh("git add eval_dataset.json && git commit -qm dataset", dir,
      fixtureEnv(dir, { SKIP_KNOWLEDGE_GATE: "1" }));
    assert.equal(r.status, 0);
    assert.equal(readFileSync(join(dir, "counter"), "utf8").length, 0);
    const row = JSON.parse(readFileSync(join(dir, "ledger.jsonl"), "utf8"));
    assert.equal(row.skipped, true);
  } finally { cleanup(dir); }
});

test("skillsHash 内容寻址：同内容同值，改一字即变", () => {
  const a = makeFixture(), b = makeFixture();
  try {
    assert.equal(skillsHash(a), skillsHash(b));
    writeFileSync(join(b, "skills", "demo-knowledge", "references", "metrics.md"), "# demo\nCHANGED\n");
    sh("git add -A", b);
    assert.notEqual(skillsHash(a), skillsHash(b));
  } finally { cleanup(a); cleanup(b); }
});

test("parseState：skip / 摘要 / 缺失三分支", () => {
  assert.deepEqual(parseState("skip"), { skipped: true });
  assert.deepEqual(parseState("85|12345\n"), { eval: { passed: 85, elapsed_ms: 12345 } });
  assert.deepEqual(parseState(null), { gate: "missed" });
  assert.deepEqual(parseState("garbage"), { gate: "missed" });
});

test("recordRow 直写：字段齐、JSONL 追加", () => {
  const dir = makeFixture();
  try {
    const l1 = join(dir, "l1.jsonl");
    const r1 = recordRow({ sha: "a".repeat(40), stateRaw: "85|1000", files: "skills/a.md eval_dataset.json", cwd: dir, ledger: l1 });
    recordRow({ sha: "b".repeat(40), stateRaw: "skip", files: "skills/b.md", cwd: dir, ledger: l1 });
    const rows = readFileSync(l1, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].files.length, 2);
    assert.equal(rows[1].skipped, true);
    assert.equal(r1.eval.passed, 85);
  } finally { cleanup(dir); }
});
