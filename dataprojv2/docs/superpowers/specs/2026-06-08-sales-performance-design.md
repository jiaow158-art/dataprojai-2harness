# Sales Performance Domain — Design Spec

**Date**: 2026-06-08
**Status**: approved, pending implementation

## Overview

Add a 4th domain "销售业绩" (sales-performance) to the self-service analytics stack. Covers sales achievement rate, YoY growth, target tracking, and multi-dimensional drill-down for the ceramics manufacturing business.

## Scope & Boundaries

### In scope
- Sales revenue (tax-inclusive & tax-exclusive)
- Sales area (sqm)
- Achievement rate vs target
- YoY / period-over-period comparison
- Multi-dimension drill-down: org, channel, customer, product category
- Monthly granularity

### Out of scope
- Gross profit / margin (covered by fin-cost domain)
- Order details, delivery details
- Customer master data drill-down
- Daily granularity tracking
- Collection / payment data (may overlap with AR domain)

### Adjacent domains

| Domain | Relationship |
|--------|-------------|
| fin-cost | Cost/profit queries stay in fin-cost; performance only outputs revenue |
| inventory | No overlap |
| ar | Collections may overlap; clarify per-query when needed |

## Architecture (following 4-layer stack)

### Layer 2 — Sources of Truth

Per-domain reference surfaces inside `skills/sales-performance-knowledge/references/`:

1. **Semantic Layer** — `metrics.md`: concept→field mapping, decision tree, metric formulas
2. **Lineage** — `data-lineage.md`: SAP source → DWS flow
3. **Query Corpus** — `sales-performance.md` (main table) + `sales-target.md` (target table)
4. **Business Context** — reuse existing cross-domain master data in `sources-of-truth/business-context/` (org-hierarchy, material-master, company-plant, wbs-master)

### Layer 3 — Skills

```
skills/
├── sales-performance-knowledge/
│   ├── SKILL.md              # Router + cross-domain refs
│   └── references/
│       ├── metrics.md        # Semantic layer (MUST read first)
│       ├── data-lineage.md   # SAP→DWI→DWR→DM
│       ├── sales-performance.md   # ct_sales_performance_t (222 cols)
│       └── sales-target.md        # dm_dp_api_sales_target
└── sales-performance-analyst/
    └── SKILL.md              # 6-step workflow + adversarial review
```

## Core Tables

### `dm.ct_sales_performance_t` — Primary Performance Table

- **Grain**: daily × customer × org_code × integrate_channel_code
- **Rows**: 8.92M
- **Date range**: 2023-12-31 ~ present
- **Columns**: 222 (wide format, pre-computed periods)

**Dimension columns**:

| Column | Description | Cardinality |
|--------|------------|-------------|
| `calday` | Date (YYYYMMDD) | 2023-12 ~ now |
| `customer` | Customer code | 10,876 |
| `org_code` | Organization code (SAP short code) | 521 |
| `integrate_channel_code` | Channel code | 3 (GD01/GD02/GD03) |

**Metric columns** (pattern: `{prefix}_{period}_{metric}`):

| Field | Meaning | YoY field |
|-------|---------|-----------|
| `month_achievement` | Monthly achievement (tax-incl) | `last_year_month_achievement` |
| `month_notax` | Monthly tax-exclusive net | `last_year_month_notax` |
| `month_sales_area` | Monthly sales area (sqm) | — |
| `year_achievement` | YTD achievement | `last_year_achievement` |
| `quarter_achievement` | QTD achievement | `last_year_quarter_achievement` |

**Product category prefixes**: `high_value_*`, `large_spec_*`, `package_*`, `n1_*`, `gd04_*`, `engineering_adjust_*`, `share_warehouse_*`, `other_adjust_*`, `qjcp_*`, `iw_*`, `fc_*`

### `dm.dm_dp_api_sales_target` — Sales Target

| Column | Description |
|--------|------------|
| `stat_year` / `stat_month` | Target year/month |
| `sales_center_code` / `sales_center` | Sales center |
| `integrate_channel` | Channel |
| `sales_dep_code` / `sales_dep` | Sales department |
| `sales_region_code` / `sales_region` | Sales region |
| `target_sales_amt` | Target sales amount |
| `n_target_amount` | N-target amount |

