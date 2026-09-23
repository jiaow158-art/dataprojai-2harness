# insight/backtest.py
"""历史重放（spec §17 + 裁定 #6/#7/#8）。

- point-in-time：值解析式守卫——任何"可解析为日期"的绑定参数（YYYYMMDD / YYYY-MM-DD /
  YYYY-MM）都必须 <= as_of（date 空间比较，杜绝混合格式字符串字典序）
- 确定性：同窗二跑 findings 逐字段一致（测试断言）
- 分级：每行携带 detector 的 point_in_time_mode（exact / retrospective）
- 可观测：非 ok 状态/带 note 的结果回显 stderr（占位配置/缺数据雷达不被静默跳过）
- 执行纪律（§14）：手动触发、非业务高峰、调用方逐月调用（无 --month-batch，裁定 #16）
用法：python -m insight.backtest --start 2025-10-01 --end 2025-10-31
"""
import argparse
import json
import sys
from datetime import date, datetime, timedelta

from .detectors import REGISTRY
from .dws import DwsQueryRunner
from .replay_ctx import ReplayContext

_FORMATS = ("%Y%m%d", "%Y-%m-%d", "%Y-%m")

def _parse_date(v):
    if not isinstance(v, str):
        return None
    for f in _FORMATS:
        try:
            return datetime.strptime(v, f).date()
        except ValueError:
            continue
    return None

def _iter_values(v):
    if isinstance(v, (list, tuple)):
        return v
    return [v]

def assert_point_in_time(params: dict, as_of: date) -> None:
    for k, v in params.items():
        for item in _iter_values(v):
            if isinstance(item, date):     # datetime 是 date 子类，比较仍正确
                d = item
            else:
                d = _parse_date(item)
            if d is not None and d > as_of:
                raise AssertionError(f"look-ahead：参数 {k}={item} 晚于 as_of {as_of}")

class BoundedRunner:
    def __init__(self, inner, as_of: date):
        self.inner, self.as_of = inner, as_of

    def __call__(self, sql: str, params: dict | None = None):
        p = dict(params or {})
        assert_point_in_time(p, self.as_of)
        return self.inner(sql, p)

def run_window(run, start: date, end: date, step_days: int, detectors: list[str]) -> list[dict]:
    out = []
    d = start
    while d <= end:
        ctx = ReplayContext(as_of=d)
        for name in detectors:
            try:
                det = REGISTRY[name]()
                res = det.detect(BoundedRunner(run, d), ctx)
                if res.status != "ok" or res.note:       # ★ 可观测回显
                    print(f"[backtest] {d.isoformat()} {name} status={res.status} "
                          f"note={res.note[:120]}", file=sys.stderr)
                for f in res.findings:
                    out.append({"data_date": f.data_date, "detector": f.detector,
                                "anchor": f.dim_keys["anchor_id"],
                                "norm_score": f.norm_score, "metrics": f.metrics,
                                "point_in_time_mode": det.cfg["backtest"]["point_in_time_mode"]})
            except Exception as e:                       # 单雷达崩溃不炸整窗（可观测非静默）
                print(f"[backtest] {d.isoformat()} {name} status=crash "
                      f"note={repr(e)[:120]}", file=sys.stderr)
        d += timedelta(days=step_days)
    out.sort(key=lambda r: (r["data_date"], r["detector"], r["anchor"]))  # SQL 行序非契约
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", required=True, help="YYYY-MM-DD")
    ap.add_argument("--end", required=True, help="YYYY-MM-DD（含）")
    ap.add_argument("--detectors", default="region_sales,gross_margin,ar_risk,target")
    ap.add_argument("--out", default="insight/backtest_results.jsonl")
    a = ap.parse_args()
    start = date.fromisoformat(a.start); end = date.fromisoformat(a.end)
    if start > end:
        ap.error("--start 必须不晚于 --end")
    names = [t.strip() for t in a.detectors.split(",") if t.strip()]
    unknown = [n for n in names if n not in REGISTRY]
    if unknown:
        ap.error(f"未知雷达: {unknown}，可用: {sorted(REGISTRY)}")
    runner = DwsQueryRunner(app_name="insight-backtest", timeout_ms=300000)
    try:
        with open(a.out, "a", encoding="utf-8", newline="\n") as fh:
            for row in run_window(runner, start, end, 7, names):
                fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    finally:
        runner.close()
    print(f"backtest done → {a.out}")

if __name__ == "__main__":
    main()
