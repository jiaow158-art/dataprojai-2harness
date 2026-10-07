# AI问数 UX 产品化改造（P3-chat）— 实施报告（2026-10-07）

依据：用户指令 + 计划确认 + 4 边界 3 裁定（spec：`2026-10-07-p3-chat-ux-productization.md`）。
提交：dataplat-ui `5bba041`（实现，11 文件 +401/−183）+ `399a607`（review 修复 2 项）。
**纯前端展示层：server/（BFF）与 harness 网关零 diff，SSE/六步法/SQL 生成/session 语义零改动。**

## 交付内容

| 层 | 实现 |
|---|---|
| 视觉统一 | ChatView/侧栏会话分支/报告卡/反馈/报告预览壳/md-body 全部 ck 亮色系；修复侧栏会话文字近隐形（暗 token 落浅壳，实测 vision 确认"对比度极低"）→ 会话文字深色清晰、选中主色高亮 |
| 层1 经营答案 | AnswerCard（新组件，RunStream/HistoryTurn 复用）：白卡+shadow-ck+「经营分析结论」主色标头；**answer 到达即第一视觉（边界4）**；报告卡紧随 |
| 层2 分析过程 | 业务化 stage 时间线（连续同 stage 压缩成段：理解问题/核对经营数据×N/分析计算×N/生成报告/发布报告），全员可见默认折叠；stage 词表直译零伪造 |
| 层3 技术详情 | 仅 isAdmin 入口（边界1 方案B，/api/me.is_admin 透传）：SQL #N·行数·ms·SQL 文本（折叠条）+ 工具调用轨迹 + tokens/总耗时；位于答案之后 |
| AnalysisStatus | 运行态=业务阶段+「已完成 N 项数据查询与分析」+计时/重连/attempt 徽标（**不显「第 N 项」**，边界3）；完成态收成一行「✓ 分析完成 · N 项 · 总耗时」+两个折叠入口 |
| 幂等（边界2） | useTaskStream：timeline 轨迹追加 + **SSE 帧级 lastEventId 去重**（网关每帧 `id:seq`，BFF 字节透传；重叠帧丢弃，重连计数绝不翻倍）；effect 重跑 fresh 重置 |
| md-body | 亮色重排：h1/h2 分隔线层级、表格表头 soft+斑马纹+tabular-nums、blockquote→callout、浅色 code/pre；仅 chat 引用（admin 零使用，改前已核） |

计数口径：N = sql 完成数 + script_running 数 − 在跑脚本 1（脚本无完成事件，运行中不虚报，终态自然收敛）。
querying 段 text=SQL 原文——新 UI 全程不渲染 stageText（旧 StatusStrip 的最大泄露面，已堵死）。

## 对抗 review（子代理，PASS×10 边界）

边界1-4/协议/md-body 影响面/移动端 CSS/暗 token/不扩 scope/XSS 全 PASS；确认**非 admin 的 SQL 渲染路径为零**。
4 项发现（无 HIGH）：MED「总耗时对非 admin 可见」——**裁定保留**（边界1 枚举指 SqlBar 逐条执行属性；任务级总耗时是等待感知，旧 UI 全员可见，移除属退化；两处 `isAdmin &&` 可随时收紧）；LOW×3：并行脚本计数理论虚高（顺序 agent 不触发）/双失败文案/侧栏 hover 可供性——后两项已修（399a607），首项记录在案。

## 实弹验收（生产 :58090，playwright + 系统 Chrome，2 次真实复杂问）

问法：对比 2026-07/08 瓷砖+卫浴事业部销售额/毛利率/库存/应收（两次运行 **21 SQL** 与 **24 SQL**，20+ 场景成立）。

| 验收项 | 结果 |
|---|---|
| 主区浅色 | rgb(245,248,252) ✓；vision 六项复查：浅色/会话可读/答案卡第一视觉/完成行/零 SQL 平铺/无样式破损 |
| 运行态默认视图（admin/非admin/重挂后） | 无 `SQL #`、无 `SELECT ` 原文；非 admin 无「查看技术详情」入口、无 tokens（route 改写 /api/me.is_admin=0 实测） |
| **计数对拍（边界2 核心）** | UI「已完成 24 项」== SSE 全量回放真值 sql=24+scripts=0，帧 63 **dupIds=0**；层3 SQL 条数 24==24 |
| **重放幂等** | 运行中刷新重挂（seq0 全量重放进 fresh state）：计数 19→19 精确保留，零翻倍零丢失 |
| 断线重连 | CDP offline + context.setOffline 双通道 30s：**未能切断已建立 SSE**（系统 Chrome 离线仿真不拆存量 socket，工具限制，如实记录）——重连路径证据改由：①刷新重挂重放幂等（上）；②BFF/gateway 契约（Last-Event-ID 字节透传+after= 裁剪，server/test/sse.test.ts、e2e.manual#3「重复 id 数 0」）；③seenIds 守卫 review 验证。**后续如需真·断线实测：浏览器 DevTools 手动断网或 BFF 侧重启窗口** |
| 层2 面板 | 理解问题+核对经营数据段在位，无工具名泄露 |
| 层3 面板（admin） | SQL #1..24、tokens、ms 全在（DOM 断言；截图受内层滚动容器限制未含列表——fullPage 只截外层文档，chat 滚动在 .ck-scroll 内层） |
| 历史回合 | AnswerCard「经营分析结论」在位；无层2/3 入口、无 SQL（与"历史无过程事件"协议既定一致） |
| 响应式 | 1366/1920 横向溢出 0 |
| 协议红线 | server/、engine-gateway/ 零 diff；无 dangerouslySetInnerHTML 新增 |

截图 `D:\dataplat-ui\screenshots-p0\p3-chat\`（11 张：空态/运行早中/非admin/重挂/完成默认/历史 × 3 宽度）。探针 `scripts/p0/p3-live*.mjs`（密码走 DP_ADMIN_PW env——首轮版本曾硬编码被分类器拦截，已改 env 注入，红线 upheld）。

## 已知边界与限制（明示）

- **技术详情可回看窗口 = 页面存活期**：BFF 历史只落 answer_md，SQL 仅存在于 live SSE——终态后刷新即不可回看（与改造前一致；不改协议不解决）
- 非 admin 无 SQL/工具/tokens 渲染路径（review+实弹双确认）；任务级总耗时对全员可见（MED 裁定，可一行收紧）
- Chrome 离线仿真不拆存量 SSE 长连接——自动断线实测受限（见上）；补测建议走 BFF 重启窗口

## 探针教训（沉淀）

- playwright `page.on("response")` 异步回调捕获不可靠——**runId 用 `waitForResponse` 阻塞等待**；BFF /api/ask 成功码是 **201** 不是 200
- 系统 Chrome `emulateNetworkConditions`/`setOffline` 对**已建立**的 SSE 长连接无效（只挡新请求）
- chat 页滚动在内层容器：fullPage 截图不含内层折叠线以下内容——过程面板取证用 DOM 断言优于截图
