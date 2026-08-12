"""
Integration test: generate a report from the dark-pro report-shell.html template.
Verifies placeholder substitution, ECharts embedding, and section rendering.
"""
import json
import os

PROJ_DIR = os.path.dirname(os.path.abspath(__file__))

# ---- Test data (adapted to match template's JS expectations) ----
report_json = {
    "title": "瓷砖事业部 2026年1-5月业绩分析报告",
    "subtitle": "2026-01 ~ 2026-05 | 生成: 2026-06-10",
    "kpis": [
        {"label": "累计达成", "value": "16.87亿", "change": "vs 预算 -21.9%", "direction": "down"},
        {"label": "5月达成", "value": "5.05亿", "change": "vs 预算 -25.0%", "direction": "down"},
        {"label": "国内营销中心占比", "value": "97.3%", "change": "16.41亿 / 16.87亿", "direction": "neutral"},
        {"label": "零售渠道达成", "value": "7.22亿", "change": "vs 预算 -27.2%", "direction": "down"}
    ],
    "insight": "1-5月累计达成16.87亿，低于预算21.9%。三大渠道全面低于预算，零售缺口最大(-27.2%)。3月后恢复但追预算压力大。",
    "sections": [
        {
            "id": "trend",
            "tab": "趋势分析",
            "type": "chart-with-analysis",
            "chart": {
                "id": "chart-trend",
                "title": "月度达成趋势",
                "option": {
                    "tooltip": {"trigger": "axis"},
                    "legend": {"data": ["实际达成", "预算", "去年同期"], "top": 0},
                    "xAxis": {"type": "category", "data": ["1月", "2月", "3月", "4月", "5月"]},
                    "yAxis": {
                        "type": "value",
                        "name": "金额（亿）",
                        "axisLabel": {
                            "formatter": "function(v){return (v/1e8).toFixed(2)+'亿';}"
                        }
                    },
                    "series": [
                        {
                            "name": "实际达成",
                            "type": "line",
                            "data": [235326388, 45844139, 427430907, 472816361, 505206331],
                            "smooth": True,
                            "symbol": "circle",
                            "symbolSize": 8
                        },
                        {
                            "name": "预算",
                            "type": "line",
                            "data": [219198800, 93583100, 577477100, 596425500, 673771500],
                            "smooth": True,
                            "symbol": "diamond",
                            "symbolSize": 8,
                            "lineStyle": {"type": "dashed"}
                        },
                        {
                            "name": "去年同期",
                            "type": "line",
                            "data": [128763599, 192470751, 598735857, 613459526, 582566799],
                            "smooth": True,
                            "symbol": "triangle",
                            "symbolSize": 8,
                            "lineStyle": {"type": "dotted"}
                        }
                    ]
                }
            },
            "analysis": [
                {
                    "label": "趋势判断",
                    "color": "blue",
                    "text": "月度达成呈V型反弹：2月触底0.46亿（春节因素），3月恢复至4.27亿，4-5月维持在4.7-5.1亿区间。5月达成5.05亿，环比4月增长+6.8%。"
                },
                {
                    "label": "风险提示",
                    "color": "pink",
                    "text": "预算达成持续落后。1-5月仅2月实际略超预算，其余各月均低于预算线。按当前节奏，全年达成率预计仅78%左右，缺口约4.6亿。"
                }
            ]
        },
        {
            "id": "channel",
            "tab": "渠道对比",
            "type": "chart-with-analysis",
            "chart": {
                "id": "chart-channel",
                "title": "渠道达成 vs 预算",
                "option": {
                    "tooltip": {"trigger": "axis", "axisPointer": {"type": "shadow"}},
                    "legend": {"data": ["实际达成", "预算"], "top": 0},
                    "xAxis": {"type": "category", "data": ["零售GD01", "工程GD03", "整装GD02"]},
                    "yAxis": {
                        "type": "value",
                        "name": "金额（亿）",
                        "axisLabel": {
                            "formatter": "function(v){return (v/1e8).toFixed(1)+'亿';}"
                        }
                    },
                    "series": [
                        {
                            "name": "实际达成",
                            "type": "bar",
                            "data": [721971110, 695107981, 223898563],
                            "itemStyle": {"borderRadius": [4, 4, 0, 0]},
                            "label": {
                                "show": True,
                                "position": "top",
                                "formatter": "function(p){return (p.value/1e8).toFixed(2)+'亿';}",
                                "fontSize": 11
                            }
                        },
                        {
                            "name": "预算",
                            "type": "bar",
                            "data": [992048300, 818680000, 318548700],
                            "itemStyle": {"borderRadius": [4, 4, 0, 0], "opacity": 0.7},
                            "label": {
                                "show": True,
                                "position": "top",
                                "formatter": "function(p){return (p.value/1e8).toFixed(2)+'亿';}",
                                "fontSize": 10
                            }
                        }
                    ]
                }
            },
            "analysis": [
                {
                    "label": "对比分析",
                    "color": "blue",
                    "text": "三大渠道全面低于预算。零售渠道达成7.22亿（占比44%），缺口-27.2%最大；工程渠道6.95亿（占比42.4%），缺口-15.1%相对可控；整装渠道2.24亿（占比13.6%），缺口-29.7%。"
                },
                {
                    "label": "风险提示",
                    "color": "pink",
                    "text": "整装渠道虽然占比最小（13.6%），但预算缺口最大（-29.7%），需关注是否为目标设定过高还是实际执行问题。"
                }
            ]
        },
        {
            "id": "data",
            "tab": "明细数据",
            "type": "table",
            "table": {
                "title": "渠道 & 品类明细",
                "columns": ["维度", "分类", "达成额", "预算", "偏差", "占比"],
                "rows": [
                    ["渠道", "零售 GD01", "7.22亿", "9.92亿", "-27.2%", "44.0%"],
                    ["渠道", "工程 GD03", "6.95亿", "8.19亿", "-15.1%", "42.4%"],
                    ["渠道", "整装 GD02", "2.24亿", "3.19亿", "-29.7%", "13.6%"],
                    ["品类", "抛釉砖", "8.16亿", "11.26亿", "-27.6%", "49.7%"],
                    ["品类", "仿古砖", "5.25亿", "6.08亿", "-13.6%", "32.0%"],
                    ["品类", "精瓷中板", "1.43亿", "1.95亿", "-26.4%", "8.7%"],
                    ["品类", "瓷片", "0.57亿", "0.75亿", "-24.2%", "3.5%"]
                ],
                "pageSize": 20
            }
        }
    ],
    "provenance": {
        "source": "dm.dm_fin_operations_mix_sum_t",
        "lastUpdate": "2026-06-09",
        "skillVersion": "sales-performance-analyst / sales-performance-knowledge",
        "sql": "SELECT period, channel_code, channel_name, SUM(tax_achievement_amount) AS amount FROM dm.dm_fin_operations_mix_sum_t WHERE node_desc2 = '瓷砖事业部' AND data_source = 'S' AND period BETWEEN '202601' AND '202605' GROUP BY period, channel_code, channel_name ORDER BY period, channel_code",
        "filters": ["瓷砖事业部", "国内营销中心(S)", "期间 202601-202605"],
        "limitations": ["仅含主数据源(S)", "不含海外渠道", "预算数据截止2026-05"],
        "dataQuality": ["2月数据受春节影响（仅0.46亿）", "空品牌占36.8%待治理"]
    }
}

