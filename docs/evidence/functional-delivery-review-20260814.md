# Arforge V2 功能开发交付复核

- 日期：2026-08-14
- 计划：`Arforge-最终详细实施计划-V2-2026-08-11.md`
- 范围：本地开发功能交付；不包含发布、部署、签名、canary、rollback
- 当前分支：`codex/phase-0-checkpoint`

## 结论

Step 8.5–8.9 的本地功能实现已完成开发期回归，可作为本地功能交付候选。当前没有执行 Git push，也没有把未配置的公网 remote executor 或发布环境伪装成可用。

## 已交付能力

- Step 8.5：A2A V1 私有协议、canonical digest、幂等/nonce、cancel/revoke、lookup、结果收据校验和本地受信 transport；默认公网入口与跨机器 executor 未启用。
- Step 8.6：Personal Job 持久化 admission、审批、周期调度、IANA 时区、限定凭据、预算、暂停/取消、通知、结果摘要、artifact receipt、执行 lease/heartbeat、失联恢复和真实 Session Runner 执行。有效 price catalog 会记录实际结算用量；无目录时保持 fail-closed，不虚构价格。
- Step 8.7：Personal Workspace 安全投影、Control Center、API/SDK；不返回 prompt、raw event、secret、lease owner 或 artifact 内容。
- Step 8.8：plugin/skill manifest、权限、签名状态、安全扫描、安装/更新/卸载/启停、ControlRun、审计和恢复校验。
- Step 8.9：tenant/RLS、密钥与秘密隔离、quota/rate、角色、审计、删除请求、backup/restore、settled usage billing 的本地实现与 PostgreSQL 验证。

## 开发期验证

| 验证项 | 结果 |
|---|---:|
| 全仓 typecheck | 22/22 成功 |
| App 单元/浏览器回归 | 975/975，3365 assertions |
| Server 回归 | 8/8 |
| Personal Job lifecycle + executor | 17/17，75 assertions |
| Session Runner/model/billing | 110/110，338 assertions |
| A2A + SessionRunCoordinator | 26/26，62 assertions |
| 8.7–8.9 重点回归 | 25/25，166 assertions |
| SDK-next 个人任务/记忆 | 2/2，21 assertions |
| SDK/OpenAPI 生成与构建 | 成功 |
| `git diff --check` | 通过（仅现有工作树换行提示） |

## 用户验收路径

在本地桌面应用中：

1. 打开一个 Session，进入 Personal Jobs/Personal Workspace。
2. 创建后台任务，填写标题、提示词、执行时间、审批策略、通知和免打扰时间；需要限定 provider 时选择 credential label。
3. 对需要审批的任务执行批准；点击“立即运行”或“检查调度器”。
4. 在任务卡片观察 `queued → running → completed/failed`，查看摘要、通知、预算用量和已验证 artifact 的名称/MIME/大小/digest。
5. 运行中可以暂停/取消；进程失联后再次调度会安全恢复或按预算收口；终态任务按 retention 规则逻辑删除。

实际 provider、模型和 credential 仍需由使用者在本地配置；缺失或不匹配时系统应显示失败/不可运行，而不是偷偷回退到其他凭据。

## 明确未包含

- Step 8.10 发布运维：签名产物、SBOM/provenance、发布环境、canary、rollback、SLO/告警、事故响应。
- Step 8.11 signed release/canary/rollback 证据与退出门禁。
- A2A 真实公网/跨机器部署、mTLS/peer registry、trusted-receipt 生产 verifier。
- 物理租户删除执行器、对象存储备份和跨区域恢复。

这些是发布/平台化边界，不影响本次“只完善本地功能后交付”的范围；在未配置真实资源时保持 candidate/未启用状态。
