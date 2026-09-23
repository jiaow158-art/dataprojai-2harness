# 雷达回测 Runbook（M-i1）

## 纪律（§14）

- **手动触发**——不进任何定时任务/CI；每月一条命令，逐月推进 12 个月（无批量模式，裁定 #16）。
- **时间窗**：ETL 完成后、业务高峰前——建议 **08:30-09:00** 或 **19:00 之后**。
- **禁止与晨间扫描同时运行**（§14）：资源争抢 + 当日数未就绪会污染 point-in-time 重放。
- 夜间 ETL 窗（用户裁定 D5）内禁止运行。

## 命令模板（每月一次）

每次校验用**独立 `--out` 文件**（默认值是共享 append 文件，会污染对拍）：

```bash
DWS_PASSWORD=$DWS_PASSWORD python -m insight.backtest \
  --start 2025-10-01 --end 2025-10-31 --out insight/bt-2025-10.jsonl
```

逐月推进（2025-10 → 2026-09 共 12 个月），`--start`/`--end` 各取该月首日/末日（`--end` 含当日）。
DWS_PASSWORD 只走 env，不得写入命令历史或任何文件。

## 确定性对拍

同月二跑（两个不同 `--out` 文件），`sort` 后 `diff` 必须为空：

```bash
DWS_PASSWORD=$DWS_PASSWORD python -m insight.backtest \
  --start 2025-10-01 --end 2025-10-31 --out insight/bt-2025-10-rerun.jsonl
sort insight/bt-2025-10.jsonl > /tmp/a && sort insight/bt-2025-10-rerun.jsonl > /tmp/b
diff /tmp/a /tmp/b    # 期望：无输出
```

非空 → 立即停，查非确定性来源（时间函数/顺序依赖），不得带病推进下月。

## stderr 必须逐条过目

stderr 里的 `status=insufficient_history / not_ready / crash` 行是显式告警，不是噪音：
**jsonl 缺行 ≠ 无异常**（诚实性红线）。每行记下 detector+note，能解释才继续；crash 必须先修再跑。

## 首轮完成后

把 12 个月的 jsonl 产物交给用户抽检——这是 M-i1 exit #8 的阈值校准入口
（norm baseline / threshold 是否合理的业务判断，由抽检结论驱动，不自动调参）。
