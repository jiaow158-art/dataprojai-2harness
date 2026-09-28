"""insight.db 写入/读取层。Store 持有连接；所有 JSON 字段在这里序列化。"""
import json
import uuid

def _uid(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"

class Store:
    def __init__(self, conn):
        self.db = conn

    # —— radar_run / detector_finding ——
    def insert_radar_run(self, detector: str, data_date: str, status: str,
                         findings_count: int, watermark_detail: str = "",
                         started_at: int = 0, finished_at: int = 0) -> str:
        run_id = _uid("rr")
        self.db.execute(
            "INSERT INTO radar_run (run_id, data_date, detector, started_at, finished_at,"
            " status, watermark_json, findings_count, error) VALUES (?,?,?,?,?,?,?,?,?)",
            (run_id, data_date, detector, started_at, finished_at, status,
             json.dumps({"detail": watermark_detail}, ensure_ascii=False),
             findings_count, watermark_detail))
        self.db.commit()
        return run_id

    def insert_finding(self, data_date: str, detector: str, dim_keys: dict,
                       metrics: dict, norm_score: int, is_late: bool) -> str:
        fid = _uid("fd")
        self.db.execute(
            "INSERT INTO detector_finding (finding_id, data_date, detector, dim_keys_json,"
            " metrics_json, norm_score, threshold_passed, is_late, created_at)"
            " VALUES (?,?,?,?,?,?,1,?,strftime('%s','now'))",
            (fid, data_date, detector, json.dumps(dim_keys, ensure_ascii=False),
             json.dumps(metrics, ensure_ascii=False), norm_score, int(is_late)))
        self.db.commit()
        return fid

    def findings_for_date(self, data_date: str, include_late: bool = False) -> list[dict]:
        sql = "SELECT * FROM detector_finding WHERE data_date=?"
        if not include_late:
            sql += " AND is_late=0"
        sql += " ORDER BY finding_id"
        rows = self.db.execute(sql, (data_date,)).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["dim_keys"] = json.loads(d["dim_keys_json"])
            d["metrics"] = json.loads(d["metrics_json"])
            out.append(d)
        return out

    # —— business_event（episode）——
    def active_episode(self, event_key: str):
        row = self.db.execute(
            "SELECT * FROM business_event WHERE event_key=? AND lifecycle='active'",
            (event_key,)).fetchone()
        return dict(row) if row else None

    # 注意：不用 INSERT OR REPLACE——REPLACE 是 DELETE+INSERT，会把 attribution_* /
    # created_at / first_seen_date 全部重置为默认值（事件跨日延续即丢归因）。
    # 这里用 ON CONFLICT(event_id) DO UPDATE 只更新可变列，归因列不碰即保留。
    # 跨日新数据回到 discovered（attribution_* 保留最新归因，UI 由 attribution_status 区分）
    # WHERE 守卫：倒序重放旧日期整体跳过（score/title/summary/severity 等标量不被旧数据覆写）
    def upsert_episode(self, event_key: str, event_id: str, data_date: str,
                       detector: str, event_type: str, title: str, summary: str,
                       severity: str, scope: dict, period: dict, facts: list,
                       score: float, breakdown: dict, metric: str, dim_keys: dict,
                       facets: dict | None = None) -> str:
        facet_set = " facet_json=excluded.facet_json," if facets is not None else ""
        self.db.execute(
            "INSERT INTO business_event (event_id, event_key, lifecycle,"
            " data_date, first_seen_date, last_seen_date, persist_days, detector,"
            " event_type, title, summary, severity, scope_json, period_json, facts_json,"
            " score, score_breakdown_json, metric, status, merged_from_json, facet_json,"
            " created_at, updated_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,"
            "strftime('%s','now'),strftime('%s','now'))"
            " ON CONFLICT(event_id) DO UPDATE SET"
            " lifecycle='active',"
            " data_date=MAX(excluded.data_date, data_date),"   # WHERE 已挡旧日期，双保险不回退
            " last_seen_date=MAX(excluded.last_seen_date, last_seen_date),"
            " persist_days=excluded.persist_days,"
            " detector=excluded.detector, event_type=excluded.event_type,"
            " title=excluded.title, summary=excluded.summary, severity=excluded.severity,"
            " scope_json=excluded.scope_json, period_json=excluded.period_json,"
            " facts_json=excluded.facts_json, score=excluded.score,"
            " score_breakdown_json=excluded.score_breakdown_json, metric=excluded.metric,"
            " status=excluded.status, merged_from_json=excluded.merged_from_json,"
            + facet_set +
            " updated_at=excluded.updated_at"
            " WHERE excluded.data_date >= business_event.data_date",
            (event_id, event_key, "active", data_date,
             self._first_seen(event_id, data_date), data_date,
             self._persist_days(event_id, data_date),
             detector, event_type, title, summary, severity,
             json.dumps(scope, ensure_ascii=False), json.dumps(period, ensure_ascii=False),
             json.dumps(facts, ensure_ascii=False), score,
             json.dumps(breakdown, ensure_ascii=False), metric, "discovered",
             json.dumps(dim_keys, ensure_ascii=False) if dim_keys else None,
             json.dumps(facets, ensure_ascii=False) if facets is not None else None))
        self.db.commit()
        return event_id

    def _first_seen(self, event_id: str, data_date: str) -> str:
        row = self.db.execute("SELECT first_seen_date FROM business_event WHERE event_id=?",
                              (event_id,)).fetchone()
        return row["first_seen_date"] if row else data_date

    def _persist_days(self, event_id: str, data_date: str) -> int:
        row = self.db.execute("SELECT persist_days, last_seen_date FROM business_event"
                              " WHERE event_id=?", (event_id,)).fetchone()
        if not row:
            return 1
        # 跨日延续：persist_days+1；同日重跑：保持（幂等）；倒序重放旧日期：不膨胀
        if data_date <= row["last_seen_date"]:
            return row["persist_days"]
        return row["persist_days"] + 1

    def open_episodes_excluding(self, keys: set[str], data_date: str) -> list[dict]:
        rows = self.db.execute(
            "SELECT * FROM business_event WHERE lifecycle='active'").fetchall()
        return [dict(r) for r in rows if r["event_key"] not in keys]

    def resolve_episode(self, event_id: str, resolved_at_day: str):
        self.db.execute(
            "UPDATE business_event SET lifecycle='resolved', resolved_at=?,"
            " updated_at=strftime('%s','now') WHERE event_id=?",
            (resolved_at_day, event_id))
        self.db.commit()
