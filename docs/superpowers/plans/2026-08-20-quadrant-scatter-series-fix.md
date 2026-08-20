# 四象限散点图产品系列修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复报告生成器中散点图（毛利贡献四象限/库存风险散点）产品系列不可辨识的问题——图例列出每个产品、气泡独立配色、悬停 tooltip 正常、气泡直标产品名。

**Architecture:** 三处联动修复：① `chart-recipes.md` 配方改为每产品一个 series（治本，Agent 产出正确）；② `report-shell.html` 模板修两个 bug（item-trigger tooltip 单参数分支、scatter 标签自动开启）；③ `validate_report.py` 加守卫规则（单 series ≥2 命名散点 → 构建失败，回归保护）。最后用迁移脚本把现有报告 JSON 机械拆分为新格式并重建验证。

**Tech Stack:** Python 3.9+（build.py/validate_report.py/迁移脚本）、纯 JS 模板（report-shell.html，内嵌 ECharts 5.5.0）、pytest 单测。

## Global Constraints

- 报告数据是纯 JSON——JSON 里不允许任何 JS 函数串（`formatter`/`symbolSize` 函数一律用 `valueFormat` 声明，validator 黑名单拒绝）。
- validator 不过不出 HTML；`provenance.query` 必填；chart 必须有 `valueFormat`。
- 单图数据点 ≤200；表格用嵌套式 `section.table`。
- 工作流唯一入口 `build.py`；构建产物 `report_{domain}_{YYYYMMDD}.html` 写入 JSON 同目录（`--out` 可覆盖）。
- `reports/`、`output/` 目录 gitignore——迁移的 JSON 与重建的 HTML **不提交**。
- 运行环境 Python 固定 `/usr/bin/python3`；测试命令 `python3 -m pytest skills/report-generator/tests/ -v`（conftest.py 已注入 `scripts/` 到 sys.path）。

---

### Task 1: Validator 守卫规则（散点多命名点 → 拒绝）

**Files:**
- Modify: `skills/report-generator/scripts/validate_report.py`（`_validate_chart_section` 的 series 循环内）
- Test: `skills/report-generator/tests/test_validate_report.py`

**Interfaces:**
- Consumes: `validate_report.validate_data(report_dict) -> list[str]`（已有）
- Produces: 新错误消息（含 `series[i]` 路径与「拆分」字样），供 Task 5 构建时复验

- [ ] **Step 1: 写失败测试**

在 `skills/report-generator/tests/test_validate_report.py` 末尾追加：

```python
# ---------- 散点守卫（四象限修复） ----------

def test_scatter_multi_named_points_fails():
    """单 series 多个命名散点（四象限病根）必须被拒绝。"""
    r = _base_report()
    r["sections"][0]["chart"]["option"] = {
        "tooltip": {"trigger": "item"},
        "series": [{"name": "系列", "type": "scatter",
                    "data": [{"name": "素色", "value": [32.2, 36.0], "symbolSize": 60},
                             {"name": "质臻", "value": [-5.9, 44.8], "symbolSize": 47}]}]}
    errs = vr.validate_data(r)
    assert any("series[0]" in e and "拆分" in e for e in errs), errs


def test_scatter_per_product_series_passes():
    """每产品独立 series（每系列一个命名点）应通过。"""
    r = _base_report()
    r["sections"][0]["chart"]["option"] = {
        "tooltip": {"trigger": "item"},
        "series": [
            {"name": "素色", "type": "scatter", "data": [{"value": [32.2, 36.0], "symbolSize": 60}]},
            {"name": "质臻", "type": "scatter", "data": [{"value": [-5.9, 44.8], "symbolSize": 47}]}]}
    assert vr.validate_data(r) == []


def test_scatter_unnamed_array_points_pass():
    """热力图/无命名数组点的散点不受影响。"""
    r = _base_report()
    r["sections"][0]["chart"]["option"] = {
        "series": [{"name": "s", "type": "scatter", "data": [[1, 2], [3, 4]]}]}
    assert vr.validate_data(r) == []
```

- [ ] **Step 2: 运行确认失败**

Run: `/usr/bin/python3 -m pytest skills/report-generator/tests/test_validate_report.py -v -k scatter`
Expected: `test_scatter_multi_named_points_fails` FAIL（`validate_data` 返回空列表，断言 `any(...)` 不成立）；另两个 PASS（尚未加规则，单系列未拆分本就通过）。

- [ ] **Step 3: 实现守卫规则**

