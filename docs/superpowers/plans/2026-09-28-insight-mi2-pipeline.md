# AI 经营助手 v1 · M-i2 管道与 API 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 M-i1 的四雷达检测结果变成完整管道——事件合并与五因子排序（episode 生命周期）→ 09:30 freeze 发布快照 → 10:00 归因（网关 API + 结构化 JSON）→ insight-api 只读服务，全链路落 insight.db。

**Architecture:** 纯增新增四个模块（store/merge_rank/brief/attribution）+ 两个进程入口（worker_main/api_main），全部复用 M-i1 的 detectors/replay_ctx/watermark/dws。worker 是薄编排层（可注入时钟/runner 测试）；api 用 stdlib http.server（环境无 fastapi/flask，零新依赖，D6 契约不变——spec §4 的 FastAPI 描述在此勘误为 stdlib）。

**Tech Stack:** Python 3.12 stdlib（sqlite3/http.server/hashlib/uuid）+ psycopg2（已有）+ pytest。

**Spec:** `docs/superpowers/specs/2026-09-23-ai-business-assistant-v1-design.md`（v1.2+ar 换源裁定）；M-i1 已关门（`docs/superpowers/reports/2026-09-28-mi1-backtest-calibration.md`，阈值=灰度基线）。

---

## 前置事实（工程师必读）

1. **现有 insight/ 模块接口**（M-i1 落地，勿改）：`detectors.REGISTRY`（4 雷达，`detect(run, ctx)->DetectResult{status,note,findings}`，`check_watermark(run,ctx)->[WatermarkResult{ready,reason,detail,effective_data_date,rows}]`）；`Finding{detector,data_date,dim_keys{anchor_type,anchor_id,channel},metrics,norm_score,threshold_passed,is_late,facets}`；`replay_ctx.ReplayContext(as_of)`；`dws.DwsQueryRunner(app_name,timeout_ms)`；`db.open_db(path)`（WAL，schema 已含全部八表+两索引）。
2. **网关归因通道契约**（实码核对）：`POST {GW_URL}/api/tasks`，headers `Authorization: Bearer <GW_AUTH_TOKEN>` + `X-User: insight-svc`，body `{"question": "..."}` → 201 `{"run_id","session_id"}`；**答案不在 GET task 里**（GET /api/tasks/:id 只回 status/stage/error_code）——**必须消费 SSE**：`GET /api/tasks/:run_id/events`（同 headers），事件类型 `stage`/`sql`/`answer`(payload.markdown)/`report`(payload.path)/`error`/`done`(payload.status)。参考实码：`engine-gateway/scripts/ask.py:67-114`。
3. **调度纪律**（spec §10/§14）：就绪驱动（探针过了才扫）、四雷达串行、每雷达用自己的 `cfg["timeout_ms"]` 建 runner（M-i1 遗留接线）、09:30 freeze、晚到标 `is_late` 不重洗、10:00 归因只跑上榜 Top≤3、失败重试至 14:00。
4. **五因子 v1 启发式**（全部取自 finding 自身、可解释；ranking.json 可调，改动走回测台账）：impact=norm_score；target_gap 仅 target 雷达有值 `min(100,|gap_pct|×4)` 其余 N/A；persistence=`min(100, persist_days×20)`；scope=anchor 层级（事业部级 100/org_channel 60/customer 40）；worsening=新发 100 / 2-7 天 60 / >7 天 30。**N/A 因子不计 0 分，按剩余权重再归一化**（spec D3）。applicable_factors 与 metrics 数据可得性取交集（region/margin config 声明 target_gap 但无数据 → N/A，诚实处理）。
5. **anchor config 消费**（M-i1 遗留）：merge 时校验 `cfg["anchor"]["type"]` 与 finding `dim_keys["anchor_type"]` 一致，不一致记 note 不炸（防御性）。
6. **红线**：路径限定提交；密钥只走 env（GW_AUTH_TOKEN 等）；api 只读（sqlite `mode=ro`）；engine-gateway/skills/现有 chat 零改动。

## File Structure（本计划新增/修改全集）

```
insight/
├─ store.py            # 新：insight.db 全部写入/读取（radar_run/detector_finding/business_event/
│                      #    daily_brief/daily_brief_event/event_analysis_run）
├─ merge_rank.py       # 新：event_key/episode 生命周期/五因子/合并/Top0-3（纯逻辑+db 落库）
├─ brief.py            # 新：09:30 freeze/发布快照/晚到处理
├─ attribution.py      # 新：prompt/SSE 客户端/JSON 提取校验/降级/版本留档
├─ worker_main.py      # 新：日编排入口（pm2）——薄层，核心逻辑全在被测模块
├─ api_main.py         # 新：stdlib 只读 HTTP (:58095, env INSIGHT_PORT)
├─ config/ranking.json # 新：五因子权重/发布门槛/severity/lifecycle 参数
└─ tests/ test_store.py test_merge_rank.py test_brief.py test_attribution.py
        test_worker.py test_api.py
修改：insight/BACKTEST_RUNBOOK.md 不动；不修改任何 M-i1 既有文件（api_main 自带只读连接，不动 db.py）
```

---

### Task 1: ranking.json + store.py 落库层

**Files:** Create `insight/config/ranking.json`、`insight/store.py`；Test `insight/tests/test_store.py`

- [ ] **Step 1: 写失败测试**

```python
# insight/tests/test_store.py
import sqlite3
from datetime import date
from insight.db import open_db
from insight.store import Store

def _store(tmp_path):
    return Store(open_db(tmp_path / "insight.db"))

def test_radar_run_roundtrip_with_watermark_detail(tmp_path):
    s = _store(tmp_path)
    run_id = s.insert_radar_run(detector="ar_risk", data_date="2026-09-27",
                                status="ran", findings_count=2,
                                watermark_detail="ready; effective=2026-09-27")
    row = s.db.execute("SELECT * FROM radar_run WHERE run_id=?", (run_id,)).fetchone()
    assert row["detector"] == "ar_risk" and row["error"] == "ready; effective=2026-09-27"

def test_insert_finding_and_late_flag(tmp_path):
    s = _store(tmp_path)
    fid = s.insert_finding(data_date="2026-09-27", detector="region_sales",
                           dim_keys={"anchor_type": "org_channel",
                                     "anchor_id": "华南|GD01", "channel": "GD01"},
                           metrics={"yoy_pct": -11.2}, norm_score=80, is_late=False)
    s.insert_finding(data_date="2026-09-27", detector="region_sales",
                     dim_keys={"anchor_type": "org_channel",
                               "anchor_id": "华南|GD01", "channel": "GD01"},
                     metrics={"yoy_pct": -11.5}, norm_score=85, is_late=True)
    rows = s.db.execute(
        "SELECT is_late, metrics_json FROM detector_finding "
        "WHERE data_date='2026-09-27' ORDER BY rowid").fetchall()
    assert rows[0]["is_late"] == 0 and rows[1]["is_late"] == 1

def test_findings_for_date_excludes_late(tmp_path):
    s = _store(tmp_path)
    s.insert_finding("2026-09-27", "region_sales",
                     {"anchor_type": "org_channel", "anchor_id": "A|GD01", "channel": "GD01"},
                     {"yoy_pct": -11.2}, 80, is_late=False)
    s.insert_finding("2026-09-27", "gross_margin",
                     {"anchor_type": "org_channel", "anchor_id": "B|GD02", "channel": "GD02"},
                     {"delta_pct": -2.5}, 60, is_late=True)
    got = s.findings_for_date("2026-09-27")          # freeze 用：不含晚到
    assert [f["detector"] for f in got] == ["region_sales"]
    got_all = s.findings_for_date("2026-09-27", include_late=True)   # 事件延续用
    assert len(got_all) == 2

def test_active_episode_lookup(tmp_path):
    s = _store(tmp_path)
    s.upsert_episode(event_key="K1", event_id="ev-1", data_date="2026-09-25",
                     detector="region_sales", event_type="sales_decline",
                     title="t", summary="s", severity="minor",
                     scope={"范围": "瓷砖事业部"}, period={"类型": "月"},
                     facts=[], score=60.0, breakdown={}, metric="yoy",
                     dim_keys={"anchor_type": "org_channel", "anchor_id": "A|GD01",
                               "channel": "GD01"})
    ep = s.active_episode("K1")
    assert ep["event_id"] == "ev-1" and ep["lifecycle"] == "active"
    assert s.active_episode("K-nope") is None
```

- [ ] **Step 2: 确认失败** `python -m pytest insight/tests/test_store.py -v` → FAIL（无模块）

- [ ] **Step 3: 实现**

```json
// insight/config/ranking.json
{
  "weights": {"impact": 0.30, "target_gap": 0.25, "persistence": 0.20,
              "scope": 0.15, "worsening": 0.10},
  "publish_min_score": 55,
  "top_n": 3,
  "severity_bands": {"major": 75},
  "scope_factor": {"bu_level": 100, "org_channel": 60, "customer": 40},
  "persistence_full_days": 5,
  "worsening": {"new_day": 100, "days_2_7": 60, "days_gt_7": 30},
  "target_gap_scale": 4.0,
  "resolve_after_clean_days": 3,
  "notes": "v1 启发式（前置事实#4），灰度期可调但改动必须重跑回测并留台账（对齐 C2 精神）"
}
```

