"""Generate HTML report for 瓷砖事业部北京区域业绩分析"""
import json

# ---- REPORT JSON ----
report = {
    "title": "瓷砖事业部 — 北京区域 2026年1-5月业绩分析",
    "subtitle": "2026-01 ~ 2026-05 | 生成: 2026-06-27",
    "kpis": [
        {"label": "累计达成额", "value": "7,692万", "change": "同比 +26.4%", "direction": "up"},
        {"label": "累计不含税", "value": "6,941万", "change": "同比 —", "direction": "neutral"},
        {"label": "累计面积", "value": "233万㎡", "change": "同比 —", "direction": "neutral"},
        {"label": "Top1客户", "value": "九号科技", "change": "1,031万", "direction": "up"},
        {"label": "客户数", "value": "20+", "change": "北京区域", "direction": "neutral"}
    ],
    "insight": "北京区域1-5月累计达成7,692万元，同比增长26.4%，在全国瓷砖事业部整体下滑20%的大背景下逆势增长。3-5月单月从1,695万稳步攀升至2,407万，趋势健康。Top5客户集中度50%，九号科技独占1,031万。",
    "sections": [
        {
            "id": "trend",
            "tab": "月度趋势",
            "type": "chart-with-analysis",
            "chart": {
                "id": "chart-trend",
                "title": "月度达成额趋势（万元）— 本期 vs 去年同期",
                "tall": True,
                "option": {
                    "tooltip": {"trigger": "axis"},
                    "legend": {"data": ["2026年", "2025年"]},
                    "xAxis": {
                        "type": "category",
                        "data": ["1月", "2月", "3月", "4月", "5月"],
                        "axisLabel": {"rotate": 0}
                    },
                    "yAxis": {
                        "type": "value",
                        "name": "万元",
                        "axisLabel": {
                            "formatter": "function(v){ return (v/10000).toFixed(0)+'万'; }"
                        }
                    },
                    "series": [
                        {
                            "name": "2026年",
                            "type": "line",
                            "data": [873, 276, 1695, 2441, 2407],
                            "smooth": True,
                            "symbol": "circle",
                            "symbolSize": 8,
                            "lineStyle": {"width": 3}
                        },
                        {
                            "name": "2025年",
                            "type": "line",
                            "data": [107, 389, 1519, 2288, 1784],
                            "smooth": True,
                            "symbol": "diamond",
                            "symbolSize": 6,
                            "lineStyle": {"type": "dashed", "width": 2}
                        }
                    ]
                }
            },
            "analysis": [
                {
                    "label": "趋势判断",
                    "color": "blue",
                    "text": "1-5月累计7,692万元，同比+26.4%（+1,605万）。春节错位明显：1月同比暴增716%，2月下滑29%。合并1+2月看：今年1,149万 vs 去年496万，增幅132%，排除春节效应后增长依然显著。"
                },
                {
                    "label": "风险提示",
                    "color": "pink",
                    "text": "2月仅276万，为全年低谷（春节因素）。5月达2,407万但略低于4月2,441万，需关注6月是否继续冲高。全国瓷砖事业部同比-20%，北京逆势增长能否持续有待观察。"
                }
            ]
        },
        {
            "id": "customer",
            "tab": "客户排行",
            "type": "chart-with-analysis",
            "chart": {
                "id": "chart-customer",
                "title": "Top 10 客户达成额（万元）",
                "option": {
                    "tooltip": {"trigger": "axis", "axisPointer": {"type": "shadow"}},
                    "yAxis": {
                        "type": "category",
                        "data": [
                            "九号科技", "朗惠时代", "东方龙泽", "楚凌特商贸", "朗惠鸿泰",
                            "屹陶鸿业", "中盛万合", "七星创展", "装库商贸", "松婷装饰"
                        ],
                        "axisLabel": {"fontSize": 11}
                    },
                    "xAxis": {
                        "type": "value",
                        "name": "万元",
                        "axisLabel": {
                            "formatter": "function(v){ return v+'万'; }"
                        }
                    },
                    "series": [{
                        "name": "达成额",
                        "type": "bar",
                        "data": [1031, 769, 746, 675, 621, 576, 418, 343, 225, 215],
                        "itemStyle": {"borderRadius": [0, 4, 4, 0]},
                        "label": {
                            "show": True,
                            "position": "right",
                            "formatter": "function(p){ return p.value+'万'; }",
                            "fontSize": 11
                        }
                    }]
                }
            },
            "analysis": [
                {
                    "label": "集中度",
                    "color": "blue",
                    "text": "Top 5客户合计3,841万元，占北京区域总额的50%。九号科技以1,031万遥遥领先，比第2名朗惠时代(769万)高34%。Top 10客户合计5,619万，占比73%。"
                },
                {
                    "label": "客户多样性",
                    "color": "cyan",
                    "text": "部分Top客户注册地不在北京（宿迁楚凌特、南昌松婷装饰、天津西瓜旅游等），说明按销售归属区域统计，非客户注册地。"
                }
            ]
        },
        {
            "id": "product",
            "tab": "产品维度",
            "type": "chart-with-analysis",
            "chart": [
                {
                    "id": "chart-brand",
                    "title": "Top 5 产品系列（万元）",
                    "option": {
                        "tooltip": {"trigger": "axis", "axisPointer": {"type": "shadow"}},
                        "yAxis": {
                            "type": "category",
                            "data": ["天然理石", "柔光理石", "质感木纹", "简约素色", "素色"],
                            "axisLabel": {"fontSize": 10}
                        },
                        "xAxis": {
                            "type": "value",
                            "name": "万元"
                        },
                        "series": [{
                            "name": "达成额",
                            "type": "bar",
                            "data": [217, 132, 44, 39, 38],
                            "itemStyle": {"borderRadius": [0, 4, 4, 0]},
                            "label": {"show": True, "position": "right", "formatter": "function(p){ return p.value+'万'; }", "fontSize": 10}
                        }]
                    }
                },
                {
                    "id": "chart-category",
                    "title": "品类构成（万元）",
                    "option": {
                        "tooltip": {"trigger": "axis", "axisPointer": {"type": "shadow"}},
                        "yAxis": {
                            "type": "category",
                            "data": ["仿古砖", "精瓷中板", "抛釉砖", "瓷片", "岩板", "其他"],
                            "axisLabel": {"fontSize": 10}
                        },
                        "xAxis": {
                            "type": "value",
                            "name": "万元"
                        },
                        "series": [{
                            "name": "达成额",
                            "type": "bar",
                            "data": [227, 219, 143, 67, 44, 14],
                            "itemStyle": {"borderRadius": [0, 4, 4, 0]},
                            "label": {"show": True, "position": "right", "formatter": "function(p){ return p.value+'万'; }", "fontSize": 10}
                        }]
                    }
                }
            ],
            "analysis": [
                {
                    "label": "系列偏好",
                    "color": "blue",
                    "text": "天然理石(217万)和柔光理石(132万)两大系列合计349万，占该客户总额的56%，风格偏好高度集中于理石类产品。"
                },
                {
                    "label": "品类分布",
                    "color": "cyan",
                    "text": "仿古砖(227万)与精瓷中板(219万)双雄并立，合计占63%；抛釉砖(143万)位居第三。品类结构相对均衡。"
                }
            ]
        },
        {
            "id": "detail",
            "tab": "客户明细",
            "type": "table",
            "title": "北京区域 Top 20 客户明细（1-5月累计）",
            "columns": ["客户名称", "达成额(万元)", "面积(万㎡)"],
            "rows": [
                ["九号科技有限公司", 1031, 22.3],
                ["北京朗惠时代家居用品有限公司", 769, 20.2],
                ["北京东方龙泽建材有限公司", 746, 0.9],
                ["宿迁楚凌特商贸有限公司", 675, 23.0],
                ["北京朗惠鸿泰科技有限公司", 621, 24.4],
                ["北京屹陶鸿业商贸有限公司", 576, 20.9],
                ["北京中盛万合集团有限公司", 418, 12.9],
                ["北京七星创展经贸有限公司", 343, 9.8],
                ["装库(北京)商贸有限公司", 225, 6.5],
                ["南昌市松婷装饰工程有限公司", 215, 6.4],
                ["天津西瓜旅游有限责任公司", 184, 6.0],
                ["广东省鹏创科筑装饰工程有限公司", 172, 5.8],
                ["北京和谐新辉煌经贸有限公司", 170, 4.0],
                ["上海振欣拓商贸有限公司", 152, 4.0],
                ["北京雅露轩建筑工程有限公司", 150, 4.8],
                ["中国邮政储蓄银行股份有限公司", 114, 3.4],
                ["眉山市宏大投资建设集团有限公司", 96, 2.4],
                ["天津德晨石材贸易有限公司", 90, 3.3],
                ["京日合创(北京)建材销售有限公司", 81, 2.6],
                ["三亚南繁繁茂置业有限公司", 74, 1.5]
            ],
            "pageSize": 20
        }
    ],
    "provenance": {
        "source": "dm.dm_fin_operations_mix_sum_t",
        "lastUpdate": "2026-06 上旬（数据次月5日左右入库）",
        "skillVersion": "sales-performance-analyst / sales-performance-knowledge",
        "table": "dm.dm_fin_operations_mix_sum_t",
        "query": "SELECT calmonth, ROUND(SUM(ambperformance)/100000000,4) as达成额_亿元, ROUND(SUM(notax_sales_net_amt)/100000000,4) as不含税_亿元, ROUND(SUM(s_zxsmj)/10000,0) as面积_万平 FROM dm.dm_fin_operations_mix_sum_t WHERE calmonth BETWEEN '2026-01' AND '2026-05' AND node_desc2='瓷砖事业部' AND region_province_name='北京' AND data_source IN ('S','T','D','') GROUP BY calmonth ORDER BY calmonth;",
        "filters": [
            "node_desc2 = 瓷砖事业部",
            "region_province_name = 北京",
            "calmonth = 2026-01 ~ 2026-05",
            "data_source IN ('S','T','D','')"
        ],
        "limitations": [
            "不含6月数据（预计7月5日入库）",
            "同比使用Mix表2025同期交叉计算（ct_sales_performance_t无region字段）",
            "区域按销售归属划分，非客户注册地"
        ],
        "dataQuality": [
            "1月同比+716%受春节错位影响，合并1+2月看更合理",
            "北京朗惠鸿泰产品系列字段(product_series_name)为规格编号，已改用product_brand_name"
        ]
    }
}

# ---- Load template shell ----
with open("D:/dataproj/skills/report-generator/templates/report-shell.html", "r", encoding="utf-8") as f:
    template = f.read()

# ---- Load echarts.min.js ----
with open("D:/dataproj/skills/report-generator/templates/echarts.min.js", "r", encoding="utf-8") as f:
    echarts_js = f.read()

# ---- Replace placeholders ----
html = template
html = html.replace("{{REPORT_TITLE}}", report["title"])
html = html.replace("{{REPORT_META}}", report["subtitle"])
html = html.replace("{{ECHARTS_LIB}}", "<script>" + echarts_js + "</script>")
html = html.replace("{{REPORT_JSON}}", json.dumps(report, ensure_ascii=False, indent=2))

# ---- Write output ----
output_path = "D:/dataproj/report_sales_beijing_20260627.html"
with open(output_path, "w", encoding="utf-8") as f:
    f.write(html)

import os
size_mb = os.path.getsize(output_path) / (1024 * 1024)
print(f"Report generated: {output_path}")
print(f"File size: {size_mb:.1f} MB")
