"""insight.db 连接与 schema（spec 2026-09-23 §6.1 逐字转录）。"""
import sqlite3
from pathlib import Path

SCHEMA = """
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
  threshold_passed INTEGER NOT NULL, is_late INTEGER NOT NULL DEFAULT 0,  -- P0-3：09:30 cutoff 后到达=晚到发现
  merged_into_event_id TEXT, created_at INTEGER);

-- 经营事件（一等实体；P0-1：event_key=业务问题身份，event_id=episode）
CREATE TABLE business_event (
  event_id TEXT PRIMARY KEY,        -- episode 身份：ev-<uuid>（新发时生成；恢复后再发=新 episode）
  event_key TEXT NOT NULL,          -- 稳定锚点身份：hash(scope+anchor_type+anchor_id)——不含日期/detector/event_type（v1.2：主雷达变更不漂移）
  lifecycle TEXT NOT NULL,          -- active|resolved（底层生命周期）
  data_date TEXT NOT NULL,          -- episode 内最近检测日
  first_seen_date TEXT NOT NULL, last_seen_date TEXT NOT NULL,
  persist_days INTEGER NOT NULL, resolved_at INTEGER,
  detector TEXT NOT NULL,           -- 主发现雷达；facet_json 记其余雷达命中
  event_type TEXT NOT NULL,         -- sales_decline|margin_drop|ar_overdue|target_gap
  title TEXT NOT NULL,              -- 人话标题："华南零售销售连续下滑"（禁 detector 名）
  summary TEXT NOT NULL,            -- 一句话摘要（检测层数据生成，非 LLM）
  severity TEXT NOT NULL,           -- major|minor（P1-2：severity 独立于 event_type，可扩展）
  scope_json TEXT NOT NULL,         -- {范围:"瓷砖事业部", 组织节点, 渠道}
  period_json TEXT NOT NULL,        -- {类型:周|月, 起, 止}
  facts_json TEXT NOT NULL,         -- [{label:"华南零售同比", value:"-11.2%", …}]（只放事实）
  score REAL NOT NULL, score_breakdown_json TEXT NOT NULL,  -- 五因子分项（"为什么推给我"）
  metric TEXT NOT NULL,             -- 主指标名
  status TEXT NOT NULL,             -- discovered|analyzed（v1 只实现这两个；其余预留）
  facet_json TEXT, merged_from_json TEXT,
  -- 归因（10:00 后回填；此处仅存"当前最新"，逐次历史版本见 event_analysis_run）
  attribution_status TEXT NOT NULL DEFAULT 'pending',  -- pending|running|done|degraded|failed
  attribution_summary TEXT,         -- 执行摘要（LLM 产，源自网关 answer）
  attribution_json TEXT,            -- {path[], findings[], waterfall, entities}（尽力解析）
  attribution_run_id TEXT,          -- 网关 run_id（溯源+报告链接）
  attribution_generated_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_key_active ON business_event(event_key) WHERE lifecycle = 'active'; -- v1.2：partial unique index，数据库层保证同 key 至多一个 active episode

-- 证据（365d：行留存；90d：result_ref 指向的文件由 retention 清）
CREATE TABLE event_evidence (
  evidence_id TEXT PRIMARY KEY, event_id TEXT NOT NULL,
  kind TEXT NOT NULL,               -- sql|result|watermark|attribution_raw
  sql_text TEXT, result_ref TEXT, note TEXT, created_at INTEGER);

-- 归因历史版本（v1.2：business_event 只存当前最新，逐次分析在此留档可回看）
CREATE TABLE event_analysis_run (
  analysis_id TEXT PRIMARY KEY,     -- an-<uuid>
  event_id TEXT NOT NULL,           -- episode
  analysis_date TEXT NOT NULL,      -- 触发日（= brief_date）
  gateway_run_id TEXT, status TEXT NOT NULL,  -- done|degraded|failed（v1.2.2 勘误 2026-09-29：持久化三态；submitted/succeeded 为传输态永不落库，网关 EOF-无 done/cancelled 等非常规终态一律归一 failed）
  answer_md TEXT, report_path TEXT,
  parsed_json TEXT,                 -- schema 校验通过的结构化产物；校验失败为 NULL（降级态）
  submitted_at INTEGER, finished_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_analysis_event ON event_analysis_run(event_id, analysis_date);

-- 每日简报（P1-3：brief_date=发布日；各雷达真实数据日期在 freshness_json 的 effective_data_date）
CREATE TABLE daily_brief (
  brief_date TEXT PRIMARY KEY, scope TEXT NOT NULL,
  status TEXT NOT NULL,             -- assembling|final|not_ready|stale
  cutoff_at INTEGER, published_at INTEGER,
  event_count INTEGER, freshness_json TEXT,  -- 各雷达 {detector, ready, effective_data_date, watermark, checked_at}
  attribution_started_at INTEGER);

-- 每日发布快照（P0-2：历史简报可精确还原"某天高管实际看到的 Top 事件及当时数据"——
-- business_event 可持续演进，但历史简报绝不因事件后续更新被覆盖）
CREATE TABLE daily_brief_event (
  brief_date TEXT NOT NULL, event_id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  score_snapshot REAL NOT NULL, severity_snapshot TEXT NOT NULL,
  title_snapshot TEXT NOT NULL, summary_snapshot TEXT NOT NULL,
  facts_snapshot TEXT NOT NULL,
  event_type_snapshot TEXT NOT NULL,          -- v1.2：当天状态一并冻结
  persist_days_snapshot INTEGER NOT NULL, first_seen_date_snapshot TEXT NOT NULL,
  lifecycle_snapshot TEXT NOT NULL,           -- 发布时恒为 active（写入时冻结，防漂移）
  published_at INTEGER NOT NULL,
  PRIMARY KEY (brief_date, event_id));

-- followup 审计
CREATE TABLE followup_session (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL, username TEXT NOT NULL,
  ui_session_id TEXT NOT NULL, gateway_session_id TEXT, created_at INTEGER);

-- SCH-1（2026-10-09）调度服务化三表 ------------------------------------------------
-- ① 流水线运行记录：调度/人工/重试统一记账（触发去重唯一键只管调度面，执行互斥见 pipeline_lock）
CREATE TABLE pipeline_run (
  run_id TEXT PRIMARY KEY,                 -- pr-<uuid>
  job_type TEXT NOT NULL,                  -- daily | attribution_second | manual_rerun | prewarm_target | prewarm_region | cache_invalidate | reconciliation
  phase TEXT NOT NULL,                     -- pipeline | scan | freeze | attribution | prewarm | invalidate（v1 worker 无 phase 拆分，记 pipeline）
  brief_date TEXT, as_of_date TEXT,
  scheduled_at INTEGER, started_at INTEGER, finished_at INTEGER,
  status TEXT NOT NULL,                    -- queued|running|succeeded|partial|not_ready|failed|skipped|shadow
  watermark_json TEXT, radar_status_json TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0, error_message TEXT,
  trigger_type TEXT NOT NULL,              -- scheduled | manual | retry | shadow
  triggered_by TEXT, heartbeat_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_pipeline_run_day ON pipeline_run(brief_date, job_type);
-- 调度触发去重（修正A：仅去重，非互斥锁）
CREATE UNIQUE INDEX IF NOT EXISTS uq_pipeline_fire ON pipeline_run(job_type, phase, scheduled_at);

-- ② 执行互斥锁（单例）：定时/人工/重试共用；原子抢占+心跳+过期 CAS 夺回（修正A）
CREATE TABLE pipeline_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  holder TEXT NOT NULL,                    -- <hostname>:<pid>:<uuid>
  acquired_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL,
  brief_date TEXT);

-- ③ 跨进程手动触发队列（修正B）：admin→BFF→insight-api 入队，scheduler 原子领取执行
CREATE TABLE trigger_queue (
  request_id TEXT PRIMARY KEY,             -- rq-<uuid>
  action TEXT NOT NULL,                    -- daily_run | prewarm_target | prewarm_region | cache_invalidate
  brief_date TEXT,                         -- daily_run 限定今日/昨日（修正E：只暴露真实安全能力）
  requested_by TEXT NOT NULL, requested_at INTEGER NOT NULL,
  claimed_at INTEGER, claimed_by TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | claimed | done | failed | rejected
  result_run_id TEXT, note TEXT);
CREATE INDEX IF NOT EXISTS idx_trigger_pending ON trigger_queue(status, requested_at);

-- ④ scheduler 状态广播（管理后台读：mode/next_fire/pid——api 与 scheduler 分进程）
CREATE TABLE scheduler_state (
  k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at INTEGER NOT NULL);
"""


def open_db(path: str | Path, *, check_same_thread: bool = True) -> sqlite3.Connection:
    """打开/初始化 insight.db（WAL）。调用方保证路径在 Temp 树外（spec §19）。
    check_same_thread=False 供常驻多线程方（SCH-1 scheduler：job/poll/心跳/广播线程
    共用一条连接，短事务经 sqlite3 模块级串行化）。"""
    p = Path(path); p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(p, check_same_thread=check_same_thread)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")   # SCH-1：跨进程（scheduler/api/worker）写碰撞等待
    # SCHEMA 保持 spec §6.1 逐字（供 diff 审）；幂等性在执行层转换，不改 SCHEMA 本身
    conn.executescript(SCHEMA.replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS "))
    conn.executescript('''CREATE TABLE IF NOT EXISTS insight_subscription (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, label TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(user_id,kind,value)); CREATE TABLE IF NOT EXISTS insight_notification (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, event_id TEXT, kind TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL, severity TEXT, created_at TEXT NOT NULL, read_at TEXT, UNIQUE(user_id,event_id,kind));''')
    return conn
