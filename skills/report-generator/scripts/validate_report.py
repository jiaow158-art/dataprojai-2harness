#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""validate_report.py — REPORT_JSON v2 纯JSON协议校验器（零依赖，Python 3.9+）。

用法:
    python validate_report.py <report.json | report.html>

校验层:
    1. JSON 可解析（HTML 输入先抽 var data = ... 段）
    2. 结构校验（手写校验器，规则同 references/report-schema.json）
    3. 黑名单：eval( / function( 旧函数串
    4. 占位符残留（HTML 输入）
    5. 结构补充：chart 必须有 valueFormat、section id 唯一、>=1 chart section
    6. 大小：单 chart 数据点 <= 200、HTML <= 5MB
    7. 内联 JS 语法（node 存在则 --check，否则跳过）
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

VALUE_FORMAT_RE = re.compile(r"^(yi|wan|percent|signed_percent|sqm_wan|yuan)(:[0-9])?$")
FUNC_BLACKLIST = re.compile(r"function\s*\(|\beval\s*\(")
PLACEHOLDERS = ("{{REPORT_JSON}}", "{{REPORT_TITLE}}", "{{REPORT_META}}", "{{ECHARTS_LIB}}")
MAX_DATA_POINTS = 200
HTML_SIZE_LIMIT = 5 * 1024 * 1024


def validate_data(data):
    """校验已解析的 REPORT_JSON dict，返回错误字符串列表（空=通过）。"""
    errs = []

    def err(path, msg):
        errs.append("[%s] %s" % (path, msg))

    if not isinstance(data, dict):
        return ["[root] 报告必须是 JSON object"]
    for k in ("title", "kpis", "insight", "sections", "provenance"):
        if k not in data:
            err("root", "缺少必填字段 %s" % k)
    if errs:
        return errs
    if not str(data.get("title") or "").strip():
        err("title", "不能为空")
    if not str(data.get("insight") or "").strip():
        err("insight", "不能为空")

    kpis = data.get("kpis")
    if not isinstance(kpis, list) or not kpis:
        err("kpis", "必须是非空数组")
    else:
        for i, k in enumerate(kpis):
            if not isinstance(k, dict):
                err("kpis[%d]" % i, "必须是 object")
                continue
            if not str(k.get("label") or "").strip():
                err("kpis[%d].label" % i, "不能为空")
            if not str(k.get("value") or "").strip():
                err("kpis[%d].value" % i, "不能为空")
            if k.get("direction") is not None and k["direction"] not in ("up", "down", "neutral"):
                err("kpis[%d].direction" % i, "非法值 %r，允许 up/down/neutral" % k["direction"])

    sections = data.get("sections")
    chart_count = 0
    seen_ids = set()
    if not isinstance(sections, list) or not sections:
        err("sections", "必须是非空数组")
        sections = []
    for i, s in enumerate(sections):
        p = "sections[%d]" % i
        if not isinstance(s, dict):
            err(p, "必须是 object")
            continue
        sid = s.get("id")
        if not str(sid or "").strip():
            err(p + ".id", "不能为空")
        else:
            if sid in seen_ids:
                err(p + ".id", "重复 id %r" % sid)
            seen_ids.add(sid)
        if not str(s.get("tab") or "").strip():
            err(p + ".tab", "不能为空")
        stype = s.get("type")
        if stype not in ("chart-with-analysis", "table"):
            err(p + ".type", "非法值 %r，允许 chart-with-analysis/table" % stype)
            continue
        if stype == "chart-with-analysis":
            chart_count += 1
            _validate_chart_section(s, p, err)
        else:
            _validate_table_section(s, p, err)

    if sections and chart_count == 0:
        err("sections", "至少需要 1 个 chart-with-analysis section")

    prov = data.get("provenance")
    if not isinstance(prov, dict):
        err("provenance", "必须是 object")
    else:
        if not str(prov.get("query") or "").strip():
            err("provenance.query", "必填非空（SQL，用于审计）")

    _scan_blacklist(data, "$", errs)
    return errs


def _validate_chart_section(s, p, err):
    ch = s.get("chart")
    charts = ch if isinstance(ch, list) else ([ch] if ch else [])
    if not charts:
        err(p + ".chart", "chart-with-analysis 必须有 chart")
    for j, c in enumerate(charts):
        cp = p + (".chart[%d]" % j if isinstance(ch, list) else ".chart")
        if not isinstance(c, dict):
            err(cp, "必须是 object")
            continue
        if not str(c.get("id") or "").strip():
            err(cp + ".id", "不能为空")
        if not str(c.get("title") or "").strip():
            err(cp + ".title", "不能为空")
        vf = c.get("valueFormat")
        if not vf:
            err(cp + ".valueFormat", "必填（yi/wan/percent/signed_percent/sqm_wan/yuan，:N 小数位）")
        elif not isinstance(vf, str) or not VALUE_FORMAT_RE.match(vf):
            err(cp + ".valueFormat", "非法值 %r，允许 yi/wan/percent/signed_percent/sqm_wan/yuan 可带 :N" % vf)
        tt = c.get("tooltipTemplate")
        if tt is not None and tt not in ("multi", "pie"):
            err(cp + ".tooltipTemplate", "非法值 %r，允许 multi/pie" % tt)
        opt = c.get("option")
        if not isinstance(opt, dict):
            err(cp + ".option", "必须是 object")
        else:
            n = _count_data_points(opt)
            if n > MAX_DATA_POINTS:
                err(cp + ".option", "数据点 %d 超上限 %d（先聚合再报告）" % (n, MAX_DATA_POINTS))
    ana = s.get("analysis")
    if not isinstance(ana, list) or not ana:
        err(p + ".analysis", "chart-with-analysis 必须有非空 analysis[]")
    else:
        for k, a in enumerate(ana):
            ap = "%s.analysis[%d]" % (p, k)
            if not isinstance(a, dict):
                err(ap, "必须是 object")
                continue
            for f in ("label", "text"):
                if not str(a.get(f) or "").strip():
                    err(ap + "." + f, "不能为空")
            if a.get("color") not in ("blue", "pink", "cyan"):
                err(ap + ".color", "非法值 %r，允许 blue/pink/cyan" % a.get("color"))


def _validate_table_section(s, p, err):
    tbl = s.get("table")
    if not isinstance(tbl, dict):
        err(p + ".table", "table 类型必须有嵌套 table 对象（扁平式已废弃）")
        return
    if not isinstance(tbl.get("columns"), list) or not tbl["columns"]:
        err(p + ".table.columns", "必须是非空数组")
    if not isinstance(tbl.get("rows"), list) or not tbl["rows"]:
        err(p + ".table.rows", "必须是非空数组")
    ps = tbl.get("pageSize")
    if ps is not None and (not isinstance(ps, int) or ps < 1):
        err(p + ".table.pageSize", "必须是 >=1 的整数")


def _count_data_points(opt):
    n = 0
    for s_ in opt.get("series", []) or []:
        if isinstance(s_, dict) and isinstance(s_.get("data"), list):
            n += len(s_["data"])
    return n


def _scan_blacklist(obj, path, errs):
    """递归扫描字符串值里的旧函数格式。"""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in ("valueFormat", "tooltipTemplate"):
                continue  # 已由专门规则校验
            _scan_blacklist(v, "%s.%s" % (path, k), errs)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            _scan_blacklist(v, "%s[%d]" % (path, i), errs)
    elif isinstance(obj, str):
        if FUNC_BLACKLIST.search(obj):
            errs.append("[%s] 旧函数格式已废弃（%r...）→ 改用 valueFormat 声明" % (path, obj[:40]))


def validate_html(html, node_check=True):
    """校验已生成的 HTML：占位符残留 + 大小 + VALID 标记 + 内联 JS 语法。"""
    errs = []
    for ph in PLACEHOLDERS:
        if ph in html:
            errs.append("[html] 占位符 %s 未替换" % ph)
    if len(html.encode("utf-8")) > HTML_SIZE_LIMIT:
        errs.append("[html] 大小 %.1fMB 超上限 5MB" % (len(html.encode("utf-8")) / 1048576))
    if "__REPORT_VALID__" not in html:
        errs.append("[html] 缺少 __REPORT_VALID__ 标记（模板过旧或渲染脚本被破坏）")
    if node_check and shutil.which("node"):
        m = re.search(r"<script>\s*\(function\(\)\s*\{.*?\}\)\(\);?\s*</script>\s*</body>", html, re.S)
        inline_js = m.group(0) if m else ""
        if inline_js:
            fd, tmp = tempfile.mkstemp(suffix=".js")
            try:
                os.write(fd, inline_js.encode("utf-8"))
                os.close(fd)
                p = subprocess.run(["node", "--check", tmp], capture_output=True)
                if p.returncode != 0:
                    errs.append("[html] 内联 JS 语法错误: %s"
                                % p.stderr.decode("utf-8", "ignore")[:200])
            finally:
                os.unlink(tmp)
    return errs


def extract_json_from_html(html):
    """从 HTML 抽 var data = {...}; 段（json.dumps 单行产物，行内唯一分号在末尾）。"""
    m = re.search(r"var data = (\{.*\});", html)
    if not m:
        raise ValueError("HTML 中找不到 var data = ... 段")
    return json.loads(m.group(1))


def main(argv=None):
    ap = argparse.ArgumentParser(description="REPORT_JSON v2 校验器")
    ap.add_argument("target", help="report.json 或已生成的 report.html")
    ap.add_argument("--no-node", action="store_true", help="跳过 node 语法检查")
    args = ap.parse_args(argv)

    with open(args.target, "r", encoding="utf-8") as f:
        content = f.read()

    if args.target.endswith(".json"):
        try:
            data = json.loads(content)
        except json.JSONDecodeError as e:
            print("[FAIL] JSON 解析失败: %s" % e)
            return 1
        errs = validate_data(data)
    else:
        try:
            data = extract_json_from_html(content)
        except (ValueError, json.JSONDecodeError) as e:
            print("[FAIL] 抽取 REPORT_JSON 失败: %s" % e)
            return 1
        errs = validate_data(data) + validate_html(content, node_check=not args.no_node)

    if errs:
        for e in errs:
            print("[FAIL] " + e)
        print("")
        print("共 %d 个错误" % len(errs))
        return 1
    print("VALIDATION PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
