# 工单：问数系统专用受限只读数据库账号（M3 试点前安全前置）

> 申请方：数据分析平台（问数系统）
> 目标库：GaussDB `DP_DWS` @ 121.37.200.214:8000
> 期望完成：M3 内部试点放行前
> 紧急程度：不急生产故障级，但为上线门禁项

## 一、背景（为什么要这个账号）

问数系统（AI 数据分析网关）以 `aiuser` 连接 DWS 查询数据。应用层已做只读约束（MCP 查询接口只放行 SELECT），但**数据库层该账号并非只读**。2026-09-18 元数据实测（只读目录查询，未做任何写入）：

| 检查项 | 实测值 |
|---|---|
| 表级 SELECT 授权 | 2276 张表 |
| **表级 INSERT 授权** | **884 张表** |
| 表级 DELETE / UPDATE / TRUNCATE 授权 | 各 1 张表 |
| 超级用户 / 建号 / 建库权限 | 无 |
| `default_transaction_read_only` | off |

风险：当前防线只有应用层一道。若应用层校验被绕过（未来缺陷或人为直连），数据库不会拒绝写入。纵深防御要求 DB 层独立兜底；同时专用账号可审计、可独立轮换密码。

## 二、诉求清单

新建专用账号 `aiquery_ro`（名称可按贵方命名规范调整）：

1. **强制只读**：`default_transaction_read_only = on`（账号级默认）
2. **只授 SELECT**，范围见 §三 白名单；不授 INSERT/UPDATE/DELETE/TRUNCATE/CREATE 任何对象
3. **连接数上限**：建议 `CONNECTION LIMIT 20`（网关并发 2-3 + 评测余量）
4. **语句超时兜底**：建议账号级 `statement_timeout = 300s`（应用层已有 30s，此为第二道）
5. 密码按贵方密码策略设定，**经安全渠道单独交付申请方**（不进代码/文档/邮件正文）

## 三、Schema 白名单（依据：系统全部 85 个标准查询场景 + 6 域知识库文档的实际引用面）

**建议授予（USAGE + SELECT ON ALL TABLES）：**

| Schema | 用途 | 引用频次（知识文档/期望 SQL） |
|---|---|---|
| `dm` | 域事实表/维表主面（财务宽表、OTD 四表、SKU、销售业绩等） | 最多（期望 SQL 76 处） |
| `dwrfin` | 财务综合/毛利明细 | 13-41 处 |
| `dwrdim` | 客户/公司维度 | 知识文档关联注记 |
| `dwimd` | 物料主数据 | 1-7 处 |
| `upload` | 整合渠道维度（OTD 域） | 9 处 |

**待贵方裁定（知识文档有引用，属 DWR 明细层，若认定可下线可不授）：**
`dwifin`（费用中心/阿米巴明细 2 表）、`dwrotd`（发运单/产销出入库 2 表）

**明确不授：** `sdi`（SAP 原始接入层，仅血缘注记引用）、`dwi`*（接入层）、以及任何 `_bak/_tmp/_wjh/_01/_close/_2024*` 后缀的备份临时表（表级如有批量授予工具请注意排除）。

## 四、参考 SQL（GaussDB 兼容形态，请按实际环境调整）

```sql
CREATE USER aiquery_ro PASSWORD '<由DBA设定>' CONNECTION LIMIT 20;
ALTER USER aiquery_ro SET default_transaction_read_only = on;
ALTER USER aiquery_ro SET statement_timeout = '300s';

GRANT USAGE ON SCHEMA dm, dwrfin, dwrdim, dwimd, upload TO aiquery_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA dm, dwrfin, dwrdim, dwimd, upload TO aiquery_ro;
-- （若裁定授予边界 schema，另加对应两行）
-- 后续新建表若需自动跟进，可选：ALTER DEFAULT PRIVILEGES ... IN SCHEMA dm GRANT SELECT ON TABLES TO aiquery_ro;
```

## 五、验收清单（DBA 自验 + 交回后申请方复验）

- [ ] `aiquery_ro` 对白名单 schema 执行 SELECT 成功
- [ ] 对任意表执行 INSERT / UPDATE / DELETE / TRUNCATE 被拒（报权限错误）
- [ ] `SHOW default_transaction_read_only` = on
- [ ] 白名单外 schema（如 sdi/dwi）USAGE 被拒
- [ ] `CREATE TABLE` 被拒
- [ ] 连接数上限生效（可选验证）

## 六、交付物与申请方接入预告

交付：账号名 + 密码（安全渠道）。
接入（申请方执行，零代码改动）：网关启动环境变量切换 `DWS_RUN_USER`/`DWS_RUN_PASSWORD` + dsh profile 模板一行改读环境变量，随后跑一轮完整问数验证（含红队 SQL 写入场景复验）。
