# Report Generator 可靠性重构设计

- **日期**：2026-08-17
- **目标**：消灭报表生成的白屏/转义翻车（问题1）、建立 schema 契约（问题5）、验证闭环（问题3）
- **非目标**：脚本堆积清理（问题2）、server 运维/跨平台启动（问题4）——只留接口不实施
- **决策记录**：可靠性优先（A）× 纯 JSON 彻底切换（A）× 方案二（builder + validator）

## 0. 全局约束：生产服务器兼容性

| 项 | 承诺 |
|---|---|
| 依赖 | 纯 Python 标准库，零新增 pip 依赖。本地已装 jsonschema 也不用，避免环境漂移 |
| Python 版本 | 3.9+（与 dws_mcp_server.py 基准一致）：禁用 match / X\|Y / tomllib 等新语法 |
| 路径 | 一律 `os.path.dirname(os.path.abspath(__file__))` 相对定位，零硬编码路径。同一份代码 Windows 开发机 / Linux 生产机（/home/dp-user/dataprojv2）直接跑 |
| node 检查 | 可选：有 node 则 `node --check` 内联 JS，无则跳过。Python 正则黑名单始终强制 |
| 部署 | git commit → push GitHub → 服务器 git pull，零手工步骤 |
| 生产自验 | `python3 skills/report-generator/scripts/build.py --selftest` 一条命令验收全链路 |

## 1. 格式声明语言（协议核心）

chart option 不再写任何 JS 函数。两个声明字段：

```json
"valueFormat": "yi:1",
"tooltipTemplate": "multi"
```

