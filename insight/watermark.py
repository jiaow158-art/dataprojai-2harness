# insight/watermark.py
"""就绪探针（P0-3/D5）：max 实际数据日（封顶 as_of 防未来行）+ 行数>0。
Dependency 按 date_format 自己生成绑定参数与回读解析；比较全在 date 空间。"""
from dataclasses import dataclass
from datetime import date, datetime
from .replay_ctx import ReplayContext, month_end_of, shift_month

@dataclass
class Dependency:
    table: str
    date_col: str
    date_format: str            # %Y%m%d | %Y-%m-%d | %Y-%m
    required: str               # data_date | last_month_end
    extra_where: str = "1=1"

    def fmt(self, d: date) -> str:
        return d.strftime(self.date_format)

    def parse(self, s) -> date | None:
        if s is None:
            return None
        return datetime.strptime(str(s), self.date_format).date()

@dataclass
class WatermarkResult:
    dep: "Dependency"
    ready: bool
    effective_data_date: date | None
    rows: int
    reason: str                 # ok | stale | empty | error
    checked_at: str
    detail: str = ""            # error 时截断的异常 repr

def check_dependency(dep: Dependency, run, ctx: ReplayContext) -> WatermarkResult:
    now = datetime.now().isoformat(timespec="seconds")
    sql = (f"SELECT MAX({dep.date_col}) AS max_day, COUNT(*) AS rows_ "
           f"FROM {dep.table} WHERE {dep.extra_where} "
           f"AND {dep.date_col} <= %(data_date)s")
    bound = dep.fmt(ctx.as_of)
    try:
        row = run(sql, {"data_date": bound})[0]
        max_day = dep.parse(row["max_day"])
    except Exception as e:
        return WatermarkResult(dep, False, None, 0, "error", now, detail=repr(e)[:200])
    if max_day is None or row["rows_"] == 0:
        return WatermarkResult(dep, False, None, row["rows_"], "empty", now)
    if dep.required == "last_month_end":
        req = month_end_of(shift_month(ctx.as_of, -1))
    else:
        req = ctx.as_of
    if dep.date_format == "%Y-%m":
        stale = (max_day.year, max_day.month) < (req.year, req.month)
    else:
        stale = max_day < req
    if stale:
        return WatermarkResult(dep, False, max_day, row["rows_"], "stale", now)
    return WatermarkResult(dep, True, max_day, row["rows_"], "ok", now)
