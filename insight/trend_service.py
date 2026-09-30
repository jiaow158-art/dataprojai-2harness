# insight/trend_service.py
"""trend/health-score 的 DWS 编排（M-i5）：事件→锚点→detector.trend，进程内缓存。

缓存 key=(用途, detector, anchor, data_date/as_of, months)；数据日变更自然失效，
无 TTL 定时器；进程重启即冷。例外：health 三数据环全降级不落缓存（疑似 DWS
故障不按天钉死，下次请求重查）。ThreadingHTTPServer 多线程→持锁串行化（spec
§7：同一时刻至多一条查询打 DWS）。"""
import json
import threading
from datetime import date

from .detectors import REGISTRY
from .health import compute
from .merge_rank import event_key_of
from .replay_ctx import ReplayContext


class TrendService:
    def __init__(self, runner):
        self.runner = runner
        self._cache: dict = {}
        self._lock = threading.Lock()

    def trend_for_event(self, db, event_id: str, months: int = 12) -> dict | None:
        ev = db.execute("SELECT event_id, event_key, detector, data_date"
                        " FROM business_event WHERE event_id=?", (event_id,)).fetchone()
        if not ev:
            return None
        anchor = ""
        for r in db.execute("SELECT dim_keys_json FROM detector_finding"
                            " WHERE data_date=? ORDER BY finding_id", (ev["data_date"],)):
            dk = json.loads(r["dim_keys_json"])
            if event_key_of({"dim_keys": dk}) == ev["event_key"]:
                anchor = dk.get("anchor_id", "")
                break
        key = ("trend", ev["detector"], anchor, ev["data_date"], months)
        if key not in self._cache:
            with self._lock:
                if key not in self._cache:   # double-check：并发同 key 只查一次
                    ctx = ReplayContext(as_of=date.fromisoformat(ev["data_date"]))
                    self._cache[key] = REGISTRY[ev["detector"]]().trend(
                        self.runner, ctx, anchor, months)
        return self._cache[key]

    def health(self, as_of: date) -> dict:
        key = ("health", as_of.isoformat())
        if key not in self._cache:
            with self._lock:
                if key not in self._cache:   # double-check：并发同 key 只查一次
                    out = compute(self.runner, ReplayContext(as_of=as_of))
                    # 三数据环（sales/margin/ar）全降级=疑似 DWS 故障：结果不落缓存，
                    # 下次请求重查（防全红卡按天钉死）；target 不参与该判定
                    if any(r["key"] in ("sales", "margin", "ar") and r.get("available")
                           for r in out["rings"]):
                        self._cache[key] = out
                    else:
                        return out
        return self._cache[key]
