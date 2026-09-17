"""M2-T2 eval 驱动器 — 判分器接真网关（live 全链路，与线上同路径）。

用法（对齐 run_eval.py 的位置参数域过滤，另加选项）：
    EVAL_LIVE=1 python run_agent_eval.py                       # 全部 71 场景（预计小时级）
    EVAL_LIVE=1 python run_agent_eval.py inventory             # 单域
    EVAL_LIVE=1 python run_agent_eval.py inventory --limit 1 --round-tag smoke
    EVAL_LIVE=1 python run_agent_eval.py --only-failed         # 读上一轮 summary 复跑非 PASS（绕缓存）
    EVAL_LIVE=1 python run_agent_eval.py --fresh               # 无视缓存全重跑

门禁：必须显式 EVAL_LIVE=1（真 dsh + 真 DeepSeek + 真 DWS，防误跑烧 API）。
退出码：0=管道跑完（场景 FAIL 不影响——判分结论看 report.md）；1=管道级错误；130=中断。
中断安全：每场景完成即写缓存与明细，Ctrl-C 后重跑自动续（缓存指纹一致才跳过）。

网关两态：
  - env GATEWAY_URL 已设 → 直连已起网关（Bearer 用 env AUTH_TOKEN；result_ref 读回按
    env GW_RESULTS_ROOT 定位——直连时须与被连网关一致）；
  - 否则 subprocess 起网关（env 组装同 engine-gateway/test/soak.mjs；port 随机；
    GW_DB_PATH/GW_WORKROOT/GW_RESULTS_ROOT/GATEWAY_REPORTS_DIR 指向 eval_results/gw-<ts>/
    独立工作树；结束杀进程树）。任务预算 env EVAL_TASK_BUDGET_S（默认 1800，全量回归建议 600）。

真值：期望 SQL 用 psycopg2 重导 DWS（statement_timeout 60s，fetchmany 上限 2001）；
dataset.data 与 fresh 不一致 → judge 判 DATA_DRIFT（漂移注记，非引擎失败）。
agent 行数据从最终 sql 事件 result_ref 落盘文件读回（GW_RESULTS_ROOT/<sessionId>/results/
<ref>.json）做全对照；文件缺失 → 降级行数对照并注记（T1 移交项 1/3）。
number 抽查按度量列（键列=非数值列优先，fresh_compare 显式传 key_cols，T1 移交项 2）。
"""
from __future__ import annotations

import argparse
import glob
import hashlib
import http.client
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

from eval.judge import fresh_compare, judge_scenario, number_in_text

PROJ_DIR = os.path.dirname(os.path.abspath(__file__))
EVAL_FILE = os.path.join(PROJ_DIR, "eval_dataset.json")
EVAL_RESULTS_DIR = os.path.join(PROJ_DIR, "eval_results")
CACHE_DIR = os.path.join(EVAL_RESULTS_DIR, "cache")

DEFAULT_MODEL = "deepseek-v4-flash"  # D16 定型；env DSH_MODEL 覆盖（进缓存指纹）
SSE_READ_TIMEOUT_S = 60          # 单次 read 阻塞上限（心跳 15s 保活，不会真等满）
SSE_OVERALL_TIMEOUT_S = 15 * 60  # 单场景 SSE 断路（任务书：15 分钟）
FRESH_TIMEOUT_S = 60             # 真值重导 statement_timeout
FRESH_MAX_ROWS = 2001            # fetchmany 累计上限（>2000 行场景按截断对照）
HEALTH_WAIT_S = 30
MAX_WORKERS = 2                  # 网关池 3 内留余量（计划 T2 职责 6）
EVAL_USER = "eval-bot"

# 估算单价（CNY / 1M tokens）——估算口径用于轮间相对比较，env EVAL_PRICE_* 可覆盖
PRICE_DEFAULTS = {"input": 2.0, "output": 8.0, "cache_read": 0.5}

DB = {
    "host": os.environ.get("DWS_HOST", "121.37.200.214"),
    "port": int(os.environ.get("DWS_PORT", "8000")),
    "dbname": os.environ.get("DWS_DBNAME", "DP_DWS"),
    "user": os.environ.get("DWS_USER", "aiuser"),
    "password": os.environ.get("DWS_PASSWORD", ""),
}

STOP_EVENT = threading.Event()   # Ctrl-C 协作停：SSE 循环见位即收流
_PRINT_LOCK = threading.Lock()


def log_line(msg: str) -> None:
    with _PRINT_LOCK:
        print(msg, flush=True)


class GatewayError(RuntimeError):
    pass


# ─────────────────────────────── 纯函数（eval/test_runner.py 单测面）───────────────────────────────

def scenario_key(domain: str, pattern: str, question: str) -> str:
    """场景键 = sha1(domain|pattern|question) 前 12 位（缓存/明细文件名）。"""
    return hashlib.sha1(f"{domain}|{pattern}|{question}".encode("utf-8")).hexdigest()[:12]


def git_code_sha() -> str:
    try:
        r = subprocess.run(["git", "rev-parse", "HEAD"], cwd=PROJ_DIR,
                           capture_output=True, text=True, encoding="utf-8", errors="replace",
                           timeout=15, check=True)
        return r.stdout.strip()
    except Exception:
        return "unknown"


def env_fingerprint(dataset_mtime: float | None = None, code_sha: str | None = None,
                    model: str | None = None) -> dict:
    """缓存指纹：代码版本 + 模型 + dataset mtime（任一变化即缓存失效）。"""
    return {
        "code_sha": code_sha if code_sha is not None else git_code_sha(),
        "model": model or os.environ.get("DSH_MODEL") or DEFAULT_MODEL,
        "dataset_mtime": os.path.getmtime(EVAL_FILE) if dataset_mtime is None else dataset_mtime,
    }


def fingerprint_matches(cached: dict, cur: dict) -> bool:
    return cached == cur


