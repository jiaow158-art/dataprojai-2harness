# insight/tests/test_base.py
import json
import pytest
from insight.detectors.base import Finding, DetectResult, percentile_score, load_config

def test_percentile_score_against_baseline():
    baseline = [100, 200, 300, 400, 500]
    assert percentile_score(500, baseline) == 100
    assert percentile_score(100, baseline) == 0
    assert 40 <= percentile_score(250, baseline) <= 60

def test_percentile_clamped_at_100_above_baseline():   # D3：norm_score 域 0-100
    assert percentile_score(600, [100, 200, 300, 400, 500]) == 100

def test_percentile_empty_baseline_neutral():
    assert percentile_score(123, []) == 50

def test_single_point_baseline_neutral():              # 钉死 len<2 中性口径
    assert percentile_score(300, [250]) == 50

def test_load_config_contract_fields(tmp_path):
    cfg = {"name": "x", "deps": [], "anchor": {"type": "org_channel"},
           "applicable_factors": ["impact"], "params": {}, "norm": {"metric": "m", "baseline": []},
           "timeout_ms": 30000, "backtest": {"point_in_time_mode": "exact"}}
    (tmp_path / "radar-x.json").write_text(json.dumps(cfg), encoding="utf-8")
    got = load_config("x", root=tmp_path)
    assert got["backtest"]["point_in_time_mode"] == "exact"

def test_load_config_missing_file_raises(tmp_path):   # 缺配置=响亮失败，不静默
    with pytest.raises(FileNotFoundError):
        load_config("no_such_radar", root=tmp_path)

def test_detect_result_default_is_ok_empty():        # 裁定 #12：findings 只含越阈
    r = DetectResult(detector="x", status="ok")
    assert r.findings == [] and r.note == ""
