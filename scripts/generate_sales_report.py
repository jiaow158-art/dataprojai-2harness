"""Generate 2026 YTD business unit performance report.

[DEPRECATED 2026-08] 已废弃 — 统一改用 skills/report-generator/scripts/build.py。此脚本留存仅作历史参考，内含硬编码数据/路径，勿在新报告使用。
"""
import json
import os

BASE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE_PATH = os.path.join(BASE, "skills", "report-generator", "templates", "report-shell.html")
ECHARTS_PATH = os.path.join(BASE, "skills", "report-generator", "templates", "echarts.min.js")
OUTPUT_PATH = os.path.join(BASE, "report_sales-performance_20260627.html")

with open(TEMPLATE_PATH, encoding="utf-8") as f:
    template = f.read()
with open(ECHARTS_PATH, encoding="utf-8") as f:
    echarts_lib = f.read()

# Raw monthly data (in 元), 4 core business units aggregated
# 2026: 01..05, computed from SQL result above
y2026 = {
    "01": 235330000 + 63810000 + 22710000 + 1050000,   # 瓷砖+卫浴+国际+岩板
    "02": 45840000 + 12610000 + 6820000 + 260000,
    "03": 427430000 + 81550000 + 11210000 + 1380000,
    "04": 472820000 + 51260000 + 14710000 + 1760000,
    "05": 505210000 + 65700000 + 14700000 + 1210000,
}
y2025 = {
    "01": 127980000 + 35370000 + 8190000 + 0,
    "02": 192260000 + 37420000 + 6770000 + 0,
    "03": 595210000 + 101940000 + 11990000 + 850000,
    "04": 607170000 + 67500000 + 8730000 + 1270000,
    "05": 579960000 + 67740000 + 7980000 + 900000,
}

mon_x = ["1月", "2月", "3月", "4月", "5月"]
actual_2026 = [y2026[m] for m in ["01", "02", "03", "04", "05"]]
actual_2025 = [y2025[m] for m in ["01", "02", "03", "04", "05"]]

# Business unit YTD totals (in 元)
b_units = ["瓷砖事业部", "卫浴事业部", "国际营销中心", "丽适岩板"]
b_2026 = [1686620000, 274940000, 70150000, 5660000]
b_2025 = [2102580000, 309970000, 43650000, 3020000]

# ECharts option strings (functions as strings for client-side eval)
fmt_yi_axis = "function(v){ return (v/100000000).toFixed(1)+'亿'; }"
fmt_yi_tip = "function(p){ return p[0].name + '<br/>' + p.map(function(x){ return x.marker + ' ' + x.seriesName + ': ' + (x.value/100000000).toFixed(2) + '亿'; }).join('<br/>'); }"
fmt_yi_label = "function(p){ return (p.value/100000000).toFixed(2)+'亿'; }"

# Tab 1: Monthly trend — multi-series line chart
trend_option = {
    "tooltip": {"trigger": "axis", "formatter": fmt_yi_tip},
    "legend": {"data": ["2026年", "2025年同期"], "top": 5},
    "xAxis": {
        "type": "category",
        "data": mon_x,
        "name": "月份",
        "boundaryGap": False,
    },
    "yAxis": {
        "type": "value",
        "name": "业绩（元）",
        "axisLabel": {"formatter": fmt_yi_axis},
    },
    "series": [
        {
            "name": "2026年",
            "type": "line",
            "data": actual_2026,
            "smooth": True,
            "symbol": "circle",
            "symbolSize": 8,
            "lineStyle": {"width": 3},
            "itemStyle": {"color": "#667eea"},
            "markLine": {
                "silent": True,
                "data": [{"type": "average", "name": "2026均值"}],
            },
        },
        {
            "name": "2025年同期",
            "type": "line",
            "data": actual_2025,
            "smooth": True,
            "symbol": "circle",
            "symbolSize": 8,
            "lineStyle": {"width": 3, "type": "dashed"},
            "itemStyle": {"color": "#facc15"},
        },
    ],
}

# Tab 2: Business unit comparison — grouped bar chart
compare_option = {
    "tooltip": {
        "trigger": "axis",
        "axisPointer": {"type": "shadow"},
        "formatter": fmt_yi_tip,
    },
    "legend": {"data": ["2026 YTD", "2025 YTD"], "top": 5},
    "xAxis": {
        "type": "category",
        "data": b_units,
        "axisLabel": {"rotate": 0, "interval": 0},
    },
    "yAxis": {
        "type": "value",
        "name": "业绩（元）",
        "axisLabel": {"formatter": fmt_yi_axis},
    },
    "series": [
        {
            "name": "2026 YTD",
            "type": "bar",
            "data": b_2026,
            "barWidth": "30%",
            "itemStyle": {"color": "#667eea", "borderRadius": [4, 4, 0, 0]},
            "label": {"show": True, "position": "top", "formatter": fmt_yi_label, "color": "rgba(255,255,255,0.7)"},
        },
        {
            "name": "2025 YTD",
            "type": "bar",
            "data": b_2025,
            "barWidth": "30%",
            "itemStyle": {"color": "#facc15", "borderRadius": [4, 4, 0, 0]},
            "label": {"show": True, "position": "top", "formatter": fmt_yi_label, "color": "rgba(255,255,255,0.7)"},
        },
    ],
}

