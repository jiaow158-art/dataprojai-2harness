# insight/tests/test_db.py
import sqlite3
import pytest
from insight.db import open_db

_INS = ("INSERT INTO business_event (event_id, event_key, lifecycle, data_date,"
        " first_seen_date, last_seen_date, persist_days, detector, event_type,"
        " title, summary, severity, scope_json, period_json, facts_json, score,"
        " score_breakdown_json, metric, status, created_at, updated_at)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")

def _ROW(event_id="ev-1", event_key="K1", lifecycle="active"):
    return (event_id, event_key, lifecycle, "2026-09-22", "2026-09-22",
            "2026-09-22", 1, "region_sales", "sales_decline", "t", "s",
            "major", "{}", "{}", "[]", 80.0, "{}", "yoy", "discovered", 0, 0)

def test_schema_creates_all_spec_tables(tmp_path):
    db = open_db(tmp_path / "insight.db")
    names = {r["name"] for r in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    assert {"radar_run", "detector_finding", "business_event", "event_evidence",
            "event_analysis_run", "daily_brief", "daily_brief_event",
            "followup_session"} <= names
    index_names = {r["name"] for r in db.execute(
        "SELECT name FROM sqlite_master WHERE type='index'").fetchall()}
    assert {"uq_event_key_active", "idx_analysis_event"} <= index_names

def test_partial_unique_index_rejects_second_active(tmp_path):
    db = open_db(tmp_path / "insight.db")
    db.execute(_INS, _ROW()); db.commit()
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(_INS, _ROW(event_id="ev-2")); db.commit()

def test_resolved_then_new_active_allowed(tmp_path):
    db = open_db(tmp_path / "insight.db")
    db.execute(_INS, _ROW()); db.commit()
    db.execute("UPDATE business_event SET lifecycle='resolved' WHERE event_id='ev-1'")
    db.commit()
    db.execute(_INS, _ROW(event_id="ev-9")); db.commit()  # 不抛

def test_reopen_idempotent(tmp_path):
    p = tmp_path / "insight.db"
    db = open_db(p); db.close()
    db = open_db(p)  # 不抛
    assert db.execute("SELECT COUNT(*) FROM business_event").fetchone()[0] == 0
