#!/usr/bin/env python3
"""Build the region MoM growth HTML report.

[DEPRECATED 2026-08] 已废弃 — 统一改用 skills/report-generator/scripts/build.py。此脚本留存仅作历史参考，内含硬编码数据/路径，勿在新报告使用。
"""

import json

# ── Read template ──
with open("skills/report-generator/templates/report-shell.html", "r", encoding="utf-8") as f:
    template = f.read()

# ── Read echarts.min.js ──
with open("skills/report-generator/templates/echarts.min.js", "r", encoding="utf-8") as f:
    echarts_js = f.read()

# ── Region data from DWS query (2026-06 vs 2026-05, 瓷砖事业部) ──
regions = [
    {"name": "黑龙江", "may": 605900, "jun": 3691384, "change": 3085483, "pct": 509.2},
    {"name": "越南",   "may": 58868,  "jun": 237314,  "change": 178446,  "pct": 303.1},
    {"name": "西藏",   "may": 96207,  "jun": 158325,  "change": 62118,   "pct": 64.6},
    {"name": "安徽",   "may": 19047184, "jun": 28707996, "change": 9660812, "pct": 50.7},
    {"name": "内蒙古", "may": 4882766, "jun": 7348652, "change": 2465885, "pct": 50.5},
    {"name": "江西",   "may": 15111519, "jun": 22511373, "change": 7399854, "pct": 49.0},
    {"name": "福建",   "may": 13092754, "jun": 18325415, "change": 5232661, "pct": 40.0},
    {"name": "吉林",   "may": 1454995, "jun": 2034774, "change": 579779,  "pct": 39.8},
    {"name": "江苏",   "may": 31826346, "jun": 43367265, "change": 11540918, "pct": 36.3},
    {"name": "天津",   "may": 6774703, "jun": 9211593, "change": 2436890, "pct": 36.0},
    {"name": "贵州",   "may": 9752244, "jun": 12701713, "change": 2949470, "pct": 30.2},
    {"name": "广东",   "may": 83418867, "jun": 108543618, "change": 25124751, "pct": 30.1},
    {"name": "广西",   "may": 12686263, "jun": 16402862, "change": 3716600, "pct": 29.3},
    {"name": "浙江",   "may": 26327132, "jun": 32999115, "change": 6671983, "pct": 25.3},
    {"name": "河北",   "may": 24441943, "jun": 29762821, "change": 5320878, "pct": 21.8},
    {"name": "湖南",   "may": 26162545, "jun": 31545999, "change": 5383455, "pct": 20.6},
    {"name": "云南",   "may": 7366227, "jun": 8804220, "change": 1437993, "pct": 19.5},
    {"name": "山西",   "may": 10274159, "jun": 12216414, "change": 1942255, "pct": 18.9},
    {"name": "海南",   "may": 3614957, "jun": 4267478, "change": 652521,  "pct": 18.1},
    {"name": "湖北",   "may": 18820803, "jun": 21931011, "change": 3110208, "pct": 16.5},
    {"name": "上海",   "may": 21376792, "jun": 24788355, "change": 3411562, "pct": 16.0},
    {"name": "重庆",   "may": 11196544, "jun": 12802946, "change": 1606402, "pct": 14.3},
    {"name": "陕西",   "may": 24131712, "jun": 27119525, "change": 2987813, "pct": 12.4},
    {"name": "河南",   "may": 21687600, "jun": 23025429, "change": 1337829, "pct": 6.2},
    {"name": "宁夏",   "may": 1840851, "jun": 1914727, "change": 73876,   "pct": 4.0},
    {"name": "山东",   "may": 24939280, "jun": 25494431, "change": 555151,  "pct": 2.2},
    {"name": "北京",   "may": 24068174, "jun": 23844323, "change": -223852, "pct": -0.9},
    {"name": "四川",   "may": 23691377, "jun": 21390814, "change": -2300564, "pct": -9.7},
    {"name": "辽宁",   "may": 14009179, "jun": 11305098, "change": -2704081, "pct": -19.3},
    {"name": "甘肃",   "may": 7680811, "jun": 5971931, "change": -1708880, "pct": -22.2},
]

# Sort by growth rate descending
regions_by_pct = sorted(regions, key=lambda r: r["pct"], reverse=True)
# Sort by absolute change descending
regions_by_change = sorted(regions, key=lambda r: r["change"], reverse=True)

may_total = sum(r["may"] for r in regions)
jun_total = sum(r["jun"] for r in regions)
total_change = jun_total - may_total
total_pct = total_change / may_total * 100
growing = sum(1 for r in regions if r["change"] > 0)
declining = sum(1 for r in regions if r["change"] < 0)

