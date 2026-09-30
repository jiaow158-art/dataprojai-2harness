# 经营事件中心（M-i6）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 spec `docs/superpowers/specs/2026-09-30-insight-event-center-design.md`（v1.0）落地经营事件中心独立页：insight-api `state=all` 端点服务端返回全部统计口径（D-e5），前端只展示。

**Architecture:** 单端点扩展（`/api/insight/events` 加 `state=all` 分支 + `_event_center(db, today)` 聚合函数，`state=active` 响应冻结不动）→ BFF 零代码改动（代理已透传 query）→ 新 `EventCenterPage` 一页（统计卡/筛选/表格/三图/动态）+ App/Sidebar 接线。

**Tech Stack:** Python stdlib（insight-api 既有形态）/ React+Vite+TS+Tailwind v4（纯 SVG 图表，零新依赖）。

---

## 前置事实

1. 两仓：T1 在 `D:\dataprojai-2harness`；T2-T6 代码在 `D:\dataplat-ui`。提交路径限定。
2. **契约冻结**：`state=active` 分支与响应一字不动（M-i5 首页观察中分区消费）；只加 `state=all` 分支。既有 `elif u.path == "/api/insight/events":` 在 api_main.py 的 do_GET 内（M-i5 加入，位于 `_EVENT_ID_RE` 分支之前）。
3. **测试基线**：harness insight 169+8 skip；dataplat-ui server 84；web=build 零错误。
4. `event_key_of({"dim_keys": ...})`（merge_rank）用于 finding→事件归属（api_main._event_detail 同款）；`RANKING` 已在 api_main 顶部 import。
5. `resolved_at` 是 ISO 日期字符串（"YYYY-MM-DD"，store.resolve_episode 写入 data_date）——窗口比较用字符串比较即可。
6. 统计卡/分布的**分布键名统一 `key`**（服务端 `{"key": "sales_decline", "label": "销售下滑", "count": n}`，两张环图同构）。
7. followup 编排：前端 `apiInsightFollowup(eventId)`（既有，不带 prompt=默认分析意图）→ App 既有 onFollowed 链路（与详情页同一编排，D-e7）。
8. 侧栏 `Sidebar.tsx` 现有 `insightsEnabled` 门禁的"AI经营驾驶舱"按钮旁加"经营事件中心"；App 的 view 联合类型加 `"events"`。
9. 深度色纪律：红=重大/负向、橙=一般/晚到 Badge、绿=已解除、蓝=主操作；空态不凑数。

---

## Task 1: insight-api `_event_center` + `state=all` 路由（harness）

**Files:**
- Modify: `insight/api_main.py`
- Test: `insight/tests/test_api.py`

- [ ] **Step 1: 失败测试**（test_api.py 追加；种子沿用既有 `_ins_event` 助手风格——先读文件看它的可选参数，按需扩展）

```python
# ---- M-i6 事件中心：state=all 统计口径（D-e5/D-e6）----

def test_event_center_summary_windows_and_trend():
    from insight.api_main import _event_center
    from datetime import date
    db = open_db(tmp := __import__("pathlib").Path(__import__("tempfile").mkdtemp()) / "ec.db")
    today = date(2026, 9, 30)
    # 近30天新发 3（1 major / 1 minor / 1 target_gap）；前30天 1（minor）；35 天前旧发 1
    _ins_event(db, eid="ev-new1", first="2026-09-28", sev="major", etype="sales_decline")
    _ins_event(db, eid="ev-new2", first="2026-09-20", sev="minor", etype="sales_decline")
    _ins_event(db, eid="ev-new3", first="2026-09-10", sev="minor", etype="target_gap")
    _ins_event(db, eid="ev-prev1", first="2026-09-05", sev="minor", etype="ar_overdue")
    _ins_event(db, eid="ev-old",  first="2026-08-26", sev="minor", etype="margin_drop")
    # 已解除：resolved_at 近30天 1、前30天 2
    _ins_event(db, eid="ev-r1", first="2026-08-01", sev="minor", etype="sales_decline",
               lifecycle="resolved", resolved="2026-09-15")
    _ins_event(db, eid="ev-r2", first="2026-07-01", sev="minor", etype="sales_decline",
               lifecycle="resolved", resolved="2026-09-01")   # 落在前30窗尾
    p = _event_center(db, today)
    s = p["summary"]
    assert s["total"] == {"count": 3, "prevCount": 1, "delta": 200}
    assert s["major"]["count"] == 1 and s["major"]["delta"] is None   # 前窗 0 → delta None
    assert s["minor"]["count"] == 2 and s["minor"]["prevCount"] == 1
    assert s["targetGap"]["count"] == 1
    assert s["resolved"] == {"count": 1, "prevCount": 1, "delta": 0}
    # trend：30 点补零、首点=2026-09-01、9-28 total=1 major=1
    assert len(p["trend"]["points"]) == 30
    assert p["trend"]["points"][0]["date"] == "2026-09-01"
    d28 = next(x for x in p["trend"]["points"] if x["date"] == "2026-09-28")
    assert d28 == {"date": "2026-09-28", "total": 1, "major": 1, "minor": 0}
    assert all(x["total"] == 0 for x in p["trend"]["points"] if x["date"] == "2026-09-03")
    # 分布=全量（7 事件全计，含 35 天前与已解除）
    assert {d["key"]: d["count"] for d in p["eventTypeDistribution"]}["sales_decline"] == 4
    assert {d["key"]: d["count"] for d in p["lifecycleDistribution"]} == {"active": 5, "resolved": 2}
```

