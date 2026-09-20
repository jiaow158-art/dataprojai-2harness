#!/usr/bin/env python
"""离线复判：对已录制轮次重跑判分器（判分器校准后零 API 成本复用录播）。

用法：python eval/rejudge_round.py <round-dir> [results_root]
  <round-dir>     如 eval_results/round-golden10
  [results_root]  网关 GW_RESULTS_ROOT（读回 result_ref 行数据；缺省尝试 env）
输出：<round-dir>/rejudge-summary.json + 控制台对照表（旧判 → 新判）。
"""
import json
import glob
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import run_agent_eval as R  # noqa: E402

DATASET = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "eval_dataset.json")


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    round_dir = sys.argv[1]
    results_root = (sys.argv[2] if len(sys.argv) > 2
                    else os.environ.get("GW_RESULTS_ROOT"))
    qs = json.load(open(DATASET, encoding="utf-8"))["questions"]
    old = {s["idx"]: s for s in json.load(open(os.path.join(round_dir, "summary.json"), encoding="utf-8"))["scenarios"]}
    rows = []
    for f in sorted(glob.glob(os.path.join(round_dir, "results", "*.json"))):
        d = json.load(open(f, encoding="utf-8"))
        q = qs[d["idx"]]
        # 录播无事件原文（stream=元数据）：state 由录制字段重组。answer 仅存前段
        # （answer_head）——只影响 number_in_answer 抽查注记，不影响判定主干。
        state = {"sql_events": d.get("sql_events") or [], "answer": d.get("answer_head") or "",
                 "done_status": d.get("done_status"), "elapsed_ms": d.get("engine_elapsed_ms")}
        refs_read = 0
        for ev in state["sql_events"]:
            ref = ev.get("result_ref")
            if ref:
                data, _err = R.read_result_ref_data(results_root, d["session_id"], ref)
                if isinstance(data, list):
                    ev["data"] = data
                    refs_read += 1
        fresh_rows, fresh_err = (None, None)
        if q.get("sql") and not q.get("expected_refusal"):
            fresh_rows, fresh_err = R.fresh_query(q["sql"])
        v = R.judge_one(q, state, None, fresh_rows, fresh_err)
        rows.append({
            "idx": d["idx"], "domain": d["domain"], "pattern": d["pattern"],
            "old_verdict": old.get(d["idx"], {}).get("verdict"),
            "new_verdict": v["verdict"], "failure_class": v.get("failure_class"),
            "refs_read": refs_read, "fresh_err": fresh_err,
            "checks": v.get("checks"), "notes": v.get("notes"),
        })
    out = os.path.join(round_dir, "rejudge-summary.json")
    json.dump(rows, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    with open(out + ".txt", "w", encoding="utf-8") as w:
        for r in rows:
            w.write(f"idx {r['idx']:2} {r['pattern']:24} {r['old_verdict'] or '?':11} -> {r['new_verdict']:11}"
                    f" class={r['failure_class']} refs={r['refs_read']}\n")
            for n in (r.get("notes") or [])[:3]:
                w.write(f"     · {n[:110]}\n")
    print(f"rejudge -> {out}（{len(rows)} 条）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