`skills/report-generator/scripts/validate_report.py` 中 `_validate_chart_section` 的 series 循环（约 142-150 行）：

```python
            for si, se in enumerate(opt.get("series") or []):
                if isinstance(se, dict):
                    svf = se.get("valueFormat")
                    if svf is not None and (not isinstance(svf, str) or not VALUE_FORMAT_RE.match(svf)):
                        err(cp + ".option.series[%d].valueFormat" % si,
                            "非法值 %r，允许 yi/wan/percent/signed_percent/sqm_wan/yuan/int 可带 :N" % svf)
```

在 `svf` 校验块之后、同一 `if isinstance(se, dict):` 缩进内追加：

```python
                    if se.get("type") == "scatter":
                        sdata = se.get("data") or []
                        named = sum(1 for dp in sdata if isinstance(dp, dict) and dp.get("name"))
                        if named >= 2:
                            err(cp + ".option.series[%d]" % si,
                                "散点含 %d 个命名点，应拆分为每产品独立 series（每个 series 一个数据点）" % named)
```

- [ ] **Step 4: 运行确认全绿**

Run: `/usr/bin/python3 -m pytest skills/report-generator/tests/test_validate_report.py -v`
Expected: 全部 PASS（含原有用例 + 3 个新用例）。

- [ ] **Step 5: 提交**

```bash
git add skills/report-generator/scripts/validate_report.py skills/report-generator/tests/test_validate_report.py
git commit -m "feat(report-generator): validator 拒绝单 series 多命名散点（四象限修复守卫）"
```

---

### Task 2: 模板修两 bug（item-trigger tooltip 单参数分支 + scatter 标签自动开启）

**Files:**
- Modify: `skills/report-generator/templates/report-shell.html`（`initializeCharts` 内 tooltip 块 ~845-866 行、label 块 ~867-877 行）
- Test: `skills/report-generator/tests/test_report_builder.py`（静态护栏）

**Interfaces:**
- Consumes: 模板既有变量 `mergedOption`/`seriesSpecs`/`chartSpec`/`ch`/`yAxes`/`parseValueFormat`/`formatValue`（均在 `initializeCharts` 作用域内）
- Produces: 渲染行为——item 触发 tooltip 显示「marker + seriesName + 数值」；scatter 气泡自动直标产品名

- [ ] **Step 1: 写静态护栏测试**

`skills/report-generator/tests/test_report_builder.py` 末尾追加：

```python
def test_template_scatter_label_and_item_tooltip_present():
    """模板必须含散点标签自动开启与 item-trigger 单参数 tooltip 分支（静态回归护栏）。"""
    tpl = (SKILL_DIR / ".." / "templates" / "report-shell.html").resolve()
    src = tpl.read_text(encoding="utf-8")
    assert "labelLayout" in src          # Fix B：散点标签防重叠
    assert "hasExplicitLabel" in src     # Fix B：尊重 JSON 显式 label
    assert "isItemTrigger" in src        # Fix A：item 触发单参数分支
    assert "return p.seriesName" in src  # Fix B：气泡直标产品名
```

- [ ] **Step 2: 运行确认失败**

Run: `/usr/bin/python3 -m pytest skills/report-generator/tests/test_report_builder.py -k template_scatter -v`
Expected: FAIL（断言不成立，模板尚无这些标记）。

- [ ] **Step 3: Fix A — tooltip item 分支**

`report-shell.html` 中，把当前 tooltip 块（约 845-861 行）：

```js
              if (!mergedOption.tooltip.formatter) {
                mergedOption.tooltip.formatter = (ch.tooltipTemplate === 'pie')
                  ? function (p) {
                      var sp = seriesSpecs[p.seriesIndex] || chartSpec;
                      return p.name + ': ' + (sp ? formatValue(p.value, sp) : p.value) + ' (' + p.percent + '%)';
                    }
                  : function (params) {
                      var r = params[0].name + '<br/>';
                      params.forEach(function (p) {
                        var sp = seriesSpecs[p.seriesIndex] || chartSpec;
                        r += p.marker + ' ' + p.seriesName + ': ' + (sp ? formatValue(p.value, sp) : p.value) + '<br/>';
                      });
                      return r;
                    };
              }
              if (mergedOption.tooltip.trigger === 'item' || ch.tooltipTemplate === 'pie') {
                mergedOption.tooltip.trigger = 'item';
              }
```

整体替换为：

