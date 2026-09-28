# insight/attribution.py
"""归因管道：prompt 构造 → 网关提交/SSE 消费 → 结构化 JSON 提取校验 → 降级。

网关契约（前置事实#2）：POST /api/tasks 提交；答案/报告/SSE 在
GET /api/tasks/{run_id}/events（事件 stage/sql/answer/report/error/done）。
解析失败严禁从自然语言猜字段——直接降级（检测层事实+AI 原文+继续问AI）。"""
import json
import re
from dataclasses import dataclass


@dataclass
class AttributionResult:
    run_id: str = ""
    status: str = ""                     # submitted|succeeded|failed
    answer_md: str = ""
    report_path: str | None = None
    error_code: str = ""
    parsed: dict | None = None           # 结构化产物；降级为 None
    degraded_reason: str = ""


_JSON_BLOCK = re.compile(r"```json\s*(\{.*?\})\s*```", re.DOTALL)


def build_prompt(title: str, summary: str, metric: str, scope: str, period: str,
                 facts: list[dict], detector: str) -> str:
    ar_hint = ("\n归因查询提示：优先使用 dm.dm_ar_analysis_rpt_f（综合分析报表）的"
               "省/市/区、cust_risk_lev、proj_rcv_risk_lev、WBS、collection_rate 等"
               "字段做客户画像与区域归因。" if detector == "ar_risk" else "")
    facts_txt = "\n".join(f"- {f['label']}: {f['value']}" for f in facts) or "-（无）"
    return f"""你是经营分析助手。以下经营事件已由确定性检测确认，请按对应业务域的
标准分析工作流做下钻归因，所有结论必须出自你实际执行的查询结果。

【事件】{title}
【摘要】{summary}
【指标】{metric}
【范围】{scope}
【涉及期间】{period}
【已确认事实（检测层，可信）】
{facts_txt}{ar_hint}

回答要求：
1. 先给执行摘要（发生了什么、主要影响在哪、量级多少）。
2. 正文给出下钻路径（逐级贡献）、关键发现、重点影响对象。
3. **最后必须追加一个机器可读 JSON 代码块**（```json 包裹），schema：
{{"summary": str, "path": [{{"level": str, "contribution": str}}],
  "findings": [{{"text": str, "evidence": str}}],
  "waterfall": [{{"name": str, "value": number}}],
  "entities": [{{"name": str, "type": str, "delta": str}}]}}
findings 每条必须带 evidence（对应哪次查询的结果）；五键齐全，不要输出其他键。"""


def parse_sse_stream(lines) -> AttributionResult:
    """SSE 行迭代器 → AttributionResult。镜像 ask.py 的帧解析：跳过 : 注释行；
    event: 记当前事件；data: 行累积；空行（及流末）时 join("\\n") 严格
    json.loads 后按事件分发，解析失败丢弃该事件——网关唯一写帧点
    （http.ts sseFrame）实 wire 即单行转义 JSON，损坏流不宽容、直接降级。"""
    res = AttributionResult()
    ev: str | None = None
    buf: list[str] = []

    def dispatch() -> None:
        nonlocal ev, buf
        if ev is not None and buf:
            try:
                payload = json.loads("\n".join(buf))
            except json.JSONDecodeError:
                payload = None           # 损坏事件丢弃，绝不猜
            if isinstance(payload, dict):
                _apply_event(res, ev, payload)
        ev, buf = None, []

    for raw_line in lines:
        line = raw_line.rstrip("\r\n")
        if line.startswith(":"):
            continue                     # SSE 注释/心跳行
        if not line.strip():             # 空行 = 帧边界，分发并复位
            dispatch()
        elif line.startswith("event: "):
            ev = line[7:].strip()
        elif line.startswith("data: "):
            buf.append(line[6:])
        # 其余行（如 id:/retry:）忽略，与 ask.py 一致
    dispatch()                           # 流末冲刷
    return res


def _apply_event(res: AttributionResult, ev: str, payload: dict) -> None:
    if ev == "answer":
        res.answer_md = payload.get("markdown") or res.answer_md   # 取最后一条
    elif ev == "report":
        res.report_path = payload.get("path")
    elif ev == "error":
        res.error_code = payload.get("code", "")
    elif ev == "done":
        res.status = payload.get("status", "")


def extract_structured(answer_md: str) -> dict | None:
    """提取最后一个 ```json 块并做宽松 schema 校验；无证据 findings 条目剔除；
    任何不满足 → None（调用方降级，绝不猜字段）。"""
    blocks = _JSON_BLOCK.findall(answer_md or "")
    if not blocks:
        return None
    try:
        obj = json.loads(blocks[-1])
    except json.JSONDecodeError:
        return None
    for k in ("summary", "path", "findings", "waterfall", "entities"):
        if k not in obj or not isinstance(obj[k], (str, list)):
            return None
    kept = [f for f in obj["findings"]
            if isinstance(f, dict) and str(f.get("evidence") or "").strip()]
    obj["findings"] = kept
    return obj
