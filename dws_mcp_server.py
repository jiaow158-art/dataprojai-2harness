"""
DWS MCP Server — synchronous stdio JSON-RPC, zero extra deps beyond psycopg2.
Uses blocking stdin/stdout I/O instead of asyncio for Windows/Python 3.9 compatibility.
"""
from __future__ import annotations
import json
import sys
import os
import time
import signal

import psycopg2
import psycopg2.extras

# --- Config from env ---
DWS_HOST = os.environ.get("DWS_HOST", "121.37.200.214")
DWS_PORT = int(os.environ.get("DWS_PORT", "8000"))
DWS_DBNAME = os.environ.get("DWS_DBNAME", "DP_DWS")
DWS_USER = os.environ.get("DWS_USER", "aiuser")
DWS_PASSWORD = os.environ.get("DWS_PASSWORD", "")
DWS_CONNECT_TIMEOUT = int(os.environ.get("DWS_CONNECT_TIMEOUT", "15"))
DWS_QUERY_TIMEOUT = int(os.environ.get("DWS_QUERY_TIMEOUT", "120000"))

SERVER_NAME = "dws-mcp-server"
SERVER_VERSION = "1.1.0"


def log_stderr(msg):
    sys.stderr.write(f"[dws-mcp] {msg}\n")
    sys.stderr.flush()


# --- Database helpers ---

def get_conn():
    return psycopg2.connect(
        host=DWS_HOST,
        port=DWS_PORT,
        dbname=DWS_DBNAME,
        user=DWS_USER,
        password=DWS_PASSWORD,
        connect_timeout=DWS_CONNECT_TIMEOUT,
        options=f"-c statement_timeout={DWS_QUERY_TIMEOUT}",
    )


def execute_sync(sql, params=None):
    start = time.time()
    conn = None
    try:
        conn = get_conn()
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, params)
            try:
                rows = cur.fetchall()
            except Exception:
                rows = []
            elapsed = (time.time() - start) * 1000
            return [dict(r) for r in rows], f"OK ({len(rows)} rows, {elapsed:.0f}ms)"
    except Exception as e:
        return [], f"ERROR: {e}"
    finally:
        if conn:
            conn.close()


# --- Tool implementations ---

def tool_run_query(**kwargs):
    sql = kwargs.get("sql", "").strip().rstrip(";")
    dangerous = ["insert", "update", "delete", "drop", "truncate", "create", "alter",
                 "grant", "revoke", "merge", "call", "execute"]
    low = sql.lower().strip()
    if any(low.startswith(kw) for kw in dangerous):
        return json.dumps({"error": "Write operation rejected. Only SELECT allowed."}, ensure_ascii=False)
    if not any(low.startswith(kw) for kw in ["select", "with", "describe", "show", "explain"]):
        return json.dumps({"error": "Only SELECT/DESCRIBE/SHOW/EXPLAIN/WITH allowed."}, ensure_ascii=False)

    if "limit" not in low:
        sql += " LIMIT 200"

    rows, msg = execute_sync(sql)
    MAX_ROWS = 500
    truncated = len(rows) > MAX_ROWS
    if truncated:
        rows = rows[:MAX_ROWS]
    return json.dumps({
        "status": "ok" if not msg.startswith("ERROR") else "error",
        "message": msg,
        "row_count": len(rows),
        "truncated": truncated,
        "schema": list(rows[0].keys()) if rows else [],
        "data": rows,
    }, ensure_ascii=False, default=str)


def tool_list_tables(**kwargs):
    schema_name = kwargs.get("schema_name", "")
    schemas = [s.strip() for s in schema_name.split(",") if s.strip()] if schema_name else []
    if schemas:
        placeholders = ",".join(["%s"] * len(schemas))
        where = f"AND table_schema IN ({placeholders})"
        params = tuple(schemas)
    else:
        where = "AND table_schema NOT IN ('information_schema','pg_catalog','pg_toast')"
        params = None
    sql = f"""
        SELECT table_schema, table_name, table_type,
               pg_size_pretty(pg_relation_size(quote_ident(table_schema)||'.'||quote_ident(table_name))) as size
        FROM information_schema.tables
        WHERE table_type = 'BASE TABLE' {where}
        ORDER BY table_schema, table_name
        LIMIT 500
    """
    rows, msg = execute_sync(sql, params)
    return json.dumps({
        "status": "ok",
        "tables": rows,
        "count": len(rows),
    }, ensure_ascii=False, default=str)


def tool_describe_table(**kwargs):
    table_name = kwargs.get("table_name", "")
    parts = table_name.split(".", 1)
    if len(parts) == 2:
        schema, table = parts
        where = "AND c.table_schema = %s AND c.table_name = %s"
        params = (schema, table)
    else:
        where = "AND c.table_name = %s"
        params = (parts[0],)
    sql = f"""
        SELECT c.column_name, c.data_type, c.character_maximum_length,
               c.is_nullable, c.column_default,
               pgd.description as column_comment
        FROM information_schema.columns c
        LEFT JOIN pg_catalog.pg_description pgd
            ON pgd.objoid = (quote_ident(c.table_schema)||'.'||quote_ident(c.table_name))::regclass
            AND pgd.objsubid = c.ordinal_position
        WHERE 1=1 {where}
        ORDER BY c.ordinal_position
    """
    rows, msg = execute_sync(sql, params)
    return json.dumps({
        "status": "ok",
        "table": table_name,
        "columns": rows,
        "count": len(rows),
    }, ensure_ascii=False, default=str)


