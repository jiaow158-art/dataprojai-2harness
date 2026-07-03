# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Framework reference

This project implements **Anthropic's 4-layer Agentic Analytics Stack** as described in:
**https://claude.com/blog/how-anthropic-enables-self-service-data-analytics-with-claude**

All design decisions — directory structure, skill pairing, adversarial review, eval gating — derive from this article. Do not deviate without revisiting its principles.

## Project overview

This is not a software application — it's a **self-service data analytics skills framework** for a ceramics manufacturing company's data warehouse (DWS). Target: 95%+ SQL generation accuracy for business questions.

The warehouse is **GaussDB** (PostgreSQL-compatible) at `121.37.200.214:8000`, database `DP_DWS`, user `aiuser`.

## Architecture — Anthropic 4-layer stack

```
dataproj/
├── huaweiclaude/              # Layer 1: Data Foundations (raw DWS schema exports)
├── sources-of-truth/          # Layer 2: Sources of Truth (cross-domain reference surfaces)
│   └── business-context/      #   Cross-domain master data (org, material, company, WBS)
├── skills/                    # Layer 3: Skills (per-domain paired knowledge + analyst)
│   ├── fin-cost-knowledge/    #   Knowledge skill (routing + references/)
│   │   └── references/       #     metrics.md, data-lineage.md, table refs
│   ├── fin-cost-analyst/      #   Analyst skill (6-step workflow + adversarial review)
│   ├── inventory-knowledge/
│   │   └── references/
│   ├── inventory-analyst/
│   ├── ar-knowledge/
│   │   └── references/
│   ├── ar-analyst/
│   ├── sales-performance-knowledge/
│   ├── sales-performance-analyst/
│   └── report-generator/       #   Cross-domain: Analyst → interactive dark-theme HTML report
│       └── templates/          #     report-shell.html, echarts.min.js
├── eval_dataset.json          # Layer 4: Validation (30 scenarios, 3 domains)
├── run_eval.py                #   Automated eval runner
└── CLAUDE.md                  #   This file
```

### Layer 1 — Data Foundations
- DWS database (SAP → DWI → DWR → DM layers), `dm` and `dwrfin` schemas are primary
- `huaweiclaude/` contains raw schema exports for reference

### Layer 2 — Sources of Truth
Four reference surfaces, in descending order of trust. The top three are **per-domain** (inside each `skills/{domain}-knowledge/references/`); only Business Context is **cross-domain**:

1. **Semantic Layer** — Per-domain `metrics.md` (concept→field mapping, decision trees, known traps). Agents MUST read this first.
2. **Lineage** — Per-domain `data-lineage.md` (SAP source → DWI → DWR → DM flow)
3. **Query Corpus** — Historical SQL distilled into per-domain table reference docs (e.g. `finance-cost-fact.md`, `stock-accage.md`)
4. **Business Context** — Cross-domain master data in `sources-of-truth/business-context/`:
   - `org-hierarchy.md` — 10-level sales org hierarchy (2427 rows, 15 node2 units)
   - `customer-master.md` — 客户主数据 (3 tables: API 1.5K / sales area 650K / general 206K rows)
   - `material-master.md` — 物料主数据 (360万 rows, SCD Type 2, 25.7万 unique materials)
   - `company-plant.md` — 公司 & 工厂 (199 companies, 131 plants)
   - `wbs-master.md` — WBS 元素 (129万 rows, 16 project types, 4-level hierarchy)

### Layer 3 — Skills
- Paired per domain: `{domain}-knowledge` (routing + references) + `{domain}-analyst` (6-step workflow)
- Cross-domain tool: `report-generator` (converts Analyst Markdown output → interactive dark-theme HTML report with ECharts)
- Without Skills: accuracy drops to ~21%. With Skills: >95%.
- Analyst adversarial review step is +6% accuracy — never skip it.

**Report generation**: When user says "生成报告", "导出 HTML", "做个报告" after receiving Analyst results, **must read `skills/report-generator/SKILL.md`** and follow its 6-step workflow. The JSON format is strictly `sections[]` + `kpis[]` + `insight` + `provenance` — never use the old `charts[]`/`table`/`trace` format.

### Layer 4 — Validation
- `eval_dataset.json` (30 scenarios) + `run_eval.py` (automated)
- Per-domain launch gate: no launch until evals clear ~90%

## MCP server — DWS database access

Configured in `.mcp.json` (project root). Format: `type: "stdio"` is a **required** field — servers without it are silently ignored.

```json
{
  "mcpServers": {
    "dws": {
      "type": "stdio",
      "command": "C:/Users/Administrator/AppData/Local/Programs/Python/Python39/python.exe",
      "args": ["D:/dataproj/dws_mcp_server.py"],
      "env": {
        "DWS_HOST": "121.37.200.214",
        "DWS_PORT": "8000",
        "DWS_DBNAME": "DP_DWS",
        "DWS_USER": "aiuser",
        "DWS_PASSWORD": "Dp123456"
      }
    }
  }
}
```

