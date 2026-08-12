#!/usr/bin/env python3
"""Build sales-performance HTML report for June 2026 budget deviation analysis."""

import json
import os
from datetime import datetime

PROJ_DIR = "/home/dp-user/dataprojv2"
REPORT_DIR = os.path.join(PROJ_DIR, "reports")
TEMPLATE_DIR = os.path.join(PROJ_DIR, "skills", "report-generator", "templates")

# ── Read template shell ──
with open(os.path.join(TEMPLATE_DIR, "report-shell.html"), "r", encoding="utf-8") as f:
    template = f.read()

# ── Read echarts.min.js ──
with open(os.path.join(TEMPLATE_DIR, "echarts.min.js"), "r", encoding="utf-8") as f:
    echarts_js = f.read()

# ── Build REPORT_JSON ──
# We use specially marked strings for JS functions; the frontend reviveFunctions() will eval them.
# Format: function strings start with "function(" exactly.

def ff(s):
    """Mark a string as a JS function expression for reviveFunctions."""
    return s  # The shell's reviveFunctions checks /^\s*function\s*\(/

# ── KPI cards ──
kpis = [
    {"label": "本月总达成额（4 BU）", "value": "6.98亿", "change": "vs 预算 8.74亿", "direction": "neutral"},
    {"label": "预算完成率", "value": "79.3%", "change": "落后预算 20.7pp", "direction": "down"},
    {"label": "最大偏差事业部", "value": "国际营销中心", "change": "偏差率 -31.3%", "direction": "down"},
    {"label": "YTD累计达成额", "value": "27.68亿", "change": "vs 预算 34.15亿 (-18.9%)", "direction": "down"},
]

# ── Insight banner ──
insight = (
    "2026年6月，四大事业部合计达成6.98亿元，预算完成率仅79.3%，单月缺口约1.76亿。"
    "瓷砖事业部（贡献86.6%）达成6.04亿，预算偏差-20.3%，YTD累计偏差-21.5%，若趋势延续全年缺口或接近10亿。"
    "国际营销中心6月骤降至-31.3%，但YTD仍超预算+1.4%——单月异常需关注是否为订单延迟或季节性波动。"
    "丽适岩板是唯一接近达标的事业部（完成率98.4%，偏差仅-1.6%）。"
    "所有事业部的不含税偏差均大于达成额偏差，提示实际返点/折扣力度超出预算假设。"
)

# ── Tab 1: 营收概览 ── grouped bar chart (actual vs budget per BU) ──
BUS = ["瓷砖事业部", "卫浴事业部", "国际营销中心", "丽适岩板"]
ACTUAL = [604092421.50, 80836718.80, 12468369.76, 2076914.72]
BUDGET = [758351000.13, 92353500.00, 18155075.08, 2111200.00]
COMP_RATE = [79.66, 87.53, 68.68, 98.38]  # budget completion rate %
DEVIATION = [-20.34, -12.47, -31.32, -1.62]

tab1_chart = {
    "id": "chart-overview",
    "title": "各事业部 实际达成额 vs 预算达成额",
    "option": {
        "tooltip": {
            "trigger": "axis",
            "axisPointer": {"type": "shadow"},
            "formatter": ff("function(params) { var r = params[0].name + '<br/>'; params.forEach(function(p) { r += p.marker + ' ' + p.seriesName + ': ' + (p.value/100000000).toFixed(2) + '亿<br/>'; }); return r; }")
        },
        "legend": {"data": ["实际达成额", "预算达成额"], "top": 0},
        "xAxis": {
            "type": "category",
            "data": BUS,
            "axisLabel": {"rotate": 0, "fontSize": 12}
        },
        "yAxis": {
            "type": "value",
            "name": "金额（元）",
            "axisLabel": {"formatter": ff("function(v) { return (v/100000000).toFixed(1) + '亿'; }")}
        },
        "series": [
            {
                "name": "实际达成额",
                "type": "bar",
                "data": ACTUAL,
                "itemStyle": {"borderRadius": [6, 6, 0, 0], "color": "#2563EB"},
                "label": {"show": True, "position": "top", "fontSize": 11, "formatter": ff("function(p) { return (p.value/100000000).toFixed(2) + '亿'; }")}
            },
            {
                "name": "预算达成额",
                "type": "bar",
                "data": BUDGET,
                "itemStyle": {"borderRadius": [6, 6, 0, 0], "color": "#9CA3AF"},
                "label": {"show": True, "position": "top", "fontSize": 11, "formatter": ff("function(p) { return (p.value/100000000).toFixed(2) + '亿'; }")}
            }
        ],
        "grid": {"left": "3%", "right": "12%", "bottom": "10%", "top": "15%", "containLabel": True}
    }
}

