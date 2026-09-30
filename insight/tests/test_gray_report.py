# 灰度 D8 报告：就绪时点口径（09:30/10:00 双口）、去重事件计数、认可率分母=认可+误报（数字不一致不入分母）
import csv
from datetime import datetime

from insight.db import open_db
from insight.gray_report import DEFAULT_LEDGER, collect


def _seed(conn):
    # published_at 生产契约=epoch 秒（gray_report._local 同步容错毫秒）
    now = int(datetime(2026, 9, 29, 9, 10).timestamp())          # 09:10 发布=按时
    late = int(datetime(2026, 9, 28, 15, 0).timestamp())         # 下午发布=迟
    conn.execute("INSERT INTO daily_brief VALUES ('2026-09-28','瓷砖事业部','final',0,?,2,'{}',0)",
                 (late,))
    conn.execute("INSERT INTO daily_brief VALUES ('2026-09-29','瓷砖事业部','final',0,?,2,'{}',0)",
                 (now,))
    conn.execute("INSERT INTO daily_brief VALUES ('2026-09-30','瓷砖事业部','not_ready',0,NULL,0,'{}',0)")
    for i, d in enumerate(["2026-09-28", "2026-09-29"]):
        for ev in ("ev-a", "ev-b"):
            conn.execute(
                "INSERT INTO daily_brief_event VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (d, ev, 1 if ev == "ev-a" else 2, 80.0, "minor", f"t-{ev}", "s", "[]",
                 "target_gap", 3, "2026-09-01", "active", now))
    conn.execute(
        "INSERT INTO business_event (event_id,event_key,lifecycle,data_date,first_seen_date,"
        "last_seen_date,persist_days,detector,event_type,title,summary,severity,scope_json,"
        "period_json,facts_json,score,score_breakdown_json,metric,status,attribution_status,"
        "created_at,updated_at) VALUES ('ev-a','k1','active','2026-09-29','2026-09-28',"
        "'2026-09-29',2,'target','target_gap','t','s','minor','{}','{}','[]',80.0,'{}','m',"
        "'analyzed','done',0,0)")


def test_collect_metrics(tmp_path):
    db = tmp_path / "g.db"
    conn = open_db(db)
    _seed(conn)
    conn.commit()
    ledger = tmp_path / "verdicts.csv"
    with ledger.open("w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["brief_date", "event_id", "verdict", "note"])
        w.writerow(["2026-09-28", "ev-a", "认可", ""])
        w.writerow(["2026-09-28", "ev-b", "认可", ""])
        w.writerow(["2026-09-29", "ev-a", "误报", "口径"])
        w.writerow(["2026-09-29", "ev-b", "数字不一致", "简报 78 vs 问数 77"])
    m = collect(db, ledger)
    assert m["brief_days"] == 2                      # not_ready 不计
    assert m["brief_on_time"]["by_0930"] == 1        # 仅 09-29 按时；09-28 15:00 迟
    assert m["published_rows"] == 4                  # 2 日 × 2 事件
    assert m["published_events"] == 2                # ev-a 两日上榜去重
    assert m["attribution"] == {"done": 1}
    assert m["verdicts"] == {"认可": 2, "误报": 1, "数字不一致": 1}
    assert m["approve_rate"] == round(2 / 3, 4)      # 分母不含数字不一致；报告口径 4 位小数


def test_collect_empty_ledger(tmp_path):
    db = tmp_path / "g.db"
    conn = open_db(db)
    conn.commit()
    m = collect(db, tmp_path / "nope.csv")
    assert m["brief_days"] == 0 and m["approve_rate"] is None
    assert DEFAULT_LEDGER.name == "verdicts.csv"
