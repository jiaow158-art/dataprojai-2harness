# 目标管理页（Target Management）v1 设计 spec

| 项 | 内容 |
|---|---|
| 状态 | v1.0（2026-10-02 用户确认方向"1"；无原型图，按对话提案结构定稿） |
| 来源 | 愿景第六问"今年目标还能不能完成"+ 2026-10-02 对话提案 |
| 上游 | `2026-09-23-ai-business-assistant-v1-design.md`（v1.2.4）/ M-i5 健康度目标环 / M-i6.1 侧栏产品化 |
| 代号 | **M-i7**；D8 灰度继续，检测/榜单/归因零改动 |

## 1. 范围

**做**：目标管理独立页（侧栏第三项，flag 门禁）——年度总览 / 确定性趋势外推 / 月度达成表 / 组织（运营中心）缺口拆解 / 一键追问；一个 DWS 聚合端点 `GET /api/insight/target-overview`。

**不做**：
- **LLM 预测**——外推=确定性线性年化（可解释红线，公式随响应下发）
- 未来月份目标模拟/情景沙盘（用户拖参数算 what-if）——后续版本
- 侧栏其余未实现页面不露；engine-gateway/skills/chat 零改动；followup 复用既有编排

## 2. 前置实证（2026-10-02 实测）

- **中心名称映射**：`dm_rpt_sales_group_t` 内 `node_name5→node_desc5` 在瓷砖事业部下 **1:1**（20 码抽查 name_cnt 全 1）——映射查询用 `MAX(node_desc5)` 防树形多行重复
- **上年同期在库**：mix 表 2025-09/2026-09 同期数据齐（96,405 万 vs 72,890 万）——月度同比与恢复潜力可算
- 目标表 2025 整年未填报（M-i1 既有事实）——页面恒取**当年**；1 月初数据少属正常不造

## 3. API 契约

`GET /api/insight/target-overview`（DWS 聚合，TrendService 缓存 key=(target_overview, as_of)；三数据块全降级不缓存；无 runner → 503 DWS_UNAVAILABLE）

```json
{
  "asOf": "2026-10-02", "year": 2026,
  "annual": { "achievePct": 82.8, "actualWan": 357407.2, "targetWan": 431430.1,
              "timePct": 74.5, "timeBasis": "年日内自然日占比" },
  "projection": { "dailyWan": 1183.5, "projectedWan": 432037.0, "projectedGapWan": -606.9,
                  "basis": "YTD 实绩 ÷ 年内已过自然日 × 全年自然日（线性年化）" },
  "months": [ { "month": "2026-01", "actualWan": 38021.0, "targetWan": 36000.0,
                "achievePct": 105.6, "yoyPct": 4.2, "isCurrent": false } ],
  "centers": [ { "centerCode": "H03230618", "centerName": "国内营销中心",
                 "actualWan": 90000.0, "targetWan": 120000.0, "achievePct": 75.0,
                 "timePct": 74.5, "behindWan": 200.0, "behindSharePct": 18.2,
                 "recoveryWan": 1500.0 } ],
  "centersTotalBehindWan": 1100.0
}
```

### 口径定义（服务端唯一权威，公式随响应下发）

- **annual**：与 health-score target 块同口径（YTD 累计实绩/各月目标求和；时间进度=年日内自然日占比）
- **projection**：`dailyWan = YTD实绩/已过自然日`；`projectedWan = dailyWan × 全年自然日`；`projectedGapWan = 年度目标 − projectedWan`（负=预计超额，如实展示负值）
- **months**（当年 1 月至 as_of 月）：完整月=全月实绩；当月=MTD（`calday<=as_of` 封顶，与目标雷达同 point-in-time）；`achievePct=实绩/目标`（目标 0/NULL→null 不造）；`yoyPct=同比增幅`（上年同月缺→null）；当月行 `isCurrent:true`
- **centers**（缺口拆解，按欠进度额降序）：
  - 实绩侧：mix 当年 YTD 按 `node_name5` 聚合（当月 MTD 封顶）
  - 目标侧：目标表当年各月按 `sales_center_code` 聚合求和；center 集=目标雷达同口径（centers CTE + `center_set_month_lag`）
  - 名称：LEFT JOIN sales_group 取 `MAX(node_desc5)`，无映射回显码
  - `behindWan = 目标 × 时间进度% − 实绩`（**欠进度额**，与目标雷达事件 `abs_gap` 同语义；负值=超前，参与排序但展示带号）
  - `behindSharePct = behindWan / Σ(behindWan>0) × 100`（分母只计落后者）
  - `recoveryWan = max(0, (上年同期日均实绩 − 当前日均实绩) × 剩余自然日)`（该中心**恢复潜力**：回到去年同期跑速可补回的量；公式可解释）
