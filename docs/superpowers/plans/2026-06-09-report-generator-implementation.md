# Report Generator Skill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a cross-domain utility Skill that converts Analyst Markdown output into standalone HTML reports with embedded ECharts charts.

**Architecture:** A single Skill directory at `skills/report-generator/` with `SKILL.md` (5-step workflow), `references/` (chart decision logic, ECharts patterns, layout templates), and `templates/` (pre-designed HTML shell with embedded ECharts). Passive invocation — only triggered when user explicitly requests HTML report generation.

**Tech Stack:** ECharts 5.x (embedded, minified), vanilla HTML/CSS/JS (no framework), Chart.js as lightweight fallback for simple charts.

---

## File Structure

```
skills/report-generator/
├── SKILL.md                     # 5-step workflow: Parse → Match → Configure → Assemble → Render
├── references/
│   ├── chart-decision.md        # Decision tree: data characteristics → chart type
│   ├── echarts-patterns.md      # ECharts option skeletons for each chart type
│   └── layout.md                # Page layout templates (overview / trend / detail)
└── templates/
    └── report-shell.html        # HTML skeleton with embedded ECharts + theme CSS + render script
```

**Design decisions:**
- `references/` follows existing skill conventions (same as `ar-knowledge/references/` etc.)
- `templates/` is a new directory type — static assets that the Skill reads and fills
- Single Skill (not paired knowledge+analyst) because there's no data source to query
- `report-shell.html` is designed once with `frontend-design` skill, not generated at runtime

---

### Task 1: Create directory structure

**Files:**
- Create: `skills/report-generator/`
- Create: `skills/report-generator/references/`
- Create: `skills/report-generator/templates/`

- [ ] **Step 1: Create directories**

```bash
mkdir -p D:/dataproj/skills/report-generator/references
mkdir -p D:/dataproj/skills/report-generator/templates
```

Verify:
```bash
ls -la D:/dataproj/skills/report-generator/
# Expected: two subdirs: references/ and templates/
```

---

### Task 2: Write chart decision reference (`chart-decision.md`)

**Files:**
- Create: `skills/report-generator/references/chart-decision.md`

- [ ] **Step 1: Write `chart-decision.md`**

```markdown
# 图表类型决策树

根据数据特征自动选择最合适的图表类型。本文档是 Claude 在 Step 2（匹配图表类型）时的判断指南。

## 决策流程

```
输入数据
  ├─ 有时间列（日期/月份/年份）？
  │   ├─ 是 → 折线图 (line)
  │   │   └─ 多系列（≥2条线）？ → 多系列折线图，加 legend
  │   └─ 否 → 继续
  ├─ 有分类列（部门/客户/物料/区域）？
  │   ├─ 是 + 分类数 ≤15 → 柱状图 (bar)，横向或纵向
  │   │   └─ 有对比系列（预算 vs 实际、同比）？ → 分组柱状图
  │   ├─ 是 + 分类数 >15 → 取 TOP10-15，其余归"其他"
  │   └─ 否 → 继续
  ├─ 数值列代表占比（总和=100%有意义）？
  │   ├─ 是 + 分类数 ≤8 → 饼图 (pie)
  │   └─ 否 → 继续
  └─ 以上都不匹配 → 数据表 (table)
       └─ 数据量 >50 行 → 分页表格 + 汇总行