```js
              if (mergedOption.tooltip.trigger === 'item' || ch.tooltipTemplate === 'pie') {
                mergedOption.tooltip.trigger = 'item';
              }
              var isItemTrigger = mergedOption.tooltip.trigger === 'item';
              if (!mergedOption.tooltip.formatter) {
                mergedOption.tooltip.formatter = (ch.tooltipTemplate === 'pie')
                  ? function (p) {
                      var sp = seriesSpecs[p.seriesIndex] || chartSpec;
                      return p.name + ': ' + (sp ? formatValue(p.value, sp) : p.value) + ' (' + p.percent + '%)';
                    }
                  : (isItemTrigger
                    ? function (p) {
                        /* item 触发（散点）：params 是单个对象，seriesName=产品名；value 是 [x, y] */
                        var sp = seriesSpecs[p.seriesIndex] || chartSpec;
                        var v = p.value;
                        var txt = Array.isArray(v)
                          ? v.map(function (vv, idx) {
                              var ysp = (idx === 1 && yAxes && yAxes[0] && yAxes[0].valueFormat)
                                ? parseValueFormat(yAxes[0].valueFormat) : null;
                              return formatValue(vv, ysp || sp || chartSpec);
                            }).join(', ')
                          : (sp ? formatValue(v, sp) : v);
                        var label = p.seriesName || p.name || '';
                        return (p.marker ? p.marker + ' ' : '') + label + ': ' + txt;
                      }
                    : function (params) {
                        var r = params[0].name + '<br/>';
                        params.forEach(function (p) {
                          var sp = seriesSpecs[p.seriesIndex] || chartSpec;
                          r += p.marker + ' ' + p.seriesName + ': ' + (sp ? formatValue(p.value, sp) : p.value) + '<br/>';
                        });
                        return r;
                      });
              }
```

说明：`isItemTrigger` 在 trigger 归一化**之后**计算，覆盖两种来源（JSON 的 `trigger:'item'` 与 `tooltipTemplate:'pie'`）；pie 仍走原单参数分支（含百分比）不变；`[x, y]` 数组值第二维优先用 yAxis 的 `valueFormat`（如 `percent:1` → `36.0%`），第一维与 yAxis 无格式时回退 chart 级 spec。

- [ ] **Step 4: Fix B — scatter 标签自动开启**

`report-shell.html` 中，把当前 series label 块（约 867-877 行）：

```js
              (mergedOption.series || []).forEach(function (se, i) {
                if (!se) return;
                se.label = se.label || {};
                if (se.type === 'pie') {
                  if (!se.label.formatter) se.label.formatter = function (p) {
                    return p.name + '\n' + p.percent + '%';
                  };
                } else if (!se.label.formatter) {
                  var sp2 = seriesSpecs[i];
                  if (sp2) se.label.formatter = function (p) { return formatValue(p.value, sp2); };
                }
              });
```

整体替换为：

```js
              (mergedOption.series || []).forEach(function (se, i) {
                if (!se) return;
                var hasExplicitLabel = !!se.label;
                se.label = se.label || {};
                if (se.type === 'pie') {
                  if (!se.label.formatter) se.label.formatter = function (p) {
                    return p.name + '\n' + p.percent + '%';
                  };
                } else if (se.type === 'scatter') {
                  /* Fix B：散点气泡直标产品名（seriesName）；JSON 显式声明 label 则尊重原样 */
                  if (!hasExplicitLabel) {
                    se.label.show = true;
                    se.label.position = 'top';
                    if (!se.label.formatter) se.label.formatter = function (p) { return p.seriesName; };
                    if (!se.labelLayout) se.labelLayout = { hideOverlap: true };
                  }
                } else if (!se.label.formatter) {
                  var sp2 = seriesSpecs[i];
                  if (sp2) se.label.formatter = function (p) { return formatValue(p.value, sp2); };
                }
              });
```

说明：`hasExplicitLabel` 在 `se.label = se.label || {}` **之前**取值，保证 JSON 显式写的 `label:{show:false}` 不被覆盖；scatter 跳过通用数值 formatter（气泡标签显示产品名而非数值），bar/line 行为不变。

- [ ] **Step 5: 运行验证**

Run 1: `/usr/bin/python3 -m pytest skills/report-generator/tests/ -v`
Expected: 全部 PASS（新护栏 + 既有 builder/validator 用例）。

Run 2: `/usr/bin/python3 skills/report-generator/scripts/build.py --selftest`
Expected: 输出 `SELFTEST PASS`（模板占位符完整、validator 复验通过）。