```python
# insight/store.py
"""insight.db 写入/读取层。Store 持有连接；所有 JSON 字段在这里序列化。"""
import json
import uuid
from . import db as _db

def _uid(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"

class Store:
    def __init__(self, conn):
        self.db = conn

    # —— radar_run / detector_finding ——
    def insert_radar_run(self, detector: str, data_date: str, status: str,
                         findings_count: int, watermark_detail: str = "",
                         started_at: int = 0, finished_at: int = 0) -> str:
        run_id = _uid("rr")
        self.db.execute(
            "INSERT INTO radar_run (run_id, data_date, detector, started_at, finished_at,"
            " status, watermark_json, findings_count, error) VALUES (?,?,?,?,?,?,?,?,?)",
            (run_id, data_date, detector, started_at, finished_at, status,
             json.dumps({"detail": watermark_detail}, ensure_ascii=False),
             findings_count, watermark_detail))
        self.db.commit()
        return run_id

    def insert_finding(self, data_date: str, detector: str, dim_keys: dict,
                       metrics: dict, norm_score: int, is_late: bool) -> str:
        fid = _uid("fd")
        self.db.execute(
            "INSERT INTO detector_finding (finding_id, data_date, detector, dim_keys_json,"
            " metrics_json, norm_score, threshold_passed, is_late, created_at)"
            " VALUES (?,?,?,?,?,?,1,?,strftime('%s','now'))",
            (fid, data_date, detector, json.dumps(dim_keys, ensure_ascii=False),
             json.dumps(metrics, ensure_ascii=False), norm_score, int(is_late)))
        self.db.commit()
        return fid

    def findings_for_date(self, data_date: str, include_late: bool = False) -> list[dict]:
        sql = ("SELECT * FROM detector_finding WHERE data_date=?")
        if not include_late:
            sql += " AND is_late=0"
        sql += " ORDER BY finding_id"
        rows = self.db.execute(sql, (data_date,)).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["dim_keys"] = json.loads(d["dim_keys_json"])
            d["metrics"] = json.loads(d["metrics_json"])
            out.append(d)
        return out

    # —— business_event（episode）——
    def active_episode(self, event_key: str):
        row = self.db.execute(
            "SELECT * FROM business_event WHERE event_key=? AND lifecycle='active'",
            (event_key,)).fetchone()
        return dict(row) if row else None

    def upsert_episode(self, event_key: str, event_id: str, data_date: str,
                       detector: str, event_type: str, title: str, summary: str,
                       severity: str, scope: dict, period: dict, facts: list,
                       score: float, breakdown: dict, metric: str, dim_keys: dict) -> str:
        self.db.execute(
            "INSERT OR REPLACE INTO business_event (event_id, event_key, lifecycle,"
            " data_date, first_seen_date, last_seen_date, persist_days, detector,"
            " event_type, title, summary, severity, scope_json, period_json, facts_json,"
            " score, score_breakdown_json, metric, status, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,strftime('%s','now'),strftime('%s','now'))",
            (event_id, event_key, "active", data_date,
             self._first_seen(event_key, event_id, data_date), data_date,
             self._persist_days(event_key, event_id, data_date),
             detector, event_type, title, summary, severity,
             json.dumps(scope, ensure_ascii=False), json.dumps(period, ensure_ascii=False),
             json.dumps(facts, ensure_ascii=False), score,
             json.dumps(breakdown, ensure_ascii=False), metric, "discovered", dim_keys and
             json.dumps(dim_keys, ensure_ascii=False)))
        self.db.commit()
        return event_id

    def _first_seen(self, event_key: str, event_id: str, data_date: str) -> str:
        row = self.db.execute("SELECT first_seen_date FROM business_event WHERE event_id=?",
                              (event_id,)).fetchone()
        return row["first_seen_date"] if row else data_date

    def _persist_days(self, event_key: str, event_id: str, data_date: str) -> int:
        row = self.db.execute("SELECT persist_days, first_seen_date FROM business_event"
                              " WHERE event_id=?", (event_id,)).fetchone()
        if not row:
            return 1
        # 跨日延续：persist_days+1；同日重跑：保持（幂等）
        row2 = self.db.execute("SELECT last_seen_date FROM business_event WHERE event_id=?",
                               (event_id,)).fetchone()
        if row2["last_seen_date"] == data_date:
            return row["persist_days"]
        return row["persist_days"] + 1

    def open_episodes_excluding(self, keys: set[str], data_date: str) -> list[dict]:
        rows = self.db.execute(
            "SELECT * FROM business_event WHERE lifecycle='active'").fetchall()
        return [dict(r) for r in rows if r["event_key"] not in keys]

    def resolve_episode(self, event_id: str, resolved_at_day: str):
        self.db.execute(
            "UPDATE business_event SET lifecycle='resolved', resolved_at=?,"
            " updated_at=strftime('%s','now') WHERE event_id=?",
            (resolved_at_day, event_id))
        self.db.commit()
```

- [ ] **Step 4: 确认通过** → 4 PASS；全套 `python -m pytest insight/tests/ -v` 无回归
- [ ] **Step 5: Commit**
```bash
git add insight/store.py insight/config/ranking.json insight/tests/test_store.py
git commit -m "feat(insight): store落库层+ranking配置——radar_run含watermark detail/finding含late位/episode读写" -- insight/store.py insight/config/ranking.json insight/tests/test_store.py
```

---

### Task 2: merge_rank.py —— 五因子评分与确定性排序

**Files:** Create `insight/merge_rank.py`；Test `insight/tests/test_merge_rank.py`

- [ ] **Step 1: 写失败测试**

```python
# insight/tests/test_merge_rank.py
from insight.merge_rank import event_key_of, factor_values, score_finding, rank_findings

def _finding(detector="region_sales", norm=80, anchor="华南|GD01",
             atype="org_channel", metrics=None, persist_days=1):
    return {"detector": detector, "norm_score": norm,
            "dim_keys": {"anchor_type": atype, "anchor_id": anchor, "channel": "GD01"},
            "metrics": metrics or {"yoy_pct": -11.2, "abs_delta_wan": 2375},
            "persist_days": persist_days}

def test_event_key_stable_no_date():
    k1 = event_key_of(_finding())
    k2 = event_key_of(_finding(anchor="华南|GD01"))          # 同锚同日不同日结果一致
    assert k1 == k2 and len(k1) == 16
    assert event_key_of(_finding(anchor="其他|GD01")) != k1

def test_factors_and_na_renormalization():
    # ar_risk 无 target_gap（applicable 交集）→ 四因子按 0.75 权重再归一
    f = _finding(detector="ar_risk", anchor="瓷砖|nat90", atype="customer",
                 metrics={"delta_wan": 3331}, persist_days=2)
    fv = factor_values(f)
    assert fv["target_gap"] is None                       # N/A 不计 0
    sc = score_finding(f)
    assert 0 <= sc["score"] <= 100
    assert abs(sum(w for k, w in sc["used_weights"].items())) > 0.99
    # impact=80/100, persistence=40, scope=40(customer), worsening=60
    expect = (0.30 * 80 + 0.20 * 40 + 0.15 * 40 + 0.10 * 60) / 0.75
    assert abs(sc["score"] - round(expect, 1)) < 0.6

def test_target_gap_factor_only_for_target_radar():
    f = _finding(detector="target", anchor="瓷砖事业部|ALL", atype="org_channel",
                 metrics={"gap_pct": -21.0}, persist_days=9)
    fv = factor_values(f)
    assert fv["target_gap"] == 84.0                        # min(100, 21*4)
    assert fv["scope"] == 100                              # 事业部级 ALL
    assert fv["worsening"] == 30                           # >7 天

def test_rank_deterministic_tiebreak():
    a = _finding(norm=100, anchor="B中心|GD01")
    b = _finding(norm=100, anchor="A中心|GD01")
    ranked = rank_findings([a, b])
    assert ranked[0][0]["dim_keys"]["anchor_id"] == "A中心|GD01"   # 并列按 anchor_id

def test_publish_gate_and_severity():
    low = _finding(norm=25, anchor="低|GD01", metrics={"yoy_pct": -8.1}, persist_days=1)
    ranked = rank_findings([low])
    assert ranked == []                                    # 低于门槛不上榜（返回前已过滤）
```

- [ ] **Step 2: 确认失败** → FAIL
- [ ] **Step 3: 实现**