```

## 图表类型速查表

| 数据特征 | 图表类型 | ECharts series.type | 示例场景 | 注意事项 |
|----------|---------|--------------------|---------|---------|
| 时间序列（单系列） | 折线图 | `line` | 月度费用趋势、应收余额走势 | X 轴必须是时间，按时间排序 |
| 时间序列（多系列） | 多系列折线图 | `line`（多条 series） | 预算 vs 实际月度对比 | 每条 series 一个 name，legend 自动生成 |
| 分类排行 | 柱状图 | `bar` | TOP10 客户逾期金额、各部门费用 | 横向柱状图 (`xAxis.type='value'`, `yAxis.type='category'`) 适合长标签 |
| 分组对比 | 分组柱状图 | `bar`（多条 series） | 各事业部预算 vs 实际 | 最多 3-4 个系列，再多改用折线图 |
| 占比构成 | 饼图 | `pie` | 费用构成、渠道占比、库龄分布 | 分类数 ≤8，超出归"其他" |
| 明细数据 | 表格 | N/A（HTML table） | 明细账、清单、原始数据 | >50 行加分页；数值列右对齐 |

## 边界情况处理

| 情况 | 处理方式 |
|------|---------|
| 只有 1 行数据 | 用 KPI 卡片展示大数字，不画图 |
| 数值全为 0 或 NULL | 表格展示原始数据，附说明"数据全为零或缺失" |
| 分类数 >15 | 柱状图只取 TOP10（或 TOP15），其余汇总为"其他" |
| 时间跨度 >60 个点 | 折线图按周/月聚合；dataZoom 默认开启底部滑杆 |
| 数值量级差异过大（>100x） | 双 Y 轴 (`yAxisIndex: 0/1`) |
| 存在负值 | 不使用饼图；柱状图/折线图正常展示 |
| 数据是百分比 | 饼图直接使用；柱状图 Y 轴加 `%` 后缀 |

## 多图表组合规则

- 一个报告最多 4 个图表区块 + 1 个数据表
- 趋势图放最上方（全宽），构成/排行放第二行（半宽并排）
- 数据表放最下方（全宽）
- 如果数据同时满足时间序列和分类排行 → 趋势图 + 排行图各一个
```

---

### Task 3: Write ECharts patterns reference (`echarts-patterns.md`)

**Files:**
- Create: `skills/report-generator/references/echarts-patterns.md`

- [ ] **Step 1: Write `echarts-patterns.md`**

````markdown
# ECharts 配置模式库

每种图表类型的 ECharts option 骨架。Claude 在 Step 3（生成图表配置）时：
1. 根据 Step 2 选定的图表类型，找到对应的 option 骨架
2. 将实际数据填入 `series`、`xAxis.data`、`yAxis` 等字段
3. 标题、颜色、tooltip 格式按需微调

## 通用配置（所有图表类型共用）

```javascript
// 所有 option 都包含以下基础配置
{
  tooltip: {
    trigger: 'axis',        // 或 'item'（饼图用）
    formatter: '{b}: {c}',  // 按需覆盖为带单位的格式
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderColor: '#e0e0e0',
    textStyle: { color: '#333', fontSize: 13 }
  },
  toolbox: {
    feature: {
      saveAsImage: { title: '保存为图片' },
      dataView: { title: '数据视图', readOnly: true }
    },
    right: 20
  },
  grid: {
    left: '3%',
    right: '8%',
    bottom: '15%',
    top: '15%',
    containLabel: true
  },
  color: ['#5470c6', '#91cc75', '#fac858', '#ee6666', '#73c0de', '#3ba272', '#fc8452', '#9a60b4']
}
```

## Pattern 1: 折线图 (line)

适用于：时间序列趋势。

```javascript
{
  tooltip: { trigger: 'axis' },
  xAxis: {
    type: 'category',
    data: [/* 日期数组，如 ['2026-01', '2026-02', ...] */],
    axisLabel: { rotate: 0 },
    name: '/* 时间单位，如 "月份" */'
  },
  yAxis: {
    type: 'value',
    name: '/* 数值单位，如 "金额（元）" */',
    axisLabel: {
      formatter: function(v) { return (v / 10000).toFixed(0) + '万'; }
      // 按数值量级调整：百万级用 v/1000000+'百万'，亿级用 v/100000000+'亿'
    }
  },
  series: [{
    name: '/* 系列名称 */',
    type: 'line',
    data: [/* 数值数组，顺序对应 xAxis.data */],
    smooth: true,
    symbol: 'circle',
    symbolSize: 6,
    markLine: {
      silent: true,
      data: [{ type: 'average', name: '均值' }]
    }
  }],
  dataZoom: [{
    // 仅当 xAxis 数据点 > 12 时启用
    type: 'slider',
    start: 0,
    end: 100,
    height: 20,
    bottom: 0
  }]
}
```

