# 口径分歧登记表（Caliber Registry）

> 用途：所有"两表皆可/数值不一致"型口径分歧的**裁决记录**——metrics.md 的路由规则只引用已裁决口径；新分歧先登记、Owner 拍板后入律。
> Owner：v1 = 用户本人（每域可指定）。

## 登记格式

| # | 日期 | 域 | 分歧描述 | 口径 A（数值/出处） | 口径 B（数值/出处） | 裁决 | 裁决人 | 落律位置 |
|---|---|---|---|---|---|---|---|---|
| 1 | 2026-09-17 | inventory | 期末库存总额两表不一 | capital_cost.closing_balance 11.86 亿 | 明细表 zsjkcje 12.43 亿（202608） | 两口径并存：默认明细表 zsjkcje，差值=排 stockcat='K'，答案中声明口径 | 用户（E1 实测确认） | inventory metrics 十节 |
| 2 | 2026-09-20 | fin-cost | 费用总额两表不一 | dm.amount 4.25 亿（报表整合口径） | dwrfin.local_currency_amt 2.59 亿（记账原值，2026-05） | 按 eval_dataset 录制口径路由（T6 §九）；分歧如实写明不替业务拍板 | 待 Owner 终裁 | fin-cost metrics §九 |
| 3 | 2026-09-20 | sku/inventory | 同表两套字段族 | 阿米巴 jchj_aging 3.30 亿 | 管理 jchj_amt 2.88 亿（202607） | 按域路由选字段族（sku 用阿米巴族、inventory 用管理族——各自精确复现录制值） | 记录性裁决（录制口径即裁决） | sku metrics 七节 |
| 4 | 2026-09-20 | sales | ct 表非瓷砖 0 行 | ct_sales_performance_t 仅含瓷砖 org | mix 表全域 | 非瓷砖业绩一律走 mix 自算同比；ct 仅瓷砖同比 | 实测性裁决 | sales metrics 七节 |

## 待裁决队列（新分歧加行到这里，裁决后上移入登记区）
