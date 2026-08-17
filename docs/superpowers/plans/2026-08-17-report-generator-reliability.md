# Report Generator 可靠性重构 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用"纯 JSON 协议（valueFormat 声明替代 JS 函数）+ 强制 validator + 统一 builder"消灭报表白屏/转义翻车，建立可测试的 schema 契约。

**Architecture:** 三件套互相咬合——`report-schema.json` 定义契约，`validate_report.py`（纯标准库手写校验器）强制执行，`build.py` 在生成 HTML 前强制调用 validator。模板端删 `eval()`、新增 `formatFactory` 把格式声明装配成 ECharts formatter。

**Tech Stack:** Python 3.9+ 标准库（json/re/os/sys/argparse/datetime/subprocess/tempfile/urllib）、原生 JS（模板内）、pytest、git。

**规格文档:** `docs/superpowers/specs/2026-08-17-report-generator-reliability-design.md`

**关键裁定（依模板代码实况）:**
- 表格结构：嵌套式 `section.table.{title,columns,rows,pageSize}`（模板 `renderTableSection` 读 `section.table || section`，schema 只认嵌套式）
- provenance SQL 字段：`query`（模板 `p.query || p.sql` 双读，schema 只认 `query`）
- 6 种 valueFormat：`yi/wan/percent/signed_percent/sqm_wan/yuan`，`:N` 小数位后缀

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `skills/report-generator/references/report-schema.json` | 机器可读契约 | 新建 |
| `skills/report-generator/scripts/validate_report.py` | 校验 JSON/HTML | 新建 |
| `skills/report-generator/scripts/build.py` | JSON→HTML（强制先 validate）+ selftest | 新建 |
| `skills/report-generator/templates/report-shell.html` | 删 eval，加 formatFactory + VALID 标记 | 修改 |
| `skills/report-generator/tests/conftest.py` | sys.path 注入 scripts/ | 新建 |
| `skills/report-generator/tests/test_validate_report.py` | validator 单测 + 负路径 | 新建 |
| `skills/report-generator/tests/test_report_builder.py` | builder 端到端 | 新建 |
| `skills/report-generator/SKILL.md` | 工作流收编 | 修改 |
| `pytest.ini` | testpaths 修正 | 修改 |
| `build_report.py` + `scripts/` 6 脚本 + `scripts/test_report.py` | 头部废弃注释 | 修改（仅头注释） |

---

### Task 1: report-schema.json（契约）

**Files:**
- Create: `skills/report-generator/references/report-schema.json`

- [ ] **Step 1: 写 schema 文件**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "REPORT_JSON 契约 v2",
  "type": "object",
  "required": ["title", "kpis", "insight", "sections", "provenance"],
  "additionalProperties": true,
  "properties": {
    "title": {"type": "string", "minLength": 1},
    "subtitle": {"type": "string"},
    "kpis": {
      "type": "array", "minItems": 1,
      "items": {
        "type": "object",
        "required": ["label", "value"],
        "properties": {
          "label": {"type": "string", "minLength": 1},
          "value": {"type": "string", "minLength": 1},
          "change": {"type": "string"},
          "direction": {"enum": ["up", "down", "neutral"]}
        }
      }
    },
    "insight": {"type": "string", "minLength": 1},
    "sections": {
      "type": "array", "minItems": 1,
      "items": {
        "type": "object",
        "required": ["id", "tab", "type"],
        "properties": {
          "id": {"type": "string", "minLength": 1},
          "tab": {"type": "string", "minLength": 1},
          "type": {"enum": ["chart-with-analysis", "table"]}
        },
        "allOf": [
          {
            "if": {"properties": {"type": {"const": "chart-with-analysis"}}},
            "then": {
              "required": ["chart", "analysis"],
              "properties": {
                "chart": {"$ref": "#/definitions/chart"},
                "analysis": {
                  "type": "array", "minItems": 1,
                  "items": {
                    "type": "object",
                    "required": ["label", "color", "text"],
                    "properties": {
                      "label": {"type": "string", "minLength": 1},
                      "color": {"enum": ["blue", "pink", "cyan"]},
                      "text": {"type": "string", "minLength": 1}
                    }
                  }
                }
              }
            }
          },
          {
            "if": {"properties": {"type": {"const": "table"}}},
            "then": {
              "required": ["table"],
              "properties": {
                "table": {
                  "type": "object",
                  "required": ["columns", "rows"],
                  "properties": {
                    "title": {"type": "string"},
                    "columns": {"type": "array", "minItems": 1, "items": {"type": "string"}},
                    "rows": {"type": "array", "minItems": 1, "items": {"type": "array"}},
                    "pageSize": {"type": "integer", "minimum": 1}
                  }
                }
              }
            }
          }
        ]
      }
    },
    "provenance": {
      "type": "object",
      "required": ["query"],
      "properties": {
        "query": {"type": "string", "minLength": 1},
        "source": {"type": "string"},
        "lastUpdate": {"type": "string"},
        "skillVersion": {"type": "string"},
        "filters": {"type": "array", "items": {"type": "string"}},
        "limitations": {"type": "array", "items": {"type": "string"}},
        "dataQuality": {"type": "array", "items": {"type": "string"}}
      }
    }
  },
  "definitions": {
    "chart": {
      "type": "object",
      "required": ["id", "title", "option", "valueFormat"],
      "properties": {
        "id": {"type": "string", "minLength": 1},
        "title": {"type": "string", "minLength": 1},
        "valueFormat": {
          "type": "string",
          "pattern": "^(yi|wan|percent|signed_percent|sqm_wan|yuan)(:[0-9])?$"
        },
        "tooltipTemplate": {"enum": ["multi", "pie"]},
        "option": {"type": "object"}
      }
    }
  }
}
```

- [ ] **Step 2: 语法自检**

Run: `python -c "import json; json.load(open('skills/report-generator/references/report-schema.json', encoding='utf-8')); print('schema JSON OK')"`
Expected: `schema JSON OK`

- [ ] **Step 3: Commit**

```bash
git add skills/report-generator/references/report-schema.json
git commit -m "feat(report): report-schema.json 契约 v2（纯JSON协议）"
```

---

### Task 2: validate_report.py（校验器，TDD）

**Files:**
- Create: `skills/report-generator/scripts/validate_report.py`
- Create: `skills/report-generator/tests/test_validate_report.py`

- [ ] **Step 1: 先写 conftest.py（Task 4 也依赖）**

`skills/report-generator/tests/conftest.py`：

```python
import os
import sys