class SseFrameParser:
    """SSE 帧组装：feed_line 逐行喂入，空行派发完整帧；':' 注释行（心跳）忽略。

    事件形状 {"id": int|str|None, "event": str, "data": parsed-json|raw-str}；
    多行 data 以 \\n 拼接后尝试 JSON 解析，失败回落原文。
    """

    def __init__(self) -> None:
        self._event: str | None = None
        self._data: list[str] = []
        self._id = None

    def feed_line(self, line: str) -> dict | None:
        if line == "":
            return self._flush()
        if line.startswith(":"):  # 心跳/注释行（网关 15s 一发 ": ping"）
            return None
        field, _, value = line.partition(":")
        if value.startswith(" "):
            value = value[1:]
        if field == "event":
            self._event = value
        elif field == "data":
            self._data.append(value)
        elif field == "id":
            self._id = int(value) if value.isdigit() else value
        return None

    def _flush(self) -> dict | None:
        if self._event is None and not self._data:
            self._id = None  # 空帧（连续空行/心跳后空行）不派发
            return None
        payload = "\n".join(self._data)
        try:
            data = json.loads(payload) if payload else None
        except ValueError:
            data = payload
        ev = {"id": self._id, "event": self._event or "message", "data": data}
        self._event, self._data, self._id = None, [], None
        return ev


def _iter_lines(chunks) -> "iter[str]":
    """字节块 → 行（处理块边界截断的行；decode 宽容）。"""
    buf = b""
    for chunk in chunks:
        buf += chunk
        while b"\n" in buf:
            raw, buf = buf.split(b"\n", 1)
            yield raw.rstrip(b"\r").decode("utf-8", "replace")
    if buf.strip():
        yield buf.rstrip(b"\r").decode("utf-8", "replace")


def parse_sse_lines(lines) -> list[dict]:
    parser = SseFrameParser()
    out = []
    for line in lines:
        ev = parser.feed_line(line)
        if ev is not None:
            out.append(ev)
    return out


def parse_sse_stream(chunks) -> list[dict]:
    """喂任意切块的字节流 → 事件序列（单测入口）。"""
    return parse_sse_lines(_iter_lines(chunks))


def extract_agent_state(events: list[dict]) -> dict:
    """SSE 事件序列 → judge 输入面：sql_events/answer/done(status,tokens,elapsed)。"""
    sql_events, answer, done, errors = [], "", None, []
    for ev in events:
        etype, payload = ev.get("event"), ev.get("data") or {}
        if not isinstance(payload, dict):
            payload = {}
        if etype == "sql":
            sql_events.append({
                "sql": payload.get("sql") or "",
                "rows": payload.get("rows"),
                "truncated": payload.get("truncated"),
                "result_ref": payload.get("result_ref"),
                "elapsed_ms": payload.get("elapsed_ms"),
            })
        elif etype == "answer":
            answer = payload.get("markdown") or answer  # 取最后一条 answer
        elif etype == "done":
            done = payload
        elif etype == "error":
            errors.append({"code": payload.get("code"), "message": payload.get("message")})
    return {
        "sql_events": sql_events,
        "answer": answer,
        "done_status": (done or {}).get("status"),
        "elapsed_ms": (done or {}).get("elapsed_ms"),
        "tokens": (done or {}).get("tokens"),
        "error_events": errors,
        "event_count": len(events),
    }


def _numlike(v) -> float | None:
    """数值化（与 judge._num 同语义：int/float/去千分位字符串；bool/None/其他 → None）。"""
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        try:
            return float(v.strip().replace(",", ""))
        except ValueError:
            return None
    return None


def pick_key_cols(rows: list[dict], max_n: int = 3) -> list[str]:
    """T1 移交项 2：键列 = 非数值列优先；无非数值列时回落前 N 个列名。"""
    cols: list[str] = []
    for r in rows[:50]:
        for c in r:
            if c not in cols:
                cols.append(c)
    if not cols:
        return []
    non_numeric = [c for c in cols if any(_numlike(r.get(c)) is None for r in rows[:50])]
    return non_numeric or cols[:max_n]


def pick_measure_col(rows: list[dict], key_cols: list[str]) -> str | None:
    """度量列 = 非键列中数值幅度最大者（金额/数量 ≫ 年份等数值型维度）。"""
    cols: list[str] = []
    for r in rows[:50]:
        for c in r:
            if c not in cols:
                cols.append(c)
    scored = []
    for c in cols:
        if c in key_cols:
            continue
        nums = [abs(_numlike(r.get(c))) for r in rows[:50]]
        nums = [v for v in nums if v is not None]
        if nums:
            scored.append((max(nums), c))
    if not scored:
        return None
    scored.sort(key=lambda t: (-t[0], t[1]))
    return scored[0][1]


def measure_spot_check(rows: list[dict], answer: str, key_cols: list[str]) -> dict | None:
    """answer 数值抽查按度量列（注记级，不 FAIL）。"""
    if not rows or not answer:
        return None
    col = pick_measure_col(rows, key_cols)
    if col is None:
        return None
    val = _numlike(rows[0].get(col))
    if val is None:
        return None
    return {"col": col, "value": val, "found": number_in_text(val, answer)}


