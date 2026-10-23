// S4-B2-B1：DSH Profile 服务端固定白名单。
//
// Profile 只能由可信服务端 env（DSH_PROFILE）选择，不能由 HTTP/任务参数/Agent 工具
// 覆盖。默认生产行为保持 sdk；测试环境可显式 sdk-s4b（无 mcp-dws）。
//
// 名称校验先于 allowlist：拒绝绝对路径、路径穿越、空白、命令/参数拼接字符。
// 非法值 fail-closed（[CONFIG] 抛错），不静默回退默认值。

export const DSH_PROFILE_NAMES = ["sdk", "sdk-s4b"] as const;
export type DshProfile = (typeof DSH_PROFILE_NAMES)[number];

interface DshProfileMeta {
  /** sdk profile 的 mcp-dws 需要 DWS_USER/DWS_PASSWORD；sdk-s4b 完全不需要。 */
  requiresDws: boolean;
}

const PROFILE_META: Record<DshProfile, DshProfileMeta> = {
  sdk: { requiresDws: true },
  "sdk-s4b": { requiresDws: false },
};

/** 仅小写字母/数字开头，后续允许 . _ -；最长 64 字符。 */
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function parseDshProfile(raw: string | undefined | null): DshProfile {
  // 未配置 / 空串 = 保留默认生产行为。
  if (raw === undefined || raw === null || raw === "") return "sdk";

  const validName =
    typeof raw === "string" &&
    PROFILE_NAME_RE.test(raw) &&
    !raw.includes("..") &&
    Object.hasOwn(PROFILE_META, raw);
  if (!validName) {
    throw new Error(
      `[CONFIG] DSH_PROFILE ${JSON.stringify(raw)} is not allowed; allowed: ${DSH_PROFILE_NAMES.join(", ")}`,
    );
  }
  return raw as DshProfile;
}

/** 从可信服务端 env 解析；不读取请求/任务字段。 */
export function resolveDshProfile(env: NodeJS.ProcessEnv = process.env): DshProfile {
  return parseDshProfile(env.DSH_PROFILE);
}

export function profileRequiresDws(profile: DshProfile): boolean {
  return PROFILE_META[profile].requiresDws;
}
