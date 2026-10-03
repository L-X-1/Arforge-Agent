# Step 6.13 — Workflow 并发与权限证据

日期：2026-08-12
计划：`Arforge-最终详细实施计划-V2-2026-08-11.md`

## 已实现

- 独立 `read` 节点按 `max_parallel` 并发执行。
- `write` 节点在同一进程内按规范化 workspace key 串行执行；单个 workflow 内仍保持单写节点批次。
- child Run 的 risk tier 从 parent Run 限缩：read 为 `L0`，write 为 `L2`；超出 parent tier 时 fail-closed。
- `plan` 模式拒绝 command 和 write-agent mutation 节点，记录 `node.capability_denied`，不会调用执行器。
- workflow checkpoint 记录 parent budget 的 `max_attempts`、保留次数和已使用次数；节点启动前校验 child 预算总和不超过 parent 预算，并按 parent 预算切分 child duration。
- approval 节点首次请求时冻结 immutable definition digest 和传递闭包下游节点；批准事件携带同一冻结范围。
- pause/cancel 先中断执行信号，再传播到已 checkpoint 的 child Run；drive 在 parent 非 running 或结果为 interrupted 时丢弃执行结果，不把中断伪造为完成。
- `recover()` 使用 DurableRun `orphaned()` 检测无 lease owner 的 workflow，清理不可恢复 child 并重试未完成节点；已完成 child 可恢复为节点完成。

## 验证

```text
bun run --cwd packages/core typecheck       PASS
bun run --cwd packages/server typecheck     PASS
bun test --cwd packages/core test/durable-workflow.test.ts  PASS (6 tests)
bun test --cwd packages/arforge test/cli/durable-workflow-api.test.ts  PASS (1 test)
git diff --check                            PASS
```

core 测试覆盖：独立读并发、同 workspace 写串行、plan fail-closed、预算约束、审批冻结范围、pause/cancel child 传播与 lease-owner recovery。HTTP E2E 覆盖 approval → read child → checkpoint 的完整 durable workflow。

## 已知基线问题

`bun run --cwd packages/arforge typecheck` 仍被既有 `packages/arforge/test/tool/shell.test.ts:212` 的 `string | undefined` 类型错误阻塞；该错误不在本 Step 的变更范围内。
