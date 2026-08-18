---
name: report-generator
description: 跨域报告生成工具。当用户在收到 Analyst 输出后说"生成报告"、"导出 HTML"、"做个报告"、"生成 HTML 报告"、"转成 HTML"等关键词时自动激活。写纯 JSON（valueFormat 声明，无 JS 函数）→ build.py 一条命令出报告。严禁旧 charts[]/扁平table/trace 格式与任何 JS 函数串。
---

# Report Generator

将 Analyst 的 Markdown 查询结果转换为独立可分享的深色主题 HTML 报告（内嵌 ECharts、AI 分析文字、数据溯源）。

> **⛔ 协议红线**：报告数据是**纯 JSON**——不允许任何 JS 函数串（`formatter`/`symbolSize`/`color` 函数一律改用 `valueFormat` 声明）。不允许旧 `charts[]`/扁平 `table`/`trace` 顶层字段。违反任一条，validator 直接拒绝、不产出 HTML。

## 触发条件

**被动调用**：仅在用户明确说以下关键词时激活：
- "生成报告"
- "导出 HTML"
- "转成 HTML 报告"
- "生成 HTML"
- "做个报告"

不影响现有对话式分析流程。用户在收到 Analyst 的 Markdown 结果后，主动要求才触发。

## 适用范围

跨域工具。可用于所有 4 个已覆盖业务域：
- fin-cost（财务费用）
- inventory（库存仓储）
- ar（应收账款）
- sales-performance（销售业绩）

## 视觉风格

深色商务主题（Dark Pro）——深蓝/深紫底色 + 渐变高亮。报告离线可打开，可直接分享。

## 快速开始（唯一工作流）

1. **读契约**：`references/report-schema.json`（结构契约）+ 本文件 valueFormat 表（数值格式协议）
2. **写 report.json**：纯 JSON，零 JS 函数。
   - 顶层五字段：`title` / `kpis` / `insight` / `sections` / `provenance`
   - 每个 chart 必须有 `valueFormat`
   - 表格用嵌套式 `table: { title, columns, rows, pageSize }`
   - `provenance` 必须有 `query`（完整 SQL，供审计）
3. **一条命令构建**：
   ```bash
   python3 skills/report-generator/scripts/build.py --json report.json --domain sales-performance
   ```
   - 校验不过 → 逐条打印 `[FAIL] 字段路径: 原因`，修完重跑；不通过不出 HTML
   - 通过 → 产物写入 `reports/report_{domain}_{YYYYMMDD}.html`（目录自动创建）
   - build.py 自动检测报告服务器：在跑则打印 URL，未跑则只给本地路径（不给假 URL）
   - Windows 下用 `python`；服务器用 `/usr/bin/python3`

## valueFormat 格式声明表（核心协议）

数值一律以**原始数值**传入 series.data，展示格式用 `valueFormat` 字符串声明，模板按就近作用域把格式声明装配为 ECharts formatter。可带 `:N` 覆盖小数位。

| 声明 | 示例输出 | 说明 |
|------|----------|------|
| `yi` / `yi:1` | `5.05亿` / `5.1亿` | 亿量纲，默认 2 位小数 |
| `wan` / `wan:1` | `4,728万` / `4,728.5万` | 万量纲，整数部分千分位 |
| `percent` | `26.2%` | 默认 1 位小数 |
| `signed_percent` | `+6.9%` / `-19.3%` | 带符号，默认 1 位小数 |
| `sqm_wan` | `120.5万㎡` | 面积，万㎡ 量纲 |
| `yuan` | `334,080,608元` | 千分位整数元 |
| `int` / `int:1` | `1,234` / `1,234.5` | 千分位整数无单位（天数/排名/计数） |

**tooltipTemplate**（chart 可选字段）：
- `multi`（默认）：多系列悬停，逐系列列值
- `pie`：`名称: 3.4亿 (26%)` 带占比

**作用域（v2.1）**：`chart.valueFormat` 为图级默认；`series[].valueFormat`、`yAxis[].valueFormat` 就近覆盖（帕累托：柱 yi + 线 percent 双轴双格式）。表格单元格支持条件着色：`字符串` 或 `{"v": "...", "tone": "good|warn|bad|na"}`（绿/黄/红/灰）。高级图表（帕累托/四象限气泡/热力图/瀑布）的完整 option 配方见 [references/chart-recipes.md](references/chart-recipes.md)。

⛔ 数据里不允许任何 JS 函数：`formatter`/`symbolSize`/`color` 函数一律改用 `valueFormat` 声明，旧函数串被 validator 黑名单直接拒绝。

## 生成前思考

收到 Analyst 的 Markdown 输出后，先思考再写 JSON：

1. **读懂**数据维度、量级、时间跨度
2. **提炼** 1-3 条核心结论：趋势是什么、有什么异常、风险在哪
3. **识别**数据质量问题：空值、异常值、缺失维度、可疑统计口径（写入 `provenance.dataQuality`）
4. **构思**叙事结构：分几个 Tab，每个 Tab 讲什么故事

这一步的思考不写入报告，但指导 JSON 的组装。分析文字（`analysis[]`）必须带具体数字和判断，不写空话；风险提示用粉色（`pink`），正面信号蓝色（`blue`），中性观察青色（`cyan`），每个 Tab 建议 2 条、不超过 3 条。

## REPORT_JSON v2 结构