# ── Tab 2: 预算偏差分析 ── horizontal bar of deviation rates by indicator ──
# Per BU, compute deviation on key metrics and show across all
DEVIATION_METRICS = ["达成额偏差", "不含税偏差", "面积偏差", "成本偏差"]
# Sorted by worst deviation across all BUs
DEV_BARS = [
    {"metric": "国际·不含税", "value": -31.48, "bu": "国际营销中心"},
    {"metric": "国际·达成额", "value": -31.32, "bu": "国际营销中心"},
    {"metric": "国际·面积",   "value": -28.97, "bu": "国际营销中心"},
    {"metric": "国际·成本",   "value": -26.26, "bu": "国际营销中心"},
    {"metric": "瓷砖·不含税", "value": -21.25, "bu": "瓷砖事业部"},
    {"metric": "瓷砖·面积",   "value": -20.72, "bu": "瓷砖事业部"},
    {"metric": "瓷砖·达成额", "value": -20.34, "bu": "瓷砖事业部"},
    {"metric": "瓷砖·成本",   "value": -16.26, "bu": "瓷砖事业部"},
    {"metric": "卫浴·不含税", "value": -14.92, "bu": "卫浴事业部"},
    {"metric": "卫浴·达成额", "value": -12.47, "bu": "卫浴事业部"},
    {"metric": "丽适·成本",   "value": -9.82,  "bu": "丽适岩板"},
    {"metric": "卫浴·成本",   "value": -8.60,  "bu": "卫浴事业部"},
    {"metric": "丽适·面积",   "value": -5.50,  "bu": "丽适岩板"},
    {"metric": "丽适·不含税", "value": -1.72,  "bu": "丽适岩板"},
    {"metric": "丽适·达成额", "value": -1.62,  "bu": "丽适岩板"},
]

# Color by BU
def bar_color(item):
    bu = item["bu"]
    if bu == "国际营销中心": return "#EF4444"
    if bu == "瓷砖事业部": return "#F59E0B"
    if bu == "卫浴事业部": return "#3B82F6"
    return "#10B981"

tab2_chart = {
    "id": "chart-deviation",
    "title": "预算偏差率排名（实际 vs 预算，按偏差从大到小）",
    "tall": True,
    "option": {
        "tooltip": {
            "trigger": "axis",
            "axisPointer": {"type": "shadow"},
            "formatter": ff("function(p) { return p[0].name + '<br/>预算偏差率: ' + p[0].value.toFixed(1) + '%'; }")
        },
        "grid": {"left": "3%", "right": "8%", "bottom": "3%", "top": "5%", "containLabel": True},
        "xAxis": {
            "type": "value",
            "name": "偏差率 (%)",
            "axisLabel": {"formatter": ff("function(v) { return v.toFixed(0) + '%'; }")}
        },
        "yAxis": {
            "type": "category",
            "data": [d["metric"] for d in DEV_BARS],
            "inverse": True,
            "axisLabel": {"fontSize": 12}
        },
        "series": [{
            "name": "预算偏差率",
            "type": "bar",
            "data": [d["value"] for d in DEV_BARS],
            "itemStyle": {
                "borderRadius": [0, 4, 4, 0],
                "color": ff("function(p) { var colors = " + json.dumps([bar_color(d) for d in DEV_BARS]) + "; return colors[p.dataIndex]; }")
            },
            "label": {
                "show": True,
                "position": "right",
                "fontSize": 11,
                "formatter": ff("function(p) { return p.value.toFixed(1) + '%'; }")
            }
        }]
    }
}