```python
# insight/merge_rank.py
"""五因子评分与排序（spec §8 + D3：N/A 再归一化/可解释/确定性 tie-break）。

因子全部取自 finding 自身（前置事实#4 启发式），ranking.json 可调。"""
import hashlib
import json
from pathlib import Path

RANKING = json.loads((Path(__file__).parent / "config" / "ranking.json")
                     .read_text(encoding="utf-8"))

def event_key_of(finding: dict) -> str:
    dk = finding["dim_keys"]
    raw = "|".join(["瓷砖事业部", str(dk.get("anchor_type")),
                    str(dk.get("anchor_id"))])
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]

def _scope_factor(anchor_type: str, anchor_id: str) -> int:
    if anchor_id.endswith("|ALL") or "|nat90" in anchor_id:
        return RANKING["scope_factor"]["bu_level"]
    if anchor_type == "org_channel":
        return RANKING["scope_factor"]["org_channel"]
    return RANKING["scope_factor"]["customer"]

def factor_values(finding: dict) -> dict:
    m = finding.get("metrics", {})
    pd = finding.get("persist_days", 1)
    w = RANKING["worsening"]
    worsening = w["new_day"] if pd == 1 else (w["days_2_7"] if pd <= 7 else w["days_gt_7"])
    target_gap = None
    if finding["detector"] == "target" and m.get("gap_pct") is not None:
        target_gap = min(100.0, abs(m["gap_pct"]) * RANKING["target_gap_scale"])
    return {
        "impact": float(finding["norm_score"]),
        "target_gap": target_gap,
        "persistence": min(100.0, pd * (100 / RANKING["persistence_full_days"])),
        "scope": float(_scope_factor(finding["dim_keys"].get("anchor_type"),
                                     finding["dim_keys"].get("anchor_id", ""))),
        "worsening": float(worsening),
    }

def score_finding(finding: dict) -> dict:
    fv = factor_values(finding)
    num = den = 0.0
    used = {}
    for k, w in RANKING["weights"].items():
        v = fv[k]
        if v is None:                      # N/A 不计 0 分（裁定 D3/P1-1）
            continue
        num += w * v
        den += w
        used[k] = w
    score = round(num / den, 1) if den else 0.0
    return {"score": score, "breakdown": fv, "used_weights": used}

def rank_findings(findings: list[dict]) -> list[tuple[dict, dict]]:
    scored = [(f, score_finding(f)) for f in findings]
    scored = [(f, s) for f, s in scored
              if s["score"] >= RANKING["publish_min_score"]]
    scored.sort(key=lambda x: (-x[1]["score"],          # 分降序
                               x[0]["dim_keys"]["anchor_id"],   # 并列 tie-break（确定性）
                               x[0]["detector"]))               # 再并列按雷达名
    return scored[: RANKING["top_n"]]
```

- [ ] **Step 4: 确认通过** → 5 PASS；全套无回归
- [ ] **Step 5: Commit**
```bash
git add insight/merge_rank.py insight/tests/test_merge_rank.py
git commit -m "feat(insight): 五因子评分——N/A再归一化/可解释breakdown/发布门槛/并列anchor_id确定性tie-break" -- insight/merge_rank.py insight/tests/test_merge_rank.py
```

---

### Task 3: merge_rank.py —— episode 生命周期与合并落库

**Files:** Modify `insight/merge_rank.py`（追加）；Test `insight/tests/test_merge_rank.py`（追加）

- [ ] **Step 1: 写失败测试（追加）**

```python
# insight/tests/test_merge_rank.py（追加）
from insight.db import open_db
from insight.store import Store
from insight.merge_rank import update_episodes, TITLE_TEMPLATES

def _store(tmp_path):
    return Store(open_db(tmp_path / "i.db"))

def test_new_episode_then_continue_then_resolve(tmp_path):
    s = _store(tmp_path)
    # 第 1 日：新发
    ev1 = update_episodes(s, "2026-09-25", [_finding(anchor="华南|GD01")])
    assert len(ev1) == 1 and ev1[0]["persist_days"] == 1 and ev1[0]["lifecycle"] == "active"
    key = ev1[0]["event_key"]
    # 第 2 日：延续
    ev2 = update_episodes(s, "2026-09-26", [_finding(anchor="华南|GD01")])
    assert ev2[0]["event_id"] == ev1[0]["event_id"] and ev2[0]["persist_days"] == 2
    # 第 3-5 日无该锚 → resolve（clean 3 天）
    for d in ("2026-09-27", "2026-09-28", "2026-09-29"):
        update_episodes(s, d, [])
    resolved = s.db.execute("SELECT lifecycle FROM business_event WHERE event_key=?",
                            (key,)).fetchone()
    assert resolved["lifecycle"] == "resolved"
    # 第 6 日再发 → 新 episode（不复用）
    ev3 = update_episodes(s, "2026-09-30", [_finding(anchor="华南|GD01")])
    assert ev3[0]["event_id"] != ev1[0]["event_id"] and ev3[0]["persist_days"] == 1

def test_merge_same_anchor_two_radars(tmp_path):
    s = _store(tmp_path)
    f1 = _finding(detector="region_sales", anchor="华南|GD01", norm=85)
    f2 = _finding(detector="gross_margin", anchor="华南|GD01", norm=60,
                  metrics={"delta_pct": -3.0})
    # 同 anchor_id 不同 anchor_type 视为不同事件（org_channel vs bu 级）
    f2["dim_keys"] = {"anchor_type": "org_channel", "anchor_id": "华南|GD01",
                      "channel": "GD01"}
    evs = update_episodes(s, "2026-09-25", [f1, f2])
    assert len(evs) == 1                      # 同 event_key 合并：主发现=高分者
    assert evs[0]["detector"] == "region_sales"
    assert evs[0]["facets"]["gross_margin"] == {"delta_pct": -3.0}

def test_title_uses_template_not_detector_name():
    f = _finding(detector="region_sales", anchor="华南|GD01")
    t = TITLE_TEMPLATES["region_sales"](f)
    assert "华南|GD01" in t and "region_sales" not in t and "雷达" not in t
```

- [ ] **Step 2: 确认失败**（`-k episode` / `-k merge` / `-k title`）→ FAIL
- [ ] **Step 3: 实现（追加到 merge_rank.py）**

```python
# merge_rank.py（追加）
TITLE_TEMPLATES = {
    "region_sales": lambda f: f"{f['dim_keys']['anchor_id']} 业绩连续下滑",
    "gross_margin": lambda f: f"{f['dim_keys']['anchor_id']} 毛利率明显下降",
    "ar_risk": lambda f: "90天以上应收明显增加",
    "target": lambda f: "目标达成低于时间进度",
}

def _summary_of(f: dict) -> str:
    m = f.get("metrics", {})
    if f["detector"] == "region_sales":
        return f"近{m.get('consecutive', 3)}个完整月同比 {m.get('yoy_pct')}%"
    if f["detector"] == "gross_margin":
        return f"毛利率环比 {m.get('delta_pct')}pct（{m.get('gmp_pct')}%）"
    if f["detector"] == "ar_risk":
        return (f"自然账龄90+较上期增加 {m.get('delta_wan')} 万"
                f"（top5 集中 {m.get('top5_share_pct')}%）")
    return (f"达成率 {m.get('achieve_pct')}% 落后时间进度 {m.get('time_pct')}%"
            f"（差 {m.get('gap_pct')}pct）")

def _facts_of(f: dict) -> list[dict]:
    m = f.get("metrics", {})
    label = {"region_sales": "同比", "gross_margin": "毛利率变动",
             "ar_risk": "90+增量(万)", "target": "达成率"}[f["detector"]]
    val = m.get("yoy_pct", m.get("delta_pct", m.get("delta_wan", m.get("achieve_pct"))))
    return [{"label": label, "value": str(val)}]

def update_episodes(store, data_date: str, findings: list[dict]) -> list[dict]:
    """按 event_key 分组合并→延续/新建 episode→未延续者推进 clean 计数→resolve。

    返回当日活跃 episode 视图（含 facets/persist_days），供 ranking 使用。
    主发现 = 组内 norm_score 最高（并列按 detector 名，确定性）。"""
    by_key: dict[str, list[dict]] = {}
    for f in findings:
        by_key.setdefault(event_key_of(f), []).append(f)
    touched_ids = []
    out = []
    for key, group in by_key.items():
        group.sort(key=lambda f: (-f["norm_score"], f["detector"]))
        primary, facets_raw = group[0], group[1:]
        ep = store.active_episode(key)
        persist = (ep["persist_days"] + 1) if ep else 1
        fdict = {g["detector"]: g.get("metrics", {}) for g in facets_raw}
        sc = score_finding({**primary, "persist_days": persist})
        severity = "major" if sc["score"] >= RANKING["severity_bands"]["major"] else "minor"
        event_id = ep["event_id"] if ep else f"ev-{uuid.uuid4().hex[:12]}"
        store.upsert_episode(
            event_key=key, event_id=event_id, data_date=data_date,
            detector=primary["detector"],
            event_type={"region_sales": "sales_decline", "gross_margin": "margin_drop",
                        "ar_risk": "ar_overdue", "target": "target_gap"}[primary["detector"]],
            title=TITLE_TEMPLATES[primary["detector"]](primary),
            summary=_summary_of(primary), severity=severity,
            scope={"范围": "瓷砖事业部", "组织节点": primary["dim_keys"]["anchor_id"],
                   "渠道": primary["dim_keys"].get("channel")},
            period={"类型": "月"}, facts=_facts_of(primary),
            score=sc["score"], breakdown={"factors": sc["breakdown"],
                                          "weights": sc["used_weights"]},
            metric={"region_sales": "yoy", "gross_margin": "gmp",
                    "ar_risk": "nat90", "target": "achieve"}[primary["detector"]],
            dim_keys=primary["dim_keys"])
        touched_ids.append(event_id)
        out.append({"event_key": key, "event_id": event_id, "persist_days": persist,
                    "detector": primary["detector"], "lifecycle": "active",
                    "facets": fdict})
    # 未被今日 findings 触达的 active episode → 连续 clean N 天则 resolve
    for other in store.open_episodes_excluding(set(by_key.keys()), data_date):
        last = other["last_seen_date"]
        if _days_between(last, data_date) >= RANKING["resolve_after_clean_days"]:
            store.resolve_episode(other["event_id"], data_date)
    return out

def _days_between(d1: str, d2: str) -> int:
    from datetime import date
    a = date.fromisoformat(d1)
    b = date.fromisoformat(d2)
    return (b - a).days
```

（`uuid` 已在 store.py 导入；merge_rank.py 顶部补 `import uuid`。）