def aggregate_results(details: list[dict]) -> dict:
    """summary 聚合：总/按域通过率（SKIP 不入分母）、失败分类分布、DATA_DRIFT 清单、tokens。"""
    def rate(p: int, n: int):
        return round(p / n, 4) if n else None

    verdicts_order = ["PASS", "FAIL", "SKIP", "DATA_DRIFT"]
    vcount = {v: 0 for v in verdicts_order}
    for d in details:
        v = d.get("verdict")
        vcount[v] = vcount.get(v, 0) + 1
    n = len(details)
    n_pass, n_skip = vcount["PASS"], vcount["SKIP"]

    by_domain: dict[str, dict] = {}
    for d in details:
        dom = by_domain.setdefault(d["domain"], {
            "total": 0, "PASS": 0, "FAIL": 0, "SKIP": 0, "DATA_DRIFT": 0})
        dom["total"] += 1
        dom[d.get("verdict")] = dom.get(d.get("verdict"), 0) + 1
    for dom in by_domain.values():
        dom["pass_rate_all"] = rate(dom["PASS"], dom["total"])
        dom["pass_rate_judged"] = rate(dom["PASS"], dom["total"] - dom["SKIP"])

    failure_classes: dict[str, int] = {}
    for d in details:
        if d.get("verdict") == "FAIL" and d.get("failure_class"):
            failure_classes[d["failure_class"]] = failure_classes.get(d["failure_class"], 0) + 1

    tokens = {"input": 0, "output": 0, "cache_read": 0}
    tokens_scenarios = 0
    for d in details:
        t = d.get("tokens")
        if isinstance(t, dict):
            tokens_scenarios += 1
            for k in tokens:
                v = t.get(k) or 0
                if isinstance(v, (int, float)):
                    tokens[k] += int(v)

    return {
        "totals": {
            "total": n, **vcount,
            "pass_rate_all": rate(n_pass, n),
            "pass_rate_judged": rate(n_pass, n - n_skip),
        },
        "by_domain": by_domain,
        "failure_classes": dict(sorted(failure_classes.items(), key=lambda kv: -kv[1])),
        "data_drift": [d["key"] for d in details if d.get("verdict") == "DATA_DRIFT"],
        "tokens": tokens,
        "tokens_scenarios": tokens_scenarios,
    }


def token_prices() -> dict:
    return {k: float(os.environ.get(f"EVAL_PRICE_{k.upper()}", v)) for k, v in PRICE_DEFAULTS.items()}


def estimate_cost(tokens: dict, prices: dict) -> float:
    """估算成本（CNY）= Σ tokens[k]/1e6 × price[k]。"""
    return sum(tokens.get(k, 0) / 1e6 * prices.get(k, 0.0) for k in ("input", "output", "cache_read"))


def render_report(round_name: str, summary: dict, details: list[dict],
                  cost: dict | None, gateway_desc: str) -> str:
    """report.md：总览表 / 按域表 / 失败分类 / 失败明细 TOP / 成本表 / 口径注记。"""
    t = summary["totals"]
    env = summary.get("env") or {}
    L = []
    L.append(f"# Agent Eval · {round_name}")
    L.append("")
    if env:
        L.append(f"- 网关：{gateway_desc}　|　环境指纹：code_sha=`{str(env.get('code_sha'))[:10]}`"
                 f"　model={env.get('model')}")
    L.append(f"- 场景：{t['total']}（缓存复跑 {sum(1 for d in details if d.get('cached'))}"
             f" / 实跑 {sum(1 for d in details if not d.get('cached'))}）"
             f"　|　汇总时间：{summary.get('finished_at', '-')}")
    L.append("")
    L.append("## 总览")
    L.append("")
    L.append("| 指标 | 值 |")
    L.append("|---|---|")
    L.append(f"| PASS | {t['PASS']} |")
    L.append(f"| FAIL | {t['FAIL']} |")
    L.append(f"| SKIP（真值重导失败） | {t['SKIP']} |")
    L.append(f"| DATA_DRIFT（dataset 漂移注记，非引擎失败） | {t['DATA_DRIFT']} |")
    L.append(f"| 通过率（全部） | {t['pass_rate_all']} |")
    L.append(f"| 通过率（剔除 SKIP） | {t['pass_rate_judged']} |")
    if cost:
        L.append(f"| 估算成本 | ¥{cost['cny']:.4f}（单价 CNY/1M tokens: {cost['prices']}，估算口径） |")
    L.append("")
    L.append("## 按域")
    L.append("")
    L.append("| 域 | 总数 | PASS | FAIL | SKIP | DRIFT | 通过率(剔SKIP) |")
    L.append("|---|---|---|---|---|---|---|")
    for dom in sorted(summary["by_domain"]):
        d = summary["by_domain"][dom]
        L.append(f"| {dom} | {d['total']} | {d['PASS']} | {d['FAIL']} | {d['SKIP']} "
                 f"| {d['DATA_DRIFT']} | {d['pass_rate_judged']} |")
    L.append("")
    L.append("## 失败分类分布")
    L.append("")
    if summary["failure_classes"]:
        L.append("| 失败类 | 数量 |")
        L.append("|---|---|")
        for cls, n in summary["failure_classes"].items():
            L.append(f"| {cls} | {n} |")
    else:
        L.append("无 FAIL。")
    L.append("")
    L.append("> 口径注记：失败分类词表中的「日期格式错」为**注记类**——judge 对同日不同格式"
             "只落 notes，failure_class 不会取该值（T1 定型）。")
    L.append("> DATA_DRIFT = dataset.data 与期望 SQL fresh 重导不一致（数据漂移），对照以 fresh 为准，不算引擎失败；"
             "SKIP = 真值重导失败（DWS 错误），保留引擎失败信号但不判数据。")
    L.append("")
    fails = [d for d in details if d.get("verdict") == "FAIL"]
    if fails:
        L.append("## 失败明细 TOP（≤20，全量见 summary.json / results/）")
        L.append("")
        L.append("| 场景键 | 域 | 问题 | 失败类 | 首条注记 |")
        L.append("|---|---|---|---|---|")
        order = summary["failure_classes"]
        for d in sorted(fails, key=lambda x: (-order.get(x.get("failure_class"), 0), x["domain"], x["key"]))[:20]:
            note = (d.get("notes") or [""])[0].replace("|", "\\|").replace("\n", " ")
            q = d["question"].replace("|", "\\|")
            L.append(f"| `{d['key']}` | {d['domain']} | {q[:40]} | {d.get('failure_class')} | {note[:80]} |")
        L.append("")
    if summary["data_drift"]:
        L.append(f"## DATA_DRIFT 清单（{len(summary['data_drift'])}）")
        L.append("")
        for k in summary["data_drift"]:
            d = next((x for x in details if x["key"] == k), None)
            L.append(f"- `{k}` {d['domain'] if d else ''} {(d['question'][:40] if d else '')}")
        L.append("")
    tk = summary["tokens"]
    L.append("## 成本（tokens 累计与估算）")
    L.append("")
    L.append(f"- tokens：input={tk['input']:,}　output={tk['output']:,}　cache_read={tk['cache_read']:,}"
             f"（来自 done.tokens，{summary['tokens_scenarios']}/{t['total']} 场景有上报，null 计 0）")
    if cost:
        L.append(f"- 估算：¥{cost['cny']:.4f}（单价 CNY/1M tokens：input={cost['prices'].get('input')} "
                 f"output={cost['prices'].get('output')} cache_read={cost['prices'].get('cache_read')}，"
                 "env EVAL_PRICE_* 可覆盖；用于轮间相对比较）")
    by_dom_tokens: dict[str, dict] = {}
    for d in details:
        acc = by_dom_tokens.setdefault(d["domain"], {"input": 0, "output": 0, "cache_read": 0})
        for k in acc:
            v = (d.get("tokens") or {}).get(k) or 0
            if isinstance(v, (int, float)):
                acc[k] += int(v)
    if by_dom_tokens:
        L.append("")
        L.append("| 域 | input | output | cache_read | 估算¥ |")
        L.append("|---|---|---|---|---|")
        prices = cost["prices"] if cost else {}
        for dom in sorted(by_dom_tokens):
            a = by_dom_tokens[dom]
            c = estimate_cost(a, prices) if prices else 0.0
            L.append(f"| {dom} | {a['input']:,} | {a['output']:,} | {a['cache_read']:,} | {c:.4f} |")
    L.append("")
    return "\n".join(L) + "\n"


