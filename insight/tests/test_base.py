# insight/tests/test_base.py
import json
from insight.detectors.base import Finding, DetectResult, percentile_score, load_config

def test_percentile_score_against_baseline():
    baseline = [100, 200, 300, 400, 500]
    assert percentile_score(500, baseline) == 100
    assert percentile_score(100, baseline) == 0
    assert 40 <= percentile_score(250, baseline) <= 60

def test_percentile_empty_baseline_neutral():
    assert percentile_score(123, []) == 50

def test_load_config_contract_fields(tmp_path):
    cfg = {"name": "x", "deps": [], "anchor": {"type": "org_channel"},
           "applicable_factors": ["impact"], "params": {}, "norm": {"metric": "m", "baseline": []},
           "timeout_ms": 30000, "backtest": {"point_in_time_mode": "exact"}}
    (tmp_path / "radar-x.json").write_text(json.dumps(cfg), encoding="utf-8")
    got = load_config("x", root=tmp_path)
    assert got["backtest"]["point_in_time_mode"] == "exact"

def test_detect_result_default_is_ok_empty():        # 裁定 #12：findings 只含越阈
    r = DetectResult(detector="x", status="ok")
    assert r.findings == [] and r.note == ""
