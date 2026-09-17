"""M2-T2 驱动器单测 — 纯函数面（SSE 解析/场景键/环境指纹/键列与度量列/汇总聚合/报告渲染）。

全部数据内嵌，不依赖网关/数据库/API——不烧 token。
"""
import json

import run_agent_eval as R  # 仓库根（pytest prepend 模式下根目录在 sys.path）


# ---- 1. SSE 解析（喂样例字节流，断言事件序列）----
def test_sse_parse_basic_event_sequence():
    stream = (
        b'id: 1\nevent: stage\ndata: {"stage":"querying"}\n\n'
        b'id: 2\nevent: sql\ndata: {"sql":"SELECT 1","rows":10}\n\n'
    )
    evs = R.parse_sse_stream([stream])
    assert [(e["event"], e["id"]) for e in evs] == [("stage", 1), ("sql", 2)]
    assert evs[0]["data"]["stage"] == "querying"
    assert evs[1]["data"]["rows"] == 10


def test_sse_arbitrary_chunk_boundaries_and_heartbeat():
    """任意字节切块 + 心跳注释行：解析结果与整块一致。"""
    stream = (
        b'id: 1\nevent: answer\ndata: {"markdown":"he\\nllo"}\n\n'
        b": ping\n\n"
        b'id: 2\nevent: done\ndata: {"status":"succeeded"}\n\n'
    )
    chunks = [stream[i:i + 3] for i in range(0, len(stream), 3)]
    evs = R.parse_sse_stream(chunks)
    assert [(e["event"], e["id"]) for e in evs] == [("answer", 1), ("done", 2)]
    assert evs[0]["data"]["markdown"] == "he\nllo"  # SSE 多行 data 以 \n 拼接
    assert evs[1]["data"]["status"] == "succeeded"


def test_sse_crlf_and_empty_data():
    evs = R.parse_sse_stream([b'event: done\r\ndata: {"status":"failed"}\r\ndata: \r\n\r\n'])
    assert len(evs) == 1
    assert evs[0]["data"] == {"status": "failed"}


def test_sse_parser_incremental_feed():
    p = R.SseFrameParser()
    assert p.feed_line("id: 7") is None
    assert p.feed_line("event: sql") is None
    assert p.feed_line('data: {"rows": 3}') is None
    ev = p.feed_line("")
    assert ev == {"id": 7, "event": "sql", "data": {"rows": 3}}
    assert p.feed_line("") is None  # 空帧不派发


def test_sse_non_json_data_falls_back_to_string():
    evs = R.parse_sse_stream([b"event: x\ndata: not-json\n\n"])
    assert evs[0]["event"] == "x" and evs[0]["data"] == "not-json"


# ---- 2. 场景键 ----
def test_scenario_key_deterministic_and_discriminating():
    k1 = R.scenario_key("inventory", "topn", "问题一")
    assert k1 == R.scenario_key("inventory", "topn", "问题一")
    assert len(k1) == 12
    assert len({k1,
                R.scenario_key("ar", "topn", "问题一"),
                R.scenario_key("inventory", "topn2", "问题一"),
                R.scenario_key("inventory", "topn", "问题二")}) == 4


# ---- 3. 环境指纹 ----
def test_fingerprint_requires_all_fields_equal():
    fp = {"code_sha": "abc", "model": "deepseek-v4-flash", "dataset_mtime": 1726400000.0}
    assert R.fingerprint_matches(fp, dict(fp)) is True
    assert R.fingerprint_matches(fp, {**fp, "code_sha": "def"}) is False
    assert R.fingerprint_matches(fp, {**fp, "model": "other"}) is False
    assert R.fingerprint_matches(fp, {**fp, "dataset_mtime": 1726400001.0}) is False


def test_env_fingerprint_injectable_for_tests():
    fp = R.env_fingerprint(dataset_mtime=1.5, code_sha="sha-x", model="m-x")
    assert fp == {"code_sha": "sha-x", "model": "m-x", "dataset_mtime": 1.5}


# ---- 4. 键列 / 度量列（T1 移交项 2）----
def test_pick_key_cols_prefers_non_numeric():
    rows = [{"year": "2026", "month": "2026-01", "amt": 100.0},
            {"year": "2026", "month": "2026-02", "amt": 200.0}]
    assert R.pick_key_cols(rows) == ["month"]