**多系列变体**：`series` 数组包含多个对象，每个对象 `name` 不同，legend 自动生成。

## Pattern 2: 柱状图 (bar)

适用于：分类排行、分组对比。

```javascript
{
  tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
  xAxis: {
    type: 'category',
    data: [/* 分类数组，如 ['瓷砖事业部', '卫浴事业部', ...] */],
    axisLabel: {
      rotate: 45,           // 标签 >4 个字时旋转
      interval: 0           // 显示所有标签
    }
  },
  yAxis: {
    type: 'value',
    name: '/* 数值单位 */',
    axisLabel: {
      formatter: function(v) { return (v / 10000).toFixed(0) + '万'; }
    }
  },
  series: [{
    name: '/* 系列名称 */',
    type: 'bar',
    data: [/* 数值数组 */],
    itemStyle: { borderRadius: [4, 4, 0, 0] },
    label: {
      show: true,
      position: 'top',
      formatter: function(p) { return (p.value / 10000).toFixed(1) + '万'; }
    }
  }]
}
```

**横向柱状图变体**（适合长标签，如客户名称）：
- 交换 xAxis/yAxis 的 type：`yAxis: { type: 'category', data: [...] }`，`xAxis: { type: 'value' }`
- `label.position` 改为 `'right'`

**分组柱状图变体**（多系列对比）：
- `series` 数组多个 `{ type: 'bar', name: '...', data: [...] }`
- `legend: { data: ['系列1', '系列2', ...] }`

## Pattern 3: 饼图 (pie)

适用于：占比构成。

```javascript
{
  tooltip: {
    trigger: 'item',
    formatter: '{b}: {c} ({d}%)'
  },
  legend: {
    type: 'scroll',
    orient: 'vertical',
    right: 10,
    top: 'middle'
  },
  series: [{
    name: '/* 分类名称 */',
    type: 'pie',
    radius: ['40%', '70%'],    // 环形图；实心饼图用 '70%'
    center: ['40%', '50%'],    // 给 legend 留空间
    data: [
      { value: 1234567, name: '分类A' },
      { value: 2345678, name: '分类B' }
      // ... 每个分类 { value, name }
    ],
    label: {
      formatter: '{b}: {d}%'
    },
    emphasis: {
      itemStyle: { shadowBlur: 10, shadowOffsetX: 0, shadowColor: 'rgba(0,0,0,0.5)' }
    }
  }]
}
```

**约束**：分类数 ≤8，超出归"其他"。只有一个分类时不用饼图，用 KPI 卡片。

## Pattern 4: 数据表 (table)

适用于：明细数据，不适合画图。

```html
<div class="table-wrapper">
  <table class="data-table">
    <thead>
      <tr>
        <!-- 表头，从数据列名生成，中文优先 -->
        <th>序号</th>
        <th>分类</th>
        <th class="num">金额（元）</th>
      </tr>
    </thead>
    <tbody>
      <!-- 
        数据行：
        - 数值列加 class="num"（右对齐，千分位）
        - 每行第一个 <td> 是序号（从 1 开始）
        - >50 行启用分页控件
      -->
      <tr>
        <td>1</td>
        <td>销售一部</td>
        <td class="num">12,345,678.00</td>
      </tr>
    </tbody>
  </table>
  <!-- >50 行时显示分页 -->
  <div class="pagination">
    <button class="page-btn active">1</button>
    <button class="page-btn">2</button>
    ...
  </div>
</div>
```

分页逻辑由 `report-shell.html` 中的脚本处理，此处只需生成完整 `<tbody>`，脚本自动分页。

## Pattern 5: KPI 指标卡片 (kpi)

适用于：单行汇总数据。

```html
<div class="kpi-cards">
  <div class="kpi-card">
    <div class="kpi-label">/* 指标名称，如"费用总额" */</div>
    <div class="kpi-value">/* 大数字，如"12.35亿" */</div>
    <div class="kpi-change positive">↑ 12.5%</div>  <!-- positive/negative/none -->
  </div>
  <!-- 最多 6 个卡片并排 -->
</div>
```