- **局部降级**：annual/months/centers 三块独立 try/except，坏块 `available:false + reason` 其余照常

## 4. 页面结构

```
目标管理
├─ 标题行：目标管理 ｜ {year} 年 · 数据日 {asOf}
├─ 上排两卡：
│  ├─ 年度目标进度（大环 achievePct + 实际/年度目标/时间进度三数）
│  └─ 趋势外推（预计完成 projectedWan ｜ 预计缺口 projectedGapWan（负显"预计超额"）
│              ｜ 口径小字 basis；达标线=0 分隔）
├─ 月度达成表：月份/实际/目标/达成率/同比/状态（完成·进行中）——当月行浅蓝底标记
├─ 组织缺口拆解：中心/实际/目标/达成率/时间进度/欠进度额(+占比条)/恢复潜力
│  （欠进度额水平条形图内嵌表内，红=落后；恢复潜力绿；点击行 → followup 种子问题）
└─ 一键追问（页脚）："按当前趋势全年缺口多少？哪些中心有恢复潜力？"→ 既有 followup 编排跳 chat
```

- 颜色纪律：蓝=主/达成；红=落后/缺口；绿=恢复潜力/超额；无数据的格显"—"
- 侧栏：`insightsEnabled` 门禁下经营导航区第三项「目标管理」（activeView==="targets" 高亮）；今日关注/事件中心不动

## 5. 实现面（全部 additive）

| 层 | 改动 |
|---|---|
| harness | 新 `insight/target_report.py`（查询+聚合+外推，纯函数 runner 注入可测）；`TrendService.target_overview(as_of)`；api 路由 `/api/insight/target-overview` |
| BFF | insight.ts 一条 GET 代理 + 测试断言 |
| web | types（TargetOverview 族）+ api 函数 + `TargetManagementPage` + App view `"targets"` + Sidebar 第三导航项 |

## 6. 测试

1. target_report：annual 与 health 口径对拍（同 fixture 同数）；外推数学（2 月 15 日 YTD 1000 万→日均/年化手算）；月度 MTD 封顶/目标缺省 null/当月标记；centers 欠进度/占比分母只计落后者/恢复潜力 max0 与上年缺省；局部降级
2. api：路由 200/503（无 runner）/缓存命中/全降级不缓存
3. BFF：代理透传 + flag 门禁
4. web build 零错误；insight/server 全量绿；eval 零影响
5. 生产冒烟：annual 与首页健康度目标环数字一致（同一口径两处呈现必须相等）；centers 缺口合计与 annual 欠进度额量级对拍

## 7. 决策记录

| # | 裁定（2026-10-02 用户方向确认 + 本 spec 固化） |
|---|---|
| D-t1 | 预测=确定性线性年化，不做 LLM 预测（可解释红线；公式随响应下发） |
| D-t2 | 缺口拆解主指标=**欠进度额**（目标×时间进度−实绩），与目标雷达事件 abs_gap 同语义——全产品一个缺口口径 |
| D-t3 | 恢复潜力=回到上年同期跑速的可补回量（确定性公式），不做情景沙盘 |
| D-t4 | 中心名称映射 MAX(node_desc5) 防树形重复；无映射回显码 |
| D-t5 | 页面恒取当年；目标表历史年未填报不回溯 |
| D-t6 | annual 口径与 health-score target 块完全同源——两处呈现数字必须一致（冒烟断言） |
