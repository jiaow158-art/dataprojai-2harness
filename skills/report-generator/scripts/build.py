#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""build.py — REPORT_JSON v2 → 独立 HTML 报告（零依赖，Python 3.9+）。

用法:
    python build.py --json report.json [--domain sales-performance] [--out reports/]
    python build.py --selftest

流程: 读 JSON → validator 强制前置（不过即止）→ 模板组装 → 写文件 → 复验 → 打印路径(+URL)
"""
import argparse
import datetime
import html as html_mod
import json
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL_DIR = os.path.normpath(os.path.join(HERE, ".."))
TEMPLATE = os.path.join(SKILL_DIR, "templates", "report-shell.html")
ECHARTS = os.path.join(SKILL_DIR, "templates", "echarts.min.js")
DEFAULT_OUT = os.path.normpath(os.path.join(SKILL_DIR, "..", "..", "reports"))

sys.path.insert(0, HERE)
import validate_report  # noqa: E402


def _force_utf8_stdio():
    """Windows GBK 控制台下，管道消费方按 UTF-8 解码会崩溃 → 统一强制 UTF-8 输出。"""
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def build_html(data, echarts_lib, title, meta):
    with open(TEMPLATE, "r", encoding="utf-8") as f:
        html = f.read()
    html = html.replace("{{ECHARTS_LIB}}", "<script>\n" + echarts_lib + "\n</script>")
    html = html.replace("{{REPORT_TITLE}}", html_mod.escape(title))
    html = html.replace("{{REPORT_META}}", html_mod.escape(meta))
    # "</" → "<\/"：JSON 合法转义，浏览器 JS 解析等价，且防止字符串值里的 </script> 撕裂 HTML script 块
    html = html.replace("{{REPORT_JSON}}", json.dumps(data, ensure_ascii=False).replace("</", "<\\/"))
    return html


def check_server():
    """health 通则返回报告基 URL，否则 None。"""
    try:
        urllib.request.urlopen("http://localhost:8080/health", timeout=1).read()
        return "http://localhost:8080/"
    except Exception:
        return None


def do_build(json_path, domain, out_dir):
    try:
        with open(json_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        print("[FAIL] JSON 解析失败: %s" % e)
        return 1
    except OSError as e:
        print("[FAIL] 无法读取 %s: %s" % (json_path, e))
        return 1
    errs = validate_report.validate_data(data)
    if errs:
        print("构建中止：report.json 校验失败")
        for e in errs:
            print("[FAIL] " + e)
        return 1
    with open(ECHARTS, "r", encoding="utf-8") as f:
        echarts_lib = f.read()
    html = build_html(data, echarts_lib, str(data.get("title", "")), str(data.get("subtitle", "")))
    os.makedirs(out_dir, exist_ok=True)
    fname = "report_%s_%s.html" % (domain, datetime.date.today().strftime("%Y%m%d"))
    out_path = os.path.join(out_dir, fname)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(html)
    post = validate_report.validate_html(html, node_check=True)
    if post:
        print("生成后校验失败")
        for e in post:
            print("[FAIL] " + e)
        return 1
    print("OK " + out_path)
    base = check_server()
    if base:
        print("URL " + base + fname)
    else:
        print("SERVER_DOWN 未检测到报告服务器，仅本地路径可用（可运行 python report_server.py）")
    return 0


SELFTEST_JSON = {
    "title": "selftest 报告",
    "subtitle": "selftest | 生成: auto",
    "kpis": [{"label": "KPI", "value": "1.00亿", "direction": "neutral"}],
    "insight": "selftest。",
    "sections": [
        {"id": "trend", "tab": "趋势", "type": "chart-with-analysis",
         "chart": {"id": "c1", "title": "图", "valueFormat": "yi:2",
                   "option": {"xAxis": {"type": "category", "data": ["1月", "2月"]},
                              "yAxis": [{"type": "value", "valueFormat": "yi:2"},
                                        {"type": "value", "valueFormat": "percent"}],
                              "series": [{"name": "s", "type": "line", "data": [1, 2], "valueFormat": "int"},
                                         {"name": "p", "type": "line", "yAxisIndex": 1, "data": [50, 100], "valueFormat": "percent"}]}},
         "analysis": [{"label": "a", "color": "blue", "text": "t"}]},
        {"id": "data", "tab": "明细", "type": "table",
         "table": {"columns": ["A", "B"], "rows": [["1", {"v": "2", "tone": "good"}]]}}
    ],
    "provenance": {"query": "SELECT 1"}
}


def do_selftest(out_dir):
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        jf = os.path.join(td, "selftest.json")
        with open(jf, "w", encoding="utf-8") as f:
            json.dump(SELFTEST_JSON, f, ensure_ascii=False)
        r = do_build(jf, "selftest", td)
        if r != 0:
            print("SELFTEST FAIL")
            return 1
        html_path = os.path.join(td, "report_selftest_%s.html" % datetime.date.today().strftime("%Y%m%d"))
        with open(html_path, "r", encoding="utf-8") as f:
            html = f.read()
        ok = ("__REPORT_VALID__" in html) and ("{{" not in html)
        print("SELFTEST " + ("PASS" if ok else "FAIL"))
        return 0 if ok else 1


def main(argv=None):
    _force_utf8_stdio()
    ap = argparse.ArgumentParser(description="REPORT_JSON v2 → HTML builder")
    ap.add_argument("--json", dest="json_path")
    ap.add_argument("--domain", default="report")
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        return do_selftest(args.out)
    if not args.json_path:
        ap.error("需要 --json 或 --selftest")
    return do_build(args.json_path, args.domain, args.out)


if __name__ == "__main__":
    sys.exit(main())