MCP tools available: `run_query` (SELECT only, auto-LIMIT 200), `list_tables`, `describe_table`, `search_tables`.
For write operations or complex multi-step queries, use Python + psycopg2 directly (see `run_eval.py` for connection pattern).

## Python version

```
C:/Users/Administrator/AppData/Local/Programs/Python/Python39/python.exe
```

## Running eval tests

```bash
# All domains (30 scenarios)
python run_eval.py

# Single domain
python run_eval.py inventory
python run_eval.py ar
python run_eval.py fin-cost
```

## Covered domains (4 of 22)

| Domain | Knowledge Skill | Analyst Skill | Tables |
|--------|----------------|---------------|--------|
| fin-cost | `skills/fin-cost-knowledge/` | `skills/fin-cost-analyst/` | 72 |
| inventory | `skills/inventory-knowledge/` | `skills/inventory-analyst/` | 73 |
| ar | `skills/ar-knowledge/` | `skills/ar-analyst/` | 73 |
| sales-performance | `skills/sales-performance-knowledge/` | `skills/sales-performance-analyst/` | 2 |

**Cross-domain tool:**

| Tool | Skill | Trigger |
|------|-------|---------|
| report-generator | `skills/report-generator/` | User says "生成报告" / "导出HTML" after Analyst output |

## Domain boundary rule (NON-NEGOTIABLE)

**Only answer queries within covered domains.** If a user asks about an uncovered domain (AP, GL, sales, procurement, HR, etc.), do NOT query DWS directly — guide them to build the domain Skill first. Without Skills, accuracy drops to ~21%.

## Cross-domain shared resources

| Resource | Location | Used by |
|----------|----------|---------|
| Org hierarchy (10-level) | `sources-of-truth/business-context/org-hierarchy.md` | All domains |
| Material master (360万 rows) | `sources-of-truth/business-context/material-master.md` | All domains |
| Company & plant (199/131) | `sources-of-truth/business-context/company-plant.md` | All domains |
| WBS elements (129万 rows) | `sources-of-truth/business-context/wbs-master.md` | All domains |

When a user asks about "瓷砖事业部", "财经平台", etc., consult org-hierarchy.md to resolve the correct `node_desc*` filter. All domain fact tables embed `node_desc1~9` fields — no JOIN needed for basic org filtering.

## Skill file conventions

- Every domain must have **paired** `{domain}-knowledge` + `{domain}-analyst` skills
- `metrics.md` is the mandatory first-read semantic layer (concept→field mapping, table selection decision tree, date format overview, known traps)
- `data-lineage.md` documents SAP source → DWI → DWR → DM flow
- Table reference docs record column definitions, common query patterns, and **known traps** (the most important maintenance item)
- Analyst SKILL.md includes adversarial review step — this is +6% accuracy
- Knowledge SKILL.md must include a "跨域共享参考" section pointing to `sources-of-truth/`

## Skill maintenance rule (from article)

**~90% of data-model PRs should include a skill change.** When ETL/table schema changes, update the corresponding reference doc in the same PR. The code-review hook should flag model changes that don't touch a skill file.

## Critical data warehouse facts

- **Date format chaos**: Different tables use `YYYYMM`, `YYYY-MM`, `YYYYMMDD`, `YYYY-MM-DD`, and `timestamp` for the same concept. Always verify the format for each table.
- **`___t` suffix**: SAP-style text description fields (e.g., `plant` → `plant___t`)
- **Backup table variants**: `_wjh_*`, `_bak*`, `_tmp*`, `_01`, `_close`, `_2024*` suffixes = DO NOT USE
- **Large tables** (>10M rows): Must always include time-range filters. `dm_fin_stock_detail_accage_t_2023` (144M rows), `dwr_ar_account_detail_f` (103M rows)
- **Dual naming systems**: `cust_code` (DWR style) vs `debitor` (SAP style), `material` vs `material_num`, `plant` vs `factory_werks_code`

## Key project files

| File | Purpose |
|------|---------|
| `eval_dataset.json` | 30 offline eval scenarios with expected results |
| `run_eval.py` | Automated eval runner |
| `domain_categories.json` | All 22 business domains with table counts |
| `skills/README.md` | Skill directory overview and maintenance rules |
| `huaweiclaude/` | Raw DWS schema exports (DWI/DWR/DM/SDI) |
| `sources-of-truth/business-context/` | Cross-domain master data (org, material, company, WBS) |
| `.mcp.json` | MCP server config for DWS database access (project root) |
| `dws_mcp_server.py` | MCP server implementation (stdio JSON-RPC, psycopg2) |
