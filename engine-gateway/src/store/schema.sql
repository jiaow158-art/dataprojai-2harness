CREATE TABLE IF NOT EXISTS tasks (
  run_id TEXT PRIMARY KEY,             -- 任务ID（服务端生成）
  client_submission_id TEXT,           -- 幂等键（可空）
  session_id TEXT NOT NULL,            -- 逻辑对话（spec D14 三层模型）
  user TEXT NOT NULL, scope_group TEXT NOT NULL DEFAULT 'default',
  question TEXT NOT NULL,
  status TEXT NOT NULL,                -- queued|running|succeeded|failed|cancelled
  stage TEXT,                          -- queued|analyzing|querying|script_running|report_checking|repairing|publishing
  attempt INTEGER NOT NULL DEFAULT 0,  -- 执行尝试编号（D15 接管规则）
  lease_owner TEXT, lease_expires_at INTEGER,  -- 执行租约（A.1：owner+attempt 围栏）
  cancel_requested INTEGER NOT NULL DEFAULT 0, -- 取消标志（A.3：无执行权者只置标志）
  deadline INTEGER,                    -- created_at+TASK_BUDGET_S，首次 claim 固化（A.4）
  error_code TEXT, error_message TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(client_submission_id)
);
CREATE TABLE IF NOT EXISTS events (    -- 事件重放日志（递增编号，SSE 断线续传）
  run_id TEXT NOT NULL, seq INTEGER NOT NULL,
  type TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(run_id, seq)
);
CREATE TABLE IF NOT EXISTS publications (  -- 报告发布记录（恢复先查，防重复发布）
  run_id TEXT PRIMARY KEY, report_path TEXT NOT NULL, published_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cleanup_reports (  -- 每 attempt 一份最终权威清理报告（C2-B2）
  -- 同一 attempt 的中间 pending/failed 清理尝试属于 CleanupAuditLog 的追加事件历史，
  -- 不写入本表；新 attempt 另起一行。主键同时防止旧 attempt 覆盖新 attempt。
  run_id TEXT NOT NULL, attempt INTEGER NOT NULL,
  cleanup_id TEXT NOT NULL, trigger TEXT NOT NULL, platform TEXT NOT NULL,
  sealed INTEGER NOT NULL,      -- 1=sealTaskCleanupReport 成功；0=失败标记
  overall_ok INTEGER NOT NULL,  -- 仅表示清理通过，不代表任务成功；sealed=0 时必为 0
  report_json TEXT,             -- sealed 报告 JSON；sealed=0 时必须为 NULL
  error_code TEXT, created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, attempt),
  CHECK (sealed IN (0, 1)),
  CHECK (overall_ok IN (0, 1)),
  CHECK ((sealed = 1 AND report_json IS NOT NULL) OR
         (sealed = 0 AND report_json IS NULL AND overall_ok = 0))
);
CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
