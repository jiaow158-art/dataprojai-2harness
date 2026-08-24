# 设计：四象限散点图产品系列修复

日期：2026-08-20
状态：已批准（用户确认方案 A）

## 1. 背景与根因

用户反馈：生成的报告中"毛利贡献四象限图"的产品系列出不来，图例只有一个条目。

定位（报告 `reports/user:4/sku_series_quadrant.json` → `report_sales-performance_20260820.html`，仿古砖系列效益双图分析）：

**数据侧（病根）**：四象限图 10 个产品系列（素色/质臻/微理石/岩萃/尚木/世界印象/尊石/墙面岩板/自然/简约素色）全部塞进**一个** scatter series（名为"系列"），无 `label`、无 `legend.data` → 图例只显示一条"系列"，10 个气泡同色、无名称标注、无法区分产品。
- `skills/report-generator/references/chart-recipes.md` §2（四象限气泡配方）**教唆了这种写法**（单 series + 命名数据点、不开 label）→ Agent 照配方产出，每次都会复现。

**渲染侧（模板 bug，所有散点图通病）**：
1. tooltip：模板对 `trigger:'item'` 的散点也装多参数 formatter（`params[0].name`），但 item 触发时 ECharts 传**单个对象** → `params[0]` undefined → TypeError → 悬停 tooltip 空白，连产品名都查不到。
2. `se.label` 只设 formatter、未设 `show:true` → 气泡名称永不显示。

## 2. 目标与成功标准

**目标**：散点类图表（毛利贡献四象限、库存风险散点）上产品系列可辨识——图例列出每个产品、气泡独立配色、悬停 tooltip 正常、气泡可直标产品名。

**成功标准**：
1. 重建后的仿古砖报告：图例显示 10 个产品名，每气泡独立颜色。
2. 悬停气泡 tooltip 显示产品名 + 格式化数值。
3. 按新配方新生成的报告不再复现"只有一条系列"。
4. validator 拒绝"单系列 ≥2 个命名点"的散点（回归保护）。
5. 现有自动化测试全绿。

## 3. 方案（用户选定 A：配方 + 模板 + 守卫全修）

### 3.1 数据侧 — `chart-recipes.md` §2 配方重写

新配方：**每产品一个 series**（系列名 = 产品名，数据点为单点对象保留 `symbolSize`）。

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

规则要点（写入配方文档）：
- **markLine 分割线仅挂在 `series[0]`**（不挂独立空系列——空系列会污染图例）。
- **series 数 > 8 时 chart 级声明 `color` 数组**（10 色），防 palette 循环撞色。
- 气泡标签由模板自动开启（见 3.2 Fix B），配方注明无需手写 `label`；如需关闭可显式 `label: {show: false}`。

### 3.2 渲染侧 — `templates/report-shell.html` 修两个 bug

**Fix A（tooltip item 分支）**：`initializeCharts` 中，最终 trigger 为 `item`（`mergedOption.tooltip.trigger === 'item'` 或 `tooltipTemplate === 'pie'`）时：
- pie → 现有单参数分支（`p.name + ': ' + ... + (p.percent + '%')`）不变；
- **scatter/item → 单参数分支**：`p.marker + p.seriesName + ': ' + formatValue(p.value, spec)`（产品名来自 seriesName）；
- 仅 trigger 为 `axis` 才走现有多参数分支（`params[0].name` + 逐系列循环）。

**Fix B（scatter 标签自动开启 + formatter 冲突解决）**：
- **现有通用 label formatter 分支跳过 `scatter`**：模板现在会对所有非 pie 系列设置 `label.formatter = formatValue(p.value)`（标签显示数值）。这对 bar/line 合理，但对四象限气泡会把产品名盖成数值 → scatter 系列跳过该分支（bar/line 行为不变）。
- **scatter 且 JSON 未显式声明 `se.label` 时自动补**：
  - `label.show = true`、`label.position = 'top'`、`labelLayout = {hideOverlap: true}`（ECharts 5.5.0 支持）；
  - `label.formatter = function(p){ return p.seriesName; }`（气泡直标**产品名**，seriesName 必定存在、无空值风险）。

JSON 显式声明过 `label` 时尊重 JSON（不做覆盖）。

### 3.3 守卫 — `scripts/validate_report.py` 新规则

`_validate_chart_section` 的 series 循环内新增：`se.type === 'scatter'` 且 `data` 中带 `name` 的命名点 **≥2** → error「散点命名点应拆分为每产品独立 series（scatter series[%d]）」。

- 热力图（data 为无 name 的数组点）、pie（type 非 scatter）不受影响。
- `tests/test_validate_report.py` 加用例：合法多 series 散点通过；单 series 多命名点被拒。

### 3.4 迁移脚本 + 重建验证

新增 `skills/report-generator/scripts/migrate_scatter_series.py`：
- 输入：现有 `reports/user:4/sku_series_quadrant.json`；
- 对每个含 ≥2 命名点的 scatter series：拆分为每产品独立 series（name=点 name，data=[{value, symbolSize}]）；
- markLine 移到拆分后第一个 series；chart 级若无 `color` 则补 3.1 的 10 色板；
- 输出回写同 JSON → 经 `build.py` 重建 `reports/user:4/report_sales-performance_20260820.html`。

4 处散点图全部转换：结论页「毛利贡献四象限」「库存风险散点」+ 图表页 2 个。

验证：`build.py --selftest` 通过；用户打开重建报告目视确认（图例 10 项、独立配色、悬停 tooltip）。

## 4. 改动文件清单

| 文件 | 改动 |
|---|---|
| `skills/report-generator/references/chart-recipes.md` | §2 配方重写为每产品一 series + markLine/color 规则 |
| `skills/report-generator/templates/report-shell.html` | Fix A tooltip item 分支；Fix B scatter label 自动开启 |
| `skills/report-generator/scripts/validate_report.py` | 新守卫规则（scatter ≥2 命名点 → 拒绝） |
| `skills/report-generator/tests/test_validate_report.py` | 新规则用例 |
| `skills/report-generator/scripts/migrate_scatter_series.py` | 新增：单系列拆分为多系列迁移脚本 |
| `reports/user:4/sku_series_quadrant.json` | 迁移后回写（重建数据） |
| `reports/user:4/report_sales-performance_20260820.html` | 重建产物 |

## 5. 测试与风险

- 自动化：validator 新规则单测（test_validate_report.py）；迁移后 JSON 过 validator + 构建成功。模板 JS 行为无 JS 测试基建，靠重建后目视验证（不引入新测试框架）。
- 风险：label 自动开启可能让非四象限 scatter 变拥挤——只对 `scatter` 生效、可被 JSON 显式 label 覆盖，影响面可控；10 点以内 hideOverlap 足够。
