"""insight-api：只读 HTTP（spec §11.1 / 裁定 D6——BFF 不直读 db，只走本 API）。

stdlib http.server（环境无 fastapi/flask，零新依赖；spec §4 技术描述在此勘误）。
只读连接：sqlite file:...?mode=ro（WAL 跨进程读）。绑定 127.0.0.1，BFF 是唯一客户端。"""
import json
import re
import sqlite3
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

from .merge_rank import RANKING, event_key_of
from .trend_service import TrendService

_EVENT_ID_RE = re.compile(r"^/api/insight/events/([A-Za-z0-9\-]+)$")
_EVENT_TREND_RE = re.compile(r"^/api/insight/events/([A-Za-z0-9\-]+)/trend$")
_EVENT_RELATED_RE = re.compile(r"^/api/insight/events/([A-Za-z0-9\-]+)/related$")

def _rows(db, sql, args=()):
    return [dict(r) for r in db.execute(sql, args).fetchall()]

def _daily_payload(db, brief_date: str) -> dict:
    brief = db.execute("SELECT * FROM daily_brief WHERE brief_date=?",
                       (brief_date,)).fetchone()
    freshness = json.loads(brief["freshness_json"])["radars"] if brief else []
    if not brief or brief["status"] == "not_ready":
        overall = "not_ready"       # fail-closed：无数据≠ready，绝不冒充（Fix 1）
    elif any(not r.get("ready") for r in freshness):
        overall = "partial"
    else:
        overall = "ready"
    # P0-2 冻结面不含 status/event_key/metric——读 business_event 当前态合规（Fix 4；
    # event_key 是锚点恒定身份、metric 事件内不变，回查即契约值）
    cur_by_id = {r["event_id"]: r for r in
                 _rows(db, "SELECT event_id, status, event_key, metric,"
                       " attribution_summary, attribution_status FROM business_event"
                       " WHERE event_id IN (SELECT event_id FROM daily_brief_event"
                       " WHERE brief_date=?)", (brief_date,))}
    evs = []
    for s in _rows(db, "SELECT * FROM daily_brief_event WHERE brief_date=?"
                       " ORDER BY rank", (brief_date,)):
        cur = cur_by_id.get(s["event_id"], {})
        evs.append({"eventId": s["event_id"], "eventKey": cur.get("event_key"),
                    "lifecycle": s["lifecycle_snapshot"],
                    "persistDays": s["persist_days_snapshot"],
                    "title": s["title_snapshot"], "summary": s["summary_snapshot"],
                    "severity": s["severity_snapshot"],
                    "eventType": s["event_type_snapshot"], "metric": cur.get("metric"),
                    "scope": {"范围": "瓷砖事业部"}, "period": {"类型": "月"},
                    "facts": json.loads(s["facts_snapshot"]),
                    "score": s["score_snapshot"],
                    "status": cur.get("status", "discovered"),
                    "attributionSummary": cur.get("attribution_summary"),
                    "attributionStatus": cur.get("attribution_status", "pending"),
                    "createdAt": s["published_at"]})
    return {"briefDate": brief_date, "scope": "瓷砖事业部",
            "dataDate": (date.fromisoformat(brief_date) - timedelta(days=1)).isoformat()
            if brief else None,
            "dataFreshness": {"overall": overall, "radars": freshness},
            "eventCount": brief["event_count"] if brief else 0,
            "stale": False, "events": evs}

def _event_detail(db, event_id: str) -> dict | None:
    ev = db.execute("SELECT * FROM business_event WHERE event_id=?",
                    (event_id,)).fetchone()
    if not ev:
        return None
    ev = dict(ev)
    latest = db.execute("SELECT * FROM event_analysis_run WHERE event_id=?"
                        " ORDER BY analysis_date DESC, submitted_at DESC,"
                        " analysis_id DESC LIMIT 1",
                        (event_id,)).fetchone()
    parsed = json.loads(latest["parsed_json"]) if latest and latest["parsed_json"] else None
    evidence = []
    for e in _rows(db, "SELECT finding_id, detector, dim_keys_json, metrics_json,"
                       " norm_score, is_late FROM detector_finding"
                       " WHERE data_date=? ORDER BY finding_id", (ev["data_date"],)):
        if event_key_of({"dim_keys": json.loads(e.pop("dim_keys_json"))}) != ev["event_key"]:
            continue                 # 只归属本事件的 findings（同锚多雷达 facet 含内，Fix 2）
        e["metrics"] = json.loads(e.pop("metrics_json"))
        evidence.append(e)
    return {"event": {k: ev[k] for k in ("event_id", "event_key", "lifecycle",
                                          "data_date", "first_seen_date", "persist_days",
                                          "resolved_at",
                                          "detector", "event_type", "title", "summary",
                                          "severity", "scope_json", "facts_json",
                                          "score", "status")},
            "executiveSummary": (parsed or {}).get("summary", ev["summary"]),
            "facts": json.loads(ev["facts_json"]),
            "attribution": {"status": ev["attribution_status"],
                            "analysisId": latest["analysis_id"] if latest else None,
                            "summary": ev["attribution_summary"],
                            "generatedAt": ev["attribution_generated_at"],
                            "path": (parsed or {}).get("path", []),
                            "findings": (parsed or {}).get("findings", []),
                            "waterfall": (parsed or {}).get("waterfall", []),
                            "entities": (parsed or {}).get("entities", []),
                            "runId": ev["attribution_run_id"],
                            "reportPath": latest["report_path"] if latest else None},
            "evidence": evidence,
            "suggestedActions": [],            # v1 只生成不执行，M-i3 UI 层呈现
            "followupPrompts": ["为什么？", "看重点影响对象明细", "生成完整分析报告"]}

