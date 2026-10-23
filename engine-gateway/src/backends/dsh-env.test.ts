// S4-B2-B1 单测：DSH 子进程环境白名单 / 显式注入 / 敏感变量排除。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INHERITED_DSH_ENV_KEYS,
  buildDshRuntimeEnv,
  requiredDshEnvKeys,
  selectInheritedDshEnv,
} from "./dsh-env.ts";

const BASE_INPUT = {
  profile: "sdk-s4b" as const,
  workdir: "/verify/b2a/tasks/work/sess-1/workdir",
  resultsDir: "/verify/b2a/tasks/results/sess-1/results",
  assetsDir: "/verify/b2a/assets/report-generator",
  skillsDir: "/verify/b2a/skills",
  runnerPath: "/repo/m0/sandbox/run_in_sandbox.sh",
  runId: "run-001",
  attempt: 2,
  deepseekApiKey: "deepseek-test-placeholder",
};

/** 父进程同时放入白名单键、敏感键与危险注入键。 */
function sourceEnv(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/verify/b2a/home",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TMPDIR: "/verify/b2a/tmp",
    // Windows 必需变量（Linux CI 也验证白名单完整性）
    SystemRoot: "C:\\Windows",
    SystemDrive: "C:",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    USERPROFILE: "C:\\Users\\dpit",
    APPDATA: "C:\\Users\\dpit\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\dpit\\AppData\\Local",
    PROGRAMDATA: "C:\\ProgramData",
    PROGRAMFILES: "C:\\Program Files",
    "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
    COMMONPROGRAMFILES: "C:\\Program Files\\Common Files",
    // DSH / 插件 / 沙箱
    DSH_HOME: "/verify/b2a/dsh-home",
    DSH_AGENTS_HOME: "/verify/b2a/agents-home",
    MCP_PYTHON: "/srv/dpit/apps/harness/.venv/bin/python",
    M0_SANDBOX_BASH: "/bin/bash",
    SANDBOX_TASK_ROOTS: "/verify/b2a/tasks",
    SANDBOX_ASSETS_ROOTS: "/verify/b2a/assets",
    SANDBOX_ACL_STATE_DIR: "/verify/b2a/acl-state",
    SANDBOX_MEM: "512m",
    SANDBOX_CPUS: "1",
    SANDBOX_PIDS: "64",
    SANDBOX_TIMEOUT_S: "120",
    SANDBOX_IMAGE: "dataplat-script:m0",
    // 必须排除的敏感/危险变量
    AUTH_TOKEN: "auth-test-token",
    DWS_RUN_USER: "dws-run-user",
    DWS_RUN_PASSWORD: "dws-run-password",
    DWS_PASSWORD: "parent-dws-password",
    DEEPSEEK_API_KEY: "parent-deepseek-key",
    NODE_OPTIONS: "--require=/tmp/evil.js",
    NODE_PATH: "/tmp/evil-node-modules",
    LD_PRELOAD: "/tmp/evil.so",
    LD_LIBRARY_PATH: "/tmp/evil-lib",
    BASH_ENV: "/tmp/evil-bash-env",
    ENV: "/tmp/evil-env",
    PYTHONPATH: "/tmp/evil-python",
    GW_DB_PATH: "/verify/b2a/gateway.db",
    DSH_PROFILE: "sdk-s4b",
    // 服务端注入项不应被父 env 覆盖
    M0_PROJECT_SKILL_DIR: "/tmp/evil-skills",
    M0_SANDBOX_RUNNER: "/tmp/evil-runner.sh",
    M0_SANDBOX_WORKDIR: "/tmp/evil-workdir",
    RESULT_DIR: "/tmp/evil-results",
    SANDBOX_RUN_ID: "evil-run-id",
    SANDBOX_ATTEMPT: "999",
  };
}

test("sdk-s4b：继承白名单保留 Linux/Windows 运行变量，敏感变量一个不进入", () => {
  const source = sourceEnv();
  const env = buildDshRuntimeEnv({ ...BASE_INPUT, source });

  // 允许继承
  for (const key of [
    "PATH", "HOME", "LANG", "LC_ALL", "TMPDIR",
    "SystemRoot", "ComSpec", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "SystemDrive", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "COMMONPROGRAMFILES",
    "DSH_HOME", "DSH_AGENTS_HOME", "MCP_PYTHON", "M0_SANDBOX_BASH",
    "SANDBOX_TASK_ROOTS", "SANDBOX_ASSETS_ROOTS", "SANDBOX_ACL_STATE_DIR",
    "SANDBOX_MEM", "SANDBOX_CPUS", "SANDBOX_PIDS", "SANDBOX_TIMEOUT_S", "SANDBOX_IMAGE",
  ] as const) {
    assert.equal(env[key], source[key], `白名单键 ${key} 应保留`);
  }
  assert.equal(env.MCP_PYTHON, "/srv/dpit/apps/harness/.venv/bin/python");

  // 禁止继承
  for (const key of [
    "AUTH_TOKEN", "DWS_RUN_USER", "DWS_RUN_PASSWORD", "DWS_PASSWORD",
    "NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH",
    "BASH_ENV", "ENV", "PYTHONPATH", "GW_DB_PATH", "DSH_PROFILE",
  ] as const) {
    assert.equal(env[key], undefined, `敏感/无关键 ${key} 不得进入 DSH 子进程`);
  }

  // sdk-s4b：DWS_* 数量必须为 0（包括父进程的真实/占位值）
  assert.equal(Object.keys(env).filter((k) => k.startsWith("DWS_")).length, 0);

  // 服务端注入项覆盖父 env 中的同名值
  assert.equal(env.M0_SANDBOX_RUNNER, BASE_INPUT.runnerPath);
  assert.equal(env.M0_SANDBOX_WORKDIR, BASE_INPUT.workdir);
  assert.equal(env.M0_RESULTS_DIR, BASE_INPUT.resultsDir);
  assert.equal(env.M0_ASSETS_DIR, BASE_INPUT.assetsDir);
  assert.equal(env.M0_PROJECT_SKILL_DIR, BASE_INPUT.skillsDir);
  assert.equal(env.RESULT_DIR, BASE_INPUT.resultsDir);
  assert.equal(env.SANDBOX_RUN_ID, BASE_INPUT.runId);
  assert.equal(env.SANDBOX_ATTEMPT, String(BASE_INPUT.attempt));
  // Key 只按显式参数注入，不继承父值
  assert.equal(env.DEEPSEEK_API_KEY, BASE_INPUT.deepseekApiKey);
});

