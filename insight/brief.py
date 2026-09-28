"""09:30 freeze：当日榜=当日非晚到 findings→episode→Top0-3 快照（P0-2/P0-3）。

- 晚到 finding 已由 store 标 is_late=1：不进当日榜，但 update_episodes 用
  include_late=True 的全集延续生命周期（事件连续性与 freeze 解耦）。
- 未就绪诚实态：雷达已回报但全部 ready=False → not_ready，且完全不动
  episode 状态（无数据≠clean，跑 update_episodes 会误 resolve 活跃事件）。
  freshness=[]（无就绪检查数据）不过门，直接按 findings 计算。
- 幂等：同 brief_date 重跑先删旧快照再写（重跑场景，不洗牌=同输入同输出）。"""
import json
from .merge_rank import update_episodes, rank_findings, event_key_of

def freeze_brief(store, brief_date: str, data_date: str, freshness: list[dict]) -> dict:
    if freshness and not any(r.get("ready") for r in freshness):
        store.db.execute(
            "INSERT OR REPLACE INTO daily_brief (brief_date, scope, status, cutoff_at,"
            " published_at, event_count, freshness_json, attribution_started_at)"
            " VALUES (?,?,?,?,strftime('%s','now'),?,?,NULL)",
            (brief_date, "瓷砖事业部", "not_ready", None, 0,
             json.dumps({"radars": freshness}, ensure_ascii=False)))
        store.db.commit()
        return {"status": "not_ready", "event_count": 0}

    all_f = store.findings_for_date(data_date, include_late=True)      # 生命周期用全集
    episodes = update_episodes(store, data_date, all_f)
    persist_by_key = {e["event_key"]: e["persist_days"] for e in episodes}

    ranked = rank_findings([dict(f, persist_days=persist_by_key.get(event_key_of(f), 1))
                            for f in store.findings_for_date(data_date)])  # 榜单不含晚到

    store.db.execute("DELETE FROM daily_brief_event WHERE brief_date=?", (brief_date,))
    for rank_i, (f, sc) in enumerate(ranked, start=1):
        ep = next(e for e in episodes if e["event_key"] == event_key_of(f))
        row = store.db.execute("SELECT * FROM business_event WHERE event_id=?",
                               (ep["event_id"],)).fetchone()
        store.db.execute(
            "INSERT INTO daily_brief_event (brief_date, event_id, rank, score_snapshot,"
            " severity_snapshot, title_snapshot, summary_snapshot, facts_snapshot,"
            " event_type_snapshot, persist_days_snapshot, first_seen_date_snapshot,"
            " lifecycle_snapshot, published_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,strftime('%s','now'))",
            (brief_date, row["event_id"], rank_i, sc["score"], row["severity"],
             row["title"], row["summary"], row["facts_json"], row["event_type"],
             row["persist_days"], row["first_seen_date"], row["lifecycle"]))
    store.db.execute(
        "INSERT OR REPLACE INTO daily_brief (brief_date, scope, status, cutoff_at,"
        " published_at, event_count, freshness_json, attribution_started_at)"
        " VALUES (?,?,?,?,strftime('%s','now'),?,?,NULL)",
        (brief_date, "瓷砖事业部", "final", None, len(ranked),
         json.dumps({"radars": freshness}, ensure_ascii=False)))
    store.db.commit()
    return {"status": "final", "event_count": len(ranked),
            "events": [{"event_id": s2["event_id"], "rank": s2["rank"]}
                       for s2 in store.db.execute(
                           "SELECT event_id, rank FROM daily_brief_event"
                           " WHERE brief_date=? ORDER BY rank", (brief_date,)).fetchall()]}