（`_ins_event` 是你为测试新增/扩展的种子助手：必填 eid/first/sev/etype，可选 lifecycle/resolved/org/late_finding——**先看 test_api.py 既有 `_ins_event` 形态（M-i5 已有，参数不同则扩展不改既有调用**）。窗口边界：近30=[09-01, 09-30]、前30=[08-02, 09-01]？不对——见 Step 2 实现：近30=[today-29, today]=09-01..09-30，前30=[today-59, today-30]=08-02..08-31。**上面种子 ev-prev1 first=09-05 落近窗**，会破坏 total=3 断言——实现者必须自己核算窗口并把种子日期配平（例如 prev 事件放 08-20、ev-old 放 07-30），断言语义不变：近 3 / 前 1 / 35 天前不计。配平结果写进报告。）

```python
def test_event_center_late_badge_and_org_parse_and_state_branch(tmp_path):
    from insight.db import open_db
    from insight.merge_rank import event_key_of
    import json as _j
    db = open_db(tmp_path / "ec2.db")
    _ins_event(db, eid="ev-l1", first="2026-09-28", sev="minor", etype="sales_decline",
               org="粤东运营中心")
    # 晚到 finding：与 ev-l1 同 event_key 且 is_late=1
    ev = db.execute("SELECT event_key FROM business_event WHERE event_id='ev-l1'").fetchone()
    dk = {"anchor_type": "org_channel", "anchor_id": "粤东运营中心|GD03", "channel": "GD03"}
    db.execute("INSERT INTO detector_finding (finding_id,data_date,detector,dim_keys_json,"
               "metrics_json,norm_score,threshold_passed,is_late) VALUES"
               "('f-late','2026-09-29','region_sales',?,'{}',50,1,1)",
               (_j.dumps(dk, ensure_ascii=False),))
    db.commit()
    # 端点级：state=all 200；late 派生命中；org 解析；state=xyz 400；state=active 契约不变
    srv = make_server(db, host="127.0.0.1", port=0)
    port = srv.server_address[1]
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/insight/events?state=all", timeout=5) as r:
            body = json.loads(r.read())
        ev1 = body["events"][0]
        assert ev1["late"] is True and ev1["org"] == "粤东运营中心"
        assert body["truncated"] is False
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/insight/events?state=active", timeout=5) as r:
            act = json.loads(r.read())
        assert set(act.keys()) >= {"briefDate", "publishMinScore", "events"}   # 契约形状不动
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/api/insight/events?state=xyz", timeout=5)
            assert False
        except urllib.error.HTTPError as e:
            assert e.code == 400
    finally:
        srv.server_close()
```

（注意 `make_server` 内 `_event_center` 用 `date.today()`——测试若要固定 today 走函数级直调（第一个测试），端点级测试只验结构性断言不依赖窗口。）

- [ ] **Step 2: 确认失败** `python -m pytest insight/tests/test_api.py -k event_center -q` → ImportError/AttributeError

- [ ] **Step 3: 实现**（api_main.py：`_active_events` 后新增 `_event_center`；路由分支改造）