**数值格式化规则**：
- 万元以下：显示原始值（如 `123,456.00`）
- 万级：`XX.XX万`
- 千万/亿级：`XX.XX亿`
- 百分比：保留 1 位小数

## 交互配置速查

```javascript
// dataZoom — 底部滑杆（时间序列 >12 点时启用）
dataZoom: [{ type: 'slider', start: 0, end: 100, height: 20, bottom: 0 }]

// toolbox — 工具栏（所有图表都加）
toolbox: { feature: { saveAsImage: {}, dataView: { readOnly: true } }, right: 20 }

// tooltip 单位格式化
tooltip: { formatter: function(params) { return params[0].name + ': ' + (params[0].value/10000).toFixed(2) + '万'; } }
```
````

---

### Task 4: Write layout reference (`layout.md`)

**Files:**
- Create: `skills/report-generator/references/layout.md`

- [ ] **Step 1: Write `layout.md`**

```markdown
# 报告布局模板

报告页面的区块组织方式。Claude 在 Step 4（组装报告结构）时根据数据特征选择布局。

## 布局选择决策

```
输入数据特征
  ├─ 有 KPI 汇总指标（单行总计/均值）？ → 概览版
  ├─ 以时间趋势为主（折线图是核心）？ → 趋势版
  └─ 以明细数据为主（大表格是核心）？ → 明细版
```

## 布局 1: 概览版 (overview)

适用：同时有 KPI 汇总 + 趋势图 + 构成图。

```
┌──────────────────────────────────┐
│           报告标题                │
│         生成时间 / 数据期间       │
├──────────┬──────────┬────────────┤
│ KPI 卡片1 │ KPI 卡片2 │ KPI 卡片3  │  ← 最多 6 个
├──────────┴──────────┴────────────┤
│                                   │
│         全宽趋势图 (line)          │  ← 第一个图表，全宽
│                                   │
├─────────────────┬─────────────────┤
│   半宽柱状图     │   半宽饼图      │  ← 排行 + 构成，并排
│   (bar)        │   (pie)        │
├─────────────────┴─────────────────┤
│         数据表（可折叠）           │  ← 底部明细
├──────────────────────────────────┤
│         溯源脚注                  │
└──────────────────────────────────┘
```

**配置 JSON 结构**：
```json
{
  "layout": "overview",
  "kpis": [
    { "label": "费用总额", "value": "12.35亿", "change": "+12.5%", "direction": "up" }
  ],
  "charts": [
    { "type": "line", "title": "月度趋势", "span": "full", "option": {...} },
    { "type": "bar", "title": "TOP10部门", "span": "half", "option": {...} },
    { "type": "pie", "title": "费用构成", "span": "half", "option": {...} }
  ]
}
```

**span 规则**：`full` = 占满一行, `half` = 半宽（两个并排）。

## 布局 2: 趋势版 (trend)

适用：核心是一个大趋势图，辅以 1-2 个小图表。

```
┌──────────────────────────────────┐
│           报告标题                │
├──────────────────────────────────┤
│                                   │
│         全宽趋势图 (line)          │  ← 主角
│         带 dataZoom 滑杆          │
│                                   │
├─────────────────┬─────────────────┤
│   半宽柱状图     │   半宽数据表     │  ← 辅助
├─────────────────┴─────────────────┤
│         溯源脚注                  │
└──────────────────────────────────┘
```

## 布局 3: 明细版 (detail)

适用：核心是一个大表格，附带 1 个汇总图。

```
┌──────────────────────────────────┐
│           报告标题                │
├──────────────────────────────────┤
│   筛选条件 / 口径说明             │  ← 灰色背景条
├──────────────────────────────────┤
│         数据表（全宽）            │
│         带分页、排序              │
│                                   │
├──────────────────────────────────┤
│         汇总柱状图 (bar)          │  ← 底部一个图
├──────────────────────────────────┤
│         溯源脚注                  │
└──────────────────────────────────┘
```

## 通用规则

- **报告标题**：从用户问题中自动提取（如"2026年1-5月应收账款账龄分析"）
- **生成时间**：当前时间戳，格式 `YYYY-MM-DD HH:MM`
- **数据期间**：从 SQL 查询条件或数据列中提取
- **溯源脚注**：从 Analyst 的 Markdown 输出中提取（表名、更新时间、Skill 版本）
- **打印适配**：CSS `@media print` 隐藏分页控件、显示所有图表
```

