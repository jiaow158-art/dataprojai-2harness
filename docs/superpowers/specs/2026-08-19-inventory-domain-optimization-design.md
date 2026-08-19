# 库存域优化（ETL 深挖驱动）— 设计文档

- **日期**：2026-08-19
- **状态**：已批准（brainstorming 产出）
- **上游材料**：业务 2026-08-18 确认的库存域四张核心表；`huaweiclaude/` 下对应 ETL 脚本导出

## 1. 背景与目标

业务确认库存域四张核心表（记忆 `dws-inventory-core-tables`）。其中三张新表（上市口径跌价 / CHDJ 阿米巴 / 资金成本）在 SKU 效益分析域建设期间已顺手建档，但文档是从 SKU 视角写的、深度不足（62~100 行）；inventory-analyst 的 8 个模式（A-H）全部是老表，新表零模式；eval 零覆盖。

本轮目标：**挖透四份 ETL 脚本，用实证公式与血缘增厚库存域三层（knowledge / analyst / eval）**，并尝试解开 CHDJ 两个悬案。

## 2. 范围与边界（用户裁定）

- **范围**：仅四张核心表：
  1. `dm.dm_fin_stock_detail_accage_t_2023` — 库龄明细主表（1.44亿行）
  2. `dm.dm_fin_stock_d_accage_list_c_t_2023` — 上市口径跌价（600万行/月）
  3. `dm.dm_ambv2_chdj_grp_t` — CHDJ 阿米巴存货价值/跌价（28万行/月）
  4. `dm.dm_fin_stock_capital_cost_t` — 库存资金成本
- **跨域边界**：严格只改库存域文件。CHDJ 悬案答案即使被 ETL 实证，也只写进库存域文档；**SKU 域（模式 C/G/I、效益利润 E 公式）一字不动**，待 Mix 表 ETL 证据齐后统一处理。
- **明确不做**：不收录 `dm_own_inventory_t`；不动 WM 库存责任表族 / SAFESTOCK 族；不新增任何表。

## 3. 第 1 节：ETL 挖掘（输入分析）

四份脚本逐一挖掘，每份产出结构化提取笔记（公式 / 源表链 / 过滤与口径转换 / 刷新机制 / 悬案答案）：

| ETL 脚本（huaweiclaude/） | 行数 | 挖掘重点 |
|---|---|---|
| `DWS/DM/DM_INSERT/PJob_DWS_DM_FIN_STOCK_D_ACCAGE_LIST_C_T_2023.txt` | 749 | 账龄桶推算（批次入库日期→账龄段映射）、跌价计提比例（0/20/30/50/50%）的实现、`stockcat <> 'K'` 上市口径筛选、面积计算逻辑 |
| `DM/DM_CT/PJob_DWS_DM_AMBV2_CHDJ_GRP_T.txt` | 1973 | ⭐ **头号目标**：`capital_cost` 为何负值（符号约定 or 计算结果）、`inventory_value` 构成是否已扣跌价、阿米巴分摊逻辑、与上市口径差异（6.35亿 vs 14.3亿）的来源 |
| `DWS/FIN/FIN_INSERT/PJob_DWS_DM_FIN_STOCK_CAPITAL_COST_T.txt` | 433 | 公式 `((期初+期末)/2 − 202012余额) × 4%/12` 的精确实现、余额基数选择、粒度聚合方式 |
| `DWS/DM/DM_INSERT/PJob_DWS_DM_FIN_STOCK_DETAIL_ACCAGE_T_2023.txt`（787 行，另有 `DM/` 目录 1289 行版本） | 787+1289 | 四套库龄口径（wbzq/ybzq 标准版、xydj/xyzjdj 协议单价、amb_ 爱米巴、zrzlcp_ 自然日历）的字段生成逻辑、`zsjkcje` 定义 |

**双版本规则**：同名 ETL 存在 `DM/` 与 `DWS/…/` 两个目录版本时，以 DWS 目录版本为准，交叉对照差异并记录。

