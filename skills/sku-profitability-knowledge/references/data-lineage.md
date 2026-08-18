# SKU 效益分析 — 血缘与表关联

## 五张核心表

| 表 | 层 | 源 | 刷新 | 粒度 |
|---|---|---|---|---|
| `dm.dm_fin_operations_mix_sum_t` | DM | SAP 销售/成本多源汇入 | 月 | 渠道×品类×物料×月 |
| `dm.dm_product_inout_stock_t` | DM | 仓储出入库 | 月 | 工厂×品牌×物料×月 |
| `dm.dm_fin_stock_d_accage_list_c_t_2023` | DM | 库龄明细表+批次入库日期推账龄（ETL: PJob_DWS_DM_FIN_STOCK_D_ACCAGE_LIST_C_T_2023） | 月（delete-insert by calmonth） | 批次×物料×库存地点×月 |
| `dm.dm_fin_stock_capital_cost_t` | DM | 库存资金成本核算（ETL: PJob_DM_FIN_STOCK_CAPITAL_COST_T，公式 ((期初+期末)/2 − 202012余额) × 4%/12） | 月 | 事业部×公司×工厂×物料×批次×库存地点×库别 |
| `dm.dm_ambv2_chdj_grp_t` | DM | 阿米巴核算体系（ETL: PJob_DM_WS_AMBV2_CHDJ_GRP_T） | 月 | 物料×工厂×渠道×销售组 |

辅助表：`dwimd.dwi_md_data_material_general_t`（物料主数据，新品/品类/产品层次）、`dm.dm_otd_no_deliver_order_dtl_t`（未交付订单，缺货补充口径）。

## 关联键

```
Mix.material_num = 出入库.material_num = 上市口径.material = capital_cost_t.material_num = 主数据.material_num
```

- Mix ↔ 主数据：品类/产品层次/上市日期丰富维度（JOIN 主数据取最新版本）
- Mix ↔ 上市口径：销售侧 ↔ 库存侧（以 Mix 为主集 LEFT JOIN；口径差见 metrics.md 陷阱 1/5）
- 出入库 ↔ 上市口径：动销 ↔ 库存快照（月粒度对齐：start_month ↔ calmonth，**格式不同 YYYY-MM vs YYYYMM**）

## 详细血缘

- Mix：`../../sales-performance-knowledge/references/data-lineage.md`
- 库存族：`../../inventory-knowledge/references/data-lineage.md`