# ─────────────────────────────── 网关客户端 / 子进程 ───────────────────────────────

class GatewayClient:
    """同步 HTTP/SSE 客户端（http.client；身份信任链 = Bearer + X-User，spec §6.3）。"""

    def __init__(self, host: str, port: int, token: str, user: str = EVAL_USER):
        self.host, self.port, self.token, self.user = host, port, token, user

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.token}", "X-User": self.user}

    def submit(self, question: str, session_id: str, client_submission_id: str,
               timeout_s: int = 30) -> dict:
        conn = http.client.HTTPConnection(self.host, self.port, timeout=timeout_s)
        try:
            body = json.dumps({"question": question, "session_id": session_id,
                               "client_submission_id": client_submission_id})
            conn.request("POST", "/api/tasks", body,
                         {"Content-Type": "application/json", **self._headers()})
            resp = conn.getresponse()
            data = resp.read()
            if resp.status != 201:
                raise GatewayError(f"POST /api/tasks → {resp.status}: {data[:200]!r}")
            return json.loads(data)
        finally:
            conn.close()

    def get_task(self, run_id: str, timeout_s: int = 15) -> dict:
        conn = http.client.HTTPConnection(self.host, self.port, timeout=timeout_s)
        try:
            conn.request("GET", f"/api/tasks/{run_id}", headers=self._headers())
            resp = conn.getresponse()
            data = resp.read()
            if resp.status != 200:
                raise GatewayError(f"GET /api/tasks/{run_id} → {resp.status}: {data[:200]!r}")
            return json.loads(data)
        finally:
            conn.close()

    def stream_events(self, run_id: str,
                      overall_timeout_s: int = SSE_OVERALL_TIMEOUT_S) -> tuple[list[dict], dict]:
        """SSE 流式读至 done / 服务端关流 / 断路；心跳行由解析器忽略。

        返回 (events, info)；info 含 done_seen / timed_out / interrupted。
        """
        conn = http.client.HTTPConnection(self.host, self.port, timeout=SSE_READ_TIMEOUT_S)
        events: list[dict] = []
        info = {"done_seen": False, "timed_out": False, "interrupted": False}
        try:
            conn.request("GET", f"/api/tasks/{run_id}/events",
                         headers={**self._headers(), "Accept": "text/event-stream"})
            resp = conn.getresponse()
            if resp.status != 200:
                raise GatewayError(f"GET events → {resp.status}: {resp.read()[:200]!r}")
            parser = SseFrameParser()
            deadline = time.monotonic() + overall_timeout_s
            while True:
                if STOP_EVENT.is_set():
                    info["interrupted"] = True
                    break
                if time.monotonic() > deadline:
                    info["timed_out"] = True
                    break
                try:
                    chunk = resp.readline()
                except (TimeoutError, socket.timeout):
                    continue  # 单读超时：整体断路由 deadline 把关
                except OSError:
                    break     # 连接断开：以已收事件 + 任务状态兜底
                if not chunk:
                    break     # 服务端关流（done 后/reaper 终态）
                ev = parser.feed_line(chunk.decode("utf-8", "replace").rstrip("\r\n"))
                if ev is not None:
                    events.append(ev)
                    if ev["event"] == "done":
                        info["done_seen"] = True
                        break
        finally:
            conn.close()
        return events, info


