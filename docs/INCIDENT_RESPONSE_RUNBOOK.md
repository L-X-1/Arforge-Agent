# Arforge Incident、数据与 Secret 泄露响应

## 触发与角色

任何 tenant isolation、secret exposure、错误删除、迁移损坏、备份恢复失败或签名材料泄露都
按至少 P1 处理；跨租户可见性、可导出的代码签名私钥或生产数据库凭据泄露直接按 P0。需要明确
`incident commander`、`release owner`、`database reviewer` 和记录员；没有可用 owner 时保持
`DO_NOT_SHIP`，不要自行批准。

## 前 15 分钟

1. 记录 UTC 时间、release/source/candidate digest、影响租户、首次告警和当前 traffic cohort。
2. 立即停止 canary promotion、自动发布和相关后台任务；必要时停止写流量。
3. 保留应用/数据库审计、migration receipt、backup manifest、签名证据和告警快照；日志中不得
   添加 prompt、token、连接串或 secret 值。
4. 将影响范围按 tenant/project/session 分层，使用最小权限的只读查询确认是否存在跨范围访问。

## 数据或 Secret 泄露

1. 通过授权的 tenant-platform 管理接口撤销受影响 secret metadata，并递增 tenant key version；
   不直接从日志或数据库导出 secret 值。
2. 禁止用旧 key 继续重试外部请求；等待 provider、数据库 reviewer 和 incident commander
   确认后再发放新 secret。
3. 冻结并隔离受影响 tenant 的数据请求、备份导出和 audit export，保留 request/export digest。
4. 评估数据访问时间窗、读取/写入类型和是否存在跨租户影响；依适用法律、合同和组织政策通知
   负责人，不在仓库或公开 issue 中披露个人数据。
5. 完成修复后执行 RLS、tenant-platform、backup restore drill 和最小权限审计；没有全套证据
   不得恢复 promotion。

## 发布与迁移事故

- 发布 artifact hash、签名主体或 timestamp 不匹配：丢弃 artifact，撤销候选，不复用旧证据。
- migration 失败或 row-count mismatch：停止写入，回到匹配 schema 的应用版本，在隔离数据库恢复
  verified backup；不要直接执行未经审查的 down SQL。
- SLO burn 或 critical alert：停止扩大 canary，比较 rollback artifact 与当前 policy/schema，
  由 release owner 和 incident commander 双人确认后回滚。

## 关闭标准

关闭 incident 前必须有：影响范围、时间线、根因、containment、修复 commit、recovery/restore
结果、secret/key rotation 记录、通知决定、回归测试、SLO 恢复和至少一项防复发 action。证据
包只保存 digest、状态和最小必要元数据；任何无法证明的项目标记为 unknown，不得写成 pass。
