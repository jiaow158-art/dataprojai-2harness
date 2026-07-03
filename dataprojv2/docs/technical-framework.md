# 智能问数分析平台 — 技术架构文档

> 最后更新：2026-06-12
> 基于 Anthropic 四层 Agentic Analytics Stack 设计

---

## 1. 项目定位

本平台是一个**自服务数据分析 Skills 框架**，服务于某陶瓷制造企业的数据仓库（DWS）。目标：业务用户用自然语言提问，AI Agent 自动生成 SQL 查询并返回分析结论，**SQL 生成准确率 ≥95%**。

核心理念来源：[How Anthropic Enables Self-Service Data Analytics with Claude](https://claude.com/blog/how-anthropic-enables-self-service-data-analytics-with-claude)

---

## 2. 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                     用户 (自然语言提问)                        │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  Layer 3: Skills (Claude Code Skills 框架)                    │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐          │
│  │ Knowledge    │  │ Knowledge    │  │ Knowledge    │  ×4域   │
│  │ (路由+参考)   │  │ (路由+参考)   │  │ (路由+参考)   │         │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘          │
│         │                │                │                  │
│  ┌──────┴──────┐  ┌──────┴──────┐  ┌──────┴──────┐          │
│  │ Analyst      │  │ Analyst      │  │ Analyst      │  ×4域   │
│  │ (6步工作流)   │  │ (6步工作流)   │  │ (6步工作流)   │         │
│  └─────────────┘  └─────────────┘  └─────────────┘          │
│  ┌─────────────────────────────────────────────────┐        │
│  │ Report Generator (跨域：Markdown → 深色HTML报告)   │        │
│  └─────────────────────────────────────────────────┘        │
└──────────────────────────┬──────────────────────────────────┘
                           │ MCP Protocol (stdio JSON-RPC)
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  Layer 1: DWS 数据仓库 (GaussDB / PostgreSQL-compatible)      │
│  SAP ERP → DWI → DWR → DM 四层 ETL                          │
│  121.37.200.214:8000 / DP_DWS / aiuser                       │
│  23 个业务域, 900+ 张表                                       │
└──────────────────────────────────────────────────────────────┘
```

### 架构分层说明

| 层级 | 名称 | 物理形态 | 职责 |
|------|------|----------|------|
| Layer 1 | Data Foundations | DWS 数据库 + `huaweiclaude/` 导出 | 原始数据，SAP ERP 经 ETL 入仓 |
| Layer 2 | Sources of Truth | `sources-of-truth/` + 各域 `references/` | 四级参考面：语义层 > 血缘 > 查询语料 > 业务上下文 |
| Layer 3 | Skills | `skills/` 目录下的 SKILL.md + references/ | 路由（Knowledge）+ 分析工作流（Analyst）+ 报告生成 |
| Layer 4 | Validation | `eval_dataset.json` + `run_eval.py` | 离线评估，31 场景，通过率 96.8% |

---

## 3. 数据层 (Layer 1 & 2)

### 3.1 数据仓库拓扑

```
SAP ERP (源系统)
    │
    ▼  ETL (DataWorks)
DWI 层  ───  原始数据接入 (贴源层)
    │
    ▼  清洗/标准化
DWR 层  ───  细粒度明细表 (dwrfin 等 schema)
    │
    ▼  汇总/建模
DM 层   ───  事实表 + 维度表 (dm schema, 宽表 93+ 列)
```

- **数据库**：GaussDB（PostgreSQL 兼容），部署于华为云
- **Schema**：`dm`（汇总层）、`dwrfin`（财务明细）、`dwr`（通用明细）等
- **规模**：23 个业务域，900+ 张表
- **最大表**：`dm_fin_stock_detail_accage_t_2023`（1.44 亿行）、`dwr_ar_account_detail_f`（1.03 亿行）

### 3.2 已覆盖的 4 个业务域

| 业务域 | Knowledge Skill | Analyst Skill | 核心表数 | 代表性表 |
|--------|----------------|---------------|----------|----------|
| 财务费用 | `fin-cost-knowledge` | `fin-cost-analyst` | 72 | `dm_fact_finance_cost_f`, `dwr_fin_cost_d_compre_subj_t` |
| 库存仓储 | `inventory-knowledge` | `inventory-analyst` | 73 | `dm_fin_stock_detail_accage_t`, `dwr_stock_accage_detail_f` |
| 应收账款 | `ar-knowledge` | `ar-analyst` | 73 | `dwr_ar_account_detail_f`, `dwr_ar_overdue_collection_f` |
| 销售业绩 | `sales-performance-knowledge` | `sales-performance-analyst` | 2 | `dwr_sales_performance_actual_f`, `dwr_sales_target_f` |

### 3.3 Sources of Truth 四级参考面

按信任度从高到低：

```
┌───────────────────────────────────────────────────┐
│ 1. 语义层 (metrics.md)          ← 每域一份        │
│    概念→字段映射、决策树、已知陷阱                   │
│    Agent 必须首先阅读                              │
├───────────────────────────────────────────────────┤
│ 2. 数据血缘 (data-lineage.md)   ← 每域一份        │
│    SAP 源表 → DWI → DWR → DM 的完整链路            │
├───────────────────────────────────────────────────┤
│ 3. 查询语料 (各表参考文档)       ← 每域多份        │
│    历史有效 SQL 提炼的表结构文档 + 常见查询模式      │
├───────────────────────────────────────────────────┤
│ 4. 业务上下文 (sources-of-truth/) ← 跨域共享      │
│    组织架构 / 客户主数据 / 物料主数据 / 公司工厂 / WBS │
└───────────────────────────────────────────────────┘
```

跨域共享主数据：

| 文件 | 内容 | 规模 |
|------|------|------|
| `org-hierarchy.md` | 10 级销售组织树 | 2,427 行, 15 个 node2 单元 |
| `customer-master.md` | 客户主数据 (3表) | API 1.5K / 销售区域 650K / 通用 206K |
| `material-master.md` | 物料主数据 (SCD Type 2) | 360 万行, 25.7 万唯一物料 |
| `company-plant.md` | 公司 & 工厂 | 199 公司, 131 工厂 |
| `wbs-master.md` | WBS 元素 | 129 万行, 16 项目类型 |

---

## 4. Skills 层 (Layer 3)

### 4.1 配对架构：Knowledge + Analyst

每个业务域采用**配对 Skill 架构**：

```
┌──────────────────────┐     ┌──────────────────────┐
│  {domain}-knowledge   │     │  {domain}-analyst     │
│  (路由 + 参考索引)     │────▶│  (6 步分析工作流)      │
│                       │     │                       │
│  SKILL.md             │     │  SKILL.md             │
│  ├── 触发条件          │     │  ├── 第1步: 澄清需求   │
│  ├── 参考文档索引      │     │  ├── 第2步: 定位数据源  │
│  └── 全局过滤条件      │     │  ├── 第3步: 标准过滤   │
│                       │     │  ├── 第4步: 生成 SQL   │
│  references/          │     │  ├── 第5步: 对抗审查   │
│  ├── metrics.md       │     │  └── 第6步: 输出结论   │
│  ├── data-lineage.md  │     │                       │
│  └── *.md (表参考)    │     │  依赖 Knowledge 提供   │
│                       │     │  表结构和业务规则       │
└──────────────────────┘     └──────────────────────┘
```

**为什么配对？**
- 无 Skills 时准确率 ~21%（直接查库，缺乏业务上下文）
- 有 Knowledge 路由后准确率 ~89%（知道该查哪张表）
- 加上 Analyst 工作流后准确率 ≥95%（对抗审查额外 +6%）

### 4.2 Analyst 6 步工作流

所有 Analyst Skill 遵循统一流程：

```
第1步: 澄清需求 ─── 歧义消解（时间/口径/组织/币种/基准）
    │
第2步: 定位数据源 ── 读 metrics.md 决策树，选定目标表
    │
第3步: 应用标准过滤 ── 时间格式/备份表排除/大表必须带 WHERE
    │
第4步: 生成并执行 SQL ── 通过 MCP 工具查 DWS
    │
第5步: 对抗审查 ──── 自我纠错：检查陷阱、验证口径、排除异常值
    │                     （不可跳过，贡献 +6% 准确率）
第6步: 输出结论 ──── 结构化 Markdown 回复
```

### 4.3 报告生成器 (跨域工具)

| 属性 | 说明 |
|------|------|
| 位置 | `skills/report-generator/` |
| 触发 | 用户说"生成报告" / "导出 HTML" / "做个报告" |
| 输入 | Analyst 输出的 Markdown 分析结果 |
| 输出 | 独立 HTML 文件（深色商务主题，内嵌 ECharts） |
| 格式 | `sections[]` + `kpis[]` + `insight` + `provenance` |

工作流：
1. 理解数据，形成判断
2. 设计报告结构（Tab 分页）
3. 生成 ECharts 图表配置（参照 `echarts-patterns.md`）
4. 填充模板（`report-shell.html`）
5. 注入分析文字和数据溯源

---

## 5. 数据访问层 — MCP Server

### 5.1 技术栈

| 组件 | 技术选型 |
|------|----------|
| 协议 | MCP (Model Context Protocol), stdio transport |
| 传输 | JSON-RPC 2.0 (支持 Content-Length 帧和 NDJSON 两种模式) |
| 语言 | Python 3.9 |
| 数据库驱动 | psycopg2 |
| 部署 | 本地 stdio 进程，由 Claude Code 启动 |
| 安全 | 只读（SQL 白名单：SELECT/WITH/DESCRIBE/SHOW/EXPLAIN） |

### 5.2 暴露的 4 个工具

```
┌──────────────────────────────────────────────────────┐
│                   MCP Server (dws)                    │
│                                                       │
│  run_query(sql)        → 执行只读 SQL，自动 LIMIT 200 │
│  list_tables(schema?)  → 列出所有表 + 大小             │
│  describe_table(name)  → 获取列定义 + 注释            │
│  search_tables(keyword)→ 按关键字搜索表/列             │
│                                                       │
│  安全限制:                                             │
│  • 禁止 INSERT/UPDATE/DELETE/DROP 等写操作             │
│  • 结果集上限 500 行                                   │
│  • 超时保护 (statement_timeout)                        │
└──────────────────────────────────────────────────────┘
```

### 5.3 连接参数

```
Host:     121.37.200.214
Port:     8000
Database: DP_DWS
User:     aiuser
Driver:   psycopg2 (GaussDB PostgreSQL-compatible)
```

配置文件：`.mcp.json`（项目根目录），`type: "stdio"` 为必填字段。

---

## 6. 验证层 (Layer 4)

### 6.1 评估体系

```
eval_dataset.json          run_eval.py
┌─────────────────┐       ┌──────────────────┐
│ 31 个评估场景     │──────▶│ 自动化执行器       │
│ 4 个业务域        │       │ • 逐场景执行 SQL   │
│ 每场景含:        │       │ • 对比行数是否匹配  │
│  - question      │       │ • 输出通过率       │
│  - expected SQL  │       │ • 性能基线对比     │
│  - expected rows │       └──────────────────┘
│  - elapsed_ms    │
└─────────────────┘
```

### 6.2 当前状态

| 域 | 场景数 | 通过率 |
|----|--------|--------|
| fin-cost | 6 | 100% |
| inventory | 9 | 100% |
| ar | 8 | 100% |
| sales-performance | 8 | 100% |
| **合计** | **31** | **96.8% (30/31)** |

### 6.3 运行方式

```bash
# 全域
python run_eval.py

# 单域
python run_eval.py inventory
python run_eval.py ar
python run_eval.py fin-cost
python run_eval.py sales-performance
```

发布门禁：新域上线前评估通过率须达到 ~90%。

---

## 7. 关键技术决策

### 7.1 为什么用 Skills 而非 Fine-tuning

| 方案 | Skills (Prompt Engineering) | Fine-tuning |
|------|----------------------------|-------------|
| 迭代速度 | 分钟级（改 SKILL.md 即生效） | 天级（重新训练） |
| 可解释性 | 高（决策树可审计） | 低（黑盒） |
| 维护成本 | 低（改文档） | 高（重新标注+训练） |
| 准确率 | 95%+ | 未知（需大量标注数据） |
| 表结构变更 | 即时更新参考文档 | 需重新训练 |

### 7.2 为什么 Knowledge 和 Analyst 分开

- **Knowledge** 是稳定的参考层（表结构、业务规则），变更频率低
- **Analyst** 是动态的工作流层（分析步骤、输出格式），迭代频率高
- 分离后，更新表参考文档不会意外影响分析流程

### 7.3 对抗审查的价值

Analyst 第 5 步"对抗审查"是自纠错机制：
- 检查是否踩中已知陷阱（日期格式、备份表、null 值）
- 验证 SQL 口径与用户意图一致
- 排除异常值和 ETL 延迟数据
- 经验证贡献 +6% 准确率，**不可跳过**

---

## 8. 目录结构详解

```
dataproj/
│
├── .mcp.json                         # MCP Server 配置（数据库连接）
├── CLAUDE.md                         # 项目级指令（Agent 行为约束）
├── dws_mcp_server.py                 # MCP Server 实现（366 行）
├── run_eval.py                       # 评估执行器（118 行）
├── eval_dataset.json                 # 31 个评估场景
├── domain_categories.json            # 23 个业务域分类（900+ 表）
├── build_report.py                   # 报告组装脚本
├── all_tables.json                   # DWS 全量表清单
│
├── huaweiclaude/                     # Layer 1: 原始 DWS schema 导出
│
├── sources-of-truth/                 # Layer 2: 跨域参考面
│   └── business-context/
│       ├── org-hierarchy.md          #   组织架构（10级, 2427行）
│       ├── customer-master.md        #   客户主数据（3表）
│       ├── material-master.md        #   物料主数据（360万行）
│       ├── company-plant.md          #   公司 & 工厂
│       └── wbs-master.md             #   WBS 元素
│
├── skills/                           # Layer 3: 领域 Skills
│   ├── fin-cost-knowledge/           #   财务费用 - 知识路由
│   │   ├── SKILL.md
│   │   └── references/              #     8 份参考文档
│   ├── fin-cost-analyst/             #   财务费用 - 分析工作流
│   │   └── SKILL.md
│   ├── inventory-knowledge/          #   库存仓储 - 知识路由
│   │   ├── SKILL.md
│   │   └── references/              #     7 份参考文档
│   ├── inventory-analyst/            #   库存仓储 - 分析工作流
│   │   └── SKILL.md
│   ├── ar-knowledge/                 #   应收账款 - 知识路由
│   │   ├── SKILL.md
│   │   └── references/              #     7 份参考文档
│   ├── ar-analyst/                   #   应收账款 - 分析工作流
│   │   └── SKILL.md
│   ├── sales-performance-knowledge/  #   销售业绩 - 知识路由
│   │   ├── SKILL.md
│   │   └── references/              #     5 份参考文档
│   ├── sales-performance-analyst/    #   销售业绩 - 分析工作流
│   │   └── SKILL.md
│   └── report-generator/             #   跨域报告生成器
│       ├── SKILL.md
│       ├── references/               #     3 份参考文档
│       │   ├── chart-decision.md
│       │   ├── echarts-patterns.md
│       │   └── layout.md
│       └── templates/
│           ├── report-shell.html     #     HTML 模板（深色主题）
│           └── echarts.min.js        #     ECharts 库
│
└── docs/                             # 项目文档
    └── technical-framework.md        #   本文件
```

---

## 9. 数据治理关键约束

### 9.1 日期格式不一致（最大陷阱）

| 表 | 日期字段 | 格式 | 示例 |
|----|----------|------|------|
| `dwr_fin_cost_d_compre_subj_t` | `year` + `month` | YYYY + YYYY-MM | `2026` + `2026-05` |
| `dm_fact_finance_cost_f` | `month` | YYYY-MM | `2026-05` |
| `dwrfin_cost_sales_gross_profit_d` | `months` | YYYYMM | `202605` |
| `dm_fin_stock_detail_accage_t` | `cal_month` | YYYYMM | `202605` |
| `dwr_stock_accage_detail_f` | `months` | YYYYMM | `202605` |

**规则**：每次查询新表前必须确认日期字段格式，不可假设。

### 9.2 备份表黑名单

以下后缀的表绝对不能使用：
- `_wjh_*`, `_bak*`, `_tmp*`, `_01`, `_close`, `_2024*`

### 9.3 双命名系统

| DWR 风格 | SAP 风格 | 含义 |
|----------|----------|------|
| `cust_code` | `debitor` | 客户编码 |
| `material` | `material_num` | 物料编码 |
| `plant` | `factory_werks_code` | 工厂代码 |

### 9.4 大表强制过滤

超过 1000 万行的表必须带时间范围 WHERE 条件，否则会超时或影响数仓性能。

---

## 10. 运行环境

| 项目 | 值 |
|------|-----|
| 操作系统 | Windows 10 Pro |
| Python | 3.9 (`C:/Users/Administrator/.../Python39/python.exe`) |
| AI 运行时 | Claude Code (CLI) |
| 数据库 | GaussDB (PostgreSQL-compatible) |
| Python 依赖 | psycopg2（无其他第三方依赖） |
| 浏览器图表 | ECharts 5.x (内嵌) |

---

## 11. 扩展路线

当前覆盖 4/23 个业务域。待扩展域：

| 优先级 | 域 | 表数 | 说明 |
|--------|-----|------|------|
| P0 | 采购-供应商 | 43 | 供应链核心 |
| P0 | 销售-订单客户 | 45 | 订单到收款 |
| P1 | 生产-执行 | 73 | 制造核心 |
| P1 | 销售-零售 | 294 | 零售渠道 |
| P2 | 物流-TMS | 8 | 运输管理 |
| P2 | 人事-HR | 21 | 人力资源 |

扩展流程：
1. 调研域内表结构，识别核心事实表
2. 编写 `metrics.md` 语义层（决策树 + 陷阱）
3. 编写 `data-lineage.md` 数据血缘
4. 编写各表参考文档
5. 创建 Knowledge + Analyst 配对 Skill
6. 编写 eval 场景（≥8 个）
7. 运行评估，通过率 ≥90% 后上线
