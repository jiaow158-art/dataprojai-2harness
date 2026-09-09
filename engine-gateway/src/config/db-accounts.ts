// M1-T3: 权限组 → DB 账号映射（spec §7 底线 2：运行账号与管理账号分开）。
//
// 这是 L4 集成位：DBA 建受限只读账号是用户侧行动项（M3 试点前）。
// 网关启动/任务执行时用 resolveDbAccount(scopeGroup) 拿账号与密码 env 名，
// DWS_RUN_USER 未设时回退现账号 aiuser 并 WARN——账号建好后设 env 即切换，
// 零代码改动。
//
// 注意：user 在 resolveDbAccount 调用时从 env 求值（非模块加载时固化），
// 保证测试可 mock env、运行时切换账号无需重载模块。

export interface DbAccount {
  user: string;
  passwordEnv: string; // 密码只透传 env 名，值不进任何日志/文件（密钥红线）
  note: string;
}

// 账号定义。当前仅一个权限组；新增组时在此加条目。
interface DbAccountDef {
  userEnv: string; // 未设时回退 fallbackUser
  fallbackUser: string;
  passwordEnv: string;
  note: string;
}

const ACCOUNTS: Record<string, DbAccountDef> = {
  default: {
    userEnv: "DWS_RUN_USER",
    fallbackUser: "aiuser",
    passwordEnv: "DWS_RUN_PASSWORD",
    note: "受限只读运行账号；未建时回退 aiuser（WARN）",
  },
};

/**
 * 按权限组解析 DB 运行账号。
 * 空串/undefined/null 视为 "default"（网关请求里 scope_group 有默认值，防御性处理）。
 * 未知组抛错——宁可失败也不静默降级到别的账号。
 */
export function resolveDbAccount(scopeGroup: string | undefined | null): DbAccount {
  const group = scopeGroup || "default";
  const def = ACCOUNTS[group];
  if (!def) {
    throw new Error(`unknown scope group: ${String(scopeGroup)}`);
  }
  return {
    user: process.env[def.userEnv] ?? def.fallbackUser,
    passwordEnv: def.passwordEnv,
    note: def.note,
  };
}

/**
 * 回退形态警告（供调用方日志标 WARN）。
 * 回退判定：process.env.DWS_RUN_USER 未设即回退（与 resolveDbAccount 同源）。
 */
export function dbAccountWarnings(_account: DbAccount): string[] {
  if (!process.env.DWS_RUN_USER) {
    return [
      "FALLBACK: DWS_RUN_USER 未设，回退使用 aiuser——spec §7 底线2（运行/管理账号分开）未满足，M3 试点前须切换受限只读账号",
    ];
  }
  return [];
}
