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
"""


def open_db(path: str | Path) -> sqlite3.Connection:
    """打开/初始化 insight.db（WAL）。调用方保证路径在 Temp 树外（spec §19）。"""
    p = Path(path); p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(p)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    # SCHEMA 保持 spec §6.1 逐字（供 diff 审）；幂等性在执行层转换，不改 SCHEMA 本身
    conn.executescript(SCHEMA.replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS "))
    conn.executescript('''CREATE TABLE IF NOT EXISTS insight_subscription (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, label TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(user_id,kind,value)); CREATE TABLE IF NOT EXISTS insight_notification (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, event_id TEXT, kind TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL, severity TEXT, created_at TEXT NOT NULL, read_at TEXT, UNIQUE(user_id,event_id,kind));''')
    return conn
