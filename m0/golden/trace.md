# 金样报告轨迹（M0-T3）

## 0. 重要事实澄清：`金样.html` 的实际内容与任务书"原始提问"不符

任务书给出的"金样原始提问"是一段 **sku-profitability 域** 的 SKU 效益分析问题（渠道-品类-系列-TOP50sku、四象限图、库存风险图等）。但根目录 `金样.html`（1,098,634 字节）的**实际内容是另一份报告**：

- `<title>` 与 REPORT_JSON `"title"`：**《2026年8月经营分析报告》**
- `"subtitle"`：`销售业绩 · 财务费用 · 应收 · 库存（四域） | 期间 2026-08 全月，对比 2026-07 / 2025-08 | 生成 2026-09-05`
- 5 个 tab：销售业绩 / 财务费用 / 应收风险 / 库存运营 / 明细数据
- 全文检索 `四象限`、`TOP50`、`SKU效益`、`品类-系列` 均为 **0 次命中**（仅 `周转天数`×2、`气泡`×1，出现在与 SKU 无关的上下文）

处理原则（按任务书"宁可写不确定+证据，不要编造"）：**本目录以 `金样.html` 的实际内容为准固化金样**，metrics.json 的 SQL 从该报告实际呈现的口径反推（其 provenance.query 字段完整记录了原始取数 SQL 模式，反推置信度高）。**用户裁定（2026-09-08）：金样就用当前这份四域经营分析报告，不换 SKU 报告。** 任务书中的 SKU 提问原文照录于第 2.2 节备查。

本仓库 `reports/report_sku-profitability_20260818.html`（SKU 存货跌价分析，2026-08-18）同样**不含**该提问要求的渠道-品类-系列四象限结构（只有帕累托+明细 2 个 tab），也不是该提问的产物。原始 SKU 效益会话轨迹（SQL 顺序、中间结果）**未找到、未提供**。

## 1. 选定理由

- `金样.html` 是用户指定提供的"现役正确产物"（M0 计划 Task 3 Step 1：最复杂、近期正确生成过）。
- 满足候选特征：跨多月（2025-08 / 2026-07 / 2026-08 三期对比）、跨域（销售/费用/应收/库存四域 + 11 销售中心明细榜）、表格含 tone 着色。
- 注：报告图表数据点合计 65 点（图表为聚合结果，非明细行）；**报告本身没有 >200 行的明细表**（明细 tab 仅 10 行）。">200 行不截断"验证（T15）改用「数据明细行数」指标 = 报告口径对应的底层明细行数（见 metrics.json，实测 50,508 行 / 802,567 行，均 >>200）。

## 2. 问题原文

### 2.1 **T14 复现官方提问**（由 provenance 重构，2026-09-08 用户裁定采用本金样）

`金样.html` 未随附原始提问（浏览器另存产物，无会话元数据）；已核实 provenance 七键（source/lastUpdate/skillVersion/query/filters/limitations/dataQuality）中**不含任何提问原文**（query 字段只记 SQL）。以下提问由报告实际覆盖范围（subtitle 期间与四域、8 张 KPI 卡、4 个图表 tab 的分析主题、明细 tab 内容、provenance.filters 口径）重构，T14 向 dsh 复现时**原样使用本段**：

> 给我出一份2026年8月的经营分析报告，全月口径，跟7月和去年8月对比着看。内容覆盖四个方面：一是销售业绩，看集团含税达成额和目标达成率，分整合渠道和事业部拆一下，毛利率也带上；二是财务费用，看期间费用构成和各项预算执行情况；三是应收，看应收余额、逾期率和账龄结构；四是库存，看库存金额、长龄库存和库龄分布。最后附一份瓷砖各销售中心的目标达成明细，生成HTML报告。

**此为重构，非实录**（原始会话轨迹未提供）。重构依据：报告 subtitle"期间 2026-08 全月，对比 2026-07 / 2025-08"、KPI 卡（含税达成额/目标达成率/阿米巴毛利率/期间费用率/应收余额/逾期率/库存金额/长龄库存）、各 tab 图表主题（渠道业绩+事业部结构 / 费用结构+预算执行率 / 应收余额逾期趋势+账龄结构 / 库存长龄趋势+库龄结构）、明细 tab"瓷砖11销售中心目标达成明细"。

