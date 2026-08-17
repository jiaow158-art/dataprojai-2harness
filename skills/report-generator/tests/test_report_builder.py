"""builder 端到端测试：JSON → HTML → 校验通过；非法 JSON 被拒。"""
import json
import os
import subprocess
import sys

SKILL_DIR = os.path.dirname(os.path.abspath(__file__))
BUILD_PY = os.path.normpath(os.path.join(SKILL_DIR, "..", "scripts", "build.py"))


def _sample():
    return {
        "title": "selftest 报告",
        "subtitle": "2026-08 | 生成: 2026-08-17",
        "kpis": [{"label": "累计达成", "value": "20.38亿", "change": "vs 预算 -20.0%", "direction": "down"}],
        "insight": "1-5月累计达成20.38亿，低于预算20%。",
        "sections": [
            {"id": "trend", "tab": "趋势", "type": "chart-with-analysis",
             "chart": {"id": "c1", "title": "月度趋势", "valueFormat": "yi:2",
                       "option": {"xAxis": {"type": "category", "data": ["1月", "2月", "3月", "4月", "5月"]},
                                  "yAxis": {"type": "value", "name": "金额(亿)"},
                                  "series": [{"name": "实际", "type": "line",
                                              "data": [235326388, 45844139, 427430907, 472816361, 505206331]}]}},
             "analysis": [{"label": "趋势判断", "color": "blue", "text": "V型反弹，3月恢复。"},
                          {"label": "风险", "color": "pink", "text": "预算持续落后。"}]},
            {"id": "data", "tab": "明细", "type": "table",
             "table": {"title": "明细", "columns": ["月", "达成"],
                       "rows": [["1月", "2.35亿"], ["2月", "0.46亿"]]}}
        ],
        "provenance": {"query": "SELECT 1", "source": "selftest", "skillVersion": "report-generator"}
    }


def test_build_end_to_end(tmp_path):
    jf = tmp_path / "r.json"
    jf.write_text(json.dumps(_sample(), ensure_ascii=False), encoding="utf-8")
    r = subprocess.run([sys.executable, BUILD_PY, "--json", str(jf), "--out", str(tmp_path)],
                       capture_output=True, text=True, encoding="utf-8")
    assert r.returncode == 0, "build 失败:\n%s\n%s" % (r.stdout, r.stderr)
    htmls = list(tmp_path.glob("report_*.html"))
    assert len(htmls) == 1, "应生成 1 个 HTML: %s" % htmls
    html = htmls[0].read_text(encoding="utf-8")
    assert "__REPORT_VALID__" in html
    for ph in ("{{REPORT_JSON}}", "{{REPORT_TITLE}}", "{{REPORT_META}}", "{{ECHARTS_LIB}}"):
        assert ph not in html
    assert "selftest 报告" in html


def test_build_rejects_invalid_json(tmp_path):
    bad = _sample()
    del bad["provenance"]["query"]  # 删整个 provenance 会命中 validator root 早退，只报 root 级错误
    jf = tmp_path / "bad.json"
    jf.write_text(json.dumps(bad, ensure_ascii=False), encoding="utf-8")
    r = subprocess.run([sys.executable, BUILD_PY, "--json", str(jf), "--out", str(tmp_path)],
                       capture_output=True, text=True, encoding="utf-8")
    assert r.returncode != 0
    assert "provenance.query" in (r.stdout + r.stderr)
