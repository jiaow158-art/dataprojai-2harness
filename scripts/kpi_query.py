#!/usr/bin/env python3
"""KPI 经营概览查询 — 输出单行 JSON 到 stdout（供 UI 服务端调用）。

指标口径（全部来自 dm_fin_operations_mix_sum_t，对齐 sales-performance-knowledge 语义层）：
- 业绩：ambperformance（含税月达成额）
- 销售面积：zxsmj（月销售面积，瓷砖行业经典指标）
- 客单价：业绩 / 月销售数量（zxssl）
- 毛利额：amb_profit_amt（阿米巴毛利额，2026-08-19 业务确认；原 gross_profit_after_sharing 为旧口径）
- 预算达成率：业绩 / 预算销售额（ambperformance_ys）
月度时效：当前日期 <= 次月 5 日时最近可用月为上月（本月数据未入库）。
"""
from __future__ import annotations

import json
import os
import sys
from datetime import date

import psycopg2
import psycopg2.extras


def get_conn():
    return psycopg2.connect(
        host=os.environ["DWS_HOST"],
        port=os.environ["DWS_PORT"],
        dbname=os.environ["DWS_DBNAME"],
        user=os.environ["DWS_USER"],
        password=os.environ["DWS_PASSWORD"],
        connect_timeout=15,
        options="-c statement_timeout=60000",
    )


def month_key(y: int, m: int) -> str:
    return f"{y:04d}-{m:02d}"


def prev_month(y: int, m: int):
    return (y - 1, 12) if m == 1 else (y, m - 1)


def resolve_months() -> tuple[tuple[int, int], tuple[int, int], tuple[int, int]]:
    today = date.today()
    cur_y, cur_m = today.year, today.month
    # 本月数据入库滞后：<= 次月5日时取上月
    if today.day <= 5:
        cur_y, cur_m = prev_month(cur_y, cur_m)
    prev = prev_month(cur_y, cur_m)
    last_year = (cur_y - 1, cur_m)
    return (cur_y, cur_m), prev, last_year


def pct(cur: float | None, base: float | None) -> float | None:
    if cur is None or base is None or base == 0:
        return None
    return round((cur - base) / base * 100, 1)


def main() -> int:
    try:
        cur_m, prev_m, ly_m = resolve_months()
        # 最近 6 个月（升序，当月最后）— 供趋势线使用
        months = [cur_m]
        m = cur_m
        for _ in range(5):
            m = prev_month(*m)
            months.insert(0, m)
        keys = [month_key(*x) for x in months]
        placeholders = ",".join(["%s"] * len(keys))
        conn = get_conn()
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    f"""
                    SELECT calmonth,
                           SUM(ambperformance)        AS sales,
                           SUM(zxssl)                 AS qty,
                           SUM(zxsmj)                 AS area,
                           SUM(amb_profit_amt)        AS gross_profit,  -- 2026-08-19 业务确认：毛利额=阿米巴毛利额口径（原 gross_profit_after_sharing 为旧口径）
                           SUM(ambperformance_ys)     AS budget
                    FROM dm.dm_fin_operations_mix_sum_t
                    WHERE calmonth IN ({placeholders})
                    GROUP BY calmonth
                    """,
                    keys,
                )
                rows = {r["calmonth"]: r for r in cur.fetchall()}
        finally:
            conn.close()
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        return 1

    def val(m: tuple[int, int], field: str) -> float | None:
        row = rows.get(month_key(*m))
        if not row or row[field] is None:
            return None
        return float(row[field])

    def spark(field: str, transform=None) -> list[float | None] | None:
        """最近 6 个月的真实序列（升序，当月最后）；任一月缺失则整体 null。"""
        out: list[float | None] = []
        for month in months:
            v = val(month, field)
            if v is None:
                return None
            out.append(round(transform(v), 1) if transform else v)
        return out

    sales = val(cur_m, "sales")
    qty = val(cur_m, "qty")
    area = val(cur_m, "area")
    gp = val(cur_m, "gross_profit")
    budget = val(cur_m, "budget")
    sales_prev, qty_prev, area_prev = val(prev_m, "sales"), val(prev_m, "qty"), val(prev_m, "area")
    gp_prev, budget_prev = val(prev_m, "gross_profit"), val(prev_m, "budget")
    sales_ly, qty_ly, area_ly = val(ly_m, "sales"), val(ly_m, "qty"), val(ly_m, "area")
    gp_ly, budget_ly = val(ly_m, "gross_profit"), val(ly_m, "budget")

    unit_price = round(sales / qty, 1) if sales is not None and qty else None
    unit_price_prev = round(sales_prev / qty_prev, 1) if sales_prev is not None and qty_prev else None
    unit_price_ly = round(sales_ly / qty_ly, 1) if sales_ly is not None and qty_ly else None

    def achieve(cur: float | None, base: float | None) -> float | None:
        if cur is None or base is None or base == 0:
            return None
        return round(cur / base * 100, 1)

    def achieve_spark() -> list[float | None] | None:
        out: list[float | None] = []
        for month in months:
            s = val(month, "sales")
            b = val(month, "budget")
            if s is None or b is None or b == 0:
                return None
            out.append(round(s / b * 100, 1))
        return out

    def unit_price_spark() -> list[float | None] | None:
        out: list[float | None] = []
        for month in months:
            s = val(month, "sales")
            q = val(month, "qty")
            if s is None or q is None or q == 0:
                return None
            out.append(round(s / q, 1))
        return out

    # 金额类指标缩放到「万」显示（原始值为元）；面积缩放为「万㎡」
    kpis = [
        {"key": "sales", "label": "业绩（本月）", "value": round(sales / 10000, 1) if sales is not None else None, "unit": "万", "mom": pct(sales, sales_prev), "yoy": pct(sales, sales_ly), "spark": spark("sales", lambda v: v / 10000)},
        {"key": "area", "label": "销售面积（本月）", "value": round(area / 10000, 1) if area is not None else None, "unit": "万㎡", "mom": pct(area, area_prev), "yoy": pct(area, area_ly), "spark": spark("area", lambda v: v / 10000)},
        {"key": "unit_price", "label": "客单价（本月）", "value": unit_price, "unit": "元", "mom": pct(unit_price, unit_price_prev), "yoy": pct(unit_price, unit_price_ly), "spark": unit_price_spark()},
        {"key": "gross_profit", "label": "毛利额（本月）", "value": round(gp / 10000, 1) if gp is not None else None, "unit": "万", "mom": pct(gp, gp_prev), "yoy": pct(gp, gp_ly), "spark": spark("gross_profit", lambda v: v / 10000)},
        {"key": "budget_achieve", "label": "预算达成率（本月）", "value": achieve(sales, budget), "unit": "%", "mom": pct(achieve(sales, budget), achieve(sales_prev, budget_prev)), "yoy": pct(achieve(sales, budget), achieve(sales_ly, budget_ly)), "spark": achieve_spark()},
    ]
    print(json.dumps({"month": month_key(*cur_m), "kpis": kpis}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
