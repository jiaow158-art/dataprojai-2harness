# 受控执行环境依赖清单（v1，来自金样轨迹）

> 依据：`m0/golden/trace.md` 的管线判定——金样出自 `skills/report-generator/` 管线。
> 脚本依赖读取自 `build.py` / `validate_report.py` 的 import 与文件引用、`report-shell.html` 的字体/资源声明。
> 本机实测（2026-09-08，Windows 10 + Git Bash）：Python 3.12.7、Node v24.14.0。

## Python

- **Python 3.9+**（build.py 声明"零依赖，Python 3.9+"；开发机实测 3.12.7）
- pip 包：**无** —— 构建链纯标准库（生产约束"纯标准库、零硬编码路径"）
- 标准库模块（逐一对源码 import 核实）：
  - `build.py`：argparse, datetime, html, json, os, sys, urllib.request + 本地模块 `validate_report`
  - `validate_report.py`：argparse, json, os, re, shutil, subprocess, sys, tempfile
  - （历史参考 `build_report.py` 同样仅 json/os/socket，不在现役链路）

## Node（可选）

- `node --check`：validate_report.py 构建后 HTML 内联 JS 语法检查；`shutil.which("node")` 探测，**不存在则自动跳过**（`--no-node` 可显式关闭）
- 版本无硬要求；本机 v24.14.0 实测可用。沙箱最小化可不装 Node

## 本地资产（只读，确切路径）

| 文件 | 用途 |
|---|---|
| `skills/report-generator/templates/report-shell.html` | 模板（占位符 `{{REPORT_TITLE}}` `{{REPORT_META}}` `{{ECHARTS_LIB}}` `{{REPORT_JSON}}`） |
| `skills/report-generator/templates/echarts.min.js` | ECharts 5.5.0 内联注入（Apache-2.0，本地文件无 CDN 依赖） |
| `skills/report-generator/references/report-schema.json` | v2.1 校验 schema |
| `skills/report-generator/scripts/build.py` | 构建入口（`python build.py --json report.json [--domain xxx] [--out dir]`） |
| `skills/report-generator/scripts/validate_report.py` | 校验器（build.py 以 `sys.path.insert` 同目录导入） |
| `skills/report-generator/scripts/migrate_scatter_series.py` | 旧 JSON 迁移用（仅当复现涉及 v2.0 旧报告） |

## 数据库访问

- GaussDB (PostgreSQL 兼容) `121.37.200.214:8000`，库 `DP_DWS`，用户 `aiuser`（口令走环境变量 `DWS_PASSWORD`）
- T15 重导真值用 `psycopg2`（仅该任务需要 pip 包 psycopg2-binary；M0 报告构建链本身不需要）
- MCP 工具 `mcp__dws__run_query`（SELECT only，自动 LIMIT 200）可用于小结果验证

## 字体（report-shell.html 实际 font-family，无 Web 字体文件）

- 正文：`-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Helvetica Neue", sans-serif`
- 等宽（数值区）：`"SF Mono", "Cascadia Code", "Menlo", "Consolas", monospace`
- 全部系统字体栈、无 @font-face/外链——中文渲染依赖宿主已装"PingFang SC / Microsoft YaHei"其一；Linux 容器需装文泉驿/Noto CJK 或接受回退

## 命令

- `python3`（报告构建、验证脚本；生产路径 `/usr/bin/python3`）
- `bash`（任务编排）
- `node`（可选，仅语法检查）
- 构建：`python3 skills/report-generator/scripts/build.py --json <report.json> --domain <domain> [--out <dir>]`
- 自检：`python3 skills/report-generator/scripts/build.py --selftest`
- 测试：`python3 -m pytest skills/report-generator/tests/ -v`（开发期，沙箱可省）

## 目录

- 技能资产（只读）：`skills/report-generator/{scripts,templates,references}/`
- 报告输出目录：默认 `reports/`（build.py DEFAULT_OUT，gitignored）；`--out` 可覆盖
- M0 结果目录：`m0/golden/`（本金样）、`m0/verify/`（T14/T15 产物）
- 工作目录：仓库根（build.py 内部用相对自身的绝对路径，不依赖 CWD）
- JSON 输出文件名约定：`report_{domain}_{YYYYMMDD}.html`（金样为 `report_operations_20260905.html`）

## 明确不需要

- 无 npm 包、无 CDN、无外网访问（echarts 本地内联）
- 无数据库驱动依赖（构建链不连库；取数在 Agent/dsh 侧完成）
- 无字体文件部署
