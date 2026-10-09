# insight/trend_service.py
"""trend/health-score 的 DWS 编排（M-i5）：事件→锚点→detector.trend，进程内缓存。

缓存 key=(用途, detector, anchor, data_date/as_of, months)；数据日变更自然失效，
无 TTL 定时器；进程重启即冷。例外：health 结果"全降级"或"含异常致降级环（error
标记）"不落缓存（疑似 DWS 故障/单环持续故障不按天钉死，下次请求重查——2026-10-06
10053 事件加固）。ThreadingHTTPServer 多线程→持锁串行化（spec
§7：同一时刻至多一条查询打 DWS）。

SCH-1 修正F（2026-10-09）：target_overview / region_map 升级 watermark-aware——
底表是月滚动表（calmonth 月键、表内无日列），ready 判定=「已开 as_of 当月账」
（max(calmonth)≥当月），不得把日历 T-1 等价为已落齐；缓存键含 effective 月——
同日补数（当月账未开→已开）自然换键重取；「同日修订（月键不变内容变）」月表
watermark 天生检测不到，由管理端缓存失效动作兜底（文档明示）。探针结果 60s
负缓存防穿透（页面高频访问不重复打 DWS）。payload 附 dataFreshness{effective,
ready}，前端显示真实有效数据期而非日历 T-1。"""
import json
import threading
import time
from datetime import date

from .detectors import REGISTRY
from .detectors.target import TargetDetector
from .health import compute
from .merge_rank import event_key_of, event_org
from .region_map import region_map as _region_map   # 别名防撞 TrendService.region_map
from .replay_ctx import ReplayContext
from .target_report import target_overview as _report   # 别名防撞 TrendService.target_overview
from .watermark import Dependency, check_dependency

# 各服务的自身数据依赖（修正F：分别定义，不挂靠四雷达结果）
TARGET_DEPS = [Dependency(table="dm.dm_fin_operations_mix_sum_t", date_col="calmonth",
                          date_format="%Y-%m", required="data_date"),
               Dependency(table="dm.dm_dp_api_sales_target", date_col="stat_month",
                          date_format="%Y-%m", required="data_date")]
REGION_DEPS = [Dependency(table="dm.dm_fin_operations_mix_sum_t", date_col="calmonth",
                          date_format="%Y-%m", required="data_date")]
PROBE_TTL_S = 60


def _deps_ready(deps, runner, as_of: date):
    """依赖就绪探针（轻量 MAX 查询）。返回 (ready, effective_sig, detail)。
    语义：stale/empty=确定未落数（拦截，不计算不缓存）；error=探针自身失败
    （fail-open——维持旧行为照常计算，DWS 级故障仍由 compute 侧降级/不缓存规则兜底，
    不因探针不可用而阻断页面）。"""
    ctx = ReplayContext(as_of=as_of)
    parts, blocking = [], False
    for dep in deps:
        r = check_dependency(dep, runner, ctx)
        parts.append(f"{dep.table}:{r.reason}:{r.effective_data_date}")
        if r.reason in ("stale", "empty"):
            blocking = True
    return (not blocking), ";".join(parts), "; ".join(parts)


class TrendService:
    def __init__(self, runner):
        self.runner = runner
        self._cache: dict = {}
        self._lock = threading.Lock()
        self._probe: dict = {}       # (kind, as_of) -> (monotonic_ts, (ready, sig, detail))——60s 负缓存防穿透

    def _probe_fresh(self, kind: str, deps, as_of: date):
        """watermark 探针（带 60s 缓存）：页面高频访问不重复打 DWS。"""
        key = (kind, as_of.isoformat())
        hit = self._probe.get(key)
        now = time.monotonic()
        if hit and now - hit[0] < PROBE_TTL_S:
            return hit[1]
        out = _deps_ready(deps, self.runner, as_of)
        self._probe[key] = (now, out)
        return out

    def invalidate_cache(self) -> int:
        """管理端缓存失效（同日修订兜底——月键不变内容变的场景 watermark 检测不到）。"""
        with self._lock:
            n = len(self._cache)
            self._cache.clear()
            self._probe.clear()
            return n

    def cache_status(self) -> list[dict]:
        """缓存现状（管理后台）：kind/as_of/effective。"""
        return [{"key": "|".join(map(str, k))} for k in list(self._cache.keys())[-20:]]

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
                    # 连接自愈在 compute 内做（_retry_if_conn_dropped：环级异常且
                    # 连接已弃→重跑一次）；瞬断在此自愈，无需外层 _run_with_conn_retry
                    # （compute 环级 try/except 吞异常永不外抛，外层也抓不到）。
                    out = compute(self.runner, ReplayContext(as_of=as_of))
                    # 落缓存双条件（10053 事件加固）：①至少一数据环（sales/margin/ar）
                    # 可用——全降级=疑似 DWS 故障不按天钉死；②无“异常致降级”环（error
                    # 标记）——单环持续故障不把降级态钉进当日缓存；target 不参与判定
                    data_rings = [r for r in out["rings"] if r["key"] in ("sales", "margin", "ar")]
                    if (any(r.get("available") for r in data_rings)
                            and not any(r.get("error") for r in data_rings)):
                        self._cache[key] = out
                    else:
                        return out
        return self._cache[key]

    def target_overview(self, as_of: date) -> dict:
        """watermark-aware（修正F）：依赖未就绪（当月账未开）→ 不计算不缓存，返回
        降级载荷（available False + dataFreshness 说明）；就绪 → 缓存键含 effective 月。"""
        ready, sig, detail = self._probe_fresh("target", TARGET_DEPS, as_of)
        if not ready:
            return {"available": False, "reason": detail,
                    "dataFreshness": {"ready": False, "effective": sig,
                                      "note": "依赖底表尚未开出当月账（watermark 未就绪）"}}
        key = ("target_overview", as_of.isoformat(), sig)
        if key not in self._cache:
            with self._lock:
                if key not in self._cache:   # double-check：并发同 key 只查一次
                    out = self._run_with_conn_retry(
                        lambda: _report(self.runner, ReplayContext(as_of=as_of)))
                    out["dataFreshness"] = {"ready": True, "effective": sig}
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
        """区域作战地图（M-i8，修正F watermark-aware）：events 锁外读 db（SQLite 快，
        不占 DWS 锁）；依赖未就绪→不计算不缓存返回降级载荷；就绪→锁内一次组合 lambda
        先取 target trend 的达成率（D-r2 与 target-overview annual 同源）再跑聚合——
        两次 DWS 序列化都在锁内，缓存命中后零查询；缓存键含 effective 月。"""
        ready, sig, detail = self._probe_fresh("region", REGION_DEPS, as_of)
        if not ready:
            return {"available": False, "reason": detail,
                    "dataFreshness": {"ready": False, "effective": sig,
                                      "note": "依赖底表尚未开出当月账（watermark 未就绪）"}}
        key = ("region_map", as_of.isoformat(), sig)
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
                    out["dataFreshness"] = {"ready": True, "effective": sig}
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
