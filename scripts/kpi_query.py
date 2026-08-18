#!/usr/bin/env python3
"""KPI 经营概览查询 — 输出单行 JSON 到 stdout（供 UI 服务端调用）。

指标口径（对齐 sales-performance-knowledge 语义层）：
- 销售额：dm_fin_operations_mix_sum_t.ambperformance（含税月达成额）
- 订单数：dm_fin_operations_mix_sum_t.zxssl（月销售数量）
- 客单价：销售额 / 订单数
- 毛利额：dm_fin_operations_mix_sum_t.gross_profit_after_sharing（分摊后毛利）
- 库存预警：dm_dp_api_stockout_oudue 最近统计期 stockout_area_ondue > 0 行数
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
        keys = [month_key(*cur_m), month_key(*prev_m), month_key(*ly_m)]
        placeholders = ",".join(["%s"] * len(keys))
        conn = get_conn()
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    f"""
                    SELECT calmonth,
                           SUM(ambperformance)        AS sales,
                           SUM(zxssl)                 AS qty,
                           SUM(gross_profit_after_sharing) AS gross_profit
                    FROM dm.dm_fin_operations_mix_sum_t
                    WHERE calmonth IN ({placeholders})
                    GROUP BY calmonth
                    """,
                    keys,
                )
                rows = {r["calmonth"]: r for r in cur.fetchall()}
                # 库存预警商品数（最近统计期缺货超期行数）
                # 注：表内存在脏数据（如 '5225-08'、未来月份），MAX 需限定 <= 当前月，
                # 否则会命中脏月份导致该 KPI 恒为 null。
                cur.execute(
                    """
                    SELECT COUNT(*) AS cnt
                    FROM dm.dm_dp_api_stockout_oudue
                    WHERE stockout_area_ondue > 0
                      AND stat_month_ym = (SELECT MAX(stat_month_ym) FROM dm.dm_dp_api_stockout_oudue
                                           WHERE stat_month_ym <= to_char(CURRENT_DATE, 'YYYY-MM'))
                    """
                )
                warning_row = cur.fetchone()
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

    sales = val(cur_m, "sales")
    qty = val(cur_m, "qty")
    gp = val(cur_m, "gross_profit")
    sales_prev, qty_prev, gp_prev = val(prev_m, "sales"), val(prev_m, "qty"), val(prev_m, "gross_profit")
    sales_ly, qty_ly, gp_ly = val(ly_m, "sales"), val(ly_m, "qty"), val(ly_m, "gross_profit")

    unit_price = round(sales / qty, 1) if sales is not None and qty else None
    unit_price_prev = round(sales_prev / qty_prev, 1) if sales_prev is not None and qty_prev else None
    unit_price_ly = round(sales_ly / qty_ly, 1) if sales_ly is not None and qty_ly else None

    # 金额类指标缩放到「万」显示（原始值为元）
    kpis = [
        {"key": "sales", "label": "销售额（本月）", "value": round(sales / 10000, 1) if sales is not None else None, "unit": "万", "mom": pct(sales, sales_prev), "yoy": pct(sales, sales_ly)},
        {"key": "orders", "label": "订单数（本月）", "value": qty, "unit": "单", "mom": pct(qty, qty_prev), "yoy": pct(qty, qty_ly)},
        {"key": "unit_price", "label": "客单价（本月）", "value": unit_price, "unit": "元", "mom": pct(unit_price, unit_price_prev), "yoy": pct(unit_price, unit_price_ly)},
        {"key": "gross_profit", "label": "毛利额（本月）", "value": round(gp / 10000, 1) if gp is not None else None, "unit": "万", "mom": pct(gp, gp_prev), "yoy": pct(gp, gp_ly)},
        {"key": "inventory_warning", "label": "库存预警商品", "value": float(warning_row["cnt"]) if warning_row and warning_row["cnt"] else None, "unit": "个", "mom": None, "yoy": None},
    ]
    print(json.dumps({"month": month_key(*cur_m), "kpis": kpis}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
