#!/usr/bin/env python3
"""Assemble the sales performance H1 2026 report HTML."""
import json, os

BASE = "/home/dp-user/dataprojv2"
TEMPLATES = os.path.join(BASE, "skills/report-generator/templates")
OUT = os.path.join(BASE, "reports/report_sales-performance_20260710.html")

with open(os.path.join(TEMPLATES, "report-shell.html"), "r", encoding="utf-8") as f:
    shell = f.read()
with open(os.path.join(TEMPLATES, "echarts.min.js"), "r", encoding="utf-8") as f:
    echarts_js = f.read()

report = {
    "title": "瓷砖事业部 2026年半年度经营分析报告",
    "subtitle": "数据期间: 2026-01 ~ 2026-06 | 生成: 2026-07-10 | 数据源: DWS (GaussDB)",

    "kpis": [
        {"label": "H1 达成额", "value": "21.63亿", "change": "vs 目标 27.81亿 · 缺口 6.18亿", "direction": "down"},
        {"label": "达成率", "value": "77.78%", "change": "落后时间进度 22.22pp", "direction": "down"},
        {"label": "面积同比", "value": "-13.68%", "change": "2025H1 7,132万㎡ → 6,157万㎡", "direction": "down"},
        {"label": "未交付面积", "value": "263.63万㎡", "change": "1,134单 · 462客户 · GD+JX占66%", "direction": "neutral"}
    ],

    "insight": "2026上半年瓷砖事业部达成21.63亿，达成率77.78%，落后时间进度。面积同比下降13.68%（减少976万㎡），但大规格(715)金额首超传统800规格，结构升级趋势明确。工程渠道(82.19%)是压舱石，整装渠道(72.72%)全事业部承压。粤东运营中心(71.94%)零售+整装双低，为最大风险点。未交付订单263.63万㎡约占月销量1/4，GD+JX两基地积压66%产能。",

    "sections": [
        # ===== TAB 1: 区域达成 =====
        {
            "id": "region", "tab": "区域达成", "type": "chart-with-analysis",
            "chart": {
                "id": "chart-region", "title": "各运营中心 H1 达成 vs 目标（亿元）", "tall": True,
                "option": {
                    "tooltip": {"trigger": "axis", "axisPointer": {"type": "shadow"}},
                    "legend": {"data": ["实际达成", "目标"], "top": 0},
                    "grid": {"left": "22%", "right": "8%", "top": "12%", "bottom": "8%"},
                    "xAxis": {"type": "value", "name": "金额（亿元）",
                              "axisLabel": {"formatter": "function(v){return (v/100000000).toFixed(0)+'亿';}"}},
                    "yAxis": {"type": "category",
                              "data": ["东北运营中心","赣皖运营中心","西北运营中心","湘鄂运营中心","华北运营中心",
                                       "战略工程中心","粤东运营中心","鲁豫晋运营中心","粤西运营中心","西南运营中心","华东运营中心"],
                              "axisLabel": {"fontSize": 12}},
                    "series": [
                        {"name": "实际达成", "type": "bar",
                         "data": [632017762,1545175360,1527671380,1609692012,1855199100,2028350474,2047292828,2085518956,2125721304,2505125108,3667179932],
                         "itemStyle": {"borderRadius": [0,4,4,0]},
                         "label": {"show": True, "position": "right", "fontSize": 11,
                                   "formatter": "function(p){return (p.value/100000000).toFixed(2)+'亿';}"}},
                        {"name": "目标", "type": "bar",
                         "data": [85014800,206361000,198264200,210607600,233939000,244040000,284579300,249742700,271893400,322400100,474051500],
                         "itemStyle": {"color": "#9CA3AF", "borderRadius": [0,4,4,0]},
                         "label": {"show": True, "position": "right", "fontSize": 11,
                                   "formatter": "function(p){return (p.value/100000000).toFixed(2)+'亿';}"}}
                    ]
                }
            },
            "analysis": [
                {"label": "排名与分布", "color": "blue",
                 "text": "鲁豫晋(83.51%)和战略工程(83.12%)领跑，仅两中心超83%。华东体量最大(3.67亿)但达成率仅77.36%。11个中心无一突破85%，整体进度落后时间线约22个百分点。"},
                {"label": "风险警示", "color": "pink",
                 "text": "粤东运营中心达成率垫底(71.94%)，缺口0.80亿为绝对值第二大。其零售仅66.39%、整装68.12%，两渠道严重滞后。东北工程渠道(59.26%)同样堪忧。"}
            ]
        },

        # ===== TAB 2: 渠道分析 =====
        {
            "id": "channel", "tab": "渠道分析", "type": "chart-with-analysis",
            "chart": [
                {
                    "id": "chart-channel-bar", "title": "三大渠道 H1 达成 vs 目标（亿元）",
                    "option": {
                        "tooltip": {"trigger": "axis", "axisPointer": {"type": "shadow"}},
                        "legend": {"data": ["实际达成", "目标"], "top": 0},
                        "grid": {"left": "12%", "right": "5%", "top": "14%", "bottom": "8%"},
                        "xAxis": {"type": "category", "data": ["零售渠道\n(GD01)", "整装渠道\n(GD02)", "工程渠道\n(GD03)"], "axisLabel": {"fontSize": 12}},
                        "yAxis": {"type": "value", "name": "金额（亿元）",
                                  "axisLabel": {"formatter": "function(v){return (v/100000000).toFixed(1)+'亿';}"}},
                        "series": [
                            {"name": "实际达成", "type": "bar", "data": [958000000, 305000000, 900000000],
                             "itemStyle": {"borderRadius": [4,4,0,0]},
                             "label": {"show": True, "position": "top", "fontSize": 11,
                                       "formatter": "function(p){return (p.value/100000000).toFixed(2)+'亿';}"}},
                            {"name": "目标", "type": "bar", "data": [1267000000, 419000000, 1095000000],
                             "itemStyle": {"color": "#9CA3AF", "borderRadius": [4,4,0,0]},
                             "label": {"show": True, "position": "top", "fontSize": 11,
                                       "formatter": "function(p){return (p.value/100000000).toFixed(2)+'亿';}"}}
                        ]
                    }
                },
                {
                    "id": "chart-channel-monthly", "title": "各渠道月度业绩走势（亿元）",
                    "option": {
                        "tooltip": {"trigger": "axis"},
                        "legend": {"data": ["零售渠道", "整装渠道", "工程渠道"], "top": 0},
                        "grid": {"left": "8%", "right": "5%", "top": "14%", "bottom": "8%"},
                        "xAxis": {"type": "category", "data": ["1月","2月","3月","4月","5月","6月"]},
                        "yAxis": {"type": "value", "name": "金额（亿元）",
                                  "axisLabel": {"formatter": "function(v){return (v/100000000).toFixed(1)+'亿';}"}},
                        "series": [
                            {"name": "零售渠道", "type": "line",
                             "data": [59000000,12000000,202000000,194000000,206000000,285000000],
                             "smooth": True, "symbol": "circle", "symbolSize": 6},
                            {"name": "整装渠道", "type": "line",
                             "data": [26000000,4000000,57000000,65000000,69000000,83000000],
                             "smooth": True, "symbol": "circle", "symbolSize": 6},
                            {"name": "工程渠道", "type": "line",
                             "data": [129000000,25000000,145000000,184000000,207000000,210000000],
                             "smooth": True, "symbol": "circle", "symbolSize": 6}
                        ]
                    }
                }
            ],
            "analysis": [
                {"label": "渠道格局", "color": "blue",
                 "text": "工程渠道达成率82.19%为最佳，鲁豫晋/华北/粤西三中心工程均超90%。零售体量最大(9.58亿)但达成率仅75.63%，缺口3.09亿居首。整装渠道(72.72%)全事业部承压，粤西整装仅57.29%几近腰斩。"},
                {"label": "集中度风险", "color": "pink",
                 "text": "整装渠道高度依赖天然理石(61.4%)单一产品系列，存在结构性风险。天然理石若出现供应或质量问题，整装渠道将全面承压。零售渠道微理石独大(29.7%)，产品生命周期管理需密切关注。"}
            ]
        },

        # ===== TAB 3: 产品系列 =====
        {
            "id": "product", "tab": "产品系列", "type": "chart-with-analysis",
            "chart": [
                {
                    "id": "chart-product-pie", "title": "产品系列业绩占比 TOP 8",
                    "option": {
                        "tooltip": {"trigger": "item",
                                    "formatter": "function(p){return p.name+': '+(p.value/100000000).toFixed(2)+'亿 ('+p.percent+'%)';}"},
                        "legend": {"type": "scroll", "orient": "vertical", "right": 8, "top": "middle", "textStyle": {"fontSize": 11}},
                        "series": [{"name": "产品系列", "type": "pie", "radius": ["42%","72%"], "center": ["38%","50%"],
                                     "data": [
                                         {"value": 308000000, "name": "微理石"},
                                         {"value": 232000000, "name": "天然理石"},
                                         {"value": 165000000, "name": "素色"},
                                         {"value": 127000000, "name": "微韵石"},
                                         {"value": 116000000, "name": "四合一"},
                                         {"value": 84000000, "name": "质臻"},
                                         {"value": 82000000, "name": "净奢石"},
                                         {"value": 73000000, "name": "柔光理石"}
                                     ],
                                     "label": {"formatter": "function(p){return p.name+'\\n'+p.percent+'%';}", "fontSize": 10},
                                     "emphasis": {"itemStyle": {"shadowBlur": 10, "shadowOffsetX": 0, "shadowColor": "rgba(0,0,0,0.3)"}}}
                        ]
                    }
                },
                {
                    "id": "chart-spec-bar", "title": "规格系列业绩占比（亿元）",
                    "option": {
                        "tooltip": {"trigger": "axis", "axisPointer": {"type": "shadow"}},
                        "grid": {"left": "18%", "right": "8%", "top": "8%", "bottom": "8%"},
                        "xAxis": {"type": "value", "name": "金额（亿元）",
                                  "axisLabel": {"formatter": "function(v){return (v/100000000).toFixed(1)+'亿';}"}},
                        "yAxis": {"type": "category",
                                  "data": ["其他","600\n(600×600)","918\n(1800×900)","840\n(800×400)",
                                           "612\n(1200×600)","800\n(800×800)","715\n(1500×750)"],
                                  "axisLabel": {"fontSize": 11}},
                        "series": [{"name": "业绩", "type": "bar",
                                     "data": [136000000,122000000,150000000,191000000,398000000,514000000,529000000],
                                     "itemStyle": {"borderRadius": [0,4,4,0]},
                                     "label": {"show": True, "position": "right", "fontSize": 11,
                                               "formatter": "function(p){return (p.value/100000000).toFixed(2)+'亿';}"}}]
                    }
                }
            ],
            "analysis": [
                {"label": "系列集中度", "color": "blue",
                 "text": "TOP 3系列(微理石+天然理石+素色)占49.5%业绩。微理石(21.6%)零售一家独大(29.7%)，天然理石(16.3%)横跨整装(61.4%)和工程(30.4%)但零售仅1.5%。两系列渠道定位泾渭分明。"},
                {"label": "规格升级", "color": "cyan",
                 "text": "715(1500×750)以25.4%金额份额首次超越传统800规格(24.7%)，大规格已成主力。715+918+超大板合计占35.3%，虽面积占比低但单价更高，驱动业绩结构升级。质臻系列(5.9%)作为2026新纳入旗舰品类表现亮眼。"}
            ]
        },

        # ===== TAB 4: 面积与交付 =====
        {
            "id": "area-delivery", "tab": "面积与交付", "type": "chart-with-analysis",
            "chart": [
                {
                    "id": "chart-area-yoy", "title": "2025 vs 2026 H1 月度销售面积（万㎡）",
                    "option": {
                        "tooltip": {"trigger": "axis"},
                        "legend": {"data": ["2025年", "2026年"], "top": 0},
                        "grid": {"left": "8%", "right": "5%", "top": "14%", "bottom": "8%"},
                        "xAxis": {"type": "category", "data": ["1月","2月","3月","4月","5月","6月"]},
                        "yAxis": {"type": "value", "name": "面积（万㎡）",
                                  "axisLabel": {"formatter": "function(v){return (v/10000).toFixed(0)+'万';}"}},
                        "series": [
                            {"name": "2025年", "type": "line",
                             "data": [3350800,5119000,15244500,15509500,14490000,17610700],
                             "smooth": True, "symbol": "circle", "symbolSize": 6,
                             "lineStyle": {"color": "#9CA3AF", "type": "dashed"}},
                            {"name": "2026年", "type": "line",
                             "data": [6534100,1180100,11319800,12926500,13770100,15834500],
                             "smooth": True, "symbol": "circle", "symbolSize": 6,
                             "areaStyle": {"opacity": 0.08}}
                        ]
                    }
                },
                {
                    "id": "chart-undeliver", "title": "未交付面积 — 按品类（万㎡）",
                    "option": {
                        "tooltip": {"trigger": "axis", "axisPointer": {"type": "shadow"}},
                        "grid": {"left": "12%", "right": "8%", "top": "8%", "bottom": "8%"},
                        "xAxis": {"type": "value", "name": "面积（万㎡）",
                                  "axisLabel": {"formatter": "function(v){return (v/10000).toFixed(0)+'万';}"}},
                        "yAxis": {"type": "category",
                                  "data": ["其他","玻化砖","瓷片","精瓷中板","岩板","晶理石","仿古砖"],
                                  "axisLabel": {"fontSize": 11}},
                        "series": [{"name": "未交付面积", "type": "bar",
                                     "data": [43500,31444,98433,187418,638563,810821,861157],
                                     "itemStyle": {"borderRadius": [0,4,4,0]},
                                     "label": {"show": True, "position": "right", "fontSize": 11,
                                               "formatter": "function(p){return (p.value/10000).toFixed(1)+'万㎡';}"}}]
                    }
                }
            ],
            "analysis": [
                {"label": "面积趋势", "color": "blue",
                 "text": "2026 H1销售面积6,157万㎡，同比-13.68%。剔除春节因素(2025春节1月 vs 2026春节2月)，1+2月合计实际下降约9%。3月降幅-25.7%为最大跳水，5月收窄至-5.0%出现边际改善，6月为-10.1%。"},
                {"label": "交付压力", "color": "pink",
                 "text": "未交付263.63万㎡约占月销量1/4，仿古砖+晶理石+岩板三大品类占87.7%。GD(广东)和JX(江西)基地积压66.4%，产能瓶颈集中。44.2%未交付订单sale_lev3为'未分配'，存在组织映射数据质量问题。"}
            ]
        },

        # ===== TAB 5: 明细数据 =====
        {
            "id": "detail", "tab": "明细数据", "type": "table",
            "table": {
                "title": "各运营中心 × 渠道 达成明细（万元）",
                "columns": ["运营中心", "渠道", "实际达成(万)", "目标(万)", "达成率"],
                "rows": [
                    ["华东运营中心","工程渠道","15,646.53","19,605.00","79.81%"],
                    ["华东运营中心","零售渠道","14,464.80","19,680.01","73.50%"],
                    ["华东运营中心","整装渠道","6,560.47","8,120.14","80.79%"],
                    ["西南运营中心","零售渠道","13,564.14","17,000.29","79.79%"],
                    ["西南运营中心","工程渠道","7,411.49","8,725.00","84.95%"],
                    ["西南运营中心","整装渠道","4,075.63","6,514.72","62.56%"],
                    ["粤西运营中心","工程渠道","12,402.42","13,730.00","90.33%"],
                    ["粤西运营中心","零售渠道","7,068.68","10,341.57","68.35%"],
                    ["粤西运营中心","整装渠道","1,786.11","3,117.77","57.29%"],
                    ["鲁豫晋运营中心","零售渠道","13,504.74","16,798.27","80.39%"],
                    ["鲁豫晋运营中心","工程渠道","4,407.48","4,640.00","94.99%"],
                    ["鲁豫晋运营中心","整装渠道","2,942.98","3,536.00","83.23%"],
                    ["粤东运营中心","工程渠道","11,374.40","14,861.00","76.54%"],
                    ["粤东运营中心","零售渠道","6,277.03","9,454.93","66.39%"],
                    ["粤东运营中心","整装渠道","2,821.50","4,142.00","68.12%"],
                    ["战略工程中心","工程渠道","20,283.50","24,404.00","83.12%"],
                    ["华北运营中心","零售渠道","10,153.70","13,500.01","75.21%"],
                    ["华北运营中心","工程渠道","6,023.26","6,590.00","91.40%"],
                    ["华北运营中心","整装渠道","2,375.03","3,303.89","71.89%"],
                    ["湘鄂运营中心","零售渠道","9,527.27","12,439.99","76.59%"],
                    ["湘鄂运营中心","整装渠道","3,563.45","4,862.77","73.28%"],
                    ["湘鄂运营中心","工程渠道","3,006.20","3,758.00","79.99%"],
                    ["赣皖运营中心","零售渠道","8,199.06","10,140.00","80.86%"],
                    ["赣皖运营中心","工程渠道","4,361.37","6,215.00","70.17%"],
                    ["赣皖运营中心","整装渠道","2,891.32","4,281.10","67.54%"],
                    ["西北运营中心","零售渠道","8,822.00","11,854.00","74.42%"],
                    ["西北运营中心","工程渠道","4,110.41","5,320.00","77.26%"],
                    ["西北运营中心","整装渠道","2,344.31","2,652.42","88.38%"],
                    ["东北运营中心","零售渠道","4,234.30","5,482.00","77.24%"],
                    ["东北运营中心","整装渠道","1,096.23","1,349.48","81.23%"],
                    ["东北运营中心","工程渠道","989.65","1,670.00","59.26%"]
                ],
                "pageSize": 20
            }
        }
    ],

    "provenance": {
        "source": "DWS (GaussDB) — dm_fin_operations_mix_sum_t + dm_dp_api_sales_target + dm_otd_no_deliver_order_dtl",
        "lastUpdate": "2026-07-10 02:21 (dm_fin_operations_mix_sum_t last_analyze)",
        "skillVersion": "sales-performance-knowledge + sales-performance-analyst + otd-fulfillment-knowledge",
        "table": "dm.dm_fin_operations_mix_sum_t, dm.dm_dp_api_sales_target, dm.ct_sales_performance_t, dm.dm_otd_no_deliver_order_dtl",
        "query": """-- 区域达成
WITH target_agg AS (
  SELECT sales_center_code, SUM(target_sales_amt)*10000 target_yuan
  FROM dm.dm_dp_api_sales_target
  WHERE stat_year='2026' AND stat_month BETWEEN '2026-01' AND '2026-06'
    AND org_type='业务单位' GROUP BY sales_center_code
)
SELECT node_desc5, SUM(ambperformance) actual, t.target_yuan
FROM dm.dm_fin_operations_mix_sum_t m
LEFT JOIN target_agg t ON m.node_name5=t.sales_center_code
WHERE calmonth BETWEEN '2026-01' AND '2026-06'
  AND node_desc2='瓷砖事业部' AND data_source IN('S','T','D','')
GROUP BY node_desc5, t.target_yuan;

-- 面积同比 (Mix表 zxsmj)
SELECT calmonth, SUM(zxsmj) FROM dm.dm_fin_operations_mix_sum_t
WHERE calmonth BETWEEN '2025-01' AND '2026-06'
  AND node_desc2='瓷砖事业部' AND data_source IN('S','T','D','')
GROUP BY calmonth;

-- 未交付订单
SELECT prod_category, product_area, SUM(nodeliver_area_aps)
FROM dm.dm_otd_no_deliver_order_dtl WHERE del_flag='N'
GROUP BY prod_category, product_area;""",
        "filters": [
            "node_desc2 = '瓷砖事业部'",
            "data_source IN ('S','T','D','')",
            "目标 org_type = '业务单位' (防重复)",
            "时间: 2026-01 ~ 2026-06",
            "目标表万元 × 10000 转元"
        ],
        "limitations": [
            "dm_otd_no_deliver_order_dtl不含零售订单(ETL排除), 实际未交付总量可能更大",
            "44.2%未交付订单sale_lev3为'未分配', 存在组织映射数据质量问题",
            "达成率仅计算11个有目标运营中心, 梦之家/DPI等无目标实体未计入"
        ],
        "dataQuality": [
            "dm_dp_api_sales_target.sales_region全为NULL, 无法按地理区域做目标分解",
            "ct_sales_performance_t无last_year_month_sales_area, 面积同比改用Mix表",
            "Mix表实际达成与业绩表month_achievement口径可能有微小差异"
        ]
    }
}

# Assemble HTML
report_json_str = json.dumps(report, ensure_ascii=False)
report_meta = "数据期间 2026-01 ~ 2026-06 | 生成 2026-07-10 | DWS (GaussDB)"
echarts_block = "<script>\n" + echarts_js + "\n</script>"

html = shell.replace("{{REPORT_TITLE}}", "瓷砖事业部 2026年半年度经营分析报告")
html = html.replace("{{REPORT_META}}", report_meta)
html = html.replace("{{ECHARTS_LIB}}", echarts_block)
html = html.replace("{{REPORT_JSON}}", report_json_str)

with open(OUT, "w", encoding="utf-8") as f:
    f.write(html)

size_kb = os.path.getsize(OUT) / 1024
print(f"✅ 报告已生成: reports/report_sales-performance_20260710.html")
print(f"📦 文件大小: {size_kb:.0f} KB")
print(f"🌐 在线访问: http://192.168.18.231:8080/report_sales-performance_20260710.html")
