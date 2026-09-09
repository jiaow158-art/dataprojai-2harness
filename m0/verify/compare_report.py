"""Compare dsh-produced report vs golden: structure + local assets + key numbers.
Numeric truth is re-derived via metrics.json SQL in T15 (anti data drift).

用法: python compare_report.py <dsh_report.html> <golden_report.html> <metrics.json> <fresh_truth.json>

tab 结构计数说明（T14 注，实测后修正）：
  金样是浏览器另存的 DOM 快照：ECharts 运行时已把 5 个 tab 按钮渲染成静态
  class="tab-btn active"/"tab-btn" 形态，外加 1 处 JS 模板串形态（共 6 处
  `class="tab-btn` 前缀）。而 fresh build.py 产物是"运行时渲染"形态——JS 里只有
  1 处模板串，tab 按钮数量语义上由 REPORT_JSON 的 `"tab":` 字段承载。
  两份产物的 REPORT_JSON `"tab":` 字段数恒等于实际 tab 数：金样 5、T14 dsh 产物 5。
  故本脚本以 `"tab":` JSON 字段计数为准（金样基线 = 5）。
  M0 宽松阈值：dsh 产物 tab 数 >= 金样 * 0.5（至少一半，即 >= 3）。
"""
import json
import re
import sys


def main(dsh_report, golden_report, metrics_json, fresh_truth):
    html = open(dsh_report, encoding="utf-8").read()
    golden = open(golden_report, encoding="utf-8").read()
    metrics = json.load(open(metrics_json, encoding="utf-8"))
    # T15 产出真值数组；本任务（T14）占位为 []，zip 空数组时指标检查自然跳过
    truth = json.load(open(fresh_truth, encoding="utf-8"))
    checks = []

    def ck(name, ok):
        checks.append((name, ok))

    ck("产物非空且为HTML", html.strip().startswith("<!DOCTYPE") and len(html) > 50000)
    ck("echarts本地引用", "echarts" in html)
    ck("无外链CDN", not re.search(r'src=["\']https?://', re.sub(r"<!--.*?-->", "", html, flags=re.S)))
    golden_tabs = len(re.findall(r'"tab":\s*"', golden))
    dsh_tabs = len(re.findall(r'"tab":\s*"', html))
    ck(f"图表tab结构(金样{golden_tabs} vs 产{dsh_tabs})", dsh_tabs >= golden_tabs * 0.5)  # M0 宽松：至少一半
    for m, t in zip(metrics["metrics"], truth):
        val = str(t["value"])
        ck(f"指标[{m['name']}]含真值{val[:12]}", val in html)
    print("\n".join(f"{'PASS' if ok else 'FAIL'}  {n}" for n, ok in checks))
    fails = [n for n, ok in checks if not ok]
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main(*sys.argv[1:5])