**悬案处理原则（不猜）**：
- ETL 有明确答案 → 写进 chdj-capital-cost.md，metrics 陷阱标注"已实证（ETL: PJob_…）"
- ETL 无明确答案 → 保留"待 ETL/财务确认"标注，记录本轮已排除的假设与证据链

## 4. 第 2 节：知识层增厚

### 4.1 四份表文档增厚（120~200 行/份）

统一结构：快速参考 → 字段语义 → **公式（ETL 实证）** → 陷阱 → 查询模式 → 血缘。

| 文档 | 现状 | 重点 |
|---|---|---|
| `stock-fall-list.md` | 100 行 | 账龄桶映射与计提比例的 ETL 实现、上市口径筛选的完整语义 |
| `chdj-capital-cost.md` | 62 行（最薄） | ⭐ 悬案答案、阿米巴分摊逻辑、双口径差异来源 |
| `capital-cost-table.md` | 73 行 | 公式精确实现与基数定义 |
| `stock-accage.md` | 134 行 | 四套库龄口径的生成逻辑、zsjkcje 定义 |

### 4.2 metrics.md（语义层）

- 第八节从一小段扩为「存货跌价与资金成本完整语义」：三表+主表概念映射表、公式表、**双口径对照表**（含 14.3亿 vs 6.35亿 差异解释与适用场景）
- 决策树跌价/资金成本分支细化为可操作判别
- 已知陷阱总览 10 → 14+ 条

### 4.3 data-lineage.md

四张表血缘精确化到实际 ETL 链路（源表 → 中间表 → DM），引用具体 PJob 名。

## 5. 第 3 节：inventory-analyst 新模式

| 模式 | 覆盖 |
|---|---|
| **模式 I：跌价分析族** | 月度跌价总额趋势 / TOP 物料 / 按品类·事业部结构 / 计提比例分布 |
| **模式 J：资金成本分析** | 按事业部/工厂/物料分摊、月度趋势 |
| **模式 K：双口径对照** | 业务问"为什么 CHDJ 6.35 亿和上市口径 14.3 亿对不上"时的标准解释 + 并排查询套路 |

配套：第 2 步数据源表补 3 行路由；对抗性审查清单补口径检查项（如"跌价问题是否误用了 CHDJ 口径"）。

## 6. 第 4 节：eval 扩充

inventory 域 10 → 15 个场景（新增下表 5 个；若库龄×跌价联动与跌价 TOP 重复度过高，实施时可砍至 4 个）：

| 模式名 | 场景 |
|---|---|
| `inventory_fall_top10` | 上市口径跌价 TOP 物料 |
| `inventory_fall_trend` | 月度跌价总额趋势 |
| `inventory_capital_cost_by_dept` | 资金成本按事业部 |
| `inventory_chdj_vs_listed` | 双口径对照 |
| `inventory_aging_fall_link` | 库龄×跌价联动（长库龄跌价敞口） |

每条带 SQL 与期望行数/量级，以 `run_eval.py` 实跑 PASS 为准。

## 7. 第 5 节：验证与收尾

1. **新场景实跑全 PASS**；老场景零回归（ar 域 7 个存量漂移与本轮无关，不处理）
2. **口径交叉验证**：ETL 提取的公式在 DWS 实跑复算对上（如资金成本公式重算、跌价比例×账龄段金额复算）
3. 记忆文件 `dws-inventory-core-tables` 待办闭环更新
4. 提交序列按层切分 commit（ETL 笔记融入文档，不留独立中间产物）

## 8. 成功标准

- [ ] 四份表文档均含 ETL 实证公式与精确血缘，CHDJ 悬案有明确结论（答案或"待确认+已排除假设"）
- [ ] metrics.md 决策树/陷阱/公式可支撑跌价与资金成本类问题路由
- [ ] inventory-analyst 含模式 I/J/K，6 步工作流可走通新表问题
- [ ] eval 新增场景实跑 PASS，`python run_eval.py inventory` 全绿
- [ ] SKU 域文件零改动（git diff 验证）