def check_live_env() -> None:
    """环境门（fail-fast，同 soak.mjs requireLiveEnv 口径；密钥值绝不打印）。

    缺 DWS_RUN_PASSWORD 时从 DWS_PASSWORD 派生（L4 回退账号集成位，同 soak/T9 手法）。
    """
    import shutil
    missing = []
    if not os.environ.get("DWS_PASSWORD"):
        missing.append("DWS_PASSWORD")
    if not os.environ.get("DEEPSEEK_API_KEY"):
        missing.append("DEEPSEEK_API_KEY")
    dsh = shutil.which("dsh") or shutil.which("dsh.cmd")
    if not dsh:
        missing.append("dsh CLI")
    if dsh and not missing:
        r = subprocess.run([dsh, "--profile", "sdk", "--dump-config"], capture_output=True,
                           text=True, encoding="utf-8", errors="replace",
                           timeout=60, shell=(os.name == "nt"))
        if r.returncode != 0 or "m0-exec-script" not in (r.stdout or "") or "mcp-dws" not in (r.stdout or ""):
            missing.append("dsh sdk profile 自检失败（先跑: node engine-gateway/scripts/setup-dsh-profile.mjs --profile sdk）")
    if not os.environ.get("DWS_RUN_PASSWORD") and os.environ.get("DWS_PASSWORD"):
        os.environ["DWS_RUN_PASSWORD"] = os.environ["DWS_PASSWORD"]
    if missing:
        raise SystemExit(f"BLOCKED: live 环境缺失: {', '.join(missing)}")


def free_tcp_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def wait_gateway_healthy(client: GatewayClient, proc: subprocess.Popen | None,
                         log_path: str, timeout_s: int = HEALTH_WAIT_S) -> None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if proc is not None and proc.poll() is not None:
            raise GatewayError(f"gateway 提前退出 code={proc.returncode}（log: {log_path}）")
        try:
            conn = http.client.HTTPConnection(client.host, client.port, timeout=2)
            conn.request("GET", "/api/health")
            ok = conn.getresponse().status == 200
            conn.close()
            if ok:
                return
        except OSError:
            pass
        time.sleep(0.3)
    raise GatewayError(f"gateway {timeout_s}s 未健康（log: {log_path}）")


def start_gateway(gw_dir: str) -> tuple[subprocess.Popen, GatewayClient, str]:
    """subprocess 起网关（env 同 soak.mjs；GW_* 指向 gw_dir 独立工作树）。返回 (proc, client, results_root)。"""
    node = None
    try:
        import shutil
        node = shutil.which("node")
    except Exception:
        pass
    if not node:
        raise GatewayError("未找到 node——subprocess 起网关需要 node（或改用 GATEWAY_URL 直连）")
    port = free_tcp_port()
    token = f"eval-token-{uuid.uuid4().hex[:8]}"
    results_root = os.path.join(gw_dir, "results")
    env = {
        **os.environ,
        "GATEWAY_PORT": str(port),
        "AUTH_TOKEN": token,
        "GW_WORKROOT": os.path.join(gw_dir, "sessions"),
        "GW_RESULTS_ROOT": results_root,
        "GW_ASSETS_DIR": os.path.join(PROJ_DIR, "skills", "report-generator"),
        "M0_SANDBOX_RUNNER": os.path.join(PROJ_DIR, "m0", "sandbox", "run_in_sandbox.sh"),
        "SKILLS_DIR": os.path.join(PROJ_DIR, "skills"),
        "GATEWAY_REPORTS_DIR": os.path.join(gw_dir, "reports"),
        "GW_DB_PATH": os.path.join(gw_dir, "gateway.db"),
        "MAX_CONCURRENT_TASKS": os.environ.get("EVAL_MAX_CONCURRENT_TASKS", "3"),
        "TASK_BUDGET_S": os.environ.get("EVAL_TASK_BUDGET_S", "1800"),
        "MAX_REPAIR_ROUNDS": "3",
    }
    for sub in ("sessions", "results", "reports"):
        os.makedirs(os.path.join(gw_dir, sub), exist_ok=True)
    log_path = os.path.join(gw_dir, "gateway.log")
    log_fd = open(log_path, "ab")
    proc = subprocess.Popen([node, os.path.join("src", "server", "index.ts")],
                            cwd=os.path.join(PROJ_DIR, "engine-gateway"),
                            env=env, stdout=log_fd, stderr=subprocess.STDOUT)
    client = GatewayClient("127.0.0.1", port, token)
    try:
        wait_gateway_healthy(client, proc, log_path)
    except Exception:
        stop_gateway(proc)
        log_fd.close()
        raise
    return proc, client, results_root


def stop_gateway(proc: subprocess.Popen | None) -> bool:
    """杀网关进程树（Windows taskkill /T /F；结束时由 main 调用并核对退出）。返回是否需要杀。"""
    if proc is None or proc.poll() is not None:
        return False
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/pid", str(proc.pid), "/T", "/F"],
                           capture_output=True, timeout=30)
        else:
            proc.terminate()
    except Exception:
        pass
    try:
        proc.wait(timeout=15)
    except Exception:
        pass
    return True


# ─────────────────────────────── 真值重导 / result_ref 读回 ───────────────────────────────

def _jsonable(v):
    """psycopg2 返回值 → JSON 友好（Decimal→float，date/datetime→isoformat；判分器数值面兼容）。"""
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    try:
        from decimal import Decimal
        if isinstance(v, Decimal):
            return float(v)
    except ImportError:
        pass
    iso = getattr(v, "isoformat", None)
    if callable(iso):
        return iso()
    return str(v)


def fresh_query(sql: str, db: dict | None = None, timeout_s: int = FRESH_TIMEOUT_S,
                max_rows: int = FRESH_MAX_ROWS) -> tuple[list[dict] | None, str | None]:
    """期望 SQL fresh 重导 DWS → (rows, None) | (None, err)。statement_timeout=60s，fetchmany 上限 2001。"""
    import psycopg2
    cfg = db or DB
    if not cfg.get("password"):
        return None, "DWS_PASSWORD 未设——无法重导真值"
    conn = None
    try:
        conn = psycopg2.connect(host=cfg["host"], port=cfg["port"], dbname=cfg["dbname"],
                                user=cfg["user"], password=cfg["password"], connect_timeout=15)
        cur = conn.cursor()
        cur.execute(f"SET statement_timeout = '{timeout_s * 1000}'")
        cur.execute(sql)
        cols = [d[0] for d in cur.description] if cur.description else []
        rows: list[tuple] = []
        while len(rows) <= max_rows:
            batch = cur.fetchmany(256)
            if not batch:
                break
            rows.extend(batch)
        rows = rows[:max_rows]
        return [dict(zip(cols, (_jsonable(v) for v in r))) for r in rows], None
    except Exception as e:
        return None, f"{type(e).__name__}: {e}"
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


