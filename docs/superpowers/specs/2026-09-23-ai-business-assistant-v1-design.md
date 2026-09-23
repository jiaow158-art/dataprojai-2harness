# AI 经营助手 v1（经营事件引擎）设计 spec

| 项 | 值 |
|---|---|
| 日期 | 2026-09-23 |
| 状态 | 待用户评审 |
| 来源 | brainstorm 会话（总裁视角愿景 → 旁路架构约束 → 4 雷达范围 → 事件式产品模型 → D1-D8 裁定 + UI/UX 裁定） |
| 总原则 | **扩能力，不重构核心**。现有 AI 问数 = 稳定底座；经营洞察 = 独立增强层 |

---

## 0. 一句话定位

> 系统已经替我看过数据了，现在告诉我最值得关注的事情。

不是 BI Dashboard：不放十几张 KPI 卡，不让管理层自己从 20 个指标里找问题。首页只有 0-3 张**经营事件卡**——v1 即使某天只有 1 张卡，只要这一张真的值得看，就比 20 张 KPI 卡成功。

**v1 全只读**：发现问题 → 展示问题 → 自动归因 → 继续追问。不自动改业务数据、不派任务、不写回业务系统、不外发推送。

## 1. 产品模型

```
4 个经营雷达（detector，确定性 SQL，各自盯数据就绪）
   ↓ 候选经营事件（detector 内部标准化 0-100 分）
合并（同组织+同渠道多雷达命中 → 一个事件多 facet；父子节点 → 父上榜）
   ↓
规则排序（五因子加权，可解释，版本化配置）
   ↓
今日经营关注 Top 0-3（门槛优先，3 只是展示上限）
   ↓
自动归因（10:00 后，走现有网关+域 analyst 技能）
   ↓
首页展示 → 事件详情 → 一键继续问数（现有问数链路）
```

管理层六问的 v1 覆盖：今天哪里出了问题 ✅ / 为什么 ✅（归因）/ 严重不严重 ✅（影响分+事实）/ 谁负责·还能做什么·解决了吗 ❌（督办闭环 = v4）。

**经营事件是一等实体**，不是每天生成的卡片文本：跨日续接（`持续第 N 天`）、可溯源（每个数字点开见 SQL）、有状态机、进时间线。

## 2. 裁定记录（全部已由用户拍板）

| # | 裁定 |
|---|---|
| D1 | v1 只扫**瓷砖事业部**。产品名统一「AI经营驾驶舱」，顶部显示当前范围「瓷砖事业部」——产品名不写死事业部，为扩集团留路 |
| D2 | Top 3 是展示上限非凑数指标；首页允许 0/1/2/3 张事件卡；不达门槛不展示 |
| D3 | 排序 = 经营影响度 30% + 目标缺口贡献 25% + 持续性 20% + 影响范围 15% + 新发/恶化程度 10%。detector 内部先标准化 0-100 再进全局排序（不拿原始金额横向比）。权重版本化配置，调整必须重跑历史回测 |
| D4 | 回测 12 个月（覆盖完整季节周期 + 去年同期 sanity check）。进本人灰度前：Top 事件"值得看"认可率 ≥80%、严重误报 = 0。开放集团高管前认可率门槛 ≥90% |
| D5 | 09:30 排序 cutoff；10:00 启动归因（避开夜间数仓 ETL 窗口）。每个 detector 必须先做 data freshness/watermark 检查；数据未就绪明示「数据未就绪」，**不得用旧数据伪装当天事件** |
| D6 | BFF → insight HTTP API → insight.db。BFF **不**直读 SQLite。insight 故障只影响经营洞察，绝不影响 AI 问数 |
| D7 | Business Event 保留 **365 天**；Evidence 原始结果保留 **90 天** |
| D8 | 本人灰度 ≥10 有效工作日且累计 ≥20 候选事件；开放业务负责人前五条全满足：①简报按时就绪率 ≥95% ②Top 事件认可率 ≥85% ③严重误报=0 ④85 场景问数回归零退化 ⑤简报数字与问数数字不一致事故=0 |
| UI | 事件驱动非 BI 驾驶舱；白/浅灰/极浅蓝底、蓝色主操作色、红橙只用于真异常、大量留白、卡片圆角适中；禁止深色大屏风；事件卡只允许一张小而明确的图；AI 建议动作与事实/归因视觉区隔；首页显示经营事件而非 detector 名称；无可靠评分算法就不显示分数 |

## 3. 数据现实基线（2026-09-23 直连 DWS 实测）

