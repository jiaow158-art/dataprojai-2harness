#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""migrate_scatter_series.py — 把单 series 多命名点的散点拆分为每产品独立 series。

四象限/风险散点修复的迁移工具：旧报告 JSON（Agent 按旧配方产出）不经重新查询，
机械拆分后即可过新 validator 并重建。用法:
    python3 migrate_scatter_series.py --json reports/user:4/sku_series_quadrant.json
"""
import argparse
import json
import sys

# 与 chart-recipes.md §2 一致的 10 色板（series 数 > 8 时 chart 级声明，防 palette 循环撞色）
PALETTE = ["#2563EB", "#06B6D4", "#7C3AED", "#DB2777", "#F59E0B",
           "#10B981", "#EF4444", "#8B5CF6", "#EC4899", "#14B8A6"]


def migrate_chart(opt):
    """原地拆分 chart.option 中的单 series 多命名散点。返回是否发生过拆分。"""
    if not isinstance(opt, dict):
        return False
    changed = False
    series = opt.get("series") or []
    out = []
    for se in series:
        if not isinstance(se, dict) or se.get("type") != "scatter":
            out.append(se)
            continue
        data = se.get("data") or []
        named = [dp for dp in data if isinstance(dp, dict) and dp.get("name")]
        if len(named) < 2:
            out.append(se)
            continue
        changed = True
        mark = se.get("markLine")  # 分割线只挂拆分后的第一个 series
        for i, dp in enumerate(named):
            new_se = dict(se)
            new_se.pop("markLine", None)
            new_se["name"] = dp["name"]
            new_se["data"] = [{"value": dp["value"], "symbolSize": dp.get("symbolSize", 20)}]
            if i == 0 and mark is not None:
                new_se["markLine"] = mark
            out.append(new_se)
    opt["series"] = out
    if changed and not opt.get("color"):
        opt["color"] = list(PALETTE)
    return changed


def migrate(data):
    """遍历报告 sections，统计发生拆分的 chart 数。"""
    n = 0
    for s in data.get("sections", []):
        if s.get("type") != "chart-with-analysis":
            continue
        ch = s.get("chart")
        charts = ch if isinstance(ch, list) else ([ch] if ch else [])
        for c in charts:
            if isinstance(c, dict) and isinstance(c.get("option"), dict):
                if migrate_chart(c["option"]):
                    n += 1
    return n


def main(argv=None):
    ap = argparse.ArgumentParser(description="拆分单 series 多命名散点为每产品独立 series（原地回写）")
    ap.add_argument("--json", required=True)
    args = ap.parse_args(argv)
    with open(args.json, "r", encoding="utf-8") as f:
        data = json.load(f)
    n = migrate(data)
    if n:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print("已拆分 %d 个 scatter chart，回写 %s" % (n, args.json))
    else:
        print("未发现需拆分的 scatter chart，文件未改动")
    return 0


if __name__ == "__main__":
    sys.exit(main())