---

### Task 5: Design HTML template shell (`report-shell.html`)

**Files:**
- Create: `skills/report-generator/templates/report-shell.html`

**Note:** This task requires the `frontend-design` skill to produce a production-grade HTML shell. The template must be a complete, self-contained HTML file with embedded ECharts and professional styling.

- [ ] **Step 1: Invoke `frontend-design` skill to design the template shell**

Use the following prompt with the frontend-design skill:

```
Design a standalone HTML report template shell for a business analytics platform. This single HTML file will be used as a template — data gets injected into it at generation time.

Requirements:
- **Self-contained**: No external CSS/JS dependencies, no CDN. Everything embedded.
- **ECharts**: Embed the ECharts 5.x core library (minified) inline. The render script reads a `window.REPORT_DATA` JSON object and initializes chart instances from it.
- **Responsive**: CSS Grid layout, desktop 2-column / mobile single column. Print-friendly (@media print).
- **Business report style**: Clean, professional, white background, blue (#5470c6) accent color, gray (#f5f7fa) section backgrounds. Not flashy.
- **Placeholder tokens** that will be replaced with actual content:
  - `{{REPORT_TITLE}}` — report heading
  - `{{REPORT_META}}` — subtitle line with date range and generation timestamp
  - `{{SUMMARY_TEXT}}` — 2-3 sentence summary paragraph
  - `{{KPI_CARDS}}` — HTML block with kpi-card divs (may be empty)
  - `{{CHART_CONTAINERS}}` — HTML block with chart-container divs (one per chart, span class full/half)
  - `{{DATA_TABLE}}` — HTML block with the data table (may be empty)
  - `{{TRACE_FOOTER}}` — source trace footer (table name, skill version, etc.)
  - `{{REPORT_JSON}}` — a JSON object injected as window.REPORT_DATA for the render script

The `{{REPORT_JSON}}` structure:
```json
{
  "title": "Report Title",
  "subtitle": "2026-01 ~ 2026-05 | Generated: 2026-06-09 14:30",
  "kpis": [
    { "label": "Total Revenue", "value": "12.35亿", "change": "+12.5%", "direction": "up" }
  ],
  "charts": [
    {
      "id": "chart-0",
      "type": "line",
      "title": "Monthly Trend",
      "span": "full",
      "option": { /* ECharts option object */ }
    }
  ],
  "table": {
    "columns": ["Col1", "Col2"],
    "rows": [["val1", "val2"]],
    "pageSize": 20
  },
  "trace": {
    "table": "dm.dm_fact_finance_cost_f",
    "lastUpdate": "2026-06-08",
    "skillVersion": "fin-cost-analyst / fin-cost-knowledge",
    "references": ["metrics.md", "data-lineage.md"],
    "limitations": ["数据截止2026-05-31"]
  }
}
```

The rendering JavaScript must:
1. Read `window.REPORT_DATA`
2. For each chart in `charts[]`, get the matching container div by `id`, call `echarts.init()`, and `setOption()`
3. Handle window resize with `window.addEventListener('resize', ...)` to call `.resize()` on all chart instances
4. If the table has more rows than `pageSize`, implement client-side pagination (prev/next buttons, showing "Page X of Y")
5. Format numbers with thousands separator in table cells that have class `num`

Edge cases to handle:
- Empty kpis array → hide the KPI section entirely
- Empty table → hide the table section entirely  
- Single chart with span "full" → full width, no second column needed
- ECharts init failure → show a fallback message in that chart container

Output: Complete `report-shell.html` file (single file, ready to save).
```

- [ ] **Step 2: Save the designed template**

Save the output of frontend-design as `D:/dataproj/skills/report-generator/templates/report-shell.html`.

