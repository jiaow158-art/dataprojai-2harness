import json, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

with open('skills/report-generator/templates/report-shell.html', 'r', encoding='utf-8') as f:
    template = f.read()
with open('skills/report-generator/templates/echarts.min.js', 'r', encoding='utf-8') as f:
    echarts_js = f.read()

# ============ Data ============
kpis = [
    {"label": "同比下滑总量", "value": "-4.14亿", "change": "21.01亿 → 16.87亿", "direction": "down"},
    {"label": "抛釉砖贡献下滑", "value": "78.2%", "change": "-3.24亿 / -4.14亿", "direction": "down"},
    {"label": "零售渠道下滑", "value": "-1.92亿", "change": "占总下滑46.3%", "direction": "down"},
    {"label": "逆势增长品牌", "value": "+0.66亿", "change": "质臻+岩萃+四合一", "direction": "up"},
]

insight = (
    "瓷砖事业部2026年1-5月含税达成额同比下滑 4.14亿（-19.7%）。"
    "归因分析定位到单一核心问题：抛釉砖品类市场萎缩，该品类贡献了总下滑量的 78.2%。"
    "零售渠道×抛釉砖的组合是最大失血点（-1.48亿，占35.6%）。"
    "品牌端天然理石断崖下跌（-43.8%），未分类产品占比 36.7% 且无品牌归属。"
    "增长点（质臻/岩萃/四合一）合计仅 +0.66亿，远不够对冲下滑。"
)

# Chart 1: Category attribution (full width, grouped bar)
chart1 = {
    "title": "品类归因：2025 vs 2026 同期达成对比",
    "option": {
        "tooltip": {
            "trigger": "axis",
            "axisPointer": {"type": "shadow"},
            "formatter": "function(params) { var s = params[0].name + '<br/>'; for(var i=0;i<params.length;i++){s+=params[i].marker+' '+params[i].seriesName+': '+(params[i].value).toFixed(2)+'亿<br/>';} return s; }",
            "backgroundColor": "rgba(255,255,255,0.95)", "borderColor": "#e0e0e0",
            "textStyle": {"color": "#333", "fontSize": 13}
        },
        "legend": {"data": ["2025年1-5月", "2026年1-5月"], "top": 0},
        "toolbox": {"feature": {"saveAsImage": {"title": "保存为图片"}}, "right": 20},
        "grid": {"left": "3%", "right": "8%", "bottom": "12%", "top": "15%", "containLabel": True},
        "color": ["#91cc75", "#5470c6"],
        "xAxis": {
            "type": "category",
            "data": ["抛釉砖", "仿古砖", "精瓷中板", "瓷片", "玻化砖", "瓷砖配套", "墙板", "岩板"],
            "axisLabel": {"rotate": 30, "fontSize": 11}
        },
        "yAxis": {
            "type": "value", "name": "金额（亿）",
            "axisLabel": {"formatter": "function(v){return v.toFixed(1)+'亿'}"}
        },
        "series": [
            {"name": "2025年1-5月", "type": "bar",
             "data": [11.52, 6.10, 1.97, 1.06, 0.29, 0.19, 0.10, 0.09],
             "itemStyle": {"borderRadius": [4,4,0,0], "opacity": 0.7}},
            {"name": "2026年1-5月", "type": "bar",
             "data": [8.28, 5.25, 1.46, 0.59, 0.17, 0.17, 0.11, 0.07],
             "itemStyle": {"borderRadius": [4,4,0,0]},
             "label": {"show": True, "position": "top",
                       "formatter": "function(p){return (p.value - [11.52,6.10,1.97,1.06,0.29,0.19,0.10,0.09][p.dataIndex]).toFixed(2)+'亿'}",
                       "fontSize": 10, "color": "#e55958"}}
        ]
    }
}

# Chart 2: Channel attribution (horizontal bar)
chart2 = {
    "title": "渠道归因：下滑量分布",
    "option": {
        "tooltip": {
            "trigger": "axis", "axisPointer": {"type": "shadow"},
            "formatter": "function(p){return p[0].name+': '+p[0].value.toFixed(2)+'亿'}",
            "backgroundColor": "rgba(255,255,255,0.95)", "borderColor": "#e0e0e0",
            "textStyle": {"color": "#333", "fontSize": 13}
        },
        "toolbox": {"feature": {"saveAsImage": {"title": "保存为图片"}}, "right": 10},
        "grid": {"left": "3%", "right": "15%", "bottom": "8%", "top": "10%", "containLabel": True},
        "color": ["#ee6666"],
        "xAxis": {"type": "value", "name": "变化量（亿）",
                  "axisLabel": {"formatter": "function(v){return v.toFixed(1)+'亿'}"}},
        "yAxis": {"type": "category", "data": ["整装", "工程", "零售"],
                  "axisLabel": {"fontSize": 12}},
        "series": [{
            "name": "下滑量", "type": "bar",
            "data": [-0.91, -1.31, -1.92],
            "itemStyle": {"borderRadius": [0,4,4,0], "color": "function(p){return p.dataIndex===2?'#ee6666':'#fac858'}"},
            "label": {"show": True, "position": "right",
                      "formatter": "function(p){return p.value.toFixed(2)+'亿 ('+[22.1,31.6,46.3][p.dataIndex]+'%)'}",
                      "fontSize": 11}
        }]
    }
}

