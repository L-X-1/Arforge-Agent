# Step 8.9 租户审计确定性 checkpoint（2026-08-23）

## 发现

上一轮已让租户审计导出包含安全的治理状态，但深层复核发现两个剩余缺口：

1. 每次导出都会写入 `tenant_audit_export` 回执，后续导出却没有包含这些既有回执，导出动作本身不可从下一份审计中追溯；
2. secret、settled usage、data request 和 backup 只按时间排序，同一毫秒内的多条记录缺少唯一字段次级排序，摘要输入顺序可能依赖数据库返回顺序。

## 修复

- 后续审计导出纳入同租户既有 `tenant_audit_export` 安全投影：ID、请求人、记录数、导出摘要和创建时间；
- secret 按 `time_created + secret_id` 排序；
- settled usage 按 `recorded_at + settlement_id` 排序；
- data request 按 `requested_at + id` 排序；
- backup 和 audit export 按 `created_at + id` 排序；
- 未返回或持久化 secret ciphertext、secret plaintext、data request reason plaintext；reason 仍只进入摘要；
- 没有新增 API、数据库表或迁移。

## 验证

| 检查 | 结果 |
| --- | --- |
| Tenant audit + platform + evidence 定向测试 | 5 pass，0 fail，57 assertions |
| Plugin/Skill/Tenant 联合回归 | 21 pass，0 fail，163 assertions |
| Server OpenAPI 合同 | 1 pass，0 fail |
| Core/Server/Protocol/Schema typecheck | 全部 passed |
| Oxlint（本轮 2 个文件） | 0 warnings，0 errors |
| `git diff --check`（本轮文件） | passed |

新增测试证明连续三次导出时，后一次 `item_count` 精确包含前一次新增的回执，三份摘要均不同，且三条持久化回执与返回值一致。

## 边界

本 checkpoint 只属于 Step 8.9 本地开发功能。未执行发布、部署、staging、签名、canary、rollback 或 Git push。
