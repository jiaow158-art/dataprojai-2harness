"""etl_watch — 知识健康监测（H1，spec 2026-09-21-knowledge-health-governance-design §二）。

数据流：ETL 镜像目录（用户周期抓取覆盖式更新，缺省 huaweiclaude/）
  → 内容哈希清单 diff（变更/新增/删除 PJob）
  × 知识引用图（skills/**/references + SKILL.md 里的表/字段）
  → 健康日报：上游变更触及哪些域哪些知识点；删除的 PJob = 表疑似下线红色告警。

用法：
  python eval/etl_watch.py                       # 增量（与上次状态比）；首次=建基线
  python eval/etl_watch.py --full                # 全量交叉报告（不做 diff 判定）
  python eval/etl_watch.py --mirror <dir> --state <json> --out <md>
状态：缺省 eval_results/.etl-watch-state.json；日报缺省 eval_results/pilot/etl-health-<date>.md
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from datetime import datetime

PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_MIRROR = os.path.join(PROJ, "huaweiclaude")
DEFAULT_STATE = os.path.join(PROJ, "eval_results", ".etl-watch-state.json")
DEFAULT_OUT_DIR = os.path.join(PROJ, "eval_results", "pilot")
DEFAULT_SKILLS = os.path.join(PROJ, "skills")

_FROM_JOIN_RE = re.compile(r"(?is)(?:\bfrom\b|\bjoin\b)\s+([a-z_][\w$]*(?:\.[a-z_][\w$]*)?)")
_TARGET_RE = re.compile(r"(?is)(?:insert\s+(?:overwrite\s+)?table|create\s+table(?:\s+if\s+not\s+exists)?)\s+([a-z_][\w$]*(?:\.[a-z_][\w$]*)?)")
# SELECT 字段注释：裸列 `T.COL --注释` 与别名 `... AS ALIAS --注释`（含无空格形态）
_FIELD_ALIAS_RE = re.compile(r"(?im)^[,\s(]*[\w.*]+\s*(?:as\s+)?(\w+)\s*(?:--[ \t]*(.+))?\s*,?\s*$")
_SQL_COMMENT_RE = re.compile(r"--([^\n]*)")
_HEADER_AUTHOR_RE = re.compile(r"(?m)^--\s*author:\s*(\S+)")
_HISTORY_RE = re.compile(r"(?m)^--\s*UPDATE\s+FROM\s+(.+)$")
# 知识文档中的 schema.table 引用（反引号或 SQL 块中）
_KT_TABLE_RE = re.compile(r"\b((?:dm|dwrfin|dwrdim|dwimd|upload|dwi|dwifin|dwrotd|sdi)\.[a-z_][a-z_0-9]*)\b", re.I)
_KT_BACKTICK_FIELD_RE = re.compile(r"`([a-z_][a-z_0-9]*)`", re.I)


def _norm_table(t: str) -> str:
    return t.strip().strip(";,()").lower()


def parse_job(txt: str) -> dict:
    """PJob HiveSQL → {target_hint, sources, fields, author, history}。"""
    body = re.sub(r"(?s)/\*.*?\*/", "", txt)
    target = _TARGET_RE.search(body)
    sources = {_norm_table(m) for m in _FROM_JOIN_RE.findall(body)}
    sources.discard("")
    fields: dict[str, str] = {}
    for m in _SQL_COMMENT_RE.finditer(body):
        comment = m.group(1).strip()
        if not comment:
            continue
        # 注释挂在行尾：回看该行前半段取最后一个标识符作字段名
        line_start = body.rfind("\n", 0, m.start()) + 1
        head = body[line_start:m.start()].strip().rstrip(",")
        name = re.search(r"(\w+)\s*$", head)
        if name and re.fullmatch(r"[A-Za-z_]\w*", name.group(1)):
            fields[name.group(1)] = comment
    return {
        "target_hint": (_norm_table(target.group(1)).split(".")[-1] if target else None),
        "sources": sorted(sources),
        "fields": fields,
        "author": (m.group(1) if (m := _HEADER_AUTHOR_RE.search(txt)) else None),
        "history": [m.group(1).strip() for m in _HISTORY_RE.finditer(txt)],
    }


def discover_pjobs(mirror: str) -> list[dict]:
    """镜像 → PJob 列表（txt 为准；metadata.json 存在则并入）。target_table=文件名去前缀。"""
    jobs = []
    for root, _dirs, files in os.walk(mirror):
        for f in files:
            if not f.endswith(".txt"):
                continue
            p = os.path.join(root, f)
            stem = f[:-4]
            m = re.match(r"(?i)p_?job[_-](.+)", stem)
            target = (m.group(1) if m else stem).lower()
            # 文件名常含额外 DWS_ 段（PJob_DWS_DM_X_T）：双候选匹配（target 与去 DWS_ 前缀形态）
            alt = target[4:] if target.startswith("dws_") and len(target) > 4 else target
            rel = os.path.relpath(p, mirror).replace("\\", "/")
            layer = rel.split("/")[0] if "/" in rel else ""
            meta_path = p[:-4] + ".metadata.json"
            meta = {}
            if os.path.exists(meta_path):
                try:
                    meta = json.load(open(meta_path, encoding="utf-8"))
                except (OSError, ValueError):
                    meta = {}
            jobs.append({"path": rel, "target_table": target, "alt_target": alt, "layer": layer, "meta": meta})
    return jobs


class Manifest:
    """内容哈希清单：{相对路径: sha256}。"""

    def __init__(self, entries: dict[str, str]):
        self.entries = entries

    @classmethod
    def build(cls, mirror: str) -> "Manifest":
        entries = {}
        for root, _dirs, files in os.walk(mirror):
            for f in files:
                if not f.endswith(".txt"):
                    continue
                p = os.path.join(root, f)
                rel = os.path.relpath(p, mirror).replace("\\", "/")
                entries[rel] = hashlib.sha256(open(p, "rb").read()).hexdigest()
        return cls(entries)


def diff_manifests(old: Manifest, new: Manifest) -> dict[str, list[str]]:
    changed = sorted(k for k in old.entries if k in new.entries and old.entries[k] != new.entries[k])
    added = sorted(k for k in new.entries if k not in old.entries)
    deleted = sorted(k for k in old.entries if k not in new.entries)
    return {"changed": changed, "added": added, "deleted": deleted}


def knowledge_refs(skills_dir: str) -> dict[str, dict]:
    """skills 下任意深度的 *-knowledge 目录 → {域: {tables:set, fields:set}}。"""
    refs: dict[str, dict] = {}
    for root, dirs, _files in os.walk(skills_dir):
        for entry in sorted(dirs):
            if not entry.endswith("-knowledge"):
                continue
            dom_dir = os.path.join(root, entry)
            domain = entry[: -len("-knowledge")]
            tables: set[str] = set()
            fields: set[str] = set()
            for r2, _d2, fs in os.walk(dom_dir):
                for f in fs:
                    if not (f.endswith(".md") or f == "SKILL.md"):
                        continue
                    txt = open(os.path.join(r2, f), encoding="utf-8", errors="replace").read()
                    tables.update(t.lower() for t in _KT_TABLE_RE.findall(txt))
                    for bt in _KT_BACKTICK_FIELD_RE.findall(txt):
                        if "." not in bt and not bt.lower().startswith(("dm", "dwr")):
                            fields.add(bt.lower())
            refs[domain] = {"tables": tables, "fields": fields}
    return refs


def _job_table(path: str) -> str:
    stem = os.path.basename(path)[:-4]
    m = re.match(r"(?i)p_?job[_-](.+)", stem)
    t = (m.group(1) if m else stem).lower()
    return t.split(".")[-1] if "." in t else t


def _domains_for_table(table: str, refs: dict[str, dict], jobs_by_table: dict[str, dict]) -> list[str]:
    """知识域命中：知识表基名 == 变更表（或其去 DWS_ 前缀形态）。"""
    cands = {table, table[4:]} if table.startswith("dws_") and len(table) > 4 else {table}
    return sorted(d for d, r in refs.items()
                  if any(t.split(".")[-1] in cands for t in r["tables"]))


def build_report(diff: dict, jobs: list[dict], refs: dict[str, dict]) -> dict:
    """变更集 × 知识引用 → 触点列表 + markdown。"""
    by_table: dict[str, dict] = {j["target_table"]: j for j in jobs}
    touchpoints = []
    for kind in ("changed", "added", "deleted"):
        for path in diff.get(kind, []):
            table = _job_table(path)
            domains = _domains_for_table(table, refs, by_table)
            touchpoints.append({"kind": kind, "table": table, "path": path,
                                "domains": domains, "layer": by_table.get(table, {}).get("layer", "")})
    lines = ["# ETL 健康日报", "",
             f"- 变更 {len(diff.get('changed', []))} · 新增 {len(diff.get('added', []))} · 删除 {len(diff.get('deleted', []))}",
             f"- 触及知识域的变更：{sum(1 for t in touchpoints if t['domains'])} 条", ""]
    for t in touchpoints:
        if t["kind"] == "deleted":
            lines.append(f"- 🔴 **表疑似下线**：`{t['table']}` 的 PJob 被删除"
                         + (f" —— 知识引用：{', '.join(t['domains'])}" if t["domains"] else "（无知识引用）"))
        elif t["domains"]:
            lines.append(f"- ⚠️ `{t['table']}` 上游{ '变更' if t['kind'] == 'changed' else '新增' }"
                         f" → 复核 {', '.join(t['domains'])} 的知识点（{t['path']}）")
    return {"touchpoints": touchpoints, "markdown": "\n".join(lines) + "\n"}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="知识健康监测（ETL 镜像 diff × 知识引用）")
    ap.add_argument("--mirror", default=DEFAULT_MIRROR)
    ap.add_argument("--skills", default=DEFAULT_SKILLS)
    ap.add_argument("--state", default=DEFAULT_STATE)
    ap.add_argument("--out-dir", default=DEFAULT_OUT_DIR)
    ap.add_argument("--full", action="store_true", help="全量模式：不做 diff 判定，输出全量交叉覆盖")
    args = ap.parse_args(argv)

    manifest = Manifest.build(args.mirror)
    jobs = discover_pjobs(args.mirror)
    refs = knowledge_refs(args.skills)

    if args.full or not os.path.exists(args.state):
        mode = "全量（基线）" if not args.full else "全量"
        # 全量：知识引用的每张表是否在镜像中有 PJob（覆盖面视角，含 DWS_ 前缀双候选）
        have = {j["target_table"] for j in jobs} | {j["alt_target"] for j in jobs}
        rows = []
        for domain, r in sorted(refs.items()):
            for t in sorted(r["tables"]):
                rows.append((domain, t, t.split(".")[-1] in have))
        md = ["# ETL 健康全量报告（基线）", "",
              f"- 镜像 PJob {len(jobs)} 个；知识引用表 {len(rows)} 处，其中 "
              f"{sum(1 for *_, ok in rows if ok)} 处在镜像有对应 PJob、"
              f"{sum(1 for *_, ok in rows if not ok)} 处无（可能是源系统表或未收录）", ""]
        for domain, t, ok in rows:
            md.append(f"- {'✅' if ok else '▫️'} `{t}` ← {domain}")
        rep_md = "\n".join(md) + "\n"
        json.dump({"entries": manifest.entries}, open(args.state, "w", encoding="utf-8"))
        print(f"[etl-watch] 基线清单已写 {args.state}（{len(manifest.entries)} 个 PJob，{mode}）")
    else:
        prev = Manifest(json.load(open(args.state, encoding="utf-8"))["entries"])
        diff = diff_manifests(prev, manifest)
        rep = build_report(diff, jobs, refs)
        rep_md = rep["markdown"]
        json.dump({"entries": manifest.entries}, open(args.state, "w", encoding="utf-8"))
        print(f"[etl-watch] diff：变更 {len(diff['changed'])} / 新增 {len(diff['added'])} / 删除 {len(diff['deleted'])}"
              f"；触及知识 {sum(1 for t in rep['touchpoints'] if t['domains'])} 条")

    os.makedirs(args.out_dir, exist_ok=True)
    out = os.path.join(args.out_dir, f"etl-health-{datetime.now():%Y%m%d}.md")
    with open(out, "w", encoding="utf-8") as f:
        f.write(rep_md)
    print(f"[etl-watch] 日报 → {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
