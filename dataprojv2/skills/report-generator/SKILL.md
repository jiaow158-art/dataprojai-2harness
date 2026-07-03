---
name: report-generator
description: 跨域报告生成工具。当用户在收到 Analyst 输出后说"生成报告"、"导出 HTML"、"做个报告"、"生成 HTML 报告"、"转成 HTML"等关键词时自动激活。读取模板 report-shell.html，按 sections[]+kpis[]+insight+provenance 结构组装数据，输出独立可分享的深色主题 HTML 文件。严禁使用已废弃的 charts[]/table/trace 旧格式。
---

# Report Generator

生成交互式深色主题 HTML 报告。将 Analyst 的 Markdown 查询结果转换为独立的、可分享的 HTML 文件，内嵌 ECharts 图表、AI 分析文字和数据溯源。

> **⛔ 废弃格式警告**：不要使用 `charts[]`、`table`、`trace` 等顶层字段。模板只识别 `sections[]` + `kpis[]` + `insight` + `provenance`。用旧格式 = 页面空白。

## 触发条件

**被动调用**：仅在用户明确说以下关键词时激活：
- "生成报告"
- "导出 HTML"
- "转成 HTML 报告"
- "生成 HTML"
- "做个报告"

不影响现有对话式分析流程。用户在收到 Analyst 的 Markdown 结果后，主动要求才触发。

## 适用范围

跨域工具。可用于所有 4 个已覆盖业务域：
- fin-cost（财务费用）
- inventory（库存仓储）
- ar（应收账款）
- sales-performance（销售业绩）

## 视觉风格

深色商务主题（Dark Pro）——深蓝/深紫底色 + 渐变高亮。报告离线可打开，可直接分享。

## 工作流

### Step 1：理解数据，形成判断

收到 Analyst 的 Markdown 输出后，**先思考再动手**：

1. **读懂**数据维度、量级、时间跨度
2. **提炼** 1-3 条核心结论：趋势是什么、有什么异常、风险在哪
3. **识别**数据质量问题：空值、异常值、缺失维度、可疑的统计口径
4. **构思**报告的叙事结构：分几个 Tab，每个 Tab 讲什么故事

这一步的思考不写入报告，但指导后续所有步骤。

### Step 2：设计报告结构

基于 Step 1 的判断，决定：

1. **Tab 分几个**：按数据维度拆分（时间→趋势分析，渠道→渠道对比，品类→品类构成...），加上最后的"明细数据"Tab
2. **每个 Tab 放什么图表**：对照 `references/chart-decision.md` 选择
3. **Insight 横幅**：用 1-3 句话概括核心结论，必须带具体数字
4. **分析文字方向**：每个 Tab 从哪个角度解读（趋势/对比/风险/归因）

### Step 3：生成图表配置

1. **必须先读取** `references/echarts-patterns.md`，找到对应 option 骨架
2. 将实际数据填入骨架
3. **深色主题自动适配**：模板 JS 会自动合并 dark base option，你只需关注数据和图表类型
4. **tooltip formatter**：根据数值量级生成合适格式：
   - 亿级：`(v/100000000).toFixed(2) + '亿'`
   - 万级：`(v/10000).toFixed(0) + '万'`
   - 百分比：直接显示
5. **颜色语义**：实际达成=实线蓝、预算=虚线绿、去年同期=点线黄

### Step 4：撰写分析文字

**每个 `chart-with-analysis` 类型的 section 必须有 `analysis[]`。**

每项结构：`{ "label": "标签名", "color": "blue|pink|cyan", "text": "分析文字" }`

分析文字要求：
- **具体**：必须带数字支撑，如"3月恢复至4.27亿"而非"3月有所恢复"
- **有判断**：趋势判断、风险提示、归因分析，不做无意义的描述
- **禁止空话**：不写"总体来看数据表现良好"、"各维度有差异"等废话
- **标注风险用粉色**（`color: "pink"`），正面信号用蓝色（`color: "blue"`），中性观察用青色（`color: "cyan"`）

每个 Tab 建议 2 条分析（如：趋势判断 + 风险提示），不要超过 3 条。

### Step 5：构建溯源信息

从 Analyst 的 Markdown 输出中提取以下信息，构建 `provenance` 对象：

```json
{
  "source": "表名",
  "lastUpdate": "数据最后更新日期",
  "skillVersion": "使用的 analyst/knowledge skill",
  "query": "实际执行的 SQL（完整复制）",
  "filters": ["筛选条件1", "筛选条件2"],
  "limitations": ["已知口径限制"],
  "dataQuality": ["Step 1 中发现的数据质量问题"]
}
```