```python
_EVENT_TYPE_LABELS = {"sales_decline": "销售下滑", "margin_drop": "毛利下降",
                      "ar_overdue": "应收风险", "target_gap": "目标缺口"}
_LIFECYCLE_LABELS = {"active": "进行中", "resolved": "已解除"}
_EVENT_CENTER_LIMIT = 500


def _event_center(db, today: date) -> dict:
    """事件中心载荷（spec §3，D-e5 统计口径服务端唯一权威）。
    窗口（D-e6）：近30=[today-29, today]，前30=[today-59, today-30]（含界不重叠）；
    新发卡按 first_seen_date、解除卡按 resolved_at；分母 0 → delta None；
    分布=全量（500 截断时分布基于截断集，v1 量级远达不到，注释即防线）。"""
    iso = today.isoformat()
    w_from = (today - timedelta(days=29)).isoformat()
    p_from = (today - timedelta(days=59)).isoformat()
    p_to = (today - timedelta(days=30)).isoformat()
    rows = _rows(db, "SELECT event_id, event_key, detector, event_type, title, summary,"
                     " severity, scope_json, facts_json, score, persist_days,"
                     " first_seen_date, last_seen_date, lifecycle, resolved_at,"
                     " attribution_status FROM business_event"
                     " ORDER BY first_seen_date DESC, event_id")
    truncated = len(rows) > _EVENT_CENTER_LIMIT
    rows = rows[:_EVENT_CENTER_LIMIT]

    def _card(attr, sev=None, etype=None):
        def n(lo, hi):
            return sum(1 for r in rows if r[attr] and lo <= r[attr] <= hi
                       and (sev is None or r["severity"] == sev)
                       and (etype is None or r["event_type"] == etype))
        cur, prev = n(w_from, iso), n(p_from, p_to)
        return {"count": cur, "prevCount": prev,
                "delta": None if prev == 0 else round((cur - prev) / prev * 100)}

    summary = {"total": _card("first_seen_date"),
               "major": _card("first_seen_date", sev="major"),
               "minor": _card("first_seen_date", sev="minor"),
               "targetGap": _card("first_seen_date", etype="target_gap"),
               "resolved": _card("resolved_at")}

    by_day: dict = {}
    for r in rows:
        if r["first_seen_date"]:
            d = by_day.setdefault(r["first_seen_date"], {"total": 0, "major": 0, "minor": 0})
            d["total"] += 1
            d[r["severity"]] += 1
    points = []
    for i in range(30):
        d = (today - timedelta(days=29 - i)).isoformat()
        points.append({"date": d, **by_day.get(d, {"total": 0, "major": 0, "minor": 0})})

    tc: dict = {}
    lc = {"active": 0, "resolved": 0}
    for r in rows:
        tc[r["event_type"]] = tc.get(r["event_type"], 0) + 1
        lc[r["lifecycle"]] += 1

    late_keys = {event_key_of({"dim_keys": json.loads(r["dim_keys_json"])})
                 for r in _rows(db, "SELECT dim_keys_json FROM detector_finding"
                                    " WHERE is_late=1")}
    latest = (db.execute("SELECT MAX(brief_date) b FROM daily_brief").fetchone()["b"]) or ""
    pub = {r["event_id"]: r["rank"] for r in
           _rows(db, "SELECT event_id, rank FROM daily_brief_event WHERE brief_date=?",
                 (latest,))}
    pmin = RANKING["publish_min_score"]
    out = []
    for r in rows:
        try:
            scope = json.loads(r["scope_json"] or "{}")
        except Exception:
            scope = {}
        try:
            facts = json.loads(r["facts_json"] or "[]")
        except Exception:
            facts = []
        out.append({"event_id": r["event_id"], "detector": r["detector"],
                    "event_type": r["event_type"], "title": r["title"],
                    "summary": r["summary"], "severity": r["severity"],
                    "org": scope.get("组织节点"), "channel": scope.get("渠道"),
                    "facts": facts, "score": r["score"],
                    "persist_days": r["persist_days"],
                    "first_seen_date": r["first_seen_date"],
                    "last_seen_date": r["last_seen_date"],
                    "lifecycle": r["lifecycle"], "resolved_at": r["resolved_at"],
                    "attribution_status": r["attribution_status"],
                    "late": r["event_key"] in late_keys,
                    "publishedToday": r["event_id"] in pub,
                    "rankToday": pub.get(r["event_id"]),
                    "scoreGap": round(r["score"] - pmin, 1)})
    return {"asOf": iso, "summary": summary,
            "trend": {"days": 30, "points": points},
            "eventTypeDistribution": [{"key": k, "label": _EVENT_TYPE_LABELS.get(k, k), "count": v}
                                      for k, v in sorted(tc.items(), key=lambda x: -x[1])],
            "lifecycleDistribution": [{"key": k, "label": _LIFECYCLE_LABELS[k], "count": lc[k]}
                                      for k in ("active", "resolved")],
            "truncated": truncated, "events": out}
```

路由分支（既有 `elif u.path == "/api/insight/events":` 改为三态）：

```python
                elif u.path == "/api/insight/events":
                    state = (q.get("state") or ["active"])[0]
                    if state == "active":
                        body, code = _active_events(ro), 200
                    elif state == "all":
                        body, code = _event_center(ro, date.today()), 200
                    else:
                        body, code = {"error": "BAD_STATE"}, 400
```

- [ ] **Step 4: 通过** `python -m pytest insight/tests/test_api.py -q` 全绿（注意既有 `state 非 active → 400 BAD_STATE` 的 M-i5 测试现在仍成立——xyz 依旧 400）
- [ ] **Step 5: 全量** `python -m pytest insight/ -q` 全绿
- [ ] **Step 6: 提交**

