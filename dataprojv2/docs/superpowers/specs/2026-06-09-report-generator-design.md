# Report Generator Skill — Design Spec

**Date**: 2026-06-09
**Status**: Approved
**Type**: Cross-domain utility Skill (Layer 3)

## 1. Motivation

当前 4 个业务域（fin-cost、inventory、ar、sales-performance）的 Analyst Skill 产出均为纯 Markdown 文本。用户需要将查询结果转成可分享的独立 HTML 报告，包含交互式图表，接近 BI 报表体验。

## 2. Scope & Constraints

- **触发方式**：被动调用。仅在用户明确说"生成报告/导出 HTML"时激活，不影响现有对话式分析流程
- **输入**：上一轮 Analyst 产出的查询结果（Markdown 中的表格/数据 + SQL + 口径说明）
- **输出**：单个独立 HTML 文件（内嵌 ECharts 核心，离线可打开，通过邮件/微信分享）
- **图表交互**：tooltip、legend 切换、缩放、数据下钻（ECharts 原生能力）
- **设计品味**：模板壳由 frontend-design skill 在开发阶段精心设计，运行时不即兴生成

## 3. Architecture

### 3.1 在项目中的定位

`report-generator` 是 Layer 3（Skills 层）的跨域工具 Skill，不属于任何单一业务域。调用链：

```
用户提问 → {domain}-analyst 产出 Markdown 结果
                ↓
用户说"生成HTML报告"
                ↓
        report-generator Skill:
          Step 1: 解析输入数据
          Step 2: 匹配图表类型
          Step 3: 生成图表配置
          Step 4: 组装报告结构
          Step 5: 渲染输出 + 自检
                ↓
        输出独立HTML文件
```

### 3.2 目录结构

```
skills/report-generator/
├── SKILL.md                     # 5-step workflow
├── references/
│   ├── chart-decision.md        # 图表类型决策树
│   ├── echarts-patterns.md      # ECharts option 模式库
│   └── layout.md                # 报告布局模板
└── templates/
    └── report-shell.html        # HTML 模板壳（ECharts 内嵌 + 主题 CSS）
```

### 3.3 与现有架构的关系

- 不是 `{domain}-knowledge` + `{domain}-analyst` 配对模式——没有数据源要查
- 沿用 `references/` 目录存放参考知识
- `templates/` 是新增目录类型，存放静态资源

## 4. Component Design

### 4.1 `SKILL.md` — 5 步工作流

**Step 1 — 解析输入数据**：分析列类型（日期/分类/数值/文本）、数据量、是否存在多维分组。

**Step 2 — 匹配图表类型**：对照 `chart-decision.md` 决策表，为每个数据段选择图表类型。一个报告可有多个图表区块。

**Step 3 — 生成图表配置**：对照 `echarts-patterns.md` 中对应类型的 option 骨架，填入数据，生成完整 ECharts option。

**Step 4 — 组装报告结构**：规划区块顺序：摘要 → KPI 指标卡片 → 图表区 → 明细表 → 溯源脚注。生成 `charts` JSON 数组。

**Step 5 — 渲染输出 + 自检**：读取模板壳 → 填入内容 → 输出 HTML。自检项：
- 数据正确嵌入（不截断、不丢失）
- 图表类型匹配数据特征
- 文件大小合理（>5MB 警告）
- ECharts 内嵌完整

### 4.2 `references/chart-decision.md`

Claude 用的图表类型判断指南：

| 数据特征 | 推荐图表 | 示例场景 |
|----------|---------|---------|
| 时间序列（日期列 + 数值列） | line | 月度费用趋势、应收余额变化 |
| 分类排行（分类列 + 数值列，≤15 类） | bar | 各部门费用、TOP10 客户 |
| 占比构成（分类列 + 数值列，总和有意义） | pie | 费用构成、渠道占比 |
| 多维度对比（≥2 个系列） | bar/line（分组） | 预算 vs 实际、同比对比 |
| 不适合画图的明细数据 | table | 明细账、清单 |

### 4.3 `references/echarts-patterns.md`

