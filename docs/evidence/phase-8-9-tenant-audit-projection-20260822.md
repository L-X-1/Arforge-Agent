# Step 8.9 后端审查与审计投影修复证据（2026-08-22）

## 发现

开发阶段复核发现，`TenantPlatform.exportAudit()` 原先只读取运行时 `AuditEntryTable`。租户的
policy、key、secret metadata、settled usage、data request 和 backup manifest 虽然已经持久化，
但在没有运行时事件的本地场景中仍会生成 `item_count=0` 的审计回执，用户无法从回执判断租户治理
是否发生过活动。这不符合 Step 8.9 的 audit export 和 safe projection 目标。

## 修复

- 保留现有运行时 audit chain，不改变其 hash 链和事实来源。
- 在导出时按当前 tenant scope 读取已有 durable platform rows，并按稳定顺序组成 safe projection：
  policy、tenant key 状态、secret metadata、settled usage、data request、backup manifest。
- secret 只包含 `secret_id`、版本、fingerprint、状态和时间字段，不读取 ciphertext。
- data request 的用户理由只保留 SHA-256 `reason_digest`，不把理由原文写入导出摘要输入。
- 导出仍只保存 `item_count` 和 `export_digest` receipt，不执行物理删除、真实对象存储备份或发布操作。
- 该修复是对现有 durable 表的导出投影，不创建第二套事件发布器或事件真相。

## 验证

| 检查 | 结果 |
| --- | --- |
| TenantPlatform + tenant evidence 单测 | 4 pass / 0 fail / 51 assertions |
| TenantPlatform 并发/幂等测试 | 通过；policy、quota、rate、request approval 仍保持原有结果 |
| Core typecheck | 通过 |
| Plugin/Skill/tenant 后端专项回归 | 20 pass / 0 fail / 156 assertions |
| Server / Protocol / Schema typecheck | 通过 |

回归现在要求租户已有治理数据时 `exportReceipt.item_count > 0`，并校验导出摘要为 64 位十六进制
SHA-256；此前的 `item_count=0` 缺陷不再被测试掩盖。

## 当前开发阶段边界

Step 8.9 的后端合同在本地 SQLite 测试、租户隔离、角色边界、幂等、并发门禁和 safe audit projection
方面可进入开发交付。物理 tenant delete executor、对象存储/跨区域恢复、signed release、staging、
canary/rollback 发布证据仍按用户要求不执行，属于计划后续发布/运维范围。