```bash
git add insight/api_main.py insight/tests/test_api.py
git commit -m "feat(mi6): 事件中心state=all端点——summary窗口口径/30点trend/全量分布/late Badge派生，统计服务端唯一权威" -- insight/api_main.py insight/tests/test_api.py
```

---

## Task 2: BFF state=all 透传断言（dataplat-ui，零代码改动）

**Files:**
- Modify: `server/test/insight.test.ts`

- [ ] **Step 1:** 既有 "M-i5 四新端点" 测试的 mock handler 里加一支：

```typescript
    if (req.url === "/api/insight/events?state=all")
      return json({ asOf: "2026-09-30", summary: {}, trend: { days: 30, points: [] },
                    eventTypeDistribution: [], lifecycleDistribution: [],
                    truncated: false, events: [] });
```

并在 flag 开后的断言段补：

```typescript
    const r5 = await request(bff.port, "GET", "/api/insight/events?state=all", { cookie: `sid=${li.sid}` });
    assert.equal(r5.status, 200);
    assert.equal(r5.body.asOf, "2026-09-30");
    assert.ok(insight.requests.some((q) => q.url === "/api/insight/events?state=all"));
```

- [ ] **Step 2:** `cd server && npm test` 全绿（85 预期）
- [ ] **Step 3: 提交** `git commit -m "test(mi6): BFF断言state=all透传(代码零改动)" -- server/test/insight.test.ts`

---

## Task 3: 前端类型 + api 函数（dataplat-ui）

**Files:**
- Modify: `web/src/types.ts`、`web/src/api.ts`

- [ ] **Step 1: types.ts 追加**

```typescript
export interface EventCenterCard { count: number; prevCount: number; delta: number | null; }
export interface EventCenterSummary {
  total: EventCenterCard; major: EventCenterCard; minor: EventCenterCard;
  targetGap: EventCenterCard; resolved: EventCenterCard;
}
export interface EventCenterTrendPoint { date: string; total: number; major: number; minor: number; }
export interface EventCenterDist { key: string; label: string; count: number; }
export interface EventCenterEvent {
  event_id: string; detector: string; event_type: string; title: string; summary: string;
  severity: "major" | "minor"; org: string | null; channel: string | null;
  facts: Array<{ label: string; value: string }>; score: number; persist_days: number;
  first_seen_date: string; last_seen_date: string;
  lifecycle: "active" | "resolved"; resolved_at: string | null;
  attribution_status: "pending" | "running" | "done" | "degraded" | "failed";
  late: boolean; publishedToday: boolean; rankToday: number | null; scoreGap: number;
}
export interface EventCenterPayload {
  asOf: string; summary: EventCenterSummary;
  trend: { days: number; points: EventCenterTrendPoint[] };
  eventTypeDistribution: EventCenterDist[];
  lifecycleDistribution: EventCenterDist[];
  truncated: boolean; events: EventCenterEvent[];
}
```

- [ ] **Step 2: api.ts** `export const apiInsightEventCenter = () => api<EventCenterPayload>("GET", "/api/insight/events?state=all");`（import type 补 EventCenterPayload）

- [ ] **Step 3:** build 零错误 → 提交 `feat(mi6): 事件中心前端契约类型+API`

---

## Task 4: EventCenterPage 主体——统计卡/筛选/表格（dataplat-ui）

**Files:**
- Create: `web/src/components/insights/EventCenterPage.tsx`

组件骨架（完整实现，~260 行；图表组件 T5 提供，本任务先占位 import 会红——**T4/T5 由同一实现者连续做时可直接一起写**，若分人则 T4 内图表区先渲染"图表加载区"占位 div，T5 替换）：

