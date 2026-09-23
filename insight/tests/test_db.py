# insight/tests/test_db.py
import sqlite3
import pytest
from insight.db import open_db

def test_schema_creates_all_spec_tables(tmp_path):
    db = open_db(tmp_path / "insight.db")
    names = {r["name"] for r in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    assert {"radar_run", "detector_finding", "business_event", "event_evidence",
            "event_analysis_run", "daily_brief", "daily_brief_event",
            "followup_session"} <= names

def test_partial_unique_index_rejects_second_active(tmp_path):
    db = open_db(tmp_path / "insight.db")
    ins = ("INSERT INTO business_event (event_id, event_key, lifecycle, data_date,"
           " first_seen_date, last_seen_date, persist_days, detector, event_type,"
           " title, summary, severity, scope_json, period_json, facts_json, score,"
           " score_breakdown_json, metric, status, created_at, updated_at)"
           " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    row = ("ev-1", "K1", "active", "2026-09-22", "2026-09-22", "2026-09-22", 1,
           "region_sales", "sales_decline", "t", "s", "major", "{}", "{}", "[]",
           80.0, "{}", "yoy", "discovered", 0, 0)
    db.execute(ins, row); db.commit()
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(ins, ("ev-2", "K1", "active") + row[3:]); db.commit()

def test_resolved_then_new_active_allowed(tmp_path):
    db = open_db(tmp_path / "insight.db")
    ins = ("INSERT INTO business_event (event_id, event_key, lifecycle, data_date,"
           " first_seen_date, last_seen_date, persist_days, detector, event_type,"
           " title, summary, severity, scope_json, period_json, facts_json, score,"
           " score_breakdown_json, metric, status, created_at, updated_at)"
           " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    row = ("ev-1", "K1", "active", "2026-09-22", "2026-09-22", "2026-09-22", 1,
           "region_sales", "sales_decline", "t", "s", "major", "{}", "{}", "[]",
           80.0, "{}", "yoy", "discovered", 0, 0)
    db.execute(ins, row); db.commit()
    db.execute("UPDATE business_event SET lifecycle='resolved' WHERE event_id='ev-1'")
    db.commit()
    db.execute(ins, ("ev-9", "K1", "active") + row[3:]); db.commit()  # 不抛