| 事实 | 设计后果 |
|---|---|
| 目标表 `dm_dp_api_sales_target` 凌晨 ~00:15 刷新（max stat_month=2026-12，全年目标已录） | 目标雷达可最早完成 |
| 应收日层 `dwr_ar_receivable_aging_2023_info_f` ~06:31 刷新；月汇总 `dm_ar_receivable_accage_t` ~08:00（当前版本 20260831） | 应收雷达落数时点按 ar 域路由选层后确定 |
| `dm_rpt_region_performance_daily_report_t` **实测 0 行**（知识在册、ETL 在册、无数据） | 业绩/毛利雷达不依赖该表，按 metrics.md §七路由从主事实表派生；就绪探针必须含行数检查。**这是真实数仓侧异常，建议另行排查（不在本 v1 范围）** |
| mix 表含预算/预测月份（2022-01~2026-12）、账龄层含 2026-12-31 未来日期行 | 雷达 SQL 模板**写死**过滤：实际数 + 日期 ≤ 数据日，防止把预算数当实绩报警 |
| 落数时点三表三样（00:15 / 06:31 / 08:00） | 调度必须**就绪驱动**，不能定时傻跑 |

口径权威：各域 `skills/{domain}-knowledge/references/metrics.md` 的「pattern → 首选表与字段路由」节（eval_dataset 录制口径）。业绩序列/下钻 → `dm_fin_operations_mix_sum_t`（主事实表，内置 node_desc1~9 九级组织）；同比 → `ct_sales_performance_t`（last_year_* 仅此表有）；目标达成 → mix + `dm_dp_api_sales_target`（**org_type 过滤防金额翻倍**，关联键 node_name5=sales_center_code + integrate_channel 缺一不可）；应收 → 按 ar 域路由（`dm_ar_analysis_rpt_f` 为主事实表，账龄分段用 aging 层）。

## 4. 架构总览

```
浏览器
  └→ UI BFF (58090, 现有, 最小侵入)
       ├─ chat/报告/管理 既有路由 ──→ engine-gateway (58080, 现有) ──→ dsh → DeepSeek
       │                              └→ DWS MCP（问数查询，现状不动）
       └─ /api/insight/* 新路由 ──→ insight-api (58095, 新, 仅本机) ──→ insight.db (新, WAL)
                                      ↑ 只读查询
insight-worker (新, 无端口, pm2)
  ├─ 调度：各雷达就绪探针轮询 → 检测 → 合并排序 → 09:30 定稿 → 10:00 归因提交
  ├─ 检测：直连 DWS 只读（学 run_eval.py 离线评测模式，不过 agent，零 API 成本）
  ├─ 归因：POST 网关 /api/tasks（X-User: insight-svc，走现有公开 API）
  └─ 写 insight.db / evidence 文件
```

进程与端口：

| 进程 | 状态 | 端口 | 说明 |
|---|---|---|---|
| engine-gateway | 现有 | 58080 仅本机 | **零改动** |
| UI BFF | 现有 | 58090 内网 | 最小侵入（见 §17） |
| insight-api | **新增** | 58095 仅本机 | Python FastAPI，只读服务 BFF；BFF 是唯一客户端 |
| insight-worker | **新增** | 无 | Python 调度+检测+排序+归因编排 |

技术栈：insight 两进程用 Python（复用仓内 DWS 直连与 etl_watch 的既有模式）；dataplat-ui 侧仍 TS。pm2 按现有部署方式（M1 报告部署节）增开两个进程。

## 5. 新增文件清单

### 5.1 本仓 `insight/`（新顶层目录，Python 包）

```
insight/
├─ worker_main.py            # 调度入口（pm2）
├─ api_main.py               # HTTP 入口（pm2）
├─ db.py                     # insight.db schema + 访问（WAL）
├─ dws.py                    # 只读直连（env 密钥，消毒日志）
├─ watermark.py              # 就绪探针（max 数据日 + 行数 + 实际数过滤）
├─ detectors/
│  ├─ base.py                # Detector 基类：依赖表声明/探针/检测/标准化
│  ├─ target.py              # 目标达成雷达
│  ├─ region_sales.py        # 区域×渠道业绩雷达
│  ├─ gross_margin.py        # 毛利雷达
│  └─ ar_risk.py             # 应收风险雷达
├─ merge_rank.py             # 合并规则 + 五因子排序（读 ranking.json）
├─ attribution.py            # 归因提交/轮询/解析/降级（走网关公开 API）
├─ brief.py                  # 简报定稿落库（09:30 cutoff）
├─ retention.py              # 365d/90d 清理（对齐 M4 SOP，dry-run 默认）
├─ backtest.py               # 12 个月历史重放
├─ config/
│  ├─ radar-target.json      # 依赖表/阈值/标准化参数（版本化）
│  ├─ radar-region_sales.json
│  ├─ radar-gross_margin.json
│  ├─ radar-ar_risk.json
│  └─ ranking.json           # 五因子权重/门槛/severity 分段
└─ tests/                    # 单测+fixture（含无异常日/正常波动/预算行防线）
```

