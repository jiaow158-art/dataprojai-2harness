// M1-T3 单测：node:test，env mock 用进程 env 读写（before/after 恢复），零依赖。
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resolveDbAccount, dbAccountWarnings } from "./db-accounts.ts";

const ENV_KEYS = ["DWS_RUN_USER", "DWS_RUN_PASSWORD"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test("default 组命中：DWS_RUN_USER 已设 → 用受限账号，无警告", () => {
  process.env.DWS_RUN_USER = "dws_readonly";
  const account = resolveDbAccount("default");
  assert.equal(account.user, "dws_readonly");
  assert.equal(account.passwordEnv, "DWS_RUN_PASSWORD");
  assert.deepEqual(dbAccountWarnings(account), []);
});

test("回退形态：DWS_RUN_USER 未设 → user=aiuser，warnings 非空且含 FALLBACK", () => {
  const account = resolveDbAccount("default");
  assert.equal(account.user, "aiuser");
  const warnings = dbAccountWarnings(account);
  assert.ok(warnings.length > 0);
  assert.ok(warnings.some((w) => w.includes("FALLBACK")));
});

test("未知组抛错", () => {
  assert.throws(() => resolveDbAccount("nonexistent"), /unknown scope group/);
});

test("scopeGroup 空串/undefined/null 均视为 default", () => {
  process.env.DWS_RUN_USER = "dws_readonly";
  for (const g of ["", undefined, null] as (string | undefined | null)[]) {
    const account = resolveDbAccount(g);
    assert.equal(account.user, "dws_readonly");
    assert.equal(account.passwordEnv, "DWS_RUN_PASSWORD");
  }
});
