# Arforge 本地测试分片证据（2026-08-14）

## 范围

- 当前分支：`codex/phase-0-checkpoint`
- 本轮复验起点 checkpoint：`c52a1ac1dd631e077a8fcb6f3260e700d0ab1082`
- 本证据只覆盖 `packages/arforge` 的 shard 1/4，不代表其余分片或整仓通过。
- 运行方式为单进程串行，以降低 Windows SQLite 与跨测试进程状态对回归判断的干扰。

## 命令与结果

```powershell
bun test --cwd packages/arforge --max-concurrency=1 --shard=1/4 --timeout 30000
```

结果：

- 825 tests across 70 files
- 817 pass
- 7 skip
- 1 todo
- 0 fail
- 40 snapshots
- 2244 `expect()` calls

## 关联针对性回归

- operations API：2 pass、18 expects、0 fail
- frontend ownership：1 pass、6 expects、0 fail
- snapshot race：1 pass、4 expects、0 fail
- ToolRegistry：16 pass、26 expects、0 fail
- runtime insight：2 pass、7 expects、0 fail
- ShareNext：10 pass、43 expects、0 fail

## 结论与边界

本分片及关联针对性测试在当前本地开发环境通过。该结果不涉及发布、部署、staging、签名、canary 或 rollback，也不关闭 V2 Step 0.6 的工作树归属门禁。