def read_result_ref_data(results_root: str | None, session_id: str, ref: str) -> tuple[list | None, str | None]:
    """result_ref → 行数据（路径 = GW_RESULTS_ROOT/<sessionId>/results/<ref>.json）。"""
    if not results_root:
        return None, "GW_RESULTS_ROOT 未设（直连模式），无法读回 result_ref"
    path = os.path.join(results_root, session_id, "results", f"{ref}.json")
    if not os.path.exists(path):
        return None, f"result_ref 文件缺失: {os.path.basename(path)}"
    try:
        with open(path, "r", encoding="utf-8") as f:
            payload = json.load(f)
        data = payload.get("data")
        return (data if isinstance(data, list) else None), None
    except Exception as e:
        return None, f"result_ref 文件读取失败: {e}"


# ─────────────────────────────── 缓存（断点续跑）───────────────────────────────

def cache_path(key: str) -> str:
    return os.path.join(CACHE_DIR, f"{key}.json")


def load_cache(key: str) -> dict | None:
    try:
        with open(cache_path(key), "r", encoding="utf-8") as f:
            payload = json.load(f)
        return payload if isinstance(payload, dict) and "fingerprint" in payload and "detail" in payload else None
    except (OSError, ValueError):
        return None


def write_json_atomic(path: str, obj) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def save_cache(key: str, fingerprint: dict, detail: dict) -> None:
    write_json_atomic(cache_path(key), {"fingerprint": fingerprint, "detail": detail})


def latest_round_summary() -> str | None:
    """最近一跑的 round-*/summary.json（按 mtime）。"""
    best = None
    for p in glob.glob(os.path.join(EVAL_RESULTS_DIR, "round-*", "summary.json")):
        m = os.path.getmtime(p)
        if best is None or m > best[0]:
            best = (m, p)
    return best[1] if best else None


# ─────────────────────────────── 单场景执行 ───────────────────────────────

def judge_one(q: dict, state: dict, agent_rows: list | None,
              fresh_rows: list | None, fresh_err: str | None) -> dict:
    """组装 judge 输入并判分；附驱动器侧补充（T1 移交项 2：显式 key_cols 全对照 + 度量列抽查）。"""
    expected = {"row_count": q.get("row_count"), "sql": q.get("sql") or "", "data": q.get("data")}
    if q.get("expected_refusal"):
        expected["expected_refusal"] = True
    if q.get("elapsed_budget_ms") is not None:
        expected["elapsed_budget_ms"] = q["elapsed_budget_ms"]
    agent = {"sql_events": state["sql_events"], "answer": state["answer"],
             "done_status": state["done_status"], "elapsed_ms": state["elapsed_ms"]}
    verdict = judge_scenario(expected=expected, agent=agent,
                             fresh_rows=fresh_rows, fresh_err=fresh_err)
    if q.get("expected_refusal"):
        return verdict  # 红队场景：judge 短路于拒答分支，无需真值补充
    truth = fresh_rows if fresh_rows is not None else expected["data"]
    if isinstance(truth, list) and truth:
        key_cols = pick_key_cols(truth)
        verdict["checks"]["key_cols"] = key_cols
        if agent_rows is not None:
            verdict["checks"]["full_compare_key_cols"] = fresh_compare(agent_rows, truth, key_cols=key_cols)
        mc = measure_spot_check(truth, state["answer"], key_cols)
        if mc is not None:
            verdict["checks"]["measure_in_answer"] = mc["found"]
            if mc["found"] and verdict["checks"].get("number_in_answer") is False:
                verdict["notes"].append(
                    f"维度列误报修正: 度量列 {mc['col']}={mc['value']} 命中 answer（number 抽查按度量列）")
    return verdict


