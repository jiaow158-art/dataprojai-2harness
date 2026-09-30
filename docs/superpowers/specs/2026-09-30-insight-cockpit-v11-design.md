# AI 经营驾驶舱 v1.1「信息密度升级」设计 spec

| 项 | 内容 |
|---|---|
| 状态 | v1.0（2026-09-30 用户口头裁定"确定"：健康度确定性映射 + 范围=首页/详情页改版） |
| 来源 | 用户提供理想驾驶舱两张原型图（东鹏驾驶舱.png / 东鹏驾驶舱2.png，仓根目录）+ 2026-09-30 对话差距分析 |
| 上游 | `2026-09-23-ai-business-assistant-v1-design.md`（v1.2.4）——本 spec 是其 UI/展示层的迭代，不改检测/排序/归因语义 |
| 并行关系 | M-i4 灰度运行继续攒 D8 证据，本迭代不动阈值/校准/事件语义，互不阻塞 |

## 1. 范围

**做**（一个迭代量级，代号 **M-i5**）：
1. 新 API：事件趋势序列（首页卡内嵌图 + 详情页趋势卡共用）
2. 新计算模块：经营健康度（确定性映射，三环 + 库存未接入态 + 目标进度环）
3. 首页改版：AI 摘要横幅升级（分类 chips + 数据更新时点 + 观察中计数）、事件卡三件套（内嵌迷你图 / AI 洞察一行 / 语义色边框）、右列健康度卡、底部时间线（已有）
4. 事件中心升级：展示"观察中"（active 未上榜）事件，含分数与距发布线差值
5. 详情页补全：趋势卡点亮、事件状态流（诚实映射）、相关经营事件（同类/同区域）

**不做**（非目标，逐条有理由）：
- 外部经营动态（窑炉检修/中标/原材料涨价）——无数据源，上了首页就是造数据（诚实性红线）
- 侧栏新导航页（目标管理/作战地图/应收/SKU 效益）——v2 逐个走 spec；导航不露未建入口
- 全局搜索 ⌘K / 通知铃铛 / 品牌壳——v2 壳升级
- "生成方案"按钮、待跟进/督办状态——v4 督办闭环
- 库存健康环给分——库存雷达需日汇总层，先显示"未接入"诚实态
- 检测阈值/排序权重/归因契约的任何改动——D8 灰度基线不动

## 2. 决策记录

| # | 决策 | 依据 |
|---|---|---|
| D-c1 | 健康度 = **确定性映射**（公式+输入+因子全部可点开查看），禁止 LLM/黑盒综合评分 | 高管第一问是"78 分谁定的"；v1 全链路可溯源原则 |
| D-c2 | 健康度因子是**新校准点**：进 `insight/config/health.json`，改动须留台账（对齐 ranking.json 纪律），不动 D8 已攒证据 | 与 M-i1 阈值校准同一纪律 |
| D-c3 | 趋势查询**复用各雷达 config 的表与谓词**（detector 模块新增 `trend()`），禁止旁路重写 SQL——口径唯一权威在雷达 | 防"首页图和检测口径两张皮" |
| D-c4 | 首页摘要 chips = 重大异常(major) / 一般异常(minor) / **观察中**(active 未上榜)——水面下事件计数透明化 | 2026-09-30 讨论：今天 5 事件只露 2 条是页面单薄主因之一 |
| D-c5 | 事件状态流诚实映射：`发现 → 归因(三态) → 持续 N 天 → 已解除`；不造"待跟进/已跟踪"（无督办机制） | 图 2 的四步流含督办语义，v1 只有前半 |
| D-c6 | 相关事件只做 **同类 / 同区域** 两 tab，不做"产品相关"（v1 事件无产品维度） | 同上，不造维度 |

## 3. 架构与数据流

```
浏览器 → BFF(insight.ts 代理) → insight-api(:58095) ─┬→ insight.db（事件/榜单/timeline/归因）
                                                      ├→ DWS（trend 查询 × detector 口径；健康度 3 个聚合查询）
                                                      └→ 内存缓存（key=查询+as_of，as_of 变更即失效）
```

新增/改动（全部 additive）：
- `insight/detectors/*.py`：各雷达类新增 `trend(anchor: dict, months: int) -> dict`（复用本雷达 cfg 的表/谓词/日期语义；本迭代months 恒 12，参数保留）
- `insight/health.py`：健康度计算（纯函数 + 查询注入，可测）
- `insight/api_main.py`：3 个新 GET 端点（§4）
- `insight/config/health.json`：公式因子（D-c2 台账纪律）
- `dataplat-ui/server/src/insight.ts`：3 条新代理路由（GET，additive）
- `dataplat-ui/web/src/components/insights/`：改 4 个组件、新增 3 个（§6）