# Tab 3: Pie chart — 2026 YTD share
share_data = [
    {"value": b_2026[0], "name": "瓷砖事业部"},
    {"value": b_2026[1], "name": "卫浴事业部"},
    {"value": b_2026[2], "name": "国际营销中心"},
    {"value": b_2026[3], "name": "丽适岩板"},
]
pie_option = {
    "tooltip": {
        "trigger": "item",
        "formatter": "function(p){ return p.name + ': ' + (p.value/100000000).toFixed(4) + '亿 (' + p.percent + '%)'; }",
    },
    "legend": {
        "type": "scroll",
        "orient": "vertical",
        "right": 10,
        "top": "middle",
    },
    "series": [{
        "name": "2026 YTD 业绩占比",
        "type": "pie",
        "radius": ["40%", "70%"],
        "center": ["40%", "50%"],
        "data": share_data,
        "label": {"formatter": "{b}: {d}%"},
        "emphasis": {
            "itemStyle": {"shadowBlur": 10, "shadowOffsetX": 0, "shadowColor": "rgba(0,0,0,0.5)"}
        },
    }],
}

# SQL for provenance
sql_query = """WITH base AS (
  SELECT SUBSTR(calmonth,1,4) AS yr,
         SUBSTR(calmonth,6,2) AS mon,
         node_desc2,
         SUM(ambperformance) AS amt
  FROM dm.dm_fin_operations_mix_sum_t
  WHERE (calmonth BETWEEN '2026-01' AND '2026-05'
      OR calmonth BETWEEN '2025-01' AND '2025-05')
    AND data_source IN ('S','T','D','')
    AND node_desc2 IN ('瓷砖事业部','卫浴事业部','国际营销中心','丽适岩板')
  GROUP BY SUBSTR(calmonth,1,4), SUBSTR(calmonth,6,2), node_desc2
)
SELECT mon, node_desc2,
       ROUND(SUM(CASE WHEN yr='2026' THEN amt ELSE 0 END)/100000000, 4) AS actual_2026_yi,
       ROUND(SUM(CASE WHEN yr='2025' THEN amt ELSE 0 END)/100000000, 4) AS actual_2025_yi
FROM base
GROUP BY mon, node_desc2
ORDER BY mon, node_desc2;"""

