# insight/worker_main.py
"""日编排（pm2 入口）：就绪驱动→四雷达串行→freeze→（10:00-14:00 窗口）归因。

薄层原则：调度/接线在此，逻辑在被测模块。测试注入 runner_for/watermark_ok/now。
生产入口 run_prod()：每雷达独立 DwsQueryRunner(app_name=insight-radar,
timeout_ms=cfg.timeout_ms)（per-radar timeout 接线，M-i1 遗留销账）。

worker 契约：freshness 必须从真实就绪检查构建、永不为空——run_day 对 REGISTRY
每雷达都 append 一项（ready/ready_check_failed/already-ran/error 全覆盖），
结构上非空；freeze_brief 的 fail-closed 就绪门依赖此契约。

late 语义（裁定=发布态判定）：is_late 只在"该 brief_date 已发布 final 之后到达"
时置位——P0-3 保护的是已发布面，不是惩罚运维迟到；未发布前的首跑（哪怕 10:30）
照常发布，防"空 final 假平安"。"""
import json
from datetime import date, datetime, time as dtime, timedelta
from .attribution import run_attribution       # 模块级导入：run_attributions 可 monkeypatch
from .backtest import BoundedRunner           # 复用 point-in-time 守卫
from .brief import freeze_brief
from .db import open_db
from .detectors import REGISTRY
from .dws import DwsQueryRunner
from .replay_ctx import ReplayContext
from .store import Store

CUTOFF_FREEZE = dtime(9, 30)
ATTRIBUTION_FROM = dtime(10, 0)
ATTRIBUTION_UNTIL = dtime(14, 0)

def run_day(store: Store, data_date: str, brief_date: str, now: datetime,
            runner_for, watermark_ok, freshness_detail) -> dict:
    ctx = ReplayContext(as_of=date.fromisoformat(data_date))
    prior = store.db.execute("SELECT status FROM daily_brief WHERE brief_date=?",
                             (brief_date,)).fetchone()
    # 发布态判定 late（now 保留为编排参数）：prior final 之后到达的 finding 才标 late
    late = bool(prior and prior["status"] == "final")
    freshness = []
    for name in sorted(REGISTRY):
        det = REGISTRY[name]()
        already = store.db.execute(
            "SELECT COUNT(*) c FROM radar_run WHERE data_date=? AND detector=?"
            " AND status='ran'", (data_date, name)).fetchone()["c"]
        if already:                                   # ★ 同日重跑去重（防 findings 翻倍）
            freshness.append({"detector": name, "ready": True, "detail": "already-ran"})
            continue
        run = runner_for(name)
        if not watermark_ok(name, run):
            store.insert_radar_run(name, data_date, "ready_check_failed", 0,
                                   watermark_detail=freshness_detail(name))
            freshness.append({"detector": name, "ready": False,
                              "detail": freshness_detail(name)})
            continue
        try:
            res = det.detect(BoundedRunner(run, ctx.as_of), ctx)
        except Exception as e:
            store.insert_radar_run(name, data_date, "error", 0,
                                   watermark_detail=repr(e)[:200])
            freshness.append({"detector": name, "ready": False, "detail": repr(e)[:120]})
            continue
        for f in res.findings:
            store.insert_finding(data_date, f.detector, f.dim_keys, f.metrics,
                                 f.norm_score, is_late=late)
        store.insert_radar_run(name, data_date, "ran", len(res.findings),
                               watermark_detail=freshness_detail(name))
        freshness.append({"detector": name, "ready": True, "detail": "ok"})
    brief = freeze_brief(store, brief_date, data_date, freshness)
    return {"brief": brief}

def run_attributions(store: Store, brief_date: str, now_t: dtime) -> list[dict]:
    """归因循环（可测）：窗口外返回空表；每日重归因裁定——done 且 analysis_date=当日
    才跳过，分析日期落后当日即重归因（持续上榜事件的分析不得冻结在首日）；幂等键
    event_id:analysis_date 保证当日多次触发网关去重；单事件异常记 failed 不中断后续。"""
    if not (ATTRIBUTION_FROM <= now_t <= ATTRIBUTION_UNTIL):
        return []
    results = []
    for row in store.db.execute(
            "SELECT b.event_id FROM daily_brief_event b"
            " JOIN business_event e ON e.event_id = b.event_id"
            " LEFT JOIN (SELECT event_id, MAX(analysis_date) ad FROM event_analysis_run"
            " GROUP BY event_id) a ON a.event_id = b.event_id"
            " WHERE b.brief_date=? AND (e.attribution_status != 'done'"
            " OR a.ad IS NULL OR a.ad < ?)"
            " ORDER BY b.rank", (brief_date, brief_date)).fetchall():
        try:
            r = run_attribution(store, row["event_id"], brief_date)
            results.append({"event_id": row["event_id"], **r})
        except Exception as e:
            results.append({"event_id": row["event_id"], "status": "failed",
                            "error": repr(e)[:200]})
    return results

def _brief_date(argv: list[str]) -> str:
    """--brief-date YYYY-MM-DD（可选）：补跑指定简报日（缺省 today）。补归因场景：
    机器在 10:00-14:00 窗口内宕机后补发当日 Top——雷达 skip-ran、freeze
    first-final-wins 均幂等，实际效果=补该日归因（窗口门控仍生效）。"""
    if "--brief-date" in argv:
        return date.fromisoformat(argv[argv.index("--brief-date") + 1]).isoformat()
    return datetime.now().date().isoformat()

def run_prod():
    """生产入口（pm2）。env：INSIGHT_DB_PATH / DWS_* / GW_URL / GW_AUTH_TOKEN / INSIGHT_GW_USER。
    可选 --brief-date YYYY-MM-DD：补跑指定简报日（缺省 today）。"""
    import os
    import sys
    from .watermark import Dependency, check_dependency
    store = Store(open_db(os.environ["INSIGHT_DB_PATH"]))
    d = date.fromisoformat(_brief_date(sys.argv[1:]))
    data_date = (d - timedelta(days=1)).isoformat()
    brief_date = d.isoformat()
    runners = {}
    wm_detail: dict[str, str] = {}            # watermark detail → radar_run.error 列

    def runner_for(name):
        if name not in runners:
            cfg = REGISTRY[name]().cfg
            runners[name] = DwsQueryRunner(app_name="insight-radar",
                                           timeout_ms=cfg["timeout_ms"])
        return runners[name]

    def watermark_ok(name, run):
        det = REGISTRY[name]()
        ctx = ReplayContext(as_of=date.fromisoformat(data_date))
        results = [check_dependency(Dependency(**d), run, ctx)
                   for d in det.cfg["deps"]]
        wm_detail[name] = "; ".join(
            f"{r.reason}:{r.effective_data_date}" for r in results)
        return all(r.ready for r in results)

    def freshness_detail(name):
        return wm_detail.get(name, "n/a")

    out = run_day(store, data_date, brief_date, datetime.now(),
                  runner_for, watermark_ok, freshness_detail)
    print(json.dumps({"brief": out["brief"]}, ensure_ascii=False))
    for r in run_attributions(store, brief_date, datetime.now().time()):
        if r.get("error"):
            print(f"[attribution] {r['event_id']} failed: {r['error']}")
        else:
            print(f"[attribution] {r['event_id']} -> {r['status']}")

if __name__ == "__main__":
    run_prod()
