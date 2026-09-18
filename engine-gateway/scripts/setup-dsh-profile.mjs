#!/usr/bin/env node
// M1-T2: dsh profile 配置脚本化（M0 遗留 L3，T16 §8 移交项固化）。
//
// 从仓库模板渲染并安装 ~/.dsh/profiles/{headless,sdk}，替代 M0 三轮安全审查
// 后手工迭代的配置。价值 = 可重现 + 防漂移：profile 目录不入库，本脚本 +
// profile-template/ 是唯一权威来源；五工具禁用是实弹攻防的产物，不许手改。
//
// ── M0 盘点差异（2026-09-09 实测，模板提炼依据）──────────────────────────
// headless profile patch  = 仅 mcp-dws 段（五禁用 + skill-filesystem 来自
//                           插件自带 bundle patch，dump-config 显示
//                           "patched by m0-exec-script-plugin"）。
// sdk profile patch       = mcp-dws + 五禁用 + skill-filesystem 三段全量
//                           （T16 显式固化，与 headless 逐条同源）。
// 两 profile 均无 "m0-exec-script bundle insert" 段——bundle 注册由
// package.json 的 dsh.profile.bundles 尾插 m0-exec-script-plugin + pnpm link
// 承载，patch 里再 insert 会重复注册。本模板统一取 sdk 的全量三段形态
// （超集，语义与 headless 等价；dump-config 断言见 selfCheck）。
// 其余事实：
//   cordis.yml 两 profile 逐字节一致（空 entry list + 说明注释，boot 时不重写）；
//   pnpm-workspace.yaml 仅 headless 有（sdk 没有，pnpm 10 亦正常 link）；
//   package.json 差异仅在 bundles[1]：headless 用 dsh-headless，sdk 用 dsh-sdk-app；
//   RESULT_DIR：headless 固定 D:\dataprojai-2harness\m0\results（M0 遗留，
//     与活配置逐字节一致以保 M0 基线可复现）；sdk 用 !!js process.env.RESULT_DIR
//     （M1 网关每任务设子目录——Task 5 衔接点）。
// 密钥红线：DWS_PASSWORD 只允许 !!js process.env.DWS_PASSWORD 表达式，
// 文件内不得出现任何密钥值。
//
// ── 用法 ────────────────────────────────────────────────────────────────
//   node setup-dsh-profile.mjs --profile headless|sdk [--force]
//
// 幂等：profile 已存在且渲染内容一致 → 跳过重建（第二遍输出 skip）。
// --force：内容一致也重写。任何覆盖写入前先备份旧文件为 <name>.bak
// （防 T16 §6 的坑：早期 `dsh --profile sdk --help` 会自举并把 package.json
// 重写为空 bundles 覆盖 patch——.bak 保证可回滚；另 dump-config 已实测为
// 只读自检，不触发该重写）。
//
// 安装顺序 = T16 实测安全序：先写齐三件套（package.json / cordis.yml /
// cordis.patch.yml）→ pnpm install（本地 link 插件）→ dump-config 自检。
// 自检为 dump-config 级：五工具 disabled:true 且带 "patched by" 标注 +
// m0-exec-script + mcp-dws 在列；会话级工具数组断言属 Task 9 E2E。
//
// 验证记录：M1-T2（两遍幂等 / 自检 / 双 profile 冒烟 / 红队 4/4）。

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = path.join(__dirname, "profile-template");

// ── 固定事实（M0 实测定型；换机器时改这里）────────────────────────────────
const PLUGIN_DIR = path.resolve(__dirname, "..", "..", "m0", "dsh-plugin", "exec-script");
// E-5 修复：读域围栏插件（tools/execute 瀑布拦 read/read_image/glob/grep）
const FENCE_PLUGIN_DIR = path.resolve(__dirname, "..", "..", "m0", "dsh-plugin", "fs-read-fence");
const MCP_PYTHON = "C:\\Users\\Administrator\\AppData\\Local\\Programs\\Python\\Python312\\python.exe";
const MCP_SCRIPT = path.resolve(__dirname, "..", "..", "dws_mcp_server.py");
const HEADLESS_RESULT_DIR = path.resolve(__dirname, "..", "..", "m0", "results");