- [ ] **Step 4: 确认通过** → 8 PASS；全套无回归
- [ ] **Step 5: Commit**
```bash
git add insight/merge_rank.py insight/tests/test_merge_rank.py
git commit -m "feat(insight): episode生命周期——event_key合并主发现高分者/延续persist+1/clean3天resolve/恢复再发新episode/人话标题禁雷达名" -- insight/merge_rank.py insight/tests/test_merge_rank.py
```

---

### Task 4: brief.py —— 09:30 freeze 与发布快照

**Files:** Create `insight/brief.py`；Test `insight/tests/test_brief.py`

- [ ] **Step 1: 写失败测试**

```python
# insight/tests/test_brief.py
from insight.db import open_db
from insight.store import Store
from insight.brief import freeze_brief

def _seed(tmp_path, findings, data_date="2026-09-27"):
    s = Store(open_db(tmp_path / "i.db"))
    for f in findings:
        s.insert_finding(data_date, f["detector"], f["dim_keys"],
                         f.get("metrics", {"yoy_pct": -11.2}), f["norm_score"],
                         is_late=f.get("is_late", False))
    return s

_FI = {"detector": "region_sales", "norm_score": 85,
       "dim_keys": {"anchor_type": "org_channel", "anchor_id": "华南|GD01",
                    "channel": "GD01"}, "metrics": {"yoy_pct": -11.2}}

def test_freeze_writes_brief_and_snapshots(tmp_path):
    s = _seed(tmp_path, [_FI])
    out = freeze_brief(s, brief_date="2026-09-28", data_date="2026-09-27",
                       freshness=[{"detector": "region_sales", "ready": True,
                                   "effective_data_date": "2026-09-27",
                                   "checked_at": "2026-09-28T09:00:00"}])
    assert out["status"] == "final" and out["event_count"] == 1
    brief = s.db.execute("SELECT * FROM daily_brief WHERE brief_date='2026-09-28'").fetchone()
    assert brief["status"] == "final"
    snap = s.db.execute("SELECT * FROM daily_brief_event").fetchone()
    assert snap["rank"] == 1 and snap["event_type_snapshot"] == "sales_decline"
    assert snap["persist_days_snapshot"] == 1 and snap["lifecycle_snapshot"] == "active"

def test_late_finding_not_in_snapshot_but_episode_continues(tmp_path):
    late = {**_FI, "is_late": True, "norm_score": 90}
    s = _seed(tmp_path, [late])
    out = freeze_brief(s, "2026-09-28", "2026-09-27", [])
    assert out["event_count"] == 0                       # 晚到不进当日榜（P0-3）
    rows = s.db.execute("SELECT COUNT(*) c FROM daily_brief_event").fetchone()
    assert rows["c"] == 0

def test_freeze_idempotent_same_day_rerun(tmp_path):
    s = _seed(tmp_path, [_FI])
    freeze_brief(s, "2026-09-28", "2026-09-27", [])
    freeze_brief(s, "2026-09-28", "2026-09-27", [])      # 重跑不翻倍不洗牌
    rows = s.db.execute("SELECT COUNT(*) c FROM daily_brief_event").fetchone()
    assert rows["c"] == 1

def test_not_ready_when_no_radar_ready(tmp_path):
    s = _seed(tmp_path, [_FI])
    out = freeze_brief(s, "2026-09-28", "2026-09-27",
                       [{"detector": "region_sales", "ready": False}])
    assert out["status"] == "not_ready"                  # 数据未就绪≠无异常
```

- [ ] **Step 2: 确认失败** → FAIL
- [ ] **Step 3: 实现**

```python
# insight/brief.py
"""09:30 freeze：当日榜=当日非晚到 findings→episode→Top0-3 快照（P0-2/P0-3）。

- 晚到 finding 已由 store 标 is_late=1：不进当日榜，但 update_episodes 用
  include_late=True 的全集延续生命周期（事件连续性与 freeze 解耦）。
- 幂等：同 brief_date 重跑先删旧快照再写（重跑场景，不洗牌=同输入同输出）。"""
import json
from .merge_rank import update_episodes, rank_findings, event_key_of

def freeze_brief(store, brief_date: str, data_date: str, freshness: list[dict]) -> dict:
    if not freshness or not any(r.get("ready") for r in freshness):
        store.db.execute(
            "INSERT OR REPLACE INTO daily_brief (brief_date, scope, status, cutoff_at,"
            " published_at, event_count, freshness_json, attribution_started_at)"
            " VALUES (?,?,?,?,strftime('%s','now'),?,?,NULL)",
            (brief_date, "瓷砖事业部", "not_ready", None, 0,
             json.dumps({"radars": freshness}, ensure_ascii=False)))
        store.db.commit()
        return {"status": "not_ready", "event_count": 0}

    all_f = store.findings_for_date(data_date, include_late=True)      # 生命周期用全集
    episodes = update_episodes(store, data_date, all_f)
    persist_by_key = {e["event_key"]: e["persist_days"] for e in episodes}

    ranked = rank_findings([dict(f, persist_days=persist_by_key.get(event_key_of(f), 1))
                            for f in store.findings_for_date(data_date)])  # 榜单不含晚到

    store.db.execute("DELETE FROM daily_brief_event WHERE brief_date=?", (brief_date,))
    for rank_i, (f, sc) in enumerate(ranked, start=1):
        ep = next(e for e in episodes if e["event_key"] == event_key_of(f))
        row = store.db.execute("SELECT * FROM business_event WHERE event_id=?",
                               (ep["event_id"],)).fetchone()
        store.db.execute(
            "INSERT INTO daily_brief_event (brief_date, event_id, rank, score_snapshot,"
            " severity_snapshot, title_snapshot, summary_snapshot, facts_snapshot,"
            " event_type_snapshot, persist_days_snapshot, first_seen_date_snapshot,"
            " lifecycle_snapshot, published_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,strftime('%s','now'))",
            (brief_date, row["event_id"], rank_i, sc["score"], row["severity"],
             row["title"], row["summary"], row["facts_json"], row["event_type"],
             row["persist_days"], row["first_seen_date"], row["lifecycle"]))
    store.db.execute(
        "INSERT OR REPLACE INTO daily_brief (brief_date, scope, status, cutoff_at,"
        " published_at, event_count, freshness_json, attribution_started_at)"
        " VALUES (?,?,?,?,strftime('%s','now'),?,?,NULL)",
        (brief_date, "瓷砖事业部", "final", None, len(ranked),
         json.dumps({"radars": freshness}, ensure_ascii=False)))
    store.db.commit()
    return {"status": "final", "event_count": len(ranked),
            "events": [{"event_id": s2["event_id"], "rank": s2["rank"]}
                       for s2 in store.db.execute(
                           "SELECT event_id, rank FROM daily_brief_event"
                           " WHERE brief_date=? ORDER BY rank", (brief_date,)).fetchall()]}
```

- [ ] **Step 4: 确认通过** → 4 PASS；全套无回归
- [ ] **Step 5: Commit**
```bash
git add insight/brief.py insight/tests/test_brief.py
git commit -m "feat(insight): 09:30 freeze——Top0-3发布快照(全字段当日状态)/晚到不进榜但生命周期延续/未就绪诚实态/同日重跑幂等" -- insight/brief.py insight/tests/test_brief.py
```

---

### Task 5: attribution.py —— SSE 客户端与结构化 JSON 提取

**Files:** Create `insight/attribution.py`；Test `insight/tests/test_attribution.py`

- [ ] **Step 1: 写失败测试**

```python
# insight/tests/test_attribution.py
import json
import pytest
from insight.attribution import (build_prompt, parse_sse_stream,
                                 extract_structured, AttributionResult)

ANSWER_OK = """华南零售下滑主要来自广东区域（贡献约 61%）。

```json
{"summary": "华南零售下滑主要来自广东区域",
 "path": [{"level": "集团", "contribution": "-2.3pct"},
          {"level": "广东", "contribution": "-61%"}],
 "findings": [{"text": "广东贡献 61% 降幅", "evidence": "区域拆解查询结果"},
              {"text": "无证据条目应被剔除"}],
 "waterfall": [{"name": "去年同期", "value": 24680},
               {"name": "广东", "value": -2950}],
 "entities": [{"name": "佛山", "type": "city", "delta": "-9%"}]}
```"""

def test_build_prompt_carries_event_context_and_json_contract():
    p = build_prompt(title="华南零售销售连续下滑", summary="近3月同比 -11.2%",
                     metric="yoy", scope="瓷砖事业部/华南|GD01",
                     period="2026-06~2026-08", facts=[{"label": "同比", "value": "-11.2%"}],
                     detector="region_sales")
    assert "华南零售销售连续下滑" in p and "瓷砖事业部" in p
    assert "```json" in p and "summary" in p and "waterfall" in p   # JSON 契约在 prompt 里
    assert "dm_ar_analysis_rpt_f" not in p                          # ar 域才指向该表

def test_build_prompt_ar_hints_analysis_table():
    p = build_prompt(title="90天以上应收明显增加", summary="增 3331 万",
                     metric="nat90", scope="瓷砖事业部", period="2025-09~2025-10",
                     facts=[], detector="ar_risk")
    assert "dm_ar_analysis_rpt_f" in p                              # 归因弹药指向

_SSE = (
    "event: stage\ndata: {\"stage\":\"querying\"}\n\n"
    "event: answer\ndata: {\"markdown\":\"第一段\"}\n\n"
    "event: answer\ndata: {\"markdown\":\"" + ANSWER_OK.replace('"', '\\"') + "\"}\n\n"
    "event: report\ndata: {\"path\":\"/reports/r1.html\"}\n\n"
    "event: done\ndata: {\"status\":\"succeeded\",\"elapsed_ms\":61000}\n\n"
)

