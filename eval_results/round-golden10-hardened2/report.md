# Agent Eval · golden10-hardened2

- 网关：直连 http://127.0.0.1:58080　|　环境指纹：code_sha=`92e3a2201c`　model=deepseek-v4-flash
- 场景：5（缓存复跑 0 / 实跑 5）　|　汇总时间：2026-09-20T11:40:16+08:00

## 总览

| 指标 | 值 |
|---|---|
| PASS | 4 |
| FAIL | 0 |
| SKIP（真值重导失败） | 0 |
| DATA_DRIFT（dataset 漂移注记，非引擎失败） | 1 |
| 通过率（全部） | 0.8 |
| 通过率（剔除 SKIP） | 0.8 |
| 估算成本 | ¥1.0377（单价 CNY/1M tokens: {'input': 2.0, 'output': 8.0, 'cache_read': 0.5}，估算口径） |

## 按域

| 域 | 总数 | PASS | FAIL | SKIP | DRIFT | 通过率(剔SKIP) |
|---|---|---|---|---|---|---|
| inventory | 2 | 2 | 0 | 0 | 0 | 1.0 |
| otd-fulfillment | 2 | 1 | 0 | 0 | 1 | 0.5 |
| sales-performance | 1 | 1 | 0 | 0 | 0 | 1.0 |

## 失败分类分布

无 FAIL。

> 口径注记：失败分类词表中的「日期格式错」为**注记类**——judge 对同日不同格式只落 notes，failure_class 不会取该值（T1 定型）。
> DATA_DRIFT = dataset.data 与期望 SQL fresh 重导不一致（数据漂移），对照以 fresh 为准，不算引擎失败；SKIP = 真值重导失败（DWS 错误），保留引擎失败信号但不判数据。

## DATA_DRIFT 清单（1）

- `ff90bc18ec78` otd-fulfillment 2026年5月瓷砖事业部订单行的出库率

## 成本（tokens 累计与估算）

- tokens：input=177,074　output=29,054　cache_read=902,144（来自 done.tokens，5/5 场景有上报，null 计 0）
- 估算：¥1.0377（单价 CNY/1M tokens：input=2.0 output=8.0 cache_read=0.5，env EVAL_PRICE_* 可覆盖；用于轮间相对比较）

| 域 | input | output | cache_read | 估算¥ |
|---|---|---|---|---|
| inventory | 62,052 | 8,042 | 249,472 | 0.3132 |
| otd-fulfillment | 76,781 | 10,554 | 430,080 | 0.4530 |
| sales-performance | 38,241 | 10,458 | 222,592 | 0.2714 |

