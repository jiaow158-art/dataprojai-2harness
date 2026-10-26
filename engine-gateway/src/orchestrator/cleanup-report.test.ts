// S4-B2-C2-B1：清理结果契约的不可变与 seal 规则。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createPendingTaskCleanupReport,
  sealTaskCleanupReport,
  type CleanupComponent,
  type TaskCleanupReportDraft,
} from "./cleanup-report.ts";

const COMPONENTS: CleanupComponent[] = ["dsh", "runner", "docker", "acl", "audit"];

function allPassed(platform: "linux" | "win32" | "other" = "linux"): TaskCleanupReportDraft {
  const d = createPendingTaskCleanupReport({
    cleanupId: "cleanup-test-1",
    runId: "run-cleanup-test",
    attempt: 2,
    trigger: "task_success",
    platform,
    now: "2026-10-25T12:00:00.000Z",
  });
  for (const key of COMPONENTS) {
    d.checks[key] = {
      component: key,
      required: true,
      status: "passed",
      reason: "TEST_PASSED",
      evidence:
        key === "dsh"
          ? { pid: 1234, pgid: 1234, startTicks: "1", processGroupAbsent: true, directChildExited: true }
          : key === "runner"
            ? { pgid: 4321, processGroupAbsent: true }
            : key === "acl"
              ? { platform: "linux", aclStateFiles: 0, aclResidualEntries: 0, aclVerifiedWith: "getfacl" }
              : {},
    };
  }
  if (platform === "win32") {
    d.checks.acl = {
      component: "acl",
      required: false,
      status: "not_applicable",
      reason: "ACL_NOT_APPLICABLE_PLATFORM",
      evidence: { platform: "win32" },
      applicability: { basis: "platform", detail: "win32" },
    };
  }
  return d;
}

function seal(d: TaskCleanupReportDraft) {
  return sealTaskCleanupReport(d, "2026-10-25T12:00:01.000Z");
}

function assertCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (err: any) => err?.code === code, `expected ${code}`);
}

test("全部必需项 passed：seal 后 overallOk=true，且草稿未被修改", () => {
  const d = allPassed();
  const before = structuredClone(d);
  const report = seal(d);
  assert.equal(report.overallOk, true);
  assert.equal(report.finishedAt, "2026-10-25T12:00:01.000Z");
  assert.deepEqual(d, before, "seal 不应修改草稿");
  assert.equal(report.checks.audit.status, "passed");
  assert.equal(report.cleanupId, "cleanup-test-1");
});

test("pending 永不 overallOk=true", () => {
  for (const key of COMPONENTS) {
    const d = allPassed();
    d.checks[key] = {
      component: key,
      required: key !== "acl" || true,
      status: "pending",
      reason: "PENDING",
      evidence: {},
    };
    const report = seal(d);
    assert.equal(report.overallOk, false, `${key} pending 不得成功`);
    assert.equal(report.checks[key].status, "pending");
  }
});

test("failed 永不 overallOk=true；audit failed 独立可见", () => {
  const d = allPassed();
  d.checks.audit = {
    component: "audit",
    required: true,
    status: "failed",
    reason: "AUDIT_WRITE_FAILED",
    evidence: { auditFailures: 2 },
  };
  const report = seal(d);
  assert.equal(report.overallOk, false);
  assert.equal(report.checks.audit.status, "failed");
  assert.equal(report.checks.audit.evidence.auditFailures, 2);
  assert.equal(report.checks.docker.status, "passed", "审计失败不应伪装成 Docker 失败");
});

test("not_applicable 无 applicability 依据拒绝", () => {
  const d = allPassed();
  d.checks.dsh = {
    component: "dsh",
    required: false,
    status: "not_applicable",
    reason: "DSH_NOT_SPAWNED",
    evidence: {},
  };
  assertCode(() => seal(d), "REPORT_NA_BASIS_REQUIRED");
});

test("required 项 not_applicable 拒绝", () => {
  const d = allPassed();
  d.checks.runner = {
    component: "runner",
    required: true,
    status: "not_applicable",
    reason: "RUNNER_GROUP_EMPTY",
    evidence: {},
    applicability: { basis: "lifecycle", detail: "no_dsh_spawn" },
  };
  assertCode(() => seal(d), "REPORT_NA_REQUIRED");
});

test("DSH lifecycle N/A 依据可靠时，Runner 也必须 N/A，且 overallOk 可成功", () => {
  const d = allPassed();
  d.checks.dsh = {
    component: "dsh",
    required: false,
    status: "not_applicable",
    reason: "DSH_NOT_SPAWNED",
    evidence: {},
    applicability: { basis: "lifecycle", detail: "dsh_not_spawned" },
  };
  d.checks.runner = {
    component: "runner",
    required: false,
    status: "not_applicable",
    reason: "RUNNER_NOT_SPAWNED",
    evidence: {},
    applicability: { basis: "lifecycle", detail: "dsh_not_spawned" },
  };
  const report = seal(d);
  assert.equal(report.checks.dsh.status, "not_applicable");
  assert.equal(report.checks.runner.status, "not_applicable");
  assert.equal(report.overallOk, true);
});

