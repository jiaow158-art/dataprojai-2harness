# 图表配方 v2.1 — 帕累托 / 四象限气泡 / 热力图 / 瀑布

> 全部纯 JSON（零 JS 函数）。单图数据点 ≤200，超出先 TOP-N 聚合。

## 1. 帕累托（柱=金额，线=累计占比）

要点：双 yAxis 各自带 `valueFormat`；series 各自带 `valueFormat`（覆盖 chart 级默认）。

```json
{
  "id": "pareto", "title": "SKU 帕累托", "valueFormat": "yi:2",
  "option": {
    "xAxis": {"type": "category", "data": ["SKU1", "SKU2", "SKU3"]},
    "yAxis": [
      {"type": "value", "name": "销售额(亿)", "valueFormat": "yi:2"},
      {"type": "value", "name": "累计占比", "valueFormat": "percent", "max": 100}
    ],
    "series": [
      {"name": "销售额", "type": "bar", "data": [500000000, 300000000, 200000000], "valueFormat": "yi:2"},
      {"name": "累计占比", "type": "line", "yAxisIndex": 1, "data": [50, 80, 100], "valueFormat": "percent"}
    ]
  }
}
```

80% 核心线（可选）：`"markLine": {"data": [{"yAxis": 80}]}` 加在折线 series 上。

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

## 3. 热力图（渠道 × SKU）

要点：visualMap 声明 min/max；x=渠道、y=SKU、value=指标；TOP-N 控制点数（如 20 SKU × 8 渠道 = 160 ≤ 200）。

```json
{
  "id": "heat", "title": "渠道×SKU 销售额热力", "valueFormat": "wan",
  "option": {
    "tooltip": {"trigger": "item"},
    "grid": {"height": "60%"},
    "xAxis": {"type": "category", "data": ["零售", "整装头部", "工程"], "splitArea": {"show": true}},
    "yAxis": {"type": "category", "data": ["SKU1", "SKU2"], "splitArea": {"show": true}},
    "visualMap": {"min": 0, "max": 10000000, "calculable": true, "orient": "horizontal", "left": "center", "bottom": "0%"},
    "series": [{"name": "销售额", "type": "heatmap",
      "data": [[0, 0, 5200000], [1, 0, 1800000], [2, 1, 900000]]}]
  }
}
```

## 4. 瀑布图（利润/增量拆解）

要点：堆叠柱两系列——`base` 透明垫底（`itemStyle.color: "rgba(0,0,0,0)"`、`emphasis` 关闭），`value` 实际增量；负值由分析师换算进 base/value 两个正数列。

```json
{
  "id": "waterfall", "title": "效益利润瀑布", "valueFormat": "wan",
  "option": {
    "xAxis": {"type": "category", "data": ["分摊后毛利", "跌价", "资金成本", "效益利润"]},
    "yAxis": {"type": "value", "valueFormat": "wan"},
    "series": [
      {"name": "base", "type": "bar", "stack": "w", "itemStyle": {"color": "rgba(0,0,0,0)"},
       "emphasis": {"itemStyle": {"color": "rgba(0,0,0,0)"}}, "data": [0, 8000, 7000, 0]},
      {"name": "金额", "type": "bar", "stack": "w", "valueFormat": "wan",
       "data": [10000, 2000, 1000, 9000]}
    ]
  }
}
```

## 表格条件着色（tone）

单元格 `字符串` 或 `{"v": "文本", "tone": "good|warn|bad|na"}`（绿/黄/红/灰）。适用：健康标记、评分档位、达成率红绿灯。

```json
"table": {"columns": ["SKU", "健康状态", "评分"],
          "rows": [["SKU-A", {"v": "正常", "tone": "good"}, {"v": "88", "tone": "good"}],
                   ["SKU-B", {"v": "滞销", "tone": "bad"}, {"v": "42", "tone": "warn"}]]}
```