**⛔ 错误示例（旧格式，validator 拒绝）**：
```json
// ❌ 绝对禁止：顶层 charts[]/table/trace、扁平表格列、任何函数串
{
  "title": "...",
  "charts": [{ "id": "...", "option": {} }],
  "table": { "columns": [], "rows": [] },
  "trace": { "table": "...", "sql": "..." }
}
```

**✅ 正确示例（唯一允许的格式）**：
```json
{
  "title": "报告标题",
  "subtitle": "2026-01 ~ 2026-05 | 生成: 2026-06-10",
  "kpis": [
    { "label": "指标名", "value": "16.87亿", "change": "vs 预算 -21.9%", "direction": "down" }
  ],
  "insight": "1-3句核心结论，带具体数字。风险用红色标注。",
  "sections": [
    {
      "id": "trend",
      "tab": "趋势分析",
      "type": "chart-with-analysis",
      "chart": {
        "id": "chart-trend",
        "title": "月度趋势",
        "valueFormat": "yi:2",
        "tooltipTemplate": "multi",
        "option": {
          "xAxis": { "type": "category", "data": ["1月", "2月", "3月"] },
          "yAxis": { "type": "value" },
          "series": [{ "name": "达成额", "type": "line", "data": [505000000, 420000000, 427000000] }]
        }
      },
      "analysis": [
        { "label": "趋势判断", "color": "blue", "text": "具体分析文字..." },
        { "label": "风险提示", "color": "pink", "text": "具体风险描述..." }
      ]
    },
    {
      "id": "data",
      "tab": "明细数据",
      "type": "table",
      "table": {
        "title": "区域明细",
        "columns": ["区域", "达成额", "同比"],
        "rows": [["北京", "7,692万", "+26.4%"]],
        "pageSize": 20
      }
    }
  ],
  "provenance": {
    "source": "表名",
    "lastUpdate": "更新日期",
    "skillVersion": "skill名",
    "query": "SELECT ... （完整 SQL）",
    "filters": [],
    "limitations": [],
    "dataQuality": []
  }
}
```

**sections[].type 说明**：
- `chart-with-analysis`：图表 + 分析文字，chart 可以是单个对象或数组（2 个图并排），每个 chart 必须有 `valueFormat`
- `table`：数据明细表，嵌套式 `table` 对象，带分页

## Report Server（报告 HTTP 服务器）

生成的 HTML 报告通过 `report_server.py` 对外提供 HTTP 访问。用户无需下载文件，直接通过浏览器打开 URL。

### 启动服务器

```bash
# 默认端口 8080
python report_server.py

# 自定义端口
REPORT_PORT=8888 python report_server.py

# 后台运行（Linux）
nohup python report_server.py > /dev/null 2>&1 &

# 后台运行（Windows）
start /B python report_server.py
```

### 服务器功能

| 路径 | 功能 |
|------|------|
| `http://host:8080/` | 报告目录首页，列出所有报告 |
| `http://host:8080/report_xxx.html` | 单个报告 |
| `http://host:8080/health` | 健康检查 |
| `http://host:8080/api/reports` | JSON 格式报告列表 |

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `REPORT_PUBLIC_URL` | 自动检测 | 用户访问报告的基础 URL，如 `http://192.168.18.231:8080` |
| `REPORT_HOST` | `0.0.0.0` | 服务器绑定地址 |
| `REPORT_PORT` | `8080` | 监听端口 |
| `REPORT_DIR` | `./reports` | 报告文件目录 |

### 相关工具

| 工具 | 位置 | 用途 |
|------|------|------|
| `report_server.py` | 项目根目录 | HTTP 静态文件服务器，serve `reports/` 目录 |
| `reports/` | 项目根目录 | 所有生成的 HTML 报告统一存放目录 |

### 服务器运维

```bash
# 检查服务器是否在运行
curl http://localhost:8080/health

# 查看所有报告（JSON）
curl http://localhost:8080/api/reports

# 重启服务器
pkill -f report_server.py && python report_server.py &
```

## 生产服务器部署

```bash
# 服务器（/home/dp-user/dataprojv2）
git pull
python3 skills/report-generator/scripts/build.py --selftest
```

`SELFTEST PASS` 即环境就绪（模板、validator、ECharts 内嵌全链路通过）。

## 关键规则

1. **数据纯 JSON、零 JS 函数**；chart 必须有 `valueFormat`
2. **validator 不过不出 HTML**；错误带字段路径，按行修
3. **表格嵌套式** `section.table`；`provenance.query` 必填
4. **最多 4 个图表 Tab + 1 个明细 Tab**；单图数据点 ≤200
5. **饼图分类 ≤8**（超出归"其他"）；大表 >50 行分页
6. **ECharts 本地内嵌**（`templates/echarts.min.js`），离线可开
7. **build.py 自动校验 + 复验**；server 未起只给路径，不给假 URL

## 图表配方（v2.1）

SKU 效益等分析报告的帕累托、四象限气泡、热力图、瀑布图，直接套用 [references/chart-recipes.md](references/chart-recipes.md) 的 option 模板（纯 JSON、逐点 symbolSize 预计算、声明式 markLine）。数据点超 200 先 TOP-N。

## 已废弃脚本

`build_report.py`、`scripts/` 下 6 个报表脚本（`build_dealer_report.py`、`build_mom_report.py`、`build_sales_report.py`、`gen_report.py`、`generate_report.py`、`generate_sales_report.py`）及 `scripts/test_report.py` 均为历史产物（硬编码数据/路径），仅作参考，勿在新报告使用。新报告一律走 `scripts/build.py`。