test("sdk：只注入选定 DWS_USER/DWS_PASSWORD，不注入 DWS_RUN_* 或父密码", () => {
  const source = sourceEnv();
  const env = buildDshRuntimeEnv({
    ...BASE_INPUT,
    profile: "sdk",
    source,
    dbUser: "dws_readonly",
    dbPassword: "run-pass-placeholder",
  });

  assert.equal(env.DWS_USER, "dws_readonly");
  assert.equal(env.DWS_PASSWORD, "run-pass-placeholder");
  assert.notEqual(env.DWS_PASSWORD, source.DWS_PASSWORD);
  assert.equal(env.DWS_RUN_USER, undefined);
  assert.equal(env.DWS_RUN_PASSWORD, undefined);
  assert.equal(env.AUTH_TOKEN, undefined);
  assert.equal(env.DEEPSEEK_API_KEY, BASE_INPUT.deepseekApiKey);
});

test("sdk：缺 DWS 账号/密码时 fail-closed；sdk-s4b 不需要 DWS", () => {
  const source = sourceEnv();
  assert.throws(
    () => buildDshRuntimeEnv({ ...BASE_INPUT, profile: "sdk", source }),
    /\[CONFIG\] DWS account\/password not set/,
  );
  assert.throws(
    () => buildDshRuntimeEnv({ ...BASE_INPUT, profile: "sdk", source, dbUser: "u" }),
    /\[CONFIG\] DWS account\/password not set/,
  );

  const s4b = buildDshRuntimeEnv({
    ...BASE_INPUT,
    profile: "sdk-s4b",
    source,
    dbUser: "ignored-user",
    dbPassword: "ignored-password",
  });
  assert.equal(Object.keys(s4b).filter((k) => k.startsWith("DWS_")).length, 0);
  assert.equal(s4b.DWS_USER, undefined);
  assert.equal(s4b.DWS_PASSWORD, undefined);
});

test("requiredDshEnvKeys：sdk 含 DWS 两项，sdk-s4b 不含；关键注入项完整", () => {
  const sdkKeys = requiredDshEnvKeys("sdk");
  const s4bKeys = requiredDshEnvKeys("sdk-s4b");
  for (const key of [
    "M0_SANDBOX_RUNNER", "M0_SANDBOX_WORKDIR", "M0_RESULTS_DIR",
    "M0_ASSETS_DIR", "M0_PROJECT_SKILL_DIR", "RESULT_DIR", "DEEPSEEK_API_KEY",
  ]) {
    assert.ok(sdkKeys.includes(key), `sdk 缺少 required key ${key}`);
    assert.ok(s4bKeys.includes(key), `sdk-s4b 缺少 required key ${key}`);
  }
  assert.ok(sdkKeys.includes("DWS_USER"));
  assert.ok(sdkKeys.includes("DWS_PASSWORD"));
  assert.ok(!s4bKeys.includes("DWS_USER"));
  assert.ok(!s4bKeys.includes("DWS_PASSWORD"));
  assert.equal(s4bKeys.filter((k) => k.startsWith("DWS_")).length, 0);
});

test("白名单完整性：MCP_PYTHON/DSH_*/M0_PROJECT_SKILL_DIR/SANDBOX_* 与 Windows 键均被覆盖", () => {
  const keys = new Set<string>(INHERITED_DSH_ENV_KEYS);
  for (const key of [
    "PATH", "HOME", "LANG", "LC_ALL", "TMPDIR",
    "SystemRoot", "SYSTEMROOT", "ComSpec", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "SystemDrive", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "COMMONPROGRAMFILES",
    "MCP_PYTHON", "DSH_HOME", "DSH_AGENTS_HOME",
    "SANDBOX_TASK_ROOTS", "SANDBOX_ASSETS_ROOTS", "SANDBOX_ACL_STATE_DIR",
    "SANDBOX_MEM", "SANDBOX_CPUS", "SANDBOX_PIDS", "SANDBOX_TIMEOUT_S", "SANDBOX_IMAGE",
  ]) {
    assert.ok(keys.has(key), `白名单缺 ${key}`);
  }
  // M0_PROJECT_SKILL_DIR 是显式注入项，不是继承项；父 env 值必须被覆盖
  assert.ok(!keys.has("M0_PROJECT_SKILL_DIR"));
});

test("selectInheritedDshEnv：只保留白名单键；白名单内空串按原样保留", () => {
  const source = {
    PATH: "/bin",
    LANG: "",
    AUTH_TOKEN: "secret",
    NODE_OPTIONS: "--evil",
    EMPTY_UNLISTED: "",
  } as NodeJS.ProcessEnv;
  const env = selectInheritedDshEnv(source);
  assert.equal(env.PATH, "/bin");
  assert.equal(env.LANG, "");
  assert.equal(env.AUTH_TOKEN, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.EMPTY_UNLISTED, undefined);
  assert.deepEqual(Object.keys(env), ["PATH", "LANG"]);
});