### 5.2 dataplat-ui（BFF + 前端）

```
server/src/insight.ts        # 新路由模块（express.Router + flag 门禁 + followup 编排）
server/src/insight-flag-cli.ts # flag 管理 CLI（独立脚本，不动 admin-cli.ts）
web/src/components/insights/
├─ OperatingDashboardPage.tsx   # 驾驶舱首页（今日经营关注）
├─ TodayAttentionHeader.tsx
├─ BusinessEventCard.tsx
├─ BusinessEventList.tsx
├─ BusinessEventTimeline.tsx
├─ EventCenterView.tsx          # 经营事件中心（时间线全量视图）
├─ EventDetailPage.tsx
├─ EventExecutiveSummary.tsx
├─ EventFactCards.tsx
├─ AttributionPath.tsx
├─ AttributionWaterfall.tsx
├─ TrendPanel.tsx
├─ ImpactEntityTable.tsx
├─ SuggestedActionsPanel.tsx
└─ EventFollowupPanel.tsx
```

组件按用户裁定拆分，禁止把首页做成一个巨大组件。

### 5.3 pm2 / 部署 / 数据集

- pm2 增开 `insight-api`、`insight-worker` 两个进程（部署细节在实现计划定，对齐现有 M1 部署节方式）
- `eval_dataset.json` 新增 4 雷达检测 SQL 场景（走数据集变更清单纪律 + C2 门）
- env 清单：`INSIGHT_DB_PATH`、`INSIGHT_EVIDENCE_DIR`（均必须在 Temp 树外）、`INSIGHT_PORT=58095`、`GW_URL`、`GW_AUTH_TOKEN`（与网关同值，只走 env）、`INSIGHT_GW_USER=insight-svc`、`DWS_*`（复用现有变量名）

## 6. 数据模型

### 6.1 insight.db（insight 层私有；BFF 永不直读）

```sql
-- 雷达运行与就绪（审计+首页 freshness 展示）
CREATE TABLE radar_run (
  run_id TEXT PRIMARY KEY, data_date TEXT NOT NULL, detector TEXT NOT NULL,
  started_at INTEGER, finished_at INTEGER,
  status TEXT NOT NULL,             -- ready_check_failed|ran|empty|error
  watermark_json TEXT,              -- {table, max_date, rows, checked_at}
  findings_count INTEGER, error TEXT);

-- detector 原始发现（合并前；回测与误报分析的事实源）
CREATE TABLE detector_finding (
  finding_id TEXT PRIMARY KEY, data_date TEXT NOT NULL, detector TEXT NOT NULL,
  dim_keys_json TEXT NOT NULL,      -- {事业部, 组织节点(编码+名), 渠道, 时间窗}
  metrics_json TEXT NOT NULL,       -- {当前值, 同比, 影响金额万, 持续期, 目标缺口贡献…}
  norm_score INTEGER NOT NULL,      -- detector 内标准化 0-100
  threshold_passed INTEGER NOT NULL,
  merged_into_event_id TEXT, created_at INTEGER);

-- 经营事件（一等实体）
CREATE TABLE business_event (
  event_id TEXT PRIMARY KEY,        -- 确定性：<detector族>+<数据日>+<dim_keys 哈希>
  data_date TEXT NOT NULL, first_seen_date TEXT NOT NULL, persist_days INTEGER NOT NULL,
  detector TEXT NOT NULL,           -- 主发现雷达；facet_json 记其余雷达命中
  event_type TEXT NOT NULL,         -- sales_decline|margin_drop|ar_overdue|target_gap
  title TEXT NOT NULL,              -- 人话标题："华南零售销售连续下滑"（禁 detector 名）
  summary TEXT NOT NULL,            -- 一句话摘要（检测层数据生成，非 LLM）
  severity TEXT NOT NULL,           -- major|minor|target_gap（重大异常/一般异常/目标偏差）
  scope_json TEXT NOT NULL,         -- {范围:"瓷砖事业部", 组织节点, 渠道}
  period_json TEXT NOT NULL,        -- {类型:周|月, 起, 止}
  facts_json TEXT NOT NULL,         -- [{label:"华南零售同比", value:"-11.2%", …}]（只放事实）
  score REAL NOT NULL, score_breakdown_json TEXT NOT NULL,  -- 五因子分项（"为什么推给我"）
  metric TEXT NOT NULL,             -- 主指标名
  status TEXT NOT NULL,             -- discovered|analyzed（v1 只实现这两个；其余预留）
  facet_json TEXT, merged_from_json TEXT,
  -- 归因（10:00 后回填）
  attribution_status TEXT NOT NULL DEFAULT 'pending',  -- pending|running|done|failed
  attribution_summary TEXT,         -- 执行摘要（LLM 产，源自网关 answer）
  attribution_json TEXT,            -- {path[], findings[], waterfall, entities}（尽力解析）
  attribution_run_id TEXT,          -- 网关 run_id（溯源+报告链接）
  attribution_generated_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);

-- 证据（365d：行留存；90d：result_ref 指向的文件由 retention 清）
CREATE TABLE event_evidence (
  evidence_id TEXT PRIMARY KEY, event_id TEXT NOT NULL,
  kind TEXT NOT NULL,               -- sql|result|watermark|attribution_raw
  sql_text TEXT, result_ref TEXT, note TEXT, created_at INTEGER);

-- 每日简报
CREATE TABLE daily_brief (
  data_date TEXT PRIMARY KEY, scope TEXT NOT NULL,
  status TEXT NOT NULL,             -- assembling|final|not_ready|stale
  cutoff_at INTEGER, published_at INTEGER,
  event_count INTEGER, freshness_json TEXT,  -- 各雷达 {detector, ready, watermark, checked_at}
  attribution_started_at INTEGER);

-- followup 审计
CREATE TABLE followup_session (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL, username TEXT NOT NULL,
  ui_session_id TEXT NOT NULL, gateway_session_id TEXT, created_at INTEGER);
```

