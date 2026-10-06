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
from .detectors.target import TargetDetector
from .health import compute
from .merge_rank import event_key_of, event_org
from .region_map import region_map as _region_map   # 别名防撞 TrendService.region_map
from .replay_ctx import ReplayContext
from .target_report import target_overview as _report   # 别名防撞 TrendService.target_overview


class TrendService:
    def __init__(self, runner):
        self.runner = runner
        self._cache: dict = {}
        self._lock = threading.Lock()

    def _run_with_conn_retry(self, fn):
        """连接级失败重试一次：空闲连接被 DWS 服务端掐断时 runner._recover 已弃连接
        （rollback 失败→_conn=None），重建后原样重跑；连接仍在（如语句超时）则照抛。"""
        try:
            return fn()
        except Exception:
            if getattr(self.runner, "_conn", None) is not None:
                raise
            return fn()

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
                    self._cache[key] = self._run_with_conn_retry(
                        lambda: REGISTRY[ev["detector"]]().trend(
                            self.runner, ctx, anchor, months))
        return self._cache[key]

    def health(self, as_of: date) -> dict:
        key = ("health", as_of.isoformat())
        if key not in self._cache:
            with self._lock:
                if key not in self._cache:   # double-check：并发同 key 只查一次
                    # 连接级失败不套 _run_with_conn_retry：compute 环级 try/except 吞
                    # 异常→available:false，永不外抛，外层重试抓不到；跨请求自愈由
                    # 下面"全降级不缓存"承担（下次重查时 runner 已重建连接）。
                    out = compute(self.runner, ReplayContext(as_of=as_of))
                    # 三数据环（sales/margin/ar）全降级=疑似 DWS 故障：结果不落缓存，
                    # 下次请求重查（防全红卡按天钉死）；target 不参与该判定
                    if any(r["key"] in ("sales", "margin", "ar") and r.get("available")
                           for r in out["rings"]):
                        self._cache[key] = out
                    else:
                        return out
        return self._cache[key]

    def target_overview(self, as_of: date) -> dict:
        key = ("target_overview", as_of.isoformat())
        if key not in self._cache:
            with self._lock:
                if key not in self._cache:   # double-check：并发同 key 只查一次
                    out = self._run_with_conn_retry(
                        lambda: _report(self.runner, ReplayContext(as_of=as_of)))
                    # annual/months/centers 三块全降级=疑似 DWS 故障：不落缓存，下次
                    # 请求重查（同 health I-2 规则，防全降级页按天钉死）；projection
                    # 依赖 annual，不参与判定
                    def usable(block):
                        return not (isinstance(block, dict)
                                    and block.get("available") is False)
                    if all(usable(out[k]) for k in ("annual", "months", "centers")):
                        self._cache[key] = out
                    else:
                        return out
        return self._cache[key]

    def region_map(self, db, as_of: date) -> dict:
        """区域作战地图（M-i8）：events 锁外读 db（SQLite 快，不占 DWS 锁）；锁内一次
        组合 lambda 先取 target trend 的达成率（D-r2 与 target-overview annual 同源）
        再跑聚合——两次 DWS 序列化都在锁内，缓存命中后零查询。"""
        key = ("region_map", as_of.isoformat())
        if key not in self._cache:
            events = []
            for r in db.execute("SELECT event_id, title, severity, score, scope_json"
                                " FROM business_event WHERE lifecycle='active'"
                                " ORDER BY score DESC, event_id"):
                try:
                    scope = json.loads(r["scope_json"] or "{}")
                except Exception:
                    scope = {}
                events.append({"event_id": r["event_id"], "title": r["title"],
                               "severity": r["severity"], "score": r["score"],
                               "org": event_org(scope)})
            with self._lock:
                if key not in self._cache:   # double-check：并发同 key 只查一次
                    ctx = ReplayContext(as_of=as_of)

                    def compute():
                        try:    # 目标侧局部降级：达成率取不到→null，不拖垮地图主体
                            t = self._run_with_conn_retry(
                                lambda: TargetDetector().trend(
                                    self.runner, ctx, "瓷砖事业部|ALL"))
                            achieve = t["series"][-1]["cur"]
                        except Exception:
                            achieve = None
                        return _region_map(self.runner, ctx, events, achieve)

                    out = self._run_with_conn_retry(compute)
                    # national+regions 双块全降级=疑似 DWS 故障：不落缓存（health/target
                    # 同 I-2 规则）；其余块局部降级照常落缓存
                    def usable(block):
                        return not (isinstance(block, dict)
                                    and block.get("available") is False)
                    if usable(out["national"]) and usable(out["regions"]):
                        self._cache[key] = out
                    else:
                        return out
        return self._cache[key]