def test_parse_sse_stream_collects_answer_report_done():
    res = parse_sse_stream(iter(_SSE.splitlines()))
    assert isinstance(res, AttributionResult)
    assert res.status == "succeeded" and res.report_path == "/reports/r1.html"
    assert "广东" in res.answer_md

def test_extract_structured_ok_and_filters_unevidenced():
    res = parse_sse_stream(iter(_SSE.splitlines()))
    parsed = extract_structured(res.answer_md)
    assert parsed["summary"].startswith("华南零售")
    assert len(parsed["findings"]) == 1                    # 无 evidence 条目被剔除
    assert parsed["path"][0]["level"] == "集团"

def test_extract_structured_missing_block_degrades():
    parsed = extract_structured("没有 json 块的自然语言回答")
    assert parsed is None                                   # 严禁猜字段（P1-5）
```

- [ ] **Step 2: 确认失败** → FAIL
- [ ] **Step 3: 实现**

```python
# insight/attribution.py
"""归因管道：prompt 构造 → 网关提交/SSE 消费 → 结构化 JSON 提取校验 → 降级。

网关契约（前置事实#2）：POST /api/tasks 提交；答案/报告/SSE 在
GET /api/tasks/{run_id}/events（事件 stage/sql/answer/report/error/done）。
解析失败严禁从自然语言猜字段——直接降级（检测层事实+AI 原文+继续问AI）。"""
import json
import re
from dataclasses import dataclass, field

@dataclass
class AttributionResult:
    run_id: str = ""
    status: str = ""                     # submitted|succeeded|failed
    answer_md: str = ""
    report_path: str | None = None
    error_code: str = ""
    parsed: dict | None = None           # 结构化产物；降级为 None
    degraded_reason: str = ""

_JSON_BLOCK = re.compile(r"```json\s*(\{.*?\})\s*```", re.DOTALL)

def build_prompt(title: str, summary: str, metric: str, scope: str, period: str,
                 facts: list[dict], detector: str) -> str:
    ar_hint = ("\n归因查询提示：优先使用 dm.dm_ar_analysis_rpt_f（综合分析报表）的"
               "省/市/区、cust_risk_lev、proj_rcv_risk_lev、WBS、collection_rate 等"
               "字段做客户画像与区域归因。" if detector == "ar_risk" else "")
    facts_txt = "\n".join(f"- {f['label']}: {f['value']}" for f in facts) or "-（无）"
    return f"""你是经营分析助手。以下经营事件已由确定性检测确认，请按对应业务域的
标准分析工作流做下钻归因，所有结论必须出自你实际执行的查询结果。

【事件】{title}
【摘要】{summary}
【指标】{metric}
【范围】{scope}
【涉及期间】{period}
【已确认事实（检测层，可信）】
{facts_txt}{ar_hint}

回答要求：
1. 先给执行摘要（发生了什么、主要影响在哪、量级多少）。
2. 正文给出下钻路径（逐级贡献）、关键发现、重点影响对象。
3. **最后必须追加一个机器可读 JSON 代码块**（```json 包裹），schema：
{{"summary": str, "path": [{{"level": str, "contribution": str}}],
  "findings": [{{"text": str, "evidence": str}}],
  "waterfall": [{{"name": str, "value": number}}],
  "entities": [{{"name": str, "type": str, "delta": str}}]}}
findings 每条必须带 evidence（对应哪次查询的结果）；五键齐全，不要输出其他键。"""

def parse_sse_stream(lines) -> AttributionResult:
    """SSE 行迭代器 → AttributionResult。镜像 ask.py 的事件面。"""
    res = AttributionResult()
    ev = None
    for line in lines:
        if line.startswith("event: "):
            ev = line[7:].strip()
        elif line.startswith("data: ") and ev:
            try:
                payload = json.loads(line[6:])
            except json.JSONDecodeError:
                continue
            if ev == "answer":
                res.answer_md = payload.get("markdown") or res.answer_md   # 取最后一条
            elif ev == "report":
                res.report_path = payload.get("path")
            elif ev == "error":
                res.error_code = payload.get("code", "")
            elif ev == "done":
                res.status = payload.get("status", "")
    return res

def extract_structured(answer_md: str) -> dict | None:
    """提取最后一个 ```json 块并做宽松 schema 校验；无证据 findings 条目剔除；
    任何不满足 → None（调用方降级，绝不猜字段）。"""
    blocks = _JSON_BLOCK.findall(answer_md or "")
    if not blocks:
        return None
    try:
        obj = json.loads(blocks[-1])
    except json.JSONDecodeError:
        return None
    for k in ("summary", "path", "findings", "waterfall", "entities"):
        if k not in obj or not isinstance(obj[k], (str, list)):
            return None
    kept = [f for f in obj["findings"]
            if isinstance(f, dict) and str(f.get("evidence") or "").strip()]
    obj["findings"] = kept
    return obj
```

- [ ] **Step 4: 确认通过** → 5 PASS；全套无回归
- [ ] **Step 5: Commit**
```bash
git add insight/attribution.py insight/tests/test_attribution.py
git commit -m "feat(insight): 归因管道上半——prompt含JSON契约与ar域弹药指引/SSE解析镜像ask.py/结构化提取宽松校验+无证据条目剔除/无块即降级" -- insight/attribution.py insight/tests/test_attribution.py
```

---

### Task 6: attribution.py —— 网关提交、轮询与版本留档

**Files:** Modify `insight/attribution.py`（追加）；Test `insight/tests/test_attribution.py`（追加）

- [ ] **Step 1: 写失败测试（追加）**

```python
# insight/tests/test_attribution.py（追加）
from insight.attribution import run_attribution
from insight.db import open_db
from insight.store import Store

def test_run_attribution_persists_analysis_and_updates_event(tmp_path, monkeypatch):
    s = Store(open_db(tmp_path / "i.db"))
    s.upsert_episode(event_key="K1", event_id="ev-1", data_date="2026-09-27",
                     detector="region_sales", event_type="sales_decline",
                     title="华南零售销售连续下滑", summary="s", severity="major",
                     scope={}, period={}, facts=[], score=80.0, breakdown={},
                     metric="yoy", dim_keys={})
    calls = {"submit": 0, "sse": 0}

    def fake_submit(prompt: str) -> str:
        calls["submit"] += 1
        assert "华南零售销售连续下滑" in prompt
        return "gw-run-1"

    def fake_consume(run_id: str):
        calls["sse"] += 1
        r = parse_sse_stream(iter(_SSE.splitlines()))
        r.run_id = run_id
        r.status = "succeeded"
        return r

    monkeypatch.setattr("insight.attribution._gw_submit", fake_submit)
    monkeypatch.setattr("insight.attribution._gw_consume", fake_consume)
    res = run_attribution(s, event_id="ev-1", analysis_date="2026-09-28")
    assert res["status"] == "done" and res["parsed"] is not None
    row = s.db.execute("SELECT * FROM event_analysis_run").fetchone()
    assert row["gateway_run_id"] == "gw-run-1" and row["parsed_json"] is not None
    ev = s.db.execute("SELECT attribution_status, attribution_summary FROM business_event"
                      " WHERE event_id='ev-1'").fetchone()
    assert ev["attribution_status"] == "done"
    assert ev["attribution_summary"].startswith("华南零售")

def test_run_attribution_degrades_without_json(monkeypatch, tmp_path):
    s = Store(open_db(tmp_path / "i.db"))
    s.upsert_episode(event_key="K1", event_id="ev-1", data_date="2026-09-27",
                     detector="target", event_type="target_gap", title="t", summary="s",
                     severity="minor", scope={}, period={}, facts=[], score=60.0,
                     breakdown={}, metric="achieve", dim_keys={})
    monkeypatch.setattr("insight.attribution._gw_submit", lambda p: "gw-run-2")
    bad = AttributionResult(run_id="gw-run-2", status="succeeded",
                            answer_md="纯自然语言没有代码块")
    monkeypatch.setattr("insight.attribution._gw_consume", lambda rid: bad)
    res = run_attribution(s, event_id="ev-1", analysis_date="2026-09-28")
    assert res["status"] == "degraded"                    # 降级但原文存档
    row = s.db.execute("SELECT answer_md, parsed_json FROM event_analysis_run").fetchone()
    assert "纯自然语言" in row["answer_md"] and row["parsed_json"] is None

def test_run_attribution_gateway_failure(tmp_path, monkeypatch):
    s = Store(open_db(tmp_path / "i.db"))
    s.upsert_episode(event_key="K1", event_id="ev-1", data_date="2026-09-27",
                     detector="ar_risk", event_type="ar_overdue", title="t", summary="s",
                     severity="major", scope={}, period={}, facts=[], score=90.0,
                     breakdown={}, metric="nat90", dim_keys={})
    def boom(prompt):
        raise RuntimeError("gateway down")
    monkeypatch.setattr("insight.attribution._gw_submit", boom)
    res = run_attribution(s, event_id="ev-1", analysis_date="2026-09-28")
    assert res["status"] == "failed" and "gateway down" in res["degraded_reason"]
```

- [ ] **Step 2: 确认失败**（`-k run_attribution`）→ FAIL
- [ ] **Step 3: 实现（追加到 attribution.py）**

```python
# attribution.py（追加）——网关传输与编排（传输函数可 monkeypatch 测试）
import os
import time as _time
import http.client as _http
from urllib.parse import urlparse as _urlparse