Verify:
```bash
wc -c D:/dataproj/skills/report-generator/templates/report-shell.html
# Expected: > 200KB (ECharts embedded)
```

- [ ] **Step 3: Validate template offline**

Open the template in a browser with a minimal test JSON to verify:
- Charts render without errors
- Responsive layout works
- Pagination works (if table present)
- Print mode looks correct

Manual check — no automated test for visual output.

---

### Task 6: Write SKILL.md — the 5-step workflow

**Files:**
- Create: `skills/report-generator/SKILL.md`

- [ ] **Step 1: Write `SKILL.md`**

````markdown
# Report Generator

生成交互式 HTML 报告。将 Analyst 的 Markdown 查询结果转换为独立的、可分享的 HTML 文件，内嵌 ECharts 图表。

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

## 工作流

### Step 1: 解析输入数据

从上一轮 Analyst 产出的 Markdown 中提取结构化数据：

1. **找到查询结果表格**：Markdown table 或代码块中的查询结果
2. **识别列信息**：
   - 列名（表头）
   - 列类型：日期（YYYYMM/YYYY-MM/YYYYMMDD/YYYY-MM-DD/timestamp）、分类（文本）、数值（带不带单位）
   - 数值列的量级（万/百万/亿）—— 决定 Y 轴和 KPI 格式化方式
3. **数据量**：行数。>50 行 → 表格用分页；>10 万行 → 采样聚合
4. **多维分组检测**：是否存在多个分类列（如"按月+按部门"）

### Step 2: 匹配图表类型

**必须先读取** `references/chart-decision.md`，对照决策树为每个数据段选择图表类型。

核心逻辑：
- 有时间列 → 折线图
- 有分类列（≤15 类） → 柱状图
- 占比数据 → 饼图
- 明细数据 → 表格
- 单行汇总 → KPI 卡片

一个报告可有多个图表区块（如：上方趋势折线图 + 下方 TOP10 柱状图 + 底部明细表）。

### Step 3: 生成图表配置

**必须先读取** `references/echarts-patterns.md`，找到对应图表类型的 option 骨架。

1. 将实际数据填入骨架的 `series`、`xAxis.data`、`data` 等字段
2. 按数值量级设置 Y 轴 formatter（万/百万/亿）
3. 根据数据点数量决定是否启用 dataZoom（>12 个点）
4. 设置图表标题、轴名称
5. 对于饼图，确保 data 数组每个元素有 `{ value, name }`

### Step 4: 组装报告结构

**必须先读取** `references/layout.md`，选择合适的布局模板。

1. **选择布局**：有 KPI → 概览版；以趋势为主 → 趋势版；大表格为主 → 明细版
2. **生成 KPI 卡片**（如适用）：
   - 从数据中提取汇总指标（总计、均值、最大/最小）
   - 格式化大数字（万/亿 + 千分位）
   - 如有对比数据，计算同比/环比，标注涨跌
3. **生成图表容器 HTML**：每个图表一个 `<div class="chart-container span-full">` 或 `span-half`
4. **生成数据表 HTML**（如适用）：表头 + 数据行，数值列加 `class="num"`
5. **组装完整的 `REPORT_JSON` 对象**（格式见 template 文档）

### Step 5: 渲染输出 + 自检

1. **读取模板壳** `templates/report-shell.html`
2. **替换占位符**：
   - `{{REPORT_TITLE}}` → 报告标题
   - `{{REPORT_META}}` → 数据期间 + 生成时间
   - `{{SUMMARY_TEXT}}` → 3-5 句数据解读
   - `{{KPI_CARDS}}` → KPI 卡片 HTML（或空）
   - `{{CHART_CONTAINERS}}` → 图表容器 HTML
   - `{{DATA_TABLE}}` → 数据表 HTML（或空）
   - `{{TRACE_FOOTER}}` → 溯源脚注
   - `{{REPORT_JSON}}` → 完整 JSON（作为 `window.REPORT_DATA`）
