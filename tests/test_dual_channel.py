"""Dual-channel run_query tests: preview for model, full result to file (spec D13)."""
import json, os, sys
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import dws_mcp_server as srv


def _rows(n):
    return [{"sku": f"S{i}", "amt": i} for i in range(n)]


@pytest.fixture
def result_dir(tmp_path, monkeypatch):
    # 注意：RESULT_* 是模块导入时常量，必须 patch 模块属性而非环境变量
    monkeypatch.setattr(srv, "RESULT_DIR", str(tmp_path), raising=False)
    monkeypatch.setattr(srv, "RESULT_PREVIEW_ROWS", 200, raising=False)
    monkeypatch.setattr(srv, "RESULT_DATA_BUDGET_ROWS", 50000, raising=False)
    return tmp_path


def _parse(out):
    return json.loads(out)


def test_preview_limited_full_saved(result_dir, monkeypatch):
    monkeypatch.setattr(srv, "execute_bounded", lambda sql, budget: (_rows(800), False))
    resp = _parse(srv.tool_run_query(sql="SELECT sku, amt FROM t"))
    assert resp["status"] == "ok"
    assert resp["row_count"] == 800            # 实际行数
    assert len(resp["data"]) == 200            # 预览 ≤200
    assert resp["truncated"] is False
    assert resp["result_ref"]                  # 引用存在
    f = result_dir / f"{resp['result_ref']}.json"
    saved = json.loads(f.read_text(encoding="utf-8"))
    assert saved["row_count"] == 800           # 落盘完整
    assert saved["data"] == _rows(800)


def test_over_budget_truncated_no_file(result_dir, monkeypatch):
    monkeypatch.setattr(srv, "execute_bounded", lambda sql, budget: (_rows(60000), True))
    resp = _parse(srv.tool_run_query(sql="SELECT * FROM big"))
    assert resp["truncated"] is True
    assert "聚合" in resp["guidance"]
    assert list(result_dir.glob("*.json")) == []  # 截断数据不落盘


def test_no_autolimit_in_dual_mode(result_dir, monkeypatch):
    seen = {}
    def fake(sql, budget):
        seen["sql"], seen["budget"] = sql, budget
        return _rows(10), False
    monkeypatch.setattr(srv, "execute_bounded", fake)
    srv.tool_run_query(sql="SELECT * FROM t")
    assert "LIMIT" not in seen["sql"].upper()   # 双通道不偷改 SQL
    assert seen["budget"] == 50000


def test_legacy_mode_unchanged(monkeypatch):
    monkeypatch.setattr(srv, "RESULT_DIR", "", raising=False)
    seen = {}
    def fake_sync(sql, params=None):
        seen["sql"] = sql
        return _rows(600), "OK"
    monkeypatch.setattr(srv, "execute_sync", fake_sync)
    resp = _parse(srv.tool_run_query(sql="SELECT * FROM t"))
    assert seen["sql"].endswith("LIMIT 200")    # 旧行为保留
    assert len(resp["data"]) == 500             # 旧顶 500
    assert resp["row_count"] == 500


def test_write_guard_unchanged(result_dir):
    resp = _parse(srv.tool_run_query(sql="DELETE FROM t"))
    assert "error" in resp
