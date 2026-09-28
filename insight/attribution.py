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


def _load_sse_json(raw: str):
    """解析 SSE data 合并串：先严格 json.loads，失败退 strict=False（容忍裸嵌
    markdown 里的真实换行）。返回 (是否可解析, payload)，绝不抛异常。"""
    for strict in (True, False):
        try:
            return True, json.loads(raw, strict=strict)
        except json.JSONDecodeError:
            continue
    return False, None


def parse_sse_stream(lines) -> AttributionResult:
    """SSE 行迭代器 → AttributionResult。镜像 ask.py 的事件面：data: 行累积至
    空行合并（join "\\n"）解析分发。对裸嵌答案 markdown（含真实换行、续行无
    data: 前缀）的容错：空行处解析失败则保留缓冲续积、后续行并入；事件边界
    与流末强制冲刷（不可解析残包放弃）。"""
    res = AttributionResult()
    ev: str | None = None
    buf: list[str] = []

    def try_flush(keep_on_fail: bool) -> None:
        nonlocal buf
        if not ev or not buf:
            return
        ok, payload = _load_sse_json("\n".join(buf))
        if not ok:
            if not keep_on_fail:
                buf = []                 # 事件边界：残包放弃
            return                       # keep：裸嵌数据的中间空行，续积
        if isinstance(payload, dict):
            _apply_event(res, ev, payload)
        buf = []

    for raw_line in lines:
        line = raw_line.rstrip("\r\n")
        if line.startswith(":"):
            continue                     # SSE 注释/心跳行
        if line.startswith("event: "):
            try_flush(keep_on_fail=False)
            ev = line[7:].strip()
        elif line.startswith("data: "):
            buf.append(line[6:])
        elif not line.strip():
            try_flush(keep_on_fail=True)
        elif buf:
            buf.append(line)             # 裸嵌续行（无 data: 前缀）并入缓冲
        # 其余未知行（如 id:/retry:）忽略，与 ask.py 一致
    try_flush(keep_on_fail=False)        # 流末冲刷
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
