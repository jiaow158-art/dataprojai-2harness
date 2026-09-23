# insight/dws.py
"""只读 DWS 查询通道——DWS Resource Guardrail 的落地（spec §14，裁定 #2/#3/#4）。

双层防护：①session 级 default_transaction_read_only=on（真正的墙）
         ②SQL 白名单仅 SELECT / WITH...SELECT（含全句禁词扫描，拒绝 SHOW 与数据改性 CTE）
异常恢复：查询异常 → rollback 清 aborted；连接失效 → 置 None 下次重建。
某 detector 超时 → 自降级 unavailable → runner 恢复 → 下一个 detector 不受污染。
密钥只走 env；REDACT 供日志侧消毒。
"""
import os
import re
import psycopg2

_FORBIDDEN = re.compile(
    r"\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE|SHOW|GRANT|REVOKE|COPY|SET)\b",
    re.IGNORECASE)

def build_connect_kwargs(app_name: str = "insight-radar",
                         timeout_ms: int = 60000) -> dict:
    return {
        "host": os.environ.get("DWS_HOST", "121.37.200.214"),
        "port": int(os.environ.get("DWS_PORT", "8000")),
        "dbname": os.environ.get("DWS_DBNAME", "DP_DWS"),
        "user": os.environ.get("DWS_USER", "aiuser"),
        "password": os.environ.get("DWS_PASSWORD", ""),
        "application_name": app_name,
        "connect_timeout": 10,
        "options": (f"-c statement_timeout={timeout_ms} "
                    f"-c default_transaction_read_only=on"),
    }

def REDACT(kwargs: dict) -> dict:
    return {k: ("***" if k == "password" else v) for k, v in kwargs.items()}

class DwsQueryRunner:
    def __init__(self, app_name: str = "insight-radar", timeout_ms: int = 60000):
        self._kwargs = build_connect_kwargs(app_name, timeout_ms)
        self._conn = None

    @staticmethod
    def _guard(sql: str) -> None:
        s = sql.lstrip()
        if not (s[:6].upper() == "SELECT" or s[:4].upper() == "WITH"):
            raise ValueError(f"非只读语句（仅允许 SELECT / WITH...SELECT）：{s[:60]}")
        m = _FORBIDDEN.search(s)
        if m:
            raise ValueError(f"SQL 含禁用关键字 {m.group(1)}：{s[:60]}")

    def __call__(self, sql: str, params: dict | None = None) -> list[dict]:
        self._guard(sql)
        if self._conn is None or getattr(self._conn, "closed", 0):
            self._conn = psycopg2.connect(**self._kwargs)
        try:
            with self._conn.cursor() as cur:
                cur.execute(sql, params)
                cols = [d[0] for d in cur.description]
                return [dict(zip(cols, row)) for row in cur.fetchall()]
        finally:
            self._recover()

    def _recover(self) -> None:
        """查询后统一收尾：正常路径 rollback 立即结束只读事务；
        异常路径 rollback 清 aborted；rollback 自身失败 → 弃连接待重建。"""
        try:
            self._conn.rollback()
        except Exception:
            self._conn = None

    def close(self):
        if self._conn is not None:
            self._conn.close(); self._conn = None
