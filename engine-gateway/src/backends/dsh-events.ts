// M1-T5：dsh SDK 事件 → spec §5 规范事件归一化（纯函数，无 IO，完全可单测）。
//
// 词表 = spec §5 六类，与 src/store/task-store.ts 文件头"事件词表契约"逐字一致：
//   "stage"  → {stage, text?}    stage ∈ queued|analyzing|querying|script_running|report_checking|repairing|publishing
//   "sql"    → {sql, rows, truncated, result_ref, elapsed_ms}
//   "answer" → {markdown}
//   "report" → {path}
//   "error"  → {code, message}
//   "done"   → {run_id, status, engine, elapsed_ms, tokens, recovered}
//              —— done 不在归一化产出：run_id/status/tokens 属编排层（T7 TaskRunner），
//                 后端只负责前五类 + 流终止信号（turn/end completed）。
//
// stage 映射规则（依据 M0-T16 真实会话轨迹定型，fixture 即其样本）：
//   tool/call name=mcp__dws__run_query      → querying（调用期；tool/result 转 sql 事件收口）
//   tool/call name=exec_script              → script_running
//   tool/call name=skill 且参数含 report-generator → report_checking（报告构建期起点；
//             后续 exec_script(read/grep) 不再逐个改 stage，保持阶段稳定）
//   其余 tool/call                           → analyzing 附原文（工具名，SSE 前端可见进展）
//   turn/start                              → analyzing（新一轮开始）
//   repairing 阶段判定属编排层（归一化器无 attempt 上下文），T7 经 task-store 的
//   stage 事件产出（attempt>0 重试起跑时）——本模块不产 repairing。
//   step/start / step/end / user/message / 头部事件（session/permission/sandbox/approval）
//                                          → 不产出（噪音；stage 由 tool/call 驱动）
//
// sql 事件的 sql 文本来源：tool/call 的 arguments.sql（按 callId 关联）；result 文本 JSON
// 提供 row_count/truncated/result_ref（M0 D13 双通道契约——run_query 结果只回预览+引用，
// 全量在 result_ref 文件）。result 文本若自带 sql 字段则以其为准（向前兼容）。
//
// turn/end reason 映射：kind=completed → 无事件（ask() 流终止）；其余 kind（error/
// max-tokens/…）→ error {code:"ENGINE_ERROR", message: reason 原文}。错误细分（TIMEOUT/
// CONFIG/…）由编排层按上下文判定，归一化只做忠实转译。

/** dsh session.event 通知的原生事件信封（dsh-sdk-protocol SessionEvent；宽松索引访问）。 */
export interface RawSdkEvent {
  type?: string;
  seq?: number;
  time?: number;
  data?: any;
}

/** spec §5 规范事件（六类中除 done 外的五类由本模块产出）。 */
export type NormEvent =
  | { type: "stage"; stage: NormStage; text?: string }
  | { type: "sql"; sql: string; rows: number | null; truncated: boolean | null; result_ref: string | null; elapsed_ms: number | null }
  | { type: "answer"; markdown: string }
  | { type: "report"; path: string }
  | { type: "error"; code: string; message: string };

export type NormStage =
  | "queued"
  | "analyzing"
  | "querying"
  | "script_running"
  | "report_checking"
  | "repairing"
  | "publishing";

const RUN_QUERY_TOOL = "mcp__dws__run_query";
const EXEC_SCRIPT_TOOL = "exec_script";

/** tool/result 文本中报告产物的探测（report-generator 管线 stdout："OK /workdir/reports/xxx.html"；
 *  只取 reports/ 起的相对段，宿主前缀（/workdir 等）由消费方按 workdir 映射）。 */
const REPORT_PATH_RE = /reports[\\/][\w.-]+\.html/;

/** 一次 ask() 调用内的归一化状态（callId → run_query 调用上下文）。 */
interface RunQueryCall {
  sql: string | null;
  time: number | null;
}

/**
 * 增量归一化器（流式）：backend ask() 逐事件喂入，callId 关联状态跨事件保持
 * （run_query 的 sql 原文在 tool/call、计数在 tool/result，两者相隔可达数分钟）。
 */
export class EventNormalizer {
  private runQueryCalls = new Map<string, RunQueryCall>();