# Chart 3: Brand attribution (horizontal bar)
chart3 = {
    "title": "品牌归因：下滑量 Top 8",
    "option": {
        "tooltip": {
            "trigger": "axis", "axisPointer": {"type": "shadow"},
            "formatter": "function(p){return p[0].name+': '+p[0].value.toFixed(2)+'亿'}",
            "backgroundColor": "rgba(255,255,255,0.95)", "borderColor": "#e0e0e0",
            "textStyle": {"color": "#333", "fontSize": 13}
        },
        "toolbox": {"feature": {"saveAsImage": {"title": "保存为图片"}}, "right": 10},
        "grid": {"left": "3%", "right": "15%", "bottom": "8%", "top": "10%", "containLabel": True},
        "color": ["#ee6666"],
        "xAxis": {"type": "value", "name": "变化量（亿）",
                  "axisLabel": {"formatter": "function(v){return v.toFixed(1)+'亿'}"}},
        "yAxis": {"type": "category",
                  "data": ["净奢石", "微韵石", "素色", "天然理石", "(未分类)"],
                  "axisLabel": {"fontSize": 11}},
        "series": [{
            "name": "下滑量", "type": "bar",
            "data": [-0.30, -0.39, -0.62, -1.40, -1.73],
            "itemStyle": {"borderRadius": [0,4,4,0]},
            "label": {"show": True, "position": "right",
                      "formatter": "function(p){return p.value.toFixed(2)+'亿'}",
                      "fontSize": 10}
        }]
    }
}

# Chart 4: Cross dimension (full width, horizontal bar)
chart4 = {
    "title": "渠道 × 品类交叉归因：下滑量 Top 10",
    "option": {
        "tooltip": {
            "trigger": "axis", "axisPointer": {"type": "shadow"},
            "formatter": "function(p){return p[0].name+': '+p[0].value.toFixed(2)+'亿'}",
            "backgroundColor": "rgba(255,255,255,0.95)", "borderColor": "#e0e0e0",
            "textStyle": {"color": "#333", "fontSize": 13}
        },
        "toolbox": {"feature": {"saveAsImage": {"title": "保存为图片"}}, "right": 20},
        "grid": {"left": "3%", "right": "12%", "bottom": "8%", "top": "10%", "containLabel": True},
        "color": ["#5470c6"],
        "xAxis": {"type": "value", "name": "变化量（亿）",
                  "axisLabel": {"formatter": "function(v){return v.toFixed(1)+'亿'}"}},
        "yAxis": {"type": "category",
                  "data": ["工程×精瓷中板", "工程×水磨石", "工程×玻化砖", "整装×精瓷中板",
                           "整装×仿古砖", "零售×精瓷中板", "工程×瓷片", "整装×抛釉砖",
                           "工程×抛釉砖", "零售×抛釉砖"],
                  "axisLabel": {"fontSize": 11}},
        "series": [{
            "name": "下滑量", "type": "bar",
            "data": [-0.035, -0.036, -0.096, -0.104, -0.122, -0.368, -0.425, -0.630, -1.128, -1.478],
            "itemStyle": {"borderRadius": [0,4,4,0],
                          "color": "function(p){var v=Math.abs(p.value);if(v>1)return '#ee6666';if(v>0.4)return '#fac858';return '#5470c6'}"},
            "label": {"show": True, "position": "right",
                      "formatter": "function(p){return p.value.toFixed(2)+'亿'}",
                      "fontSize": 10}
        }]
    }
}

