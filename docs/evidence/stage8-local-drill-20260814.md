# Stage 8 本地 evidence drill（2026-08-14）

- 运行 checkpoint：`5e819ce1`
- 运行范围：`packages/core` 本地集成测试；无 provider 实网请求、无生产数据库变更。

| Suite | 命令 | 结果 |
|---|---|---|
| capability revocation | `bun run audit:stage8:local-evidence -- --suite capability_revocation --output artifacts/stage8-capability-revocation.json` | pass |
| background visibility/stop | `bun run audit:stage8:local-evidence -- --suite background_visibility_stop_audit --output artifacts/stage8-background-visibility.json` | pass |

两个报告均通过进程退出、期望通过数、关键行为 marker 和 secret 输出检查，并将 stdout/stderr 只记录为 digest 与字节数。

重新生成并审计 `artifacts/stage-8-exit-evidence.json` 后：

- decision：`DO_NOT_EXIT`
- failed checks：2
- 缺失：`baseline_and_multi_agent_gain`、`signed_release_rollback`

本地 integration evidence 不等价于 staging/production evidence，不能单独打开 Step 8.11。
