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


def test_build_survives_script_tag_in_text(tmp_path):
    """analysis text 含 </script> 不得撕裂 HTML script 块。"""
    import re as _re
    r = _sample()
    r["sections"][0]["analysis"][0]["text"] = "结论 </script><script>alert(1)</script> 完"
    jf = tmp_path / "s.json"
    jf.write_text(json.dumps(r, ensure_ascii=False), encoding="utf-8")
    out = subprocess.run([sys.executable, BUILD_PY, "--json", str(jf), "--out", str(tmp_path)],
                         capture_output=True, text=True, encoding="utf-8")
    assert out.returncode == 0, out.stdout + out.stderr
    html = list(tmp_path.glob("report_*.html"))[0].read_text(encoding="utf-8")
    # 数据段里的 </script> 必须已转义为 <\/（build.py 的 replace("</", "<\\/") 产物）
    assert "<\\/script><script>alert(1)<\\/script>" in html, "转义缺失"
    assert "</script><script>" not in html, "数据段出现裸 </script>，script 块被撕裂"
    # echarts 库 script 之外，渲染 script 段应完整（未被数据内容撕成多段）
    scripts = _re.findall(r"<script>[\s\S]*?</script>", html)
    assert len(scripts) == 2, "script 块数量异常: %d" % len(scripts)
    # round-trip：抽出的 JSON 仍含原始 text
    sys.path.insert(0, os.path.normpath(os.path.join(SKILL_DIR, "..", "scripts")))
    import validate_report as vr
    data = vr.extract_json_from_html(html)
    assert data["sections"][0]["analysis"][0]["text"] == "结论 </script><script>alert(1)</script> 完"


def test_build_bad_json_syntax_graceful(tmp_path):
    jf = tmp_path / "broken.json"
    jf.write_text('{"title": ', encoding="utf-8")
    out = subprocess.run([sys.executable, BUILD_PY, "--json", str(jf), "--out", str(tmp_path)],
                         capture_output=True, text=True, encoding="utf-8")
    assert out.returncode == 1
    assert "[FAIL]" in out.stdout and "Traceback" not in out.stdout + out.stderr
    assert not list(tmp_path.glob("report_*.html"))


def test_template_scatter_label_and_item_tooltip_present():
    """模板必须含散点标签自动开启与 item-trigger 单参数 tooltip 分支（静态回归护栏）。"""
    import pathlib
    tpl = (pathlib.Path(SKILL_DIR) / ".." / "templates" / "report-shell.html").resolve()
    src = tpl.read_text(encoding="utf-8")
    assert "labelLayout" in src          # Fix B：散点标签防重叠
    assert "hasExplicitLabel" in src     # Fix B：尊重 JSON 显式 label
    assert "isItemTrigger" in src        # Fix A：item 触发单参数分支
    assert "return p.seriesName" in src  # Fix B：气泡直标产品名