```tsx
// M-i6 经营事件中心（spec 2026-09-30）：统计口径全由 /events?state=all 服务端返回（D-e5），
// 前端只做筛选（客户端，v1 量级几十行）与展示。三概念分立（D-e2）：lifecycle/attribution_status
// 两列各自独立；late 仅标题 Badge。
import { useEffect, useMemo, useState } from "react";
import { ApiError, apiInsightEventCenter, apiInsightFollowup, apiInsightTimeline } from "../../api";
import type { EventCenterPayload } from "../../types";
import BusinessEventTimeline from "./BusinessEventTimeline";
import { EventTrendCard, EventDonutCard } from "./EventCenterCharts";
import { severityStyle } from "./BusinessEventCard";

const TYPE_LABEL: Record<string, string> = { sales_decline: "销售下滑", margin_drop: "毛利下降", ar_overdue: "应收风险", target_gap: "目标缺口" };
const ATTR_LABEL: Record<string, string> = { pending: "待分析", running: "分析中", done: "分析完成", degraded: "降级完成", failed: "分析失败" };
const ATTR_STYLE: Record<string, string> = { pending: "bg-slate-100 text-slate-500", running: "bg-blue-50 text-blue-600", done: "bg-emerald-50 text-emerald-600", degraded: "bg-amber-50 text-amber-600", failed: "bg-red-50 text-red-500" };

function DeltaTag({ d, positiveIsGood }: { d: number | null; positiveIsGood: boolean }) {
  if (d === null) return <span className="text-[11px] text-slate-300">—</span>;
  const good = positiveIsGood ? d >= 0 : d <= 0;
  return (
    <span className={`text-[11px] ${good ? "text-emerald-600" : "text-red-500"}`}>
      {d > 0 ? "↑" : d < 0 ? "↓" : ""}{Math.abs(d)}% 较上期
    </span>
  );
}

export default function EventCenterPage({
  onOpenEvent, onFollowed,
}: { onOpenEvent: (id: string) => void; onFollowed: (r: { uiSessionId: string; seedQuestion: string }) => void }) {
  const [data, setData] = useState<EventCenterPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // 筛选态（全客户端）
  const [q, setQ] = useState("");
  const [sev, setSev] = useState("全部");
  const [etype, setEtype] = useState("全部");
  const [life, setLife] = useState("全部");
  const [attr, setAttr] = useState("全部");
  const [org, setOrg] = useState("全部");
  const [lateOnly, setLateOnly] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [followBusy, setFollowBusy] = useState<string | null>(null);
  useEffect(() => {
    apiInsightEventCenter().then(setData).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);
  const orgs = useMemo(() => ["全部", ...new Set((data?.events ?? []).map((e) => e.org).filter((x): x is string => !!x))], [data]);
  const filtered = useMemo(() => (data?.events ?? []).filter((e) => {
    if (sev !== "全部" && e.severity !== sev) return false;
    if (etype !== "全部" && e.event_type !== etype) return false;
    if (life !== "全部" && e.lifecycle !== life) return false;
    if (attr !== "全部" && e.attribution_status !== attr) return false;
    if (org !== "全部" && e.org !== org) return false;
    if (lateOnly && !e.late) return false;
    if (from && e.first_seen_date < from) return false;
    if (to && e.first_seen_date > to) return false;
    if (q.trim()) {
      const hay = `${e.title} ${e.org ?? ""} ${e.channel ?? ""} ${TYPE_LABEL[e.event_type] ?? ""}`;
      if (!hay.includes(q.trim())) return false;
    }
    return true;
  }), [data, q, sev, etype, life, attr, org, lateOnly, from, to]);

  const follow = async (id: string) => {
    if (followBusy) return;
    setFollowBusy(id);
    try { onFollowed(await apiInsightFollowup(id)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : "追问创建失败"); }
    finally { setFollowBusy(null); }
  };

  if (err && !data) return <div className="p-8 text-sm text-slate-500">经营事件中心暂不可用。<br /><span className="text-xs text-slate-400">{err}</span></div>;
  const cards = data ? [
    { label: "全部事件", card: data.summary.total, good: false },
    { label: "重大异常", card: data.summary.major, good: false },
    { label: "一般异常", card: data.summary.minor, good: false },
    { label: "目标偏差", card: data.summary.targetGap, good: false },
    { label: "已解除", card: data.summary.resolved, good: true },
  ] : [];
  return (
    <div className="h-full overflow-y-auto bg-slate-50">
      <div className="px-8 pt-8 pb-4 flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">经营事件中心</h1>
          <p className="mt-1 text-sm text-slate-500">查看全部经营事件、状态与进展{data ? ` · 数据日 ${data.asOf}` : ""}</p>
        </div>
      </div>
      <div className="px-8 grid grid-cols-2 md:grid-cols-5 gap-3">
        {cards.map(({ label, card, good }) => (
          <div key={label} className="rounded-xl bg-white p-4 ring-1 ring-slate-100">
            <div className="text-xs text-slate-400">{label}</div>
            <div className="mt-1 text-2xl font-semibold text-slate-900">{card.count}</div>
            <div className="mt-1"><DeltaTag d={card.delta} positiveIsGood={good} /></div>
          </div>
        ))}
        {!data && <div className="col-span-5 py-6 text-center text-sm text-slate-400">加载中…</div>}
      </div>
      <div className="mx-8 mt-4 flex flex-wrap items-center gap-2 rounded-xl bg-white p-3 ring-1 ring-slate-100 text-xs">
        <input className="min-w-48 flex-1 rounded border border-slate-200 px-2 py-1.5" placeholder="搜索标题 / 组织 / 渠道 / 事件类型" value={q} onChange={(e) => setQ(e.target.value)} />
        <input type="date" className="rounded border border-slate-200 px-2 py-1.5" value={from} onChange={(e) => setFrom(e.target.value)} />
        <span className="text-slate-300">~</span>
        <input type="date" className="rounded border border-slate-200 px-2 py-1.5" value={to} onChange={(e) => setTo(e.target.value)} />
        {[["严重程度", sev, setSev, ["全部", "major", "minor"]],
          ["事件类型", etype, setEtype, ["全部", ...Object.keys(TYPE_LABEL)]],
          ["事件状态", life, setLife, ["全部", "active", "resolved"]],
          ["AI分析状态", attr, setAttr, ["全部", ...Object.keys(ATTR_LABEL)]],
          ["区域", org, setOrg, orgs]] as const].map(([label, val, set, opts]) => (
          <label key={label} className="flex items-center gap-1 text-slate-400">
            {label}
            <select className="rounded border border-slate-200 px-1.5 py-1.5 text-slate-600" value={val} onChange={(e) => (set as (v: string) => void)(e.target.value)}>
              {opts.map((o) => <option key={o} value={o}>{o === "全部" ? "全部" : label === "严重程度" ? (o === "major" ? "重大异常" : "一般异常") : label === "事件状态" ? (o === "active" ? "进行中" : "已解除") : label === "AI分析状态" ? ATTR_LABEL[o] : label === "事件类型" ? TYPE_LABEL[o] : o}</option>)}
            </select>
          </label>
        ))}
        <label className="flex items-center gap-1 text-slate-400">
          <input type="checkbox" checked={lateOnly} onChange={(e) => setLateOnly(e.target.checked)} /> 晚到
        </label>
        <span className="ml-auto text-slate-400">{filtered.length} 条</span>
      </div>
      <div className="mx-8 mt-4 flex flex-col gap-4 xl:flex-row">
        <div className="min-w-0 flex-1">
          <div className="overflow-x-auto rounded-xl bg-white ring-1 ring-slate-100">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-100 text-left text-slate-400">
                  {["#", "事件标题", "严重度", "事件类型", "影响范围", "关键事实", "首次发现", "持续天数", "事件状态", "AI分析状态", "操作"].map((h) => <th key={h} className="px-3 py-2.5 font-normal whitespace-nowrap">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && <tr><td colSpan={11} className="px-3 py-10 text-center text-slate-300">{data ? "暂无匹配事件" : "…"}</td></tr>}
                {filtered.map((e, i) => (
                  <tr key={e.event_id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60">
                    <td className="px-3 py-2.5 text-slate-300">{i + 1}</td>
                    <td className="max-w-56 px-3 py-2.5">
                      <button type="button" className="flex items-center gap-1 text-left font-medium text-slate-800 hover:text-blue-600" onClick={() => onOpenEvent(e.event_id)}>
                        <span className="truncate">{e.title}</span>
                        {e.late && <span className="shrink-0 rounded bg-amber-50 px-1 py-0.5 text-[10px] text-amber-600">晚到</span>}
                      </button>
                    </td>
                    <td className="px-3 py-2.5"><span className={`rounded-full px-2 py-0.5 ${severityStyle(e).chip}`}>{e.severity === "major" ? "重大异常" : "一般异常"}</span></td>
                    <td className="px-3 py-2.5 text-slate-600 whitespace-nowrap">{TYPE_LABEL[e.event_type] ?? e.event_type}</td>
                    <td className="max-w-28 truncate px-3 py-2.5 text-slate-600">{e.org ?? "—"}</td>
                    <td className="max-w-44 truncate px-3 py-2.5 text-slate-500">{e.facts[0] ? `${e.facts[0].label} ${e.facts[0].value}` : "—"}</td>
                    <td className="px-3 py-2.5 text-slate-500 whitespace-nowrap">{e.first_seen_date}</td>
                    <td className="px-3 py-2.5 text-slate-500">{e.persist_days} 天</td>
                    <td className="px-3 py-2.5 whitespace-nowrap"><span className={e.lifecycle === "active" ? "text-blue-600" : "text-emerald-600"}>● {e.lifecycle === "active" ? "进行中" : "已解除"}</span></td>
                    <td className="px-3 py-2.5 whitespace-nowrap"><span className={`rounded-full px-2 py-0.5 ${ATTR_STYLE[e.attribution_status] ?? ATTR_STYLE.pending}`}>{ATTR_LABEL[e.attribution_status] ?? e.attribution_status}</span></td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <button type="button" className="rounded bg-blue-600 px-2 py-1 text-white hover:bg-blue-700" onClick={() => onOpenEvent(e.event_id)}>详情</button>
                      <button type="button" className="ml-1 rounded border border-slate-200 px-2 py-1 text-slate-600 hover:border-blue-400 hover:text-blue-600 disabled:opacity-50" disabled={followBusy === e.event_id} onClick={() => void follow(e.event_id)}>
                        {followBusy === e.event_id ? "分析中…" : "继续分析"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data?.truncated && <div className="mt-2 text-[11px] text-amber-600">事件超过 500 条已截断显示——请联系管理员调整</div>}
          <div className="mt-4 rounded-xl bg-white p-6 ring-1 ring-slate-100">
            <h3 className="text-sm font-semibold text-slate-900">近期事件动态</h3>
            <div className="mt-2 max-h-72 overflow-y-auto"><TimelineSection /></div>
          </div>
        </div>
        <div className="flex w-full flex-col gap-4 xl:w-96 xl:shrink-0">
          {data && <EventTrendCard points={data.trend.points} />}
          {data && <EventDonutCard title="事件类型分布" items={data.eventTypeDistribution} total={data.events.length} />}
          {data && <EventDonutCard title="事件生命周期分布" items={data.lifecycleDistribution} total={data.events.length} />}
        </div>
      </div>
      {err && data && <div className="mx-8 mb-6 text-xs text-red-500">{err}</div>}
      <div className="pb-8" />
    </div>
  );
}

function TimelineSection() {
  const [items, setItems] = useState<import("../../types").InsightTimelineItem[] | null>(null);
  useEffect(() => { apiInsightTimeline(30).then(setItems).catch(() => setItems([])); }, []);
  return items === null ? <div className="p-4 text-sm text-slate-400">加载中…</div>
    : <BusinessEventTimeline items={items} onOpen={() => { /* 中心页无 onOpenEvent 透传给时间线时点击无效——实现时把 onOpenEvent 传下去 */ }} />;
}
```

