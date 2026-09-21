# 知识库健康与治理体系 — 研究设计（2026-09-21，与用户共同研究定稿）

> 背景：知识库是问数系统的命根子（无知识 21% vs 有知识 95%+）。用户裁定四项全做：静默腐烂监测 / 用户反馈闭环 / 扩域工厂 / 治理与 Owner；数据授权分组暂缓。
> 用户提供的核心能力：**数据中台 ETL 文件在 git 仓，可周期抓取覆盖式镜像到本地**。

## 一、事实基础（huaweiclaude/ 样本实测 2026-09-21）

| 事实 | 值 |
|---|---|
| 形态 | `PJob_<目标表名>.txt`（HiveSQL ETL）+ 同名 `.metadata.json`（name/type/directory/database）成对 |
| 规模 | 4052 对（DM/DWI/… 分层分域目录，43MB） |
| 命名即血缘 | 文件名直接编码目标表 → "谁建这张表"零成本可得 |
| 字段语义 | SELECT 列内嵌中文注释（`T.STAT_MONTH --年月`）——字段级语义文档天然存在 |
| 变更痕迹 | 文件头 author/create time/history list（UPDATE 工号 时间 描述） |
| 注释完备度 | 部分有注释，部分需读逻辑（用户确认） |

## 二、A. 静默腐烂监测（先行——最高险）

**数据流**：
```
用户侧：GitHub 周期抓取 → 覆盖式更新 ETL 镜像目录（缺省 huaweiclaude/，路径可配）
系统侧每日健康任务 etl-watch：
  1. 内容哈希清单 diff（上次 vs 本次）→ 变更/新增/删除的 PJob 集合
  2. 解析变更 PJob → 目标表（文件名）+ 源表（FROM/JOIN 抽取，复用判分器 extract_tables 的 HiveQL 兼容版）+ 字段注释图 + 头部 history
  3. 知识引用图：从 skills/**/references/*.md 抽表/字段引用（同样复用抽取器）
  4. 交叉 → 日报：「表 X 上游逻辑变更 → 触及 <域>.metrics.md N 处引用，建议复核」
     + 删除的 PJob = 表疑似下线 → 引用该表的知识点红色告警
     + 字段存在性巡检：知识提到的字段 vs ETL 当前 SELECT 别名（再对 DWS information_schema 抽查）
  5. 每周：全量 79 场景离线 eval（行为级兜底，复用发布门同款 runner）
```
产物：`eval_results/pilot/` 下 `etl-health-<date>.md` 日报；管理后台统计页并入一栏（后续）。

## 三、B. 用户反馈闭环

- UI：每个答案气泡加「有问题」按钮 → `POST /api/feedback`（run_id/session_id/原因分类枚举：数值不对/口径不对/看不懂/其他/描述）→ BFF incidents 表
- 管理后台：问题队列页（状态：待归因/修复中/已发布/驳回）；归因动作联动审计页（跳 run 轨迹）
- 修复路径：改知识 → 发布门 → 提交 sha 回写 incident（闭环链：用户反馈 → 知识 commit → eval 成绩）
- 红线：反馈不改数据集标准；若反馈揭示数据集本身错，走数据集修复纪律（变更清单）

## 四、C. 扩域工厂（数天 → 数小时）

流水线五步（每步产出可检查的中间物）：
1. **脚手架**：`scripts/domain-scaffold.mjs <domain>` 建 knowledge/analyst skill 对 + 目录骨架 + 跨域引用节
2. **起草**：`scripts/domain-draft.mjs <domain> --tables t1,t2`——从 ETL 镜像抽目标表 PJob：SELECT 注释 → 字段语义表；源表 → 血缘；metadata.json → 域归属 → 生成 metrics.md **草稿**（决策树/路由规则留 TODO 标记）
3. **Owner 确认**：人对草稿做口径裁决（分歧点显式列出，裁决记入登记表）
4. **场景实录**：eval-scenario-writer 打法（DWS 实录期望 SQL+data，时间锚点纪律双侧有界）
5. **过门发布**：C2 知识发布门（79+新增场景回归）

## 五、D. 治理与 Owner

- **Owner 角色**：每域一个口径 Owner（v1=用户本人；users 表 is_admin 之外后续加知识角色位）；Owner 职责=口径裁决+发布确认
- **分歧登记表** `sources-of-truth/caliber-registry.md`：所有"两表皆可/数值不一致"型分歧的裁决记录（先例：dm.amount 4.25亿 vs dwrfin 2.59亿；capital_cost 排 K 差异）——路由规则只引用已裁决口径
- **变更责任**：ETL 变更触发的知识复核由日报指派到域 Owner（v1=日报 + 人工认领）

## 六、里程碑

| 阶段 | 内容 | 依赖 |
|---|---|---|
| H1 健康监测 | etl-watch 日报（diff/解析/交叉/字段巡检）+ 周 eval | 用户把镜像更新跑起来（节奏自定，建议日更） |
| H2 反馈闭环 | UI 按钮 + incidents + 队列页 | 无外部依赖 |
| H3 扩域工厂 | scaffold + draft 两脚本 + 首域试点（选一个轻域实跑全流程） | H1 解析器 |
| H4 治理 | Owner 位 + 分歧登记表 + 流程文档 | 贯穿，随 H1-H3 落 |

## 七、开放问题（待用户输入/裁定）

1. ETL 镜像更新的**执行方式**：用户手工/计划任务 GitHub pull？（系统只读镜像目录，抓取不在本系统职责内）
2. 覆盖式更新**删文件语义**：删除=表下线（按设计触发红色告警）——确认这个解释符合数据中台实际？
3. H3 首域试点选哪个（16 个未覆盖域中挑一个业务急迫且表少的）？