## 4. API 契约（insight-api → BFF 逐字代理，BFF 不解释）

### 4.1 GET `/api/insight/events/:id/trend?months=12`
事件锚点的月度序列。`months` 缺省 12，上限 24。

```json
{
  "event_id": "ev-...", "detector": "region_sales",
  "anchor_id": "粤东运营中心|GD03", "unit": "万元",
  "kind": "month_compare",
  "series": [ {"month": "2026-01", "cur": 1234.5, "prev": 1100.2} ],
  "meta": {"source_table": "…", "as_of": "2026-09-29"}
}
```

kind 语义按雷达封闭（UI 按 kind 选图型）：

| detector | kind | cur | prev | 图型 |
|---|---|---|---|---|
| region_sales | month_compare | 当月销售额(万) | 去年同月 | 双色柱 |
| gross_margin | month_single | 完整月毛利率(%) | — | 折线 |
| ar_risk | month_single | 当期 nat90 余额(万) | — | 面积线(红) |
| target | cumulative_dual | YTD 累计达成率(%) | 时间进度(%) | 双线 |

- 序列截至该事件 data_date（point-in-time：月值只取完整自然月，当月进行中的值不带——与 region_sales 检测的"完整自然月同比"口径一致）
- anchor 不存在/事件无对应序列 → 200 + `{"series": [], "reason": "…"}`（UI 显示空态，不 500）

### 4.2 GET `/api/insight/health`
首页健康度卡数据。as_of 缺省 = 最新数据日。

```json
{
  "as_of": "2026-09-29",
  "rings": [
    {"key": "sales", "label": "销售健康度", "score": 77.6, "mom_delta": -6.0,
     "formula": "100 − 完整自然月同比降幅(pt) × 2",
     "inputs": {"yoy_pct": -11.2, "month": "2026-08"}},
    {"key": "margin", "label": "毛利健康度", "score": 82.0, "mom_delta": 1.0,
     "formula": "100 − 毛利率环比降幅(pt) × 10",
     "inputs": {"delta_pct": 1.8, "month": "2026-08"}},
    {"key": "ar", "label": "应收健康度", "score": 62.0, "mom_delta": -3.0,
     "formula": "100 − nat90 占应收余额比例(%)",
     "inputs": {"nat90_share_pct": 38.0, "month": "2026-09"}},
    {"key": "inventory", "label": "库存健康度", "available": false,
     "reason": "库存雷达未接入（需日汇总层）"}
  ],
  "target": {"year": 2026, "achieve_pct": 78.1, "actual_wan": 42046.0,
             "annual_target_wan": 646154.0, "time_pct": 90.9}
}
```

- target = 年度口径：annual_target_wan = 当年各月目标求和（目标表 2026 段），actual_wan = 当年 YTD 实绩累计，time_pct = 已过工作日/全年工作日（与 target 雷达同定义）
- 任何环的数据查询失败 → 该环 `available:false + reason`，其余环照常（局部降级，不整卡 503）

### 4.3 GET `/api/insight/events?state=active`
事件中心"观察中"列表（D-c4）。返回 active 事件全集（含已上榜），每项附 `published_today: bool` 与 `score_gap`（距 publish_min_score 的差值）。已上榜事件标 `rank_today`。

## 5. 健康度口径定义（D-c1 落地）

| 环 | 公式 | 输入查询（全部瓷砖事业部域） | 因子（health.json） |
|---|---|---|---|
| 销售健康度 | `round(100 − clip(−yoy_pct,0,100) × k1, 1)` | 最近完整自然月全渠道销售同比（region_sales 同表同谓词聚合） | k1=2.0 |
| 毛利健康度 | `round(100 − clip(−delta_pct,0,100) × k2, 1)` | 最近完整月毛利率环比变动（gross_margin 同口径） | k2=10.0 |
| 应收健康度 | `round(100 − nat90_share_pct, 1)` | 当期 nat90 余额 / 应收总余额（ar_risk 同表） | — |
| mom_delta | 同公式跑上一期，取差 | 同上，期次 -1 | — |