test("DSH 已启动但 Runner 未启动：Runner lifecycle N/A，DSH 仍需有自己的证据", () => {
  const d = allPassed();
  d.checks.runner = {
    component: "runner",
    required: false,
    status: "not_applicable",
    reason: "RUNNER_NOT_SPAWNED",
    evidence: {},
    applicability: { basis: "lifecycle", detail: "runner_not_spawned" },
  };
  const report = seal(d);
  assert.equal(report.checks.runner.status, "not_applicable");
  assert.equal(report.overallOk, true);
});

test("生命周期矛盾：DSH 未启动但 Runner passed / Runner unknown 均拒绝 N/A 伪证", () => {
  const d = allPassed();
  d.checks.dsh = {
    component: "dsh",
    required: false,
    status: "not_applicable",
    reason: "DSH_NOT_SPAWNED",
    evidence: {},
    applicability: { basis: "lifecycle", detail: "dsh_not_spawned" },
  };
  assertCode(() => seal(d), "REPORT_LIFECYCLE_INCONSISTENT");

  const d2 = allPassed();
  d2.checks.runner = {
    component: "runner",
    required: false,
    status: "not_applicable",
    reason: "RUNNER_NOT_SPAWNED",
    evidence: {},
    applicability: { basis: "lifecycle", detail: "runner_unknown" },
  };
  assertCode(() => seal(d2), "REPORT_NA_BASIS_INVALID");

  const d3 = allPassed();
  d3.checks.runner = {
    component: "runner",
    required: false,
    status: "not_applicable",
    reason: "RUNNER_NOT_SPAWNED",
    evidence: {},
    applicability: { basis: "lifecycle", detail: "dsh_not_spawned" },
  };
  assertCode(() => seal(d3), "REPORT_LIFECYCLE_INCONSISTENT");
});

test("Linux ACL 不允许 not_applicable，也不允许 required=false", () => {
  const d = allPassed();
  d.checks.acl = {
    component: "acl",
    required: false,
    status: "not_applicable",
    reason: "ACL_NOT_APPLICABLE_PLATFORM",
    evidence: { platform: "linux" },
    applicability: { basis: "platform", detail: "linux" },
  };
  assertCode(() => seal(d), "ACL_NA_FORBIDDEN_LINUX");

  const d2 = allPassed();
  d2.checks.acl = {
    component: "acl",
    required: false,
    status: "pending",
    reason: "PENDING",
    evidence: {},
  };
  assertCode(() => seal(d2), "ACL_REQUIRED_LINUX");
});

test("非 Linux/win32 平台 ACL 必须 required，且不得伪造 passed", () => {
  const d = allPassed("other");
  assert.equal(d.checks.acl.required, true);
  d.checks.acl = {
    component: "acl",
    required: true,
    status: "pending",
    reason: "ACL_PLATFORM_UNVERIFIABLE",
    evidence: { platform: "other" },
  };
  const report = seal(d);
  assert.equal(report.overallOk, false);

  const d2 = allPassed("other");
  d2.checks.acl = {
    component: "acl",
    required: true,
    status: "passed",
    reason: "ACL_CLEAN",
    evidence: { platform: "other", aclStateFiles: 0, aclResidualEntries: 0, aclVerifiedWith: "getfacl" },
  };
  assertCode(() => seal(d2), "ACL_PLATFORM_UNVERIFIABLE");
});

test("Linux ACL passed 必须带 getfacl/零残留证据", () => {
  const d = allPassed();
  d.checks.acl = {
    component: "acl",
    required: true,
    status: "passed",
    reason: "ACL_NO_65534_RESIDUAL",
    evidence: {},
  };
  assertCode(() => seal(d), "ACL_EVIDENCE_INVALID");
});

test("DSH passed 必须带 processGroupAbsent 证据", () => {
  const d = allPassed();
  d.checks.dsh.evidence = {};
  assertCode(() => seal(d), "DSH_EVIDENCE_INVALID");
});

test("Runner 覆盖证明：必须与 DSH 同 PGID 且 DSH 已通过", () => {
  const d = allPassed();
  d.checks.runner.evidence = { pgid: 1234, processGroupAbsent: true, coveredBy: "dsh_process_group" };
  d.checks.dsh.evidence = { ...d.checks.dsh.evidence, pgid: 999 };
  assertCode(() => seal(d), "RUNNER_COVERAGE_UNPROVEN");

  const d2 = allPassed();
  d2.checks.runner.evidence = { pgid: 1234, processGroupAbsent: true, coveredBy: "dsh_process_group" };
  d2.checks.dsh.status = "pending";
  d2.checks.dsh.reason = "PENDING";
  assertCode(() => seal(d2), "RUNNER_COVERAGE_UNPROVEN");

  const ok = allPassed();
  ok.checks.runner.evidence = { pgid: 1234, processGroupAbsent: true, coveredBy: "dsh_process_group" };
  assert.equal(seal(ok).overallOk, true);
});