每种图表类型对应的 ECharts option 骨架，含：
- `tooltip`、`legend`、`grid` 等通用配置
- `xAxis`/`yAxis`/`series` 占位结构
- 交互配置（dataZoom、toolbox、saveAsImage）
- 示例 option（带注释说明每个字段的填法）

### 4.4 `references/layout.md`

报告页面布局模板：
- **概览版**：KPI 卡片行 + 2列图表网格 + 底部表格
- **趋势版**：全宽趋势图 + 下方2列辅助图表
- **明细版**：筛选器 + 大表格 + 底部1个汇总图

### 4.5 `templates/report-shell.html`

预制的 HTML 骨架（开发阶段用 frontend-design skill 设计，运行时不修改）：

- **内嵌 ECharts 核心库**（~400KB minified）—— 离线可用
- **响应式 CSS Grid 布局**：桌面双列/移动单列，适配打印
- **占位符**：`{{TITLE}}`、`{{SUMMARY}}`、`{{KPIS}}`、`{{CHARTS_JSON}}`、`{{TRACE}}`
- **渲染脚本**：遍历 `CHARTS_JSON` 数组，逐个初始化 ECharts 实例
- **配色方案**：商务风（白色底、蓝色强调、灰色辅助）

### 4.6 职责分离

| 组件 | 职责 | 修改频率 |
|------|------|---------|
| `report-shell.html` | 页面布局 + 视觉风格 + ECharts 渲染引擎 | 低（一次性设计） |
| `chart-decision.md` | 图表类型选择逻辑 | 中（新增图表类型时） |
| `echarts-patterns.md` | ECharts option 骨架 | 中（新增图表类型时） |
| `SKILL.md` | 数据→报告的转换工作流 | 低（流程稳定后） |

## 5. Data Flow

```
Analyst Markdown output
        ↓
[Step 1] 解析列名、类型、行数
        ↓
[Step 2] 对照 chart-decision.md 选图表类型
        ↓
[Step 3] 对照 echarts-patterns.md 填数据 → 生成 option
        ↓
[Step 4] 选择 layout 模板、排布区块顺序
        ↓
[Step 5] 读取 report-shell.html → 替换占位符 → 输出 .html
```

## 6. Quality & Evaluation

### 6.1 开发阶段评估

- 选取 eval_dataset.json 中每个域 3 个典型场景（共 12 个）
- 对每个场景生成 HTML 报告
- 人工检查：图表类型是否合适、数据是否正确、布局是否美观、离线是否可打开

### 6.2 运行阶段自检

Step 5 内置自检清单（见 4.1），发现问题时主动告知用户并建议修正。

### 6.3 后续 eval 扩展

可在 `eval_dataset.json` 中新增 `report` 相关字段，自动化检测：
- HTML 文件包含 ECharts 核心（文件大小 > 300KB 作为 proxy 指标）
- 图表数量和数据段匹配
- 能被浏览器正常解析（HTML 结构完整）

## 7. Risks & Mitigations

| 风险 | 缓解措施 |
|------|---------|
| 图表类型选择不准确 | chart-decision.md 需迭代打磨，收集用户反馈修正 |
| ECharts option 生成错误导致图表空白 | echarts-patterns.md 提供经过验证的 option 骨架，降低出错概率 |
| HTML 文件过大（微信分享限制） | 内嵌 ECharts 约 400KB，数据量过大时自动降级为表格+轻量图表 |
| 数据超过 10 万行导致渲染卡顿 | Step 1 检测行数，超阈值时自动聚合采样 |
| 不同域的报告风格不一致 | 模板壳统一风格，chart-decision 统一图表选择逻辑 |

## 8. Implementation Phases

Phase 1 — 核心骨架：
- 创建目录结构 + SKILL.md 工作流
- template 先用 frontend-design 设计 report-shell.html
- 支持 3 种基础图表（line、bar、pie）+ 数据表

Phase 2 — 扩展：
- 4 个域各跑一轮 eval，打磨 chart-decision 和 echarts-patterns
- 新增图表类型（scatter、radar、heatmap 按需）

Phase 3 — 增强：
- KPI 指标卡片（大数字 + 同比环比）
- 下钻/联动交互（点击柱状图的一个柱子 → 下方展示对应明细表）