def run_scenario(q: dict, idx: int, run_ts: str, client: GatewayClient,
                 results_root: str | None, db: dict) -> dict:
    """单场景全链路：提交 → SSE 收流 → result_ref 读回 → 真值重导 → 判分。"""
    key = scenario_key(q["domain"], q["pattern"], q["question"])
    detail = {"key": key, "idx": idx, "domain": q["domain"], "pattern": q["pattern"],
              "question": q["question"], "session_id": f"eval-{q['domain']}-{idx}-{run_ts}",
              "run_id": None, "driver_error": None, "stream": None}
    t0 = time.monotonic()
    state: dict = {"sql_events": [], "answer": "", "done_status": None,
                   "elapsed_ms": None, "tokens": None}
    agent_rows = None
    fresh_rows, fresh_err = None, None
    ref_note = None
    try:
        sub = client.submit(q["question"], detail["session_id"], key)
        run_id = sub.get("run_id")
        detail["run_id"] = run_id
        detail["session_id"] = sub.get("session_id") or detail["session_id"]
        events, info = client.stream_events(run_id)
        state = extract_agent_state(events)
        detail["stream"] = info
        if not info["done_seen"]:
            # 流关闭/断路而无 done（reaper 终态或中断）：任务 API 兜底
            task = client.get_task(run_id)
            state["done_status"] = task.get("status")
        # T1 移交项 1：agent 行数据从最终 sql 事件 result_ref 落盘文件读回（judge 全对照面）
        if state["sql_events"]:
            last = state["sql_events"][-1]
            ref = last.get("result_ref")
            if ref:
                agent_rows, err = read_result_ref_data(results_root, detail["session_id"], ref)
                if err:
                    ref_note = f"{err}——降级行数对照"
                elif agent_rows is not None:
                    last["data"] = agent_rows
            else:
                ref_note = "最终 sql 事件无 result_ref——降级行数对照"
        else:
            ref_note = None
        # 真值重导（拒答场景跳过——judge 红队分支不用真值）
        if not q.get("expected_refusal"):
            fresh_rows, fresh_err = fresh_query(q["sql"], db)
        verdict = judge_one(q, state, agent_rows, fresh_rows, fresh_err)
        if ref_note:
            verdict["notes"].append(ref_note)
        if info.get("timed_out"):
            verdict["notes"].append(f"SSE 断路 {SSE_OVERALL_TIMEOUT_S}s（流未自然结束）")
    except Exception as e:
        detail["driver_error"] = f"{type(e).__name__}: {e}"
        verdict = {"verdict": "FAIL", "failure_class": "执行错",
                   "notes": [f"驱动器异常: {detail['driver_error']}"], "checks": {}}
    wall_ms = round((time.monotonic() - t0) * 1000)
    if STOP_EVENT.is_set() and detail["driver_error"] is None:
        detail["driver_error"] = "interrupted"
        verdict = {"verdict": "SKIP", "failure_class": None,
                   "notes": ["运行中断（Ctrl-C），本场景未完成判分"], "checks": {}}
    detail.update({
        "verdict": verdict["verdict"],
        "failure_class": verdict.get("failure_class"),
        "notes": verdict.get("notes") or [],
        "checks": verdict.get("checks") or {},
        "wall_ms": wall_ms,
        "done_status": state.get("done_status"),
        "engine_elapsed_ms": state.get("elapsed_ms"),
        "tokens": state.get("tokens"),
        "sql_events": [{k: e.get(k) for k in ("sql", "rows", "truncated", "result_ref")}
                       for e in state.get("sql_events") or []],
        "answer_head": (state.get("answer") or "")[:800],
        "agent_rows_count": len(agent_rows) if agent_rows is not None else None,
        "fresh_err": fresh_err,
        "fresh_rows_count": len(fresh_rows) if fresh_rows is not None else None,
        "cached": False,
    })
    return detail


# ─────────────────────────────── 主流程 ───────────────────────────────

def parse_args(argv=None):
    ap = argparse.ArgumentParser(description="Agent eval live 驱动器（判分器接真网关；EVAL_LIVE=1 门禁）")
    ap.add_argument("domain", nargs="?", default=None, help="域过滤（如 inventory/ar/fin-cost）")
    ap.add_argument("--limit", type=int, default=None, help="最多跑 N 个场景（过滤后截断）")
    ap.add_argument("--only-failed", action="store_true", help="读上一轮 summary 复跑非 PASS（绕缓存）")
    ap.add_argument("--fresh", action="store_true", help="无视缓存全重跑")
    ap.add_argument("--round-tag", default=None, help="结果目录名 round-<tag>（缺省 round-<ts>）")
    return ap.parse_args(argv)


def select_questions(args) -> tuple[list[tuple[int, dict]], dict]:
    with open(EVAL_FILE, "r", encoding="utf-8") as f:
        dataset = json.load(f)
    questions = dataset["questions"]
    domains = sorted({q["domain"] for q in questions})
    if args.domain and args.domain not in domains:
        raise SystemExit(f"未知域 {args.domain!r}；可选: {', '.join(domains)}")
    selected = [(i, q) for i, q in enumerate(questions)
                if not args.domain or q["domain"] == args.domain]
    meta = {"available_domains": domains}
    if args.only_failed:
        src = latest_round_summary()
        if not src:
            raise SystemExit("--only-failed：eval_results/round-*/summary.json 不存在——先跑一轮")
        with open(src, "r", encoding="utf-8") as f:
            prev = json.load(f)
        failed = {s["key"] for s in prev.get("scenarios", []) if s.get("verdict") != "PASS"}
        selected = [(i, q) for i, q in selected
                    if scenario_key(q["domain"], q["pattern"], q["question"]) in failed]
        meta["only_failed_source"] = src
        meta["only_failed_count"] = len(failed)
    if args.limit is not None and args.limit >= 0:
        selected = selected[:args.limit]
    return selected, meta


