# Report Generator Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform report-generator from a rigid white-card template into a dark-pro themed, AI-driven report with interactive tabs, natural language analysis, and full data provenance.

**Architecture:** Sections-based JSON replaces fixed kpis/charts/table/trace. The template shell provides only CSS + rendering engine + ECharts dark base. AI decides content structure via `sections[]` array. Each tab can contain charts, analysis text, or data tables.

**Tech Stack:** HTML/CSS/JS (single-file self-contained), ECharts, no external dependencies.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `skills/report-generator/templates/report-shell.html` | Rewrite | Dark CSS + sections renderer + tabs + ECharts dark base + formatNumbers fix |
| `skills/report-generator/SKILL.md` | Rewrite | 6-step thinking-driven workflow |
| `skills/report-generator/references/layout.md` | Rewrite | AI-guided section composition principles |
| `skills/report-generator/references/echarts-patterns.md` | Minor update | Dark theme notes + formatter guidance |
| `skills/report-generator/references/chart-decision.md` | No change | — |
| `skills/report-generator/templates/echarts.min.js` | No change | — |

---

### Task 1: Rewrite report-shell.html (CSS + HTML skeleton)

**Files:**
- Rewrite: `skills/report-generator/templates/report-shell.html`

- [ ] **Step 1: Write complete new report-shell.html**

