# OTD Fulfillment Domain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create paired otd-fulfillment-knowledge + otd-fulfillment-analyst skills covering 4 core OTD tables for order lifecycle monitoring.

**Architecture:** Follow the existing sales-performance paired-skill pattern. Knowledge skill provides routing + 6 reference docs (metrics.md, data-lineage.md, 4 table refs). Analyst skill provides 6-step workflow with adversarial review and query patterns.

**Tech Stack:** Markdown reference docs, DWS GaussDB SQL (PostgreSQL-compatible), MCP tools for schema exploration.

## Global Constraints

- All 4 target tables verified queryable in DWS (794万/899万/1854/662万 rows)
- `dm_otd_sales_order_det_t` and `dm_otd_so_order_not_user_t` are large tables (>700万) — must document time-range filter requirement
- Channel dimensions reference existing `upload.upload_business_analysis_channel_t` and `dm.dm_dim_integrate_channel_d`
- Org hierarchy references existing `sources-of-truth/business-context/org-hierarchy.md`
- Backup tables marked as DO NOT USE (`_wjh_`, `_bak`, `_20240329` suffixes)
- Reuse existing cross-domain sources-of-truth for org/material/customer/company-plant

---

### Task 1: Directory Scaffolding + Knowledge SKILL.md

**Files:**
- Create: `skills/otd-fulfillment-knowledge/SKILL.md`
- Create: `skills/otd-fulfillment-knowledge/references/` (directory)
- Create: `skills/otd-fulfillment-analyst/` (directory)

**Interfaces:**
- Produces: `SKILL.md` routing layer with table decision tree, global filters, cross-domain refs
- Later tasks write into `references/` and `analyst/SKILL.md`

- [ ] **Step 1: Create directories**

```bash
mkdir -p /home/dp-user/dataprojv2/dataprojv2/.claude/skills/otd-fulfillment-knowledge/references
mkdir -p /home/dp-user/dataprojv2/dataprojv2/.claude/skills/otd-fulfillment-analyst
```

- [ ] **Step 2: Verify directories created**

```bash
ls -d /home/dp-user/dataprojv2/dataprojv2/.claude/skills/otd-fulfillment-knowledge/references/
ls -d /home/dp-user/dataprojv2/dataprojv2/.claude/skills/otd-fulfillment-analyst/
```

### Task 2: Knowledge SKILL.md — Routing Layer

**Files:**
- Create: `skills/otd-fulfillment-knowledge/SKILL.md`

**Interfaces:**
- Produces: Routing layer with 6-reference table, global filter rules, cross-domain refs
- All subsequent tasks reference this file as the entry point

Write the file with content exactly as shown in the plan. Key sections:
1. YAML frontmatter (name + description)
2. 作用 and 可用的参考文档 table (metrics.md as mandatory first-read + 5 other refs)
3. 跨域共享参考 table (4 sources-of-truth links)
4. 使用方式 (4-step workflow)
5. 标准全局过滤条件 (time formats, channel, backup tables, hardcoded filters)

### Task 3: metrics.md — Semantic Layer

**Files:**
- Create: `skills/otd-fulfillment-knowledge/references/metrics.md`

**Interfaces:**
- Consumes: All 4 ETL scripts and table schemas
- Produces: Concept→field mapping, table selection decision tree, OTD lifecycle state machine, channel encoding tables, known traps (13 items)

Write the file with these sections:
1. **一、核心业务概念** — OTD lifecycle state machine (8 nodes), key business metrics table (16 indicators)
2. **二、表选择决策树** — 5-branch decision tree (base order / fulfillment progress / undelivered / area delivery / full chain)
3. **三、渠道维度映射** — zh_channel_code1 (3 values + rules), zh_channel_code2 (10 values + rules), dimension table references
4. **四、现货判断逻辑（is_xh）** — 5-rule CASE WHEN from ETL
5. **五、控制天数逻辑（kz_date）** — 13+ priority rules table
6. **六、表关联关系** — JOIN diagram (core + dimension)
7. **七、已知陷阱** — 13 items covering performance, date formats, hardcoded filters, NULL fields, caliber differences

### Task 4: data-lineage.md

**Files:**
- Create: `skills/otd-fulfillment-knowledge/references/data-lineage.md`

**Interfaces:**
- Consumes: All 4 ETL scripts
- Produces: SAP→DM data flow, table JOIN relationships, ETL notes

Write the file with:
1. Data flow diagram (SAP→SDI→DWI/DWR→DM, ASCII art)
2. Per-table source mapping (all 4 tables with their upstream tables)
3. JOIN relationships (最常用 JOIN 链路 in ASCII)
4. ETL notes (10 items covering refresh modes, date formats, channel systems, etc.)

### Task 5: sales-order-det.md — Order Base Table (83 columns)

**Files:**
- Create: `skills/otd-fulfillment-knowledge/references/sales-order-det.md`

