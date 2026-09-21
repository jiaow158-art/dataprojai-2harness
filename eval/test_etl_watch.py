# etl_watch 测试——PJob 解析 / 清单 diff / 知识交叉 / 日报。全部 fixture 内联，不碰真镜像。
import json
import os

import pytest

from eval.etl_watch import (
    Manifest, diff_manifests, discover_pjobs, knowledge_refs, parse_job, build_report,
)

SAMPLE_JOB = """-- HIVE sql
-- ******************************************************************** --
-- author: DP_10002375
-- create time: 2024/11/05 11:44:29 GMT+08:00
-- description:注明脚本业务含义
-- history list:
-- UPDATE FROM 88888 20250301 增加分摊比例字段
-- ******************************************************************** --
set hive.cbo.enable=true;
with tmpp as (
SELECT
 T.STAT_MONTH --年月
,T.SITE_CODE --基地编码
,SUM(T.AMO_RATE) AS AMO_RATE --分摊比例
,SUM(T.PCS_COST_TOTAL_AMT) AS PCS_COST_TOTAL_AMT--成本合计(无空格注释)
FROM sdi.sdi_loc_comp_relate_1036 t
WHERE t.flag = '1'
)
INSERT OVERWRITE TABLE dm.dm_pam_base_cost_detail_t
SELECT * FROM tmpp
JOIN dwi.dwi_md_material_general_t m ON t.material_num = m.material_num;
"""

SAMPLE_KNOWLEDGE = """# 某域语义层
库存金额用 `dm.dm_fin_stock_detail_accage_t_2023`，字段 `zsjkcje`。
```sql
SELECT SUM(zsjkcje) FROM dm.dm_fin_stock_detail_accage_t_2023 WHERE calmonth='202605'
```
另见 dwrfin.dwr_fin_cost_d_compre_subj_t 的 `local_currency_amt`。
"""


@pytest.fixture()
def mirror(tmp_path):
    (d := tmp_path / "DM" / "DM_CT").mkdir(parents=True)
    (d / "PJob_DM_PAM_BASE_COST_DETAIL_T.txt").write_text(SAMPLE_JOB, encoding="utf-8")
    (d / "PJob_DM_PAM_BASE_COST_DETAIL_T.metadata.json").write_text(
        json.dumps({"name": "PJob_DM_PAM_BASE_COST_DETAIL_T", "type": "HiveSQL"}), encoding="utf-8")
    return tmp_path


@pytest.fixture()
def skills(tmp_path):
    d = tmp_path / "skills" / "demo-knowledge" / "references"
    d.mkdir(parents=True)
    (d / "metrics.md").write_text(SAMPLE_KNOWLEDGE, encoding="utf-8")
    return tmp_path


def test_parse_job_extracts_sources_fields_history():
    job = parse_job(SAMPLE_JOB)
    assert job["target_hint"] == "dm_pam_base_cost_detail_t"  # INSERT OVERWRITE 表
    assert "sdi.sdi_loc_comp_relate_1036" in job["sources"]
    assert "dwi.dwi_md_material_general_t" in job["sources"]
    # 字段注释：裸列 + 别名（含无空格形态）
    assert job["fields"]["STAT_MONTH"] == "年月"
    assert job["fields"]["AMO_RATE"] == "分摊比例"
    assert job["fields"]["PCS_COST_TOTAL_AMT"] == "成本合计(无空格注释)"
    assert job["history"] and "88888" in job["history"][0]
    assert job["author"] == "DP_10002375"


def test_discover_pjobs_pairs_txt_with_target(mirror):
    jobs = discover_pjobs(mirror)
    assert len(jobs) == 1
    assert jobs[0]["target_table"] == "dm_pam_base_cost_detail_t"  # 文件名即目标表
    assert jobs[0]["layer"] == "DM"


def test_manifest_diff_detects_change_new_delete(mirror):
    m1 = Manifest.build(mirror)
    p = mirror / "DM" / "DM_CT" / "PJob_DM_PAM_BASE_COST_DETAIL_T.txt"
    (mirror / "DM" / "DM_CT" / "PJob_DM_NEW_TABLE_T.txt").write_text("INSERT OVERWRITE TABLE dm.dm_new_table_t SELECT 1", encoding="utf-8")
    p.write_text(SAMPLE_JOB.replace("flag = '1'", "flag = '2'"), encoding="utf-8")
    m2 = Manifest.build(mirror)
    p.unlink()
    (mirror / "DM" / "DM_CT" / "PJob_DM_NEW_TABLE_T.txt").unlink()
    m3 = Manifest.build(mirror)
    d2 = diff_manifests(m1, m2)
    assert "DM/DM_CT/PJob_DM_PAM_BASE_COST_DETAIL_T.txt" in d2["changed"]
    assert any(j.endswith("PJob_DM_NEW_TABLE_T.txt") for j in d2["added"])
    d3 = diff_manifests(m2, m3)
    assert len(d3["deleted"]) == 2


def test_knowledge_refs_extracts_tables_and_fields(skills):
    refs = knowledge_refs(skills)
    dom = refs["demo"]
    assert "dm.dm_fin_stock_detail_accage_t_2023" in dom["tables"]
    assert "dwrfin.dwr_fin_cost_d_compre_subj_t" in dom["tables"]
    assert "zsjkcje" in dom["fields"]
    assert "local_currency_amt" in dom["fields"]


def test_build_report_maps_changes_to_knowledge(mirror, skills):
    m1 = Manifest.build(mirror)
    p = mirror / "DM" / "DM_CT" / "PJob_DM_PAM_BASE_COST_DETAIL_T.txt"
    p.write_text(SAMPLE_JOB.replace("成本合计", "成本总额(改)"), encoding="utf-8")
    m2 = Manifest.build(mirror)
    # 知识引用的是库存表，与变更的 pam 表无交集 → 无触点
    rep = build_report(diff_manifests(m1, m2), discover_pjobs(mirror), knowledge_refs(skills))
    assert [t for t in rep["touchpoints"] if t["domains"]] == []  # 无知识触点（变更仍在列表作可见性）
    # 再让知识引用 pam 表 → 出触点
    (skills / "skills" / "demo-knowledge" / "references" / "metrics.md").write_text(
        SAMPLE_KNOWLEDGE + "\n成本表 dm.dm_pam_base_cost_detail_t 字段 pcs_cost_total_amt。\n", encoding="utf-8")
    rep2 = build_report(diff_manifests(m1, m2), discover_pjobs(mirror), knowledge_refs(skills))
    assert len(rep2["touchpoints"]) == 1
    tp = rep2["touchpoints"][0]
    assert tp["table"] == "dm_pam_base_cost_detail_t"
    assert tp["domains"] == ["demo"]
    assert tp["kind"] == "changed"
    md = rep2["markdown"]
    assert "dm_pam_base_cost_detail_t" in md and "demo" in md


def test_deleted_job_flags_table_offline(mirror, skills):
    m1 = Manifest.build(mirror)
    (mirror / "DM" / "DM_CT" / "PJob_DM_PAM_BASE_COST_DETAIL_T.txt").unlink()
    (mirror / "DM" / "DM_CT" / "PJob_DM_PAM_BASE_COST_DETAIL_T.metadata.json").unlink()
    rep = build_report(diff_manifests(m1, Manifest.build(mirror)), [], knowledge_refs(skills))
    assert any(t["kind"] == "deleted" for t in rep["touchpoints"]) or "deleted" in rep["markdown"]