def _related(db, event_id: str) -> dict | None:
    """同类型/同组织节点相关事件各至多 5 条（db-only，排除自身，created_at 降序）。
    按桶两条查询（I-1）：不做全表窗口扫描——LIMIT 100 截断会让窗口外的老事件漏配。"""
    ev = db.execute("SELECT event_type,"
                    " json_extract(scope_json,'$.组织节点') AS org"
                    " FROM business_event WHERE event_id=?", (event_id,)).fetchone()
    if not ev:
        return None
    def bucket(where, args):
        return [{"event_id": r["event_id"], "title": r["title"],
                 "severity": r["severity"], "data_date": r["data_date"],
                 "created_at": r["created_at"]}
                for r in db.execute(
                    "SELECT event_id, title, severity, data_date, created_at"
                    " FROM business_event WHERE " + where +
                    " ORDER BY created_at DESC LIMIT 5", args)]
    same_type = bucket("event_type=? AND event_id<>?", (ev["event_type"], event_id))
    same_region = (bucket("json_extract(scope_json,'$.组织节点')=? AND event_id<>?",
                          (ev["org"], event_id)) if ev["org"] else [])
    return {"event_id": event_id, "sameType": same_type, "sameRegion": same_region}

def _active_events(db) -> dict:
    """active 事件全集按 score 降序，附当日发布态与达标缺口（db-only）。
    排序 tie-break（M-1）：score 并列按 updated_at 降序再 event_id（确定性）。"""
    latest = (db.execute("SELECT MAX(brief_date) b FROM daily_brief").fetchone()["b"]) or ""
    pub = {r["event_id"]: r["rank"] for r in
           _rows(db, "SELECT event_id, rank FROM daily_brief_event WHERE brief_date=?",
                 (latest,))}
    out = []
    for r in _rows(db, "SELECT event_id, detector, event_type, title, summary, severity,"
                       " score, persist_days, first_seen_date, lifecycle,"
                       " attribution_status, updated_at FROM business_event"
                       " WHERE lifecycle='active'"
                       " ORDER BY score DESC, updated_at DESC, event_id"):
        out.append({**r, "publishedToday": r["event_id"] in pub,
                    "rankToday": pub.get(r["event_id"]),
                    "scoreGap": round(r["score"] - RANKING["publish_min_score"], 1)})
    return {"briefDate": latest, "publishMinScore": RANKING["publish_min_score"],
            "events": out}

_EVENT_TYPE_LABELS = {"sales_decline": "销售下滑", "margin_drop": "毛利下降",
                      "ar_overdue": "应收风险", "target_gap": "目标缺口"}
_LIFECYCLE_LABELS = {"active": "进行中", "resolved": "已解除"}
_EVENT_CENTER_LIMIT = 500


