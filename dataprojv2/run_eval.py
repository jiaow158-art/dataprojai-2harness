"""Eval runner for Skills accuracy tracking.
Executes SQL scenarios from eval_dataset.json against DWS and reports pass/fail.
"""
import json
import sys
import time
import psycopg2

EVAL_FILE = "D:/dataproj/eval_dataset.json"
DB = {
    "host": "121.37.200.214",
    "port": 8000,
    "dbname": "DP_DWS",
    "user": "aiuser",
    "password": "Dp123456",
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
