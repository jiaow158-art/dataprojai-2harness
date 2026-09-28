"""五因子评分与排序（spec §8 + D3：N/A 再归一化/可解释/确定性 tie-break）。

因子全部取自 finding 自身（前置事实#4 启发式），ranking.json 可调。
因子可用性以 metrics 数据可得性为准（config applicable_factors 仅声明性，有意不逐键校验——前置事实#4 简化）。"""
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