# Tab 2 also includes a per-BU breakdown table as a second chart
# Build the per-BU detail data as a second chart in the same tab (charts array)
TAB2_DETAIL_COLS = ["事业部", "实际达成额", "预算达成额", "达成额偏差率", "实际不含税", "预算不含税", "不含税偏差率",
                     "实际面积", "预算面积", "面积偏差率", "实际成本", "预算成本", "成本偏差率", "实际毛利", "预算毛利"]

TAB2_DETAIL_ROWS = [
    ["瓷砖事业部", "6.04亿", "7.58亿", "-20.34%", "5.27亿", "6.70亿", "-21.25%",
     "1,583.45万㎡", "1,997.21万㎡", "-20.72%", "3.83亿", "4.57亿", "-16.26%", "1.61亿", "2.13亿"],
    ["卫浴事业部", "0.81亿", "0.92亿", "-12.47%", "0.70亿", "0.83亿", "-14.92%",
     "2.13万㎡", "—", "—", "0.59亿", "0.65亿", "-8.60%", "0.12亿", "0.18亿"],
    ["国际营销中心", "0.12亿", "0.18亿", "-31.32%", "0.11亿", "0.16亿", "-31.48%",
     "16.89万㎡", "23.78万㎡", "-28.97%", "0.09亿", "0.12亿", "-26.26%", "0.01亿", "0.04亿"],
    ["丽适岩板", "0.02亿", "0.02亿", "-1.62%", "0.02亿", "0.02亿", "-1.72%",
     "1.27万㎡", "1.34万㎡", "-5.50%", "0.01亿", "0.01亿", "-9.82%", "0.005亿", "0.006亿"],
]

# ── Tab 3: 月度趋势（瓷砖事业部）── line chart Jan-Jun ──
MONTHS = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"]
MONTH_ACTUAL = [235326400, 45844100, 427430900, 472816400, 505206300, 604092421.50]
MONTH_BUDGET = [219198800, 93583100, 577477100, 596425500, 673771500, 758351000.13]
MONTH_DEV = [7.36, -51.01, -25.98, -20.72, -25.02, -20.34]

tab3_chart = {
    "id": "chart-trend",
    "title": "瓷砖事业部 月度达成额趋势（2026年1-6月）",
    "option": {
        "tooltip": {
            "trigger": "axis",
            "formatter": ff("function(params) { var r = params[0].name + '<br/>'; params.forEach(function(p) { r += p.marker + ' ' + p.seriesName + ': ' + (p.value/100000000).toFixed(2) + '亿<br/>'; }); return r; }")
        },
        "legend": {"data": ["实际达成额", "预算达成额"], "top": 0},
        "xAxis": {
            "type": "category",
            "data": ["1月", "2月", "3月", "4月", "5月", "6月"],
            "boundaryGap": False
        },
        "yAxis": {
            "type": "value",
            "name": "金额（元）",
            "axisLabel": {"formatter": ff("function(v) { return (v/100000000).toFixed(1) + '亿'; }")}
        },
        "series": [
            {
                "name": "实际达成额",
                "type": "line",
                "data": MONTH_ACTUAL,
                "smooth": True,
                "symbol": "circle",
                "symbolSize": 8,
                "lineStyle": {"width": 3, "color": "#2563EB"},
                "itemStyle": {"color": "#2563EB"},
                "markLine": {
                    "silent": True,
                    "symbol": "none",
                    "lineStyle": {"type": "dashed", "color": "#2563EB", "width": 1},
                    "label": {"formatter": ff("function(p) { return '均值: ' + (p.value/100000000).toFixed(2) + '亿'; }")},
                    "data": [{"type": "average", "name": "均值"}]
                }
            },
            {
                "name": "预算达成额",
                "type": "line",
                "data": MONTH_BUDGET,
                "smooth": True,
                "symbol": "diamond",
                "symbolSize": 8,
                "lineStyle": {"width": 2, "color": "#9CA3AF", "type": "dashed"},
                "itemStyle": {"color": "#9CA3AF"}
            }
        ],
        "grid": {"left": "3%", "right": "8%", "bottom": "10%", "top": "15%", "containLabel": True}
    }
}