- [ ] **Step 6: 提交**

```bash
git add skills/report-generator/templates/report-shell.html skills/report-generator/tests/test_report_builder.py
git commit -m "fix(report-generator): 模板修 item-trigger tooltip 单参数分支 + scatter 标签自动开启"
```

---

### Task 3: 迁移脚本（单 series → 每产品独立 series）

**Files:**
- Create: `skills/report-generator/scripts/migrate_scatter_series.py`
- Test: `skills/report-generator/tests/test_migrate_scatter.py`

**Interfaces:**
- Consumes: 报告 JSON（顶层 `sections[]`；`chart-with-analysis` 的 `chart` 单对象或数组）
- Produces: `migrate_chart(option: dict) -> bool`（原地拆分，返回是否变更）、`migrate(data: dict) -> int`（统计变更 chart 数）、`main(argv)`（`--json` 回写文件）

- [ ] **Step 1: 写失败测试**

创建 `skills/report-generator/tests/test_migrate_scatter.py`：

```python
"""migrate_scatter_series 单测：单 series 多命名点散点 → 每产品独立 series。"""
import migrate_scatter_series as mig  # conftest 已注入 scripts/


def _quadrant():
    return {"tooltip": {"trigger": "item"},
            "series": [{"name": "系列", "type": "scatter",
                        "data": [{"name": "素色", "value": [32.2, 36.0], "symbolSize": 60},
                                 {"name": "质臻", "value": [-5.9, 44.8], "symbolSize": 47}],
                        "markLine": {"symbol": "none", "data": [{"xAxis": 0}, {"yAxis": 40}]}}]}


def test_split_named_scatter_into_series():
    opt = _quadrant()
    assert mig.migrate_chart(opt) is True
    sers = opt["series"]
    assert len(sers) == 2
    assert [s["name"] for s in sers] == ["素色", "质臻"]
    assert sers[0]["data"] == [{"value": [32.2, 36.0], "symbolSize": 60}]
    assert sers[1]["data"] == [{"value": [-5.9, 44.8], "symbolSize": 47}]
    assert sers[0]["markLine"]["data"] == [{"xAxis": 0}, {"yAxis": 40}]  # 分割线挂第一个
    assert "markLine" not in sers[1]
    assert opt.get("color")  # 拆分后自动补 10 色板


def test_no_change_for_per_product_series():
    opt = {"series": [{"name": "素色", "type": "scatter",
                       "data": [{"value": [1, 2], "symbolSize": 10}]}]}
    assert mig.migrate_chart(opt) is False
    assert len(opt["series"]) == 1


def test_no_change_for_unnamed_points():
    opt = {"series": [{"name": "s", "type": "scatter", "data": [[1, 2], [3, 4]]}]}
    assert mig.migrate_chart(opt) is False


def test_keeps_non_scatter_series():
    opt = {"series": [{"name": "bar", "type": "bar", "data": [1]},
                      {"name": "系列", "type": "scatter",
                       "data": [{"name": "A", "value": [1, 2], "symbolSize": 5},
                                {"name": "B", "value": [3, 4], "symbolSize": 6}]}]}
    assert mig.migrate_chart(opt) is True
    assert opt["series"][0]["name"] == "bar"
    assert len(opt["series"]) == 3


def test_migrate_full_report_counts_charts():
    data = {"sections": [
        {"id": "a", "type": "chart-with-analysis",
         "chart": [{"id": "c1", "title": "t", "valueFormat": "signed_percent:1", "option": _quadrant()},
                   {"id": "c2", "title": "t", "valueFormat": "signed_percent:1", "option": _quadrant()}]},
        {"id": "b", "type": "table", "table": {"columns": ["A"], "rows": [["1"]]}}]}
    assert mig.migrate(data) == 2
```

- [ ] **Step 2: 运行确认失败**

Run: `/usr/bin/python3 -m pytest skills/report-generator/tests/test_migrate_scatter.py -v`
Expected: 全部 FAIL（ModuleNotFoundError: migrate_scatter_series）。

- [ ] **Step 3: 实现脚本**

创建 `skills/report-generator/scripts/migrate_scatter_series.py`：

