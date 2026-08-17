#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""组装销售业绩分析报告 HTML

[DEPRECATED 2026-08] 已废弃 — 统一改用 skills/report-generator/scripts/build.py。此脚本留存仅作历史参考，内含硬编码数据/路径，勿在新报告使用。
"""
from __future__ import annotations

import json
import os

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "skills/report-generator/templates")

if __name__ == "__main__":
    reports_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reports")
    os.makedirs(reports_dir, exist_ok=True)
    OUT = os.path.join(reports_dir, "report_sales-performance_20260612.html")

    with open(os.path.join(BASE, "report-shell.html"), "r", encoding="utf-8") as f:
        template = f.read()

    with open(os.path.join(BASE, "echarts.min.js"), "r", encoding="utf-8") as f:
        echarts_lib = f.read()

if __name__ == "__main__":
    # ============================================================
    # REPORT_JSON
    # ============================================================
    report = {
    "title": "2026年1-5月 集团销售业绩预算达成分析",
    "subtitle": "数据期间：2026-01 ~ 2026-05 | 生成时间：2026-06-12",
    "kpis": [
        {"label": "累计实际业绩", "value": "20.38亿", "change": "vs 预算 -20.0%", "direction": "down"},
        {"label": "累计预算目标", "value": "25.46亿", "direction": "neutral"},
        {"label": "累计预算缺口", "value": "-5.1亿", "direction": "down"},
        {"label": "仅1月达标", "value": "1/5月", "change": "2-5月连续未达标", "direction": "down"}
    ],
    "insight": "1-5月累计预算达成率仅80.0%，缺口5.1亿元。仅1月完成预算(107%)，2-5月连续未达标。核心拖累为瓷砖事业部(占85%预算，达成率78.1%)，其中零售渠道达成率72.4%且从1月106%持续下滑至5月69%，未见企稳迹象。",

    "sections": [
        # ---- Tab 1: 月度趋势 ----
        {
            "id": "trend",
            "tab": "月度趋势",
            "type": "chart-with-analysis",
            "chart": {
                "id": "chart-trend",
                "title": "月度实际 vs 预算 & 累计达成率",
                "option": {
                    "legend": {"data": ["实际业绩", "预算目标", "累计达成率"], "top": 0},
                    "tooltip": {"trigger": "axis"},
                    "xAxis": {
                        "type": "category",
                        "data": ["1月", "2月", "3月", "4月", "5月"]
                    },
                    "yAxis": [
                        {
                            "type": "value",
                            "name": "金额(亿元)",
                            "axisLabel": {
                                "formatter": "function(v){ return (v/100000000).toFixed(2)+'亿'; }"
                            }
                        },
                        {
                            "type": "value",
                            "name": "达成率(%)",
                            "axisLabel": {
                                "formatter": "function(v){ return v.toFixed(0)+'%'; }"
                            },
                            "min": 60,
                            "max": 120
                        }
                    ],
                    "series": [
                        {
                            "name": "实际业绩",
                            "type": "line",
                            "data": [323619414.83, 65532779.23, 521575730.51, 540545673.70, 586862670.83],
                            "smooth": True,
                            "symbol": "circle",
                            "symbolSize": 8,
                            "lineStyle": {"width": 3}
                        },
                        {
                            "name": "预算目标",
                            "type": "line",
                            "data": [303023930.62, 105171470.71, 679295742.35, 685530605.48, 773084081.31],
                            "smooth": True,
                            "symbol": "diamond",
                            "symbolSize": 7,
                            "lineStyle": {"width": 2, "type": "dashed"}
                        },
                        {
                            "name": "累计达成率",
                            "type": "line",
                            "yAxisIndex": 1,
                            "data": [106.8, 95.3, 83.7, 81.9, 80.0],
                            "smooth": True,
                            "symbol": "pin",
                            "symbolSize": 8,
                            "lineStyle": {"width": 2, "type": "dotted"},
                            "itemStyle": {"color": "#f87171"}
                        }
                    ]
                }
            },
            "analysis": [
                {
                    "label": "趋势判断",
                    "color": "blue",
                    "text": "累计达成率从1月106.8%持续下滑至5月80.0%，仅1月因年底结转效应超额完成。2月春节断崖(62.3%)，3-5月恢复至76-79%但始终低于预算线，未出现向上拐点。"
                },
                {
                    "label": "风险提示",
                    "color": "pink",
                    "text": "后7个月需完成剩余预算约120%+才能追回全年目标。从3-5月均值76%看，当前趋势下全年达成率预计仅78-82%，缺口可能扩大至8-10亿元。"
                }
            ]
        },

        # ---- Tab 2: 事业部 & 渠道 ----
        {
            "id": "bu-channel",
            "tab": "事业部 & 渠道",
            "type": "chart-with-analysis",
            "chart": [
                {
                    "id": "chart-bu",
                    "title": "各事业部累计实际 vs 预算(亿元)",
                    "option": {
                        "legend": {"data": ["实际", "预算"], "top": 0},
                        "tooltip": {"trigger": "axis", "axisPointer": {"type": "shadow"}},
                        "xAxis": {
                            "type": "category",
                            "data": ["瓷砖事业部", "卫浴事业部", "国际营销中心", "丽适岩板"]
                        },
                        "yAxis": {
                            "type": "value",
                            "name": "亿元",
                            "axisLabel": {
                                "formatter": "function(v){ return (v/100000000).toFixed(1)+'亿'; }"
                            }
                        },
                        "series": [
                            {
                                "name": "实际",
                                "type": "bar",
                                "data": [1686624125.99, 274943412.02, 70145753.56, 5657861.79],
                                "itemStyle": {"borderRadius": [4,4,0,0]},
                                "label": {
                                    "show": True,
                                    "position": "top",
                                    "formatter": "function(p){ return (p.value/100000000).toFixed(1)+'亿'; }"
                                }
                            },
                            {
                                "name": "预算",
                                "type": "bar",
                                "data": [2160456000.38, 314168100, 63308530.09, 81732000],
                                "itemStyle": {"borderRadius": [4,4,0,0], "opacity": 0.5},
                                "label": {
                                    "show": True,
                                    "position": "top",
                                    "formatter": "function(p){ return (p.value/100000000).toFixed(1)+'亿'; }"
                                }
                            }
                        ]
                    }
                },
                {
                    "id": "chart-channel",
                    "title": "瓷砖事业部-渠道达成率(%)",
                    "option": {
                        "tooltip": {"trigger": "axis", "axisPointer": {"type": "shadow"}},
                        "xAxis": {
                            "type": "category",
                            "data": ["零售渠道", "工程渠道", "整装渠道"]
                        },
                        "yAxis": {
                            "type": "value",
                            "name": "达成率(%)",
                            "max": 100,
                            "axisLabel": {
                                "formatter": "function(v){ return v+'%'; }"
                            }
                        },
                        "series": [
                            {
                                "name": "累计达成率",
                                "type": "bar",
                                "data": [72.4, 88.2, 70.3],
                                "itemStyle": {"borderRadius": [4,4,0,0]},
                                "label": {
                                    "show": True,
                                    "position": "top",
                                    "formatter": "function(p){ return p.value+'%'; }"
                                },
                                "markLine": {
                                    "silent": True,
                                    "data": [{"yAxis": 100, "name": "预算线"}],
                                    "lineStyle": {"color": "#f87171", "type": "dashed"}
                                }
                            }
                        ]
                    }
                }
            ],
            "analysis": [
                {
                    "label": "事业部归因",
                    "color": "cyan",
                    "text": "瓷砖事业部占集团预算85%，累计欠额4.7亿，是集团整体未达标的主因。国际营销中心唯一超额(110.8%)但体量仅0.7亿，对集团拉动有限。"
                },
                {
                    "label": "渠道风险",
                    "color": "pink",
                    "text": "零售渠道是最大拖累：达成率72.4%，缺口2.83亿，月度从106%持续下滑至69%无企稳。整装渠道达成率最低(70.3%)，工程渠道相对最好(88.2%)但受订单波动影响大。"
                }
            ]
        },

        # ---- Tab 3: 区域分析 ----
        {
            "id": "region",
            "tab": "区域分析",
            "type": "chart-with-analysis",
            "chart": [
                {
                    "id": "chart-region",
                    "title": "各大区累计预算达成率(%)",
                    "tall": True,
                    "option": {
                        "tooltip": {"trigger": "axis", "axisPointer": {"type": "shadow"}},
                        "yAxis": {
                            "type": "category",
                            "data": ["赣皖运营中心", "东北运营中心", "湘鄂运营中心", "粤东运营中心",
                                     "华东运营中心", "粤西运营中心", "西南运营中心",
                                     "华北运营中心", "西北运营中心", "鲁豫晋运营中心"]
                        },
                        "xAxis": {
                            "type": "value",
                            "name": "达成率(%)",
                            "max": 90,
                            "axisLabel": {
                                "formatter": "function(v){ return v+'%'; }"
                            }
                        },
                        "series": [
                            {
                                "name": "达成率",
                                "type": "bar",
                                "data": [70.9, 70.6, 72.9, 73.1, 74.5, 76.4, 78.3, 78.4, 79.0, 81.4],
                                "itemStyle": {"borderRadius": [0,4,4,0]},
                                "label": {
                                    "show": True,
                                    "position": "right",
                                    "formatter": "function(p){ return p.value+'%'; }"
                                },
                                "markLine": {
                                    "silent": True,
                                    "data": [{"xAxis": 80, "name": "80%线"}],
                                    "lineStyle": {"color": "#f87171", "type": "dashed"}
                                }
                            }
                        ]
                    }
                }
            ],
            "analysis": [
                {
                    "label": "区域分化",
                    "color": "blue",
                    "text": "鲁豫晋(81.4%)和西北(79.0%)相对领先，但仍低于预算。赣皖(70.9%)和东北(70.6%)垫底。华东体量最大(26亿)但缺口也最大(8.9亿)，占集团总缺口的35%。"
                },
                {
                    "label": "结构问题",
                    "color": "pink",
                    "text": "10个大区无一达成80%以上，说明问题不是个别区域拖累，而是系统性低于预算。赣皖和东北产品结构与其他大区高度雷同，问题在渠道能力而非产品组合。"
                }
            ]
        },

        # ---- Tab 4: 产品 & 大板 ----
        {
            "id": "product",
            "tab": "产品 & 大板",
            "type": "chart-with-analysis",
            "chart": [
                {
                    "id": "chart-918",
                    "title": "918+大板渗透率 vs 单价",
                    "option": {
                        "legend": {"data": ["918+渗透率(%)", "单价(元/㎡)"], "top": 0},
                        "tooltip": {"trigger": "axis"},
                        "xAxis": {
                            "type": "category",
                            "data": ["粤东", "华东", "西南", "湘鄂", "粤西", "鲁豫晋", "赣皖", "东北", "华北", "西北"]
                        },
                        "yAxis": [
                            {
                                "type": "value",
                                "name": "渗透率(%)",
                                "max": 12,
                                "axisLabel": {
                                    "formatter": "function(v){ return v+'%'; }"
                                }
                            },
                            {
                                "type": "value",
                                "name": "单价(元/㎡)",
                                "max": 100,
                                "axisLabel": {
                                    "formatter": "function(v){ return v+'元'; }"
                                }
                            }
                        ],
                        "series": [
                            {
                                "name": "918+渗透率(%)",
                                "type": "bar",
                                "data": [10.6, 4.4, 4.4, 4.6, 4.2, 3.2, 3.4, 3.3, 2.0, 2.4],
                                "itemStyle": {"borderRadius": [4,4,0,0]},
                                "label": {
                                    "show": True,
                                    "position": "top",
                                    "formatter": "function(p){ return p.value+'%'; }"
                                }
                            },
                            {
                                "name": "单价(元/㎡)",
                                "type": "line",
                                "yAxisIndex": 1,
                                "data": [68.6, 78.4, 71.9, 72.6, 88.2, 80.4, 76.1, 83.7, 80.9, 96.8],
                                "smooth": True,
                                "symbol": "circle",
                                "symbolSize": 6
                            }
                        ]
                    }
                },
                {
                    "id": "chart-cust",
                    "title": "一级客户业绩分布(家)",
                    "option": {
                        "tooltip": {"trigger": "axis", "axisPointer": {"type": "shadow"}},
                        "xAxis": {
                            "type": "category",
                            "data": ["零业绩", "<5万", "5-20万", "20-50万", "50-100万", "100-300万", ">300万"],
                            "axisLabel": {"rotate": 30, "interval": 0}
                        },
                        "yAxis": {
                            "type": "value",
                            "name": "客户数(家)"
                        },
                        "series": [
                            {
                                "name": "客户数",
                                "type": "bar",
                                "data": [71, 273, 459, 480, 202, 99, 24],
                                "itemStyle": {"borderRadius": [4,4,0,0]},
                                "label": {
                                    "show": True,
                                    "position": "top"
                                }
                            }
                        ]
                    }
                }
            ],
            "analysis": [
                {
                    "label": "大板市场",
                    "color": "blue",
                    "text": "粤东918+渗透率10.6%远超其他区域(2-5%)，但单价仅68.6元/㎡为全集团最低。西北/华北渗透率仅2.0-2.4%但单价高达81-97元/㎡，存在增长空间。1800X900(918)占918+面积80-90%，其他大规格尚处导入期。"
                },
                {
                    "label": "客户质量",
                    "color": "pink",
                    "text": "71家零业绩+273家<5万=344家(21.8%)一级客户几乎不产出，占用渠道资源。东北零业绩占比9.3%最高，79%客户月均<4万。华东客户质量最好，28%低于20万。"
                }
            ]
        },

        # ---- Tab 5: 明细数据 ----
        {
            "id": "data",
            "tab": "明细数据",
            "type": "table",
            "columns": ["分析维度", "主体", "实际(亿元)", "预算(亿元)", "达成率(%)", "缺口(亿元)", "关键判断"],
            "rows": [
                ["集团", "全集团", "20.38", "25.46", "80.0", "-5.08", "仅1月达标"],
                ["事业部", "瓷砖事业部", "16.87", "21.60", "78.1", "-4.73", "占85%预算，主因"],
                ["事业部", "卫浴事业部", "2.75", "3.14", "87.5", "-0.39", "接近但未达标"],
                ["事业部", "国际营销中心", "0.70", "0.63", "110.8", "0.07", "唯一超额"],
                ["事业部", "丽适岩板", "0.06", "0.08", "69.2", "-0.02", "达成率最低"],
                ["渠道", "零售渠道 GD01", "7.40", "10.23", "72.4", "-2.83", "持续下滑至69%"],
                ["渠道", "工程渠道 GD03", "7.22", "8.19", "88.2", "-0.96", "波动大"],
                ["渠道", "整装渠道 GD02", "2.24", "3.19", "70.3", "-0.95", "底部回升"],
                ["大区", "鲁豫晋运营中心", "1.54", "1.88", "81.4", "-0.35", "相对最好"],
                ["大区", "西北运营中心", "1.16", "1.46", "79.0", "-0.31", ""],
                ["大区", "华北运营中心", "1.36", "1.74", "78.4", "-0.38", ""],
                ["大区", "西南运营中心", "1.86", "2.38", "78.3", "-0.52", ""],
                ["大区", "华东运营中心", "2.60", "3.49", "74.5", "-0.89", "缺口最大(8.9亿)"],
                ["大区", "粤西运营中心", "1.52", "1.99", "76.4", "-0.47", ""],
                ["大区", "粤东运营中心", "1.53", "2.09", "73.1", "-0.56", ""],
                ["大区", "湘鄂运营中心", "1.14", "1.56", "72.9", "-0.42", ""],
                ["大区", "赣皖运营中心", "1.09", "1.53", "70.9", "-0.45", "达成率最低之一"],
                ["大区", "东北运营中心", "0.45", "0.63", "70.6", "-0.19", "达成率最低之一"],
                ["大板", "粤东 918+", "2,640万", "—", "—", "—", "渗透率10.6%，单价68.6"],
                ["大板", "西北 918+", "664万", "—", "—", "—", "渗透率2.4%，单价96.8"],
                ["客户", "零业绩客户", "71家", "—", "—", "—", "占4.5%，东北最多(10家)"],
                ["客户", "<5万客户", "273家", "—", "—", "—", "占17.3%，月均不足1万"]
            ],
            "pageSize": 25
        }
    ],

    "provenance": {
        "source": "DWS数仓 DM层",
        "lastUpdate": "2026-06-12",
        "skillVersion": "sales-performance-analyst / sales-performance-knowledge",
        "query": "SELECT calmonth, SUM(ambperformance) as actual, SUM(ambperformance_ys) as budget,\n  SUM(ambperformance)/NULLIF(SUM(ambperformance_ys),0)*100 as rate\nFROM dm.dm_fin_operations_mix_sum_t\nWHERE calmonth BETWEEN '2026-01' AND '2026-05'\n  AND data_source IN ('S','T','D','')\nGROUP BY calmonth ORDER BY calmonth;",
        "filters": [
            "数据期间: 2026-01 ~ 2026-05",
            "集团层级: data_source IN ('S','T','D','')",
            "业绩口径: 含税达成额 ambperformance",
            "预算口径: Mix表内置 ambperformance_ys (年初编制)"
        ],
        "limitations": [
            "预算未分解到客户级别，无法计算客户级达成率",
            "预算为年初编制值，不反映年中调整",
            "6月数据不完整(截至6月12日)，未纳入分析",
            "生态新材达成率27.8%可能含试编性质预算"
        ],
        "dataQuality": [
            "dimension字段含异常值(如50000X1200、3000X8等疑似录入错误)",
            "粤西Top物料被单一工程部门主导，零售端被掩盖",
            "部分客户分组为空或缺失"
        ]
    }
}

# ============================================================
# 组装 HTML
# ============================================================
report_json = json.dumps(report, ensure_ascii=False, indent=2)

html = template.replace("{{REPORT_TITLE}}", report["title"])
html = html.replace("{{REPORT_META}}",
    '<span>数据期间：2026-01 ~ 2026-05</span>'
    '<span class="sep"></span>'
    '<span>生成时间：2026-06-12</span>'
    '<span class="sep"></span>'
    '<span>来源：DWS数仓 dm.dm_fin_operations_mix_sum_t</span>')
html = html.replace("{{ECHARTS_LIB}}", "<script>\n" + echarts_lib + "\n</script>")
html = html.replace("{{REPORT_JSON}}", report_json)

with open(OUT, "w", encoding="utf-8") as f:
    f.write(html)

import socket as _socket
_rhost = os.environ.get("REPORT_PUBLIC_URL", "")
if not _rhost:
    try:
        _s = _socket.socket(_socket.AF_INET, _socket.SOCK_DGRAM)
        _s.connect(("10.255.255.255", 1))
        _rhost = f"http://{_s.getsockname()[0]}"
        _s.close()
    except Exception:
        _hn = _socket.gethostname()
        _rhost = f"http://{_hn}" if _hn else "http://localhost"
_rhost = _rhost.rstrip("/")
report_port = os.environ.get("REPORT_PORT", "8080")
report_name = os.path.basename(OUT)

print(f"报告已生成: {OUT}")
print(f"文件大小: {os.path.getsize(OUT) / 1024:.0f} KB")
print(f"\n✅ 报告已生成: reports/{report_name}")
print(f"🌐 在线访问: {_rhost}:{report_port}/{report_name}")


# ============================================================
# 可复用接口：供 webapp 调用
# ============================================================

def assemble_report(report_data: dict, output_path: str, base_dir: str | None = None) -> str:
    """组装 report_data 为 HTML 报告，保存并返回 output_path。

    report_data 格式（遵循 report-generator SKILL.md 规范）：
        title, subtitle, kpis, insight, sections, provenance

    文件保存到 output_path。如果 output_path 不是绝对路径，则相对于 reports/ 目录。
    返回值: (output_path, url) 元组。
    """
    _base = base_dir or os.path.dirname(os.path.abspath(__file__))
    templates_dir = os.path.join(_base, "skills", "report-generator", "templates")

    with open(os.path.join(templates_dir, "report-shell.html"), "r", encoding="utf-8") as f:
        template = f.read()
    with open(os.path.join(templates_dir, "echarts.min.js"), "r", encoding="utf-8") as f:
        echarts_lib = f.read()

    report_json_str = json.dumps(report_data, ensure_ascii=False, indent=2)
    subtitle = report_data.get("subtitle", "")
    provenance = report_data.get("provenance", {})

    html = template.replace("{{REPORT_TITLE}}", report_data.get("title", "分析报告"))
    html = html.replace("{{REPORT_META}}",
        f'<span>{subtitle}</span>'
        f'<span class="sep"></span>'
        f'<span>SQL: {provenance.get("sql", "")[:100]}</span>')
    html = html.replace("{{ECHARTS_LIB}}", "<script>\n" + echarts_lib + "\n</script>")
    html = html.replace("{{REPORT_JSON}}", report_json_str)

    # If output_path is relative, put it under reports/
    if not os.path.isabs(output_path):
        reports_dir = os.path.join(_base, "reports")
        os.makedirs(reports_dir, exist_ok=True)
        output_path = os.path.join(reports_dir, output_path)
    else:
        os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(html)

    # Build URL — IP preferred over hostname for internal network compatibility
    import socket
    report_host = os.environ.get("REPORT_PUBLIC_URL", "")
    if not report_host:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("10.255.255.255", 1))
            ip = s.getsockname()[0]
            s.close()
            report_host = f"http://{ip}"
        except Exception:
            hostname = socket.gethostname()
            report_host = f"http://{hostname}" if hostname else "http://localhost"
    report_host = report_host.rstrip("/")
    report_port = os.environ.get("REPORT_PORT", "8080")
    report_name = os.path.basename(output_path)
    url = f"{report_host}:{report_port}/{report_name}"

    return output_path, url
