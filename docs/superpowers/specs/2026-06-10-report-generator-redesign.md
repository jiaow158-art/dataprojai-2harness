# Report Generator Redesign Spec

Date: 2026-06-10
Status: Approved

## Problem

Current report-generator produces "low-end admin dashboard" HTML:
- White cards + thin shadows, single blue accent — no visual hierarchy or brand feel
- Pure chart stacking with no text analysis or conclusions
- `formatNumbers()` corrupts pre-formatted Chinese values (e.g. "7.22亿" → "7.22", "44.0%" → "44.00")
- Rigid placeholder template — AI just fills slots, no thinking about what to say

## Design Decisions

### 1. Visual: Dark Pro theme

Deep navy/purple background with neon accent highlights. Similar to ByteDance internal BI / Tableau dark mode.

CSS design tokens:
```css
:root {
  --bg-base: #0f0f1a;
  --bg-card: rgba(255,255,255,0.03);
  --bg-card-hover: rgba(255,255,255,0.06);
  --bg-header: linear-gradient(135deg, #1a1a3e, #2d1b69, #1a1a3e);

  --text-primary: rgba(255,255,255,0.88);
  --text-secondary: rgba(255,255,255,0.55);
  --text-muted: rgba(255,255,255,0.3);

  --accent-blue: #667eea;
  --accent-purple: #764ba2;
  --accent-cyan: #38bdf8;
  --accent-pink: #f093fb;

  --color-up: #f87171;
  --color-down: #4ade80;
  --color-neutral: rgba(255,255,255,0.35);

  --border: rgba(255,255,255,0.06);
  --border-accent: rgba(102,126,234,0.2);
  --radius: 10px;
}
```

Component treatments:
- **KPI cards**: Gradient semi-transparent backgrounds + rotating 4-color left borders
- **Chart blocks**: `bg-card` + subtle border; ECharts gets auto-merged dark base option
- **Analysis text**: Two-column layout (blue label "趋势判断" + pink label "风险提示") inside `bg-card`
- **Data table**: Dark header `rgba(255,255,255,0.04)`, alternating rows `rgba(255,255,255,0.015)`, numeric columns in `accent-blue`
- **Tab navigation**: Dark base, active tab = `accent-blue` bottom border + text color
- **Insight banner**: Gradient background + left blue border, positioned between KPIs and Tabs
- **Provenance section**: Bottom independent section, dark gray, SQL in code block style, limitations as tags
- **Print**: `@media print` switches to light mode (white bg, dark text) for print compatibility

### 2. Architecture: Sections-based JSON (AI-driven content)

Replace fixed `kpis/charts/table/trace` with flexible `sections[]` array. AI decides tab count, names, and content per section.

```json
{
  "title": "瓷砖事业部 2026年1-5月业绩分析",
  "subtitle": "2026-01 ~ 2026-05 | 生成: 2026-06-10",
  "insight": "1-5月累计达成16.87亿，低于预算21.9%。三大渠道全面低于预算，零售缺口最大(-27.2%)。",
  "sections": [
    {
      "id": "trend",
      "tab": "趋势分析",
      "type": "chart-with-analysis",
      "chart": { "id": "chart-trend", "option": {} },
      "analysis": [
        { "label": "趋势判断", "color": "blue", "text": "月度达成呈V型反弹..." },
        { "label": "风险提示", "color": "pink", "text": "预算达成持续落后..." }
      ]
    },
    {
      "id": "channel",
      "tab": "渠道对比",
      "type": "chart-with-analysis",
      "chart": { "id": "chart-channel", "option": {} },
      "analysis": [ ... ]
    },
    {
      "id": "category",
      "tab": "品类构成",
      "type": "chart-with-analysis",
      "chart": [
        { "id": "chart-pie", "option": {} },
        { "id": "chart-bar", "option": {} }
      ]
    },
    {
      "id": "data",
      "tab": "明细数据",
      "type": "table",
      "columns": ["维度", "分类", "达成额", "预算", "偏差", "占比"],
      "rows": [ ... ]
    }
  ],
  "provenance": {
    "source": "dm.dm_fin_operations_mix_sum_t",
    "lastUpdate": "2026-06-09",
    "skillVersion": "sales-performance-analyst",
    "query": "SELECT period, channel, SUM(amount) ... WHERE ...",
    "filters": ["瓷砖事业部", "国内营销中心(S)"],
    "limitations": ["仅含主数据源(S)", "不含海外渠道"],
    "dataQuality": ["2月数据受春节影响", "空品牌占36.8%待治理"]
  }
}
```