### 2.2 任务书指定的 SKU 提问原文（**备查-非本金样驱动提问**，照录备查，与 1,098,634 字节金样文件内容无关）

> 分析瓷砖事业部国内营销系统SKU效益，产品所有权为瓷砖产品，分析按渠道-品类-系列-TOP50sku逐层深入分析，每个渠道，分析瓷砖事业部国内营销系统26年上半年SKU效益，产品所有权为瓷砖产品，分析按渠道-品类-系列-TOP50sku逐层深入分析，每个渠道下，以每个品类系列输出四象限图:毛利额(横轴·万元)x销售增长率(纵轴)，库存风险图：增长率(横轴) × 周转天数(纵轴)，气泡=库存金额。组织范围明确为瓷砖事业部-国内营销中心，不包含生态新材营销中心、高端品牌营销中心、梦之家、绿家、辅材、ART+，数据来源为S\T\D，产品所有权不做限制。四象限图和库存风险图，拆分到每个渠道，每个品类各有一个图，按系列规格作为一个单元。

## 3. 生成管线判定（证据充分）

**结论：金样出自 `skills/report-generator/` 管线（build.py + validate_report.py + report-shell.html + 本地 echarts.min.js），且与本仓库当前版本模板逐字节兼容；根目录 `build_report.py` 已自标 DEPRECATED，排除。**

### 证据 A — 模板 CSS 逐字节一致

`金样.html` 的 `<style>` 块（12,548 字符）与 `skills/report-generator/templates/report-shell.html` 的 `<style>` 块**完全相等**（Python 逐字节比对 identical=True）。CSS 变量体系（`--accent-blue: #2563EB`、`--color-up: #DC2626` 等）、类名（`.kpi-card`、`.insight-banner`、`.tab-nav`、`.provenance-section`）一一对应。

### 证据 B — REPORT_JSON 结构与 v2.1 schema 一致，且通过当前 validator

从 `var data = {...}` 提取的内嵌 JSON（已存 `m0/findings/golden_report_data.json`）：
- 顶层键 `title/subtitle/kpis/insight/sections/provenance` — 与 `references/report-schema.json` 顶层 required 一致；
- `chart` 字段为**数组**（chart-with-analysis 节多图），正是 schema v2.1 的 `oneOf [chart, chart[]]` 特性；
- 明细表 cell 用 `{"v": "...", "tone": "good|warn|bad"}` 对象 — schema v2.1 着色协议；
- `valueFormat: "yi:2"/"wan:0"/"percent"`、`tooltipTemplate: "multi"` — v2.1 专属特性；
- **用当前 `validate_report.validate_data()` 校验该 JSON：0 errors**。

### 证据 C — build.py 组装签名

- 金样正文含 **67 处 `<\/`** 转义 — `build.py::build_html` 的 `json.dumps(...).replace("</", "<\\/")` 防 script 撕裂处理是唯一来源；
- `window.__REPORT_VALID__ = true;` 收尾 JS 与模板尾部完全一致；echarts 5.5.0 内联（`{{ECHARTS_LIB}}` 替换位），版本号与 `templates/echarts.min.js`（`version:"5.5.0"`，Apache-2.0，Copyright Microsoft）一致；
- 用当前 build.py `build_html()` 对提取 JSON 重建 HTML：渲染层（CSS+JS+容器骨架）与金样一致，差异仅来自**浏览器另存归一化**（`saved from url` 注释、`<meta http-equiv>` 改写、`<html><head>` 合并成一行、ECharts 运行时把 KPI/图/表渲染进容器的静态快照），数据 JSON **语义完全相等**（解析后 ==）。
- `saved from url` 注释里的 URL 路径为 `.../reports/user:4/report_operations_20260905.html` — 与 build.py 输出命名 `report_{domain}_{YYYYMMDD}.html`（domain=operations，2026-09-05 生成）吻合，经 claudecodeui（192.168.18.231:3001）分发下载。

### 证据 D — 排除 build_report.py