7 种值格式（`"``:N"`` 后缀=小数位）：

| 声明 | 输出示例 | 默认小数位 |
|---|---|---|
| `yi` | 5.05亿 | 2（yi:1→1, yi:0→0） |
| `wan` | 4,728万 | 0（带千分位） |
| `percent` | 26.2% | 1 |
| `signed_percent` | +6.9% / -19.3% | 1 |
| `sqm_wan` | 120.5万㎡ | 1 |
| `yuan` | 334,080,608元 | 千分位整数 |
| `wan:1` 等组合 | 同规则 | 按后缀 |

`tooltipTemplate`：`multi`（多系列：`月份<br/>● 实际: 5.05亿`）/ `pie`（`名称: 3.4亿 (26%)`）。默认 `multi`。

非法值 → validator 报错（带字段路径），模板端 `.chart-error` 快速失败并 console.warn。饼图 percent、markLine 均值等特殊 label 由格式工厂内置处理，无需声明。

## 2. 模板改造（templates/report-shell.html）

改动收敛在渲染 JS（431-870 行区域），HTML/CSS 不动：

1. 删除 `reviveFunctions()` 及两处 `eval('(' + ... + ')')` 调用
2. 新增 `formatFactory(valueFormat, decimals)` → `{ axisLabelFormatter, tooltipFormatter, labelFormatter }`；option 合并后检测 `ch.valueFormat` 注入 `axisLabel/tooltip/label`，`ch.tooltipTemplate` 控制 tooltip 样式
3. 快速失败：非法 valueFormat → 容器显示 `.chart-error`；JSON 解析失败 → 页面顶部红条（保留现有机制）
4. `formatNumbers`（表格千分位）保留不动
5. 模板尾部加 `window.__REPORT_VALID__ = true`（validator 检查点）

兼容性：HTML 自包含，历史报告零影响。`{{REPORT_JSON}}` 内容为纯 JSON，`json.dumps(ensure_ascii=False)` 一次成型无后处理。

## 3. 验证闭环

### report-schema.json（skills/report-generator/references/）

- 顶层必填 `title/kpis/insight/sections/provenance`
- `kpis[]`：必填 `label/value`；`direction` 枚举 `up/down/neutral`
- `sections[]`：必填 `id/tab/type`；`type` 枚举 `chart-with-analysis/table`
- `chart-with-analysis` → `chart + analysis[]`（`label/color/text`，color 枚举 `blue/pink/cyan`）
- `table` → `columns/rows`
- `provenance.query` 必填非空

### validate_report.py（skills/report-generator/scripts/，纯标准库）

```
用法: python validate_report.py <report.json | report.html>
  1. JSON 可解析（HTML 输入先抽 {{REPORT_JSON}} 段）
  2. schema 校验（手写校验器 ~80 行，无 jsonschema 依赖）
  3. 黑名单：eval( / function( / \" 函数痕迹 → "旧函数格式已废弃 → 改用 valueFormat"
  4. 占位符残留检查（{{REPORT_JSON}} 等 4 类，HTML 输入）
  5. 结构检查：≥1 chart section、chart 有 valueFormat、kpis 非空、id 唯一
  6. 大小：HTML ≤5MB、单 chart 数据点 ≤200
  6b. 内联 JS 语法（node 存在则 --check，否则跳过）+ __REPORT_VALID__ 检查点
```

失败输出带字段路径，exit code 非 0。

### 测试布局

- `pytest.ini` → `testpaths = skills/report-generator/tests scripts`（修复指向幽灵目录 webapp/tests）
- `scripts/test_report.py` → `skills/report-generator/tests/test_report_builder.py`，输出进 `reports/test_*.html`（已 gitignore）
- 新增 `test_validate_report.py`：①合规 JSON 过 ②缺 provenance.query / 非法 direction / 旧函数格式各自报错 ③端到端：JSON → build → 校验 → HTML 含 __REPORT_VALID__

## 4. 统一 builder（build.py）

位置：`skills/report-generator/scripts/build.py`

```
python3 build.py --json report.json [--domain sales-performance] [--out reports/]
python3 build.py --selftest
```

流程：读 JSON → **validator 强制前置**（不过即止）→ 组装（模板+echarts 替换 4 占位符）→ 写 `reports/report_{domain}_{YYYYMMDD}.html` → 打印路径（health 通则附 URL，不通只给路径）。

`--selftest`：内置最小合规样例 → 完整 build+validate → 断言 HTML 含 `__REPORT_VALID__` 无占位符残留 → `SELFTEST PASS`。

SKILL.md Step 6 收编为"写 report.json → build.py --json"（~60 行教战守则 → ~10 行）。7 个一次性脚本本轮**只标注废弃**（文件头注释 + SKILL.md 归档说明），不物理删除。

## 5. 错误处理

| 故障 | 行为 |
|---|---|
| report.json 非法 JSON / schema 不过 | validator 逐条 [FAIL] 带字段路径，builder 中止，exit 1 |
| valueFormat 非法 | validator 拦截；漏网则模板 .chart-error 显示在图表区 |
| echarts.min.js 缺失 | builder 明确报错退出 |
| node 不存在 | 语法检查跳过（黑名单正则已强制） |
| server 未起 | 只打印本地路径 + 启动指引一行，不输出假 URL |

## 6. 测试与验收

1. `pytest skills/report-generator/tests/` 全绿
2. `python3 build.py --selftest` 在 Windows 开发机与 Linux 生产服务器均输出 SELFTEST PASS
3. 用真实数据（瓷砖 2026-01~05 达成趋势）生成一份报告，浏览器打开图表/表格/分析/溯源全渲染，无白屏无 console 错误
4. 负路径：旧函数格式 JSON → validator 拦截并给出可执行修复建议

## 7. 交付物清单

| 文件 | 动作 |
|---|---|
| `skills/report-generator/templates/report-shell.html` | 改造（删 eval、加 formatFactory、加 __REPORT_VALID__） |
| `skills/report-generator/references/report-schema.json` | 新增 |
| `skills/report-generator/scripts/validate_report.py` | 新增（纯标准库） |
| `skills/report-generator/scripts/build.py` | 新增（含 --selftest） |
| `skills/report-generator/tests/test_report_builder.py` | 迁移+修复 scripts/test_report.py |
| `skills/report-generator/tests/test_validate_report.py` | 新增 |
| `skills/report-generator/SKILL.md` | 重写 Step 3/6，删转义警告，加 build.py 用法与格式声明表 |
| `pytest.ini` | testpaths 修正 |
| `build_report.py` + `scripts/*_report*.py`（7个） | 文件头加废弃注释（不删除） |
