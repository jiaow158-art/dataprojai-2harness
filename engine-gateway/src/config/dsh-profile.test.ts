// S4-B2-B1 单测：DSH Profile 白名单与默认值。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DSH_PROFILE_NAMES,
  parseDshProfile,
  profileRequiresDws,
  resolveDshProfile,
} from "./dsh-profile.ts";

test("parseDshProfile：未配置/空串保留生产默认 sdk", () => {
  assert.equal(parseDshProfile(undefined), "sdk");
  assert.equal(parseDshProfile(null), "sdk");
  assert.equal(parseDshProfile(""), "sdk");
  assert.deepEqual(DSH_PROFILE_NAMES, ["sdk", "sdk-s4b"]);
});

test("parseDshProfile：仅允许白名单中的 sdk / sdk-s4b", () => {
  assert.equal(parseDshProfile("sdk"), "sdk");
  assert.equal(parseDshProfile("sdk-s4b"), "sdk-s4b");
  assert.equal(profileRequiresDws("sdk"), true);
  assert.equal(profileRequiresDws("sdk-s4b"), false);
});

test("parseDshProfile：路径/参数/大小写/控制字符/原型链名称全部 fail-closed", () => {
  const bad = [
    " ",
    " sdk",
    "sdk ",
    "SDK",
    "Sdk-S4b",
    "sdk/../sdk",
    "../sdk",
    "..",
    "/srv/dpit/runtime/dsh-home/profiles/sdk",
    "C:\\dsh\\profiles\\sdk",
    "sdk;sdk-s4b",
    "sdk s4b",
    "--profile",
    "-sdk",
    `sdk${String.fromCharCode(10)}`,
    `sdk${String.fromCharCode(9)}`,
    `sdk${String.fromCharCode(0)}x`,
    "__proto__",
    "constructor",
    "toString",
    "a".repeat(65),
    `sdk${String.fromCharCode(0)}`,
  ];
  for (const raw of bad) {
    assert.throws(
      () => parseDshProfile(raw),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /\[CONFIG\] DSH_PROFILE/);
        assert.match(err.message, /allowed: sdk, sdk-s4b/);
        return true;
      },
      `应拒绝 DSH_PROFILE=${JSON.stringify(raw)}`,
    );
  }
});

test("resolveDshProfile：只读 DSH_PROFILE；其他字段不影响默认值", () => {
  assert.equal(resolveDshProfile({}), "sdk");
  assert.equal(resolveDshProfile({ DSH_PROFILE: "" }), "sdk");
  assert.equal(resolveDshProfile({ DSH_PROFILE: "sdk-s4b" }), "sdk-s4b");
  assert.throws(() => resolveDshProfile({ DSH_PROFILE: "../../sdk" }), /\[CONFIG\] DSH_PROFILE/);
});
