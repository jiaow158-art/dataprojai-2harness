# insight/replay_ctx.py
"""canonical date 上下文（裁定 #5/#6/#7）。

内部统一 datetime.date；一切查询日期参数由 ctx 派生（格式属于 Dependency/ctx，
不属于 Detector 身份）；日期比较只发生在 date 空间，禁止混合格式字符串字典序。
Backtest 用 ReplayContext(as_of=历史日) 重放，天然 point-in-time。
"""
import calendar
from dataclasses import dataclass
from datetime import date, timedelta

def shift_month(d: date, delta: int) -> date:
    """目标月同日；日序超出目标月长度则钳到月末（如 2026-03-31 -1月 → 2026-02-28）。"""
    total = d.year * 12 + (d.month - 1) + delta
    y, m = divmod(total, 12)
    return date(y, m + 1, min(d.day, calendar.monthrange(y, m + 1)[1]))

def month_end_of(d: date) -> date:
    """任意日锚定，返回所在自然月月末（= 次月 1 日 - 1 天）。"""
    return d.replace(day=calendar.monthrange(d.year, d.month)[1])

@dataclass(frozen=True)
class ReplayContext:
    as_of: date

    def iso(self) -> str:   return self.as_of.isoformat()          # query_date
    def calday(self) -> str: return self.as_of.strftime("%Y%m%d")  # mix/ct calday
    def ym(self) -> str:    return self.as_of.strftime("%Y-%m")    # calmonth/stat_month
    def minus_days(self, days: int) -> date: return self.as_of - timedelta(days=days)
    def prev_month_ym(self) -> str:
        return shift_month(self.as_of, -1).strftime("%Y-%m")

    def completed_month_ends(self, n: int) -> list[date]:
        """截至 as_of 已结束的自然月月末，升序前 n 个（裁定 #8 完整自然月口径）。"""
        out: list[date] = []
        m = self.as_of.replace(day=1)
        while len(out) < n:
            end = month_end_of(m)
            if end <= self.as_of:
                out.append(end)
            m = shift_month(m, -1)
        return sorted(out)