def test_pick_key_cols_fallback_first_n():
    rows = [{"a": 1, "b": 2, "c": 3, "d": 4}]
    assert R.pick_key_cols(rows) == ["a", "b", "c"]


def test_pick_key_cols_empty_rows():
    assert R.pick_key_cols([]) == []


def test_pick_measure_col_prefers_largest_magnitude():
    rows = [{"year": "2026", "month": "2026-01", "amt": 12345678.9}]
    assert R.pick_measure_col(rows, R.pick_key_cols(rows)) == "amt"


def test_pick_measure_col_none_when_all_key():
    assert R.pick_measure_col([{"month": "2026-01"}], ["month"]) is None


def test_measure_spot_check_hits_wan_unit():
    rows = [{"month": "2026-01", "amt": 216660000.0}]
    mc = R.measure_spot_check(rows, "1月达成 2.17 亿", ["month"])
    assert mc["col"] == "amt" and mc["value"] == 216660000.0 and mc["found"] is True


def test_measure_spot_check_miss_and_guards():
    mc = R.measure_spot_check([{"month": "2026-01", "amt": 1.0}], "答非所问", ["month"])
    assert mc["found"] is False
    assert R.measure_spot_check([], "x", []) is None
    assert R.measure_spot_check([{"month": "2026-01", "amt": 1.0}], "", ["month"]) is None


# ---- 5. 事件流抽取 ----
def test_extract_agent_state_shape():
    events = [
        {"id": 1, "event": "stage", "data": {"stage": "querying"}},
        {"id": 2, "event": "sql", "data": {"sql": "SELECT 1", "rows": 10, "truncated": False,
                                            "result_ref": "r-1", "elapsed_ms": 12}},
        {"id": 3, "event": "answer", "data": {"markdown": "# 报告"}},
        {"id": 4, "event": "done", "data": {"run_id": "run-1", "status": "succeeded",
                                             "elapsed_ms": 9000, "tokens": {"input": 10, "output": 5,
                                                                             "cache_read": 0}}},
    ]
    st = R.extract_agent_state(events)
    assert st["done_status"] == "succeeded"
    assert st["elapsed_ms"] == 9000
    assert st["tokens"] == {"input": 10, "output": 5, "cache_read": 0}
    assert st["answer"] == "# 报告"
    assert len(st["sql_events"]) == 1 and st["sql_events"][0]["result_ref"] == "r-1"


def test_extract_agent_state_takes_last_answer_and_tolerates_nulls():
    events = [
        {"event": "answer", "data": {"markdown": "一"}},
        {"event": "answer", "data": {"markdown": "二"}},
        {"event": "error", "data": {"code": "ENGINE_ERROR", "message": "boom"}},
    ]
    st = R.extract_agent_state(events)
    assert st["answer"] == "二"
    assert st["done_status"] is None and st["tokens"] is None
    assert len(st["error_events"]) == 1


# ---- 6. 汇总聚合 ----
def _d(verdict, domain="inventory", cls=None, tokens=None, cached=False, key="k1"):
    return {"key": key, "idx": 1, "domain": domain, "pattern": "p", "question": "q",
            "verdict": verdict, "failure_class": cls, "wall_ms": 1000,
            "engine_elapsed_ms": 900, "tokens": tokens, "cached": cached,
            "session_id": "s", "run_id": "r"}


def test_aggregate_counts_rates_and_drift_list():
    ds = [_d("PASS", key="a"), _d("FAIL", cls="口径错", key="b"),
          _d("SKIP", key="c"), _d("DATA_DRIFT", domain="ar", key="d")]
    s = R.aggregate_results(ds)
    assert s["totals"]["total"] == 4
    assert s["totals"]["PASS"] == 1 and s["totals"]["FAIL"] == 1
    assert s["totals"]["SKIP"] == 1 and s["totals"]["DATA_DRIFT"] == 1
    assert s["totals"]["pass_rate_all"] == 0.25
    assert s["totals"]["pass_rate_judged"] == round(1 / 3, 4)  # SKIP 不入分母
    assert s["failure_classes"] == {"口径错": 1}
    assert s["data_drift"] == ["d"]
    inv = s["by_domain"]["inventory"]
    assert inv["total"] == 3 and inv["PASS"] == 1
    assert inv["pass_rate_judged"] == 0.5  # 1 PASS / (3-1 SKIP)