**Interfaces:**
- Consumes: Table schema (83 cols) + ETL script (1030 lines)
- Produces: Full column reference organized in 13 groups, query patterns, known traps

Write the file with:
1. Overview table (schema, row count, granularity, refresh, ETL, sources, order types)
2. Column definitions in 13 groups: PK/ID, Material, Org, Customer, Channel, Date/Time, Qty/Amount, Area, Status, Order Type, Plant/Stock, WBS/Project, Personnel, Order Group, Chain/KA, Other
3. 3 common query patterns (date filter, area summary, unconfirmed orders)
4. Known traps (6 items)

### Task 6: so-order-not-user.md — Fulfillment Tracking Table (50 columns)

**Files:**
- Create: `skills/otd-fulfillment-knowledge/references/so-order-not-user.md`

**Interfaces:**
- Consumes: Table schema (50 cols) + ETL script (119 lines)
- Produces: Full column reference, lifecycle queries, trap documentation

Write the file with:
1. Overview table
2. Column definitions in groups: PK/Join Key, Material, Customer/Org, Plant/Stock, Time Nodes, Duration Metrics, Holding, Warehouse/Outbound, Shipping/Receiving, Prototype, Other
3. 3 query patterns (status distribution, overdue holding, duration analysis)
4. Known traps (7 items including string-format durations and NULL fields)

### Task 7: no-deliver-order-dtl.md — Undelivered Orders (26 columns)

**Files:**
- Create: `skills/otd-fulfillment-knowledge/references/no-deliver-order-dtl.md`

**Interfaces:**
- Consumes: Table schema (26 cols) + ETL script (99 lines)
- Produces: Full reference with ETL filter documentation

Write the file with:
1. Overview table
2. **ETL filter conditions table** (7 conditions that define data scope — most critical section)
3. Column definitions
4. Query patterns (summary, detail, JOIN with base table)
5. Known traps (5 items: no retail, progress 6-11, OSS vs SAP, channel encoding, del_flag)

### Task 8: area-delivery-detail.md — Area Delivery Monthly (22 columns)

**Files:**
- Create: `skills/otd-fulfillment-knowledge/references/area-delivery-detail.md`

**Interfaces:**
- Consumes: Table schema (22 cols) + ETL script (88 lines)
- Produces: Full reference with ETL hardcoded filter documentation

Write the file with:
1. Overview table
2. **ETL key filters table** (division, material group, movement types, record type)
3. Column definitions
4. Query patterns (monthly trend, province TOP, area×channel cross)
5. Known traps (8 items: tiles-only, negative quantities, stat_month format, default area, province fallback, etc.)

### Task 9: Analyst SKILL.md — 6-Step Workflow

**Files:**
- Create: `skills/otd-fulfillment-analyst/SKILL.md`

**Interfaces:**
- Consumes: All knowledge skill references
- Produces: Analysis workflow with OTD-specific query patterns

Write the file with:
1. YAML frontmatter
2. 角色 description
3. 6-step workflow: clarify → locate source → apply filters → self-review → adversarial review → output
4. Standard filter SQL snippets for each table
5. Adversarial review checklist (4 sections, OTD-specific)
6. 溯源脚注 format
7. 7 analysis patterns (status distribution, receiving rate, overdue holding, lead time, undelivered summary, full chain JOIN, area delivery trend)
8. Data quality checks (4 items)
9. Validation layer (4 checks)
10. Unbook mechanism (4 scenarios)

### Task 10: Final Consistency Check

**Files:**
- Verify: All 8 files exist
- Verify: Cross-references correct

- [ ] **Step 1: Verify file count**

```bash
find /home/dp-user/dataprojv2/dataprojv2/.claude/skills/otd-fulfillment-knowledge -type f | wc -l
find /home/dp-user/dataprojv2/dataprojv2/.claude/skills/otd-fulfillment-analyst -type f | wc -l
```
Expected: knowledge=7 files (SKILL.md + 6 refs), analyst=1 file (SKILL.md)

- [ ] **Step 2: Verify cross-references**

```bash
grep -c 'references/' /home/dp-user/dataprojv2/dataprojv2/.claude/skills/otd-fulfillment-knowledge/SKILL.md
grep -c 'otd-fulfillment-knowledge' /home/dp-user/dataprojv2/dataprojv2/.claude/skills/otd-fulfillment-analyst/SKILL.md
```

- [ ] **Step 3: SQL smoke test each table**

```sql
SELECT COUNT(*) FROM dm.dm_otd_sales_order_det_t WHERE audat BETWEEN '20260501' AND '20260531';
SELECT COUNT(*) FROM dm.dm_otd_so_order_not_user_t WHERE creation_time >= '2026-05-01';
SELECT COUNT(*) FROM dm.dm_otd_no_deliver_order_dtl WHERE del_flag = 'N';
SELECT COUNT(*) FROM dm.dm_otd_area_delivery_detail_m WHERE stat_month = '2026-06';
```
All should return > 0 rows.