def main():
    template_path = os.path.join(PROJ_DIR, "skills", "report-generator", "templates", "report-shell.html")
    echarts_path = os.path.join(PROJ_DIR, "skills", "report-generator", "templates", "echarts.min.js")
    output_path = os.path.join(PROJ_DIR, "test_report_output.html")

    # 1. Read template
    with open(template_path, "r", encoding="utf-8") as f:
        html = f.read()

    # 2. Read ECharts library
    with open(echarts_path, "r", encoding="utf-8") as f:
        echarts_js = f.read()

    # 3. Replace placeholders
    html = html.replace("{{ECHARTS_LIB}}", f"<script>\n{echarts_js}\n</script>")
    html = html.replace("{{REPORT_TITLE}}", report_json["title"])
    html = html.replace("{{REPORT_META}}", report_json["subtitle"])
    html = html.replace("{{REPORT_JSON}}", json.dumps(report_json, ensure_ascii=False))

    # 4. Write output
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(html)

    import os
    size = os.path.getsize(output_path)
    print(f"OK: {output_path}")
    print(f"Size: {size:,} bytes ({size / 1024:.1f} KB)")

    # Quick sanity checks
    assert "{{ECHARTS_LIB}}" not in html, "FAIL: ECHARTS_LIB placeholder not replaced"
    assert "{{REPORT_TITLE}}" not in html, "FAIL: REPORT_TITLE placeholder not replaced"
    assert "{{REPORT_META}}" not in html, "FAIL: REPORT_META placeholder not replaced"
    assert "{{REPORT_JSON}}" not in html, "FAIL: REPORT_JSON placeholder not replaced"
    assert "<script>" in html and "echarts" in html.lower(), "FAIL: ECharts not embedded"
    assert "瓷砖事业部" in html, "FAIL: Report content not found"
    assert "tab-" in html or "趋势分析" in html, "FAIL: Section tabs not rendered by JS"
    print("All placeholder checks passed.")

if __name__ == "__main__":
    main()