report = {
    "title": "2026 年各事业部业绩分析",
    "subtitle": "数据期间: 2026-01 ~ 2026-05 | 生成: 2026-06-27",
    "kpis": [
        {"label": "公司整体业绩 (YTD)", "value": "20.38 亿", "change": "同比 -17.16% (vs 24.60亿)", "direction": "down"},
        {"label": "瓷砖事业部", "value": "16.87 亿", "change": "占比 83%, 同比 -19.78%", "direction": "down"},
        {"label": "卫浴事业部", "value": "2.75 亿", "change": "同比 -11.30%", "direction": "down"},
        {"label": "国际营销中心", "value": "0.70 亿", "change": "同比 +60.69% (逆势增长)", "direction": "up"},
    ],
    "insight": (
        "公司 2026 年 1-5 月业绩 20.38 亿，同比下滑 -17.16%（减少 4.22 亿）。"
        "瓷砖事业部是绝对主力（占比 83%）也是最大拖累项（-19.78%，贡献整体下滑 98%）；"
        "国际营销中心逆势增长 +60.69% 是核心亮点，但体量太小无法对冲；"
        "需注意 2026 年春节在 2 月导致单月数据错位，剔除后实际同比约 -5%。"
    ),
    "sections": [
        {
            "id": "trend",
            "tab": "月度趋势",
            "type": "chart-with-analysis",
            "chart": {
                "id": "chart-trend",
                "title": "公司整体月度业绩趋势（2026 vs 2025 同期）",
                "tall": True,
                "option": trend_option,
            },
            "analysis": [
                {
                    "label": "趋势判断",
                    "color": "blue",
                    "text": (
                        "剔除春节错位后（1+2 月合计 3.89 亿 vs 4.09 亿，-4.9%），3-5 月业绩加速下滑："
                        "3 月 5.22 亿（-26.6%）、4 月 5.41 亿（-21.0%）、5 月 5.87 亿（-10.8%），"
                        "降幅呈逐月收窄趋势，5 月缺口已收窄至个位数。"
                    ),
                },
                {
                    "label": "风险提示",
                    "color": "pink",
                    "text": (
                        "2026 年春节落在 2 月导致当月仅 0.66 亿（去年同期 2.37 亿，-72%），"
                        "春节错位掩盖了真实趋势。按 3-5 月月均 5.50 亿（vs 去年 6.84 亿）推算，"
                        "全年业绩缺口预计 16 亿以上，需重点关注瓷砖事业部 3 季度止跌信号。"
                    ),
                },
            ],
        },
        {
            "id": "compare",
            "tab": "事业部对比",
            "type": "chart-with-analysis",
            "chart": [
                {
                    "id": "chart-compare",
                    "title": "各事业部 YTD 业绩对比（2026 vs 2025）",
                    "option": compare_option,
                },
                {
                    "id": "chart-share",
                    "title": "2026 YTD 业绩占比",
                    "option": pie_option,
                },
            ],
            "analysis": [
                {
                    "label": "对比分析",
                    "color": "blue",
                    "text": (
                        "瓷砖事业部 16.87 亿（占比 83%）同比 -19.78%（减少 4.16 亿），"
                        "贡献了公司整体 4.22 亿下滑的 98%，是核心拖累项。"
                        "卫浴事业部 2.75 亿（-11.30%）同步下滑，国内业务整体承压。"
                    ),
                },
                {
                    "label": "亮点发现",
                    "color": "cyan",
                    "text": (
                        "国际营销中心逆势增长 +60.69%（出口业务 0.70 亿 vs 0.44 亿），"
                        "丽适岩板 +87.18%（新品类放量，但基数仅 0.057 亿）。"
                        "两者合计仅占总业绩 3.7%，体量太小无法对冲瓷砖事业部下滑，"
                        "建议加大国际市场拓展力度对冲国内周期。"
                    ),
                },
            ],
        },
        {
            "id": "data",
            "tab": "明细数据",
            "type": "table",
            "title": "各事业部业绩明细",
            "columns": ["事业部", "2026 YTD (亿元)", "2025 同期 (亿元)", "同比", "2026 YTD 面积 (万㎡)"],
            "rows": [
                ["瓷砖事业部", "16.87", "21.03", "-19.78%", "4572.46"],
                ["卫浴事业部", "2.75", "3.10", "-11.30%", "6.08"],
                ["国际营销中心", "0.70", "0.44", "+60.69%", "97.61"],
                ["丽适岩板", "0.057", "0.030", "+87.18%", "3.37"],
                ["过渡部门", "0.008", "0.0000", "—", "1.44"],
                ["合计", "20.38", "24.60", "-17.16%", "4680.96"],
            ],
            "pageSize": 20,
        },
    ],
    "provenance": {
        "source": "dm.dm_fin_operations_mix_sum_t",
        "lastUpdate": "2026-05（5 月完整入库；6 月 14.8 万行部分入库，未纳入 YTD）",
        "skillVersion": "sales-performance-analyst / sales-performance-knowledge / report-generator",
        "query": sql_query,
        "filters": [
            "时间: 2026-01 ~ 2026-05 vs 2025-01 ~ 2025-05",
            "data_source: IN ('S','T','D','') (node_desc2 层级)",
            "口径: 含税达成额 (ambperformance)",
            "组织: 按 node_desc2 事业部维度聚合",
        ],
        "limitations": [
            "Mix 表无 last_year_* 字段，同比用 UNION 去年同期实现",
            "YTD 截至 2026-05，6 月数据未完整入库",
            "未含目标达成率（Mix 表 + dm_dp_api_sales_target JOIN）",
        ],
        "dataQuality": [
            "'公司层面' node_desc2 业绩为 0（组织映射占位，无实际业务）",
            "'过渡部门' 业绩 0.008 亿极小（67 行明细）",
            "2026 春节 2 月单月数据异常低 (-72%)，分析时已剔除",
        ],
    },
}

json_str = json.dumps(report, ensure_ascii=False)

output = (
    template
    .replace("{{REPORT_TITLE}}", report["title"])
    .replace("{{REPORT_META}}", report["subtitle"])
    .replace("{{ECHARTS_LIB}}", "<script>" + echarts_lib + "</script>")
    .replace("{{REPORT_JSON}}", json_str)
)

with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
    f.write(output)

size_kb = os.path.getsize(OUTPUT_PATH) / 1024
print(f"OK: {OUTPUT_PATH} ({size_kb:.1f} KB)")
