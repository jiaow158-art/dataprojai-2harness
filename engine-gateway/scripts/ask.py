#!/usr/bin/env python
"""手动问数客户端 — 直接体验 dsh 引擎全链路（提交→SSE实时过程→回答/报告）。

用法（网关需在跑，见 start-manual-gateway 说明）：
  python engine-gateway/scripts/ask.py                  # 交互模式：逐行输入问题，同会话多轮追问
  python engine-gateway/scripts/ask.py "问题"           # 单发一问（自动续用上次的会话）
  python engine-gateway/scripts/ask.py --new            # 交互模式，强制新会话

显示约定：
  [阶段] ...     实时进度（analyzing/querying/script_running/...）
  [SQL] n行      每次查询（截断标记 ⋏）
  [回答]         最终答案全文（Markdown 原文）
  [报告] path    生成的 HTML 报告路径
  [错误] code    失败信息
"""
import http.client
import json
import os
import sys
import threading

HOST = os.environ.get("GW_HOST", "127.0.0.1")
PORT = int(os.environ.get("GW_PORT", "58080"))
TOKEN = os.environ.get("GW_TOKEN", "manual-token")
USER = os.environ.get("GW_USER", "manual-tester")
STATE_FILE = os.path.join(os.path.dirname(__file__), ".ask-session.json")


def api(method, path, body=None, headers=None):
    conn = http.client.HTTPConnection(HOST, PORT, timeout=30)
    h = {"Authorization": f"Bearer {TOKEN}", "X-User": USER}
    if body is not None:
        h["Content-Type"] = "application/json"
    h.update(headers or {})
    conn.request(method, path, json.dumps(body) if body is not None else None, h)
    r = conn.getresponse()
    data = r.read().decode("utf-8", "replace")
    conn.close()
    return r.status, (json.loads(data) if data else None)


def load_session():
    try:
        return json.load(open(STATE_FILE, encoding="utf-8")).get("session_id")
    except Exception:
        return None


def save_session(sid):
    json.dump({"session_id": sid}, open(STATE_FILE, "w", encoding="utf-8"))


def ask(question, session_id):
    body = {"question": question}
    if session_id:
        body["session_id"] = session_id
    st, resp = api("POST", "/api/tasks", body)
    if st == 429:
        print(f"[限流] {resp}")
        return session_id
    if st != 201:
        print(f"[提交失败 {st}] {resp}")
        return session_id
    run_id, sid = resp["run_id"], resp["session_id"]
    save_session(sid)

    # SSE 流式收事件（实时打印进度）
    conn = http.client.HTTPConnection(HOST, PORT, timeout=1900)
    conn.request("GET", f"/api/tasks/{run_id}/events", headers={
        "Authorization": f"Bearer {TOKEN}", "X-User": USER})
    r = conn.getresponse()
    if r.status != 200:
        print(f"[事件流失败 {r.status}] {r.read().decode('utf-8','replace')[:300]}")
        return sid
    cur_event, data_lines = None, []
    for raw in r:
        line = raw.decode("utf-8", "replace").rstrip("\n")
        if line.startswith(":"):
            continue
        if not line.strip():
            if cur_event:
                payload = json.loads("\n".join(data_lines)) if data_lines else {}
                handle(cur_event, payload)
            cur_event, data_lines = None, []
            continue
        if line.startswith("event: "):
            cur_event = line[7:]
        elif line.startswith("data: "):
            data_lines.append(line[6:])
    conn.close()
    return sid


def handle(ev, p):
    if ev == "stage":
        extra = f" {p.get('text') or ''}"[:60]
        print(f"[{p.get('stage')}] {extra if p.get('text') else ''}".rstrip())
    elif ev == "sql":
        flag = "⋏截断" if p.get("truncated") else ""
        print(f"  [SQL] {p.get('rows')}行{flag}  {str(p.get('sql'))[:70].replace(chr(10),' ')}…")
    elif ev == "answer":
        print("\n[回答]")
        print(p.get("markdown", ""))
        print()
    elif ev == "report":
        print(f"[报告] {p.get('path')}")
    elif ev == "error":
        print(f"[错误] {p.get('code')}: {str(p.get('message'))[:200]}")
    elif ev == "done":
        t = p.get("tokens") or {}
        print(f"[完成] status={p.get('status')} 耗时={p.get('elapsed_ms',0)//1000}s "
              f"tokens(in/out)={t.get('input')}/{t.get('output')}"
              + (" [本次为恢复重试]" if p.get("recovered") else ""))


def main():
    args = sys.argv[1:]
    new_session = "--new" in args
    args = [a for a in args if a != "--new"]
    session = None if new_session else load_session()

    if args:  # 单问模式
        ask(" ".join(args), session)
        return

    # 交互 REPL
    print(f"问数客户端 → {HOST}:{PORT}（user={USER}；exit/quit 退出；/new 开新会话）")
    if session:
        print(f"续用会话 {session}（--new 可重开）")
    while True:
        try:
            q = input("\n问吧> ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n再见")
            break
        if not q:
            continue
        if q in ("exit", "quit"):
            break
        if q == "/new":
            session = None
            print("已开新会话")
            continue
        session = ask(q, session) or session


if __name__ == "__main__":
    main()