const PROFILES = {
  headless: { appBundle: "@deepseek-ai/dsh-headless", resultDirLine: `          RESULT_DIR: '${HEADLESS_RESULT_DIR}'` },
  // sdk（M1 网关用）：RESULT_DIR 改环境变量注入——网关每任务设子目录（Task 5）。
  // 防 T2 实测崩溃：裸 `!!js process.env.RESULT_DIR` 在未设置时求值为 undefined，
  // mcp-client env schema（仅字符串）拒绝 → 整个 profile 启动失败，且 dsh 的
  // 校验错误会把解析后的 DWS_PASSWORD 打到 stderr。`|| ''` 使未设置时空串通过
  // 校验，dws_mcp_server.py 对空 RESULT_DIR 走 legacy 模式（无落盘、auto-LIMIT
  // 200）——优雅降级而非崩溃泄密。
  sdk: { appBundle: "@deepseek-ai/dsh-sdk-app", resultDirLine: "          RESULT_DIR: !!js process.env.RESULT_DIR || ''" },
};

// ── CLI ───────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const profileName = args[args.indexOf("--profile") + 1];
const force = args.includes("--force");
if (!profileName || !PROFILES[profileName]) {
  console.error(`Usage: node setup-dsh-profile.mjs --profile headless|sdk [--force]`);
  process.exit(2);
}
const profile = PROFILES[profileName];
const profileDir = path.join(process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME, ".dsh"), "profiles", profileName);

// ── 渲染模板 ──────────────────────────────────────────────────────────────
function render(tmplFile, subs) {
  let text = readFileSync(path.join(TEMPLATE_DIR, tmplFile), "utf8");
  for (const [k, v] of Object.entries(subs)) text = text.replaceAll(`{{${k}}}`, v);
  if (text.includes("{{")) throw new Error(`${tmplFile}: unresolved placeholder after render`);
  return text;
}

const packageJson = render("package.json.tmpl", {
  PROFILE_NAME: profileName,
  APP_BUNDLE: profile.appBundle,
  // Windows link: 用正斜杠（pnpm/yaml 均接受，且避免 YAML 反斜杠转义问题）。
  PLUGIN_DIR: PLUGIN_DIR.replaceAll("\\", "/"),
  FENCE_PLUGIN_DIR: FENCE_PLUGIN_DIR.replaceAll("\\", "/"),
});

const patchYml = render("cordis.patch.yml.tmpl", {
  MCP_PYTHON,
  MCP_SCRIPT,
  RESULT_DIR_LINE: profile.resultDirLine,
});

