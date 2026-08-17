"""validator 单测：合规过、负路径逐条拦截。"""
import validate_report as vr  # conftest 已注入 scripts/ 到 sys.path


def _base_report():
    """最小合规报告（负路径在其上做字段破坏）。"""
    return {
        "title": "T", "subtitle": "s", "insight": "i",
        "kpis": [{"label": "L", "value": "V", "direction": "up"}],
        "sections": [
            {"id": "trend", "tab": "趋势", "type": "chart-with-analysis",
             "chart": {"id": "c1", "title": "图", "valueFormat": "yi:2", "option": {}},
             "analysis": [{"label": "a", "color": "blue", "text": "t"}]},
            {"id": "data", "tab": "明细", "type": "table",
             "table": {"columns": ["A"], "rows": [["1"]]}}
        ],
        "provenance": {"query": "SELECT 1", "source": "dm.t"}
    }


def test_valid_report_passes():
    errs = vr.validate_data(_base_report())
    assert errs == [], f"应无错误，实际: {errs}"


def test_missing_query_fails():
    r = _base_report(); del r["provenance"]["query"]
    errs = vr.validate_data(r)
    assert any("provenance.query" in e for e in errs)


def test_bad_direction_fails():
    r = _base_report(); r["kpis"][0]["direction"] = "sideways"
    errs = vr.validate_data(r)
    assert any("kpis[0].direction" in e for e in errs)


def test_old_function_format_fails():
    r = _base_report()
    r["sections"][0]["chart"]["option"]["yAxis"] = {
        "axisLabel": {"formatter": "function(v){return v;}"}}
    errs = vr.validate_data(r)
    assert any("旧函数格式" in e for e in errs), f"应拦截函数串: {errs}"


def test_bad_valueformat_fails():
    r = _base_report(); r["sections"][0]["chart"]["valueFormat"] = "billion"
    errs = vr.validate_data(r)
    assert any("valueFormat" in e for e in errs)


def test_missing_valueformat_fails():
    r = _base_report(); del r["sections"][0]["chart"]["valueFormat"]
    errs = vr.validate_data(r)
    assert any("valueFormat" in e for e in errs)


def test_flat_table_fails():
    """表格必须嵌套式 section.table，扁平式（SKILL.md 旧示例）应报错。"""
    r = _base_report()
    r["sections"][1] = {"id": "data", "tab": "明细", "type": "table",
                        "columns": ["A"], "rows": [["1"]]}
    errs = vr.validate_data(r)
    assert any("table" in e for e in errs)


def test_duplicate_id_fails():
    r = _base_report(); r["sections"][1]["id"] = "trend"
    errs = vr.validate_data(r)
    assert any("重复" in e for e in errs)


def test_eval_blacklist_fails():
    r = _base_report()
    r["insight"] = "用 eval(data) 计算"
    errs = vr.validate_data(r)
    assert any("旧函数格式" in e for e in errs)


def test_unhashable_id_does_not_crash():
    r = _base_report()
    r["sections"][0]["id"] = {"a": 1}
    errs = vr.validate_data(r)
    assert isinstance(errs, list)
    assert any(".id" in e for e in errs)


def test_bool_pagesize_fails():
    r = _base_report()
    r["sections"][1]["table"]["pageSize"] = True
    errs = vr.validate_data(r)
    assert any("pageSize" in e for e in errs)


def test_validate_html_placeholder_and_marker():
    dirty = "<html>{{REPORT_JSON}}</html>"
    errs = vr.validate_html(dirty, node_check=False)
    assert any("占位符" in e for e in errs)
    assert any("__REPORT_VALID__" in e for e in errs)
    clean = '<html><script>(function(){ window.__REPORT_VALID__ = true; })();</script></body></html>'
    errs2 = vr.validate_html(clean, node_check=False)
    assert errs2 == [], f"干净HTML不应报错: {errs2}"
