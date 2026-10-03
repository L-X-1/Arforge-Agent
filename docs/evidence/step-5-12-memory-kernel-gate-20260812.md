# Step 5.12 — Memory V1 退出门禁

日期：2026-08-12
计划：`Arforge-最终详细实施计划-V2-2026-08-11.md` / 12.阶段 5 / Step 5.12
状态：已完成。MemoryKernel V1 门禁实现、MemoryV2 兼容层切换、删除协议收紧与回归验证均通过。

## 已通过的 Kernel 门禁

代码：`packages/core/src/memory-kernel.ts`
测试：`packages/core/test/memory-kernel.test.ts`

- `propose` 只写 `memory_candidate`，不会创建 active row。
- 只有 user approval、`allow` policy、非 `working`、非 `secret`、非 duplicate/conflict candidate 才能 promote。
- promotion 在一个事务内创建 active row 与 revision，写入 verified provenance、scope、actor、policy version、evidence IDs、content digest 和 version `1`。
- global active memory 限制为 user/user-corrected/imported source。
- forget 使用 expected version CAS，写入 version `2` 的 forget revision，并将 lifecycle 置为 forgotten。
- delete 需要 maintenance actor、explicit destructive authority、action ID、redaction evidence 和 expected version；删除后 active row 与 revision 均不可见。
- `MemoryV2.create({ source: "auto" | "model" })` fail-closed：只写入 `memory_candidate` 并返回治理错误，不创建 active row。
- 显式 user/imported/user-corrected 创建、更新、纠正统一经 Kernel 写入，均带 verified provenance、actor、policy、digest、单调 version 与 revision。
- 自动抽取改为 candidate-only；不再通过旧 `create` 绕过审批。
- 纠正撤销、冲突裁决、治理隔离等维护性写入同步更新 lifecycle/version/digest，并追加 revision；旧 MemoryV2 删除接口已改为维护授权请求。
- recall path 已过滤非 active lifecycle；Context Compiler 继续把 recall 作为 untrusted data。

## Cutover 结论

旧 `MemoryV2` 读路径继续保留兼容性；其所有产品写入已切到 Kernel。自动/model 来源只进入 candidate，显式 user/imported/user-corrected 来源才可写 active。删除协议要求 expected version、maintenance actor、explicit destructive authority、action ID、redaction evidence 和 reason；server handler 不接受客户端伪造 actor/authority。

## 验证

```text
bun test --cwd packages/core ./test/memory-candidate.test.ts ./test/memory-class.test.ts ./test/memory-evaluation.test.ts ./test/memory-kernel.test.ts ./test/memory-migration.test.ts ./test/memory-policy.test.ts ./test/memory-promotion.test.ts ./test/memory-recall.test.ts ./test/memory-retention.test.ts ./test/memory-revision.test.ts ./test/memory-truth-boundary.test.ts ./test/memory.test.ts
bun run --cwd packages/core typecheck
bun run --cwd packages/protocol typecheck
bun run --cwd packages/server typecheck
bun run --cwd packages/client typecheck
bunx oxlint packages/core/src/memory-kernel.ts packages/core/src/memory.ts packages/core/test/memory.test.ts packages/core/test/memory-kernel.test.ts packages/protocol/src/groups/memory.ts packages/server/src/handlers/memory.ts --quiet
```

结果：Memory 相关测试 `53 pass / 217 assertions`；Core、Protocol、Server、Client typecheck 全部通过；相关 lint `0 errors`（已有 15 条非阻断 warning）。客户端生成文件已由 `bun run --cwd packages/client generate` 更新。