（**TimelineSection 的 onOpen 必须接外层 onOpenEvent**——上面是骨架示意，实现时把 onOpenEvent prop 透传进 TimelineSection，勿留空回调。）

- [ ] **Step 2:** `cd web && npm run build`——EventCenterCharts 尚未存在会红；**与 Task 5 同一实现者连续执行**（推荐），或本任务先创建最小占位 `EventCenterCharts.tsx`（导出两个组件渲染 null）保证 build 绿再提交。
- [ ] **Step 3: 提交** `feat(mi6): EventCenterPage——5统计卡/客户端筛选/11列事件表/晚到Badge/继续分析复用followup`

---

## Task 5: 右栏图表组件 + App/Sidebar 接线（dataplat-ui）

**Files:**
- Create: `web/src/components/insights/EventCenterCharts.tsx`
- Modify: `web/src/App.tsx`（view 联合 + 渲染 + onFollowed 复用）
- Modify: `web/src/components/Sidebar.tsx`（经营事件中心入口，flag 门禁同驾驶舱）

- [ ] **Step 1: EventCenterCharts.tsx**

```tsx
// M-i6 事件中心右栏图表：30 天新发三线 + 通用环图（类型 4 段 / 生命周期 2 段）。
// 纯 SVG（MiniTrendChart/HealthPanel 同路线）。数据口径全在服务端，这里只画。
import type { EventCenterDist, EventCenterTrendPoint } from "../../types";

const DONUT_COLORS = ["#2563eb", "#f97316", "#ef4444", "#10b981", "#64748b"];

export function EventTrendCard({ points }: { points: EventCenterTrendPoint[] }) {
  const W = 260, H = 130, PAD = 8;
  const n = points.length;
  const hi = Math.max(2, ...points.map((p) => p.total));
  const x = (i: number) => PAD + (i * (W - 2 * PAD)) / Math.max(n - 1, 1);
  const y = (v: number) => PAD + (1 - v / hi) * (H - 2 * PAD - 10);
  const line = (key: "total" | "major" | "minor") =>
    points.map((p, i) => `${x(i)},${y(p[key])}`).join(" ");
  return (
    <div className="rounded-xl bg-white p-5 ring-1 ring-slate-100">
      <h3 className="text-sm font-semibold text-slate-900">事件趋势（近 30 天）</h3>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 w-full" role="img" aria-label="事件趋势">
        <polyline fill="none" stroke="#93c5fd" strokeWidth="2" points={line("minor")} />
        <polyline fill="none" stroke="#f97316" strokeWidth="1.5" points={line("major")} />
        <polyline fill="none" stroke="#2563eb" strokeWidth="2" points={line("total")} />
      </svg>
      <div className="mt-1 flex gap-3 text-[11px] text-slate-400">
        <span><i className="mr-1 inline-block h-0.5 w-3 bg-blue-600" />全部</span>
        <span><i className="mr-1 inline-block h-0.5 w-3 bg-orange-500" />重大</span>
        <span><i className="mr-1 inline-block h-0.5 w-3 bg-blue-300" />一般</span>
      </div>
    </div>
  );
}

export function EventDonutCard({ title, items, total }: { title: string; items: EventCenterDist[]; total: number }) {
  const sum = items.reduce((s, i) => s + i.count, 0) || 1;
  let acc = 0;
  const R = 40, C = 2 * Math.PI * R;
  return (
    <div className="rounded-xl bg-white p-5 ring-1 ring-slate-100">
      <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
      <div className="mt-3 flex items-center gap-4">
        <svg viewBox="0 0 100 100" className="h-28 w-28 shrink-0">
          {items.map((it, i) => {
            const frac = it.count / sum;
            const el = (
              <circle key={it.key} cx="50" cy="50" r={R} fill="none"
                stroke={DONUT_COLORS[i % DONUT_COLORS.length]} strokeWidth="14"
                strokeDasharray={`${C * frac} ${C}`} strokeDashoffset={-C * acc}
                transform="rotate(-90 50 50)" />
            );
            acc += frac;
            return el;
          })}
          <text x="50" y="48" textAnchor="middle" className="fill-slate-900" style={{ fontSize: 18, fontWeight: 600 }}>{total}</text>
          <text x="50" y="62" textAnchor="middle" className="fill-slate-400" style={{ fontSize: 8 }}>总事件数</text>
        </svg>
        <div className="flex min-w-0 flex-1 flex-col gap-1 text-[11px]">
          {items.map((it, i) => (
            <div key={it.key} className="flex items-center gap-1.5">
              <i className="h-2 w-2 shrink-0 rounded-sm" style={{ background: DONUT_COLORS[i % DONUT_COLORS.length] }} />
              <span className="truncate text-slate-600">{it.label}</span>
              <span className="ml-auto shrink-0 text-slate-400">{it.count}（{Math.round(it.count / sum * 100)}%）</span>
            </div>
          ))}
          {items.length === 0 && <span className="text-slate-300">暂无事件</span>}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: App.tsx**——view 联合加 `"events"`；渲染分支插在 insights 分支旁：

```tsx
      {view === "admin" ? (
        <AdminView … />
      ) : view === "events" && insightsOn ? (
        <EventCenterPage
          onOpenEvent={(id) => setOpenEventId(id)}
          onFollowed={(r) => {           // 与详情页同一编排（D-e7）
            setFollowupSeed({ sessionId: r.uiSessionId, question: r.seedQuestion });
            setActiveId(r.uiSessionId);
            setView("chat");
            void refreshSessions();
          }}
        />
      ) : view === "insights" && insightsOn ? ( …既有… )}
