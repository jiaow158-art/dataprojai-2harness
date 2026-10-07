# AI问数 UX 产品化改造（P3-chat）— 规格（2026-10-07）

用户指令 + 计划确认 + 4 边界 3 裁定。仓库：dataplat-ui（纯前端展示层）。

## 目标

问数主界面从「Agent 调试台」转为「经营分析工作台」：视觉与驾驶舱统一（浅色 ck 系）、
执行过程三层化（经营答案/分析过程/技术详情）、SQL 默认折叠、最终答案第一视觉。
**不改**：消息协议、SSE、gateway、六步法、SQL 生成、skills、session 业务语义。

## 裁定与边界（2026-10-07 用户确认）

| # | 内容 |
|---|---|
| 裁定1 | flag-off 模式 AI问数也统一浅色（一个产品一套皮肤；P0 flag-off 字节不变边界仅护驾驶舱） |
| 裁定2 | 技术详情入口仅 isAdmin（方案B，/api/me.is_admin 既有透传） |
| 裁定3 | ReportPreview 壳页纳入浅色化——仅改壳，报告正文（iframe 引擎产物）自带主题不覆盖 |
| 边界1 | 普通用户只见经营答案+业务化过程；SQL 编号/文本/行数/耗时/工具名/tokens 全部只在层3（admin） |
| 边界2 | timeline/计数必须 SSE replay 幂等：按帧 lastEventId（网关 id:seq）去重，重连计数不翻倍；须断线重连实测 |
| 边界3 | 运行态不显「第 N 项查询」——只用「正在核对经营数据… / 已完成 N 项数据查询与分析」（callId/事件模型不保证序号语义） |
| 边界4 | answer 到达即第一视觉；完成态 AnalysisStatus 收缩到答案下方；admin 技术详情也位于答案之后；运行期间 AnalysisStatus 才占主视觉 |

## 设计要点（计划已确认）

- **层映射数据源诚实性**：SSE 无 workflow 事件（dsh-events 把 step/start/end 丢弃）；唯一可靠
  过程信号=7 值 stage 词表（queued/analyzing/querying/script_running/report_checking/publishing/repairing）。
  层2 业务文案全部 stage 直译（理解问题/核对经营数据/分析计算/生成报告/发布报告/恢复重试），
  零伪造步骤；六步法细粒度无信号→落到「已完成 N 项数据查询与分析」退化摘要。
- **SQL 归组**：事件按 seq 有序到达（D15 不重不漏），useTaskStream 追加积累 timeline（stage
  原文轨迹）；层2 按连续同 stage 压缩成段；每条 SQL 业务名一律「数据查询」安全退化，**禁止**
  从 SQL 文本猜业务含义。层3 SQL 按完成序编号，与工具行不配对（并行调用下调用序≠完成序）。
- **计数口径**：已完成 N = sql 事件完成数 + script_running stage 数 −（当前在跑脚本 1；
  脚本无完成事件，运行中不虚报，终态自然等于全部）。querying stage 的 text 字段=SQL 原文
  ——新 UI 全程不渲染 stageText（旧 StatusStrip 的最大泄露面，本次堵死）。
- **既有限制（明示）**：BFF 历史只落 answer_md，SQL 仅存在于 live SSE——技术详情在页面存活期
  可看（含非终态刷新重挂/seq0 全量重放），终态后刷新不可回看（与改造前现状一致，不改协议不解决）。

## 文件清单（11，全 web/src）

RunStream.tsx（三层化主体）/ useTaskStream.ts（timeline+seenIds 幂等，纯增量）/ ChatView.tsx
（浅色+isAdmin）/ HistoryTurn.tsx / AnswerCard.tsx（新，层1 卡）/ index.css（md-body 亮色重排，
仅 chat 引用已核）/ Sidebar.tsx（会话分支 ck 化——修复暗 token 落浅壳的近隐形文字）/
ReportCard.tsx / FeedbackControl.tsx / ReportPreview.tsx（壳）/ App.tsx（isAdmin 透传一行）。

## 验收（用户指定顺序）

build 绿（=部署）→ 对抗 review → 复杂 20+ SQL 实弹（运行态无 SQL/计数对拍 SSE 全量回放真值/
非 admin 视角零泄露）→ 断线重连实弹（CDP offline，计数不翻倍）→ 三宽度截图。
零退化红线：SSE/会话/六步法/SQL 执行零改动（server/ 与 harness 零 diff）。