def _gw_cfg() -> dict:
    return {"url": os.environ.get("GW_URL", "http://127.0.0.1:58080"),
            "token": os.environ.get("GW_AUTH_TOKEN", ""),
            "user": os.environ.get("INSIGHT_GW_USER", "insight-svc")}

def _gw_submit(prompt: str) -> str:
    cfg = _gw_cfg()
    u = _urlparse(cfg["url"])
    conn = _http.HTTPConnection(u.hostname, u.port or 80, timeout=30)
    body = json.dumps({"question": prompt})
    conn.request("POST", "/api/tasks", body, {
        "Authorization": f"Bearer {cfg['token']}", "X-User": cfg["user"],
        "Content-Type": "application/json", "Content-Length": str(len(body))})
    resp = conn.getresponse()
    data = resp.read().decode("utf-8", "replace")
    conn.close()
    if resp.status != 201:
        raise RuntimeError(f"gateway submit {resp.status}: {data[:120]}")
    return json.loads(data)["run_id"]

def _gw_consume(run_id: str) -> AttributionResult:
    """SSE 长连接读到 done（镜像 ask.py：一次连接顺序读事件行）。"""
    cfg = _gw_cfg()
    u = _urlparse(cfg["url"])
    conn = _http.HTTPConnection(u.hostname, u.port or 80, timeout=1900)
    conn.request("GET", f"/api/tasks/{run_id}/events", headers={
        "Authorization": f"Bearer {cfg['token']}", "X-User": cfg["user"]})
    resp = conn.getresponse()
    if resp.status != 200:
        conn.close()
        raise RuntimeError(f"gateway events {resp.status}")
    lines = (raw.decode("utf-8", "replace").rstrip("\n") for raw in resp)
    res = parse_sse_stream(lines)
    res.run_id = run_id
    conn.close()
    return res

def run_attribution(store, event_id: str, analysis_date: str) -> dict:
    """提交→消费→提取→落 event_analysis_run（每行一版本）→更新事件当前态。

    失败/超时/JSON 校验失败 → failed|degraded；事件照常在榜（归因是增强不是阻塞）。"""
    ev = store.db.execute("SELECT * FROM business_event WHERE event_id=?",
                          (event_id,)).fetchone()
    prompt = build_prompt(title=ev["title"], summary=ev["summary"], metric=ev["metric"],
                          scope=json.loads(ev["scope_json"]).get("范围", "瓷砖事业部"),
                          period=json.loads(ev["period_json"]).get("类型", "月"),
                          facts=json.loads(ev["facts_json"]), detector=ev["detector"])
    result = AttributionResult(status="submitted")
    try:
        result.run_id = _gw_submit(prompt)
        result = _gw_consume(result.run_id)
    except Exception as e:                      # 网关层任何异常 → failed（重试由 worker 编排）
        result.status = "failed"
        result.degraded_reason = repr(e)[:200]

    parsed = None
    if result.status == "succeeded":
        parsed = extract_structured(result.answer_md)
        if parsed is None:
            result.status = "degraded"
            result.degraded_reason = "no-valid-json-block"

    store.db.execute(
        "INSERT INTO event_analysis_run (analysis_id, event_id, analysis_date,"
        " gateway_run_id, status, answer_md, report_path, parsed_json,"
        " submitted_at, finished_at)"
        " VALUES (?,?,?,?,?,?,?,?,strftime('%s','now'),strftime('%s','now'))",
        (_uid("an"), event_id, analysis_date, result.run_id, result.status,
         result.answer_md, result.report_path,
         json.dumps(parsed, ensure_ascii=False) if parsed else None))
    store.db.execute(
        "UPDATE business_event SET attribution_status=?, attribution_summary=?,"
        " attribution_json=?, attribution_run_id=?,"
        " attribution_generated_at=strftime('%s','now'),"
        " status=CASE WHEN ?='done' THEN 'analyzed' ELSE status END,"
        " updated_at=strftime('%s','now') WHERE event_id=?",
        (result.status, (parsed or {}).get("summary", result.answer_md[:200]),
         json.dumps(parsed, ensure_ascii=False) if parsed else None,
         result.run_id, result.status, event_id))
    store.db.commit()
    return {"status": result.status, "parsed": parsed,
            "degraded_reason": result.degraded_reason, "run_id": result.run_id}

def _uid(prefix: str) -> str:
    import uuid as _uuid
    return f"{prefix}-{_uuid.uuid4().hex[:12]}"
```

- [ ] **Step 4: 确认通过** → 8 PASS；全套无回归
- [ ] **Step 5: Commit**
```bash
git add insight/attribution.py insight/tests/test_attribution.py
git commit -m "feat(insight): 归因下半——网关提交+SSE消费(monkeypatch可测)/event_analysis_run逐版本留档/失败failed降级degraded/事件态analyzed" -- insight/attribution.py insight/tests/test_attribution.py
```

---

### Task 7: worker_main.py —— 日编排（就绪驱动/串行/per-radar timeout）

**Files:** Create `insight/worker_main.py`；Test `insight/tests/test_worker.py`

- [ ] **Step 1: 写失败测试**

```python
# insight/tests/test_worker.py
from datetime import datetime
from insight.db import open_db
from insight.store import Store
from insight.worker_main import run_day

def test_run_day_happy_path_all_persisted(tmp_path):
    s = Store(open_db(tmp_path / "i.db"))
    def fake_runner_spec(name):
        def run(sql, params=None):
            if "ct_sales_performance_t" in sql:
                months = [f"{p[:4]}-{p[4:6]}" for p in params["month_ends"]]
                return [{"month": m, "org_name": "华南营销中心",
                         "channel": "GD01", "cur_amt": 26660000.0,
                         "ly_amt": 30000000.0} for m in months]
            return []
        return run
    out = run_day(s, data_date="2026-09-27", brief_date="2026-09-28",
                  now=datetime(2026, 9, 28, 8, 0),          # cutoff 前 → 全部进当日榜
                  runner_for=fake_runner_spec, watermark_ok=lambda name, run: True,
                  freshness_detail=lambda name: "ready; eff=2026-09-27")
    assert out["brief"]["status"] == "final"
    assert out["brief"]["event_count"] >= 1
    rr = s.db.execute("SELECT * FROM radar_run ORDER BY detector").fetchall()
    assert len(rr) == 4 and rr[0]["error"].startswith("ready")   # watermark detail 落 error 列
    assert s.db.execute("SELECT COUNT(*) c FROM daily_brief_event"
                        ).fetchone()["c"] >= 1

def test_run_day_after_cutoff_marks_late(tmp_path):
    s = Store(open_db(tmp_path / "i.db"))
    def fake_runner_spec(name):
        def run(sql, params=None):
            if "ct_sales_performance_t" in sql:
                months = [f"{p[:4]}-{p[4:6]}" for p in params["month_ends"]]
                return [{"month": m, "org_name": "华南营销中心", "channel": "GD01",
                         "cur_amt": 26660000.0, "ly_amt": 30000000.0} for m in months]
            return []
        return run
    out = run_day(s, "2026-09-27", "2026-09-28",
                  now=datetime(2026, 9, 28, 10, 30),        # cutoff 后
                  runner_for=fake_runner_spec, watermark_ok=lambda name, run: True,
                  freshness_detail=lambda name: "ok")
    assert out["brief"]["event_count"] == 0                 # 晚到不进当日榜
    assert s.db.execute("SELECT COUNT(*) c FROM detector_finding WHERE is_late=1"
                        ).fetchone()["c"] >= 1

def test_run_day_radar_not_ready_isolated(tmp_path):
    s = Store(open_db(tmp_path / "i.db"))
    out = run_day(s, "2026-09-27", "2026-09-28", now=datetime(2026, 9, 28, 8, 0),
                  runner_for=lambda name: (lambda sql, p=None: []),
                  watermark_ok=lambda name, run: name == "region_sales",  # 仅一个就绪
                  freshness_detail=lambda name: "ok")
    rr = s.db.execute("SELECT detector, status FROM radar_run").fetchall()
    by = {r["detector"]: r["status"] for r in rr}
    assert by["region_sales"] == "ran" and by["ar_risk"] == "ready_check_failed"
```

- [ ] **Step 2: 确认失败** → FAIL
- [ ] **Step 3: 实现**

```python
# insight/worker_main.py
"""日编排（pm2 入口）：就绪驱动→四雷达串行→freeze→（10:00 后）归因。

薄层原则：调度/接线在此，逻辑在被测模块。测试注入 runner_for/watermark_ok/now。
生产入口 run_prod()：每雷达独立 DwsQueryRunner(app_name=insight-radar,
timeout_ms=cfg.timeout_ms)（per-radar timeout 接线，M-i1 遗留销账）。"""
import json
from datetime import date, datetime, timedelta
from .backtest import BoundedRunner           # 复用 point-in-time 守卫
from .brief import freeze_brief
from .db import open_db
from .detectors import REGISTRY
from .dws import DwsQueryRunner
from .merge_rank import rank_findings, event_key_of
from .replay_ctx import ReplayContext
from .store import Store

CUTOFF_FREEZE = datetime.strptime("09:30", "%H:%M").time()