### Dimension Mapping Table

- `dm.dm_rpt_sales_group_t` — maps `org_code` ↔ `node_desc1~9` hierarchy (existing, cross-domain)

## Key Metric Formulas

| Metric | Formula | Source |
|--------|---------|--------|
| Achievement rate | `SUM(month_achievement) / SUM(target_sales_amt) * 100` | perf + target |
| YoY growth rate | `(SUM(month_achievement) - SUM(last_year_month_achievement)) / SUM(last_year_month_achievement) * 100` | perf only |
| YTD achievement | Aggregate `month_achievement` within calendar year | perf only |
| Tax-exclusive net | `SUM(month_notax)` | perf only |
| Sales area | `SUM(month_sales_area)` | perf only |
| QTD achievement | `SUM(quarter_achievement)` | perf only |

## Known Traps (initial)

1. **`org_code` is NOT `node_desc`**: Main table uses SAP-style short codes (ZJ7, B21). Org filtering MUST join `dm_rpt_sales_group_t` to resolve `node_desc2` etc. The mapping column needs verification (likely `org_code` ↔ `node10` or a specific node level).

2. **Daily grain aggregation**: `month_achievement` already contains the MTD value. When aggregating across the month, use `MAX(month_achievement)` grouped by the last day, or filter to the latest `calday` of the month. Do NOT naively SUM — it would double-count.

3. **Channel codes**: GD01/GD02/GD03 need description mapping. Verify actual channel names against business context.

4. **Target table has future periods**: 2026-12 data exists (full-year targets pre-loaded). Filter `stat_month <= current_month` for actual tracking.

5. **Date format**: `calday` is YYYYMMDD (string), `stat_month` in target table format needs verification.

6. **Customer grain**: 10,876 unique customers. Performance queries should aggregate away from customer level unless specifically drilling into customer dimension.

## Query Patterns

### Achievement Rate by Org

```sql
SELECT p.org_code,
       MAX(p.month_achievement) as actual,
       MAX(t.target_sales_amt) as target,
       MAX(p.month_achievement) / NULLIF(MAX(t.target_sales_amt), 0) * 100 as rate
FROM dm.ct_sales_performance_t p
LEFT JOIN dm.dm_dp_api_sales_target t
  ON p.org_code = t.sales_center_code
  AND p.integrate_channel_code = t.integrate_channel
  AND t.stat_month = '2026-05'
WHERE p.calday = '20260531'
GROUP BY p.org_code
ORDER BY rate DESC;
```

### Monthly Trend + YoY

```sql
SELECT LEFT(calday, 6) as mon,
       MAX(month_achievement) as actual,
       MAX(last_year_month_achievement) as ly
FROM dm.ct_sales_performance_t
WHERE calday BETWEEN '20260101' AND '20260531'
  AND calday LIKE '%01'  -- last day of month (or use subquery)
GROUP BY LEFT(calday, 6)
ORDER BY mon;
```

### Org Filter via node_desc

```sql
SELECT p.*
FROM dm.ct_sales_performance_t p
JOIN dm.dm_rpt_sales_group_t s ON p.org_code = s.node10
WHERE s.node_desc2 = '瓷砖事业部'
  AND p.calday = '20260531';
```

## EVAL Plan

- 10 offline eval scenarios for sales-performance
- Mix: achievement rate (3), YoY growth (2), target tracking (2), multi-dimension drill (3)
- Gate: ≥90% accuracy before launch
- Add to `eval_dataset.json` and `run_eval.py`

## Implementation Steps

1. Create `skills/sales-performance-knowledge/SKILL.md` (router)
2. Create `skills/sales-performance-knowledge/references/`:
   - `metrics.md` — semantic layer
   - `data-lineage.md` — lineage doc
   - `sales-performance.md` — main table reference
   - `sales-target.md` — target table reference
3. Create `skills/sales-performance-analyst/SKILL.md` (6-step workflow)
4. Register skills via `.claude/skills/` symlinks
5. Validate with 2-3 real queries against DWS
6. Add 10 eval scenarios to `eval_dataset.json`
7. Update `CLAUDE.md` covered domains table
8. Run evals, iterate until ≥90%