```python
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""migrate_scatter_series.py — 把单 series 多命名点的散点拆分为每产品独立 series。

四象限/风险散点修复的迁移工具：旧报告 JSON（Agent 按旧配方产出）不经重新查询，
机械拆分后即可过新 validator 并重建。用法:
    python3 migrate_scatter_series.py --json reports/user:4/sku_series_quadrant.json
"""
import argparse
import json
import sys

# 与 chart-recipes.md §2 一致的 10 色板（series 数 > 8 时 chart 级声明，防 palette 循环撞色）
PALETTE = ["#2563EB", "#06B6D4", "#7C3AED", "#DB2777", "#F59E0B",
           "#10B981", "#EF4444", "#8B5CF6", "#EC4899", "#14B8A6"]


def migrate_chart(opt):
    """原地拆分 chart.option 中的单 series 多命名散点。返回是否发生过拆分。"""
    if not isinstance(opt, dict):
        return False
    changed = False
    series = opt.get("series") or []
    out = []
    for se in series:
        if not isinstance(se, dict) or se.get("type") != "scatter":
            out.append(se)
            continue
        data = se.get("data") or []
        named = [dp for dp in data if isinstance(dp, dict) and dp.get("name")]
        if len(named) < 2:
            out.append(se)
            continue
        changed = True
        mark = se.get("markLine")  # 分割线只挂拆分后的第一个 series
        for i, dp in enumerate(named):
            new_se = dict(se)
            new_se.pop("markLine", None)
            new_se["name"] = dp["name"]
            new_se["data"] = [{"value": dp["value"], "symbolSize": dp.get("symbolSize", 20)}]
            if i == 0 and mark is not None:
                new_se["markLine"] = mark
            out.append(new_se)
    opt["series"] = out
    if changed and not opt.get("color"):
        opt["color"] = list(PALETTE)
    return changed


def migrate(data):
    """遍历报告 sections，统计发生拆分的 chart 数。"""
    n = 0
    for s in data.get("sections", []):
        if s.get("type") != "chart-with-analysis":
            continue
        ch = s.get("chart")
        charts = ch if isinstance(ch, list) else ([ch] if ch else [])
        for c in charts:
            if isinstance(c, dict) and isinstance(c.get("option"), dict):
                if migrate_chart(c["option"]):
                    n += 1
    return n


def main(argv=None):
    ap = argparse.ArgumentParser(description="拆分单 series 多命名散点为每产品独立 series（原地回写）")
    ap.add_argument("--json", required=True)
    args = ap.parse_args(argv)
    with open(args.json, "r", encoding="utf-8") as f:
        data = json.load(f)
    n = migrate(data)
    if n:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print("已拆分 %d 个 scatter chart，回写 %s" % (n, args.json))
    else:
        print("未发现需拆分的 scatter chart，文件未改动")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: 运行确认全绿**

Run: `/usr/bin/python3 -m pytest skills/report-generator/tests/test_migrate_scatter.py -v`
Expected: 5 个用例全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add skills/report-generator/scripts/migrate_scatter_series.py skills/report-generator/tests/test_migrate_scatter.py
git commit -m "feat(report-generator): 散点迁移脚本（单 series → 每产品独立 series）"
```

---

### Task 4: 配方重写（chart-recipes.md §2 四象限气泡）

**Files:**
- Modify: `skills/report-generator/references/chart-recipes.md`（§2，当前 28-52 行）

**Interfaces:**
- Consumes: 无
- Produces: Agent 产出规范（新报告直接写成每产品一 series）

- [ ] **Step 1: 重写 §2**

把当前 §2（`## 2. 四象限气泡（散点+分割线）` 起，到 `## 3.` 前止）整体替换为：

````markdown
## 2. 四象限气泡（散点+分割线）

要点：逐点 `symbolSize` 由分析师预计算（建议 `8 + 52 * sqrt(v/max_v)`，√面积感知）；分割线用声明式 markLine（xAxis/yAxis 值）。**每个产品一个独立 series**（series name = 产品名）——图例列出全部产品、气泡独立配色、悬停 tooltip 显示产品名。**严禁**把多个命名数据点塞进同一个 scatter series（validator 会拒绝构建）。

```json
{
  "id": "quad", "title": "SKU 效益四象限", "valueFormat": "signed_percent:1",
  "option": {
    "tooltip": {"trigger": "item"},
    "color": ["#2563EB", "#06B6D4", "#7C3AED", "#DB2777", "#F59E0B",
              "#10B981", "#EF4444", "#8B5CF6", "#EC4899", "#14B8A6"],
    "xAxis": {"type": "value", "name": "销售增长率%"},
    "yAxis": {"type": "value", "name": "毛利率%"},
    "series": [
      {"name": "SKU-A", "type": "scatter", "data": [{"value": [12.5, 30.2], "symbolSize": 40}]},
      {"name": "SKU-B", "type": "scatter", "data": [{"value": [-8.1, 15.0], "symbolSize": 22}]},
      {"name": "SKU-C", "type": "scatter", "data": [{"value": [3.2, 9.8], "symbolSize": 15}]}
    ]
  }
}
```

