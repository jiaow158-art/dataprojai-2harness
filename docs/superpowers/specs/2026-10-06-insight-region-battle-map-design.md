# 区域作战地图（Region Battle Map）v1 设计 spec

| 项 | 内容 |
|---|---|
| 状态 | v1.0（2026-10-06 用户确认方向与两项诚实差异；原型图 `区域作战地图.png` 仓根） |
| 来源 | 愿景第四问"全国哪里出了问题"+ 原型图 + 2026-10-06 对话（数据实证先行） |
| 上游 | v1 spec（v1.2.4）/ M-i5~M-i7 页面族；D8 灰度继续，检测/榜单/归因零改动 |
| 代号 | **M-i8** |

## 1. 范围

**做**：区域作战地图独立页（侧栏第四项，flag 门禁）——5 统计卡 / 七大区着色真地图（省份边界资产）/ 区域排名 / 重点预警（大区关联事件）/ 区域趋势（近 12 月）/ 省区表现分布 / 重点作战区域三卡；一个 DWS 聚合端点 `GET /api/insight/region-map`。

**不做**（诚实差异，用户 2026-10-06 已确认）：
- **大区/省份"达成率"列与 tab 不做**——目标表只有中心维度；mix 预算列（ambperformance_ys）实测只填在无省份汇总行（2026-09 预算 5.68 亿全在 prov=NULL 组，省份行 ys 全空），按省拆分即造数。达成率只在顶部全国卡有真值（目标表口径，与 M-i7 同源）
- **着色沿用产品色彩纪律**（D-r1）：同比 ≤-8% 红 / -8%~0 橙 / ≥0 绿——原型"红=表现好"与全产品"红=负向"冲突，不反转
- "作战建议"标签按钮不做（无数据源）；未分区/海外组不进地图

## 2. 前置实证（2026-10-06 实测）

- mix 表有 `region_province_name`：**38 个值** = 31 个国内省市（名称无后缀："广东""内蒙古"…）+ **NULL 未分区组**（2026-09 实绩 673 万，预算行集中于此）+ 海外/港澳（越南/布达佩斯/奥克兰/维多利亚/九龙/Vladimir 区域）
- 省份 YTD 分布健康（广东 6.49 亿居首）；GROUP BY 省份单查 ~13s（缓存端点可接受，timeout 60s）
- 上年同月同表可比（同窗同比可算，方法同 M-i7 target_report 的 LY 封顶）

## 3. 大区映射（config 权威，`insight/config/region-map.json`）

```
华南：广东、广西、海南          华东：上海、江苏、浙江、安徽、福建、江西、山东
华中：湖南、湖北、河南          华北：北京、天津、河北、山西、内蒙古
西北：陕西、甘肃、宁夏、新疆、青海    西南：四川、重庆、云南、贵州、西藏
东北：辽宁、吉林、黑龙江
未分区：region_province_name IS NULL      海外：映射表外的其余值（动态归类）
```

（山东归华东、内蒙古归华北——标准七大区口径；映射表外的国内值若出现自动落"未分区"并在响应 `unmappedProvinces` 披露，不静默吞。）

## 4. API 契约

`GET /api/insight/region-map`（DWS 聚合；TrendService 缓存 key=(region_map, as_of)；national+regions 全降级不缓存；无 runner → 503 DWS_UNAVAILABLE）

```json
{
  "asOf": "2026-10-05", "window": "2026-01-01 ~ 2026-10-05（双年同窗）",
  "national": { "ytdWan": 363201.2, "lyWan": 326941.0, "yoyPct": 11.1,
                "grossMarginPct": 24.3, "achievePct": 75.9 },
  "regions": [ { "region": "华南", "ytdWan": 67584.6, "lyWan": 54108.0, "yoyPct": 24.9,
                 "sharePct": 18.6, "grossMarginPct": 25.1,
                 "level": "growth" } ],
  "provinces": [ { "prov": "广东", "region": "华南", "ytdWan": 64853.0,
                   "lyWan": 52109.0, "yoyPct": 24.5 } ],
  "unmappedProvinces": [],
  "regionTrend": { "months": ["2025-11","…","2026-10"], "series": {
      "华南": [ {"month": "2025-11", "wan": 5120.3} ] } },
  "regionEvents": { "华南": [ {"event_id": "ev-…", "title": "…", "severity": "minor",
                                "score": 50.7, "org": "粤东运营中心"} ] }
}
```

### 口径定义（服务端唯一权威）

- **同窗同比**：当年 1 月 1 日~as_of（当月 calday 封顶 MTD）vs 上年同月同日窗——与 M-i7 LY 法一致；分母 0/NULL → `yoyPct: null`
- **大区聚合**：省份求和后映射；未分区/海外作为独立行出现在 regions/provinces（`region: "未分区"/"海外"`），**不参与地图与排名展示**（UI 过滤），但金额如实计入 national 与合计
- **level（着色档，服务端判定）**：`decline`（yoyPct ≤ -8，与 region_sales 雷达阈值一致）/ `watch`（-8 < yoyPct < 0）/ `growth`（yoyPct ≥ 0）/ `unknown`（yoyPct null）
- **grossMarginPct**：窗内 gross_profit_after_sharing 之和 / notax_sales_net_amt 之和（非比率平均）
- **achievePct（仅全国）**：与 M-i7 target-overview annual 同源（复用 `target_report`，D-t6 精神延续）
- **regionTrend**：近 12 个自然月逐月实绩（完整月全月；当月 MTD）按大区；未分区/海外不入趋势
- **regionEvents**：大区 → 关联 active 事件。关联规则：事件的 org（中心名）在该区任一省份**当月有销售**（center×province 当月销售关系，一次查询推导 center→regionSet 映射；org 无匹配（如"瓷砖事业部"BU 级事件）→ 关联到**全部大区**）。按 score 降序每区最多 5 条
- **5 统计卡口径**：全国销售额=national.ytdWan；同比=yoyPct；毛利率=grossMarginPct；达成率=achievePct；重点关注区域数 = regions 中 level ∈ {decline, watch} 的计数（国内七区口径）