根目录 `build_report.py` 头部自带标注：`[DEPRECATED 2026-08] 已废弃 — 统一改用 skills/report-generator/scripts/build.py。此脚本留存仅作历史参考，内含硬编码数据/路径`。且其内嵌 REPORT_JSON 是 2026 年 1-5 月销售业绩预算达成内容（硬编码示例），结构为旧版单 chart dict（非数组）、无 valueFormat/tooltipTemplate/tone 特性，与金样不符。

### skill 链推断

`provenance.skillVersion = "sales-performance / fin-cost / ar / inventory analyst+knowledge（6步工作流+对抗审查）"`，故生成链为四域各自的 `{domain}-knowledge → {domain}-analyst`（6 步工作流 + 对抗审查）→ `report-generator`。非 sku-profitability 域。

## 4. 调用的脚本/资源（按 report-generator 管线）

| 资源 | 路径 | 角色 |
|---|---|---|
| 构建入口 | `skills/report-generator/scripts/build.py` | 读 JSON → validator → 模板组装 → 写文件 → 复验 |
| 校验器 | `skills/report-generator/scripts/validate_report.py` | 构建前 JSON 校验 + 构建后 HTML 校验（node 存在时 `node --check`） |
| 模板 | `skills/report-generator/templates/report-shell.html` | CSS/JS 容器，占位符 `{{REPORT_TITLE}}/{{REPORT_META}}/{{ECHARTS_LIB}}/{{REPORT_JSON}}` |
| 图表库 | `skills/report-generator/templates/echarts.min.js`（5.5.0，内联） | 渲染 |
| Schema | `skills/report-generator/references/report-schema.json`（v2.1） | validator 依据 |
| 数据层 skill | sales-performance / fin-cost / ar / inventory 的 knowledge+analyst（四域 6 步工作流） | 产生各域数字与口径 |
| 运行时 | Python 3.9+（实测 3.12.7）、Node（可选，仅语法检查）、report_server.py（:8080，可选，打印 URL 用） | — |

## 5. 产物统计

- 文件：`m0/golden/report.html`，1,098,634 字节 / 1,031 行（浏览器另存后单行化，行数无意义）
- md5：`c0658e04548335ef0a129fb339652339`（与根目录 `金样.html` 一致；原文件保留原地未动）
- REPORT_JSON：8 KPI、5 sections（4×chart-with-analysis 含 8 图、1×table 10 行）、insight 249 字、provenance 7 键
- 图表数据点合计 65；图表 8 个：chart-channel、chart-bu(pie)、chart-expense、chart-budget、chart-ar-trend、chart-aging、chart-inv-trend、chart-stock-aging

## 6. SQL 轨迹声明

**原始会话 SQL 轨迹未提供。** `m0/golden/metrics.json` 中的 SQL 为按报告口径反推：
1. 首要依据 = 金样 `provenance.query` 字段（生成时 Agent 自述的取数 SQL，逐字保留在报告内，是最接近真值的反推来源）；
2. 辅助依据 = 各域 knowledge/analyst 的 metrics.md / SKILL.md 模式（日期格式、data_source 过滤、字段口径）；
3. 每条 SQL 已于 2026-09-08 在 DWS 实跑验证，跑出的值与报告呈现值对照（详见 metrics.json 的 expect_hint）——**销售/费用/应收总额/库存/长龄/明细行数等 KPI 全部对上**；仅"账龄结构 8 段"图（0.56/0.47/…/9.12 亿）的精确取数式未能唯一复原（未逾期 10.62 亿可复现，各逾期分段与文档记载的分段列组合存在残差），已在 metrics.json 中如实标注。

真值以 T15 同 SQL 重导为准（防数据漂移）。

## 7. 复现要点（给 T14）

- 用 trace.md 第 2.1 节 **T14 复现官方提问**（由 provenance 重构，2026-09-08 用户裁定采用本金样）向 dsh 提问；
- dsh 需复用 report-generator 管线：产出 REPORT_JSON（sections[]+kpis[]+insight+provenance，chart 支持数组）→ build.py 组装；
- 环境依赖见 `m0/env-manifest.md`。
