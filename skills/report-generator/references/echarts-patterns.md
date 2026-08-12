# ECharts 配置模式库

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

每种图表类型的 ECharts option 骨架。Claude 在 Step 3（生成图表配置）时：
1. 根据 Step 2 选定的图表类型，找到对应的 option 骨架
2. 将实际数据填入 `series`、`xAxis.data`、`yAxis` 等字段
3. 标题、颜色、tooltip 格式按需微调

## 通用配置（所有图表类型共用）

```javascript
// 所有 option 都包含以下基础配置
{
  tooltip: {
    trigger: 'axis',        // 或 'item'（饼图用）
    formatter: '{b}: {c}',  // 按需覆盖为带单位的格式
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderColor: '#e0e0e0',
    textStyle: { color: '#333', fontSize: 13 }
  },
  toolbox: {
    feature: {
      saveAsImage: { title: '保存为图片' },
      dataView: { title: '数据视图', readOnly: true }
    },
    right: 20
  },
  grid: {
    left: '3%',
    right: '8%',
    bottom: '15%',
    top: '15%',
    containLabel: true
  },
}
```

## Pattern 1: 折线图 (line)

适用于：时间序列趋势。

```javascript
{
  tooltip: { trigger: 'axis' },
  xAxis: {
    type: 'category',
    data: [/* 日期数组，如 ['2026-01', '2026-02', ...] */],
    axisLabel: { rotate: 0 },
    name: '/* 时间单位，如 "月份" */'
  },
  yAxis: {
    type: 'value',
    name: '/* 数值单位，如 "金额（元）" */',
    axisLabel: {
      formatter: function(v) { return (v / 10000).toFixed(0) + '万'; }
      // 按数值量级调整：百万级用 v/1000000+'百万'，亿级用 v/100000000+'亿'
    }
  },
  series: [{
    name: '/* 系列名称 */',
    type: 'line',
    data: [/* 数值数组，顺序对应 xAxis.data */],
    smooth: true,
    symbol: 'circle',
    symbolSize: 6,
    markLine: {
      silent: true,
      data: [{ type: 'average', name: '均值' }]
    }
  }],
  dataZoom: [{
    // 仅当 xAxis 数据点 > 12 时启用
    type: 'slider',
    start: 0,
    end: 100,
    height: 20,
    bottom: 0
  }]
}
```

**多系列变体**：`series` 数组包含多个对象，每个对象 `name` 不同，legend 自动生成。

## Pattern 2: 柱状图 (bar)

适用于：分类排行、分组对比。

```javascript
{
  tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
  xAxis: {
    type: 'category',
    data: [/* 分类数组，如 ['瓷砖事业部', '卫浴事业部', ...] */],
    axisLabel: {
      rotate: 45,           // 标签 >4 个字时旋转
      interval: 0           // 显示所有标签
    }
  },
  yAxis: {
    type: 'value',
    name: '/* 数值单位 */',
    axisLabel: {
      formatter: function(v) { return (v / 10000).toFixed(0) + '万'; }
    }
  },
  series: [{
    name: '/* 系列名称 */',
    type: 'bar',
    data: [/* 数值数组 */],
    itemStyle: { borderRadius: [4, 4, 0, 0] },
    label: {
      show: true,
      position: 'top',
      formatter: function(p) { return (p.value / 10000).toFixed(1) + '万'; }
    }
  }]
}
```

**横向柱状图变体**（适合长标签，如客户名称）：
- 交换 xAxis/yAxis 的 type：`yAxis: { type: 'category', data: [...] }`，`xAxis: { type: 'value' }`
- `label.position` 改为 `'right'`

**分组柱状图变体**（多系列对比）：
- `series` 数组多个 `{ type: 'bar', name: '...', data: [...] }`
- `legend: { data: ['系列1', '系列2', ...] }`

## Pattern 3: 饼图 (pie)

适用于：占比构成。

```javascript
{
  tooltip: {
    trigger: 'item',
    formatter: '{b}: {c} ({d}%)'
  },
  legend: {
    type: 'scroll',
    orient: 'vertical',
    right: 10,
    top: 'middle'
  },
  series: [{
    name: '/* 分类名称 */',
    type: 'pie',
    radius: ['40%', '70%'],    // 环形图；实心饼图用 '70%'
    center: ['40%', '50%'],    // 给 legend 留空间
    data: [
      { value: 1234567, name: '分类A' },
      { value: 2345678, name: '分类B' }
      // ... 每个分类 { value, name }
    ],
    label: {
      formatter: '{b}: {d}%'
    },
    emphasis: {
      itemStyle: { shadowBlur: 10, shadowOffsetX: 0, shadowColor: 'rgba(0,0,0,0.5)' }
    }
  }]
}
```

**约束**：分类数 ≤8，超出归"其他"。只有一个分类时不用饼图，用 KPI 卡片。

## Pattern 4: 数据表 (table)

适用于：明细数据，不适合画图。

```html
<div class="table-wrapper">
  <table class="data-table">
    <thead>
      <tr>
        <!-- 表头，从数据列名生成，中文优先 -->
        <th>序号</th>
        <th>分类</th>
        <th class="num">金额（元）</th>
      </tr>
    </thead>
    <tbody>
      <!-- 
        数据行：
        - 数值列加 class="num"（右对齐，千分位）
        - 每行第一个 <td> 是序号（从 1 开始）
        - >50 行启用分页控件
      -->
      <tr>
        <td>1</td>
        <td>销售一部</td>
        <td class="num">12,345,678.00</td>
      </tr>
    </tbody>
  </table>
  <!-- >50 行时显示分页 -->
  <div class="pagination">
    <button class="page-btn active">1</button>
    <button class="page-btn">2</button>
    ...
  </div>
</div>
```

分页逻辑由 `report-shell.html` 中的脚本处理，此处只需生成完整 `<tbody>`，脚本自动分页。

## Pattern 5: KPI 指标卡片 (kpi)

适用于：单行汇总数据。

```html
<div class="kpi-cards">
  <div class="kpi-card">
    <div class="kpi-label">/* 指标名称，如"费用总额" */</div>
    <div class="kpi-value">/* 大数字，如"12.35亿" */</div>
    <div class="kpi-change positive">↑ 12.5%</div>  <!-- positive/negative/none -->
  </div>
  <!-- 最多 6 个卡片并排 -->
</div>
```

**数值格式化规则**：
- 万元以下：显示原始值（如 `123,456.00`）
- 万级：`XX.XX万`
- 千万/亿级：`XX.XX亿`
- 百分比：保留 1 位小数

## 交互配置速查

```javascript
// dataZoom — 底部滑杆（时间序列 >12 点时启用）
dataZoom: [{ type: 'slider', start: 0, end: 100, height: 20, bottom: 0 }]

// toolbox — 工具栏（所有图表都加）
toolbox: { feature: { saveAsImage: {}, dataView: { readOnly: true } }, right: 20 }

// tooltip 单位格式化
tooltip: { formatter: function(params) { return params[0].name + ': ' + (params[0].value/10000).toFixed(2) + '万'; } }
```
