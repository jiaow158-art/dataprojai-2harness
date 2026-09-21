"""Eval runner for Skills accuracy tracking.
Executes SQL scenarios from eval_dataset.json against DWS and reports pass/fail.
"""
import json
import os
import sys
import time
import psycopg2

PROJ_DIR = os.path.dirname(os.path.abspath(__file__))
EVAL_FILE = os.path.join(PROJ_DIR, "eval_dataset.json")
DB = {
    "host": os.environ.get("DWS_HOST", "121.37.200.214"),
    "port": int(os.environ.get("DWS_PORT", "8000")),
    "dbname": os.environ.get("DWS_DBNAME", "DP_DWS"),
    "user": os.environ.get("DWS_USER", "aiuser"),
    "password": os.environ.get("DWS_PASSWORD", ""),
}


def load_eval():
    with open(EVAL_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def run_query(conn, sql, timeout_s=30):
    """Execute SQL, return (rows, elapsed_ms, error)."""
    start = time.time()
    try:
        cur = conn.cursor()
        cur.execute(f"SET statement_timeout = '{timeout_s * 1000}'")
        cur.execute(sql)
        rows = cur.fetchall()
        elapsed = round((time.time() - start) * 1000)
        cur.close()
        return rows, elapsed, None
    except Exception as e:
        elapsed = round((time.time() - start) * 1000)
        return None, elapsed, str(e)


def check_row_count(actual_rows, expected_count):
    """Compare actual row count to expected."""
    if actual_rows is None:
        return False, "query error"
    actual = len(actual_rows)
    if actual == expected_count:
        return True, f"rows={actual}"
    return False, f"rows mismatch: got {actual}, expected {expected_count}"


def main():
    eval_data = load_eval()
    questions = eval_data["questions"]

    # Filter by domain if specified
    domain_filter = sys.argv[1] if len(sys.argv) > 1 else None

    conn = psycopg2.connect(**DB)
    conn.autocommit = True

    results = []
    total = 0
    passed = 0
    failed = 0

    for i, q in enumerate(questions):
        domain = q["domain"]
        if domain_filter and domain != domain_filter:
            continue
        # 红队场景（expected_refusal）无期望 SQL——拒答判定是 live judge 的职责，
        # 离线 runner 跳过（M4-C2 知识发布门接入时实测：sql=null 会被当 query error 全挂）
        if q.get("expected_refusal"):
            print(f"[{i}] {q['pattern']}: SKIP (redteam，拒答判定走 live eval)")
            continue

        total += 1
        print(f"[{total}] {q['pattern']}: {q['question']}", end=" ... ")

        rows, elapsed, err = run_query(conn, q["sql"])
        ok, detail = check_row_count(rows, q["row_count"])

        if ok:
            passed += 1
            print(f"PASS ({detail}, {elapsed}ms)")
        else:
            failed += 1
            print(f"FAIL ({detail}, {elapsed}ms)")
            if err:
                print(f"    error: {err[:120]}")
            if rows:
                print(f"    first row: {rows[0]}")

        results.append({
            "pattern": q["pattern"],
            "passed": ok,
            "detail": detail,
            "elapsed_ms": elapsed,
            "stored_ms": q.get("elapsed_ms"),
        })

    conn.close()

    # Report
    print(f"\n{'='*50}")
    print(f"Results: {passed} passed, {failed} failed, {total} total")
    print(f"Accuracy: {round(passed / total * 100, 1)}%")

    # Domain stats
    if domain_filter:
        print(f"Domain: {domain_filter}")

    # Compare elapsed times
    slow_ones = [r for r in results if r["stored_ms"] and r["elapsed_ms"] and r["elapsed_ms"] > r["stored_ms"] * 2]
    if slow_ones:
        print(f"\n*** Queries significantly slower than stored baseline:")
        for r in slow_ones:
            print(f"  {r['pattern']}: {r['elapsed_ms']}ms vs stored {r['stored_ms']}ms")

    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
