# insight/gray_report.py
"""M-i4 灰度 D8 指标报告（只读）：自动采集 ①就绪率 ②候选事件数 ③认可率（读人工裁决台账）。

D8 五指标中 ④85 场景回归、⑤数字不一致事故 的判定分别走 eval 体系与台账记录，
本脚本只做事实汇总，不下放行结论。台账 verdict 取值封闭集：认可|误报|数字不一致
（认可率=认可/(认可+误报)；数字不一致单独计数为事故，不入分母——spec D8 ③⑤分立）。
用法：python -m insight.gray_report [--db PATH] [--ledger PATH]
"""
import csv
import sys
from datetime import datetime, timedelta
from pathlib import Path
import sqlite3

VERDICT_OK, VERDICT_FP, VERDICT_MISMATCH = "认可", "误报", "数字不一致"
DEFAULT_LEDGER = Path(__file__).resolve().parent.parent / "eval_results" / "insight-gray" / "verdicts.csv"


def _local(ts: int) -> datetime:
    # store 落秒（实测 1790667609=2026-09-29 15:40）；>1e12 视为毫秒容错
    return datetime.fromtimestamp(ts / 1000 if ts > 1e12 else ts)


def collect(db_path: str | Path, ledger_path: str | Path = DEFAULT_LEDGER) -> dict:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        # ① 就绪率：final 简报的发布时点分布（09:30 freeze / 10:00 归因窗两口任选参考）
        briefs = conn.execute(
            "SELECT brief_date, status, published_at FROM daily_brief ORDER BY brief_date").fetchall()
        final = [b for b in briefs if b["status"] == "final"]
        on_time = {"by_0930": 0, "by_1000": 0}
        for b in final:
            if not b["published_at"]:
                continue
            day = datetime.strptime(b["brief_date"], "%Y-%m-%d")
            t = _local(b["published_at"])
            if t <= day + timedelta(hours=9, minutes=30):
                on_time["by_0930"] += 1
            if t <= day + timedelta(hours=10):
                on_time["by_1000"] += 1
        # ② 候选事件：发布快照行数 + 去重事件数（≥20 门槛口径=上榜过的 event_id）
        pub_rows = conn.execute("SELECT COUNT(*) c FROM daily_brief_event").fetchone()["c"]
        pub_events = conn.execute(
            "SELECT COUNT(DISTINCT event_id) c FROM daily_brief_event").fetchone()["c"]
        # 归因三态（仅上榜过的事件）
        attr = dict(conn.execute(
            "SELECT e.attribution_status, COUNT(DISTINCT e.event_id) c FROM business_event e"
            " WHERE e.event_id IN (SELECT DISTINCT event_id FROM daily_brief_event)"
            " GROUP BY e.attribution_status").fetchall())
        # ③⑤ 人工裁决台账
        verdicts = {VERDICT_OK: 0, VERDICT_FP: 0, VERDICT_MISMATCH: 0}
        ledger_rows = 0
        ledger = Path(ledger_path)
        if ledger.exists():
            with ledger.open(encoding="utf-8-sig", newline="") as f:
                for row in csv.DictReader(f):
                    v = (row.get("verdict") or "").strip()
                    if v in verdicts:
                        verdicts[v] += 1
                        ledger_rows += 1
        rated = verdicts[VERDICT_OK] + verdicts[VERDICT_FP]
        return {
            "brief_days": len(final),
            "brief_on_time": on_time,
            "published_rows": pub_rows,
            "published_events": pub_events,
            "attribution": attr,
            "verdicts": verdicts,
            "ledger_rows": ledger_rows,
            "approve_rate": round(verdicts[VERDICT_OK] / rated, 4) if rated else None,
        }
    finally:
        conn.close()


def render(m: dict) -> str:
    lines = [
        "── M-i4 灰度 D8 证据（自动汇总，不下放行结论）──",
        f"① 简报：final {m['brief_days']} 天｜09:30 前 {m['brief_on_time']['by_0930']}｜10:00 前 {m['brief_on_time']['by_1000']}",
        f"② 候选事件：上榜快照 {m['published_rows']} 行 / 去重事件 {m['published_events']} 个（门槛 ≥20）",
        f"   归因状态：{m['attribution'] or '无'}",
        f"③ 台账：已裁决 {m['ledger_rows']} 行 → 认可 {m['verdicts']['认可']} / 误报 {m['verdicts']['误报']}"
        f" / 数字不一致 {m['verdicts']['数字不一致']}",
        f"   认可率 = {m['approve_rate'] if m['approve_rate'] is not None else '—'}（门槛 ≥0.85；分母=认可+误报）",
        "④ 85 场景回归 / ⑤ 数字不一致事故数=台账'数字不一致'计数 → 放行前单独跑 eval 复核",
    ]
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    db = argv[argv.index("--db") + 1] if "--db" in argv else "insight.db"
    ledger = Path(argv[argv.index("--ledger") + 1]) if "--ledger" in argv else DEFAULT_LEDGER
    print(render(collect(db, ledger)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