```

import EventCenterPage。

- [ ] **Step 3: Sidebar.tsx**——props 加 `onEventCenter: () => void`；"AI经营驾驶舱"按钮下方并排第二个按钮（同样 `props.insightsEnabled &&` 门禁）：

```tsx
          <button type="button"
            className="w-full rounded border border-line-strong bg-card py-1.5 text-xs text-ink-2 transition-colors hover:border-accent hover:text-ink"
            onClick={props.onEventCenter}>
            经营事件中心
          </button>
```

App.tsx 侧栏调用处传 `onEventCenter={() => setView("events")}`。

- [ ] **Step 4:** build 零错误 + server 测试绿 → 提交 `feat(mi6): 事件中心图表组件+App视图+侧栏入口(flag门禁)`

---

## Task 6: 总验收 + 部署（双仓 + 运维）

- [ ] **Step 1:** 双仓全量：`cd /d/dataprojai-2harness && python -m pytest insight/ eval/ -q` 全绿；`cd /d/dataplat-ui/web && npm run build`；`cd /d/dataplat-ui/server && npm test`
- [ ] **Step 2:** 部署：harness T1 改了 api_main → `pm2 restart insight-api`（env 已带 DWS）；web build 产物即 dist（BFF 代码零改动不必重启，保险起见 `pm2 restart dataplat-ui`）
- [ ] **Step 3:** 生产冒烟：admin-prod 登录 → BFF `/api/insight/events?state=all` 200 且 summary/distribution 数字与 insight.db 直查一致（抽 3 个数：total/major/lifecycle active）；UI 页：统计卡/筛选交互/表格列/晚到 Badge（当前 0 条属正常）/继续分析跳 chat/三图渲染
- [ ] **Step 4:** runbook 追加一行（§M-i6：state=all 端点+截断上限）并提交 harness
- [ ] **Step 5:** 收尾：dataplat-ui 侧若有验收小修按路径限定提交

## Self-Review 记录

1. **Spec 覆盖**：§2 三概念分立=T4 表列/筛选+T1 late 派生；§3 口径=T1 `_event_center` 逐条（窗口/补零/全量分布/500 截断/active 冻结）；§4 页面=T4/T5；§5 BFF 零改动=T2；§6 测试=各任务+T6 冒烟。无缺口。
2. **占位**：T4 的 TimelineSection onOpen 空回调已显式标注"必须透传"；T4/T5 连续执行建议已注明。
3. **类型一致性**：分布键名统一 `key`（T1 服务端 / T3 EventCenterDist）；EventCenterEvent 字段与 T1 out dict 逐字段对齐；onFollowed 签名与 App 既有 detail 页 handler 同构。