SCRIPTS_DIR = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)
```

- [ ] **Step 2: 写失败测试**

`skills/report-generator/tests/test_validate_report.py`：

```python
"""validator 单测：合规过、负路径逐条拦截。"""
import sys
import os

import validate_report as vr  # conftest 已注入 scripts/ 到 sys.path


def _base_report():
    """最小合规报告（负路径在其上做字段破坏）。"""
    return {
        "title": "T", "subtitle": "s", "insight": "i",
        "kpis": [{"label": "L", "value": "V", "direction": "up"}],
        "sections": [
            {"id": "trend", "tab": "趋势", "type": "chart-with-analysis",
             "chart": {"id": "c1", "title": "图", "valueFormat": "yi:2", "option": {}},
             "analysis": [{"label": "a", "color": "blue", "text": "t"}]},
            {"id": "data", "tab": "明细", "type": "table",
             "table": {"columns": ["A"], "rows": [["1"]]}}
        ],
        "provenance": {"query": "SELECT 1", "source": "dm.t"}
    }


def test_valid_report_passes():
    errs = vr.validate_data(_base_report())
    assert errs == [], f"应无错误，实际: {errs}"


def test_missing_query_fails():
    r = _base_report(); del r["provenance"]["query"]
    errs = vr.validate_data(r)
    assert any("provenance.query" in e for e in errs)


def test_bad_direction_fails():
    r = _base_report(); r["kpis"][0]["direction"] = "sideways"
    errs = vr.validate_data(r)
    assert any("kpis[0].direction" in e for e in errs)


def test_old_function_format_fails():
    r = _base_report()
    r["sections"][0]["chart"]["option"]["yAxis"] = {
        "axisLabel": {"formatter": "function(v){return v;}"}}
    errs = vr.validate_data(r)
    assert any("旧函数格式" in e for e in errs), f"应拦截函数串: {errs}"


def test_bad_valueformat_fails():
    r = _base_report(); r["sections"][0]["chart"]["valueFormat"] = "billion"
    errs = vr.validate_data(r)
    assert any("valueFormat" in e for e in errs)


def test_missing_valueformat_fails():
    r = _base_report(); del r["sections"][0]["chart"]["valueFormat"]
    errs = vr.validate_data(r)
    assert any("valueFormat" in e for e in errs)


def test_flat_table_fails():
    """表格必须嵌套式 section.table，扁平式（SKILL.md 旧示例）应报错。"""
    r = _base_report()
    r["sections"][1] = {"id": "data", "tab": "明细", "type": "table",
                        "columns": ["A"], "rows": [["1"]]}
    errs = vr.validate_data(r)
    assert any("table" in e for e in errs)


def test_duplicate_id_fails():
    r = _base_report(); r["sections"][1]["id"] = "trend"
    errs = vr.validate_data(r)
    assert any("重复" in e for e in errs)
```

- [ ] **Step 3: 跑测试确认失败**

Run: `python -m pytest skills/report-generator/tests/test_validate_report.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'validate_report'`

- [ ] **Step 4: 写实现**

`skills/report-generator/scripts/validate_report.py`：

```python
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""validate_report.py — REPORT_JSON v2 纯JSON协议校验器（零依赖，Python 3.9+）。

用法:
    python validate_report.py <report.json | report.html>