保留策略（D7）：`business_event`/`daily_brief`/`radar_run`/`detector_finding`/`followup_session`/`event_evidence` 行保留 **365 天**；evidence `result_ref` 指向的原始结果文件保留 **90 天**。清理并入 M4 数据保留 SOP（默认 dry-run，显式 `--apply`）。

### 6.2 BFF 记账库（ dataplat-ui/server/schema.sql 追加，CREATE TABLE IF NOT EXISTS，不 ALTER 现有表）

```sql
CREATE TABLE IF NOT EXISTS user_flags (
  username TEXT NOT NULL, flag TEXT NOT NULL,     -- 'insight_cockpit'
  enabled INTEGER NOT NULL DEFAULT 0,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (username, flag));
```

### 6.3 配置（版本化 JSON，非数据库）

`radar-*.json`：依赖表清单+watermark 规则、检测 SQL 参数、阈值、detector 内标准化参数（分位/log 标度）、scope 过滤（瓷砖事业部）。`ranking.json`：五因子权重（0.30/0.25/0.20/0.15/0.10）、上榜门槛、severity 分段。**任何配置改动必须重跑回测并留变更台账**（对齐 C2 精神）。

## 7. 四个经营雷达（detector）

通用契约（`detectors/base.py`）：

1. **watermark 先行**：对每张依赖表探 `max(实际数数据日)`（显式排除预算/未来行）**且行数 > 0**（空表探针——区域日报实测教训）。未就绪 → 该雷达当日 `数据未就绪`，不用旧数据。
2. **确定性 SQL**：模板从对应域 metrics.md §七路由派生，写死三条防线：scope=瓷砖事业部、实际数、日期 ≤ 数据日。无自由发挥。
3. **候选发现**：输出 `detector_finding`（含 dim_keys/metrics）。
4. **detector 内标准化 0-100**：影响金额相对本 detector 历史分布（回测期）取分位；跨 detector 只比标准化分，不比原始金额（D3）。

| 雷达 | 依赖（口径来源） | 检测逻辑（阈值进 config，回测定稿） | 事件形态 |
|---|---|---|---|
| target | mix 实绩 + `dm_dp_api_sales_target`（org_type 防翻倍；两关联键） | 月度达成率 vs 时间进度的落后幅度越阈；去年同期达成对照 sanity | "目标达成低于时间进度"（severity=target_gap） |
| region_sales | mix（业绩序列）+ ct_sales_performance_t（同比） | 区域×渠道周/旬同比连续 N 期 < -X%；影响金额=同比差额折算 | "华南零售销售连续下滑" |
| gross_margin | mix 毛利额/不含税收入（域标准公式） | 渠道/区域毛利率环比/同比变动 < -X pct 且金额越阈 | "工程毛利率明显下降" |
| ar_risk | ar 域路由表（`dm_ar_analysis_rpt_f` 主事实 + aging 分段层，日层 06:31 落数） | 90 天+余额环比增量越阈；top 客户集中度（前 5 贡献%）；连续逾期客户数 | "90天以上应收明显增加" |

**每张雷达的检测 SQL 作为新场景录入 `eval_dataset.json`**（expected SQL=同一查询）——从此 85 场景离线回归同时守护简报口径，改动必过 C2 门（约束 5 的机制化）。insight 引用的表登记入 etl_watch 监测清单（表下线/变更告警自动覆盖雷达）。

## 8. 合并与排序

