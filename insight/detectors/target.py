# insight/detectors/target.py
"""目标达成雷达（retrospective）。裁定 #13：NULL=缺数据（跳过+note），0=真实业务值
（照常参与计算——真实销售为 0 是重大异常）。
actual 侧 point-in-time 封顶（mix 有 calday 历史，calday<=as_of 防月中重放看到整月实绩）；
retrospective 仅指目标表侧（目标表只留当前记录，历史不可恢复）。"""
import calendar
from datetime import date
from ..replay_ctx import ReplayContext, shift_month
from .base import DetectResult, Finding, load_config, percentile_score

def time_progress_pct(as_of: date, basis: str, curve: dict | None = None) -> float:
    """时间进度（P1-4 优先级）。curve={day: pct}：精确命中取值，两点间线性插值，
    早于首点取首点值，超出最后点取最后值；basis=curve 但无曲线 → 自然日兜底（显式规则，均有测试）。
    workday 不含法定节假日（假期密集月用曲线口径）。"""
    days_in = calendar.monthrange(as_of.year, as_of.month)[1]
    if basis == "curve" and curve:
        pts = sorted(curve.items())
        if as_of.day <= pts[0][0]:
            return round(pts[0][1], 1)
        for (d0, p0), (d1, p1) in zip(pts, pts[1:]):
            if d0 <= as_of.day <= d1:
                v = p0 + (p1 - p0) * (as_of.day - d0) / (d1 - d0)
                return round(v, 1)
        return round(pts[-1][1], 1)
    if basis == "workday":
        wd = sum(1 for i in range(1, as_of.day + 1)
                 if date(as_of.year, as_of.month, i).weekday() < 5)
        total_wd = sum(1 for i in range(1, days_in + 1)
                       if date(as_of.year, as_of.month, i).weekday() < 5)
        return round(wd / total_wd * 100, 1)
    return round(as_of.day / days_in * 100, 1)          # natural 兜底

SQL = """
WITH actual AS (
  SELECT SUM(ambperformance) AS actual_amt
  FROM dm.dm_fin_operations_mix_sum_t
  WHERE calmonth = %(cur_month_ym)s
    AND calmonth <= %(cur_month_ym)s
    AND calday <= %(as_of_calday)s
    AND node_desc2 = '瓷砖事业部'
    AND data_source IN ('S','T','D','')
),
centers AS (
  SELECT DISTINCT node_name5 AS center
  FROM dm.dm_fin_operations_mix_sum_t
  WHERE calmonth = %(center_set_month_ym)s
    AND node_desc2 = '瓷砖事业部'
    AND data_source IN ('S','T','D','')
),
tgt AS (
  SELECT SUM(target_sales_amt) * 10000 AS target_amt
  FROM dm.dm_dp_api_sales_target
  WHERE stat_month = %(cur_month_ym)s
    AND stat_month <= %(cur_month_ym)s
    AND org_type = '业务单位'
    AND sales_center_code IN (SELECT center FROM centers)
)
SELECT a.actual_amt, t.target_amt FROM actual a CROSS JOIN tgt t
"""

class TargetDetector:
    def __init__(self, cfg: dict | None = None):
        self.cfg = cfg or load_config("target")

    @classmethod
    def for_test(cls):
        return cls(load_config("target"))

    def check_watermark(self, run, ctx: ReplayContext):
        from ..watermark import Dependency, check_dependency
        return [check_dependency(Dependency(**d), run, ctx) for d in self.cfg["deps"]]

    def detect(self, run, ctx: ReplayContext) -> DetectResult:
        p = self.cfg["params"]
        rows = run(SQL, {"cur_month_ym": ctx.ym(),
                         "as_of_calday": ctx.calday(),
                         "center_set_month_ym": shift_month(ctx.as_of, -p["center_set_month_lag"])
                         .strftime("%Y-%m")})
        if not rows:                       # 生产 CROSS JOIN 聚合恒 1 行；空行=缺数据（防崩）
            return DetectResult(self.cfg["name"], "not_ready", "缺数据：查询无行返回")
        r = rows[0]
        if r["actual_amt"] is None or r["target_amt"] is None:
            return DetectResult(self.cfg["name"], "not_ready", "缺数据：actual/target 为 NULL")
        if r["target_amt"] == 0:
            return DetectResult(self.cfg["name"], "not_ready", "数据异常：target_amt=0")
        achieve = round(r["actual_amt"] / r["target_amt"] * 100, 1)   # actual=0 → 0.0 照常
        tp = time_progress_pct(ctx.as_of, p["progress_basis"], p["progress_curve"])
        gap = round(achieve - tp, 1)
        findings = []
        if gap <= p["gap_threshold_pct"]:
            gap_wan = abs(r["actual_amt"] - r["target_amt"] * tp / 100) / 10000
            findings.append(Finding(
                detector=self.cfg["name"], data_date=ctx.as_of.isoformat(),
                dim_keys={"anchor_type": "org_channel",
                          "anchor_id": "瓷砖事业部|ALL", "channel": None},
                metrics={"achieve_pct": achieve, "time_pct": tp, "gap_pct": gap,
                         "abs_gap_wan": round(gap_wan),
                         "progress_basis": p["progress_basis"]},
                norm_score=percentile_score(gap_wan, self.cfg["norm"]["baseline_wan"])))
        return DetectResult(self.cfg["name"], "ok", findings=findings)