// cordis.yml：与现有两 profile 逐字节一致的空 entry list（boot 时由 dsh 读取）。
const cordisYml = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`;

const FILES = [
  { name: "package.json", content: packageJson },
  { name: "cordis.yml", content: cordisYml },
  { name: "cordis.patch.yml", content: patchYml },
];

// ── 幂等判定 + 写入（覆盖前 .bak 备份）────────────────────────────────────
function sameAsOnDisk(content, diskPath) {
  return existsSync(diskPath) && readFileSync(diskPath, "utf8") === content;
}

const allSame = FILES.every((f) => sameAsOnDisk(f.content, path.join(profileDir, f.name)));
if (allSame && !force) {
  console.log(`[${profileName}] 配置与模板一致，跳过重建（--force 强制重写）`);
} else {
  mkdirSync(profileDir, { recursive: true });
  for (const f of FILES) {
    const target = path.join(profileDir, f.name);
    if (existsSync(target)) {
      if (sameAsOnDisk(f.content, target) && !force) continue;
      copyFileSync(target, target + ".bak");
      unlinkSync(target);
    }
    writeFileSync(target, f.content, "utf8");
    console.log(`[${profileName}] 写入 ${f.name}${existsSync(target + ".bak") ? "（旧件已存 .bak）" : ""}`);
  }
}

// ── node_modules link（T13 实测方式：dsh plugin add，转包 pnpm）────────────
const PLUGINS = [
  { name: "m0-exec-script-plugin", dir: PLUGIN_DIR },
  { name: "m0-fs-read-fence-plugin", dir: FENCE_PLUGIN_DIR },
];
for (const p of PLUGINS) {
  const linkTarget = path.join(profileDir, "node_modules", p.name);
  const linkOk = existsSync(linkTarget);
  if (!linkOk || force) {
    console.log(`[${profileName}] ${p.name} ${linkOk ? "force" : "link 缺失"} → dsh plugin add（bundle 注册 + pnpm link）`);
    const r = spawnSync("dsh.cmd", ["plugin", "--profile", profileName, "add", p.dir], {
      stdio: "inherit", shell: true, cwd: process.env.USERPROFILE || process.env.HOME,
    });
    if (r.status !== 0) {
      console.error(`[${profileName}] dsh plugin add ${p.name} 失败（exit ${r.status}）`);
      process.exit(1);
    }
  } else {
    console.log(`[${profileName}] ${p.name} link 已存在，跳过 plugin add`);
  }
}

// ── 自检（dump-config 级；会话级断言属 Task 9 E2E）────────────────────────
// dump-config 已实测为只读自检（不重写 package.json），安全用于 CI。
const REQUIRED_DISABLED = ["tool-pwsh", "tool-web", "tool-workflow", "workflow-worker-thread", "tool-ralph"];
const REQUIRED_PRESENT = ["m0-exec-script", "mcp-dws", "m0-fs-read-fence"];

function selfCheck() {
  const r = spawnSync("dsh.cmd", ["--profile", profileName, "--dump-config"], {
    encoding: "utf8", shell: true, cwd: process.env.USERPROFILE || process.env.HOME, maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0) {
    console.error(`[${profileName}] SELF-CHECK FAIL: dump-config exit ${r.status}\n${r.stderr}`);
    return false;
  }
  const out = r.stdout;
  const failures = [];
  // dump-config 形态（实测）：条目为 "- id: <id>" 起、缩进属性行随后的 YAML 块，
  // 层级头 "# == <bundle>, patched by <plugin>" 标注 patch 来源。
  const entries = [...out.matchAll(/^- id: (\S+)\n((?:[ \t]+\S.*\n?)*)/gm)].map((m) => ({
    id: m[1],
    body: m[2],
    // 条目上方最近一行 "# ==" 头即其所属层。
    layer: (() => {
      const idx = m.index;
      const before = out.slice(0, idx);
      const heads = [...before.matchAll(/^# == (.*)$/gm)];
      return heads.length ? heads[heads.length - 1][1] : "";
    })(),
  }));
  const byId = new Map(entries.map((e) => [e.id, e]));

  for (const id of REQUIRED_DISABLED) {
    const e = byId.get(id);
    if (!e) { failures.push(`${id}: 缺失`); continue; }
    if (!/^\s+disabled:\s*true\s*$/m.test(e.body)) { failures.push(`${id}: disabled!=true`); continue; }
    if (!/patched by m0-exec-script-plugin/.test(e.layer) && !/m0-exec-script-plugin/.test(e.layer)) {
      failures.push(`${id}: 层头无 "patched by m0-exec-script-plugin"（实际层: ${e.layer}）`);
    }
  }
  for (const id of REQUIRED_PRESENT) {
    if (!byId.has(id)) failures.push(`${id}: 缺失（bundle/patch 未生效）`);
  }
  // 密钥红线：patch 文件里不得有密钥值（只允许 !!js 表达式）。
  const patchOnDisk = readFileSync(path.join(profileDir, "cordis.patch.yml"), "utf8");
  if (!/DWS_PASSWORD:\s*!!js process\.env\.DWS_PASSWORD\s*$/m.test(patchOnDisk)) {
    failures.push("cordis.patch.yml: DWS_PASSWORD 必须恰为 !!js process.env.DWS_PASSWORD 表达式");
  }

  if (failures.length) {
    console.error(`[${profileName}] SELF-CHECK FAIL (${failures.length}):`);
    for (const f of failures) console.error(`  - ${f}`);
    try {
      writeFileSync(`/tmp/dump_${profileName}_fail.log`, out);
      console.error(`  dump-config 已存 /tmp/dump_${profileName}_fail.log 供比对`);
    } catch {}
    return false;
  }
  console.log(`[${profileName}] SELF-CHECK PASS: 五工具 disabled+patched by / m0-exec-script / mcp-dws / m0-fs-read-fence（dump-config 级）`);
  return true;
}

process.exit(selfCheck() ? 0 : 1);
