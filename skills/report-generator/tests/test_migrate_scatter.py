"""migrate_scatter_series 单测：单 series 多命名点散点 → 每产品独立 series。"""
import migrate_scatter_series as mig  # conftest 已注入 scripts/


def _quadrant():
    return {"tooltip": {"trigger": "item"},
            "series": [{"name": "系列", "type": "scatter",
                        "data": [{"name": "素色", "value": [32.2, 36.0], "symbolSize": 60},
                                 {"name": "质臻", "value": [-5.9, 44.8], "symbolSize": 47}],
                        "markLine": {"symbol": "none", "data": [{"xAxis": 0}, {"yAxis": 40}]}}]}


def test_split_named_scatter_into_series():
    opt = _quadrant()
    assert mig.migrate_chart(opt) is True
    sers = opt["series"]
    assert len(sers) == 2
    assert [s["name"] for s in sers] == ["素色", "质臻"]
    assert sers[0]["data"] == [{"value": [32.2, 36.0], "symbolSize": 60}]
    assert sers[1]["data"] == [{"value": [-5.9, 44.8], "symbolSize": 47}]
    assert sers[0]["markLine"]["data"] == [{"xAxis": 0}, {"yAxis": 40}]  # 分割线挂第一个
    assert "markLine" not in sers[1]
    assert opt.get("color")  # 拆分后自动补 10 色板


def test_no_change_for_per_product_series():
    opt = {"series": [{"name": "素色", "type": "scatter",
                       "data": [{"value": [1, 2], "symbolSize": 10}]}]}
    assert mig.migrate_chart(opt) is False
    assert len(opt["series"]) == 1


def test_no_change_for_unnamed_points():
    opt = {"series": [{"name": "s", "type": "scatter", "data": [[1, 2], [3, 4]]}]}
    assert mig.migrate_chart(opt) is False


def test_keeps_non_scatter_series():
    opt = {"series": [{"name": "bar", "type": "bar", "data": [1]},
                      {"name": "系列", "type": "scatter",
                       "data": [{"name": "A", "value": [1, 2], "symbolSize": 5},
                                {"name": "B", "value": [3, 4], "symbolSize": 6}]}]}
    assert mig.migrate_chart(opt) is True
    assert opt["series"][0]["name"] == "bar"
    assert len(opt["series"]) == 3


def test_migrate_full_report_counts_charts():
    data = {"sections": [
        {"id": "a", "type": "chart-with-analysis",
         "chart": [{"id": "c1", "title": "t", "valueFormat": "signed_percent:1", "option": _quadrant()},
                   {"id": "c2", "title": "t", "valueFormat": "signed_percent:1", "option": _quadrant()}]},
        {"id": "b", "type": "table", "table": {"columns": ["A"], "rows": [["1"]]}}]}
    assert mig.migrate(data) == 2