**合并（规则，非 AI）**：
- 同组织节点+同渠道被多雷达命中 → 一个事件；主发现=标准化分最高者；其余降级为 facet（如"业绩下滑"事件附带"毛利率同时 -2.7pct"）
- 组织树父子节点都命中 → 父级上榜，子级进归因/影响对象，不单独占位（子级分数显著更高时例外）

**排序（五因子，全可解释，权重进 ranking.json）**：

```
score = 0.30×经营影响度(标准化分) + 0.25×目标缺口贡献 + 0.20×持续性
      + 0.15×影响范围 + 0.10×新发/恶化程度
```

- 持续性：连续越阈天数（封顶）；影响范围：组织层级+涉及下级节点数；新发/恶化：7 天内新发满分、持续事件按边际恶化程度取分
- 上榜门槛：score ≥ config 门槛才展示（门槛优先，上限 3）；severity 按分数段映射 major/minor/target_gap
- `score_breakdown` 落库并在 UI 展开"为什么推给我"

**跨日续接**：维度键相同且仍越阈 → 更新 `persist_days`，首页标"持续第 N 天"；事件消失=自然恢复，不发恢复卡（避免噪音）。

## 9. 归因管道

- **触发**：10:00（D5），只对上榜 Top ≤3 提交；候选事件不烧 API
- **执行**：`POST {GW_URL}/api/tasks`，`Authorization: Bearer <GW_AUTH_TOKEN>`，`X-User: insight-svc`（网关现有公开 API，与 ask.py/评测驱动同通道——**网关零改动**；insight-svc 身份在网关审计中天然可区分）
- **问题构造**：事件上下文（指标/组织/时间窗/异常数值/已有事实）+ 指定按对应域 analyst 技能的 6 步工作流做下钻归因（引擎按问题域路由到 sales-performance / fin-cost / ar 域——技能零改动，复用其对抗审查）
- **产物契约**：轮询 `GET /api/tasks/:run_id`（属主 insight-svc ✓）至终态；answer + report 存档；结构化字段（执行摘要/drill path/关键发现/影响对象）**尽力解析，解析失败降级为原文呈现**。检测层数据是硬结构化证据；归因层是 agent 产物，靠 run_id 溯源 + 域技能对抗审查背书。**关键发现必须出自查询结果**——解析时丢弃无查询结果支撑的发现条目
- **降级**：归因失败/超时（重试至 14:00 后放弃）→ 事件照常上榜，`attribution_status=failed`，执行摘要退回检测层事实摘要；[继续分析] 从不依赖预计算归因

## 10. 时序（就绪驱动两段式）

```
各雷达不等齐，就绪探针通过即扫：
  ├─ target      依赖就绪即扫（实测 ~00:30 可完成）
  ├─ region_sales / gross_margin   mix/ct 就绪即扫
  └─ ar_risk     按 ar 路由选层（日层 ~06:31 / 月汇总 ~08:00）
09:30  排序定稿 cutoff（全部就绪可提前）；未就绪雷达在 freshness 标「数据未就绪」
       → daily_brief.status=final，简报可读（第一段：发生了什么）
10:00  Top ≤3 归因提交 → ~10:30 摘要回填（第二段：为什么），事件卡原地升级
```

晨间体验两段式：早上打开="今天要关注什么"（事件+数字+影响分，全量可溯源）；10:30 后补齐"为什么"。周末照跑（周一早看周末累计），无异常自然显示无异常。

## 11. API contract

### 11.1 insight-api（58095，仅本机，BFF 唯一客户端）

```
GET /api/insight/daily?date=&scope=
  → { date, scope, dataFreshness:{ overall:"ready|partial|not_ready",
        radars:[{detector, ready, watermark, checkedAt}] },
      eventCount, stale:bool,
      events:[{ eventId, title, summary, severity, eventType, metric,
                scope, period, facts[], score, status, createdAt }] }

GET /api/insight/events/:eventId
  → { event, executiveSummary, facts, attribution:{status, summary, path[],
        findings[], waterfall, trend, entities[], runId, reportPath},
      evidence[], suggestedActions[], followupPrompts[] }

GET /api/insight/timeline?days=30
  → [{ eventId, title, severity, dataDate, createdAt }]

GET /api/insight/health   → 进程/DB/最近 run 概要（观测用）
```

UI 不感知 insight.db（D6）。

### 11.2 BFF 新路由（全部在 `server/src/insight.ts`，挂 `/api/insight`）