# ── YTD summary for Tab 3 second chart ──
YTD_BUS = ["瓷砖事业部", "卫浴事业部", "国际营销中心", "丽适岩板"]
YTD_ACTUAL = [2290716547.49, 355780130.82, 82614123.32, 7734776.50]
YTD_BUDGET = [2918807000.51, 406521600.00, 81463605.17, 10284400.00]
YTD_DEV = [-21.52, -12.48, 1.41, -24.79]

tab3_chart2 = {
    "id": "chart-ytd",
    "title": "各事业部 YTD 达成额（2026年1-6月累计）",
    "option": {
        "tooltip": {
            "trigger": "axis",
            "axisPointer": {"type": "shadow"},
            "formatter": ff("function(params) { var r = params[0].name + '<br/>'; params.forEach(function(p) { r += p.marker + ' ' + p.seriesName + ': ' + (p.value/100000000).toFixed(2) + '亿<br/>'; }); return r; }")
        },
        "legend": {"data": ["YTD实际", "YTD预算"], "top": 0},
        "xAxis": {
            "type": "category",
            "data": YTD_BUS
        },
        "yAxis": {
            "type": "value",
            "name": "金额（元）",
            "axisLabel": {"formatter": ff("function(v) { return (v/100000000).toFixed(1) + '亿'; }")}
        },
        "series": [
            {
                "name": "YTD实际",
                "type": "bar",
                "data": YTD_ACTUAL,
                "itemStyle": {"borderRadius": [6, 6, 0, 0], "color": "#2563EB"},
                "label": {"show": True, "position": "top", "fontSize": 10, "formatter": ff("function(p) { return (p.value/100000000).toFixed(2) + '亿'; }")}
            },
            {
                "name": "YTD预算",
                "type": "bar",
                "data": YTD_BUDGET,
                "itemStyle": {"borderRadius": [6, 6, 0, 0], "color": "#9CA3AF"},
                "label": {"show": True, "position": "top", "fontSize": 10, "formatter": ff("function(p) { return (p.value/100000000).toFixed(2) + '亿'; }")}
            }
        ],
        "grid": {"left": "3%", "right": "12%", "bottom": "10%", "top": "15%", "containLabel": True}
    }
}

# ── Tab 4: 明细数据 ──
TAB4_COLS = [
    "事业部", "实际达成额(万元)", "预算达成额(万元)", "达成额偏差率",
    "不含税净额(万元)", "预算不含税(万元)", "不含税偏差率",
    "销售面积(㎡)", "预算面积(㎡)", "面积偏差率",
    "实际成本(万元)", "预算成本(万元)", "成本偏差率",
    "毛利(万元)", "预算毛利(万元)"
]

TAB4_ROWS = [
    ["瓷砖事业部", "60,409.24", "75,835.10", "-20.34%",
     "52,734.72", "66,961.33", "-21.25%",
     "15,834,523.40", "19,972,078.67", "-20.72%",
     "38,272.44", "45,703.70", "-16.26%",
     "16,054.47", "21,257.63"],
    ["卫浴事业部", "8,083.67", "9,235.35", "-12.47%",
     "7,036.59", "8,270.52", "-14.92%",
     "21,315.61", "—", "—",
     "5,906.87", "6,462.82", "-8.60%",
     "1,164.46", "1,807.70"],
    ["国际营销中心", "1,246.84", "1,815.51", "-31.32%",
     "1,091.96", "1,593.58", "-31.48%",
     "168,871.24", "237,759.46", "-28.97%",
     "869.37", "1,179.02", "-26.26%",
     "143.88", "414.57"],
    ["丽适岩板", "207.69", "211.12", "-1.62%",
     "180.12", "183.28", "-1.72%",
     "12,656.75", "13,393.99", "-5.50%",
     "114.22", "126.65", "-9.82%",
     "48.88", "56.63"],
]