def tool_search_tables(**kwargs):
    keyword = kwargs.get("keyword", "")
    sql = """
        SELECT DISTINCT c.table_schema, c.table_name, t.table_type,
               string_agg(c.column_name, ', ' ORDER BY c.ordinal_position) as columns_sample
        FROM information_schema.columns c
        JOIN information_schema.tables t USING (table_schema, table_name)
        WHERE (c.table_name ILIKE %s OR c.column_name ILIKE %s)
          AND t.table_type = 'BASE TABLE'
          AND c.table_schema NOT IN ('information_schema','pg_catalog','pg_toast')
        GROUP BY c.table_schema, c.table_name, t.table_type
        ORDER BY c.table_schema, c.table_name
        LIMIT 100
    """
    pattern = f"%{keyword}%"
    rows, msg = execute_sync(sql, (pattern, pattern))
    return json.dumps({
        "status": "ok",
        "keyword": keyword,
        "tables": rows,
        "count": len(rows),
    }, ensure_ascii=False, default=str)


# --- MCP Tool Definitions ---

TOOLS = [
    {
        "name": "run_query",
        "description": "Execute a read-only SQL query on DWS (GaussDB). Use after exploring schema with describe_table or search_tables. Auto-adds LIMIT 200 if omitted. IMPORTANT: use WHERE filters with date/period conditions on large tables like dm.dm_fact_finance_cost_f.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "sql": {"type": "string", "description": "SELECT/WITH/DESCRIBE/SHOW/EXPLAIN statement"},
                "description": {"type": "string", "description": "Brief note about what this query does"},
            },
            "required": ["sql"],
        },
    },
    {
        "name": "list_tables",
        "description": "List all BASE TABLEs in DWS with their schemas and sizes. Use to discover available tables across all schemas.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "schema_name": {"type": "string", "description": "Optional comma-separated schemas, e.g. 'dm,dwrfin'"},
            },
        },
    },
    {
        "name": "describe_table",
        "description": "Get column definitions (name, type, nullable, comments) for a table. Input: 'schema.table_name' like 'dm.dm_fact_finance_cost_f'.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "table_name": {"type": "string", "description": "Table name, optionally schema-qualified: 'schema.table'"},
            },
            "required": ["table_name"],
        },
    },
    {
        "name": "search_tables",
        "description": "Search for tables/columns matching a keyword. Use to find relevant tables when you don't know exact names. Example: 'cost', 'profit', 'sales'.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "keyword": {"type": "string", "description": "Keyword to search in table and column names"},
            },
            "required": ["keyword"],
        },
    },
]

TOOL_MAP = {
    "run_query": tool_run_query,
    "list_tables": tool_list_tables,
    "describe_table": tool_describe_table,
    "search_tables": tool_search_tables,
}


# --- JSON-RPC handler ---

def handle_request(req) -> dict | None:
    method = req.get("method", "")
    req_id = req.get("id")

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": "2025-11-25",
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
                "capabilities": {"tools": {}},
            },
        }

    if method == "notifications/initialized":
        return None

    if method == "tools/list":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {"tools": TOOLS},
        }

    if method == "tools/call":
        tool_name = req.get("params", {}).get("name", "")
        tool_args = req.get("params", {}).get("arguments", {})
        func = TOOL_MAP.get(tool_name)
        if not func:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32601, "message": f"Unknown tool: {tool_name}"},
            }
        try:
            result_text = func(**tool_args)
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": result_text}],
                    "isError": False,
                },
            }
        except Exception as e:
            log_stderr(f"Tool error: {e}")
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": f"Error executing {tool_name}: {e}"}],
                    "isError": True,
                },
            }

    if method == "resources/list":
        return {"jsonrpc": "2.0", "id": req_id, "result": {"resources": []}}

    if method == "prompts/list":
        return {"jsonrpc": "2.0", "id": req_id, "result": {"prompts": []}}

    if method == "ping":
        return {"jsonrpc": "2.0", "id": req_id, "result": {}}

    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "error": {"code": -32601, "message": f"Method not found: {method}"},
    }


# --- Synchronous stdio transport ---

def send_message(data: dict):
    body = json.dumps(data, ensure_ascii=False)
    body_bytes = body.encode('utf-8') + b'\n'
    sys.stdout.buffer.write(body_bytes)
    sys.stdout.buffer.flush()


def read_message():
    """Read a single JSON-RPC message from stdin.
    Supports both Content-Length framing and raw JSON lines (NDJSON).
    Returns None on EOF.
    """
    line = sys.stdin.buffer.readline()
    if not line:
        return None

    line_str = line.decode('utf-8').strip()
    if not line_str:
        return None

    # Content-Length framed mode
    if line_str.lower().startswith("content-length:"):
        content_length = int(line_str.split(":", 1)[1].strip())
        sys.stdin.buffer.readline()  # blank separator
        body_bytes = sys.stdin.buffer.read(content_length)
        return json.loads(body_bytes.decode('utf-8'))

    # Raw JSON line mode (NDJSON)
    try:
        return json.loads(line_str)
    except json.JSONDecodeError:
        log_stderr(f"Unparseable input: {line_str[:80]}")
        return None


def main_loop():
    log_stderr(f"Started. {DWS_HOST}:{DWS_PORT}/{DWS_DBNAME} as {DWS_USER}")
    while True:
        try:
            req = read_message()
            if req is None:
                log_stderr("EOF on stdin, exiting")
                break

            resp = handle_request(req)
            if resp is not None:
                send_message(resp)

        except json.JSONDecodeError as e:
            log_stderr(f"JSON parse error: {e}")
        except Exception as e:
            log_stderr(f"Unexpected error in main loop: {e}")


if __name__ == "__main__":
    main_loop()