规则：
- **每产品一个 series**，数据点是单个对象 `{"value": [x, y], "symbolSize": n}`，不带 `name`（产品名在 `series.name` 上）。
- **markLine 分割线只挂在 `series[0]`**；不要挂独立空系列（会污染图例）。
- **series 数 > 8 时 chart 级声明 `color`**（上例 10 色，防 palette 循环撞色）。
- 气泡标签由模板自动开启（直标产品名）；如确需关闭，显式写 `"label": {"show": false}`。
````

- [ ] **Step 2: 提交**

```bash
git add skills/report-generator/references/chart-recipes.md
git commit -m "docs(report-generator): 四象限气泡配方改为每产品一 series + markLine/color 规则"
```

---

### Task 5: 迁移真实报告 + 重建 + 验证

**Files:**
- Run on: `reports/user:4/sku_series_quadrant.json`（gitignore，不回库）
- Produce: `reports/user:4/report_sales-performance_20260820.html`（gitignore，不回库）

**Interfaces:**
- Consumes: Task 3 的 `migrate_scatter_series.py`（真实运行）、Task 2 的模板修复（重建后肉眼可验）、Task 1 的守卫规则（构建时复验）

- [ ] **Step 1: 运行迁移脚本**

Run: `/usr/bin/python3 skills/report-generator/scripts/migrate_scatter_series.py --json reports/user:4/sku_series_quadrant.json`
Expected: `已拆分 4 个 scatter chart，回写 reports/user:4/sku_series_quadrant.json`（结论页 2 图 + 图表页 2 图）。

- [ ] **Step 2: 验证迁移结果**

Run:

```bash
/usr/bin/python3 - <<'EOF'
import json
d = json.load(open('reports/user:4/sku_series_quadrant.json'))
for s in d['sections']:
    if 'chart' not in s:
        continue
    for c in (s['chart'] if isinstance(s['chart'], list) else [s['chart']]):
        sers = c['option']['series']
        sc = [se for se in sers if se['type'] == 'scatter']
        if sc:
            print(c['title'], '| scatter series:', len(sc),
                  '| 首个 markLine:', 'markLine' in sc[0],
                  '| color:', len(c['option'].get('color', [])))
EOF
```

Expected: 4 个散点 chart 各自打印 `scatter series: 10 | 首个 markLine: True | color: 10`。

- [ ] **Step 3: 重建 HTML**

Run: `/usr/bin/python3 skills/report-generator/scripts/build.py --json reports/user:4/sku_series_quadrant.json --domain sales-performance`
Expected: 无 `[FAIL]`，输出 `OK reports/user:4/report_sales-performance_20260820.html`（构建后校验含 Task 1 新规则，验证迁移格式合规）。

- [ ] **Step 4: 验证 HTML 内嵌数据**

Run:

```bash
/usr/bin/python3 - <<'EOF'
import re, json
html = open('reports/user:4/report_sales-performance_20260820.html', encoding='utf-8').read()
assert '__REPORT_VALID__' in html
m = re.search(r'var data = (\{.*?\});', html, re.S)
d = json.loads(m.group(1))
c = d['sections'][0]['chart']
names = [se['name'] for se in c['option']['series']]
print('结论页四象限系列:', names)
EOF
```

Expected: 打印 10 个产品名（素色/质臻/微理石/岩萃/尚木/世界印象/尊石/墙面岩板/自然/简约素色）。

- [ ] **Step 5: 全套测试**

Run: `/usr/bin/python3 -m pytest skills/report-generator/tests/ -v`
Expected: 全部 PASS。

- [ ] **Step 6: 人工目视确认**

请用户打开 `reports/user:4/report_sales-performance_20260820.html`（系统 UI 的「打开报告」按钮），确认：
1. 四象限图图例列出 10 个产品名，每气泡独立颜色；
2. 气泡上方直标产品名，无重叠（hideOverlap 生效）；
3. 悬停气泡 tooltip 显示「产品名: 增长率%, 毛利率%」；
4. 库存风险散点图同样正常。

（无 git 提交——`reports/` 在 .gitignore 中，产物不入库。）