- 同比为正/环比改善 → 记 100（封顶）
- 公式与 inputs 随响应下发，UI 点击分数弹层展示（"62 分 = 100 − 38%"）
- **因子是初始拍定值，灰度期校准**：改因子只影响健康环展示，不影响事件检测/榜单/D8 证据，但每次改动在 `eval_results/insight-gray/` 留台账行

## 6. UI 组件变更清单（15 个既有 + 新增）

| 组件 | 动作 | 内容 |
|---|---|---|
| TodayAttentionHeader | 改 | 标题行加"数据更新：{freshness 最新 effective_data_date}（4 雷达）"；chips：重大异常 N/一般异常 N/观察中 N |
| BusinessEventCard | 改 | 加迷你图（按 §4.1 kind 图型，高 120px 级）+ AI 洞察一行（attribution_summary 首句截 80 字，pending 时显示检测层 summary）+ 语义色左边框（major 红/minor 橙，已有 severityStyle） |
| OperatingDashboardPage | 改 | 布局改三列：事件卡 0-3 张（D2 上限不动）+ 右列健康卡；三卡以下右列占位不拉伸 |
| HealthPanel | **新** | 四环（库存=灰"未接入"）+ 目标进度环 + 分数点击弹层（公式+inputs） |
| MiniTrendChart | **新** | 纯 SVG 迷你图（双色柱/折线/面积/双线四型；无图表库依赖，与现有瀑布图同路线） |
| EventCenterView | 改 | 加"观察中"分区：active 未上榜事件列表（分数+score_gap+持续天数） |
| EventDetailPage | 改 | 挂 TrendPanel 真数据 + RelatedEventsCard + StatusFlowCard |
| TrendPanel | 改 | 占位灰块 → 调 trend API 渲染（含图例/同比标注，图 2 趋势卡形态） |
| StatusFlowCard | **新** | 四节点流：发现(first_seen) → 归因(三态+时间) → 持续(persist_days) → 已解除(resolved_at)；当前节点按 lifecycle/归因状态点亮 |
| RelatedEventsCard | **新** | 两 tab：同类（同 event_type）/同区域（scope_json 组织节点相同）；各取最近 5 条，排除自身 |

颜色纪律沿用 v1 裁定：白/浅灰/浅蓝底、蓝主操作、红橙只给真异常；红橙用量随本迭代增加（图表负值/异常环），但**语义色=数据方向**，不做装饰性用色。

## 7. 资源护栏与缓存

- trend/health 查询走 `DwsQueryRunner(app_name=insight-trend)`：SELECT/WITH 白名单、statement_timeout、串行（同一请求内不并发打 DWS）
- 进程内缓存 `dict[key=(sql,params), (as_of, result)]`：as_of（数据日）变更自然失效，无 TTL 定时器；进程重启即冷，量级几十条
- months 上限 24；单事件单序列一次查询（不做 per-month 循环查库）

## 8. 测试与验收

1. detector.trend()：fixture runner 断言序列截断在完整自然月、kind/字段按表、anchor 缺失空态（每雷达 ≥2 用例）
2. health.py：公式封顶/clip/环比差/局部降级（某环查询异常→available:false 不炸整卡）
3. api_main：三端点 ro 模式、缓存命中、months 上限拒绝（>24 → 400）
4. BFF：三条代理路由 + flag 门禁复测（403 FLAG_OFF 前置）
5. web：build 零错误（既有验证形态）；人工 smoke：首页三卡+健康环数字与 insight.db/直查 DWS 对得上（抽 3 个数）
6. 回归红线：harness `python -m pytest insight/ eval/` 全绿；网关/skills 零 diff；85 场景 eval 零退化（放行前跑一轮）

## 9. 侵入性复核（对齐 v1 spec §18）

- engine-gateway / m0 / skills / eval 判分语义：**零改动**
- 现有 chat/SSE/报告/管理路由：**零改动**；insight.ts 仅追加 3 条 GET 代理
- insight 既有模块：detect/merge_rank/brief/attribution/worker 逻辑零改动；detectors 仅新增 trend 方法
- 排序/阈值/发布线：零改动（D8 基线锁定）

## 10. 里程碑

单迭代 **M-i5**（建议任务序：T1 trend×4 雷达 → T2 health.py → T3 api 端点 → T4 BFF 代理 → T5 首页改版 → T6 详情页补全 → T7 事件中心观察中 → T8 验收+eval 复跑）。与 M-i4 灰度并行：上线走 feature flag 既有开关，admin-prod 即见，D8 攒数不中断。