```
GET  /api/insight/enabled            # 会话门禁后返回当前用户 flag 状态（前端落地页判定）
GET  /api/insight/daily              # 反代 insight-api；flag 不开 → 403
GET  /api/insight/events/:id         # 反代；flag 不开 → 403
GET  /api/insight/timeline           # 反代；flag 不开 → 403
POST /api/insight/events/:id/followup {prompt?}
     # ① 会话门禁取 req.user ② 从 insight-api 取事件详情
     # ③ 服务端拼种子问题（事件上下文+用户意图）④ 建 ui_session（标题=事件标题）
     # ⑤ 落 followup_session 审计
     # → { uiSessionId, seedQuestion }
     # 前端拿到后跳转聊天页该会话，经【现有】提问路径自动发送种子问题
```

**followup 的零侵入设计**：网关提交仍走现有 GatewayClient + 现有 chat 代码路径（Bearer/X-User 唯一注入点红线不破）；BFF 不新增任何直连网关的提交代码；种子问题经浏览器回环（用户能在会话里看到上下文首条，反而符合透明原则）。网关侧看到的就是一个普通问数任务（D14 历史从该会话第一条自然累积）。**绝不创建第二套问数 Agent。**

## 12. UI 页面结构

路由形态：遵循现有 state 视图切换模式（App.tsx 的 chat/admin 先例，**不引入路由库**）；`view="insights"`，内部子视图 list/detail。

### 12.1 导航与 Header

- 左侧导航：今日经营关注（v1 功能）｜经营事件中心（v1 功能，时间线全量）｜**AI问数**（切回现有 chat 视图，完全独立）｜目标管理/区域经营/应收风险/SKU效益（v1 占位禁用态"后续版本"，不假可用）｜系统设置（仅 admin 可见，链现有管理后台）
- Header：左「AI经营驾驶舱」+ 当前范围「瓷砖事业部」+ 数据更新截至时间；右：全局 AI 搜索/问数入口（跳 chat）、通知、当前用户

### 12.2 驾驶舱首页（OperatingDashboardPage）

1. **今日经营关注**："截至昨日，发现 N 件值得关注的经营事项" + 轻量摘要标签（重大异常 x｜一般异常 x｜目标偏差 x——只是摘要不是 KPI 主体）
2. **0-3 张事件卡**（PC 横向三列）：序号 + severity 徽标（红=重大/橙=一般/蓝=目标偏差）+ 人话标题 + 摘要 + 关键数字（如 同比 -11.2%｜影响集团零售增长 -2.3pct）+ **至多一张**小而明确的趋势/柱状图 + AI 洞察一句话（须出自结构化归因证据；归因完成前该行显示检测层事实摘要，10:30 后原地升级）+ `[查看详情]` `[继续分析]` `[一键问AI]` + `持续第 N 天` 标签 + 展开式影响分明细（"为什么推给我"）
3. 右侧窄栏（不抢视觉中心）：经营健康概览（销售/毛利/应收/目标 各显示 正常/关注/异常 三态——**不做未经业务验证的评分数字**）+ 年度/月度目标进度（目标/实际/时间进度）
4. 底部：**经营事件时间线**（近期事件，可点入历史详情）
5. 空态：**「今日暂无重大经营异常」**+ 四雷达运行状态行（何时扫/多少项检查/结论）；数据未就绪态：**「数据未就绪」**（明示哪些雷达未就绪，绝不算作无异常）

### 12.3 事件详情页（EventDetailPage）

页面顺序（裁定：摘要先行，不是图表先行）：

1. 顶部：返回 + 标题 + severity 标签 + 发现时间/事件类型/涉及时间范围/当前状态（v1 状态机：`已发现` `分析完成`；发现中/分析中/待跟进/已跟踪/已关闭为未来预留，v1 不做闭环逻辑）
2. **AI 执行摘要**（右侧 `[基于本事件继续问AI]`）
3. **核心事实区**：3-4 张事实卡（同比/影响 pct/主要影响区域/持续时间——只放事实，无 AI 主观评分）
4. **自动归因分析**（核心模块）：Drill-down Path（集团→华南→广东→核心门店→规格，逐级贡献度）+ Waterfall 瀑布图（去年同期→各因子→本期）+ 关键发现列表（**必须由结构化证据生成，无证据条目在解析层已丢弃**）+ `[查看数据]` 展示 evidence（SQL+结果，只读）
5. **趋势与影响对象**：左趋势（6-12 期，判断一次性 vs 持续恶化）；右重点影响对象 Tab（核心门店/经销商/产品规格/客户，表列：名称/所在城市/同比/贡献占比/状态，默认 Top 5）
6. **AI 建议动作**（右侧栏）：只生成不执行（如"针对核心门店制定提升方案"）+ `[生成分析方案]`；**与事实/归因有明显视觉区隔**（弱化底色+标注"决策辅助"）
7. **一键继续追问**：快捷 prompt（为什么广东下降最明显？/查看 17 家核心门店详细数据/看规格贡献明细/生成完整经营分析报告）→ 走 §11.2 followup

### 12.4 视觉规范