`query` 字段必须包含完整 SQL，方便读者审计数据口径。`dataQuality` 记录你在 Step 1 发现的问题。

### Step 6：组装输出

1. **读取模板壳** `templates/report-shell.html`
2. **替换占位符**：
   - `{{REPORT_TITLE}}` → 报告标题
   - `{{REPORT_META}}` → 数据期间 + 生成时间
   - `{{ECHARTS_LIB}}` → `<script>` + echarts.min.js 内容 + `</script>`
   - `{{REPORT_JSON}}` → 完整 JSON 对象
3. **构建 REPORT_JSON**：按 sections 结构组装，确保每个 section 有 `id`、`tab`、`type`
4. **输出 HTML 文件**：保存到当前工作目录，文件名格式 `report_{domain}_{YYYYMMDD}.html`

**自检清单**（全部通过才输出）：
- [ ] Insight 横幅包含具体数字和结论（不是空泛描述）
- [ ] 每个 Tab 有分析文字（`chart-with-analysis` 类型必须有 `analysis[]`）
- [ ] 溯源信息完整（source + query + filters + limitations）
- [ ] 分析文字避免了空话套话
- [ ] 数值列不会被 formatNumbers 破坏（中文单位值、百分比、"—" 不受影响）
- [ ] 图表类型匹配数据特征（对照 chart-decision.md 复核）
- [ ] ECharts option 完整（series + xAxis/yAxis + tooltip）
- [ ] 文件大小合理（ECharts ~1MB + 数据，>5MB 警告）

## REPORT_JSON 结构

**⛔ 错误示例（旧格式，会导致页面空白）**：
```json
// ❌ 绝对禁止这种结构！
{
  "title": "...",
  "charts": [{ "id": "...", "option": {} }],
  "table": { "columns": [], "rows": [] },
  "trace": { "table": "...", "sql": "..." }
}
```

**✅ 正确示例（唯一允许的格式）**：
```json
{
  "title": "报告标题",
  "subtitle": "2026-01 ~ 2026-05 | 生成: 2026-06-10",
  "kpis": [
    { "label": "指标名", "value": "16.87亿", "change": "vs 预算 -21.9%", "direction": "down" }
  ],
  "insight": "1-3句核心结论，带具体数字。风险用红色标注。",
  "sections": [
    {
      "id": "trend",
      "tab": "趋势分析",
      "type": "chart-with-analysis",
      "chart": { "id": "chart-trend", "title": "月度趋势", "option": {} },
      "analysis": [
        { "label": "趋势判断", "color": "blue", "text": "具体分析文字..." },
        { "label": "风险提示", "color": "pink", "text": "具体风险描述..." }
      ]
    },
    {
      "id": "data",
      "tab": "明细数据",
      "type": "table",
      "columns": ["列1", "列2"],
      "rows": [["值1", "值2"]],
      "pageSize": 20
    }
  ],
  "provenance": {
    "source": "表名",
    "lastUpdate": "更新日期",
    "skillVersion": "skill名",
    "query": "SQL语句",
    "filters": [],
    "limitations": [],
    "dataQuality": []
  }
}
```

**sections[].type 说明**：
- `chart-with-analysis`：图表 + 分析文字，chart 可以是单个对象或数组（2个图并排）
- `table`：数据明细表，带分页

## 关键规则

1. **必须先读 reference 再动手**：Step 3 读 `echarts-patterns.md`
2. **数值格式化**：万级用 `XX.XX万`，亿级用 `XX.XX亿`，百分比保留1位小数
3. **图表数量**：最多 4 个 Tab 含图表 + 1 个明细数据 Tab
4. **大表保护**：数据 >50 行自动分页；>10万行建议聚合
5. **饼图限制**：分类 ≤8，超出归"其他"
6. **离线自包含**：ECharts 从本地 `templates/echarts.min.js` 内嵌，不依赖 CDN
7. **溯源不可省略**：`provenance` 对象必须有 `query` 字段
8. **分析文字不可省略**：每个图表 Tab 必须有 `analysis[]`

## 跨域共享参考

本 Skill 为跨域工具，不直接查询 DWS 数据库。数据来源为上游 Analyst Skill 的 Markdown 输出。

如遇数据问题（口径不清、字段不明），建议用户先回到对应领域的 Analyst Skill 确认数据准确性，再重新生成报告。
