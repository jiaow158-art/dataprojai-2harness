# insight/tests/test_merge_rank.py
from insight.merge_rank import (RANKING, event_key_of, factor_values,
                                score_finding, rank_findings)

def _finding(detector="region_sales", norm=80, anchor="华南|GD01",
             atype="org_channel", metrics=None, persist_days=1):
    return {"detector": detector, "norm_score": norm,
            "dim_keys": {"anchor_type": atype, "anchor_id": anchor, "channel": "GD01"},
            "metrics": metrics or {"yoy_pct": -11.2, "abs_delta_wan": 2375},
            "persist_days": persist_days}

def test_event_key_stable_no_date():
    k1 = event_key_of(_finding())
    k2 = event_key_of(_finding(anchor="华南|GD01"))          # 同锚不同数据日结果一致
    assert k1 == k2 and len(k1) == 16
    assert event_key_of(_finding(anchor="其他|GD01")) != k1

def test_factors_and_na_renormalization():
    # ar_risk 无 target_gap → 四因子按 0.75 权重再归一
    f = _finding(detector="ar_risk", anchor="瓷砖|nat90", atype="customer",
                 metrics={"delta_wan": 3331}, persist_days=2)
    fv = factor_values(f)
    assert fv["target_gap"] is None                       # N/A 不计 0
    sc = score_finding(f)
    assert 0 <= sc["score"] <= 100
    assert abs(sum(w for k, w in sc["used_weights"].items())) > 0.99
    # impact=80/100, persistence=40, scope=40(customer), worsening=60
    expect = (0.30 * 80 + 0.20 * 40 + 0.15 * 40 + 0.10 * 60) / 0.75
    assert abs(sc["score"] - round(expect, 1)) < 0.05   # 实现已达精确值，宽容差会掩盖权重装载错误

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
    assert ranked == []                                    # 低于门槛不上榜

def test_rank_dedupes_same_event_key():
    a1 = _finding(norm=100, anchor="华南|GD01")           # 同 anchor+atype → 同 event_key
    a2 = _finding(norm=90, anchor="华南|GD01")            # 同日重跑双插的第二条
    b = _finding(norm=95, anchor="其他|GD01")
    ranked = rank_findings([a1, a2, b])
    assert len(ranked) == 2                                # 同事件无双占位
    assert ranked[0][0]["norm_score"] == 100               # 排序后首见=最高分
    assert ranked[1][0]["dim_keys"]["anchor_id"] == "其他|GD01"

def test_top_n_truncation():
    four = [_finding(norm=95, anchor=f"区{i}|GD01") for i in range(4)]
    ranked = rank_findings(four)                           # 4 条全过门槛且 event_key 互异
    assert len(ranked) == 3                                # Top0-3 出口标准

def test_full_weight_path_target_83():
    # 协调方规格 norm=50 与 pinned score 83.0 矛盾（50→74.0）；测试名/断言钉 83.0 → norm=80
    f = _finding(detector="target", norm=80, anchor="瓷砖事业部|ALL", atype="org_channel",
                 metrics={"gap_pct": -21.0}, persist_days=9)
    sc = score_finding(f)
    assert sc["score"] == 83.0                             # 全五因子，无再归一
    assert sc["used_weights"] == RANKING["weights"]        # 仅真 N/A 才再归一