test("Runner 独立进程组 passed 必须带自己的 PGID 和 processGroupAbsent", () => {
  const d = allPassed();
  d.checks.runner = {
    component: "runner",
    required: true,
    status: "passed",
    reason: "RUNNER_GROUP_EXITED",
    evidence: {},
  };
  assertCode(() => seal(d), "RUNNER_EVIDENCE_INVALID");

  d.checks.runner.evidence = { pgid: 4321, processGroupAbsent: true };
  assert.equal(seal(d).overallOk, true);
});

test("coveredBy 只能出现在 Runner 检查项", () => {
  const d = allPassed();
  d.checks.audit.evidence = { coveredBy: "dsh_process_group" };
  assertCode(() => seal(d), "REPORT_EVIDENCE_INVALID");
});

test("win32 ACL 只能 N/A，且 basis=platform/detail=win32", () => {
  const ok = seal(allPassed("win32"));
  assert.equal(ok.overallOk, true);
  assert.equal(ok.checks.acl.status, "not_applicable");

  const d = allPassed("win32");
  d.checks.acl = {
    component: "acl",
    required: true,
    status: "passed",
    reason: "ACL_CLEAN",
    evidence: {},
  };
  assertCode(() => seal(d), "ACL_NA_REQUIRED_WIN32");
});

test("Docker / Audit 永远必需且不可 not_applicable", () => {
  for (const key of ["docker", "audit"] as const) {
    const d = allPassed();
    d.checks[key] = {
      component: key,
      required: false,
      status: "not_applicable",
      reason: "TEST_NA",
      evidence: {},
      applicability: { basis: "lifecycle", detail: "test" },
    };
    assertCode(() => seal(d), "REPORT_NA_FORBIDDEN");
  }
});

test("证据只允许 code-only 白名单字段", () => {
  const d = allPassed();
  d.checks.docker = {
    component: "docker",
    required: true,
    status: "passed",
    reason: "DOCKER_CLEAN",
    evidence: { scriptText: "print(1)" } as any,
  };
  assertCode(() => seal(d), "REPORT_EVIDENCE_INVALID");

  const d2 = allPassed();
  d2.checks.docker = {
    component: "docker",
    required: true,
    status: "passed",
    reason: "DOCKER_CLEAN",
    evidence: { foo: { nested: true } } as any,
  };
  assertCode(() => seal(d2), "REPORT_EVIDENCE_INVALID");
});

test("reason 必须是封闭集风格，不接受路径/空格/自由文本", () => {
  for (const reason of ["/srv/dpit/secret", "audit failed", "bad-reason", "1BAD"]) {
    const d = allPassed();
    d.checks.audit.reason = reason;
    assertCode(() => seal(d), "REPORT_REASON_INVALID");
  }
  const tooLong = allPassed();
  tooLong.checks.audit.reason = "A".repeat(65);
  assertCode(() => seal(tooLong), "REPORT_FIELD_INVALID");
});

test("seal 后深冻结，不可修改状态或 overallOk", () => {
  const report = seal(allPassed());
  assert.ok(Object.isFrozen(report));
  assert.ok(Object.isFrozen(report.checks));
  assert.ok(Object.isFrozen(report.checks.audit));
  assert.ok(Object.isFrozen(report.checks.audit.evidence));
  assert.throws(() => {
    (report as any).overallOk = true;
  }, TypeError);
  assert.throws(() => {
    (report.checks.audit as any).status = "passed";
  }, TypeError);
});

test("缺少任一检查项拒绝", () => {
  const d = allPassed();
  delete (d.checks as any).audit;
  assertCode(() => seal(d), "REPORT_CHECK_INVALID");
});

test("组件与键位不一致拒绝", () => {
  const d = allPassed();
  d.checks.runner = { ...d.checks.runner, component: "dsh" };
  assertCode(() => seal(d), "REPORT_COMPONENT_MISMATCH");
});

test("finishedAt 早于 startedAt 拒绝", () => {
  const d = allPassed();
  assertCode(
    () => sealTaskCleanupReport(d, "2026-10-25T11:59:59.000Z"),
    "REPORT_TIME_INVALID",
  );
});

test("createPending 初始全部 pending；win32 ACL required=false；overallOk 尚不可成功", () => {
  const d = createPendingTaskCleanupReport({
    runId: "run-pending",
    attempt: 0,
    trigger: "cancel",
    platform: "win32",
  });
  for (const key of COMPONENTS) {
    assert.equal(d.checks[key].status, "pending");
    assert.equal(d.overallOk, false);
  }
  assert.equal(d.checks.acl.required, false);
  assert.equal(d.checks.docker.required, true);
  assert.equal(d.checks.audit.required, true);
});
