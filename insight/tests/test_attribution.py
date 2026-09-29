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
    "event: answer\ndata: " + json.dumps({"markdown": ANSWER_OK}, ensure_ascii=False) + "\n\n"
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

def test_extract_wrong_types_degrade():                    # 错形=降级（防 T6 InterfaceError）
    def _blk(obj):
        return "```json\n" + json.dumps(obj, ensure_ascii=False) + "\n```"
    assert extract_structured(_blk({"summary": ["华南"], "path": [], "findings": [],
                                   "waterfall": [], "entities": []})) is None
    assert extract_structured(_blk({"summary": "x", "path": "集团→广东", "findings": [],
                                   "waterfall": [], "entities": []})) is None

def test_corrupted_data_event_dropped_stream_survives():   # 损坏帧丢弃不宽容（裁定核心）
    sse = ("event: stage\ndata: {broken\n\n"
           "event: answer\ndata: {\"markdown\":\"正常回答\"}\n\n"
           "event: done\ndata: {\"status\":\"succeeded\"}\n\n")
    res = parse_sse_stream(iter(sse.splitlines()))
    assert res.status == "succeeded" and "正常回答" in res.answer_md
    assert res.error_code == ""                             # 丢弃≠转成 error 事件

def test_multi_data_line_frame_joins():                    # SSE 规范多 data 行 join 后解析
    sse = ("id: 42\n"
           "event: done\n"
           "data: {\"status\":\n"
           "data: \"failed\"}\n"
           "\n")
    res = parse_sse_stream(iter(sse.splitlines()))
    assert res.status == "failed"
