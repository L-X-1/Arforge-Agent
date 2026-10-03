# Step 6.14 — Verifier Registry 证据

日期：2026-08-12
计划：`Arforge-最终详细实施计划-V2-2026-08-11.md`

## 已实现

- `packages/core/src/runtime/verifier.ts` 新增按 `actionKind@actionVersion` 注册和查找的 `VerifierRegistry`。
- 注册契约强制 `readOnly: true`、`credentialScope: "independent"` 和正整数 deadline；运行时拒绝携带 `mutationExecutor` 的 registration。
- 输入必须由 `freezeVerifierInput` 深冻结，包含 frozen intent、observation 和 artifact refs；Verifier callback 只收到只读输入、独立 scope 和 `AbortSignal`，不能取得 mutation executor。
- registry 以独立 deadline 执行 callback，超时 fail-closed；结果生成 evaluation summary、证据 digest 和 `AgentRuntime.Evidence`，证据默认 `instructionAllowed=false`。
- 默认 registry 提供 `file@1`、`shell@1`、`worktree@1`、`share@1`、`browser@1`、`workflow@1` 的结构化检查。

## 验证

```text
bun run --cwd packages/core typecheck       PASS
bun test --cwd packages/core test/runtime/verifier.test.ts  PASS (10 tests)
bunx oxlint verifier.ts verifier.test.ts   PASS (0 warnings, 0 errors)
git diff --check                            PASS
```

测试覆盖版本注册、独立 evidence 生成、六类默认 verifier、冻结输入、重复注册、mutation executor 拒绝和 deadline 超时。
