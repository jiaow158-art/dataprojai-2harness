# SCH-1 Scheduler 首轮全自动运行验收报告（2026-10-10）

切换背景：2026-10-09 完成 Shadow→核对→旧 pm2 cron 退役→live 四步切换（见
`2026-10-09-sch-1-report.md`）。**本日为首个零人工干预的全自动调度日**，两跳均由
insight-scheduler 真实 cron 触发（非对账补跑、非手动）。数据源：insight.db 直查
（pipeline_run / radar_run / daily_brief / daily_brief_event / business_event /
event_analysis_run）+ pm2 进程面。

## 一、总体结论

| 跳 | 时刻 | 结果 | 耗时 |
|---|---|---|---|
| daily（09:05 主跑） | 09:05:00 准点触发 | `succeeded` | 47s（09:05:00 → 09:05:47） |
| attribution_second（10:05 二发） | 10:05:00 准点触发 | `succeeded` | 11m52s（10:05:00 → 10:16:52） |

- **无双跑**：进程面仅 `insight-scheduler`（旧 insight-worker/insight-worker-1005 已于
  10-09 退役，本日无复活）；每跳恰一条 pipeline_run（slot 去重键生效，retry_count=0）
- **执行锁**：两跳用后释放，无残留；心跳至各跳结束时刻
- **失败/重试**：0

## 二、09:05 daily 主跑明细（run_id pr-7ab6c471…）

**Watermark 就绪探针**（data_date=2026-10-09）——四雷达全部 ready：

| 雷达 | 依赖 effective date | 就绪 |
|---|---|---|
| region_sales | ok:2026-10-09（日表） | ✓ |
| gross_margin | ok:2026-10-09（日表） | ✓ |
| target | ok:2026-10-09（mix 日口径）+ ok:2026-10-01（目标月表） | ✓ |
| ar_risk | ok:2026-10-01（**月表口径**：应收底表按月开账，effective=月初快照，10 月账已开即 ready） | ✓ |

**雷达状态**（radar_run，data_date=2026-10-09）：四雷达全 `ran`，findings
region_sales 3 / gross_margin 2 / target 1 / ar_risk 0（合计 6 条进入合并排名）。

**发布**：`daily_brief(2026-10-10) = final`，**published_at = 09:05:47**（freeze 完成即
发布——首-final-wins 语义；名义 09:30 无硬门控，实际发布时刻=主跑执行时长偏移 +47s）。

**榜单 Top3（发布快照，冻结不改写）**：
1. 目标达成低于时间进度（ev-f31805a5958a）
2. 华东运营中心|GD01 业绩连续下滑（ev-c6ab9e6c8712）
3. 粤东运营中心|GD03 业绩连续下滑（ev-9ca2524b595b）

**归因**：09:05 在 10:00-14:00 窗口外，按门控空过（done:0）——设计行为。

## 三、10:05 归因二发明细（run_id pr-04f62d01…）

- 雷达四跳全部 `already-ran` 幂等跳过（同日重跑去重，零重复 SQL）
- **归因 3/3 done、0 failed**，与当日榜单 Top3 一一对应：

| 事件 | 状态 | 完成时刻 |
|---|---|---|
| 目标达成低于时间进度 | done | 10:08:56 |
| 华东 GD01 业绩连续下滑 | done | 10:13:10 |
| 粤东 GD03 业绩连续下滑 | done | 10:16:52 |

- 网关幂等键 `event_id:analysis_date` 在位；`business_event.attribution_status` 三事件
  均回填 done

## 四、观察项（如实记录，非缺陷）

1. `radar_run.started_at/finished_at` 为 0——insert_radar_run 未填时刻（既有行为，
   pipeline_run 侧时刻完整；如需雷达级耗时再补）
2. `event_analysis_run.submitted_at == finished_at`（同秒）——归因为同步等待型，
   落库时一次写入两时刻；逐事件实际间隔（10:08→10:13→10:16）反映真实执行节奏
3. ar_risk watermark 显示 10-01 系月表口径（10 月账已开），非数据滞后

## 五、验收判定

**通过**。SCH-1 调度服务化在生产完成首个全自动双跳日：准点触发、就绪探针全绿、
雷达全跑、榜单准点发布（09:05:47）、归因窗口内 3/3 完成、零双跑、零重试、零人工。
后续无需逐日照看——异常态（failed/partial/not_ready）会直接呈现在管理后台「数据更新」页。
