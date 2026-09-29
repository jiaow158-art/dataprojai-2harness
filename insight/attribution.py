# insight/attribution.py
"""归因管道：prompt 构造 → 网关提交/SSE 消费 → 结构化 JSON 提取校验 → 降级。

网关契约（前置事实#2）：POST /api/tasks 提交；答案/报告/SSE 在
GET /api/tasks/{run_id}/events（事件 stage/sql/answer/report/error/done）。
解析失败严禁从自然语言猜字段——直接降级（检测层事实+AI 原文+继续问AI）。"""
import json
import os
import re
import http.client as _http
from dataclasses import dataclass
from urllib.parse import urlparse as _urlparse


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
    """提取最后一个 ```json 块并做逐键类型校验（summary:str，其余四键:list；
    缺键/错形 → None，绝不猜字段）；无证据 findings 条目剔除。"""
    blocks = _JSON_BLOCK.findall(answer_md or "")
    if not blocks:
        return None
    try:
        obj = json.loads(blocks[-1])
    except json.JSONDecodeError:
        return None
    if not isinstance(obj, dict) or not isinstance(obj.get("summary"), str):
        return None
    for k in ("path", "findings", "waterfall", "entities"):
        if not isinstance(obj.get(k), list):
            return None
    kept = [f for f in obj["findings"]
            if isinstance(f, dict) and str(f.get("evidence") or "").strip()]
    obj["findings"] = kept
    return obj


# —— 网关传输与编排（Task 6 追加；传输函数可 monkeypatch 测试）——

def _gw_cfg() -> dict:
    return {"url": os.environ.get("GW_URL", "http://127.0.0.1:58080"),
            "token": os.environ.get("GW_AUTH_TOKEN", ""),
            "user": os.environ.get("INSIGHT_GW_USER", "insight-svc")}


def _gw_submit(prompt: str, client_submission_id: str) -> str:
    cfg = _gw_cfg()
    u = _urlparse(cfg["url"])
    conn = _http.HTTPConnection(u.hostname, u.port or 80, timeout=30)
    body = json.dumps({"question": prompt,
                       "client_submission_id": client_submission_id}).encode("utf-8")
    # bytes body：http.client 自设字节精确的 Content-Length（中文 prompt 下手工
    # len(str) 会算字符数而非字节数）
    conn.request("POST", "/api/tasks", body, {
        "Authorization": f"Bearer {cfg['token']}", "X-User": cfg["user"],
        "Content-Type": "application/json"})
    resp = conn.getresponse()
    data = resp.read().decode("utf-8", "replace")
    conn.close()
    if resp.status != 201:
        # 注意：错误信息只带响应体前 120 字符（网关响应不含 token，token 只进请求头）
        raise RuntimeError(f"gateway submit {resp.status}: {data[:120]}")
    return json.loads(data)["run_id"]


def _gw_consume(run_id: str) -> AttributionResult:
    """SSE 长连接读到 done（镜像 ask.py：一次连接顺序读事件行）。"""
    cfg = _gw_cfg()
    u = _urlparse(cfg["url"])
    conn = _http.HTTPConnection(u.hostname, u.port or 80, timeout=1900)
    conn.request("GET", f"/api/tasks/{run_id}/events", headers={
        "Authorization": f"Bearer {cfg['token']}", "X-User": cfg["user"]})
    resp = conn.getresponse()
    if resp.status != 200:
        conn.close()
        raise RuntimeError(f"gateway events {resp.status}")
    lines = (raw.decode("utf-8", "replace").rstrip("\r\n") for raw in resp)
    res = parse_sse_stream(lines)
    res.run_id = run_id
    conn.close()
    return res


def run_attribution(store, event_id: str, analysis_date: str) -> dict:
    """提交→消费→提取→落 event_analysis_run（每行一版本）→更新事件当前态。

    失败/超时/JSON 校验失败 → failed|degraded；事件照常在榜（归因是增强不是阻塞）。
    持久化三态 done|degraded|failed（succeeded/submitted 只是传输层中间态，不落库）。"""
    ev = store.db.execute("SELECT * FROM business_event WHERE event_id=?",
                          (event_id,)).fetchone()
    if ev is None:
        raise ValueError(f"event not found: {event_id}")
    prompt = build_prompt(title=ev["title"], summary=ev["summary"], metric=ev["metric"],
                          scope=json.loads(ev["scope_json"]).get("范围", "瓷砖事业部"),
                          period=json.loads(ev["period_json"]).get("类型", "月"),
                          facts=json.loads(ev["facts_json"]), detector=ev["detector"])
    result = AttributionResult(status="submitted")
    try:
        result.run_id = _gw_submit(prompt, f"{event_id}:{analysis_date}")
        result = _gw_consume(result.run_id)
    except Exception as e:                      # 网关层任何异常 → failed（重试由 worker 编排）
        result.status = "failed"
        result.degraded_reason = repr(e)[:200]  # 网关异常不含 token（只进请求头）
    if result.status not in ("succeeded", "failed"):
        # 非异常的非 succeeded 终态归一：EOF 无 done（status=""）或 done 带未知
        # 终态（如 cancelled）——先记 reason 再改 status，保留原始终态语义
        result.degraded_reason = f"gateway-terminal:{result.status or 'no-done-event'}"
        result.status = "failed"

    parsed = None
    if result.status == "succeeded":
        parsed = extract_structured(result.answer_md)
        if parsed is None:
            result.status = "degraded"
            result.degraded_reason = "no-valid-json-block"
        else:
            result.status = "done"

    store.db.execute(
        "INSERT INTO event_analysis_run (analysis_id, event_id, analysis_date,"
        " gateway_run_id, status, answer_md, report_path, parsed_json,"
        " submitted_at, finished_at)"
        " VALUES (?,?,?,?,?,?,?,?,strftime('%s','now'),strftime('%s','now'))",
        (_uid("an"), event_id, analysis_date, result.run_id, result.status,
         result.answer_md, result.report_path,
         json.dumps(parsed, ensure_ascii=False) if parsed else None))
    store.db.execute(
        "UPDATE business_event SET attribution_status=?, attribution_summary=?,"
        " attribution_json=?, attribution_run_id=?,"
        " attribution_generated_at=strftime('%s','now'),"
        " status=CASE WHEN ?='done' THEN 'analyzed' ELSE status END,"
        " updated_at=strftime('%s','now') WHERE event_id=?",
        (result.status, (parsed or {}).get("summary") or ev["summary"],
         json.dumps(parsed, ensure_ascii=False) if parsed else None,
         result.run_id, result.status, event_id))
    store.db.commit()
    return {"status": result.status, "parsed": parsed,
            "degraded_reason": result.degraded_reason, "run_id": result.run_id}


def _uid(prefix: str) -> str:
    import uuid as _uuid
    return f"{prefix}-{_uuid.uuid4().hex[:12]}"
