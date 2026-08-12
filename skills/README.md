# 数仓 Self-Service Analytics Skills

基于 Anthropic 四层 Agentic Analytics 框架构建。当前覆盖 5 个域：费用成本、库存仓储、应收、销售业绩、OTD 履约。

## 目录结构

```
skills/
├── fin-cost-knowledge/       # 知识 Skill — 财务费用域
│   ├── SKILL.md              # 路由层
│   └── references/           # 9 个参考文档
├── fin-cost-analyst/         # 分析 Skill — 财务费用工作流
│   └── SKILL.md
├── inventory-knowledge/      # 知识 Skill — 库存仓储域
│   ├── SKILL.md              # 路由层
│   └── references/           # 9 个参考文档
├── inventory-analyst/        # 分析 Skill — 库存分析工作流
│   └── SKILL.md
├── ar-knowledge/             # 知识 Skill — 应收域
│   ├── SKILL.md              # 路由层
│   └── references/           # 7 个参考文档
├── ar-analyst/               # 分析 Skill — 应收分析工作流
│   └── SKILL.md
├── sales-performance-knowledge/  # 知识 Skill — 销售业绩域
│   ├── SKILL.md              # 路由层
│   └── references/           # 6 个参考文档
├── sales-performance-analyst/    # 分析 Skill — 销售业绩工作流
│   └── SKILL.md
├── otd-fulfillment-knowledge/    # 知识 Skill — OTD 履约域
│   ├── SKILL.md              # 路由层
│   └── references/           # 6 个参考文档
├── otd-fulfillment-analyst/      # 分析 Skill — OTD 履约工作流
│   └── SKILL.md
├── report-generator/         # 跨域工具 — HTML 报告生成
│   ├── SKILL.md              # 工作流 + 模板路由
│   ├── references/           # chart-decision, echarts-patterns, layout
│   └── templates/            # report-shell.html, echarts.min.js
└── README.md                 # 本文件
```

## 设计原则

1. **知识 Skill + 分析 Skill 成对出现**：知识层解决"去哪查"，分析层解决"怎么查"
2. **参考文档共置在脚本仓库**：数仓逻辑变更时同步更新文档
3. **陷阱优先记录**：每个表文档必须包含已知的坑和口径变更历史
4. **渐进披露**：路由层先加载，参考文档按需加载

## 使用方式

在 Claude Code 中直接提问：
- "这个月制造费用按成本中心汇总"
- "华东区 Q1 毛利同比分析"
- "当前库存库龄结构，长库龄占比"
- "清远基地仓协销日报"
- "最新应收账龄结构，逾期占比"
- "2026年6月回款金额Top10客户"
- "按客户分类的坏账减值汇总"
- "本月销售达成率按事业部汇总"
- "OTD 履约率趋势，未交付订单分析"

Claude 会自动加载对应的 Skill 和参考文档，按工作流生成 SQL。

## 维护规则

- **ETL 变更 PR 必须同步更新对应参考文档**
- **新增表需要在 data-lineage.md 中补充血缘**
- **参考文档的"陷阱"和"变更历史"是最重要的维护项**
- **每月检查一次准确率**（抽 10-20 个真实问题验证）
- **新增 Skill 时同步更新 `.claude/skills/` 目录**（或保持 `.claude/skills/ → skills/` 符号链接）

## 后续扩展

| 领域 | 预计表数 | 优先级 | 状态 |
|------|---------|--------|------|
| 费用成本 (CO) | 72 | 高 | ✅ 已完成 |
| 库存仓储 (WM) | 73 | 高 | ✅ 已完成 |
| 应收 (AR) | 73 | 高 | ✅ 已完成 |
| 销售业绩 | 2 | 高 | ✅ 已完成 |
| OTD 履约 | — | 高 | ✅ 已完成 |
| 应付 (AP) | 13 | 高 | 待建设 |
| 总账 (GL) | 23 | 中 | 待建设 |
| 利润 | 22 | 中 | 待建设 |
| 销售订单 | 31 | 中 | 待建设 |
| 销售发货 | 20 | 中 | 待建设 |
| 销售目标 | 43 | 中 | 待建设 |
| 销售渠道客户 | 45 | 中 | 待建设 |
| 采购供应链 | 43 | 中 | 待建设 |
| HR | 21 | 低 | 待建设 |
| 物流 TMS | 8 | 低 | 待建设 |
