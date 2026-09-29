# insight/tests/test_e2e_smoke.py
"""M-i2 全链路 smoke：fixture 数据日 → worker → freeze → 归因(mock 网关) → api 读。"""
import threading
import urllib.request
from datetime import datetime
import json
from insight.api_main import make_server
from insight.db import open_db
from insight.store import Store
from insight.worker_main import run_day

def test_full_pipeline_smoke(tmp_path, monkeypatch):
    s = Store(open_db(tmp_path / "i.db"))

    def runner_for(name):
        def run(sql, params=None):
            if "ct_sales_performance_t" in sql:
                months = [f"{p[:4]}-{p[4:6]}" for p in params["month_ends"]]
                return [{"month": m, "org_name": "华南营销中心", "channel": "GD01",
                         "cur_amt": 20000000.0, "ly_amt": 30000000.0} for m in months]
            return []
        return run

    out = run_day(s, "2026-09-27", "2026-09-28", now=datetime(2026, 9, 28, 8, 0),
                  runner_for=runner_for,
                  watermark_ok=lambda name, run: True,
                  freshness_detail=lambda name: "ready; eff=2026-09-27")
    assert out["brief"]["status"] == "final"
    assert out["brief"]["event_count"] >= 1

    # 归因（mock 网关：成功 + 结构化）
    import insight.attribution as att
    monkeypatch.setattr(att, "_gw_submit", lambda p, cid: "gw-e2e-1")
    good = att.AttributionResult(run_id="gw-e2e-1", status="succeeded",
                                 answer_md='分析……\n```json\n{"summary":"华南下滑主因广东",'
                                           '"path":[],"findings":[{"text":"t","evidence":"q1"}],'
                                           '"waterfall":[],"entities":[]}\n```')
    monkeypatch.setattr(att, "_gw_consume", lambda rid: good)
    from insight.attribution import run_attribution
    eid = out["brief"]["events"][0]["event_id"]
    res = run_attribution(s, eid, "2026-09-28")
    assert res["status"] == "done"

    # api 读
    srv = make_server(s.db, port=0)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    try:
        with urllib.request.urlopen(f"{base}/api/insight/daily", timeout=5) as r:
            daily = json.loads(r.read().decode("utf-8"))
        assert daily["eventCount"] >= 1
        with urllib.request.urlopen(f"{base}/api/insight/events/{eid}", timeout=5) as r:
            detail = json.loads(r.read().decode("utf-8"))
        assert detail["attribution"]["status"] == "done"
        assert detail["attribution"]["summary"] == "华南下滑主因广东"
    finally:
        srv.shutdown()
