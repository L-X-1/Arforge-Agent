# Step 6.3 — Shell 工具封板证据

日期：2026-08-12
状态：通过（代码与定向回归已完成；未推送远端）

## 计划门禁

| 计划要求 | 实现证据 |
| --- | --- |
| stable action identity | `ToolRegistry` 以 canonical decoded input 计算 input digest，并由 `ActionGateway.stableActionID` 绑定 tool call；输入变化不会复用旧授权。 |
| L3 fresh ask | Bash 使用 `majorImpact`、`forceAsk: true`；`ToolRegistry`/Gateway 对 L3 走 human authority，测试验证每次调用到达 fresh ask。 |
| minimal env | Bash 显式传入 `allowlistedChildEnvironment(process.env)`；不继承任意环境变量，`ARFORGE_*` 控制面密钥和 `ANTHROPIC_API_KEY` 不进入子进程。 |
| secret scope | effect contract 声明 `allowlisted child environment; no Arforge control-plane secrets`，不再宣称 inherited process environment。 |
| no preapproval spawn | workdir、外部目录与 Bash action 授权全部完成后才构造/启动 `ChildProcess`；拒绝测试确认无 spawn。 |
| timeout/cancel | `AppProcess.run` 使用 bounded timeout/signal；`CrossSpawnSpawner` 作用域退出 kill 子进程，Windows 使用 `taskkill /T /F`，POSIX 使用进程组并支持 force-kill escalation。 |
| output artifact/backpressure | Bash producer capture 限制为 1 MiB 并显式返回 truncation；Registry 的 `ToolOutputStore` 对模型-facing output 做行/字节边界并保留 managed artifact path。 |
| platform/path coverage | 现有 Windows shell routing/cmd script-with-spaces 测试通过；Bash tool 新增带空格和 Unicode 目录、真实 shell、高输出 artifact 测试。 |

## 验证

```text
bun test --cwd packages/core ./test/tool-bash.test.ts ./test/process/process.test.ts ./test/effect/cross-spawn-spawner.test.ts ./test/secret-environment.test.ts
  61 pass, 0 fail, 130 expect() calls
```

关键结果：

- `BashTool` 12 pass：L3/拒绝不 spawn、外部目录授权、timeout settlement、Unicode/空格路径、高输出 artifact；
- `AppProcess` 23 pass：stdout/stderr、capture limit、abort signal、stdin/cwd/env、退出码；
- `CrossSpawnSpawner` 26 pass：进程 kill、scope cleanup、forceKillAfter、pipeline、Windows shell routing 与带空格 cmd 脚本；
- `allowlistedChildEnvironment` 2 pass：ambient secret 与控制面 secret 均不泄露。

## 已知边界

命令字符串仍是宿主 Shell 的完整能力面，Shell AST/树解析和可复用 command-prefix 授权尚未开放；因此 Bash 继续固定 L3 human approval。超出 1 MiB 的 producer capture 只保留 bounded preview，完整持久 artifact 由未截断范围内的 `ToolOutputStore` 负责；进程树清理依赖各平台原生能力并保留后续平台验收项。
