# Step 8.1 — Generated Client/OpenAPI/SDK 契约收敛证据

- 计划：`Arforge-最终详细实施计划-V2-2026-08-11.md` § Step 8.1、§ 18 第 6 条、§ 19.7
- 日期：2026-08-23
- 基线：`b21988a4 feat(run): enforce recoverable child budgets`
- 范围：本地生成与验证；未发布、未部署、未 push

## 审计发现与修复

- 基线中的 `packages/sdk/js/src/v2/gen/types.gen.ts` 把 Tenant Platform 类型插入 `V2ProjectCopyListErrors` 注释内部，存在确定的 TypeScript 语法错误。
- 同一基线的 `sdk.gen.ts` 存在类外悬空的 `_tenantPlatform` getter；内部 `packages/client/src/generated/client.ts` 也含悬空类型列表。三处都会阻断从干净 checkpoint 启动官方生成链。
- 在隔离 worktree 中只做临时 bootstrap 以启动生成器；最终候选由内部 Client generator 和 HeyAPI/OpenAPI generator 整体覆盖，不把手工修补作为交付物。
- 根生成脚本原来直接执行 TypeScript shebang，并调用全仓 formatter：Windows 下前者失败，后者在隔离审计中造成 496 个无关文件漂移。现改为通过 Bun 运行、且只格式化 `packages/sdk/openapi.json`；SDK build 自己继续格式化其生成目录。

## 外部契约结果

官方生成后的 OpenAPI 与 JS SDK 已包含：

- `AgentRuntimeBudget.maxTokens/tokensUsed`；
- attempt `usageBaseline` 与 `AgentRuntimeRunUsageBaseline`；
- Child Run capability、budget reservation/settlement、result 与 delegation 字段；
- workflow `child_run_id` 与预算投影。

内部 Client contract 不直接暴露完整 DurableRun 事件模型，只包含其 HTTP contract 实际可达的 workflow child projection；public OpenAPI/JS SDK 承担完整事件类型投影。

## 可复现验证

| 检查 | 结果 |
|---|---:|
| 连续重跑两条生成链 | 25 个生成文件，0 个 hash 漂移 |
| `packages/client` typecheck + tests | 17 passed，0 failed，80 expects |
| `packages/sdk/js` typecheck + tests | 3 passed，0 failed，5 expects |
| Arforge public OpenAPI contract | 18 passed，0 failed，545 expects |
| 隔离生成候选 SDK typecheck + tests | 2 passed，0 failed，3 expects |

## 已知边界

- 当前主工作树还有其他阶段的未提交 API source 变化；本 checkpoint 只固化从 `b21988a4` 可重现生成的自洽快照。提交后会从主工作树现状重新生成，后续差异必须与各自 source contract 同批审查，不能把 generated 文件单独冒充功能实现。
- `bun install --frozen-lockfile --ignore-scripts` 在隔离 worktree 被现有 lockfile 漂移拒绝；非冻结安装还遇到默认 npm mirror 的连接失败。该依赖可复现性问题单独保留为开发质量待办，本轮未修改 lockfile。