白/浅灰/极浅蓝背景；蓝色主操作色；红/橙只用于真异常；大量留白；卡片圆角适中；企业级简洁高管感科技感但不炫酷；禁止深色大屏、霓虹线条、密集图表。图表：事件卡 ≤1 张、详情页趋势 1 张 + 瀑布 1 张，不堆图。

### 12.5 用户路径

```
登录 → AI经营驾驶舱（flag 开）→ 今日关注 → Top 0-3 → 事件详情
     → 自动归因 → 基于事件继续问 AI → 现有问数会话（chat 页独立完整保留）
```

## 13. Feature Flag 与灰度

- `user_flags` 表（§6.2），flag 名 `insight_cockpit`，默认关
- 管理：`insight-flag-cli.ts`（独立脚本，不动 admin-cli.ts）；放量节奏 = 用户本人 → 少量业务负责人 → 集团高管（D4/D8 门槛逐级把关）
- 灰度只控制"谁看见"：insight-worker 从第一天对全量数据跑（攒回测延续数据与信任证据）
- flag 关闭用户：登录落地 chat 页（现状），无任何 insight 入口可见

## 14. Insight 故障降级策略

| 故障 | 行为 | 对问数影响 |
|---|---|---|
| insight-api 挂 | BFF `/api/insight/*` 回 503 封闭集错误；前端驾驶舱页显示"经营洞察暂不可用"，侧栏 AI问数 正常 | **零** |
| insight-worker 挂 | 显示昨日简报 + 「数据过期」横幅（带数据日）；pm2 拉起 | **零** |
| 某雷达失败/DWS 不可用 | 该雷达 freshness 标「数据未就绪」，其余雷达与已定稿事件照常 | **零** |
| 10:00 归因时网关挂 | 重试退避至 14:00 后放弃 → attribution_status=failed，事件照常上榜，摘要退回检测层事实 | **零**（网关自身故障另有既有处理） |
| 归因超时/失败 | 同上；[继续分析] 不受影响（不依赖预计算归因） | **零** |
| followup 失败 | 前端错误提示，可重试 | **零** |
| insight.db 损坏 | worker 重建+回填补扫（当日事件重建；历史从备份恢复——运维项） | **零** |

**诚实性红线（代码级约束）**：数据未就绪 ≠ 无异常；无异常日不凑数；不可溯源的数字不上首页。

## 15. 回归保护与测试（四层）

1. **现有问数基线（零新建，直接复用）**：85 场景离线 eval（期望 SQL 直连 DWS，零 API 成本）+ 金点子 10 条 live 复判。v1 开发期间**每次合入必跑**；放行条件含"零退化"（D8 ④）
2. **口径守护**：4 雷达检测 SQL 入 `eval_dataset.json`（变更清单纪律）→ C2 门自动守护简报口径
3. **insight 单测**：watermark 探针（空表/滞后/未来行 fixture）、合并规则、五因子排序数学、标准化、归因解析降级、retention、followup 编排（上下文拼接/身份/审计行）、BFF flag 门禁（未开 403）
4. **行为红线测试**（fixture 驱动）：无异常日 → 输出"暂无重大经营异常"且不造事件；正常波动 → 不报警；预算/未来日期行 → 不得当实绩；数据未就绪 → 不得发布"无异常"
5. **E2E smoke**（开发环境）：fixture 事件 → 简报 → 详情 → followup 建会话 → chat 正常作答 → chat 全功能回归不受影响

## 16. 历史回测与放行门

- `backtest.py`：对过去 12 个月每个数据日离线重放 雷达→合并→排序（批量直连 DWS，零 API；归因不回放），产出逐月 Top 3 事件流 + 空跑日统计 + 去年同期 sanity 对照
- 校准回路：用户逐月抽检 Top 3（"值得总裁看？"）→ 调阈值/权重 → 重跑（config 改动强制重跑，台账留痕）
- 放行线：进本人灰度前 认可率 ≥80% 且严重误报=0（D4）；高管前 ≥90%
- 灰度放量门（D8）：≥10 有效工作日、≥20 候选事件、五指标全绿才开业务负责人

## 17. 侵入性复核（用户要求的再确认）

### 17.1 明确禁止修改清单