  /** 喂入一个原始事件，返回 0..n 个规范事件。 */
  push(ev: RawSdkEvent): NormEvent[] {
    const out: NormEvent[] = [];
    const data = ev?.data ?? {};
    switch (ev?.type) {
      case "turn/start":
        out.push({ type: "stage", stage: "analyzing", text: `turn ${data.turn} started` });
        break;

      case "tool/call": {
        const name: string = data.name ?? "";
        if (name === RUN_QUERY_TOOL) {
          let sql: string | null = null;
          try {
            const args = JSON.parse(data.arguments ?? "{}");
            if (typeof args.sql === "string") sql = args.sql;
          } catch { /* arguments 非合法 JSON：sql 留空，result 侧可能自带 */ }
          if (data.callId) this.runQueryCalls.set(data.callId, { sql, time: ev.time ?? null });
          out.push({ type: "stage", stage: "querying", text: sql ?? "run_query" });
        } else if (name === EXEC_SCRIPT_TOOL) {
          out.push({ type: "stage", stage: "script_running", text: toolCallText(data) });
        } else if (name === "skill" && String(data.arguments ?? "").includes("report-generator")) {
          out.push({ type: "stage", stage: "report_checking", text: "skill report-generator" });
        } else {
          out.push({ type: "stage", stage: "analyzing", text: toolCallText(data) });
        }
        break;
      }

      case "tool/result": {
        const blocks = data?.message?.content ?? [];
        const texts: string[] = [];
        for (const outer of blocks) {
          for (const inner of outer?.content ?? []) {
            if (inner?.type === "text" && typeof inner.text === "string") texts.push(inner.text);
          }
        }
        const fullText = texts.join("\n");
        const callId = data?.message?.source?.callId;

        // run_query → sql 事件（M0 双通道：预览+result_ref）
        if (callId !== undefined && this.runQueryCalls.has(callId)) {
          const call = this.runQueryCalls.get(callId)!;
          const sql = parseSqlFromResultText(fullText) ?? call.sql ?? "";
          const rowInfo = parseRowCounters(fullText);
          out.push({
            type: "sql",
            sql,
            rows: rowInfo?.row_count ?? null,
            truncated: rowInfo?.truncated ?? null,
            result_ref: rowInfo?.result_ref ?? null,
            elapsed_ms: call.time != null && ev.time != null ? ev.time - call.time : null,
          });
          this.runQueryCalls.delete(callId);
          break;
        }

        // 报告产物探测（exec_script 构建管线的 stdout）
        const m = fullText.match(REPORT_PATH_RE);
        if (m) out.push({ type: "report", path: m[0].replace(/\\/g, "/") });
        break;
      }

      case "assistant/message": {
        const content = data?.message?.content ?? [];
        const hasText = content.some((b: any) => b?.type === "text");
        const hasToolCall = content.some((b: any) => b?.type === "tool-call");
        // 终文 = 有 text 块且无 tool-call 块（中间消息带 tool-call，reasoning 不算）
        if (hasText && !hasToolCall) {
          const markdown = content
            .filter((b: any) => b?.type === "text" && typeof b.text === "string")
            .map((b: any) => b.text)
            .join("");
          if (markdown) out.push({ type: "answer", markdown });
        }
        break;
      }

      case "turn/end": {
        const reason = data?.reason;
        if (reason?.kind !== "completed") {
          out.push({
            type: "error",
            code: "ENGINE_ERROR",
            message: JSON.stringify(reason ?? { kind: "unknown" }),
          });
        }
        break;
      }

      default:
        // step/start|end、user/message、session/permission/sandbox/approval 头部、
        // chunk 类（reasoning-chunks 等）——不产出（见文件头映射规则）。
        break;
    }
    return out;
  }
}

/**
 * 归一化一批原始 SDK 事件（单 turn 或跨 turn 均可；callId 关联在批内完成）。
 * 纯函数：同输入同输出，无副作用，直接以 fixture JSON 单测。
 */
export function normalize(events: RawSdkEvent[]): NormEvent[] {
  const n = new EventNormalizer();
  const out: NormEvent[] = [];
  for (const ev of events) out.push(...n.push(ev));
  return out;
}

/** tool/call 的 stage 附文（SSE 可读）：工具名 + 参数首段截断。 */
function toolCallText(data: any): string {
  const name = data?.name ?? "tool";
  let args = "";
  try {
    const parsed = JSON.parse(data?.arguments ?? "{}");
    const first = Object.values(parsed)[0];
    if (typeof first === "string") args = ` ${first.slice(0, 60)}`;
  } catch { /* 保持只有工具名 */ }
  return `${name}${args}`.trim();
}

/** run_query result 文本若是合法 JSON 且含 sql 字段则取之。 */
function parseSqlFromResultText(text: string): string | null {
  try {
    const obj = JSON.parse(text);
    return typeof obj?.sql === "string" ? obj.sql : null;
  } catch {
    return null;
  }
}

/** run_query result 文本提取 {row_count, truncated, result_ref}。 */
function parseRowCounters(text: string): { row_count: number; truncated: boolean; result_ref: string } | null {
  try {
    const obj = JSON.parse(text);
    if (typeof obj?.row_count !== "number" || typeof obj?.truncated !== "boolean" || typeof obj?.result_ref !== "string") {
      return null;
    }
    return { row_count: obj.row_count, truncated: obj.truncated, result_ref: obj.result_ref };
  } catch {
    return null;
  }
}