校验层:
    1. JSON 可解析（HTML 输入先抽 var data = ... 段）
    2. 结构校验（手写校验器，规则同 references/report-schema.json）
    3. 黑名单：eval( / function( 旧函数串
    4. 占位符残留（HTML 输入）
    5. 结构补充：chart 必须有 valueFormat、section id 唯一、>=1 chart section
    6. 大小：单 chart 数据点 <= 200、HTML <= 5MB
    7. 内联 JS 语法（node 存在则 --check，否则跳过）
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

VALUE_FORMAT_RE = re.compile(r"^(yi|wan|percent|signed_percent|sqm_wan|yuan)(:[0-9])?$")
FUNC_BLACKLIST = re.compile(r"function\s*\(|\beval\s*\(")
PLACEHOLDERS = ("{{REPORT_JSON}}", "{{REPORT_TITLE}}", "{{REPORT_META}}", "{{ECHARTS_LIB}}")
MAX_DATA_POINTS = 200
HTML_SIZE_LIMIT = 5 * 1024 * 1024


def validate_data(data):
    """校验已解析的 REPORT_JSON dict，返回错误字符串列表（空=通过）。"""
    errs = []

    def err(path, msg):
        errs.append("[%s] %s" % (path, msg))

    if not isinstance(data, dict):
        return ["[root] 报告必须是 JSON object"]
    for k in ("title", "kpis", "insight", "sections", "provenance"):
        if k not in data:
            err("root", "缺少必填字段 %s" % k)
    if errs:
        return errs
    if not str(data.get("title") or "").strip():
        err("title", "不能为空")
    if not str(data.get("insight") or "").strip():
        err("insight", "不能为空")

    kpis = data.get("kpis")
    if not isinstance(kpis, list) or not kpis:
        err("kpis", "必须是非空数组")
    else:
        for i, k in enumerate(kpis):
            if not isinstance(k, dict):
                err("kpis[%d]" % i, "必须是 object")
                continue
            if not str(k.get("label") or "").strip():
                err("kpis[%d].label" % i, "不能为空")
            if not str(k.get("value") or "").strip():
                err("kpis[%d].value" % i, "不能为空")
            if k.get("direction") is not None and k["direction"] not in ("up", "down", "neutral"):
                err("kpis[%d].direction" % i, "非法值 %r，允许 up/down/neutral" % k["direction"])

    sections = data.get("sections")
    chart_count = 0
    seen_ids = set()
    if not isinstance(sections, list) or not sections:
        err("sections", "必须是非空数组")
        sections = []
    for i, s in enumerate(sections):
        p = "sections[%d]" % i
        if not isinstance(s, dict):
            err(p, "必须是 object")
            continue
        sid = s.get("id")
        if not str(sid or "").strip():
            err(p + ".id", "不能为空")
        else:
            if sid in seen_ids:
                err(p + ".id", "重复 id %r" % sid)
            seen_ids.add(sid)
        if not str(s.get("tab") or "").strip():
            err(p + ".tab", "不能为空")
        stype = s.get("type")
        if stype not in ("chart-with-analysis", "table"):
            err(p + ".type", "非法值 %r，允许 chart-with-analysis/table" % stype)
            continue
        if stype == "chart-with-analysis":
            chart_count += 1
            _validate_chart_section(s, p, err)
        else:
            _validate_table_section(s, p, err)

    if sections and chart_count == 0:
        err("sections", "至少需要 1 个 chart-with-analysis section")

    prov = data.get("provenance")
    if not isinstance(prov, dict):
        err("provenance", "必须是 object")
    else:
        if not str(prov.get("query") or "").strip():
            err("provenance.query", "必填非空（SQL，用于审计）")

    _scan_blacklist(data, "$", errs)
    return errs


def _validate_chart_section(s, p, err):
    ch = s.get("chart")
    charts = ch if isinstance(ch, list) else ([ch] if ch else [])
    if not charts:
        err(p + ".chart", "chart-with-analysis 必须有 chart")
    for j, c in enumerate(charts):
        cp = p + (".chart[%d]" % j if isinstance(ch, list) else ".chart")
        if not isinstance(c, dict):
            err(cp, "必须是 object")
            continue
        if not str(c.get("id") or "").strip():
            err(cp + ".id", "不能为空")
        if not str(c.get("title") or "").strip():
            err(cp + ".title", "不能为空")
        vf = c.get("valueFormat")
        if not vf:
            err(cp + ".valueFormat", "必填（yi/wan/percent/signed_percent/sqm_wan/yuan，:N 小数位）")
        elif not isinstance(vf, str) or not VALUE_FORMAT_RE.match(vf):
            err(cp + ".valueFormat", "非法值 %r，允许 yi/wan/percent/signed_percent/sqm_wan/yuan 可带 :N" % vf)
        tt = c.get("tooltipTemplate")
        if tt is not None and tt not in ("multi", "pie"):
            err(cp + ".tooltipTemplate", "非法值 %r，允许 multi/pie" % tt)
        opt = c.get("option")
        if not isinstance(opt, dict):
            err(cp + ".option", "必须是 object")
        else:
            n = _count_data_points(opt)
            if n > MAX_DATA_POINTS:
                err(cp + ".option", "数据点 %d 超上限 %d（先聚合再报告）" % (n, MAX_DATA_POINTS))
    ana = s.get("analysis")
    if not isinstance(ana, list) or not ana:
        err(p + ".analysis", "chart-with-analysis 必须有非空 analysis[]")
    else:
        for k, a in enumerate(ana):
            ap = "%s.analysis[%d]" % (p, k)
            if not isinstance(a, dict):
                err(ap, "必须是 object")
                continue
            for f in ("label", "text"):
                if not str(a.get(f) or "").strip():
                    err(ap + "." + f, "不能为空")
            if a.get("color") not in ("blue", "pink", "cyan"):
                err(ap + ".color", "非法值 %r，允许 blue/pink/cyan" % a.get("color"))


def _validate_table_section(s, p, err):
    tbl = s.get("table")
    if not isinstance(tbl, dict):
        err(p + ".table", "table 类型必须有嵌套 table 对象（扁平式已废弃）")
        return
    if not isinstance(tbl.get("columns"), list) or not tbl["columns"]:
        err(p + ".table.columns", "必须是非空数组")
    if not isinstance(tbl.get("rows"), list) or not tbl["rows"]:
        err(p + ".table.rows", "必须是非空数组")
    ps = tbl.get("pageSize")
    if ps is not None and (not isinstance(ps, int) or ps < 1):
        err(p + ".table.pageSize", "必须是 >=1 的整数")


def _count_data_points(opt):
    n = 0
    for s_ in opt.get("series", []) or []:
        if isinstance(s_, dict) and isinstance(s_.get("data"), list):
            n += len(s_["data"])
    return n


def _scan_blacklist(obj, path, errs):
    """递归扫描字符串值里的旧函数格式。"""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in ("valueFormat", "tooltipTemplate"):
                continue  # 已由专门规则校验
            _scan_blacklist(v, "%s.%s" % (path, k), errs)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            _scan_blacklist(v, "%s[%d]" % (path, i), errs)
    elif isinstance(obj, str):
        if FUNC_BLACKLIST.search(obj):
            errs.append("[%s] 旧函数格式已废弃（%r...）→ 改用 valueFormat 声明" % (path, obj[:40]))


def validate_html(html, node_check=True):
    """校验已生成的 HTML：占位符残留 + 大小 + VALID 标记 + 内联 JS 语法。"""
    errs = []
    for ph in PLACEHOLDERS:
        if ph in html:
            errs.append("[html] 占位符 %s 未替换" % ph)
    if len(html.encode("utf-8")) > HTML_SIZE_LIMIT:
        errs.append("[html] 大小 %.1fMB 超上限 5MB" % (len(html.encode("utf-8")) / 1048576))
    if "__REPORT_VALID__" not in html:
        errs.append("[html] 缺少 __REPORT_VALID__ 标记（模板过旧或渲染脚本被破坏）")
    if node_check and shutil.which("node"):
        m = re.search(r"<script>\s*\(function\(\)\s*\{.*?\}\)\(\);?\s*</script>\s*</body>", html, re.S)
        inline_js = m.group(0) if m else ""
        if inline_js:
            fd, tmp = tempfile.mkstemp(suffix=".js")
            try:
                os.write(fd, inline_js.encode("utf-8"))
                os.close(fd)
                p = subprocess.run(["node", "--check", tmp], capture_output=True)
                if p.returncode != 0:
                    errs.append("[html] 内联 JS 语法错误: %s"
                                % p.stderr.decode("utf-8", "ignore")[:200])
            finally:
                os.unlink(tmp)
    return errs


def extract_json_from_html(html):
    """从 HTML 抽 var data = {...}; 段（json.dumps 单行产物，行内唯一分号在末尾）。"""
    m = re.search(r"var data = (\{.*\});", html)
    if not m:
        raise ValueError("HTML 中找不到 var data = ... 段")
    return json.loads(m.group(1))


def main(argv=None):
    ap = argparse.ArgumentParser(description="REPORT_JSON v2 校验器")
    ap.add_argument("target", help="report.json 或已生成的 report.html")
    ap.add_argument("--no-node", action="store_true", help="跳过 node 语法检查")
    args = ap.parse_args(argv)

    with open(args.target, "r", encoding="utf-8") as f:
        content = f.read()

    if args.target.endswith(".json"):
        try:
            data = json.loads(content)
        except json.JSONDecodeError as e:
            print("[FAIL] JSON 解析失败: %s" % e)
            return 1
        errs = validate_data(data)
    else:
        try:
            data = extract_json_from_html(content)
        except (ValueError, json.JSONDecodeError) as e:
            print("[FAIL] 抽取 REPORT_JSON 失败: %s" % e)
            return 1
        errs = validate_data(data) + validate_html(content, node_check=not args.no_node)

    if errs:
        for e in errs:
            print("[FAIL] " + e)
        print("")
        print("共 %d 个错误" % len(errs))
        return 1
    print("VALIDATION PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 5: 跑测试确认通过**

Run: `python -m pytest skills/report-generator/tests/test_validate_report.py -v`
Expected: 8 passed

- [ ] **Step 6: Commit**

```bash
git add skills/report-generator/scripts/validate_report.py skills/report-generator/tests/
git commit -m "feat(report): validator v2—schema+黑名单+占位符+大小校验，纯标准库"
```

---

### Task 3: 模板改造（删 eval，加 formatFactory）

**Files:**
- Modify: `skills/report-generator/templates/report-shell.html`（渲染 JS 区 445-870 行）

- [ ] **Step 1: 删除 reviveFunctions 及其调用**

1. 删除模板中 `reviveFunctions` 整个函数定义（约 458-481 行，注释 `Helper: revive function strings from JSON` 起至其闭合 `}`）
2. 删除 `initializeCharts` 内的调用行 `mergedOption = reviveFunctions(mergedOption);`（约 795 行）

验证：`grep -c "reviveFunctions\|eval(" skills/report-generator/templates/report-shell.html`
Expected: `0`

- [ ] **Step 2: 在 deepMerge 之后插入 formatFactory**

插入位置：`deepMerge` 函数闭合后、`/* ---- ECharts light base option ---- */` 注释前：

```javascript
  /* ---- Format factory: valueFormat 声明 → ECharts formatter ---- */
  var FORMAT_REGISTRY = {
    yi:             { div: 100000000, unit: '亿',  sep: false },
    wan:            { div: 10000,     unit: '万',  sep: true  },
    percent:        { div: 1,         unit: '%',   sep: false },
    signed_percent: { div: 1,         unit: '%',   sep: false, sign: true },
    sqm_wan:        { div: 10000,     unit: '万㎡', sep: false },
    yuan:           { div: 1,         unit: '元',  sep: true  }
  };
  var FORMAT_DEFAULT_DEC = { yi: 2, wan: 0, percent: 1, signed_percent: 1, sqm_wan: 1, yuan: 0 };

  function parseValueFormat(vf) {
    var m = /^([a-z_]+)(?::(\d))?$/.exec(vf || '');
    if (!m || !FORMAT_REGISTRY[m[1]]) return null;
    return {
      name: m[1],
      dec: m[2] !== undefined ? parseInt(m[2], 10) : FORMAT_DEFAULT_DEC[m[1]]
    };
  }

  function formatValue(v, spec) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    var cfg = FORMAT_REGISTRY[spec.name];
    var n = v / cfg.div;
    var out = cfg.sep
      ? n.toLocaleString('zh-CN', { minimumFractionDigits: spec.dec, maximumFractionDigits: spec.dec })
      : n.toFixed(spec.dec);
    return (cfg.sign && v > 0 ? '+' : '') + out + cfg.unit;
  }

  function formatFactory(vf, template) {
    var spec = parseValueFormat(vf);
    if (!spec) return null;
    return {
      axis: function (v) { return formatValue(v, spec); },
      label: function (p) { return formatValue(p.value, spec); },
      tooltip: (template === 'pie')
        ? function (p) { return p.name + ': ' + formatValue(p.value, spec) + ' (' + p.percent + '%)'; }
        : function (params) {
            var r = params[0].name + '<br/>';
            params.forEach(function (p) {
              r += p.marker + ' ' + p.seriesName + ': ' + formatValue(p.value, spec) + '<br/>';
            });
            return r;
          }
    };
  }
```

- [ ] **Step 3: initializeCharts 注入 formatter**

定位 `initializeCharts` 内这两行：

```javascript
          var mergedOption = deepMerge(darkBase, ch.option || {});
          var instance = echarts.init(dom);
```

在两者之间插入：

```javascript
          var fns = null;
          if (ch.valueFormat) {
            fns = formatFactory(ch.valueFormat, ch.tooltipTemplate || 'multi');
            if (!fns) {
              dom.innerHTML = '<div class="chart-error">非法 valueFormat: ' + escapeHTML(ch.valueFormat)
                + ' — 允许 yi/wan/percent/signed_percent/sqm_wan/yuan（可带 :N）</div>';
              return;
            }
          }
          if (fns) {
            var yAxes = mergedOption.yAxis;
            (Array.isArray(yAxes) ? yAxes : [yAxes]).forEach(function (ax) {
              if (!ax) return;
              ax.axisLabel = ax.axisLabel || {};
              if (!ax.axisLabel.formatter) ax.axisLabel.formatter = fns.axis;
            });
            if (!mergedOption.tooltip) mergedOption.tooltip = { trigger: 'axis' };
            if (!mergedOption.tooltip.formatter) mergedOption.tooltip.formatter = fns.tooltip;
            if (mergedOption.tooltip.trigger === 'item' || ch.tooltipTemplate === 'pie') {
              mergedOption.tooltip.trigger = 'item';
            }
            (mergedOption.series || []).forEach(function (se) {
              se.label = se.label || {};
              if (se.type === 'pie') {
                if (!se.label.formatter) se.label.formatter = function (p) {
                  return p.name + '\n' + p.percent + '%';
                };
              } else if (!se.label.formatter) {
                se.label.formatter = fns.label;
              }
            });
          }
```

- [ ] **Step 4: 模板尾部加 VALID 标记**

在最后一个 `})();` 之前（即 IIFE 收尾处）插入一行：

```javascript
  window.__REPORT_VALID__ = true;
```

- [ ] **Step 5: grep 验证**

Run:
```bash
grep -c "reviveFunctions\|eval(" skills/report-generator/templates/report-shell.html
grep -c "formatFactory\|FORMAT_REGISTRY" skills/report-generator/templates/report-shell.html
grep -c "__REPORT_VALID__" skills/report-generator/templates/report-shell.html
```
Expected: `0` / `>=4` / `>=1`

- [ ] **Step 6: Commit**

```bash
git add skills/report-generator/templates/report-shell.html
git commit -m "feat(report): 模板删eval/reviveFunctions，新增formatFactory+快速失败+VALID标记"
```

---

### Task 4: build.py（统一 builder，TDD）

**Files:**
- Create: `skills/report-generator/scripts/build.py`
- Create: `skills/report-generator/tests/test_report_builder.py`

- [ ] **Step 1: 写失败测试**

`skills/report-generator/tests/test_report_builder.py`：

```python
"""builder 端到端测试：JSON → HTML → 校验通过；非法 JSON 被拒。"""
import json
import os
import subprocess
import sys

SKILL_DIR = os.path.dirname(os.path.abspath(__file__))
BUILD_PY = os.path.normpath(os.path.join(SKILL_DIR, "..", "scripts", "build.py"))


def _sample():
    return {
        "title": "selftest 报告",
        "subtitle": "2026-08 | 生成: 2026-08-17",
        "kpis": [{"label": "累计达成", "value": "20.38亿", "change": "vs 预算 -20.0%", "direction": "down"}],
        "insight": "1-5月累计达成20.38亿，低于预算20%。",
        "sections": [
            {"id": "trend", "tab": "趋势", "type": "chart-with-analysis",
             "chart": {"id": "c1", "title": "月度趋势", "valueFormat": "yi:2",
                       "option": {"xAxis": {"type": "category", "data": ["1月", "2月", "3月", "4月", "5月"]},
                                  "yAxis": {"type": "value", "name": "金额(亿)"},
                                  "series": [{"name": "实际", "type": "line",
                                              "data": [235326388, 45844139, 427430907, 472816361, 505206331]}]}},
             "analysis": [{"label": "趋势判断", "color": "blue", "text": "V型反弹，3月恢复。"},
                          {"label": "风险", "color": "pink", "text": "预算持续落后。"}]},
            {"id": "data", "tab": "明细", "type": "table",
             "table": {"title": "明细", "columns": ["月", "达成"],
                       "rows": [["1月", "2.35亿"], ["2月", "0.46亿"]]}}
        ],
        "provenance": {"query": "SELECT 1", "source": "selftest", "skillVersion": "report-generator"}
    }


def test_build_end_to_end(tmp_path):
    jf = tmp_path / "r.json"
    jf.write_text(json.dumps(_sample(), ensure_ascii=False), encoding="utf-8")
    r = subprocess.run([sys.executable, BUILD_PY, "--json", str(jf), "--out", str(tmp_path)],
                       capture_output=True, text=True, encoding="utf-8")
    assert r.returncode == 0, "build 失败:\n%s\n%s" % (r.stdout, r.stderr)
    htmls = list(tmp_path.glob("report_*.html"))
    assert len(htmls) == 1, "应生成 1 个 HTML: %s" % htmls
    html = htmls[0].read_text(encoding="utf-8")
    assert "__REPORT_VALID__" in html
    for ph in ("{{REPORT_JSON}}", "{{REPORT_TITLE}}", "{{REPORT_META}}", "{{ECHARTS_LIB}}"):
        assert ph not in html
    assert "selftest 报告" in html


def test_build_rejects_invalid_json(tmp_path):
    bad = _sample()
    del bad["provenance"]
    jf = tmp_path / "bad.json"
    jf.write_text(json.dumps(bad, ensure_ascii=False), encoding="utf-8")
    r = subprocess.run([sys.executable, BUILD_PY, "--json", str(jf), "--out", str(tmp_path)],
                       capture_output=True, text=True, encoding="utf-8")
    assert r.returncode != 0
    assert "provenance.query" in (r.stdout + r.stderr)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python -m pytest skills/report-generator/tests/test_report_builder.py -v`
Expected: FAIL（build.py 不存在，subprocess 报错或 FileNotFound）

- [ ] **Step 3: 写 build.py**

`skills/report-generator/scripts/build.py`：

```python
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""build.py — REPORT_JSON v2 → 独立 HTML 报告（零依赖，Python 3.9+）。

用法:
    python build.py --json report.json [--domain sales-performance] [--out reports/]
    python build.py --selftest

流程: 读 JSON → validator 强制前置（不过即止）→ 模板组装 → 写文件 → 复验 → 打印路径(+URL)
"""
import argparse
import datetime
import json
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL_DIR = os.path.normpath(os.path.join(HERE, ".."))
TEMPLATE = os.path.join(SKILL_DIR, "templates", "report-shell.html")
ECHARTS = os.path.join(SKILL_DIR, "templates", "echarts.min.js")
DEFAULT_OUT = os.path.normpath(os.path.join(SKILL_DIR, "..", "..", "reports"))

sys.path.insert(0, HERE)
import validate_report  # noqa: E402


def build_html(data, echarts_lib, title, meta):
    with open(TEMPLATE, "r", encoding="utf-8") as f:
        html = f.read()
    html = html.replace("{{ECHARTS_LIB}}", "<script>\n" + echarts_lib + "\n</script>")
    html = html.replace("{{REPORT_TITLE}}", title)
    html = html.replace("{{REPORT_META}}", meta)
    html = html.replace("{{REPORT_JSON}}", json.dumps(data, ensure_ascii=False))
    return html


def check_server():
    """health 通则返回报告基 URL，否则 None。"""
    try:
        urllib.request.urlopen("http://localhost:8080/health", timeout=1).read()
        return "http://localhost:8080/"
    except Exception:
        return None


def do_build(json_path, domain, out_dir):
    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    errs = validate_report.validate_data(data)
    if errs:
        print("构建中止：report.json 校验失败")
        for e in errs:
            print("[FAIL] " + e)
        return 1
    with open(ECHARTS, "r", encoding="utf-8") as f:
        echarts_lib = f.read()
    html = build_html(data, echarts_lib, str(data.get("title", "")), str(data.get("subtitle", "")))
    os.makedirs(out_dir, exist_ok=True)
    fname = "report_%s_%s.html" % (domain, datetime.date.today().strftime("%Y%m%d"))
    out_path = os.path.join(out_dir, fname)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(html)
    post = validate_report.validate_html(html, node_check=False)
    if post:
        print("生成后校验失败")
        for e in post:
            print("[FAIL] " + e)
        return 1
    print("OK " + out_path)
    base = check_server()
    if base:
        print("URL " + base + fname)
    else:
        print("SERVER_DOWN 未检测到报告服务器，仅本地路径可用（可运行 python report_server.py）")
    return 0


SELFTEST_JSON = {
    "title": "selftest 报告",
    "subtitle": "selftest | 生成: auto",
    "kpis": [{"label": "KPI", "value": "1.00亿", "direction": "neutral"}],
    "insight": "selftest。",
    "sections": [
        {"id": "trend", "tab": "趋势", "type": "chart-with-analysis",
         "chart": {"id": "c1", "title": "图", "valueFormat": "yi:2",
                   "option": {"xAxis": {"type": "category", "data": ["1月", "2月"]},
                              "yAxis": {"type": "value"},
                              "series": [{"name": "s", "type": "line", "data": [1, 2]}]}},
         "analysis": [{"label": "a", "color": "blue", "text": "t"}]},
        {"id": "data", "tab": "明细", "type": "table",
         "table": {"columns": ["A"], "rows": [["1"]]}}
    ],
    "provenance": {"query": "SELECT 1"}
}


def do_selftest(out_dir):
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        jf = os.path.join(td, "selftest.json")
        with open(jf, "w", encoding="utf-8") as f:
            json.dump(SELFTEST_JSON, f, ensure_ascii=False)
        r = do_build(jf, "selftest", td)
        if r != 0:
            print("SELFTEST FAIL")
            return 1
        html_path = os.path.join(td, "report_selftest_%s.html" % datetime.date.today().strftime("%Y%m%d"))
        with open(html_path, "r", encoding="utf-8") as f:
            html = f.read()
        ok = ("__REPORT_VALID__" in html) and ("{{" not in html)
        print("SELFTEST " + ("PASS" if ok else "FAIL"))
        return 0 if ok else 1


def main(argv=None):
    ap = argparse.ArgumentParser(description="REPORT_JSON v2 → HTML builder")
    ap.add_argument("--json", dest="json_path")
    ap.add_argument("--domain", default="report")
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        return do_selftest(args.out)
    if not args.json_path:
        ap.error("需要 --json 或 --selftest")
    return do_build(args.json_path, args.domain, args.out)


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: 跑全部测试确认通过**

Run: `python -m pytest skills/report-generator/tests/ -v`
Expected: 10 passed（8 validator + 2 builder）

- [ ] **Step 5: selftest 冒烟**

Run: `python skills/report-generator/scripts/build.py --selftest`
Expected: 末行 `SELFTEST PASS`

- [ ] **Step 6: Commit**

```bash
git add skills/report-generator/scripts/build.py skills/report-generator/tests/test_report_builder.py
git commit -m "feat(report): build.py 统一 builder—validator 前置强制+selftest"
```

---

### Task 5: SKILL.md 重写 + pytest.ini + 废弃标注

**Files:**
- Modify: `skills/report-generator/SKILL.md`
- Modify: `pytest.ini`
- Modify: `build_report.py`、`scripts/build_dealer_report.py`、`scripts/build_mom_report.py`、`scripts/build_sales_report.py`、`scripts/gen_report.py`、`scripts/generate_report.py`、`scripts/generate_sales_report.py`、`scripts/test_report.py`（共 8 个，仅头部）

- [ ] **Step 1: SKILL.md 重写**

保留原文件的：frontmatter（description 按下文更新）、触发条件、适用范围、视觉风格、Report Server 整节。其余按以下内容重写（工作流从 6 步手拼收编为 3 步）：

```markdown
---
name: report-generator
description: 跨域报告生成工具。当用户在收到 Analyst 输出后说"生成报告"、"导出 HTML"、"做个报告"、"生成 HTML 报告"、"转成 HTML"等关键词时自动激活。写纯 JSON（valueFormat 声明，无 JS 函数）→ build.py 一条命令出报告。严禁旧 charts[]/扁平table/trace 格式与任何 JS 函数串。
---

# Report Generator

将 Analyst 的 Markdown 查询结果转换为独立可分享的深色主题 HTML 报告（内嵌 ECharts、AI 分析文字、数据溯源）。

（触发条件 / 适用范围 / 视觉风格：保留原文）

## 快速开始（唯一工作流）

1. **读契约**：`references/report-schema.json` + 下方 valueFormat 表
2. **写 report.json**：纯 JSON。顶层五字段 title/kpis/insight/sections/provenance；
   每个 chart 必须有 `valueFormat`；表格用嵌套 `table:{title,columns,rows,pageSize}`；
   provenance 必须有 `query`（完整 SQL）
3. **一条命令构建**：
   ```bash
   python3 skills/report-generator/scripts/build.py --json report.json --domain sales-performance
   ```
   校验不过会逐条打印 `[FAIL] 字段路径: 原因`，修完重跑。产物：`reports/report_{domain}_{YYYYMMDD}.html`

## valueFormat 格式声明表（核心协议）

| 声明 | 输出 | 说明 |
|---|---|---|
| `yi` / `yi:1` | 5.05亿 / 5.1亿 | 亿量纲，默认2位小数 |
| `wan` / `wan:1` | 4,728万 / 4,728.5万 | 万量纲，整数部分千分位 |
| `percent` | 26.2% | 百分比，默认1位 |
| `signed_percent` | +6.9% / -19.3% | 带符号百分比，默认1位 |
| `sqm_wan` | 120.5万㎡ | 面积 |
| `yuan` | 334,080,608元 | 千分位整数元 |

`tooltipTemplate`：`multi`（默认，多系列悬停）/ `pie`（`名称: 3.4亿 (26%)`）

**⛔ 数据里不允许任何 JS 函数**：formatter/symbolSize/color 函数一律改用 `valueFormat`
声明。旧函数串会被 validator 直接拒绝（`[FAIL] 旧函数格式已废弃`）。

## REPORT_JSON v2 结构

（保留原正确示例框架，chart 对象用 `"valueFormat": "yi:2"` 替代所有 formatter 字符串；
表格用嵌套 table；provenance 用 query 字段存 SQL）

## 生成前思考（原 Step 1 内容保留：读懂数据/提炼结论/识别质量/构思叙事）

## Report Server（保留原文整节）

## 生产服务器部署

```bash
# 服务器（/home/dp-user/dataprojv2）
git pull
python3 skills/report-generator/scripts/build.py --selftest
# SELFTEST PASS 即环境就绪
```

## 关键规则

1. 数据纯 JSON、零 JS 函数；chart 必须有 valueFormat
2. validator 不过不出 HTML；错误带字段路径，按行修
3. 表格嵌套式 section.table；provenance.query 必填
4. 最多 4 图表 Tab + 1 明细 Tab；单图数据点 <=200
5. 饼图分类 <=8；大表 >50 行分页
6. ECharts 本地内嵌，离线可开
7. build.py 自动校验+复验；server 未起只给路径不给假 URL

## 已废弃脚本

`build_report.py` 与 `scripts/` 下 6 个报表脚本为历史产物（硬编码数据/路径），
新报告一律走 build.py。
```

- [ ] **Step 2: pytest.ini**

```ini
[pytest]
testpaths = skills/report-generator/tests scripts
python_files = test_*.py
python_classes = Test*
python_functions = test_*
asyncio_mode = auto
```

- [ ] **Step 3: 8 个文件加废弃头**

对 `build_report.py`、`scripts/build_dealer_report.py`、`scripts/build_mom_report.py`、`scripts/build_sales_report.py`、`scripts/gen_report.py`、`scripts/generate_report.py`、`scripts/generate_sales_report.py`、`scripts/test_report.py`，在各自 docstring 首行后插入一行：

```python
[DEPRECATED 2026-08] 已废弃 — 统一改用 skills/report-generator/scripts/build.py。此脚本留存仅作历史参考，内含硬编码数据/路径，勿在新报告使用。
```

- [ ] **Step 4: 全量测试 + commit**

Run: `python -m pytest skills/report-generator/tests/ -v`
Expected: 10 passed

```bash
git add skills/report-generator/SKILL.md pytest.ini build_report.py scripts/
git commit -m "docs(report): SKILL.md 收编 build.py 工作流+格式声明表；8脚本标注废弃"
```

---

### Task 6: 端到端验收（真实数据）

**Files:**
- Create: `report.json`（项目根，验收后删除）
- 产物: `reports/report_sales-performance_20260817.html`（gitignored）

- [ ] **Step 1: 写真实数据 report.json**

用 eval 验证过的真实数字：月度达成 `[235326388, 45844139, 427430907, 472816361, 505206331]`、预算 `[219198800, 93583100, 577477100, 596425500, 673771500]`、去年同期 `[128763599, 192470751, 598735857, 613459526, 582566799]`（1-5月）。KPI：累计达成 16.87亿 / vs 预算 -21.9% 等。provenance.query 填模式 A 真实 SQL（Mix 表 calmonth BETWEEN + node_desc2 + data_source IN）。图表 `valueFormat: "yi:2"`，表格嵌套式，analysis 带数字结论。

- [ ] **Step 2: 构建**

Run: `python skills/report-generator/scripts/build.py --json report.json --domain sales-performance`
Expected:
```
OK reports/report_sales-performance_20260817.html
URL http://localhost:8080/report_sales-performance_20260817.html
```
（或 `SERVER_DOWN ...` 行——两者都算通过）

- [ ] **Step 3: HTML 复验**

Run: `python skills/report-generator/scripts/validate_report.py reports/report_sales-performance_20260817.html`
Expected: `VALIDATION PASS`

- [ ] **Step 4: 浏览器人工验收**

打开 HTML 核对：KPI 卡、insight 横幅、Tab 切换、图表渲染（**轴标签显示 2.35亿 而非 235326388**）、表格分页、溯源区 SQL 显示、console 无错误。

- [ ] **Step 5: 负路径验收**

构造缺 provenance.query 的 JSON（`python -c` 或编辑副本）→ build → Expected: 打印 `[FAIL] [provenance.query] ...` 且 exit 1。

- [ ] **Step 6: 清理 + 确认提交线**

```bash
rm report.json
git log --oneline -5
```
Expected: Task 1-5 的 5 个 commit 在线。

---

## Self-Review

**1. Spec 覆盖：**
- §0 生产兼容（零依赖/3.9+/相对路径/node 可选/selftest/git pull 部署）→ Task 2/4 实现（纯标准库、`__file__` 定位、tempfile 版 node 检查、`--selftest`、Task 5 SKILL.md 部署节）✓
- §1 格式声明 6 种 + tooltipTemplate → Task 1（pattern）+ Task 3（FORMAT_REGISTRY/formatFactory）✓
- §2 模板删 eval/reviveFunctions、formatFactory 注入、快速失败、VALID 标记 → Task 3 ✓
- §3 schema + validator + 测试布局（conftest/2 测试文件/pytest.ini 幽灵目录修复）→ Task 1/2/5 ✓
- §4 builder 强制前置 + selftest + SKILL.md 收编 + 7 脚本废弃标注 → Task 4/5 ✓
- §5 错误处理表（JSON 坏/SVF 非法/echarts 缺失/node 缺/server 未起）→ Task 2/4；echarts 缺失由 `open(ECHARTS)` 抛 IOError 自然中断 ✓
- §6 验收（selftest 双端/真实数据/负路径）→ Task 6 + Task 4 Step 5；Linux 侧 selftest 属部署时验收，SKILL.md 部署节已写明 ✓
- §7 交付物 9 项 → 文件结构表逐一对应 ✓

**2. 占位符扫描：** 初稿曾用"故意埋错+修正标注"的写法，已全部重写为直接正确的代码；当前计划无 TBD/TODO/占位路径。SKILL.md 重写节中的"（保留原文…）"是引用既有文件内容的指令而非占位。

**3. 类型一致性：** `validate_data(data)->list[str]` Task 2 定义、Task 4 `import validate_report` 复用 ✓；`formatFactory` Task 3 定义并同任务内消费 ✓；`__REPORT_VALID__` Task 3 写入、Task 2/4/6 校验 ✓；`report_{domain}_{YYYYMMDD}.html` Task 4 定义、Task 6 使用 ✓；`do_build(json_path, domain, out_dir)` 签名在 selftest 调用处一致 ✓。

---

## 执行注意事项

1. Task 3 是纯 JS 改造，无 pytest 可跑，靠 grep 断言（Step 5）+ Task 6 浏览器验收间接验证。
2. Task 6 的 Linux 侧 selftest 在生产部署时执行（git pull 后 `--selftest`），本计划在 Windows 开发机完成全部开发验证。
3. `scripts/test_report.py` 加废弃头后仍会被 pytest 收集（testpaths 含 scripts），但其无 test_ 函数、import 无副作用，不影响结果。