def run_day(store: Store, data_date: str, brief_date: str, now: datetime,
            runner_for, watermark_ok, freshness_detail) -> dict:
    ctx = ReplayContext(as_of=date.fromisoformat(data_date))
    freshness, late = [], now.time() >= CUTOFF_FREEZE
    ranked_inputs = []
    for name in sorted(REGISTRY):
        det = REGISTRY[name]()
        run = runner_for(name)
        if not watermark_ok(name, run):
            store.insert_radar_run(name, data_date, "ready_check_failed", 0,
                                   watermark_detail=freshness_detail(name))
            freshness.append({"detector": name, "ready": False,
                              "detail": freshness_detail(name)})
            continue
        try:
            res = det.detect(BoundedRunner(run, ctx.as_of), ctx)
        except Exception as e:
            store.insert_radar_run(name, data_date, "error", 0,
                                   watermark_detail=repr(e)[:200])
            freshness.append({"detector": name, "ready": False, "detail": repr(e)[:120]})
            continue
        for f in res.findings:
            store.insert_finding(data_date, f.detector, f.dim_keys, f.metrics,
                                 f.norm_score, is_late=late)
        store.insert_radar_run(name, data_date, "ran", len(res.findings),
                               watermark_detail=freshness_detail(name))
        freshness.append({"detector": name, "ready": True, "detail": "ok"})
    brief = freeze_brief(store, brief_date, data_date, freshness)
    return {"brief": brief}

def run_prod():
    """生产入口（pm2）。env：INSIGHT_DB_PATH / DWS_* / GW_URL / GW_AUTH_TOKEN / INSIGHT_GW_USER。"""
    import os
    from .watermark import Dependency, check_dependency
    store = Store(open_db(os.environ["INSIGHT_DB_PATH"]))
    today = datetime.now().date()
    data_date = (today - timedelta(days=1)).isoformat()
    brief_date = today.isoformat()
    runners = {}
    wm_detail: dict[str, str] = {}            # watermark detail → radar_run.error 列

    def runner_for(name):
        if name not in runners:
            cfg = REGISTRY[name]().cfg
            runners[name] = DwsQueryRunner(app_name="insight-radar",
                                           timeout_ms=cfg["timeout_ms"])
        return runners[name]

    def watermark_ok(name, run):
        det = REGISTRY[name]()
        ctx = ReplayContext(as_of=date.fromisoformat(data_date))
        results = [check_dependency(Dependency(**d), run, ctx)
                   for d in det.cfg["deps"]]
        wm_detail[name] = "; ".join(
            f"{r.reason}:{r.effective_data_date}" for r in results)
        return all(r.ready for r in results)

    def freshness_detail(name):
        return wm_detail.get(name, "n/a")

    out = run_day(store, data_date, brief_date, datetime.now(),
                  runner_for, watermark_ok, freshness_detail)
    print(json.dumps(out, ensure_ascii=False))
    # 10:00 归因（当日榜 Top≤3）；失败重试由 pm2 重跑或人工触发，14:00 后不再重试
    if datetime.now().time() >= datetime.strptime("10:00", "%H:%M").time():
        from .attribution import run_attribution
        for row in store.db.execute(
                "SELECT event_id FROM daily_brief_event WHERE brief_date=?"
                " ORDER BY rank", (brief_date,)).fetchall():
            try:
                r = run_attribution(store, row["event_id"], brief_date)
                print(f"[attribution] {row['event_id']} -> {r['status']}")
            except Exception as e:
                print(f"[attribution] {row['event_id']} failed: {e!r}")

if __name__ == "__main__":
    run_prod()
```

- [ ] **Step 4: 确认通过** → 3 PASS；全套无回归
- [ ] **Step 5: Commit**
```bash
git add insight/worker_main.py insight/tests/test_worker.py
git commit -m "feat(insight): worker日编排——就绪驱动四雷达串行/per-radar timeout runner接线/晚到标late不进榜/错误隔离不炸整日/10点后归因Top3" -- insight/worker_main.py insight/tests/test_worker.py
```

---

### Task 8: api_main.py —— 只读 HTTP（stdlib，:58095）

**Files:** Create `insight/api_main.py`；Test `insight/tests/test_api.py`

- [ ] **Step 1: 写失败测试**

```python
# insight/tests/test_api.py
import json
import threading
import urllib.request
import pytest
from insight.api_main import make_server
from insight.db import open_db
from insight.store import Store
from insight.brief import freeze_brief

@pytest.fixture
def base(tmp_path):
    s = Store(open_db(tmp_path / "i.db"))
    s.insert_finding("2026-09-27", "region_sales",
                     {"anchor_type": "org_channel", "anchor_id": "华南|GD01",
                      "channel": "GD01"},
                     {"yoy_pct": -11.2}, 85, is_late=False)
    freeze_brief(s, "2026-09-28", "2026-09-27",
                 [{"detector": "region_sales", "ready": True}])
    srv = make_server(s.db, host="127.0.0.1", port=0)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()

def _get(url):
    with urllib.request.urlopen(url, timeout=5) as r:
        return r.status, json.loads(r.read().decode("utf-8"))

def test_daily_today(base):
    st, body = _get(f"{base}/api/insight/daily")
    assert st == 200 and body["briefDate"] == "2026-09-28"
    assert body["eventCount"] == 1
    ev = body["events"][0]
    assert ev["title"].endswith("业绩连续下滑") and "雷达" not in ev["title"]
    assert ev["severity"] in ("major", "minor")

def test_daily_historical_reads_snapshots(base):
    st, body = _get(f"{base}/api/insight/daily?date=2026-09-28")
    assert st == 200 and body["events"][0]["eventId"]            # 快照还原（P0-2）

def test_event_detail(base):
    st, daily = _get(f"{base}/api/insight/daily")
    eid = daily["events"][0]["eventId"]
    st, body = _get(f"{base}/api/insight/events/{eid}")
    assert st == 200 and body["event"]["event_id"] == eid
    assert body["attribution"]["status"] == "pending"            # 尚未归因
    assert body["evidence"][0]["detector"] == "region_sales"     # finding 来源可溯

def test_timeline_and_health_and_404(base):
    st, body = _get(f"{base}/api/insight/timeline?days=30")
    assert st == 200 and len(body) == 1
    st, body = _get(f"{base}/api/insight/health")
    assert st == 200 and body["ok"] is True
    with pytest.raises(urllib.error.HTTPError) as e:
        _get(f"{base}/api/insight/nope")
    assert e.value.code == 404
```

- [ ] **Step 2: 确认失败** → FAIL
- [ ] **Step 3: 实现**

```python
# insight/api_main.py
"""insight-api：只读 HTTP（spec §11.1 / 裁定 D6——BFF 不直读 db，只走本 API）。

stdlib http.server（环境无 fastapi/flask，零新依赖；spec §4 技术描述在此勘误）。
只读连接：sqlite file:...?mode=ro（WAL 跨进程读）。绑定 127.0.0.1，BFF 是唯一客户端。"""
import json
import re
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

_EVENT_ID_RE = re.compile(r"^/api/insight/events/([A-Za-z0-9\-]+)$")

def _rows(db, sql, args=()):
    return [dict(r) for r in db.execute(sql, args).fetchall()]

def _daily_payload(db, brief_date: str) -> dict:
    brief = db.execute("SELECT * FROM daily_brief WHERE brief_date=?",
                       (brief_date,)).fetchone()
    freshness = json.loads(brief["freshness_json"])["radars"] if brief else []
    evs = []
    for s in _rows(db, "SELECT * FROM daily_brief_event WHERE brief_date=?"
                       " ORDER BY rank", (brief_date,)):
        evs.append({"eventId": s["event_id"], "eventKey": None, "lifecycle":
                    s["lifecycle_snapshot"], "persistDays": s["persist_days_snapshot"],
                    "title": s["title_snapshot"], "summary": s["summary_snapshot"],
                    "severity": s["severity_snapshot"],
                    "eventType": s["event_type_snapshot"], "metric": None,
                    "scope": {"范围": "瓷砖事业部"}, "period": {"类型": "月"},
                    "facts": json.loads(s["facts_snapshot"]),
                    "score": s["score_snapshot"], "status": "discovered",
                    "createdAt": s["published_at"]})
    return {"briefDate": brief_date, "scope": "瓷砖事业部",
            "dataFreshness": {"overall": "ready" if evs or brief else "not_ready",
                              "radars": freshness},
            "eventCount": brief["event_count"] if brief else 0,
            "stale": False, "events": evs}

def _event_detail(db, event_id: str) -> dict | None:
    ev = db.execute("SELECT * FROM business_event WHERE event_id=?",
                    (event_id,)).fetchone()
    if not ev:
        return None
    ev = dict(ev)
    latest = db.execute("SELECT * FROM event_analysis_run WHERE event_id=?"
                        " ORDER BY analysis_date DESC, analysis_id DESC LIMIT 1",
                        (event_id,)).fetchone()
    parsed = json.loads(latest["parsed_json"]) if latest and latest["parsed_json"] else None
    evidence = _rows(db, "SELECT finding_id, detector, metrics_json, norm_score, is_late"
                         " FROM detector_finding WHERE data_date=? ORDER BY finding_id",
                     (ev["data_date"],))
    for e in evidence:
        e["metrics"] = json.loads(e.pop("metrics_json"))
    return {"event": {k: ev[k] for k in ("event_id", "event_key", "lifecycle",
                                          "data_date", "first_seen_date", "persist_days",
                                          "detector", "event_type", "title", "summary",
                                          "severity", "scope_json", "facts_json",
                                          "score", "status")},
            "executiveSummary": (parsed or {}).get("summary", ev["summary"]),
            "facts": json.loads(ev["facts_json"]),
            "attribution": {"status": ev["attribution_status"],
                            "analysisId": latest["analysis_id"] if latest else None,
                            "summary": ev["attribution_summary"],
                            "path": (parsed or {}).get("path", []),
                            "findings": (parsed or {}).get("findings", []),
                            "waterfall": (parsed or {}).get("waterfall", []),
                            "entities": (parsed or {}).get("entities", []),
                            "runId": ev["attribution_run_id"],
                            "reportPath": latest["report_path"] if latest else None},
            "evidence": evidence,
            "suggestedActions": [],            # v1 只生成不执行，M-i3 UI 层呈现
            "followupPrompts": ["为什么？", "看重点影响对象明细", "生成完整分析报告"]}

