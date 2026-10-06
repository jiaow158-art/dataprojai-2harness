"""五因子评分与排序（spec §8 + D3：N/A 再归一化/可解释/确定性 tie-break）。

因子全部取自 finding 自身（前置事实#4 启发式），ranking.json 可调。
因子可用性以 metrics 数据可得性为准（config applicable_factors 仅声明性，有意不逐键校验——前置事实#4 简化）。"""
import hashlib
import json
import uuid
from pathlib import Path

RANKING = json.loads((Path(__file__).parent / "config" / "ranking.json")
                     .read_text(encoding="utf-8"))

def event_key_of(finding: dict) -> str:
    dk = finding["dim_keys"]
    raw = "|".join(["瓷砖事业部", str(dk.get("anchor_type")),
                    str(dk.get("anchor_id"))])
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]

def event_org(scope: dict) -> str | None:
    """展示归一（不动数据/锚点/event_key）：组织节点存的是锚点串——取首段；
    BU 级锚点首段短名"瓷砖"回显范围字段"瓷砖事业部"；无竖线原样直出。
    事件中心影响范围列与 region_map 事件注入共用（org 与中心名同名域做关联）。"""
    org = (scope.get("组织节点") or "").partition("|")[0] or None
    if org == "瓷砖":                       # BU 级锚点首段短名 → 显示范围字段
        org = scope.get("范围") or org
    return org

def _scope_factor(anchor_type: str, anchor_id: str) -> int:
    # bu_level 仅限 "|ALL" 后缀（target 事业部级锚点）；nat90 等客户级锚
    # 不升级（TDD：test_factors_and_na_renormalization 钉死 瓷砖|nat90→40）
    if anchor_id.endswith("|ALL"):
        return RANKING["scope_factor"]["bu_level"]
    if anchor_type == "org_channel":
        return RANKING["scope_factor"]["org_channel"]
    return RANKING["scope_factor"]["customer"]

def factor_values(finding: dict) -> dict:
    """注意：调用方必须注入 persist_days（store 原始 finding 无此字段，缺省=按新发计分）。"""
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
    used = {k: w / den for k, w in used.items()}   # 存再归一化权重（除以最终 den）：
                                                   # Σused≈1.0，Σ(breakdown×used)≈score（差≤0.05，round 所致）
    return {"score": score, "breakdown": fv, "used_weights": used}

def rank_findings(findings: list[dict]) -> list[tuple[dict, dict]]:
    """注意：入参 finding 必须由调用方注入 persist_days（store 原始 finding 无此字段，缺省=按新发计分）。"""
    scored = [(f, score_finding(f)) for f in findings]
    scored = [(f, s) for f, s in scored
              if s["score"] >= RANKING["publish_min_score"]]
    scored.sort(key=lambda x: (-x[1]["score"],          # 分降序
                               x[0]["dim_keys"]["anchor_id"],   # 并列 tie-break（确定性）
                               x[0]["detector"]))               # 再并列按雷达名
    seen_keys = set()
    deduped = []
    for f, s in scored:
        k = event_key_of(f)
        if k in seen_keys:
            continue                     # 同事件只上榜一次（排序后首见=最高分，与 Task3 主发现语义一致）
        seen_keys.add(k)
        deduped.append((f, s))
    return deduped[: RANKING["top_n"]]

# —— episode 生命周期与合并（Task 3 追加）——

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
    out = []
    for key, group in by_key.items():
        group.sort(key=lambda f: (-f["norm_score"], f["detector"]))
        primary, facets_raw = group[0], group[1:]
        ep = store.active_episode(key)
        if ep is None:
            persist = 1
        elif data_date > ep["last_seen_date"]:
            persist = ep["persist_days"] + 1
        else:                                  # 同日重跑/倒序重放：与 store._persist_days 守卫一致
            persist = ep["persist_days"]
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
            dim_keys=primary["dim_keys"], facets=fdict)   # 合并证据链落 facet_json（M-i3 详情页可用）
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