# ── Assemble REPORT_JSON ──
report_json = {
    "title": "2026年6月 各事业部营收完成率 & 预算偏差分析",
    "subtitle": "数据期间: 2026-06 | 生成时间: " + datetime.now().strftime("%Y-%m-%d %H:%M"),
    "kpis": kpis,
    "insight": insight,
    "sections": [
        {
            "id": "overview",
            "tab": "📊 营收概览",
            "type": "chart-with-analysis",
            "chart": tab1_chart,
            "analysis": [
                {
                    "label": "核心发现",
                    "color": "blue",
                    "text": "四大事业部合计达成6.98亿，整体预算完成率79.3%。瓷砖事业部以6.04亿占总额86.6%，是绝对主力，但其完成率仅79.7%，单月缺口1.54亿。丽适岩板以98.4%完成率成为唯一接近达标的事业部。"
                },
                {
                    "label": "风险提示",
                    "color": "pink",
                    "text": "国际营销中心预算完成率仅68.7%（偏差-31.3%），且YTD从超预算骤转为6月暴跌，需紧急排查是否为出口订单延迟、汇率影响或数据异常。卫浴及岩板体量小，对整体影响有限，但卫浴12.5%的偏差也不容忽视。"
                }
            ]
        },
        {
            "id": "deviation",
            "tab": "🔍 预算偏差",
            "type": "chart-with-analysis",
            "chart": tab2_chart,
            "analysis": [
                {
                    "label": "偏差归因",
                    "color": "cyan",
                    "text": "Top 4最大偏差均来自国际营销中心，覆盖达成额、不含税、面积、成本四项指标，呈全维度崩塌态势。瓷砖事业部的四项指标偏差集中在-16%~-21%区间，不含税偏差（-21.3%）一致地大于达成额偏差（-20.3%），表明实际返点/税负超出预算假设。"
                },
                {
                    "label": "数据观察",
                    "color": "pink",
                    "text": "卫浴事业部预算面积数据缺失（NULL），导致面积偏差无法计算。所有事业部返点预算均为0或NULL，但实际返点均为负支出（瓷砖-737万、卫浴-86万、国际-28万），这部分未预算成本直接拉低了毛利表现。"
                }
            ]
        },
        {
            "id": "trend",
            "tab": "📈 月度趋势",
            "type": "chart-with-analysis",
            "chart": [tab3_chart, tab3_chart2],
            "analysis": [
                {
                    "label": "趋势判断",
                    "color": "blue",
                    "text": "瓷砖事业部1月超预算7.4%开局良好，2月受春节影响暴跌至-51.0%。3-6月偏差稳定在-20%~-26%区间，未见收敛迹象。6月绝对值虽升至6.04亿（全年最高），但预算也同步走高，完成率并未改善。YTD累计偏差-21.5%，若下半年不调整预算或加大促销，全年缺口预估将达8-10亿。"
                },
                {
                    "label": "异常关注",
                    "color": "pink",
                    "text": "国际营销中心YTD累计偏差+1.4%（超预算），但6月单月暴跌至-31.3%——这种月间剧烈反转极不寻常。可能原因：大额订单集中在前期交付、6月出口政策变化、或数据入库延迟。建议业务部门立即核实6月国际业务实际出货情况。丽适岩板YTD偏差-24.8%远超单月的-1.6%，提示前期月份存在较大缺口。"
                }
            ]
        },
        {
            "id": "data",
            "tab": "📋 明细数据",
            "type": "table",
            "table": {
                "title": "2026年6月 各事业部预算偏差明细表",
                "columns": TAB4_COLS,
                "rows": TAB4_ROWS,
                "pageSize": 20
            }
        }
    ],
    "provenance": {
        "source": "DWS数据仓库 — 销售业绩领域",
        "lastUpdate": "2026-07-08 01:31 UTC (dm_fin_operations_mix_sum_t)",
        "skillVersion": "sales-performance-analyst / sales-performance-knowledge / report-generator",
        "table": "dm.dm_fin_operations_mix_sum_t",
        "query": """-- 本月各事业部营收 & 预算偏差（核心查询）
SELECT
    node_desc2 AS 事业部,
    SUM(ambperformance) AS 实际达成额,
    SUM(ambperformance_ys) AS 预算达成额,
    ROUND((SUM(ambperformance)/NULLIF(SUM(ambperformance_ys),0)-1)*100,2) AS 达成额偏差率,
    SUM(notax_sales_net_amt) AS 实际不含税,
    SUM(notax_sales_net_amt_ys) AS 预算不含税,
    ROUND((SUM(notax_sales_net_amt)/NULLIF(SUM(notax_sales_net_amt_ys),0)-1)*100,2) AS 不含税偏差率,
    SUM(zxsmj) AS 实际面积,
    SUM(s_zxsmj_ys) AS 预算面积,
    ROUND((SUM(zxsmj)/NULLIF(SUM(s_zxsmj_ys),0)-1)*100,2) AS 面积偏差率,
    SUM(act_cost_sum_amt) AS 实际成本,
    SUM(act_cost_sum_amt_ys) AS 预算成本,
    ROUND((SUM(act_cost_sum_amt)/NULLIF(SUM(act_cost_sum_amt_ys),0)-1)*100,2) AS 成本偏差率,
    SUM(gross_profit_after_sharing) AS 实际毛利,
    SUM(zfdje) AS 实际返点,
    SUM(zfdje_ys) AS 预算返点
FROM dm.dm_fin_operations_mix_sum_t
WHERE calmonth = '2026-06'
  AND node_desc2 IN ('瓷砖事业部','卫浴事业部','国际营销中心','丽适岩板')
  AND data_source IN ('S','T','D','')
GROUP BY node_desc2
ORDER BY 实际达成额 DESC;

-- 瓷砖事业部月度趋势
SELECT calmonth,
       SUM(ambperformance)/10000 AS 实际_万元,
       SUM(ambperformance_ys)/10000 AS 预算_万元
FROM dm.dm_fin_operations_mix_sum_t
WHERE calmonth BETWEEN '2026-01' AND '2026-06'
  AND node_desc2 = '瓷砖事业部'
  AND data_source IN ('S','T','D','')
GROUP BY calmonth ORDER BY calmonth;""",
        "filters": [
            "时间: calmonth = '2026-06'",
            "组织: node_desc2 IN (瓷砖/卫浴/国际/丽适)",
            "数据源: data_source IN ('S','T','D','')",
            "排除备份表 (_bak/_tmp/_wjh_ 后缀)"
        ],
        "limitations": [
            "目标表(dm_dp_api_sales_target)仅覆盖瓷砖事业部11个运营中心，卫浴/国际/岩板无目标数据",
            "卫浴事业部预算面积(s_zxsmj_ys)为NULL，无法计算面积偏差率",
            "所有事业部预算返点(zfdje_ys)为0或NULL，返点偏差率无法计算",
            "国际营销中心6月单月骤降原因未确认，可能是订单延迟或数据问题",
            "不含税偏差系统性大于达成额偏差的口径差异需财务确认"
        ],
        "dataQuality": [
            "dm_fin_operations_mix_sum_t last_analyze=2026-07-08，数据新鲜",
            "6月数据25.3万行，6个node_desc2值，数据量正常",
            "卫浴预算面积、返点预算为NULL",
            "国际营销中心YTD(+1.4%)与6月单月(-31.3%)存在剧烈反转",
            "calmonth存在异常值'S'（非标准月份格式，已排除）"
        ]
    }
}