## 5. 地图资产与渲染

- **资产管线（T0）**：下载 DataV 公开省份边界 GeoJSON（`geo.datav.aliyun.com/areas_v3/bound/100000_full.json`）→ 坐标简化（2 位小数）转 SVG path 集 → 生成 `dataplat-ui/web/src/assets/china-map.ts`（path 数据 + 省名→adcode 映射，含"南海诸岛"小图）；资产文件预计 150-400KB，入仓一次性建设
- **省名匹配**：mix 省名（无后缀）→ DataV 全名归一表（31 行，"内蒙古"→"内蒙古自治区"等），随资产生成
- **渲染**：`ChinaMap` 纯 SVG 组件——省份 path 按所属大区着 level 色（七区三档），区域气泡（区名+销售额亿+同比%）锚大区几何中心（坐标随资产生成），点击大区 → 高亮该区省份 + 联动右栏与省分布过滤；未分区/海外不入图
- **降级**：资产管线失败（网络/格式）→ 自动降级"省份磁贴矩阵"（格子地图，布局表内置）——数据层零变化，UI 层替换渲染器。降级决策在 T0 完成时定，不拖到 T4

## 6. 页面结构

```
区域作战地图
├─ 标题行：区域作战地图 ｜ 查看全国区域经营表现与风险热点 ｜ 数据日 {asOf}（同窗说明小字）
├─ 5 统计卡：全国销售额(+同比) / 同比增速 / 毛利率 / 全国达成率 / 重点关注区域数
├─ 主体两栏（左 ~60% 地图区）：
│  ├─ ChinaMap（大区着色+气泡+图例：红=下滑告警/橙=关注/绿=增长；缩放按钮 v1 不做）
│  └─ 右栏：区域排名（tab 销售额/同比增速；列 排名/区域/销售额(亿)/同比；行点击=选区）
│          + 重点预警（选中区的关联事件卡：标题/org/分数/查看详情→事件详情；未选区=全部按分数）
├─ 底部三块：区域趋势（近12月多线，选中区高亮）/ 省区表现分布（选中区过滤 Top 省；条形+同比）
│          + 重点作战区域三卡（同比最深三区：销售/同比/毛利 + 查看详情=选区联动）
└─ 空态/降级：地图资产缺失→磁贴；DWS 块降级→各卡 reason 行
```

## 7. 实现面（全部 additive）

| 层 | 改动 |
|---|---|
| harness | `insight/config/region-map.json`（大区映射）；`insight/region_map.py`（聚合+同窗+关联）；TrendService.region_map；api 路由；资产管线脚本 `scripts/build-china-map.py`（生成 web 资产，产物入 dataplat-ui 仓） |
| BFF | insight.ts 一条 GET 代理 + 测试 |
| web | `assets/china-map.ts`（T0 产物）+ `ChinaMap.tsx` + `RegionBattleMapPage.tsx` + App view `"regions"` + Sidebar 第四项（我的关注顺移） |

## 8. 测试

1. region_map：同窗同比数学（双年封顶）/大区映射与 unmapped 披露/未分区海外入 regions 不入图口径/level 三档边界（-8/0）/毛利比率求和法/regionTrend 12 月补齐/regionEvents 关联规则（center→region、BU 级→全区间）/局部降级
2. api：200/缓存命中/全降级不缓存/503
3. 资产管线：生成的 path 集 34 省级行政单位齐全、省名归一表覆盖 mix 31 值
4. BFF 代理透传；web build；insight/server 全量；eval 零影响
5. 生产冒烟：national 与 M-i7 target-overview annual 实绩逐位一致（同窗一致性）；广东居省榜首；地图渲染 34 单位

## 9. 决策记录

| # | 裁定 |
|---|---|
| D-r1 | 着色=产品色彩纪律（下滑红/增长绿），不沿用原型"红=好"；阈值 -8 与 region_sales 雷达一致 |
| D-r2 | 大区/省份达成率不做（无真实数据源）；达成率仅全国卡（与 M-i7 同源） |
| D-r3 | 未分区(NULL)/海外如实入聚合与明细行，不入地图/排名/趋势；映射表外国内值落未分区并披露 |
| D-r4 | 同窗同比=双年同月同日窗（MTD 对 MTD），方法与 M-i7 一致 |
| D-r5 | 大区→事件关联=center×province 当月销售关系推导；BU 级事件关联全部大区 |
| D-r6 | 地图资产=DataV 公开 GeoJSON 转内嵌 SVG 入仓（一次性）；失败降级磁贴矩阵，数据层不变 |