# ── Build REPORT_JSON ──
report_json = {
    "title": "区域月环比增长分析报告",
    "subtitle": f"瓷砖事业部 | 2026-06 vs 2026-05 | 生成: 2026-07-04",
    "kpis": [
        {"label": "6月达成额", "value": f"{jun_total/1e8:.2f}亿", "change": f"环比 +{total_pct:.1f}%", "direction": "up"},
        {"label": "5月达成额", "value": f"{may_total/1e8:.2f}亿", "change": "基准月", "direction": "neutral"},
        {"label": "增长区域", "value": f"{growing}/{len(regions)}", "change": f"占比 {growing/len(regions)*100:.0f}%", "direction": "up"},
        {"label": "最大增量", "value": f"广东 +{25124751/1e4:.0f}万", "change": "+30.1%", "direction": "up"},
    ],
    "insight": (
        f"6月瓷砖事业部达成额{jun_total/1e8:.2f}亿，环比增长{total_pct:.1f}%（+{total_change/1e4:.0f}万）。"
        f"30个区域中{growing}个实现正增长，{declining}个下降。"
        f"安徽（+50.7%, +967万）、内蒙古（+50.5%, +247万）、江西（+49.0%, +740万）领跑增长率榜单。"
        f"广东以+2,512万绝对增量居首。"
        f"⚠️ 黑龙江（+509%）、越南（+303%）因5月基数不足100万，增长率失真，不具备业务参考意义。"
    ),
    "sections": [
        {
            "id": "growth-rank",
            "tab": "增长率排名",
            "type": "chart-with-analysis",
            "chart": {
                "id": "chart-growth-rank",
                "title": "区域月环比增长率排名（2026-06 vs 2026-05）",
                "option": {
                    "tooltip": {
                        "trigger": "axis",
                        "axisPointer": {"type": "shadow"},
                        "formatter": "function(params){var v=params[0].value;return params[0].name+': '+(v>=0?'+':'')+v.toFixed(1)+'%';}"
                    },
                    "grid": {"left": "3%", "right": "10%", "bottom": "5%", "top": "3%", "containLabel": True},
                    "xAxis": {
                        "type": "value",
                        "name": "环比增长率(%)",
                        "axisLabel": {"formatter": "function(v){return v.toFixed(0)+'%';}"}
                    },
                    "yAxis": {
                        "type": "category",
                        "data": [r["name"] for r in reversed(regions_by_pct)],
                        "axisLabel": {"fontSize": 11},
                        "inverse": False
                    },
                    "series": [{
                        "name": "环比增长率",
                        "type": "bar",
                        "data": [r["pct"] for r in reversed(regions_by_pct)],
                        "itemStyle": {
                            "borderRadius": [0, 4, 4, 0],
                            "color": "function(params){return params.value>=0?'#2563EB':'#DC2626';}"
                        },
                        "label": {
                            "show": True,
                            "position": "right",
                            "fontSize": 10,
                            "formatter": "function(p){return (p.value>=0?'+':'')+p.value.toFixed(1)+'%';}"
                        }
                    }]
                },
                "tall": True
            },
            "analysis": [
                {
                    "label": "增长格局",
                    "color": "blue",
                    "text": "26个区域实现环比正增长，整体增长率中位数约+19.1%。安徽（+50.7%, +967万）、内蒙古（+50.5%）、江西（+49.0%）在千万级以上基数中增速最快，增长质量高，值得关注增长驱动因素。"
                },
                {
                    "label": "风险提示",
                    "color": "pink",
                    "text": "黑龙江（+509%）和越南（+303%）增长率排名前2，但5月基数均不足100万（分别为60.6万和5.9万），微小绝对增量即可放大为高百分比，不具备业务参考意义。此外甘肃（-22.2%）、辽宁（-19.3%）、四川（-9.7%）为仅有的4个下降区域中降幅最大的，需关注原因。"
                }
            ]
        },
        {
            "id": "change-rank",
            "tab": "增量对比",
            "type": "chart-with-analysis",
            "chart": {
                "id": "chart-change-rank",
                "title": "区域月环比绝对增量排名（2026-06 vs 2026-05）",
                "option": {
                    "tooltip": {
                        "trigger": "axis",
                        "axisPointer": {"type": "shadow"},
                        "formatter": "function(params){var v=params[0].value/10000;return params[0].name+': '+(v>=0?'+':'')+v.toFixed(0)+'万';}"
                    },
                    "grid": {"left": "3%", "right": "10%", "bottom": "5%", "top": "3%", "containLabel": True},
                    "xAxis": {
                        "type": "value",
                        "name": "环比增量（元）",
                        "axisLabel": {"formatter": "function(v){return (v/10000).toFixed(0)+'万';}"}
                    },
                    "yAxis": {
                        "type": "category",
                        "data": [r["name"] for r in reversed(regions_by_change)],
                        "axisLabel": {"fontSize": 11},
                        "inverse": False
                    },
                    "series": [{
                        "name": "环比增量",
                        "type": "bar",
                        "data": [r["change"] for r in reversed(regions_by_change)],
                        "itemStyle": {
                            "borderRadius": [0, 4, 4, 0],
                            "color": "function(params){return params.value>=0?'#2563EB':'#DC2626';}"
                        },
                        "label": {
                            "show": True,
                            "position": "right",
                            "fontSize": 10,
                            "formatter": "function(p){return (p.value/10000).toFixed(0)+'万';}"
                        }
                    }]
                },
                "tall": True
            },
            "analysis": [
                {
                    "label": "增量集中度",
                    "color": "blue",
                    "text": "广东（+2,512万）、江苏（+1,154万）、安徽（+967万）三大区域贡献了总增量9,889万的46.9%。广东单省增量占整体增量的25.4%，是6月增长的核心引擎。前十区域合计贡献增量的82%。"
                },
                {
                    "label": "异常观察",
                    "color": "cyan",
                    "text": "四川（-230万）、辽宁（-270万）、甘肃（-171万）出现绝对下降，合计减少671万，拖累整体增长率约1.3个百分点。建议结合渠道与产品维度下钻分析下降原因。北京基本持平（-22万, -0.9%）。"
                }
            ]
        },
        {
            "id": "detail-data",
            "tab": "明细数据",
            "type": "table",
            "columns": ["排名", "区域", "5月达成额(元)", "6月达成额(元)", "环比增量(元)", "环比增长率"],
            "rows": [
                [str(i+1)] + [
                    r["name"],
                    f"{r['may']:,.2f}",
                    f"{r['jun']:,.2f}",
                    f"{r['change']:+,.2f}",
                    f"{r['pct']:+.1f}%"
                ]
                for i, r in enumerate(regions_by_pct)
            ],
            "pageSize": 20
        }
    ],
    "provenance": {
        "source": "DWS 数据仓库 → DM 层 → dm_fin_operations_mix_sum_t（经营混合汇总表）",
        "lastUpdate": "2026-07（6月数据已入库）",
        "skillVersion": "sales-performance-analyst / sales-performance-knowledge / report-generator",
        "table": "dm.dm_fin_operations_mix_sum_t",
        "query": (
            "WITH monthly AS (\n"
            "  SELECT calmonth,\n"
            "         region_province_name,\n"
            "         SUM(ambperformance) as total\n"
            "  FROM dm.dm_fin_operations_mix_sum_t\n"
            "  WHERE calmonth IN ('2026-05', '2026-06')\n"
            "    AND node_desc2 = '瓷砖事业部'\n"
            "    AND data_source IN ('S', 'T', 'D', '')\n"
            "    AND region_province_name IS NOT NULL\n"
            "  GROUP BY calmonth, region_province_name\n"
            ")\n"
            "SELECT cur.region_province_name,\n"
            "       ROUND(prev.total::numeric, 0) as may_amt,\n"
            "       ROUND(cur.total::numeric, 0) as jun_amt,\n"
            "       ROUND((cur.total - prev.total)::numeric, 0) as change_amt,\n"
            "       ROUND((cur.total - prev.total) / NULLIF(prev.total, 0) * 100, 1) as mom_growth_pct\n"
            "FROM monthly cur\n"
            "JOIN monthly prev ON cur.region_province_name = prev.region_province_name\n"
            "  AND prev.calmonth = '2026-05'\n"
            "WHERE cur.calmonth = '2026-06'\n"
            "ORDER BY mom_growth_pct DESC;"
        ),
        "filters": [
            "node_desc2 = '瓷砖事业部'",
            "data_source IN ('S', 'T', 'D', '')",
            "calmonth IN ('2026-05', '2026-06')",
            "region_province_name IS NOT NULL"
        ],
        "limitations": [
            "前3名（黑龙江、越南、西藏）5月基数<100万，增长率失真",
            "区域维度仅含省份粒度，无法下钻至城市/经销商",
            "仅含税达成额口径，不含税净额可能呈现不同趋势",
            "未区分渠道与产品维度，区域增长可能由单一渠道/客户驱动"
        ],
        "dataQuality": [
            "6月数据已入库（219,130行），时效正常",
            "30个区域均有数据，无缺失值",
            "黑龙江5月60.6万→6月369.1万，6倍增长需人工复核"
        ]
    }
}

# ── Assemble HTML ──
report_meta = f"<span>📅 数据期间: 2026-05 ~ 2026-06</span><span class=\"sep\"></span><span>🕐 生成时间: 2026-07-04</span><span class=\"sep\"></span><span>🏷️ 瓷砖事业部</span>"

html = template.replace("{{REPORT_TITLE}}", "区域月环比增长分析报告")
html = html.replace("{{REPORT_META}}", report_meta)
html = html.replace("{{ECHARTS_LIB}}", f"<script>\n{echarts_js}\n</script>")
html = html.replace("{{REPORT_JSON}}", json.dumps(report_json, ensure_ascii=False, indent=2))

# ── Write output ──
output_path = "report_sales-performance_20260704.html"
with open(output_path, "w", encoding="utf-8") as f:
    f.write(html)

import os
size_mb = os.path.getsize(output_path) / (1024 * 1024)
print(f"✅ Report written: {output_path} ({size_mb:.1f} MB)")
print(f"   KPIs: {len(report_json['kpis'])} | Sections: {len(report_json['sections'])} | Regions: {len(regions)}")