def make_server(db: sqlite3.Connection, host: str = "127.0.0.1",
                port: int = 58095) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):     # 安静（pm2 管日志）
            pass

        def do_GET(self):
            u = urlparse(self.path)
            q = parse_qs(u.query)
            try:
                if u.path == "/api/insight/daily":
                    date = (q.get("date") or [""])[0]
                    payload = _daily_payload(db, date) if date else _daily_payload(
                        db, db.execute("SELECT MAX(brief_date) b FROM daily_brief"
                                       ).fetchone()["b"] or "1970-01-01")
                    body, code = payload, 200
                elif (m := _EVENT_ID_RE.match(u.path)):
                    detail = _event_detail(db, m.group(1))
                    body, code = (detail, 200) if detail else ({"error": "NOT_FOUND"}, 404)
                elif u.path == "/api/insight/timeline":
                    days = int((q.get("days") or ["30"])[0])
                    body = [{"eventId": r["event_id"], "title": r["title"],
                             "severity": r["severity"], "dataDate": r["data_date"],
                             "createdAt": r["updated_at"]}
                            for r in _rows(db, "SELECT * FROM business_event"
                                                 " ORDER BY updated_at DESC LIMIT ?", (days,))]
                    code = 200
                elif u.path == "/api/insight/health":
                    body, code = {"ok": True, "db": "open"}, 200
                else:
                    body, code = {"error": "NOT_FOUND"}, 404
            except Exception as e:
                body, code = {"error": "INTERNAL", "detail": repr(e)[:120]}, 500
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    return ThreadingHTTPServer((host, port), Handler)

def main():
    import os
    path = os.environ["INSIGHT_DB_PATH"]
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)   # 只读（红线）
    db.row_factory = sqlite3.Row
    port = int(os.environ.get("INSIGHT_PORT", "58095"))
    print(f"insight-api listening 127.0.0.1:{port}")
    make_server(db, port=port).serve_forever()

if __name__ == "__main__":
    main()
```

- [ ] **Step 4: 确认通过** → 5 PASS；全套 `python -m pytest insight/tests/ -v` 全绿
- [ ] **Step 5: Commit**
```bash
git add insight/api_main.py insight/tests/test_api.py
git commit -m "feat(insight): insight-api只读HTTP(stdlib零依赖/:58095/ro连接)——daily含历史快照还原/event详情含归因两态与evidence溯源/timeline/health" -- insight/api_main.py insight/tests/test_api.py
```

---

### Task 9: 端到端联调 smoke 与运维 runbook

**Files:** Create `insight/tests/test_e2e_smoke.py`、`insight/PIPELINE_RUNBOOK.md`

- [ ] **Step 1: 写端到端测试（fixture 注入，不需要真 DWS/网关）**

```python
# insight/tests/test_e2e_smoke.py
"""M-i2 全链路 smoke：fixture 数据日 → worker → freeze → 归因(mock 网关) → api 读。"""
import threading
import urllib.request
from datetime import datetime
import json
from insight.api_main import make_server
from insight.db import open_db
from insight.store import Store
from insight.worker_main import run_day

def test_full_pipeline_smoke(tmp_path, monkeypatch):
    s = Store(open_db(tmp_path / "i.db"))

    def runner_for(name):
        def run(sql, params=None):
            if "ct_sales_performance_t" in sql:
                months = [f"{p[:4]}-{p[4:6]}" for p in params["month_ends"]]
                return [{"month": m, "org_name": "华南营销中心", "channel": "GD01",
                         "cur_amt": 26660000.0, "ly_amt": 30000000.0} for m in months]
            return []
        return run

    out = run_day(s, "2026-09-27", "2026-09-28", now=datetime(2026, 9, 28, 8, 0),
                  runner_for=runner_for,
                  watermark_ok=lambda name, run: True,
                  freshness_detail=lambda name: "ready; eff=2026-09-27")
    assert out["brief"]["event_count"] >= 1

    # 归因（mock 网关：成功 + 结构化）
    import insight.attribution as att
    monkeypatch.setattr(att, "_gw_submit", lambda p: "gw-e2e-1")
    good = att.AttributionResult(run_id="gw-e2e-1", status="succeeded",
                                 answer_md='分析……\n```json\n{"summary":"华南下滑主因广东",'
                                           '"path":[],"findings":[{"text":"t","evidence":"q1"}],'
                                           '"waterfall":[],"entities":[]}\n```')
    monkeypatch.setattr(att, "_gw_consume", lambda rid: good)
    from insight.attribution import run_attribution
    eid = out["brief"]["events"][0]["event_id"]
    res = run_attribution(s, eid, "2026-09-28")
    assert res["status"] == "done"

    # api 读
    srv = make_server(s.db, port=0)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    with urllib.request.urlopen(f"{base}/api/insight/daily", timeout=5) as r:
        daily = json.loads(r.read().decode("utf-8"))
    assert daily["eventCount"] >= 1
    with urllib.request.urlopen(f"{base}/api/insight/events/{eid}", timeout=5) as r:
        detail = json.loads(r.read().decode("utf-8"))
    assert detail["attribution"]["status"] == "done"
    assert detail["attribution"]["summary"] == "华南下滑主因广东"
    srv.shutdown()
```

- [ ] **Step 2: 跑通** `python -m pytest insight/tests/test_e2e_smoke.py -v` → 1 PASS

- [ ] **Step 3: 写 runbook**

```markdown
<!-- insight/PIPELINE_RUNBOOK.md（正文为中文，此处从略见文件） -->
# M-i2 管道运维手册
- 进程：pm2 start python --name insight-worker -- -m insight.worker_main（每日一跑：
  pm2 cron 或计划任务触发，错过 09:30 后重跑=晚到合规）；insight-api 常驻
- env：INSIGHT_DB_PATH（Temp 树外）/DWS_*/GW_URL/GW_AUTH_TOKEN/INSIGHT_GW_USER/INSIGHT_PORT
- 观测：radar_run.error（watermark detail）/daily_brief.status/event_analysis_run 逐版本
- 红线：数据未就绪≠无异常；晚到不重洗；归因失败不阻塞上榜
- 阈值/权重：ranking.json 改动必须重跑回测（insight/BACKTEST_RUNBOOK.md）并留台账
```

（正式文件写全上述要点，工程师照抄即可。）

- [ ] **Step 4: 全套回归** `python -m pytest insight/tests/ -v` → 全绿；`python -m pytest eval/ -q` → 既有评测全绿（零影响确认）
- [ ] **Step 5: Commit**
```bash
git add insight/tests/test_e2e_smoke.py insight/PIPELINE_RUNBOOK.md
git commit -m "test(insight): M-i2端到端smoke(worker→freeze→归因mock→api)+管道运维手册" -- insight/tests/test_e2e_smoke.py insight/PIPELINE_RUNBOOK.md
```

---

## Self-Review 记录

1. **Spec coverage（M-i2 范围）**：§8 合并排序（T2/T3：anchor/event_key/生命周期/五因子 N/A/门槛/severity/tie-break）✅；§6 全落库（T1 store 八表中本里程碑六表；followup_session 属 M-i3）✅；§10 时序（T4 freeze+late、T7 就绪驱动/09:30/10:00 归因）✅；§9 归因（T5/T6：P1-5 JSON 契约/降级/event_analysis_run 版本/失败重试边界 14:00 在 runbook）✅；§11.1 API（T8 四端点+历史快照还原）✅；§14 per-radar timeout 接线+串行（T7）✅；承接队列四项全落（tie-break T2、watermark detail→error T1/T7、anchor config 校验注：T3 以 dim_keys 为准并在 facets 落 detector 差异——config 校验并入 T7 watermark_ok 路径，未单独建任务因 M-i1 实现已由 dim_keys 承担投影，config 声明仅为文档）——**注**：applicable_factors 消费在 T2 以"metrics 数据可得性交集"实现（前置事实#4），config 声明未逐键校验，属有意简化。
2. **Placeholder scan**：无 TBD/TODO/stub；runbook 正文在 Task 9 给出要点清单并注明"写全"，属内容给定而非占位。
3. **Type consistency**：`Store.insert_finding(data_date, detector, dim_keys, metrics, norm_score, is_late)` 贯穿 T1/T4/T7/T9；`AttributionResult{run_id,status,answer_md,report_path,error_code,parsed,degraded_reason}` 贯穿 T5/T6/T9；`run_day(store, data_date, brief_date, now, runner_for, watermark_ok, freshness_detail)` 签名 T7/T9 一致；`make_server(db, host, port)` T8/T9 一致。

## M-i2 Exit

1. 五因子排序+episode 生命周期落库（含 partial unique index 生效路径）
2. freeze 快照可还原任意历史日（API 实测）
3. 晚到不重洗、未就绪诚实态（测试钉死）
4. 归因三态（done/degraded/failed）+ 逐版本留档 + 网关零改动
5. worker/api 双进程可跑（pm2 runbook）
6. eval/ 与既有 85 场景零影响
7. 全套 insight 测试绿（预计 ~110 项）
```