# Table
table = {
    "title": "瓷砖事业部 1-5月同比归因明细",
    "columns": ["维度", "分类", "2026年", "2025年", "变化量", "同比"],
    "rows": [
        ["渠道", "零售 GD01", "7.40亿", "9.32亿", "-1.92亿", "-20.6%"],
        ["渠道", "工程 GD03", "7.22亿", "8.53亿", "-1.31亿", "-15.3%"],
        ["渠道", "整装 GD02", "2.24亿", "3.15亿", "-0.91亿", "-29.0%"],
        ["品类", "抛釉砖", "8.28亿", "11.52亿", "-3.24亿", "-28.1%"],
        ["品类", "精瓷中板", "1.46亿", "1.97亿", "-0.51亿", "-25.8%"],
        ["品类", "瓷片", "0.59亿", "1.06亿", "-0.47亿", "-44.5%"],
        ["品类", "玻化砖", "0.17亿", "0.29亿", "-0.12亿", "-41.0%"],
        ["品牌↓", "(未分类)", "6.31亿", "8.05亿", "-1.73亿", "-21.6%"],
        ["品牌↓", "天然理石", "1.79亿", "3.19亿", "-1.40亿", "-43.8%"],
        ["品牌↓", "素色", "1.18亿", "1.81亿", "-0.62亿", "-34.4%"],
        ["品牌↓", "微韵石", "0.94亿", "1.33亿", "-0.39亿", "-29.5%"],
        ["品牌↓", "净奢石", "0.61亿", "0.91亿", "-0.30亿", "-33.0%"],
        ["品牌↑", "质臻", "0.61亿", "0.39亿", "+0.22亿", "+56.0%"],
        ["品牌↑", "岩萃", "0.26亿", "0.04亿", "+0.22亿", "+533%"],
        ["品牌↑", "四合一", "0.81亿", "0.66亿", "+0.15亿", "+23.4%"],
        ["区域", "广东", "2.92亿", "4.08亿", "-1.16亿", "-28.5%"],
        ["区域", "江苏", "1.01亿", "1.49亿", "-0.48亿", "-32.0%"],
        ["区域", "河北", "0.73亿", "1.10亿", "-0.37亿", "-33.7%"],
        ["区域", "安徽", "0.77亿", "1.13亿", "-0.36亿", "-32.3%"],
        ["区域", "浙江", "0.98亿", "1.30亿", "-0.32亿", "-24.7%"],
    ],
    "pageSize": 20
}

provenance = {
    "source": "DWS数据仓库",
    "table": "dm.dm_fin_operations_mix_sum_t",
    "lastUpdate": "2026-06-10",
    "skillVersion": "sales-performance-analyst / report-generator",
    "limitations": [
        "数据截止2026-05-31",
        "受春节移位影响1-2月",
        "面积/单价维度未拆分",
        "同表CASE WHEN跨年对比"
    ]
}

# ============ Build report JSON (matching template's expected structure) ============
report_json = {
    "title": "瓷砖事业部 2026年业绩下滑归因分析",
    "subtitle": "2026年1-5月 vs 2025年同期 | 总下滑 -4.14亿 (-19.7%)",
    "kpis": kpis,
    "insight": insight,
    "sections": [
        {
            "tab": "品类归因",
            "type": "chart-with-analysis",
            "chart": [chart1],
            "analysis": [
                {"label": "核心发现", "color": "pink",
                 "text": "抛釉砖单一品类贡献总下滑量的78.2%（-3.24亿），是绝对核心问题。仿古砖下滑-0.85亿居次席。"},
                {"label": "次要品类", "color": "blue",
                 "text": "精瓷中板(-0.51亿)、瓷片(-0.47亿)、玻化砖(-0.12亿)均下滑，但体量较小。"}
            ]
        },
        {
            "tab": "渠道×品牌",
            "type": "chart-with-analysis",
            "chart": [chart2, chart3],
            "analysis": [
                {"label": "渠道视角", "color": "cyan",
                 "text": "零售渠道贡献总下滑的46.3%（-1.92亿），是最大失血渠道。工程(-1.31亿)和整装(-0.91亿)紧随其后。"},
                {"label": "品牌视角", "color": "pink",
                 "text": "天然理石品牌断崖下跌-43.8%（-1.40亿）。未分类产品占36.7%且无品牌归属，管理真空。"}
            ]
        },
        {
            "tab": "交叉归因",
            "type": "chart-with-analysis",
            "chart": [chart4],
            "analysis": [
                {"label": "最大失血点", "color": "pink",
                 "text": "零售×抛釉砖是最大单一交叉点（-1.48亿，占35.6%），其次是工程×抛釉砖（-1.13亿）。"},
                {"label": "增长亮点", "color": "blue",
                 "text": "质臻(+56.0%)、岩萃(+533%)、四合一(+23.4%)逆势增长，但合计+0.66亿远不够对冲-4.14亿下滑。"}
            ]
        },
        {
            "tab": "归因明细",
            "type": "table",
            "table": table
        }
    ],
    "provenance": provenance
}

# ============ Build HTML ============
report_json_str = json.dumps(report_json, ensure_ascii=False, indent=2)

html = template
html = html.replace('{{REPORT_TITLE}}', '瓷砖事业部 2026年业绩下滑归因分析')
html = html.replace('{{REPORT_META}}', '2026年1-5月 vs 2025年同期 | 生成时间: 2026-06-10 | 总下滑 -4.14亿 (-19.7%)')
html = html.replace('{{ECHARTS_LIB}}', f'<script>{echarts_js}</script>')
html = html.replace('{{REPORT_JSON}}', report_json_str)

output_path = 'report_attribution_ceramic_20260610.html'
with open(output_path, 'w', encoding='utf-8') as f:
    f.write(html)

import os
size_kb = os.path.getsize(output_path) / 1024
print(f'OK: {output_path} ({size_kb:.0f} KB)')
