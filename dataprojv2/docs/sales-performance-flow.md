# 业绩域问题处理流向

> 本文档说明：当用户提出业绩域问题时，整个 Anthropic 4 层 Agentic Analytics Stack 是如何协同工作的。以一个真实问题为例，从路由激活到 SQL 落库的完整链路。

## 示例问题

> "瓷砖事业部今年业绩预算达成率趋势"

## 完整流向

```
用户问："瓷砖事业部今年业绩预算达成率趋势"
   ↓
[Layer 3 — Skill 路由]
   Claude 检测到"业绩/达成率/趋势"关键词
   → 激活 sales-performance-knowledge (路由) + sales-performance-analyst (6 步工作流)
   ↓
[Layer 2 — Sources of Truth 加载]
   ① 必读：references/metrics.md (语义层)
       → 决策树指向 dm_fin_operations_mix_sum_t (默认主表, 含预算字段 ambperformance_ys)
       → 概念映射："业绩达成率" = ambperformance / ambperformance_ys
   ② 按需：references/data-lineage.md (血缘, 903 万行表陷阱)
   ③ 跨域：sources-of-truth/business-context/org-hierarchy.md
       → 解析 "瓷砖事业部" = node_desc2 = '瓷砖事业部'
   ↓
[Layer 3 — Analyst 6 步工作流]
   Step 1: 澄清 (时间范围? 含税/不含税? 含工程调整?)
   Step 2: 选表 (Mix 表 vs 业绩表 vs 目标表 — 见 metrics.md 决策树)
   Step 3: 标准过滤 (data_source IN ('S','T','D','') + node_desc2 + calmonth)
   Step 4: 自检 (时间格式 YYYY-MM? data_source 是否按组织层级正确?)
   Step 5: ⚡对抗性审查 (+6% 准确率关键步) — 备份表? 口径唯一? 过滤完整?
   Step 6: 输出 SQL + 数据解读 + 溯源脚注
   ↓
[Layer 1 — Data Foundation 查询]
   MCP mcp__dws__run_query → GaussDB DP_DWS 执行 SELECT
   auto-LIMIT 200, 只读
   ↓
[可选 — Layer 3 跨域工具]
   用户说"生成报告" → report-generator skill 激活
   → Markdown 结果 + ECharts → 暗色 HTML 报告
   ↓
返回用户
```

## 各层在业绩域的具体角色

| 层 | 业绩域对应物 | 作用 |
|---|---|---|
| **L1 数据基础** | `dm.dm_fin_operations_mix_sum_t` (903万行) / `ct_sales_performance_t` (892万行) / `dm_dp_api_sales_target` | 物理表 + 字段 |
| **L2 语义层** | `sales-performance-knowledge/references/metrics.md` | "达成率"→`ambperformance/ambperformance_ys`、决策树选 Mix/业绩/目标表、4 个 data_source 取值规则 |
| **L2 血缘** | `references/data-lineage.md` | SAP SDI → DWI → DWR → DM 链路，6 张核心表的 ETL 注记 |
| **L2 业务上下文** | `sources-of-truth/business-context/org-hierarchy.md` | "瓷砖事业部" → `node_desc2` 的 10 级组织树映射（无需 JOIN，Mix 表内置） |
| **L3 Analyst** | `sales-performance-analyst/SKILL.md` | 6 步法 + 对抗性审查 + 9 种 SQL 模式（A-I）+ 溯源脚注格式 |
| **L3 报告生成器** | `report-generator/SKILL.md` | 仅当用户说"生成报告"时激活，JSON `sections[]/kpis[]/insight/provenance` 格式 |
| **L4 验证** | `eval_dataset.json` 业绩域场景 + `run_eval.py` | 离线测试，确保 ~90%+ 准确率才允许上线 |

## 关键设计原则

1. **Skill 必须配对**：knowledge（路由+参考）+ analyst（工作流+审查），缺一不可。没有 Skill 时准确率 ~21%，加上后 >95%
2. **语义层优先**：`metrics.md` 是 Agent 第一个必须读的文件，决定表选择和字段映射，所有口径从这里发出
3. **对抗性审查 +6%**：analyst 第 5 步不可跳过，是项目里反复验证过的最大单项准确率提升手段
4. **领域边界硬约束**：未覆盖域（AP/GL/采购/HR 等 18 个）必须引导用户先建 Skill，不直接查 DWS

## 实际生成的 SQL 形态

按上述流向，示例问题最终会落到的 SQL（Mix 表模式 G — 预算 vs 实际）：

```sql
SELECT calmonth,
       SUM(ambperformance)         AS actual,
       SUM(ambperformance_ys)      AS budget,
       (SUM(ambperformance) - SUM(ambperformance_ys))
         / NULLIF(SUM(ambperformance_ys), 0) * 100 AS variance_pct
FROM dm.dm_fin_operations_mix_sum_t
WHERE calmonth BETWEEN '2026-01' AND '2026-06'
  AND node_desc2 = '瓷砖事业部'
  AND data_source IN ('S', 'T', 'D', '')   -- node_desc2 层级
GROUP BY calmonth
ORDER BY calmonth;
```

**为什么走这条路：**
- `metrics.md` 决策树指出预算对比只能用 Mix 表（唯一有 `_ys` 字段）
- 业务上下文解析"瓷砖事业部"→ `node_desc2` 过滤，无需 JOIN 组织维度表
- `data_source IN ('S','T','D','')` 是 node_desc2 层级的规则（其他层级要加 'U'）
- `calmonth` 格式 YYYY-MM（Mix 表），不是 YYYYMM

## 参考

- 项目总纲：[technical-framework.md](technical-framework.md)
- 业绩域审计：见 user memory `sales-perf-ambiguity-audit.md`（2026-06-10 渠道文档失真等 P0 已识别）
- 4 层框架原文：https://claude.com/blog/how-anthropic-enables-self-service-data-analytics-with-claude
