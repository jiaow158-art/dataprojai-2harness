# Phase 1: Server Cleanup & GitHub Push — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clean git workspace (8289 stale deletions), sanitize 2 files with hardcoded passwords, organize root directory, push to private GitHub.

**Architecture:** Four independent cleanup tasks followed by git push. Each task is self-contained and can be verified independently before moving on.

**Tech Stack:** bash, git, sed for inline replacements

## Global Constraints

- Private repo: `https://github.com/jiaow158-art/dpai-dataproj.git`
- IP address `121.37.200.214` retained (private repo, acceptable risk)
- `report_server.py` and `build_report.py` MUST stay at root (actively referenced by skills/docs)
- Must not break: MCP server (`dws_mcp_server.py`), eval runner (`run_eval.py`), skill loading

---

### Task 1: Git workspace cleanup — stage all deletions

**Files:**
- Modify: all 8289 deleted paths (staged via `git add -A`)
- No new files

**Interfaces:**
- Consumes: none
- Produces: clean git workspace, ready for subsequent tasks

- [ ] **Step 1: Stage all deletions and verify count**

```bash
cd /home/dp-user/dataprojv2
git add -A
git diff --cached --stat | tail -5
```

Expected: shows ~8289 files changed, mostly deletions. Confirm no unexpected files staged.

- [ ] **Step 2: Commit the cleanup**

```bash
git commit -m "chore: clean workspace — stage 8289 stale deletions from directory restructure

Co-Authored-By: Claude <noreply@anthropic.com>"
```

Expected: clean commit, working tree should now show clean (`git status`).

- [ ] **Step 3: Verify clean state**

```bash
git status --short | wc -l
```

Expected: 0 or near-zero (only `.claude/settings.local.json` may remain modified).

---

### Task 2: Sanitize hardcoded passwords

**Files:**
- Modify: `docs/superpowers/plans/2026-06-08-sales-performance-implementation.md:914,939,957`
- Modify: `huaweiclaude/DWS/DM/PyJob_SA280PUSH.py:30`

**Interfaces:**
- Consumes: clean workspace from Task 1
- Produces: 2 files with no hardcoded passwords

- [ ] **Step 1: Replace passwords in sales-performance plan doc (3 occurrences)**

```bash
cd /home/dp-user/dataprojv2
# Line 914, 939, 957 all have the pattern: password='Dp123456'
# Replace with environment variable pattern
sed -i "s/password='Dp123456'/password=os.environ.get('DWS_PASSWORD', '')/g" \
  docs/superpowers/plans/2026-06-08-sales-performance-implementation.md
```

Verify:
```bash
grep -n "Dp123456" docs/superpowers/plans/2026-06-08-sales-performance-implementation.md || echo "CLEAN - no passwords found"
```

Expected: "CLEAN - no passwords found"

- [ ] **Step 2: Replace password in PyJob_SA280PUSH.py (line 30)**

```bash
cd /home/dp-user/dataprojv2
# Line 30: "password": "Dp@123456" # 密码
# Replace the hardcoded string with os.environ.get()
sed -i '30s/"password": "Dp@123456"/"password": os.environ.get("DWS_PASSWORD", "")/' \
  huaweiclaude/DWS/DM/PyJob_SA280PUSH.py
```

Verify:
```bash
grep -n "Dp@123456" huaweiclaude/DWS/DM/PyJob_SA280PUSH.py || echo "CLEAN - no passwords found"
```

Expected: "CLEAN - no passwords found"

- [ ] **Step 3: Commit password sanitization**

```bash
git add docs/superpowers/plans/2026-06-08-sales-performance-implementation.md \
        huaweiclaude/DWS/DM/PyJob_SA280PUSH.py
git commit -m "security: remove hardcoded DWS passwords from plan doc and PyJob script

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Organize root directory — move standalone scripts to scripts/

**Files:**
- Create: `scripts/` directory
- Move: `build_dealer_report.py`, `build_mom_report.py`, `build_sales_report.py`, `generate_report.py`, `generate_sales_report.py`, `gen_report.py`, `test_report.py`, `categorize_tables.py`

**Files NOT moved** (leave at root):
- `report_server.py` — referenced in `skills/report-generator/SKILL.md`
- `build_report.py` — imported by web app: `from build_report import generate_report`
- `dws_mcp_server.py` — MCP server entry point
- `run_eval.py` — eval runner
- `eval_dataset.json` — eval data

**Interfaces:**
- Consumes: clean workspace from Task 2
- Produces: organized root directory

- [ ] **Step 1: Create scripts directory and move files**

```bash
cd /home/dp-user/dataprojv2
mkdir -p scripts
git mv build_dealer_report.py scripts/
git mv build_mom_report.py scripts/
git mv build_sales_report.py scripts/
git mv generate_report.py scripts/
git mv generate_sales_report.py scripts/
git mv gen_report.py scripts/
git mv test_report.py scripts/
git mv categorize_tables.py scripts/
```

- [ ] **Step 2: Verify root directory is clean**

```bash
ls /home/dp-user/dataprojv2/*.py
```

Expected: only `build_report.py`, `dws_mcp_server.py`, `report_server.py`, `run_eval.py` at root.

- [ ] **Step 3: Verify scripts directory**

```bash
ls /home/dp-user/dataprojv2/scripts/
```

Expected: 8 Python files.

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor: move standalone scripts to scripts/ directory

Keep report_server.py and build_report.py at root (actively referenced).

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Final verification and push to GitHub

**Files:**
- Modify: none
- Verify: `dws_mcp_server.py`, `run_eval.py`, `skills/` directory

**Interfaces:**
- Consumes: Tasks 1-3 complete
- Produces: code pushed to GitHub private repo

- [ ] **Step 1: Run final credential scan**

```bash
cd /home/dp-user/dataprojv2
grep -rn "Dp123456\|Dp@123456" --include="*.py" --include="*.md" --include="*.json" . 2>/dev/null | grep -v ".git/" || echo "PASS: No hardcoded passwords found"
```

Expected: PASS

- [ ] **Step 2: Verify critical files exist at root**

```bash
ls /home/dp-user/dataprojv2/{CLAUDE.md,.mcp.json,.gitignore,dws_mcp_server.py,run_eval.py,eval_dataset.json,report_server.py,build_report.py}
```

Expected: all 8 files listed.

- [ ] **Step 3: Verify skills directory**

```bash
ls /home/dp-user/dataprojv2/skills/
```

Expected: 5 domain pairs + report-generator + README.md.

- [ ] **Step 4: Quick MCP server syntax check**

```bash
python3 -c "import sys; sys.path.insert(0, '/home/dp-user/dataprojv2'); exec(open('/home/dp-user/dataprojv2/dws_mcp_server.py').read().split('if __name__')[0]); print('Syntax OK')"
```

Expected: "Syntax OK" (no import errors).

- [ ] **Step 5: Add GitHub remote and push**

```bash
cd /home/dp-user/dataprojv2
git remote add origin https://github.com/jiaow158-art/dpai-dataproj.git
git push -u origin main
```

Note: This step requires GitHub authentication. If using HTTPS, you'll need a personal access token or credential helper.

- [ ] **Step 6: Verify push success**

```bash
git remote -v
git log --oneline -5
```

Expected: remote `origin` set, last 5 commits visible on the remote.
