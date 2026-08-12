#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Report HTTP Server — serve reports/ directory over HTTP.

Zero dependencies (Python stdlib only). CORS-enabled. Auto-generates
a directory index so users can browse all available reports.

Usage:
    python report_server.py                          # default: 0.0.0.0:8080
    REPORT_PORT=8888 python report_server.py         # custom port
    REPORT_DIR=/tmp/reports python report_server.py  # custom dir

Env vars:
    REPORT_PORT — listen port (default 8080)
    REPORT_HOST — bind address (default 0.0.0.0)
    REPORT_DIR  — reports directory (default ./reports)
"""

import os
import sys
import json
import socket
import time
import urllib.parse
import mimetypes
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path


# ── Config ────────────────────────────────────────────────────────
REPORT_HOST = os.environ.get("REPORT_HOST", "0.0.0.0")
REPORT_PORT = int(os.environ.get("REPORT_PORT", "8080"))
REPORT_DIR  = Path(os.environ.get("REPORT_DIR", Path(__file__).resolve().parent / "reports"))

# Ensure reports directory exists
REPORT_DIR.mkdir(parents=True, exist_ok=True)


def detect_public_url() -> str:
    """Detect the best URL for users to access this server.
    Priority: REPORT_PUBLIC_URL env var > primary IP > hostname > localhost.
    IP is preferred over hostname because internal DNS often doesn't resolve.
    """
    env_url = os.environ.get("REPORT_PUBLIC_URL", "")
    if env_url:
        return env_url.rstrip("/")

    # Try primary non-loopback IP first (most reliable on internal networks)
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
        s.close()
        return f"http://{ip}:{REPORT_PORT}"
    except Exception:
        pass

    # Fallback: hostname
    hostname = socket.gethostname()
    if hostname:
        return f"http://{hostname}:{REPORT_PORT}"

    return f"http://localhost:{REPORT_PORT}"


# ── Handler ───────────────────────────────────────────────────────
class ReportHandler(SimpleHTTPRequestHandler):
    """Serve static files from REPORT_DIR with CORS + directory index."""

    def __init__(self, *args, **kwargs):
        # Force serve from REPORT_DIR regardless of cwd
        super().__init__(*args, directory=str(REPORT_DIR), **kwargs)

    # ── CORS ──────────────────────────────────────────────────
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    # ── Directory index at / ──────────────────────────────────
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        # Root → directory index
        if path == "/" or path == "":
            self._send_index()
            return

        # Health check
        if path == "/health":
            self._send_json({
                "status": "ok",
                "server": "report-server",
                "reports_dir": str(REPORT_DIR),
                "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
            })
            return

        # API: list reports as JSON (for programmatic access)
        if path == "/api/reports":
            self._send_json(self._list_reports())
            return

        super().do_GET()

    # ── Index page ────────────────────────────────────────────
    def _send_index(self):
        reports = self._list_reports()

        rows = ""
        for r in reports:
            rows += f"""
            <tr>
                <td><a href="/{r['name']}">{r['name']}</a></td>
                <td>{r['size']}</td>
                <td>{r['mtime']}</td>
            </tr>"""

        html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>数据报告中心</title>
<style>
  * {{ margin:0; padding:0; box-sizing:border-box; }}
  body {{
    font-family: -apple-system, "Microsoft YaHei", "PingFang SC", sans-serif;
    background: #0f172a; color: #e2e8f0;
    min-height: 100vh; padding: 40px 20px;
  }}
  .container {{ max-width: 900px; margin: 0 auto; }}
  h1 {{
    font-size: 28px; font-weight: 700; color: #f1f5f9;
    margin-bottom: 8px;
  }}
  .subtitle {{ color: #94a3b8; font-size: 14px; margin-bottom: 32px; }}
  table {{
    width: 100%; border-collapse: collapse;
    background: #1e293b; border-radius: 12px; overflow: hidden;
  }}
  th {{
    text-align: left; padding: 14px 20px;
    font-size: 12px; font-weight: 600; text-transform: uppercase;
    color: #94a3b8; background: #1a2332; letter-spacing: 0.5px;
  }}
  td {{ padding: 12px 20px; font-size: 14px; border-top: 1px solid #2d3a4f; }}
  tr:hover {{ background: #273449; }}
  a {{ color: #7dd3fc; text-decoration: none; }}
  a:hover {{ color: #bae6fd; text-decoration: underline; }}
  .empty {{
    text-align: center; padding: 60px 20px; color: #64748b;
    font-size: 15px;
  }}
  .empty-icon {{ font-size: 48px; margin-bottom: 16px; }}
  .badge {{
    display: inline-block; background: #1e3a5f; color: #7dd3fc;
    padding: 2px 10px; border-radius: 10px; font-size: 12px;
    margin-left: 8px;
  }}
  .footer {{
    margin-top: 32px; text-align: center; color: #475569; font-size: 12px;
  }}
</style>
</head>
<body>
<div class="container">
  <h1>📊 数据报告中心 <span class="badge">{len(reports)} 份报告</span></h1>
  <p class="subtitle">Data Report Center — {REPORT_DIR}</p>

  {"<table><thead><tr><th>报告文件</th><th>大小</th><th>生成时间</th></tr></thead><tbody>" + rows + "</tbody></table>" if reports else '<div class="empty"><div class="empty-icon">📭</div><p>暂无报告 — 在 Claude Code 中完成分析后说"生成报告"即可</p></div>'}

  <p class="footer">Report Server v1.0 · {time.strftime("%Y-%m-%d %H:%M:%S")} · <code>reports/</code></p>
</div>
</body>
</html>"""

        self._send_html(html)

    # ── Helpers ───────────────────────────────────────────────
    def _list_reports(self) -> list[dict]:
        """List all HTML files in REPORT_DIR, newest first."""
        files = []
        for f in sorted(REPORT_DIR.glob("*.html"), key=lambda p: p.stat().st_mtime, reverse=True):
            st = f.stat()
            size = st.st_size
            if size >= 1024 * 1024:
                size_str = f"{size / (1024 * 1024):.1f} MB"
            elif size >= 1024:
                size_str = f"{size / 1024:.0f} KB"
            else:
                size_str = f"{size} B"
            files.append({
                "name": f.name,
                "size": size_str,
                "size_bytes": size,
                "mtime": time.strftime("%Y-%m-%d %H:%M", time.localtime(st.st_mtime)),
                "url": f"/{f.name}",
            })
        return files

    def _send_html(self, html: str, status: int = 200):
        data = html.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_json(self, obj, status: int = 200):
        data = json.dumps(obj, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):
        ts = time.strftime("%H:%M:%S")
        sys.stderr.write(f"[report-server] {ts}  {format % args}\n")
        sys.stderr.flush()


# ── Main ──────────────────────────────────────────────────────────
def main():
    # Ensure mimetypes are initialized (needed for .js, .css, etc.)
    mimetypes.init()

    server = HTTPServer((REPORT_HOST, REPORT_PORT), ReportHandler)
    public_url = detect_public_url()

    print(f"""
╔══════════════════════════════════════════════════════╗
║         📊  Report Server Started                    ║
╠══════════════════════════════════════════════════════╣
║  Listen:    http://{REPORT_HOST}:{REPORT_PORT}                    ║
║  Public:    {public_url}                    ║
║  Directory: {REPORT_DIR}  ║
║  Index:     {public_url}/                     ║
║  Health:    {public_url}/health               ║
║  API:       {public_url}/api/reports          ║
╚══════════════════════════════════════════════════════╝
""")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[report-server] Shutting down...")
        server.shutdown()


if __name__ == "__main__":
    main()