def test_aggregate_token_sums():
    ds = [_d("PASS", tokens={"input": 100, "output": 50, "cache_read": 10}),
          _d("PASS", tokens=None),
          _d("FAIL", cls="口径错", tokens={"input": 30, "output": 20, "cache_read": 0})]
    s = R.aggregate_results(ds)
    assert s["tokens"] == {"input": 130, "output": 70, "cache_read": 10}
    assert s["tokens_scenarios"] == 2


# ---- 7. 报告渲染（口径注记：日期格式错为注记类）----
def test_render_report_notes_date_class_is_annotation_only():
    ds = [_d("PASS", key="a"), _d("FAIL", cls="表选错", key="b")]
    summary = R.aggregate_results(ds)
    md = R.render_report("round-test", summary, ds, cost=None, gateway_desc="subprocess")
    assert "日期格式错" in md and "注记" in md
    assert "表选错" in md
    assert "round-test" in md


def test_render_report_cost_table_when_tokens_present():
    ds = [_d("PASS", tokens={"input": 1000, "output": 500, "cache_read": 100})]
    summary = R.aggregate_results(ds)
    cost = R.estimate_cost(summary["tokens"], {"input": 2.0, "output": 8.0, "cache_read": 0.5})
    # 1000/1e6*2 + 500/1e6*8 + 100/1e6*0.5 = 0.002+0.004+0.00005
    assert abs(cost - 0.00605) < 1e-9
    md = R.render_report("r", summary, ds, cost={"cny": cost, "prices": {"input": 2.0}}, gateway_desc="x")
    assert "成本" in md and "tokens" in md


# ---- 8. round1 缺陷1 联动：多事件读回与 any-event 复核 ----
def test_judge_one_multievent_full_compare():
    """judge_one：任一事件 fresh_compare（显式 key_cols）通过 → full_compare_key_cols=True 且记命中序号。"""
    truth = [{"month": "2026-01", "amt": 1.0}, {"month": "2026-02", "amt": 2.0}]
    q = {"row_count": 2, "sql": "SELECT month, amt FROM t", "data": truth}
    state = {"sql_events": [
        {"sql": "SELECT month, amt FROM t", "rows": 2, "truncated": False, "data": list(truth)},
        {"sql": "SELECT SUM(amt) AS a FROM t", "rows": 1, "truncated": False, "data": [{"a": 3.0}]},
    ], "answer": "2026-01 amt 1.0", "done_status": "succeeded", "elapsed_ms": 100}
    v = R.judge_one(q, state, agent_rows=list(truth), fresh_rows=list(truth), fresh_err=None)
    assert v["verdict"] == "PASS"
    assert v["checks"]["full_compare_key_cols"] is True
    assert v["checks"]["full_compare_event"] == 0
    assert v["checks"]["matched_event"] == 0


def test_judge_one_multievent_none_match_reports_false():
    truth = [{"month": "2026-01", "amt": 1.0}]
    q = {"row_count": 1, "sql": "SELECT month, amt FROM t", "data": truth}
    state = {"sql_events": [
        {"sql": "SELECT month, amt FROM t", "rows": 1, "truncated": False, "data": [{"month": "2026-01", "amt": 9.0}]},
        {"sql": "SELECT SUM(amt) AS a FROM t", "rows": 1, "truncated": False, "data": [{"a": 9.0}]},
    ], "answer": "", "done_status": "succeeded", "elapsed_ms": 100}
    v = R.judge_one(q, state, agent_rows=None, fresh_rows=list(truth), fresh_err=None)
    assert v["checks"]["full_compare_key_cols"] is False


def test_read_result_ref_roundtrip_and_missing(tmp_path):
    import json as _json
    d = tmp_path / "sess-1" / "results"
    d.mkdir(parents=True)
    (d / "r-1.json").write_text(_json.dumps({"result_ref": "r-1", "data": [{"a": 1}]}), encoding="utf-8")
    data, err = R.read_result_ref_data(str(tmp_path), "sess-1", "r-1")
    assert data == [{"a": 1}] and err is None
    data2, err2 = R.read_result_ref_data(str(tmp_path), "sess-1", "r-missing")
    assert data2 is None and "缺失" in err2
    data3, err3 = R.read_result_ref_data(None, "sess-1", "r-1")
    assert data3 is None and err3  # 无 results_root（直连未配 GW_RESULTS_ROOT）→ 降级说明
