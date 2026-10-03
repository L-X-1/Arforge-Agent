# Step 6.11 — Sandbox 与资源治理证据

日期：2026-08-12
计划：`Arforge-最终详细实施计划-V2-2026-08-11.md`
范围：在不改变 Action/Run 合同的前提下，复用现有 process、filesystem、worktree 与预算治理，并补齐 durable shell 的进程级网络出口边界。

## 已确认的治理能力

- per-run cwd / worktree：`InstanceState`、worktree sealed snapshot 与 `DurableRun` 约束运行位置和恢复身份。
- minimal environment：`packages/arforge/src/tool/shell.ts` 的 `sanitizeChildEnvironment` 只向子进程传递受控环境变量。
- wall-clock deadline：Shell timeout、`DurableRun` deadline 与 worktree worker hard deadline 在到期时终止或暂停运行。
- output bytes：Shell 的 stdout/stderr 截断、持久化完整输出 artifact 和 `ActionGateway` durable output 上限共同限制输出规模。
- process tree cancellation：核心 process runner 与 Windows `taskkill /T /F` 路径在 abort/timeout 时终止进程树。
- filesystem roots：`Filesystem` / `FSUtil` 对真实路径、root、symlink 与外部目录 scope 做 preflight 和逃逸拒绝。
- token/cost：`ContextBudget` 负责输入、工具、恢复与安全保留量；`DurableRun` 记录并限制 duration/cost budget。
- attempt budget：`DurableRun` 对 active attempt、重试次数、租约与恢复状态做持久化约束。

## 本步新增：进程级 network egress gate

Shell 的静态 preflight 现在给已知的单命令结果增加 `network` 分类：

- 明确的本地文件/文本命令（例如 `cat`、`ls`、`sed`）标记为 `none`；
- 未能证明只读本地行为的命令（例如 `git`、`curl`、`python`、`npm`）标记为 `possible`；
- 未知 shell、管道、重定向、替换和其他无法完整静态证明的组合仍沿用原有 fail-closed barrier。

当 Shell 位于 durable parent action 内且分类为 `possible` 时：

1. 没有上层注入 `Egress.Authorizer.assertProcess`，在 shellEnv/spawn 之前拒绝；
2. 有 authorizer 时，必须由 `process:<exact command>` 或 `process:*` 覆盖；
3. `Egress.make` 同时检查 declared `networkScope` 与 parent `grantedResources`（若提供），拒绝越界资源；
4. 拒绝记录使用统一的 redacted target，不把命令或潜在 secret 写入审计请求目标。

因此，普通本地 Shell 仍可执行；可能联网的 durable Shell 没有隐式网络权限。真正允许它执行的 runner 必须先把 process scope 作为授权的一部分注入。当前实现没有声称建立 OS/container network namespace；跨平台容器化仍按计划作为后续 adapter，不能替代 Action/Run 合同。

## 验证

- `bun run --cwd packages/core typecheck`
- `bun run --cwd packages/arforge typecheck`
- `bun test --cwd packages/core test/context-firewall-egress.test.ts`：5 pass
- `bun test --cwd packages/arforge test/session/tools-preflight.test.ts test/tool/shell.test.ts -t "blocks possible network effects|classifies possible shell network effects"`：2 pass
- `bun test --cwd packages/core test/context-budget.test.ts test/durable-run.test.ts`：41 pass
- `bun test --cwd packages/arforge test/control-operation/worktree-executor.test.ts test/control-operation/worktree-scheduler.test.ts test/control-operation/worktree-snapshot.test.ts test/control-operation/worktree-worker.test.ts`：30 pass
- `bun test --cwd packages/arforge test/util/process.test.ts`：10 pass