3. **输出 HTML 文件**：保存到当前工作目录，文件名格式 `report_{domain}_{YYYYMMDD_HHmm}.html`
4. **自检**：
   - [ ] 数据是否正确嵌入（对比原始查询结果行数、数值量级）
   - [ ] 图表类型是否匹配数据特征（对照 chart-decision.md 复核）
   - [ ] 文件大小是否合理（ECharts 核心 ~400KB + 数据，总计 >5MB 时警告）
   - [ ] ECharts option 字段完整（必须有 series、xAxis/yAxis、tooltip）
   - [ ] 溯源脚注完整（表名、更新时间、Skill 版本、已知限制）

自检发现任何问题 → 修正后再输出；无法修正 → 明确告知用户风险。

## 关键规则

1. **必须先读 reference 再动手**：Step 2 必须读 `chart-decision.md`，Step 3 必须读 `echarts-patterns.md`，Step 4 必须读 `layout.md`
2. **数值格式化**：万级用 `XX.XX万`，亿级用 `XX.XX亿`，小于万保留原值 + 千分位
3. **图表数量限制**：最多 4 个图表 + 1 个明细表，超出提示用户分多个报告
4. **大表保护**：数据 >50 行自动启用分页；>10 万行建议聚合而不是逐行展示
5. **饼图限制**：分类 ≤8，超出归"其他"
6. **离线自包含**：绝不依赖 CDN，ECharts 已内嵌在模板壳中
7. **溯源脚注不可省略**：延续 Analyst 的溯源要求，报告底部必须带数据来源

## 输出示例

```
✅ HTML 报告已生成：report_ar_20260609_1430.html（480KB）

包含内容：
- 3 个图表：月度逾期趋势（折线图）、TOP10 客户逾期金额（柱状图）、逾期账龄构成（饼图）
- 1 个明细表：客户逾期明细（已分页，每页 20 行）
- KPI 卡片：逾期总额、逾期率、客户数

离线可打开，可直接分享。
```

## 跨域共享参考

本 Skill 为跨域工具，不直接查询 DWS 数据库。数据来源为上游 Analyst Skill 的 Markdown 输出。

如遇数据问题（口径不清、字段不明），应建议用户先回到对应领域的 Analyst Skill 确认数据准确性，再重新生成报告。
````

---

### Task 7: Integration validation

**Files:**
- Reference: `eval_dataset.json`

- [ ] **Step 1: Pick 2 eval scenarios for manual validation**

Select one scenario from `ar` domain and one from `fin-cost` domain:

```
ar: "各客户逾期应收账款余额TOP10" (or similar)
fin-cost: "2026年各月费用总额趋势" (or similar)
```

- [ ] **Step 2: Simulate the full flow for each scenario**

For each scenario:
1. Read the eval scenario's `question` and `data` fields — treat them as the Analyst's output
2. Run through the report-generator workflow manually:
   - Step 1: Parse columns and types from the data
   - Step 2: Match chart types (consult chart-decision.md)
   - Step 3: Generate ECharts option (consult echarts-patterns.md)
   - Step 4: Assemble report structure (consult layout.md)
   - Step 5: Fill template and output HTML
3. Open the generated HTML in a browser
4. Verify:
   - Charts render without JavaScript errors
   - Data values match the eval scenario's expected data
   - Tooltips work on hover
   - saveAsImage works
   - Page renders correctly at 1920px and 768px widths

- [ ] **Step 3: Document findings**

Note any issues in chart selection, data formatting, or template rendering. These become backlog items for Phase 2 iteration.

---

## Phase 2 & 3 (Follow-up, not in this plan)

**Phase 2 — Extension** (after Phase 1 passes manual validation):
- Run all 4 domains through report generation, collect feedback
- Refine `chart-decision.md` thresholds (class count limits, aggregation rules)
- Add scatter chart and stacked bar patterns to `echarts-patterns.md`
- Consider adding `eval_dataset.json` fields for automated report validation

**Phase 3 — Enhancement**:
- KPI cards with YoY/MoM comparison arrows
- Chart interaction: click bar → show detail table below
- Export to PDF (browser print to PDF)
- Dark mode theme variant