def _event_center(db, today: date) -> dict:
    """事件中心载荷（spec §3，D-e5 统计口径服务端唯一权威）。
    窗口（D-e6）：近30=[today-29, today]，前30=[today-59, today-30]（含界不重叠）；
    新发卡按 first_seen_date、解除卡按 resolved_at；分母 0 → delta None；
    分布=全量（500 截断时分布基于截断集，v1 量级远达不到，注释即防线）；
    summary/trend 亦基于截断集（>500 时前窗 prevCount 可能被截断，delta 口径失真
    ——v1 量级远达不到，达到时须改为截断前全集计算）。"""
    iso = today.isoformat()
    w_from = (today - timedelta(days=29)).isoformat()
    p_from = (today - timedelta(days=59)).isoformat()
    p_to = (today - timedelta(days=30)).isoformat()
    rows = _rows(db, "SELECT event_id, event_key, detector, event_type, title, summary,"
                     " severity, scope_json, facts_json, score, persist_days,"
                     " first_seen_date, last_seen_date, lifecycle, resolved_at,"
                     " attribution_status, created_at, attribution_generated_at"
                     " FROM business_event"
                     " ORDER BY first_seen_date DESC, event_id")
    truncated = len(rows) > _EVENT_CENTER_LIMIT
    rows = rows[:_EVENT_CENTER_LIMIT]

    def _card(attr, sev=None, etype=None):
        def n(lo, hi):
            return sum(1 for r in rows if r[attr] and lo <= r[attr] <= hi
                       and (sev is None or r["severity"] == sev)
                       and (etype is None or r["event_type"] == etype))
        cur, prev = n(w_from, iso), n(p_from, p_to)
        return {"count": cur, "prevCount": prev,
                "delta": None if prev == 0 else round((cur - prev) / prev * 100)}

    summary = {"total": _card("first_seen_date"),
               "major": _card("first_seen_date", sev="major"),
               "minor": _card("first_seen_date", sev="minor"),
               "targetGap": _card("first_seen_date", etype="target_gap"),
               "resolved": _card("resolved_at")}

    by_day: dict = {}
    for r in rows:
        if r["first_seen_date"]:
            d = by_day.setdefault(r["first_seen_date"], {"total": 0, "major": 0, "minor": 0})
            d["total"] += 1
            d[r["severity"]] = d.get(r["severity"], 0) + 1   # 第三值防御：计入不炸（第三值只进 total）
    points = []
    for i in range(30):
        d = (today - timedelta(days=29 - i)).isoformat()
        v = by_day.get(d, {})
        points.append({"date": d, "total": v.get("total", 0),
                       "major": v.get("major", 0), "minor": v.get("minor", 0)})

    tc: dict = {}
    lc = {"active": 0, "resolved": 0}
    for r in rows:
        tc[r["event_type"]] = tc.get(r["event_type"], 0) + 1
        lc[r["lifecycle"]] = lc.get(r["lifecycle"], 0) + 1   # 第三值防御：计入不炸（输出仍只两键）

    late_keys = {event_key_of({"dim_keys": json.loads(r["dim_keys_json"])})
                 for r in _rows(db, "SELECT dim_keys_json FROM detector_finding"
                                    " WHERE is_late=1")}
    latest = (db.execute("SELECT MAX(brief_date) b FROM daily_brief").fetchone()["b"]) or ""
    pub = {r["event_id"]: r["rank"] for r in
           _rows(db, "SELECT event_id, rank FROM daily_brief_event WHERE brief_date=?",
                 (latest,))}
    pmin = RANKING["publish_min_score"]
    out = []
    for r in rows:
        try:
            scope = json.loads(r["scope_json"] or "{}")
        except Exception:
            scope = {}
        try:
            facts = json.loads(r["facts_json"] or "[]")
        except Exception:
            facts = []
        org = (scope.get("组织节点") or "").partition("|")[0] or None   # 展示归一：锚点串取首段
        if org == "瓷砖":                       # BU 级锚点首段短名 → 显示范围字段
            org = scope.get("范围") or org
        out.append({"event_id": r["event_id"], "detector": r["detector"],
                    "event_type": r["event_type"], "title": r["title"],
                    "summary": r["summary"], "severity": r["severity"],
                    "org": org, "channel": scope.get("渠道"),
                    "facts": facts, "score": r["score"],
                    "persist_days": r["persist_days"],
                    "first_seen_date": r["first_seen_date"],
                    "last_seen_date": r["last_seen_date"],
                    "lifecycle": r["lifecycle"], "resolved_at": r["resolved_at"],
                    "attribution_status": r["attribution_status"],
                    "created_at": r["created_at"],
                    "attribution_generated_at": r["attribution_generated_at"],
                    "late": r["event_key"] in late_keys,
                    "publishedToday": r["event_id"] in pub,
                    "rankToday": pub.get(r["event_id"]),
                    "scoreGap": round(r["score"] - pmin, 1)})
    return {"asOf": iso, "summary": summary,
            "trend": {"days": 30, "points": points},
            "eventTypeDistribution": [{"key": k, "label": _EVENT_TYPE_LABELS.get(k, k), "count": v}
                                      for k, v in sorted(tc.items(), key=lambda x: -x[1])],
            "lifecycleDistribution": [{"key": k, "label": _LIFECYCLE_LABELS[k], "count": lc[k]}
                                      for k in ("active", "resolved")],
            "truncated": truncated, "events": out}