# ── Replace placeholders in template ──
html = template
html = html.replace("{{REPORT_TITLE}}", report_json["title"])
html = html.replace("{{REPORT_META}}", report_json["subtitle"])
html = html.replace("{{ECHARTS_LIB}}", "<script>\n" + echarts_js + "\n</script>")

# For REPORT_JSON, we need to embed the JSON but keep function strings as-is
# so that reviveFunctions can detect them with /^\s*function\s*\(/
json_str = json.dumps(report_json, ensure_ascii=False, indent=2)
# json.dumps will escape the function strings, but that's okay because
# reviveFunctions matches against the unescaped value after JSON.parse.
# JSON.parse will give us the original string "function(v) { ... }" which
# will match /^\s*function\s*\(/
html = html.replace("{{REPORT_JSON}}", json_str)

# ── Write output ──
os.makedirs(REPORT_DIR, exist_ok=True)
now = datetime.now()
filename = f"report_sales-performance_{now.strftime('%Y%m%d_%H%M%S')}.html"
filepath = os.path.join(REPORT_DIR, filename)
with open(filepath, "w", encoding="utf-8") as f:
    f.write(html)

size_kb = os.path.getsize(filepath) / 1024
print(f"✅ Report written: {filepath} ({size_kb:.0f} KB)")
print(f"FILENAME: {filename}")
