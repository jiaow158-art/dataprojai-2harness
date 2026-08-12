# 渠道维度表 — upload_business_analysis_channel_t

## 表概览

| 属性 | 值 |
|------|-----|
| Schema | `upload` |
| 表名 | `upload_business_analysis_channel_t` |
| 行数 | 10 |
| 用途 | **渠道维度的权威映射表**，提供 channel_code→channel_name 的标准化映射 |
| 更新频率 | 低频（主数据类） |

## 列定义

| 列名 | 类型 | 说明 | 示例 |
|------|------|------|------|
| `channel_code` | varchar | 渠道编码 | `GD01`, `GG01` |
| `channel_name` | varchar | 渠道名称 | `国内零售`, `N品牌产品` |
| `channel_type` | varchar | 渠道层级分组 | `整合渠道1`, `整合渠道2` |
| `updater` | varchar | 更新人工号 | `10004102` |
| `dw_last_update_date` | timestamp | 最后更新日期 | `2024-03-11` |

## channel_type 分组

| channel_type | 包含编码 | 对应 Mix 表字段 | 说明 |
|-------------|---------|---------------|------|
| `整合渠道1` | GD01, GD02, GD03 | `integrate_channel` | 一级综合渠道（销售渠道导向） |
| `整合渠道2` | GD04, GG01, GG02, GG03, GG05, GG06, GG08 | `integrate_channel2` | 二级综合渠道（产品导向） |

## 完整渠道枚举

### 整合渠道1（integrate_channel）

| channel_code | channel_name | 说明 |
|-------------|-------------|------|
| GD01 | 零售渠道 | 零售渠道 |
| GD02 | 整装头部 | 整装/头部客户渠道 |
| GD03 | 工程渠道 | 工程渠道 |

### 整合渠道2（integrate_channel2）

| channel_code | channel_name | 说明 |
|-------------|-------------|------|
| GD04 | 特惠品 | 特惠/促销产品 |
| GG01 | N品类产品 | N品类 |
| GG02 | 瓷砖产品 | 瓷砖 |
| GG03 | 大包专供产品 | 大包专供 |
| GG05 | 非设计师产品 | 非设计师渠道 |
| GG06 | 零售产品 | 零售 |
| GG08 | 设计师专供产品 | 设计师专属 |

**注意**：GG04、GG07 在当前表中不存在。GD04 属于整合渠道2（二级渠道），出现在 Mix 表 `integrate_channel2` 字段中，不在 `integrate_channel` 中。

## 关联方式

### 一级渠道：`integrate_channel = channel_code`

```sql
-- 为 Mix 表结果补渠道名称
SELECT m.integrate_channel,
       c.channel_name,
       SUM(m.ambperformance) as actual
FROM dm.dm_fin_operations_mix_sum_t m
LEFT JOIN upload.upload_business_analysis_channel_t c
  ON m.integrate_channel = c.channel_code
 AND c.channel_type = '一级渠道1'
WHERE m.calmonth = '2026-05'
  AND m.node_desc2 = '瓷砖事业部'
  AND m.data_source IN ('S', 'T', 'D', '')
GROUP BY m.integrate_channel, c.channel_name
ORDER BY actual DESC;
```

### 二级渠道：`integrate_channel2 = channel_code`

```sql
SELECT m.integrate_channel2,
       c.channel_name,
       SUM(m.ambperformance) as actual
FROM dm.dm_fin_operations_mix_sum_t m
LEFT JOIN upload.upload_business_analysis_channel_t c
  ON m.integrate_channel2 = c.channel_code
 AND c.channel_type = '一级渠道2'
WHERE m.calmonth = '2026-05'
  AND m.node_desc2 = '瓷砖事业部'
  AND m.data_source IN ('S', 'T', 'D', '')
GROUP BY m.integrate_channel2, c.channel_name
ORDER BY actual DESC;
```

## 与 Mix 表内置字段的关系

Mix 表 `integrate_channel__t` 字段已包含一级渠道描述，**绝大多数场景直接用 Mix 表内置字段即可**，无需 JOIN 本表：

```sql
-- 推荐：直接用 Mix 表内置描述
SELECT integrate_channel, integrate_channel__t, SUM(ambperformance) as actual
FROM dm.dm_fin_operations_mix_sum_t
WHERE ...

-- 仅在以下场景使用 channel 维表：
-- 1. 二级渠道需要描述时（integrate_channel2__t 覆盖率不如本表完整）
-- 2. 需要 GD04 等 Mix 表少见的渠道描述
-- 3. 需要统一的渠道名称标准化
```

## 三套渠道体系决策指引

Mix 表有三个独立的渠道字段，适用场景不同：

| 字段 | 值数 | 性质 | 适用场景 |
|------|------|------|---------|
| `integrate_channel` (整合渠道1) | 3 | 销售渠道导向 | 问"按渠道看业绩"的默认起点 |
| `integrate_channel2` (整合渠道2) | 7 | 产品导向 | 问"按产品渠道/产品类型看" |
| `distr_chan` (分销渠道) | 7 | 客户/业务模式导向 | 问"经销vs零售vs工程"的SAP原始口径 |

**常见混淆**：`integrate_channel` GD01="零售渠道" vs `distr_chan` 02="零售" 是不同口径的"零售"。整合渠道是业务整合后的分组，分销渠道是 SAP 原始分类。

**当用户说"渠道"时，必须确认指哪个维度。**

## 已知陷阱

1. **GG04、GG07 缺失**：维表中不存在这两个编码，如果 Mix 表出现对应数据，渠道名会显示 NULL。
2. **Mix 表已有 `integrate_channel__t`**：一级渠道直接用 Mix 内置字段，本表主要用于二级渠道。
3. **`integrate_channel2__t` 字段**：Mix 表部分行有 `integrate_channel2__t` 值（如 N品类产品/大包专供产品等），但覆盖率不如本表完整。
4. **更新日期为 2024-03**：渠道定义是主数据类，长期稳定，更新日期较早不影响使用。
5. **三套渠道体系并存**：`integrate_channel`、`integrate_channel2`、`distr_chan` 三者口径不同，详见上方决策指引。
6. **GD04 属于整合渠道2**：GD04 不在 `integrate_channel` 字段中，只在 `integrate_channel2` 中出现。
