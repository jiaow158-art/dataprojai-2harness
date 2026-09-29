"""insight-api：只读 HTTP（spec §11.1 / 裁定 D6——BFF 不直读 db，只走本 API）。

stdlib http.server（环境无 fastapi/flask，零新依赖；spec §4 技术描述在此勘误）。
只读连接：sqlite file:...?mode=ro（WAL 跨进程读）。绑定 127.0.0.1，BFF 是唯一客户端。"""
import json
import re
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

_EVENT_ID_RE = re.compile(r"^/api/insight/events/([A-Za-z0-9\-]+)$")

def _rows(db, sql, args=()):
    return [dict(r) for r in db.execute(sql, args).fetchall()]

def _daily_payload(db, brief_date: str) -> dict:
    brief = db.execute("SELECT * FROM daily_brief WHERE brief_date=?",
                       (brief_date,)).fetchone()
    freshness = json.loads(brief["freshness_json"])["radars"] if brief else []
    evs = []
    for s in _rows(db, "SELECT * FROM daily_brief_event WHERE brief_date=?"
                       " ORDER BY rank", (brief_date,)):
        evs.append({"eventId": s["event_id"], "eventKey": None, "lifecycle":
                    s["lifecycle_snapshot"], "persistDays": s["persist_days_snapshot"],
                    "title": s["title_snapshot"], "summary": s["summary_snapshot"],
                    "severity": s["severity_snapshot"],
                    "eventType": s["event_type_snapshot"], "metric": None,
                    "scope": {"范围": "瓷砖事业部"}, "period": {"类型": "月"},
                    "facts": json.loads(s["facts_snapshot"]),
                    "score": s["score_snapshot"], "status": "discovered",
                    "createdAt": s["published_at"]})
    return {"briefDate": brief_date, "scope": "瓷砖事业部",
            "dataFreshness": {"overall": "ready" if evs or brief else "not_ready",
                              "radars": freshness},
            "eventCount": brief["event_count"] if brief else 0,
            "stale": False, "events": evs}

def _event_detail(db, event_id: str) -> dict | None:
    ev = db.execute("SELECT * FROM business_event WHERE event_id=?",
                    (event_id,)).fetchone()
    if not ev:
        return None
    ev = dict(ev)
    latest = db.execute("SELECT * FROM event_analysis_run WHERE event_id=?"
                        " ORDER BY analysis_date DESC, analysis_id DESC LIMIT 1",
                        (event_id,)).fetchone()
    parsed = json.loads(latest["parsed_json"]) if latest and latest["parsed_json"] else None
    evidence = _rows(db, "SELECT finding_id, detector, metrics_json, norm_score, is_late"
                         " FROM detector_finding WHERE data_date=? ORDER BY finding_id",
                     (ev["data_date"],))
    for e in evidence:
        e["metrics"] = json.loads(e.pop("metrics_json"))
    return {"event": {k: ev[k] for k in ("event_id", "event_key", "lifecycle",
                                          "data_date", "first_seen_date", "persist_days",
                                          "detector", "event_type", "title", "summary",
                                          "severity", "scope_json", "facts_json",
                                          "score", "status")},
            "executiveSummary": (parsed or {}).get("summary", ev["summary"]),
            "facts": json.loads(ev["facts_json"]),
            "attribution": {"status": ev["attribution_status"],
                            "analysisId": latest["analysis_id"] if latest else None,
                            "summary": ev["attribution_summary"],
                            "path": (parsed or {}).get("path", []),
                            "findings": (parsed or {}).get("findings", []),
                            "waterfall": (parsed or {}).get("waterfall", []),
                            "entities": (parsed or {}).get("entities", []),
                            "runId": ev["attribution_run_id"],
                            "reportPath": latest["report_path"] if latest else None},
            "evidence": evidence,
            "suggestedActions": [],            # v1 只生成不执行，M-i3 UI 层呈现
            "followupPrompts": ["为什么？", "看重点影响对象明细", "生成完整分析报告"]}

def make_server(db: sqlite3.Connection, host: str = "127.0.0.1",
                port: int = 58095) -> ThreadingHTTPServer:
    # ThreadingHTTPServer 在工作线程跑 do_GET，而连接通常创建于主线程
    # （sqlite3 默认 check_same_thread=True 拒绝跨线程使用）——按路径重开
    # 一条线程安全的只读连接供服务用（红线上移：API 服务面恒 mode=ro）。
    db_path = db.execute("PRAGMA database_list").fetchone()[2]
    ro = sqlite3.connect(f"file:{Path(db_path).as_posix()}?mode=ro", uri=True,
                         check_same_thread=False)
    ro.row_factory = sqlite3.Row

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):     # 安静（pm2 管日志）
            pass

        def do_GET(self):
            u = urlparse(self.path)
            q = parse_qs(u.query)
            try:
                if u.path == "/api/insight/daily":
                    date = (q.get("date") or [""])[0]
                    payload = _daily_payload(ro, date) if date else _daily_payload(
                        ro, ro.execute("SELECT MAX(brief_date) b FROM daily_brief"
                                       ).fetchone()["b"] or "1970-01-01")
                    body, code = payload, 200
                elif (m := _EVENT_ID_RE.match(u.path)):
                    detail = _event_detail(ro, m.group(1))
                    body, code = (detail, 200) if detail else ({"error": "NOT_FOUND"}, 404)
                elif u.path == "/api/insight/timeline":
                    days = int((q.get("days") or ["30"])[0])
                    body = [{"eventId": r["event_id"], "title": r["title"],
                             "severity": r["severity"], "dataDate": r["data_date"],
                             "createdAt": r["updated_at"]}
                            for r in _rows(ro, "SELECT * FROM business_event"
                                                 " ORDER BY updated_at DESC LIMIT ?", (days,))]
                    code = 200
                elif u.path == "/api/insight/health":
                    body, code = {"ok": True, "db": "open"}, 200
                else:
                    body, code = {"error": "NOT_FOUND"}, 404
            except Exception as e:
                body, code = {"error": "INTERNAL", "detail": repr(e)[:120]}, 500
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    return ThreadingHTTPServer((host, port), Handler)

def main():
    import os
    path = os.environ["INSIGHT_DB_PATH"]
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)   # 只读（红线）
    db.row_factory = sqlite3.Row
    port = int(os.environ.get("INSIGHT_PORT", "58095"))
    print(f"insight-api listening 127.0.0.1:{port}")
    make_server(db, port=port).serve_forever()

if __name__ == "__main__":
    main()
