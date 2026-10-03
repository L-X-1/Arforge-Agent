# DeepSeek 实网授权门禁证据（2026-08-14）

- 修改范围：`packages/core/script/run-stage8-deepseek-experiment.ts`
- 目的：避免仅因当前进程存在 provider 环境变量就意外发起实网请求。

## 新门禁

runner 现在要求命令行显式包含 `--authorize-live`。缺少该参数时：

- 只生成 `status=blocked`、`decision=DO_NOT_PROMOTE` 报告；
- `authorization.requestsUsed=0`；
- `failureReason` 明确为未尝试 provider 请求；
- 不读取/发送模型请求，不产生费用。

授权执行命令形态：

```powershell
bun run audit:stage8:deepseek -- `
  --authorize-live `
  --output artifacts/stage8-deepseek-experiment.json
```

## Fresh verification

```powershell
bun --cwd packages/core script/run-stage8-deepseek-experiment.ts `
  --output artifacts/stage8-deepseek-no-auth.json
```

结果：`blocked`，`requestsUsed=0`，`secretsPrinted=false`；未进行实网调用。

合同测试、`oxlint` 和 `packages/core` typecheck 均通过。