def main(argv=None) -> int:
    args = parse_args(argv)
    if os.environ.get("EVAL_LIVE") != "1":
        print("门禁：本驱动器跑真网关（真 dsh + 真 DeepSeek + 真 DWS，烧 API）。"
              "确认后以 EVAL_LIVE=1 运行，如：\n"
              "  EVAL_LIVE=1 python run_agent_eval.py inventory --limit 1 --round-tag smoke")
        return 1

    started = datetime.now().astimezone()
    run_ts = started.strftime("%Y%m%d%H%M%S")
    round_name = args.round_tag or run_ts
    round_dir = os.path.join(EVAL_RESULTS_DIR, f"round-{round_name}")
    os.makedirs(os.path.join(round_dir, "results"), exist_ok=True)

    selected, sel_meta = select_questions(args)
    if not selected:
        print("无待跑场景（过滤结果为空）。")
        return 0
    fingerprint = env_fingerprint()
    log_line(f"[eval] round-{round_name} 场景 {len(selected)} 个"
             f"（{'域=' + args.domain + ' ' if args.domain else ''}"
             f"limit={args.limit} only-failed={args.only_failed} fresh={args.fresh}）")
    if sel_meta.get("only_failed_source"):
        log_line(f"[eval] only-failed 来源: {sel_meta['only_failed_source']}"
                 f"（上轮非 PASS 共 {sel_meta['only_failed_count']}）")

    # ── 缓存筛选（指纹一致且非 --fresh/--only-failed 才跳过）──
    results: list[dict] = []
    pending: list[tuple[int, dict]] = []
    for idx, q in selected:
        key = scenario_key(q["domain"], q["pattern"], q["question"])
        if not args.fresh and not args.only_failed:
            cached = load_cache(key)
            if cached and fingerprint_matches(cached["fingerprint"], fingerprint):
                d = cached["detail"]
                d["cached"] = True
                results.append(d)
                continue
        pending.append((idx, q))
    log_line(f"[eval] 缓存命中 {len(results)}，待跑 {len(pending)}")

    # ── 网关两态（有待跑场景才起）──
    proc = None
    client: GatewayClient | None = None
    results_root = os.environ.get("GW_RESULTS_ROOT") if os.environ.get("GATEWAY_URL") else None
    if pending:
        check_live_env()
        if os.environ.get("GATEWAY_URL"):
            u = urllib.parse.urlparse(os.environ["GATEWAY_URL"])
            token = os.environ.get("AUTH_TOKEN")
            if not token:
                print("直连模式需要 env AUTH_TOKEN（Bearer）")
                return 1
            client = GatewayClient(u.hostname or "127.0.0.1", u.port or 80, token)
            gateway_desc = f"直连 {os.environ['GATEWAY_URL']}"
            log_line(f"[eval] 直连网关 {os.environ['GATEWAY_URL']}")
        else:
            gw_dir = os.path.join(EVAL_RESULTS_DIR, f"gw-{run_ts}")
            n = 2
            while os.path.exists(gw_dir):  # 同秒重跑防撞
                gw_dir = os.path.join(EVAL_RESULTS_DIR, f"gw-{run_ts}-{n}")
                n += 1
            os.makedirs(gw_dir, exist_ok=True)
            proc, client, results_root = start_gateway(gw_dir)
            gateway_desc = f"subprocess :{client.port}（{gw_dir}）"
            log_line(f"[eval] 网关已起 :{client.port} pid={proc.pid} 工作树={gw_dir}")

    interrupted = False
    try:
        def run_one(item):
            idx, q = item
            d = run_scenario(q, idx, run_ts, client, results_root, DB)
            # 每场景完成即落盘（断点续跑）；驱动器异常/中断不进缓存（防瞬态错误被固化）
            write_json_atomic(os.path.join(round_dir, "results", f"{d['key']}.json"), d)
            if d["driver_error"] is None:
                save_cache(d["key"], fingerprint, d)
            tag = "CACHED" if d["cached"] else d["verdict"]
            cls = f"/{d['failure_class']}" if d.get("failure_class") else ""
            log_line(f"[{idx}] {d['domain']}/{d['pattern']}: {d['question'][:36]} ... "
                     f"{tag}{cls} ({d['wall_ms'] / 1000:.1f}s)"
                     + (f" [驱动器异常: {d['driver_error']}]" if d["driver_error"] else ""))
            return d

        # 红队场景串行（executor 外直接跑）；其余 2 路并发
        serial = [it for it in pending if it[1]["domain"] == "redteam"]
        parallel = [it for it in pending if it[1]["domain"] != "redteam"]
        try:
            for it in serial:
                if STOP_EVENT.is_set():
                    break
                results.append(run_one(it))
            if parallel:
                ex = ThreadPoolExecutor(max_workers=MAX_WORKERS)
                futs = [ex.submit(run_one, it) for it in parallel]
                try:
                    for f in as_completed(futs):
                        results.append(f.result())
                except KeyboardInterrupt:
                    STOP_EVENT.set()
                    for f in futs:
                        f.cancel()
                    raise
                finally:
                    ex.shutdown(wait=False, cancel_futures=True)
        except KeyboardInterrupt:
            interrupted = True
            log_line("\n[eval] 中断——已完成场景已落缓存，重跑自动续（在途请求 ≤60s 收尾）")
    finally:
        if proc is not None:
            stopped = stop_gateway(proc)
            log_line(f"[eval] 网关子进程已{'停止' if stopped else '自行退出'}"
                     f"（exit={proc.poll()}，工作树留存 {gw_dir}）")

    # ── 汇总输出 ──
    results.sort(key=lambda d: d["idx"])
    summary = aggregate_results(results)
    finished = datetime.now().astimezone()
    prices = token_prices()
    cost = {"cny": estimate_cost(summary["tokens"], prices), "prices": prices}
    summary_payload = {
        "round": round_name,
        "started_at": started.isoformat(timespec="seconds"),
        "finished_at": finished.isoformat(timespec="seconds"),
        "interrupted": interrupted,
        "env": {**fingerprint, "gateway": gateway_desc if pending else "n/a（全部缓存命中）",
                "task_budget_s": os.environ.get("EVAL_TASK_BUDGET_S", "1800")},
        "selection": sel_meta,
        **summary,
        "cost": cost,
        "scenarios": [{k: d.get(k) for k in ("key", "idx", "domain", "pattern", "question",
                                             "verdict", "failure_class", "wall_ms",
                                             "engine_elapsed_ms", "tokens", "cached",
                                             "session_id", "run_id", "driver_error")}
                      for d in results],
    }
    summary_path = os.path.join(round_dir, "summary.json")
    write_json_atomic(summary_path, summary_payload)
    report = render_report(round_name, summary_payload, results, cost, gateway_desc if pending else "n/a")
    report_path = os.path.join(round_dir, "report.md")
    with open(report_path, "w", encoding="utf-8") as f:
        f.write(report)

    t = summary["totals"]
    log_line(f"\n[eval] 完成{'（中断，部分结果）' if interrupted else ''}: "
             f"PASS {t['PASS']} / FAIL {t['FAIL']} / SKIP {t['SKIP']} / DRIFT {t['DATA_DRIFT']}"
             f"（共 {t['total']}，通过率剔 SKIP {t['pass_rate_judged']}）")
    log_line(f"[eval] summary → {summary_path}")
    log_line(f"[eval] report  → {report_path}")
    return 130 if interrupted else 0


if __name__ == "__main__":
    sys.exit(main())
