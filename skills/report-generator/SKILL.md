---
name: report-generator
description: 跨域报告生成工具。当用户在收到 Analyst 输出后说"生成报告"、"导出 HTML"、"做个报告"、"生成 HTML 报告"、"转成 HTML"等关键词时自动激活。读取模板 report-shell.html，按 sections[]+kpis[]+insight+provenance 结构组装数据，输出独立可分享的深色主题 HTML 文件。严禁使用已废弃的 charts[]/table/trace 旧格式。
---

# Report Generator

生成交互式深色主题 HTML 报告。将 Analyst 的 Markdown 查询结果转换为独立的、可分享的 HTML 文件，内嵌 ECharts 图表、AI 分析文字和数据溯源。

> **⛔ 废弃格式警告**：不要使用 `charts[]`、`table`、`trace` 等顶层字段。模板只识别 `sections[]` + `kpis[]` + `insight` + `provenance`。用旧格式 = 页面空白。

> **⛔ 输出 URL 是强制步骤，不可省略！** 报告必须保存到 `reports/` 目录，并且必须在输出中打印可访问的 URL。**只输出本地文件路径视为生成失败。**
> ```
> ✅ 报告已生成: reports/report_xxx.html
> 🌐 在线访问: http://192.168.18.231:8080/report_xxx.html
> ```

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

### Step 0：确保报告服务器运行

**生成报告前必须先确认 `report_server.py` 正在运行**，否则生成的 URL 无法访问。

```bash
# 检查服务器是否在运行
curl -s http://localhost:8080/health 2>/dev/null && echo "OK" || echo "DOWN"

# 如果未运行，启动它
nohup python3 report_server.py > reports/server.log 2>&1 &
```

如果端口 8080 不通，用 `REPORT_PORT=5000` 换端口。确认服务器正常后再继续。

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

### Step 6：组装输出并输出 URL（⛔ 不可跳过）

1. **读取模板壳** `templates/report-shell.html`
2. **替换占位符**：
   - `{{REPORT_TITLE}}` → 报告标题
   - `{{REPORT_META}}` → 数据期间 + 生成时间
   - `{{ECHARTS_LIB}}` → `<script>` + echarts.min.js 内容 + `</script>`
   - `{{REPORT_JSON}}` → 完整 JSON 对象
3. **构建 REPORT_JSON**：按 sections 结构组装，确保每个 section 有 `id`、`tab`、`type`
4. **用 Python 脚本写入文件**：不要只描述路径，必须实际执行 Python/Write 工具将 HTML 写入 `reports/` 目录。先 `mkdir -p reports`，文件名格式 `report_{domain}_{YYYYMMDD}.html`

> **🔥 函数转义陷阱（最常见的翻车原因）**：`{{REPORT_JSON}}` 被直接嵌入 JavaScript 源码（`var data = {{REPORT_JSON}};`），**不是** `JSON.parse()` 的字符串参数。因此：
> - ❌ **禁止**在函数体内使用 `\"` 转义引号——`return \"<b>\"+name` 在 JS 源码中是**语法错误**
> - ❌ **禁止**在函数值末尾放多余的 `"`——`function(val){...}; }",` 中 `}"` 后面的 `"` 是 stray character，会导致语法错误
> - ✅ ECharts option 中的 `formatter`、`symbolSize`、`color` 等函数值必须写成原生 JS 函数，内部直接用 `"` 或 `'`
> - ✅ **用 Python 写入时**：不能对整个 data 对象用 `json.dumps()`，而应该用 `json.dumps()` 只处理纯数据部分，函数部分拼接原始 JS 字符串
> - ✅ **推荐做法**：先用 `json.dumps(data_dict, ensure_ascii=False)` 得到 JSON 字符串，然后对其中被序列化为字符串的函数（如 `"function(p){...}"`）做后处理——去掉外层引号和内部 `\"` 转义，恢复为原生函数
> - ✅ **写入后必须验证**：`grep -n '\\"' reports/report_xxx.html | grep -v 'echarts\|prototype'` 应该只匹配到 SQL 等字符串内部的合法转义，不应匹配到函数体
5. **⛔ 打印 URL**：文件写入后，必须打印如下格式的 URL。**只输出本地路径不输出 URL 视为此步骤未完成。**
   ```
   ✅ 报告已生成: reports/report_sales-performance_20260707.html
   🌐 在线访问: http://192.168.18.231:8080/report_sales-performance_20260707.html
   ```