Key fields:
- `insight`: Top-level 1-3 sentence conclusion written by AI
- `sections[].tab`: Tab label text
- `sections[].type`: `chart-with-analysis` | `table`
- `sections[].chart`: Single object or array (multiple charts per tab)
- `sections[].analysis[]`: `{ label, color, text }` — natural language interpretation
- `provenance.query`: Actual SQL from Analyst output
- `provenance.dataQuality[]`: Data issues AI discovered during analysis

### 3. SKILL.md Workflow: 6-step thinking-driven process

**Step 1 — Understand data, form judgments**
- Read data dimensions, magnitude, time span
- Extract 1-3 core conclusions (trend, anomaly, risk)
- Design narrative structure (how many sections, what each covers)
- Identify data quality issues (nulls, outliers, missing dimensions)
- Output: internal thinking notes (not in report, guides subsequent steps)

**Step 2 — Design report structure**
- Decide tab count based on data dimensions
- Decide each tab's content: chart type + analysis angle
- Draft insight banner text from core conclusions
- Plan analysis direction per tab (trend/comparison/risk/attribution)

**Step 3 — Generate chart configs**
- Read `echarts-patterns.md`, fill data into option skeletons
- Auto-generate tooltip formatters based on magnitude (万/亿/%)
- Set color semantics: budget = dashed green, actual = solid blue, decline = red
- Template JS auto-merges dark base option — AI only cares about data and chart type

**Step 4 — Write analysis text (NEW)**
- For each section, write 1-2 analysis blocks
- Each block: `label` (趋势判断/对比分析/风险提示/归因分析), `color` (blue/pink/cyan), `text`
- Requirements: specific, number-backed, no vague platitudes. Ban phrases like "总体来看数据表现良好"
- Red = risk, green = positive signal

**Step 5 — Build provenance info**
- Extract from Analyst's output: SQL query, filters, limitations
- Add `dataQuality[]` issues found in Step 1
- Provenance displays as last tab or bottom section — cannot be hidden

**Step 6 — Assemble and self-check**
- Fill template shell, output HTML
- Self-check items:
  - [ ] Insight banner has specific numbers and conclusions
  - [ ] Every tab has analysis text
  - [ ] Provenance complete (query + filters + limitations)
  - [ ] Analysis text avoids vague platitudes
  - [ ] Numeric columns correctly formatted (not corrupted by formatNumbers)

### 4. Data bug fix

`formatNumbers()` in `report-shell.html` — skip values that are already formatted with Chinese units or symbols:

```javascript
function formatNumbers() {
  document.querySelectorAll('.data-table td.num').forEach(function(td) {
    var text = td.textContent.trim();
    // Skip values with Chinese units, percentages, or dashes
    if (/[亿万%％]$/.test(text) || text === '—' || text === '-') return;
    var num = parseFloat(text.replace(/,/g, ''));
    if (!isNaN(num)) {
      td.textContent = num.toLocaleString('zh-CN', {
        minimumFractionDigits: 2, maximumFractionDigits: 2
      });
    }
  });
}
```

## Files Changed

| File | Action | Description |
|------|--------|-------------|
| `templates/report-shell.html` | Rewrite | Dark CSS + sections rendering engine + Tab switch JS + ECharts dark base + formatNumbers fix |
| `SKILL.md` | Rewrite | 6-step thinking-driven workflow |
| `references/layout.md` | Rewrite | Remove fixed layout choices, guide AI to freely compose sections |
| `references/echarts-patterns.md` | Minor update | Add dark theme notes, improve magnitude-based formatter guidance |
| `references/chart-decision.md` | No change | Decision tree logic unchanged |
| `templates/echarts.min.js` | No change | Library file untouched |

## Unchanged

- Trigger conditions ("生成报告", "导出HTML", etc.)
- Applicable domains (all 4 covered domains)
- Key rules (pie ≤8 categories, offline self-contained, ≤4 charts + 1 table, file naming)
- ECharts library file
- Chart decision tree logic