def make_server(db: sqlite3.Connection, host: str = "127.0.0.1",
                port: int = 58095, trend_runner=None) -> ThreadingHTTPServer:
    # ThreadingHTTPServer 在工作线程跑 do_GET，而连接通常创建于主线程
    # （sqlite3 默认 check_same_thread=True 拒绝跨线程使用）——按路径重开
    # 一条线程安全的只读连接供服务用（红线上移：API 服务面恒 mode=ro）。
    db_path = db.execute("PRAGMA database_list").fetchone()[2]
    ro = sqlite3.connect(f"file:{Path(db_path).as_posix()}?mode=ro", uri=True,
                         check_same_thread=False)
    ro.row_factory = sqlite3.Row
    # DWS 编排（trend/health-score）：runner 缺席（进程无 DWS_PASSWORD）→ 端点 503
    service = TrendService(trend_runner) if trend_runner else None

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):     # 安静（pm2 管日志）
            pass

        def do_GET(self):
            u = urlparse(self.path)
            q = parse_qs(u.query)
            try:
                if u.path == "/api/insight/daily":
                    want = (q.get("date") or [""])[0]
                    if want:
                        payload = _daily_payload(ro, want)  # 显式回看：stale 恒 False
                    else:
                        latest = (ro.execute("SELECT MAX(brief_date) b FROM daily_brief"
                                             ).fetchone()["b"]) or "1970-01-01"
                        payload = _daily_payload(ro, latest)
                        payload["stale"] = latest < date.today().isoformat()  # Fix 3
                    body, code = payload, 200
                elif u.path == "/api/insight/events":
                    state = (q.get("state") or ["active"])[0]
                    if state == "active":
                        body, code = _active_events(ro), 200
                    elif state == "all":
                        body, code = _event_center(ro, date.today()), 200
                    else:
                        body, code = {"error": "BAD_STATE"}, 400
                elif (m := _EVENT_TREND_RE.match(u.path)):
                    if service is None:
                        body, code = {"error": "DWS_UNAVAILABLE"}, 503
                    else:
                        try:
                            months = int((q.get("months") or ["12"])[0])
                            if not 1 <= months <= 24:
                                raise ValueError
                        except ValueError:
                            body, code = {"error": "BAD_MONTHS"}, 400
                        else:
                            t = service.trend_for_event(ro, m.group(1), months)
                            body, code = (t, 200) if t is not None \
                                else ({"error": "NOT_FOUND"}, 404)
                elif (m := _EVENT_RELATED_RE.match(u.path)):
                    rel = _related(ro, m.group(1))
                    body, code = (rel, 200) if rel else ({"error": "NOT_FOUND"}, 404)
                elif u.path == "/api/insight/health-score":
                    if service is None:
                        body, code = {"error": "DWS_UNAVAILABLE"}, 503
                    else:
                        body, code = service.health(date.today() - timedelta(days=1)), 200
                elif (m := _EVENT_ID_RE.match(u.path)):
                    detail = _event_detail(ro, m.group(1))
                    body, code = (detail, 200) if detail else ({"error": "NOT_FOUND"}, 404)
                elif u.path == "/api/insight/timeline":
                    try:
                        days = int((q.get("days") or ["30"])[0])
                        if days < 0:
                            raise ValueError
                        body = [{"eventId": r["event_id"], "title": r["title"],
                                 "severity": r["severity"], "dataDate": r["data_date"],
                                 "createdAt": r["created_at"]}   # updated_at 因归因回填会重排（Fix 3）
                                for r in _rows(ro, "SELECT * FROM business_event"
                                                   " ORDER BY created_at DESC LIMIT ?",
                                               (days,))]
                        code = 200
                    except ValueError:
                        body, code = {"error": "BAD_DAYS"}, 400
                elif u.path == "/api/insight/health":
                    try:
                        ro.execute("SELECT 1")
                        body, code = {"ok": True, "db": "open"}, 200
                    except Exception:
                        body, code = {"ok": False, "db": "error"}, 200
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
    runner = None
    if os.environ.get("DWS_PASSWORD"):            # 密钥只走 env；缺席→trend/health-score 503
        from .dws import DwsQueryRunner
        runner = DwsQueryRunner(app_name="insight-trend", timeout_ms=30000)
    print(f"insight-api listening 127.0.0.1:{port} dws={'on' if runner else 'off'}")
    make_server(db, port=port, trend_runner=runner).serve_forever()

if __name__ == "__main__":
    main()