**报告文件路径规则**：
- 所有报告统一保存到 `<项目根目录>/reports/` 目录
- 若 `reports/` 目录不存在则先创建
- 文件名：`report_{domain}_{YYYYMMDD}.html`，如 `report_sales-performance_20260707.html`

**URL 输出规则**：
- 报告服务器默认监听 `0.0.0.0:8080`（由 `report_server.py` 提供），已在 Step 0 确认运行中
- HOST 优先使用环境变量 `REPORT_PUBLIC_URL`，其次用本机 hostname（`hostname` 命令获取），最后用 IP
- PORT 默认 `8080`，可通过 `REPORT_PORT` 覆盖
- ⛔ **URL 必须打印在回复的最后，作为最终交付物。不能只给路径不给 URL。**

**自检清单**（全部通过才输出）：
- [ ] Insight 横幅包含具体数字和结论（不是空泛描述）
- [ ] 每个 Tab 有分析文字（`chart-with-analysis` 类型必须有 `analysis[]`）
- [ ] 溯源信息完整（source + query + filters + limitations）
- [ ] 分析文字避免了空话套话
- [ ] 数值列不会被 formatNumbers 破坏（中文单位值、百分比、"—" 不受影响）
- [ ] 图表类型匹配数据特征（对照 chart-decision.md 复核）
- [ ] ECharts option 完整（series + xAxis/yAxis + tooltip）
- [ ] 文件大小合理（ECharts ~1MB + 数据，>5MB 警告）
- [ ] 文件保存到 `reports/` 目录（非项目根目录）
- [ ] 输出中包含可访问的 URL（`http://host:port/report_xxx.html`）
- [ ] **JS 语法验证通过**：写入后用 `node --check` 验证提取的 script-2，函数体内无 `\"` 转义错误

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

## Report Server（报告 HTTP 服务器）

生成的 HTML 报告通过 `report_server.py` 对外提供 HTTP 访问。用户无需下载文件，直接通过浏览器打开 URL。

### 启动服务器

```bash
# 默认端口 8080
python report_server.py

# 自定义端口
REPORT_PORT=8888 python report_server.py

# 后台运行（Linux）
nohup python report_server.py > /dev/null 2>&1 &

# 后台运行（Windows）
start /B python report_server.py
```

### 服务器功能

| 路径 | 功能 |
|------|------|
| `http://host:8080/` | 报告目录首页，列出所有报告 |
| `http://host:8080/report_xxx.html` | 单个报告 |
| `http://host:8080/health` | 健康检查 |
| `http://host:8080/api/reports` | JSON 格式报告列表 |

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `REPORT_PUBLIC_URL` | 自动检测 | 用户访问报告的基础 URL，如 `http://192.168.18.231:8080` |
| `REPORT_HOST` | `0.0.0.0` | 服务器绑定地址 |
| `REPORT_PORT` | `8080` | 监听端口 |
| `REPORT_DIR` | `./reports` | 报告文件目录 |

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

### 相关工具

| 工具 | 位置 | 用途 |
|------|------|------|
| `report_server.py` | 项目根目录 | HTTP 静态文件服务器，serve `reports/` 目录 |
| `reports/` | 项目根目录 | 所有生成的 HTML 报告统一存放目录 |

### 服务器运维

```bash
# 检查服务器是否在运行
curl http://localhost:8080/health

# 查看所有报告（JSON）
curl http://localhost:8080/api/reports

# 重启服务器
pkill -f report_server.py && python report_server.py &
```
