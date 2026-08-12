# GitHub Migration & Skill Optimization Design

**Date**: 2026-08-12
**Status**: Approved
**Target**: Push dpai-dataproj to private GitHub repo, restructure on Windows, sync back to server

---

## Objective

1. Clean up server git repo (resolve 8000+ stale deletions, organize root directory)
2. Push clean codebase to private GitHub repo `https://github.com/jiaow158-art/dpai-dataproj.git`
3. Clone to Windows local, optimize all 5 domain Skills for better query accuracy
4. Push optimized version back, server pulls to overwrite

---

## Architecture: Branch-Based Collaboration (Option B)

```
Server (Linux)              GitHub (Private)              Windows (Local)
─────────────               ────────────────              ───────────────
main ──cleanup+push──>      main                          clone main
                             ^                             checkout -b dev
                             |── PR merge ←──────────────  optimize Skills
                             |                             push dev
main <──git pull─────       main (merged)
```

**Branch strategy**: `main` is stable/server; `dev` for Windows optimization. PR review gates changes before hitting the server.

---

## Phase 1: Server Cleanup

### 1.1 Git workspace cleanup
- **Problem**: 8289 files in deleted state from prior `dataprojv2/` subdirectory restructuring that was never committed
- **Fix**: `git add -A` to stage all deletions, single cleanup commit

### 1.2 Credential sanitization
- `docs/superpowers/plans/2026-06-08-sales-performance-implementation.md`: Replace 3x hardcoded `password='Dp123456'` with `os.environ.get('DWS_PASSWORD')`
- `huaweiclaude/DWS/DM/PyJob_SA280PUSH.py`: Replace 2x hardcoded `Dp@123456` with `os.environ.get('DWS_PASSWORD')`
- Note: IP address `121.37.200.214` retained (private repo, acceptable risk)

### 1.3 Root directory organization

**Move to `scripts/`** (standalone utilities, no cross-file references):
- `build_dealer_report.py`, `build_mom_report.py`, `build_sales_report.py`
- `generate_report.py`, `generate_sales_report.py`, `gen_report.py`
- `test_report.py`, `categorize_tables.py`

**Keep at root** (actively referenced by skills or other code):
- `CLAUDE.md`, `.mcp.json`, `.gitignore`, `requirements.txt`, `pytest.ini`
- `dws_mcp_server.py` — MCP server entry point
- `run_eval.py` — eval runner
- `eval_dataset.json` — eval data
- `report_server.py` — referenced in `skills/report-generator/SKILL.md` (commands: `python report_server.py`, `pkill -f report_server.py`)
- `build_report.py` — imported by web app: `from build_report import generate_report`

### 1.4 .gitignore supplement
Add: `_mcp_stderr.txt` (already present), verify `*.tmp` and `*.bak` rules are sufficient

---

## Phase 2: Push to GitHub

```bash
git remote add origin https://github.com/jiaow158-art/dpai-dataproj.git
git push -u origin main
```

---

## Phase 3: Windows Skill Optimization

### 3.1 Priority: sales-performance references (HIGHEST)
- Current state: 0 reference docs, all domain knowledge inlined in SKILL.md
- Add: `metrics.md`, `data-lineage.md`, table reference docs for fact tables used
- Standard per-domain structure: `{domain}-knowledge/references/` matching other 4 domains

### 3.2 All domains: metrics.md review
- Verify field-to-concept mappings against actual DWS schema
- Compare decision trees against eval failure cases
- Audit known traps for completeness

### 3.3 All domains: data-lineage.md review
- Confirm SAP → DWI → DWR → DM flow accuracy per table

### 3.4 All domains: Analyst SKILL.md 6-step workflow tuning
- Adversarial review step rigor
- Domain-specific trap propagation into analyst workflow

### 3.5 Cross-domain consistency
- Verify `sources-of-truth/business-context/` references appear in every knowledge SKILL.md
- Ensure org-hierarchy, material-master, company-plant, WBS references are current

### Windows Git workflow
```bash
git clone https://github.com/jiaow158-art/dpai-dataproj.git
git checkout -b dev
# ... optimize with VS Code ...
git add -A && git commit -m "feat: optimize all domain skills for accuracy"
git push -u origin dev
# GitHub: Create PR dev → main, review, merge
```

---

## Phase 4: Server Sync

```bash
cd /home/dp-user/dataprojv2
git pull origin main
```

### Verification checklist
| Item | Check |
|------|-------|
| MCP server starts | `python3 dws_mcp_server.py` — no import errors |
| Skills intact | `ls skills/` — 5 domains present |
| Eval runs | `python3 run_eval.py` — all 30 scenarios execute |
| `.mcp.json` unchanged | Database connection config intact |
| `report_server.py` present | Report generator skill dependency |
| `build_report.py` present | Web app import dependency |

### Rollback
```bash
git log --oneline -5
git reset --hard <pre-pull-commit>
```

---

## Files Touched (Phase 1)

| File | Action |
|------|--------|
| All 8289 deleted paths | Stage via `git add -A` |
| `docs/superpowers/plans/2026-06-08-sales-performance-implementation.md` | Replace hardcoded passwords |
| `huaweiclaude/DWS/DM/PyJob_SA280PUSH.py` | Replace hardcoded passwords |
| `scripts/` (new) | Move 8 standalone Python scripts |
| `.mcp.json` | Verify no credentials present |

## Non-Goals (Out of Scope)

- Schema changes to DWS database
- Adding new business domains
- Eval dataset expansion (handled separately)
- Changing `.claude/` agent or skill configurations
