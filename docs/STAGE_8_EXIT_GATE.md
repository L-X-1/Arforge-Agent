# Stage 8 退出门禁

计划中的第 8.11 不是文档勾选，而是对五类证据做 digest 校验。

执行命令：

    bun run audit:stage8:exit -- --input artifacts/stage-8-exit-evidence.json --output artifacts/stage-8-exit-report.json

输入必须包含当前 checkpoint 的 commit/tree，以及以下每一项的 status=pass、仓库内 evidence_path
和对应 SHA-256：

- 单 Agent baseline 与多 Agent 量化收益；
- child/remote capability 可撤销且不可扩大；
- Personal AI OS 后台任务可见、可停、可审计；
- 多租户 RLS/backup/delete 真实演练；
- signed release 与 rollback 证据。

任一证据缺失、状态不是 pass、路径越出仓库或 digest 不匹配，报告就是 DO_NOT_EXIT，CLI 默认
非零退出。--report-only 只能用于诊断。

本地真实租户演练

在已授权的本机 PostgreSQL 环境中，可以执行：

    bun run db:tenant:rls-delete-drill -- --output artifacts/stage8-tenant-rls-delete.json

该演练使用唯一测试租户和用户，在一个事务中切换到 `arforge_app`，验证跨租户读取/删除边界及自租户删除，
然后回滚事务，并用管理员连接确认测试标记为零。它不提交业务数据，也不输出数据库密码。它只能证明 RLS/delete
事务边界；backup/restore 仍需使用 `script/postgres-recovery-drill.ps1` 生成真实恢复报告。

组合证据：

    bun run db:tenant:evidence -- --rls-report artifacts/stage8-tenant-rls-delete.json --recovery-report artifacts/recovery-drills/<latest-report>.json --output artifacts/stage8-tenant-rls-backup-delete.json

组合器会重新计算两份报告的 SHA-256，并拒绝 mismatch、非 pass、secret 输出或业务数据提交。

本地集成候选证据：

    bun run audit:stage8:local-evidence -- --suite capability_revocation --output artifacts/stage8-capability-revocation.json
    bun run audit:stage8:local-evidence -- --suite background_visibility_stop_audit --output artifacts/stage8-background-visibility.json

这两个套件只允许执行仓库内固定的 A2A loopback 和 PersonalJob 集成测试；报告会标记
`evidence_class=local-integration`，不能替代 staging、生产遥测或 release-owner 人工证据。

重建当前退出证据 manifest：

    bun run audit:stage8:manifest -- --capability artifacts/stage8-capability-revocation.json --background artifacts/stage8-background-visibility.json --tenant artifacts/stage8-tenant-rls-backup-delete.json --output artifacts/stage-8-exit-evidence.json

未提供的 baseline、signed release 或 rollback 会保持 `missing`；只有明确传入且报告自身为 pass 的文件才会进入
pass，`--require-complete` 用于 CI/发布前阻断不完整 manifest。

退出证据不是只看 `status=pass`。builder 和最终 auditor 会按证据类型校验 schema、evidence_type、关键 checks、
safety 标记以及真实来源结构；任意手写的 `{"status":"pass"}` 文件都会被拒绝。

签名发布与回滚证据组合：

    bun run audit:stage8:signed-release -- --release-gate artifacts/release-gate-step8-10.json --release-manifest artifacts/release-evidence-step8-10-final/release-manifest.json --canary-receipt artifacts/canary-receipt.json --output artifacts/stage8-signed-release-rollback.json

组合器要求 release gate 为 `SHIP`、manifest 的签名状态为 verified signed、canary 为 `/global/health` 通过且绑定
不同的 rollback digest，并重新核对 gate 中的 manifest/canary digest。当前 gate 为 `DO_NOT_SHIP` 或缺少真实签名、
staging canary 时，组合结果保持 fail，不得作为 Step 8.11 证据。

DeepSeek 实网候选实验

在已授权的当前进程中，如果 `ANTHROPIC_API_KEY` 存在且 `ANTHROPIC_BASE_URL` 是
`https://api.deepseek.com` 的 HTTPS 端点，可以执行：

    bun run audit:stage8:deepseek -- --authorize-live --output artifacts/stage8-deepseek-experiment.json

缺少 `--authorize-live` 时 runner 只生成 `blocked` 报告，`requestsUsed=0`，不会发起 provider 请求。

该工具固定使用 `deepseek-v4-flash`，最多三次请求、预算声明不超过 ¥5：一次单 Agent baseline，随后两个并发
child 请求，使用固定且带 digest 的小数据集；当前 runner 使用强制结构化结果工具调用，单次最多 512 tokens。
报告只保存响应哈希、可用的 token 统计、校验结果和脱敏失败标签，
不保存模型原文或密钥。三次请求全部成功时报告仍是 `candidate` 而不是 `pass`，因为每种模式只有一个样本，
未达到至少三个稳定样本；它不会触发自动多 Agent 晋级，也不会被退出 manifest 接受。

为满足本退出合同的稳定样本要求，另提供固定三样本 runner：

    bun run audit:stage8:stable-deepseek -- `
      --authorize-live `
      --samples 3 `
      --budget-cny 5 `
      --output artifacts/stage8-deepseek-stable-experiment.json

该 runner 每个样本执行一次 baseline 与两个并发 child 请求，最多九次请求，固定模型
`deepseek-v4-flash`、单次最多 512 tokens、总预算上限 ¥5。只有三组样本全部成功且多 Agent
平均 wall-clock duration 严格低于 baseline 时，报告才会成为 `status=pass` 的
`baseline_and_multi_agent_gain` 证据；否则保持 fail/blocked。缺少显式 `--authorize-live`、
`--samples 3`、有效预算或受限 DeepSeek 端点时，不会发送 provider 请求。