Replace the entire file. The new template contains:
- Dark Pro CSS design system with all component styles
- HTML skeleton with: header, insight banner, KPI section, tab nav, tab content container, provenance footer
- `{{ECHARTS_LIB}}` placeholder preserved
- `{{REPORT_JSON}}` placeholder preserved
- All CSS for: KPI cards, tabs, chart blocks, analysis panels, data table, provenance section, pagination, print mode, responsive

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{{REPORT_TITLE}}</title>
<style>
  :root {
    --bg-base: #0f0f1a;
    --bg-card: rgba(255,255,255,0.03);
    --bg-card-hover: rgba(255,255,255,0.06);
    --bg-header-from: #1a1a3e;
    --bg-header-to: #2d1b69;

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

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Helvetica Neue", sans-serif;
    color: var(--text-primary);
    background: var(--bg-base);
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }

  .report {
    max-width: 1200px;
    margin: 0 auto;
    padding: 32px 24px 48px;
  }

  /* ---- Hero Header ---- */
  .report-header {
    background: linear-gradient(135deg, var(--bg-header-from), var(--bg-header-to), var(--bg-header-from));
    border-radius: 12px;
    padding: 28px 32px;
    margin-bottom: 16px;
    border: 1px solid var(--border-accent);
    position: relative;
    overflow: hidden;
  }
  .report-header::before {
    content: '';
    position: absolute;
    top: -30px; right: -30px;
    width: 120px; height: 120px;
    background: radial-gradient(circle, rgba(118,75,162,0.3), transparent);
    border-radius: 50%;
  }
  .report-header::after {
    content: '';
    position: absolute;
    bottom: -20px; left: 40%;
    width: 80px; height: 80px;
    background: radial-gradient(circle, rgba(102,126,234,0.2), transparent);
    border-radius: 50%;
  }
  .report-header .header-tag {
    font-size: 11px;
    color: rgba(255,255,255,0.5);
    letter-spacing: 3px;
    text-transform: uppercase;
    margin-bottom: 8px;
  }
  .report-header h1 {
    font-size: 22px;
    font-weight: 700;
    color: #fff;
    margin-bottom: 4px;
    position: relative;
  }
  .report-header .meta {
    font-size: 12px;
    color: rgba(255,255,255,0.4);
    position: relative;
  }

  /* ---- KPI Cards ---- */
  .kpi-section {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 12px;
    margin-bottom: 16px;
  }
  .kpi-section:empty { display: none; }
  .kpi-card {
    border-radius: var(--radius);
    padding: 20px;
    border: 1px solid;
    position: relative;
    overflow: hidden;
  }
  .kpi-card[data-accent="blue"] {
    background: linear-gradient(145deg, rgba(102,126,234,0.15), rgba(102,126,234,0.05));
    border-color: rgba(102,126,234,0.15);
  }
  .kpi-card[data-accent="purple"] {
    background: linear-gradient(145deg, rgba(118,75,162,0.15), rgba(118,75,162,0.05));
    border-color: rgba(118,75,162,0.15);
  }
  .kpi-card[data-accent="cyan"] {
    background: linear-gradient(145deg, rgba(56,189,248,0.12), rgba(56,189,248,0.04));
    border-color: rgba(56,189,248,0.15);
  }
  .kpi-card[data-accent="pink"] {
    background: linear-gradient(145deg, rgba(240,147,251,0.12), rgba(240,147,251,0.04));
    border-color: rgba(240,147,251,0.15);
  }
  .kpi-label {
    font-size: 11px;
    color: var(--text-muted);
    letter-spacing: 1px;
    margin-bottom: 10px;
  }
  .kpi-value {
    font-size: 26px;
    font-weight: 700;
    color: #fff;
    letter-spacing: -0.02em;
    line-height: 1.2;
  }
  .kpi-value .unit {
    font-size: 14px;
    color: rgba(255,255,255,0.6);
    margin-left: 2px;
  }
  .kpi-change {
    font-size: 11px;
    margin-top: 8px;
    font-weight: 600;
  }
  .kpi-change.up { color: var(--color-up); }
  .kpi-change.down { color: var(--color-down); }
  .kpi-change.neutral { color: var(--color-neutral); }

  /* ---- Insight Banner ---- */
  .insight-banner {
    background: linear-gradient(135deg, rgba(102,126,234,0.08), rgba(118,75,162,0.08));
    border-radius: var(--radius);
    padding: 16px 20px;
    margin-bottom: 16px;
    border-left: 3px solid var(--accent-blue);
    border-top: 1px solid rgba(102,126,234,0.1);
    border-right: 1px solid rgba(102,126,234,0.1);
    border-bottom: 1px solid rgba(102,126,234,0.1);
  }
  .insight-banner:empty { display: none; }
  .insight-banner .insight-label {
    font-size: 10px;
    color: var(--accent-blue);
    letter-spacing: 2px;
    font-weight: 600;
    margin-bottom: 6px;
  }
  .insight-banner .insight-text {
    font-size: 12px;
    color: var(--text-secondary);
    line-height: 1.8;
  }
  .insight-banner .insight-text strong { color: var(--text-primary); }
  .insight-banner .insight-text .risk { color: var(--color-up); }
  .insight-banner .insight-text .positive { color: var(--color-down); }

  /* ---- Tab Navigation ---- */
  .tab-nav {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--border);
    margin-bottom: 0;
  }
  .tab-nav:empty { display: none; }
  .tab-btn {
    padding: 10px 20px;
    font-size: 12px;
    color: var(--text-muted);
    cursor: pointer;
    border: none;
    background: none;
    border-bottom: 2px solid transparent;
    transition: color 0.2s, border-color 0.2s;
    font-family: inherit;
  }
  .tab-btn:hover { color: var(--text-secondary); }
  .tab-btn.active {
    color: var(--accent-blue);
    border-bottom-color: var(--accent-blue);
    font-weight: 600;
  }

  /* ---- Tab Content ---- */
  .tab-content {
    background: var(--bg-card);
    border-radius: 0 0 var(--radius) var(--radius);
    padding: 24px;
    border: 1px solid var(--border);
    border-top: none;
    margin-bottom: 16px;
    display: none;
  }
  .tab-content.active { display: block; }

  /* ---- Chart Block ---- */
  .chart-block {
    background: var(--bg-card);
    border-radius: var(--radius);
    padding: 20px;
    border: 1px solid var(--border);
    margin-bottom: 16px;
  }
  .chart-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: 4px;
  }
  .chart-subtitle {
    font-size: 10px;
    color: var(--text-muted);
    margin-bottom: 16px;
  }
  .chart-container { width: 100%; height: 380px; }
  .chart-container.tall { height: 420px; }
  .charts-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin-bottom: 16px;
  }
  .chart-error {
    display: flex; align-items: center; justify-content: center;
    height: 200px; color: var(--text-muted); font-size: 13px;
    background: rgba(255,255,255,0.02); border-radius: var(--radius);
    border: 1px dashed var(--border);
  }

  /* ---- Analysis Panel ---- */
  .analysis-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin-top: 16px;
  }
  .analysis-card {
    background: rgba(255,255,255,0.02);
    border-radius: 8px;
    padding: 14px 16px;
    border: 1px solid rgba(255,255,255,0.04);
  }
  .analysis-card .analysis-label {
    font-size: 10px;
    font-weight: 600;
    margin-bottom: 6px;
    letter-spacing: 1px;
  }
  .analysis-card[data-color="blue"] .analysis-label { color: var(--accent-blue); }
  .analysis-card[data-color="pink"] .analysis-label { color: var(--accent-pink); }
  .analysis-card[data-color="cyan"] .analysis-label { color: var(--accent-cyan); }
  .analysis-card .analysis-text {
    font-size: 11px;
    color: var(--text-secondary);
    line-height: 1.7;
  }
  .analysis-card .analysis-text strong { color: var(--text-primary); }

  /* ---- Data Table ---- */
  .table-wrapper { overflow-x: auto; }
  .data-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 11px;
  }
  .data-table thead { background: rgba(255,255,255,0.04); }
  .data-table th {
    padding: 10px 14px;
    text-align: left;
    font-weight: 600;
    color: var(--text-muted);
    font-size: 10px;
    white-space: nowrap;
    border-bottom: 1px solid var(--border);
  }
  .data-table td {
    padding: 9px 14px;
    border-bottom: 1px solid rgba(255,255,255,0.03);
    color: var(--text-primary);
  }
  .data-table tbody tr:nth-child(even) { background: rgba(255,255,255,0.015); }
  .data-table tbody tr:hover { background: rgba(255,255,255,0.04); }
  .data-table td.num {
    text-align: right;
    font-variant-numeric: tabular-nums;
    font-family: "SF Mono", "Cascadia Code", "Menlo", "Consolas", monospace;
    font-size: 11px;
    color: var(--accent-blue);
  }
  .data-table td.neg { color: var(--color-up); }

  /* Pagination */
  .pagination {
    display: flex; align-items: center; justify-content: center;
    gap: 4px; margin-top: 16px; padding-top: 12px;
    border-top: 1px solid var(--border);
  }
  .pagination:empty { display: none; }
  .page-btn {
    width: 30px; height: 30px;
    border: 1px solid var(--border);
    background: rgba(255,255,255,0.03); border-radius: 4px;
    cursor: pointer; font-size: 11px; color: var(--text-muted);
    display: flex; align-items: center; justify-content: center;
    transition: all 0.15s;
  }
  .page-btn:hover { border-color: var(--accent-blue); color: var(--accent-blue); }
  .page-btn.active { background: var(--accent-blue); color: #fff; border-color: var(--accent-blue); }
  .page-btn:disabled { opacity: 0.3; cursor: default; }
  .page-info { font-size: 11px; color: var(--text-muted); margin: 0 8px; }

  /* ---- Provenance Section ---- */
  .provenance-section {
    background: var(--bg-card);
    border-radius: var(--radius);
    padding: 20px 24px;
    border: 1px solid var(--border);
    margin-bottom: 16px;
  }
  .provenance-section:empty { display: none; }
  .provenance-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: 14px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--border);
  }
  .provenance-grid {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 8px 14px;
    font-size: 11px;
    margin-bottom: 12px;
  }
  .provenance-grid .pk { color: var(--text-muted); font-weight: 500; }
  .provenance-grid .pv { color: var(--text-secondary); }
  .provenance-sql {
    background: rgba(255,255,255,0.04);
    border-radius: 6px;
    padding: 12px 16px;
    font-family: "SF Mono", "Cascadia Code", "Menlo", "Consolas", monospace;
    font-size: 11px;
    color: var(--text-secondary);
    line-height: 1.6;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-all;
    margin-bottom: 12px;
    border: 1px solid var(--border);
  }
  .tag-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 8px;
  }
  .tag-list .tag-label {
    font-size: 10px;
    color: var(--text-muted);
    font-weight: 500;
    min-width: 60px;
    line-height: 24px;
  }
  .tag {
    display: inline-block;
    background: rgba(102,126,234,0.1);
    color: var(--text-secondary);
    padding: 3px 10px;
    border-radius: 4px;
    font-size: 10px;
    border: 1px solid rgba(102,126,234,0.1);
  }
  .tag.warn {
    background: rgba(248,113,113,0.1);
    border-color: rgba(248,113,113,0.15);
    color: rgba(248,113,113,0.8);
  }

  /* ---- Responsive ---- */
  @media (max-width: 768px) {
    .report { padding: 16px 12px 32px; }
    .report-header { padding: 20px; }
    .report-header h1 { font-size: 18px; }
    .charts-grid { grid-template-columns: 1fr; }
    .chart-container, .chart-container.tall { height: 280px; }
    .kpi-section { grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }
    .kpi-value { font-size: 20px; }
    .analysis-grid { grid-template-columns: 1fr; }
    .tab-btn { padding: 8px 12px; font-size: 11px; }
  }

  /* ---- Print ---- */
  @media print {
    body { background: #fff; color: #1a1a1a; }
    .report { max-width: none; padding: 0; }
    .report-header {
      background: #fff; border-radius: 0; box-shadow: none;
      border: none; border-top: 3px solid #1a1a3e; padding: 16px 0;
    }
    .report-header h1 { color: #1a1a1a; }
    .report-header .meta { color: #666; }
    .report-header::before, .report-header::after { display: none; }
    .kpi-card { background: #f8f9fa !important; border-color: #e2e8f0 !important; }
    .kpi-value { color: #1a1a1a !important; }
    .kpi-change.up { color: #dc2626 !important; }
    .kpi-change.down { color: #16a34a !important; }
    .insight-banner { background: #f0f4ff; border-color: #667eea; }
    .tab-nav { display: none; }
    .tab-content { display: block !important; border: none; padding: 12px 0; page-break-inside: avoid; background: none; }
    .chart-block { border: 1px solid #e2e8f0; background: #fff; }
    .analysis-card { border-color: #e2e8f0; background: #f9fafb; }
    .analysis-card .analysis-text { color: #374151; }
    .data-table thead { background: #f3f4f6; }
    .data-table th { color: #374151; border-bottom-color: #d1d5db; }
    .data-table td { color: #1a1a1a; border-bottom-color: #e5e7eb; }
    .data-table td.num { color: #2563eb; }
    .data-table td.neg { color: #dc2626; }
    .provenance-section { background: #f9fafb; border-color: #e5e7eb; }
    .provenance-sql { background: #f3f4f6; border-color: #d1d5db; color: #374151; }
    .pagination { display: none; }
    .tag { background: #f3f4f6; color: #374151; border-color: #d1d5db; }
    .tag.warn { background: #fef2f2; color: #dc2626; border-color: #fecaca; }
  }
</style>
</head>
<body>
<div class="report">

  <div class="report-header">
    <div class="header-tag">Performance Analysis Report</div>
    <h1>{{REPORT_TITLE}}</h1>
    <div class="meta">{{REPORT_META}}</div>
  </div>

  <div class="kpi-section"></div>
  <div class="insight-banner"></div>
  <div class="tab-nav"></div>
  <div class="tab-content-container"></div>
  <div class="provenance-section"></div>

</div>

{{ECHARTS_LIB}}

<script>
(function() {
  var data = {{REPORT_JSON}};

  if (!data) { console.error('REPORT_JSON is empty'); return; }

  var accentColors = ['blue', 'purple', 'cyan', 'pink'];

  // ---- ECharts dark base option ----
  var darkBase = {
    backgroundColor: 'transparent',
    textStyle: { color: 'rgba(255,255,255,0.65)' },
    legend: { textStyle: { color: 'rgba(255,255,255,0.5)' }, pageTextStyle: { color: 'rgba(255,255,255,0.5)' } },
    tooltip: {
      backgroundColor: 'rgba(15,15,26,0.95)',
      borderColor: 'rgba(255,255,255,0.1)',
      textStyle: { color: 'rgba(255,255,255,0.85)', fontSize: 12 }
    },
    xAxis: {
      axisLine: { lineStyle: { color: 'rgba(255,255,255,0.08)' } },
      axisLabel: { color: 'rgba(255,255,255,0.4)' },
      splitLine: { lineStyle: { color: 'rgba(255,255,255,0.04)' } },
      nameTextStyle: { color: 'rgba(255,255,255,0.4)' }
    },
    yAxis: {
      axisLine: { lineStyle: { color: 'rgba(255,255,255,0.08)' } },
      axisLabel: { color: 'rgba(255,255,255,0.4)' },
      splitLine: { lineStyle: { color: 'rgba(255,255,255,0.04)' } },
      nameTextStyle: { color: 'rgba(255,255,255,0.4)' }
    },
    toolbox: { iconStyle: { borderColor: 'rgba(255,255,255,0.4)' }, emphasis: { iconStyle: { borderColor: 'rgba(255,255,255,0.7)' } } },
    color: ['#667eea', '#764ba2', '#f093fb', '#38bdf8', '#4ade80', '#facc15', '#fb923c', '#f87171']
  };

  function deepMerge(target, source) {
    var result = {};
    for (var k in target) result[k] = target[k];
    for (var k in source) {
      if (source[k] && typeof source[k] === 'object' && !Array.isArray(source[k]) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
        result[k] = deepMerge(target[k], source[k]);
      } else {
        result[k] = source[k];
      }
    }
    return result;
  }

  function escapeHTML(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  function reviveFunctions(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    for (var key in obj) {
      var val = obj[key];
      if (typeof val === 'string' && /^\s*function\s*\(/.test(val)) {
        try { obj[key] = eval('(' + val + ')'); } catch(e) {}
      } else if (typeof val === 'object' && val !== null) {
        reviveFunctions(val);
      }
    }
    return obj;
  }

  // ---- Render KPI cards ----
  var kpiSection = document.querySelector('.kpi-section');
  if (data.kpis && data.kpis.length) {
    var kpiHTML = '';
    data.kpis.forEach(function(k, i) {
      var accent = accentColors[i % accentColors.length];
      var cls = k.direction === 'up' ? 'up' : (k.direction === 'down' ? 'down' : 'neutral');
      kpiHTML += '<div class="kpi-card" data-accent="' + accent + '">'
        + '<div class="kpi-label">' + escapeHTML(k.label) + '</div>'
        + '<div class="kpi-value">' + escapeHTML(String(k.value)) + '</div>'
        + (k.change ? '<div class="kpi-change ' + cls + '">' + escapeHTML(k.change) + '</div>' : '')
        + '</div>';
    });
    kpiSection.innerHTML = kpiHTML;
  } else {
    kpiSection.style.display = 'none';
  }

  // ---- Render insight banner ----
  var insightBanner = document.querySelector('.insight-banner');
  if (data.insight) {
    insightBanner.innerHTML = '<div class="insight-label">KEY INSIGHTS</div>'
      + '<div class="insight-text">' + escapeHTML(data.insight) + '</div>';
  } else {
    insightBanner.style.display = 'none';
  }

  // ---- Render tabs + content ----
  var tabNav = document.querySelector('.tab-nav');
  var tabContainer = document.querySelector('.tab-content-container');
  var sections = data.sections || [];

  if (sections.length === 0) {
    tabNav.style.display = 'none';
  } else {
    // Build tab buttons
    var navHTML = '';
    sections.forEach(function(sec, i) {
      navHTML += '<button class="tab-btn' + (i === 0 ? ' active' : '') + '" data-tab="' + i + '">' + escapeHTML(sec.tab || ('Section ' + (i+1))) + '</button>';
    });
    tabNav.innerHTML = navHTML;

    // Build tab content panels
    sections.forEach(function(sec, i) {
      var panel = document.createElement('div');
      panel.className = 'tab-content' + (i === 0 ? ' active' : '');
      panel.setAttribute('data-panel', i);

      if (sec.type === 'chart-with-analysis') {
        // Render chart(s)
        var charts = Array.isArray(sec.chart) ? sec.chart : (sec.chart ? [sec.chart] : []);
        if (charts.length === 2) {
          panel.innerHTML += '<div class="charts-grid" id="charts-' + i + '">';
          charts.forEach(function(ch) {
            panel.innerHTML += '<div class="chart-block">'
              + '<div class="chart-title">' + escapeHTML(ch.title || '') + '</div>'
              + '<div class="chart-container" id="' + escapeHTML(ch.id) + '"></div>'
              + '</div>';
          });
          panel.innerHTML += '</div>';
        } else {
          charts.forEach(function(ch) {
            panel.innerHTML += '<div class="chart-block">'
              + '<div class="chart-title">' + escapeHTML(ch.title || '') + '</div>'
              + '<div class="chart-container tall" id="' + escapeHTML(ch.id) + '"></div>'
              + '</div>';
          });
        }

        // Render analysis cards
        if (sec.analysis && sec.analysis.length) {
          panel.innerHTML += '<div class="analysis-grid">';
          sec.analysis.forEach(function(a) {
            panel.innerHTML += '<div class="analysis-card" data-color="' + escapeHTML(a.color || 'blue') + '">'
              + '<div class="analysis-label">' + escapeHTML(a.label) + '</div>'
              + '<div class="analysis-text">' + escapeHTML(a.text) + '</div>'
              + '</div>';
          });
          panel.innerHTML += '</div>';
        }
      } else if (sec.type === 'table') {
        renderTable(panel, sec);
      }

      tabContainer.appendChild(panel);
    });

    // Tab click handler
    tabNav.addEventListener('click', function(e) {
      var btn = e.target.closest('.tab-btn');
      if (!btn) return;
      var idx = btn.getAttribute('data-tab');
      // Update buttons
      tabNav.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      // Update panels
      tabContainer.querySelectorAll('.tab-content').forEach(function(p) { p.classList.remove('active'); });
      var target = tabContainer.querySelector('[data-panel="' + idx + '"]');
      if (target) target.classList.add('active');
      // Resize charts in new tab
      resizeCharts();
    });
  }

  // ---- Table rendering ----
  function renderTable(container, sec) {
    var pageSize = sec.pageSize || 20;
    var currentPage = 0;
    var totalPages = Math.ceil(sec.rows.length / pageSize);

    var colHTML = '<th>#</th>';
    sec.columns.forEach(function(c) { colHTML += '<th>' + escapeHTML(c) + '</th>'; });

    function renderPage(page) {
      var start = page * pageSize;
      var end = Math.min(start + pageSize, sec.rows.length);
      var rowHTML = '';
      for (var i = start; i < end; i++) {
        rowHTML += '<tr><td>' + (i + 1) + '</td>';
        sec.rows[i].forEach(function(cell, ci) {
          var cls = '';
          if (typeof cell === 'number' || (!isNaN(parseFloat(cell)) && isFinite(cell) && !/[亿万%％]$/.test(String(cell)))) {
            cls = 'num';
          }
          var text = String(cell);
          if (text.charAt(0) === '-' && text.length > 1 && text.indexOf('%') < 0) {
            cls = 'neg';
          }
          rowHTML += '<td class="' + cls + '">' + escapeHTML(text) + '</td>';
        });
        rowHTML += '</tr>';
      }
      container.querySelector('.data-table tbody').innerHTML = rowHTML;
      formatNumbers();
      updatePaginationUI(page);
    }

    function updatePaginationUI(page) {
      var pagDiv = container.querySelector('.pagination');
      if (!pagDiv) return;
      if (totalPages <= 1) { pagDiv.style.display = 'none'; return; }
      pagDiv.style.display = 'flex';
      var html = '<button class="page-btn" data-page="prev" ' + (page === 0 ? 'disabled' : '') + '>&#8249;</button>';
      for (var p = 0; p < totalPages; p++) {
        html += '<button class="page-btn' + (p === page ? ' active' : '') + '" data-page="' + p + '">' + (p + 1) + '</button>';
      }
      html += '<button class="page-btn" data-page="next" ' + (page >= totalPages - 1 ? 'disabled' : '') + '>&#8250;</button>';
      html += '<span class="page-info">' + (page + 1) + ' / ' + totalPages + '（共 ' + sec.rows.length + ' 条）</span>';
      pagDiv.innerHTML = html;
    }

    var tableHTML = '<div class="table-wrapper"><table class="data-table"><thead><tr>' + colHTML + '</tr></thead><tbody></tbody></table></div>'
      + '<div class="pagination"></div>';

    var wrapper = document.createElement('div');
    wrapper.innerHTML = tableHTML;
    container.appendChild(wrapper);

    // Pagination events
    container.addEventListener('click', function(e) {
      var btn = e.target.closest('.page-btn');
      if (!btn || btn.disabled) return;
      var p = btn.getAttribute('data-page');
      if (p === 'prev') { currentPage--; renderPage(currentPage); }
      else if (p === 'next') { currentPage++; renderPage(currentPage); }
      else { currentPage = parseInt(p); renderPage(currentPage); }
    });

    renderPage(0);
  }

  // ---- Format numbers (bug-fixed) ----
  function formatNumbers() {
    document.querySelectorAll('.data-table td.num').forEach(function(td) {
      var text = td.textContent.trim();
      if (/[亿万%％]$/.test(text) || text === '—' || text === '-') return;
      var num = parseFloat(text.replace(/,/g, ''));
      if (!isNaN(num)) {
        td.textContent = num.toLocaleString('zh-CN', {
          minimumFractionDigits: 2, maximumFractionDigits: 2
        });
      }
    });
  }

  // ---- Render provenance ----
  var provSection = document.querySelector('.provenance-section');
  if (data.provenance) {
    var p = data.provenance;
    var html = '<div class="provenance-title">数据溯源与口径说明</div>';

    html += '<div class="provenance-grid">';
    html += '<span class="pk">数据来源</span><span class="pv">' + escapeHTML(p.source || '-') + '</span>';
    html += '<span class="pk">最后更新</span><span class="pv">' + escapeHTML(p.lastUpdate || '-') + '</span>';
    html += '<span class="pk">Skill 版本</span><span class="pv">' + escapeHTML(p.skillVersion || '-') + '</span>';
    html += '</div>';

    if (p.query) {
      html += '<div class="provenance-sql">' + escapeHTML(p.query) + '</div>';
    }

    if (p.filters && p.filters.length) {
      html += '<div class="tag-list"><span class="tag-label">筛选条件</span>';
      p.filters.forEach(function(f) { html += '<span class="tag">' + escapeHTML(f) + '</span>'; });
      html += '</div>';
    }

    if (p.limitations && p.limitations.length) {
      html += '<div class="tag-list"><span class="tag-label">口径限制</span>';
      p.limitations.forEach(function(l) { html += '<span class="tag warn">' + escapeHTML(l) + '</span>'; });
      html += '</div>';
    }

    if (p.dataQuality && p.dataQuality.length) {
      html += '<div class="tag-list"><span class="tag-label">数据质量</span>';
      p.dataQuality.forEach(function(d) { html += '<span class="tag warn">' + escapeHTML(d) + '</span>'; });
      html += '</div>';
    }

    provSection.innerHTML = html;
  } else {
    provSection.style.display = 'none';
  }

  // ---- Initialize ECharts ----
  var chartInstances = [];

  function initCharts() {
    if (!data.sections || typeof echarts === 'undefined') return;
    data.sections.forEach(function(sec) {
      if (sec.type !== 'chart-with-analysis') return;
      var charts = Array.isArray(sec.chart) ? sec.chart : (sec.chart ? [sec.chart] : []);
      charts.forEach(function(ch) {
        var dom = document.getElementById(ch.id);
        if (!dom) return;
        try {
          var instance = echarts.init(dom);
          if (ch.option && Object.keys(ch.option).length > 0) {
            var merged = deepMerge(darkBase, reviveFunctions(ch.option));
            instance.setOption(merged);
          }
          chartInstances.push(instance);
        } catch(e) {
          dom.innerHTML = '<div class="chart-error">图表渲染失败</div>';
        }
      });
    });
  }

  function resizeCharts() {
    chartInstances.forEach(function(inst) { try { inst.resize(); } catch(e) {} });
  }

  initCharts();
  window.addEventListener('resize', resizeCharts);

  if (typeof echarts === 'undefined' && data.sections) {
    data.sections.forEach(function(sec) {
      if (sec.type !== 'chart-with-analysis') return;
      var charts = Array.isArray(sec.chart) ? sec.chart : (sec.chart ? [sec.chart] : []);
      charts.forEach(function(ch) {
        var dom = document.getElementById(ch.id);
        if (dom) dom.innerHTML = '<div class="chart-error">ECharts 库未加载</div>';
      });
    });
  }
})();
</script>
</body>
</html>
```

- [ ] **Step 2: Verify template structure**

Open the template file and confirm:
- All CSS variables present in `:root`
- All component classes defined (kpi-card, insight-banner, tab-nav, tab-content, chart-block, analysis-grid, data-table, provenance-section)
- `{{ECHARTS_LIB}}` and `{{REPORT_JSON}}` placeholders present
- Print media query switches to light mode
- `formatNumbers()` has the regex guard `/[亿万%％]$/.test(text)`
- No reference to old `REPORT_DATA`, `KPI_CARDS`, `CHART_CONTAINERS`, `DATA_TABLE`, `TRACE_FOOTER` placeholders

---

### Task 2: Rewrite SKILL.md

**Files:**
- Rewrite: `skills/report-generator/SKILL.md`

- [ ] **Step 1: Write new SKILL.md with 6-step thinking-driven workflow**

Replace the entire file. Preserve: trigger conditions, applicable domains, key rules. Rewrite workflow to 6 steps.

```markdown
# Report Generator

生成交互式深色主题 HTML 报告。将 Analyst 的 Markdown 查询结果转换为独立的、可分享的 HTML 文件，内嵌 ECharts 图表、AI 分析文字和数据溯源。

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

## 工作流

### Step 1：理解数据，形成判断

收到 Analyst 的 Markdown 输出后，**先思考再动手**：

1. **读懂**数据维度、量级、时间跨度
2. **提炼** 1-3 条核心结论：趋势是什么、有什么异常、风险在哪
3. **识别**数据质量问题：空值、异常值、缺失维度、可疑的统计口径
4. **构思**报告的叙事结构：分几个 Tab，每个 Tab 讲什么故事

这一步的思考不写入报告，但指导后续所有步骤。

### Step 2：设计报告结构

基于 Step 1 的判断，决定：

1. **Tab 分几个**：按数据维度拆分（时间→趋势分析，渠道→渠道对比，品类→品类构成...），加上最后的"明细数据"Tab
2. **每个 Tab 放什么图表**：对照 `references/chart-decision.md` 选择
3. **Insight 横幅**：用 1-3 句话概括核心结论，必须带具体数字
4. **分析文字方向**：每个 Tab 从哪个角度解读（趋势/对比/风险/归因）

### Step 3：生成图表配置

1. **必须先读取** `references/echarts-patterns.md`，找到对应 option 骨架
2. 将实际数据填入骨架
3. **深色主题自动适配**：模板 JS 会自动合并 dark base option，你只需关注数据和图表类型
4. **tooltip formatter**：根据数值量级生成合适格式：
   - 亿级：`(v/100000000).toFixed(2) + '亿'`
   - 万级：`(v/10000).toFixed(0) + '万'`
   - 百分比：直接显示
5. **颜色语义**：实际达成=实线蓝、预算=虚线绿、去年同期=点线黄

### Step 4：撰写分析文字

**每个 `chart-with-analysis` 类型的 section 必须有 `analysis[]`。**

每项结构：`{ "label": "标签名", "color": "blue|pink|cyan", "text": "分析文字" }`

分析文字要求：
- **具体**：必须带数字支撑，如"3月恢复至4.27亿"而非"3月有所恢复"
- **有判断**：趋势判断、风险提示、归因分析，不做无意义的描述
- **禁止空话**：不写"总体来看数据表现良好"、"各维度有差异"等废话
- **标注风险用粉色**（`color: "pink"`），正面信号用蓝色（`color: "blue"`），中性观察用青色（`color: "cyan"`）

每个 Tab 建议 2 条分析（如：趋势判断 + 风险提示），不要超过 3 条。

### Step 5：构建溯源信息

从 Analyst 的 Markdown 输出中提取以下信息，构建 `provenance` 对象：

```json
{
  "source": "表名",
  "lastUpdate": "数据最后更新日期",
  "skillVersion": "使用的 analyst/knowledge skill",
  "query": "实际执行的 SQL（完整复制）",
  "filters": ["筛选条件1", "筛选条件2"],
  "limitations": ["已知口径限制"],
  "dataQuality": ["Step 1 中发现的数据质量问题"]
}
```

`query` 字段必须包含完整 SQL，方便读者审计数据口径。`dataQuality` 记录你在 Step 1 发现的问题。

### Step 6：组装输出

1. **读取模板壳** `templates/report-shell.html`
2. **替换占位符**：
   - `{{REPORT_TITLE}}` → 报告标题
   - `{{REPORT_META}}` → 数据期间 + 生成时间
   - `{{ECHARTS_LIB}}` → `<script>` + echarts.min.js 内容 + `</script>`
   - `{{REPORT_JSON}}` → 完整 JSON 对象
3. **构建 REPORT_JSON**：按 sections 结构组装，确保每个 section 有 `id`、`tab`、`type`
4. **输出 HTML 文件**：保存到当前工作目录，文件名格式 `report_{domain}_{YYYYMMDD}.html`

**自检清单**（全部通过才输出）：
- [ ] Insight 横幅包含具体数字和结论（不是空泛描述）
- [ ] 每个 Tab 有分析文字（`chart-with-analysis` 类型必须有 `analysis[]`）
- [ ] 溯源信息完整（source + query + filters + limitations）
- [ ] 分析文字避免了空话套话
- [ ] 数值列不会被 formatNumbers 破坏（中文单位值、百分比、"—" 不受影响）
- [ ] 图表类型匹配数据特征（对照 chart-decision.md 复核）
- [ ] ECharts option 完整（series + xAxis/yAxis + tooltip）
- [ ] 文件大小合理（ECharts ~1MB + 数据，>5MB 警告）

## REPORT_JSON 结构

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
      "chart": { "id": "chart-trend", "title": "月度趋势", "option": {} },
      "analysis": [
        { "label": "趋势判断", "color": "blue", "text": "具体分析文字..." },
        { "label": "风险提示", "color": "pink", "text": "具体风险描述..." }
      ]
    },
    {
      "id": "data",
      "tab": "明细数据",
      "type": "table",
      "columns": ["列1", "列2"],
      "rows": [["值1", "值2"]],
      "pageSize": 20
    }
  ],
  "provenance": {
    "source": "表名",
    "lastUpdate": "更新日期",
    "skillVersion": "skill名",
    "query": "SQL语句",
    "filters": [],
    "limitations": [],
    "dataQuality": []
  }
}
```

**sections[].type 说明**：
- `chart-with-analysis`：图表 + 分析文字，chart 可以是单个对象或数组（2个图并排）
- `table`：数据明细表，带分页

## 关键规则

1. **必须先读 reference 再动手**：Step 3 读 `echarts-patterns.md`
2. **数值格式化**：万级用 `XX.XX万`，亿级用 `XX.XX亿`，百分比保留1位小数
3. **图表数量**：最多 4 个 Tab 含图表 + 1 个明细数据 Tab
4. **大表保护**：数据 >50 行自动分页；>10万行建议聚合
5. **饼图限制**：分类 ≤8，超出归"其他"
6. **离线自包含**：ECharts 从本地 `templates/echarts.min.js` 内嵌，不依赖 CDN
7. **溯源不可省略**：`provenance` 对象必须有 `query` 字段
8. **分析文字不可省略**：每个图表 Tab 必须有 `analysis[]`

## 跨域共享参考

本 Skill 为跨域工具，不直接查询 DWS 数据库。数据来源为上游 Analyst Skill 的 Markdown 输出。

如遇数据问题（口径不清、字段不明），建议用户先回到对应领域的 Analyst Skill 确认数据准确性，再重新生成报告。
```

- [ ] **Step 2: Verify SKILL.md**

Check:
- 6 steps all present (理解→设计→图表→分析→溯源→组装)
- `analysis[]` mandatory for `chart-with-analysis` sections
- `provenance.query` mandatory
- Self-check list updated (8 items)
- Trigger conditions and applicable domains preserved
- Key rules preserved (pie ≤8, offline, etc.)

---

### Task 3: Rewrite references/layout.md

**Files:**
- Rewrite: `skills/report-generator/references/layout.md`

- [ ] **Step 1: Write new layout.md**

Replace entire file. Change from fixed layout choices to AI-guided section composition principles.

```markdown
# 报告结构设计指南

Claude 在 Step 2（设计报告结构）时参考本文档，根据数据特征自由组合 sections。

## 设计原则

1. **按维度拆 Tab**：数据有几个分析维度就开几个 Tab，不要强行合并不相关的维度
2. **先总后分**：Insight 横幅给全局结论，每个 Tab 给该维度的深入分析
3. **图文并茂**：每个图表 Tab 必须配分析文字，禁止纯图表堆砌
4. **明细垫底**：数据表永远放最后一个 Tab

## Section 组合模板

### 模板 1：单维度趋势（最常见）

适用：核心是一个时间序列，没有太多维度交叉。

```
Tab 1: 趋势分析    → 全宽折线图 + 趋势判断/风险提示
Tab 2: 明细数据    → 分页数据表
```

### 模板 2：多维度分析

适用：有时间维度 + 1-2 个分类维度（渠道、品类、部门等）。

```
Tab 1: 趋势分析    → 全宽多系列折线图 + 趋势判断
Tab 2: 渠道对比    → 分组柱状图 + 对比分析/风险提示
Tab 3: 品类构成    → 饼图（占半）+ 柱状图（占半）+ 归因分析
Tab 4: 明细数据    → 分页数据表
```

### 模板 3：纯对比排名

适用：无时间维度，核心是分类排行或对比。

```
Tab 1: 排名对比    → 横向柱状图（TOP10-15）+ 对比分析
Tab 2: 构成分析    → 饼图/环形图 + 占比解读
Tab 3: 明细数据    → 分页数据表
```

## Tab 命名建议

| 数据维度 | 推荐 Tab 名 | 示例 |
|----------|------------|------|
| 时间序列 | 趋势分析 / 月度走势 | "月度达成趋势" |
| 渠道 | 渠道对比 / 渠道分析 | "三大渠道达成对比" |
| 品类 | 品类构成 / 品类分析 | "四大品类占比" |
| 品牌/产品 | 品牌排名 / 产品分布 | "品牌 TOP10" |
| 区域 | 区域分布 / 区域对比 | "各区域达成对比" |
| 客户 | 客户分析 / 客户排名 | "客户逾期 TOP10" |
| 明细 | 明细数据 | "费用明细" |

## 图表在 Tab 内的布局

- **单个图表**：全宽，`chart-container.tall`（高度 420px）
- **两个图表**：并排 `charts-grid`（各半宽），适合对比型展示（如：饼图 + 柱状图）
- **不建议**：单个 Tab 内放 3 个以上图表——拆成多个 Tab

## analysis[] 编写要点

每个 `chart-with-analysis` section 必须有 1-3 条 analysis。推荐搭配：

| 场景 | 推荐 analysis 组合 |
|------|-------------------|
| 趋势分析 | 趋势判断 (blue) + 风险提示 (pink) |
| 对比分析 | 对比分析 (blue) + 异常发现 (pink) |
| 排名分析 | 排名解读 (blue) + 归因分析 (cyan) |
| 构成分析 | 结构解读 (blue) + 变化提示 (pink) |

分析文字模板（避免空话）：

| 不要写 | 应该写 |
|--------|--------|
| "总体来看数据有所增长" | "3-5月月均达成4.68亿，较去年同期增长12.3%" |
| "各渠道表现有差异" | "零售渠道达成7.22亿（占比44%），但缺口最大（-27.2%）" |
| "需持续关注" | "按当前节奏全年预计达成78%，缺口约4.6亿" |
```

---

### Task 4: Update references/echarts-patterns.md

**Files:**
- Modify: `skills/report-generator/references/echarts-patterns.md`

- [ ] **Step 1: Add dark theme notes and update formatter guidance**

Add a section at the top explaining dark theme auto-merge, and improve the magnitude-based formatter guidance. The existing patterns (line, bar, pie) remain unchanged — only add/modify the preamble.

Add after the existing "通用配置" section header and before the code block:

```markdown
## 深色主题说明

模板 JS 会自动合并 dark base option（暗色背景、白色网格线、浅色文字、蓝紫配色方案）。
你只需关注**数据映射和图表类型**，不需要手动配置颜色、背景或文字颜色。

dark base 自动提供的配色：
```javascript
color: ['#667eea', '#764ba2', '#f093fb', '#38bdf8', '#4ade80', '#facc15', '#fb923c', '#f87171']
```
即蓝→紫→粉→青→绿→黄→橙→红。如果你不指定 `color`，ECharts 将按此顺序循环。

## 数值格式化指南

根据数据量级选择 tooltip 和 axisLabel 的 formatter：

| 量级 | formatter | 示例输出 |
|------|-----------|---------|
| 亿级（≥1e8）| `function(v){ return (v/1e8).toFixed(2)+'亿'; }` | `6.05亿` |
| 千万级（≥1e7）| `function(v){ return (v/1e4).toFixed(0)+'万'; }` | `6050万` |
| 万级（≥1e4）| `function(v){ return (v/1e4).toFixed(1)+'万'; }` | `123.5万` |
| 百分比 | `function(v){ return v.toFixed(1)+'%'; }` | `78.1%` |
| 原始值 | `function(v){ return v.toLocaleString(); }` | `12,345` |

**统一原则**：所有数值列使用**原始数值**（不带中文单位）传入 series.data，由 formatter 负责展示转换。
```

Then find and replace the old 通用配置 section's color array:
```javascript
// Old:
color: ['#5470c6', '#91cc75', '#fac858', '#ee6666', '#73c0de', '#3ba272', '#fc8452', '#9a60b4']
// New: (remove this line — dark base handles colors automatically)
```

Remove the explicit `color` array from the 通用配置 code block since dark base now handles it.

---

### Task 5: Integration verification

**Files:**
- Test: Generate a report using existing data

- [ ] **Step 1: Create test report with existing sales-performance data**

Use the data from the existing `report_sales_trend_20260610.html` to build a new REPORT_JSON in the sections format. Create a test HTML file by manually filling the new template with this data.

Write a Python script `test_report.py` that:
1. Reads `templates/report-shell.html`
2. Reads `templates/echarts.min.js`
3. Replaces `{{ECHARTS_LIB}}` with `<script>` + echarts content + `</script>`
4. Replaces `{{REPORT_TITLE}}` with test title
5. Replaces `{{REPORT_META}}` with test meta
6. Replaces `{{REPORT_JSON}}` with a test JSON object using sections format
7. Writes output to `test_report_output.html`

- [ ] **Step 2: Open test report in browser and verify**

Check:
- Dark theme renders correctly (dark background, neon accents)
- KPI cards show with gradient backgrounds and 4-color rotation
- Insight banner displays with blue left border
- Tab navigation switches between sections
- Charts render with dark base option (dark grid lines, light text)
- Analysis cards display below charts with colored labels
- Data table shows with alternating row backgrounds
- Provenance section displays with SQL code block and tag lists
- Print preview shows light mode
- Pre-formatted values like "7.22亿" are NOT corrupted

- [ ] **Step 3: Clean up test files**

Delete `test_report.py` and `test_report_output.html`.

---

## Self-Review Checklist

**Spec coverage:**
- [x] Dark Pro CSS theme → Task 1
- [x] Sections-based JSON → Task 1 (template JS) + Task 2 (SKILL.md)
- [x] Tab navigation → Task 1
- [x] Insight banner → Task 1
- [x] Analysis text (analysis[]) → Task 1 (template) + Task 2 (Step 4) + Task 3 (layout.md)
- [x] Provenance section → Task 1 (template) + Task 2 (Step 5)
- [x] formatNumbers bug fix → Task 1
- [x] ECharts dark base auto-merge → Task 1 + Task 4
- [x] Print mode → Task 1
- [x] 6-step workflow → Task 2
- [x] Layout guide rewrite → Task 3
- [x] ECharts patterns update → Task 4

**Placeholder scan:** No TBD, TODO, "implement later", or "similar to" references found.

**Type consistency:** `sections[].chart` can be object or array — handled in Task 1 template JS with `Array.isArray()` check. `analysis[].color` limited to blue/pink/cyan — CSS uses `data-color` attribute matching. `provenance` field names consistent between Task 1 template JS and Task 2 SKILL.md spec.