| 对象 | 清单 | 结论 |
|---|---|---|
| engine-gateway | `engine-gateway/src/**` 全部（http.ts/task-runner.ts/task-store.ts/dsh-backend.ts/…）、`m0/dsh-plugin/**`、`m0/tests/sandbox_redteam.sh` | **零改动**。归因走公开 HTTP API + insight-svc 服务身份；若未来出现"必须改网关"的需求 → 视为方案违例，需回本 spec 走变更裁决 |
| 现有问数 chat | BFF `server/src/app.ts` 既有路由体、`gateway.ts`、`sse-parser.ts`、`gw-audit.ts`、`db.ts` 既有表结构、`admin-cli.ts`、`schema.sql` 既有表 | 既有行零改动（schema.sql 只追加新表，见 17.2） |
| 现有 skills | `skills/**` 既有文件 | 零改动（知识编辑仍走 knowledge-publish + C2 门；insight 只**读** metrics.md 口径） |
| 现有问数页面 | `web/src/components/ChatView.tsx`、`Sidebar.tsx` 既有逻辑、`RunStream.tsx`、`HistoryTurn.tsx`、`ReportCard.tsx`、`ReportPreview.tsx`、`Markdown.tsx`、`LoginScreen.tsx`、`admin/**`、`api.ts` 既有函数、`types.ts` 既有类型 | 零改动 |
| 评测语义 | `eval/judge.py` 判分语义 | 零改动（只按纪律**新增**场景） |
| 契约冻结 | M2 集成检查报告冻结的既有契约 | 零改动（insight API 全为新端点） |

### 17.2 允许的最小侵入改动（逐文件、逐行级）

| 文件 | 改动 | 预估规模 |
|---|---|---|
| `dataplat-ui/server/src/app.ts` | ① `BffConfig` 增 `insightUrl?: string`（env `INSIGHT_URL`）② import + `app.use("/api/insight", insightRouter(deps))` 一行挂载 | ~5 行 |
| `dataplat-ui/server/src/index.ts` | env 透传一处 | ~1 行 |
| `dataplat-ui/server/src/schema.sql` | 文件尾追加 `user_flags` 表（CREATE TABLE IF NOT EXISTS，不 ALTER 既有表） | 追加块 |
| `dataplat-ui/web/src/App.tsx` | `view` 状态扩 `"insights"`；登录落地页按 `/api/insight/enabled` 分支（flag 关→chat，现状不变）；insights 子视图挂载 | ~15 行 |
| `dataplat-ui/web/src/components/Sidebar.tsx` | 增"AI经营驾驶舱"入口（flag 开才渲染） | ~5 行 |
| `dataplat-ui/web/src/api.ts` | 文件尾追加 insight 相关 fetch 函数 | 追加块 |
| `dataplat-ui/web/src/types.ts` | 文件尾追加 insight 类型 | 追加块 |

合计对既有文件的净侵入 ≈ 25 行装配代码 + 3 个追加块，全部为"挂载/透传/追加"，不触碰任何既有逻辑分支。**四对象结论：engine-gateway 零侵入；现有 chat 链路零逻辑侵入（仅装配）；skills 零侵入；现有问数页面零逻辑侵入（仅视图挂载与侧栏入口）。**

## 18. 安全与红线（延续仓规）

- 密钥只走 env（`DWS_PASSWORD`/`GW_AUTH_TOKEN`/`INSIGHT_*`），任何文件/日志/测试输出不得含值；insight 两进程日志消毒（PASSWORD|TOKEN|SECRET|KEY 模式），与网关 stderr 消毒同级
- `INSIGHT_DB_PATH`/`INSIGHT_EVIDENCE_DIR` 必须在平台 Temp 树外
- insight-api 仅绑本机（同网关）；BFF 是唯一客户端；followup 身份只信 BFF 会话门禁的 `req.user`（GatewayClient 红线延伸）
- 后台代理并行作业时提交必须路径限定（`git commit -m msg -- <paths>`）
- evidence 展示只读；无写回业务系统的任何通道（v1 全只读）

## 19. 非目标（v1 明确不做）

任务督办闭环（指派/跟踪/验证=v4）、推送外发（企微/邮件——v1 首页拉取式）、库存雷达（先做日汇总/快照层再接入，用户裁定）、预测与目标缺口弥补测算（v3）、经销商分型/SKU 月报/作战地图交互版（v2）、综合健康评分数字、移动端专项适配（PC 优先）、多事业部扫描（框架预留 scope 字段）、恢复通知卡。

## 20. 里程碑建议（供 writing-plans 细化）

| 阶段 | 内容 | 出口 |
|---|---|---|
| M-i1 | 检测层四雷达 + watermark + 回测框架 | 12 个月回测可跑；用户抽检校准通过 D4 线 |
| M-i2 | 合并排序 + insight.db + insight-api + 简报管道 | 09:30 定稿/10:00 归因全链路（开发环境） |
| M-i3 | BFF 路由/flag + 前端两页 + followup | E2E smoke 绿；85 场景回归零退化 |
| M-i4 | 本人灰度运行 | D8 五指标全绿 → 开放业务负责人 |

---

## 附：本 spec 落定后下一步

调用 writing-plans 技能，把 M-i1~M-i4 细化为带验证点的实现计划。**在此之前不写任何实现代码（HARD GATE）。**
