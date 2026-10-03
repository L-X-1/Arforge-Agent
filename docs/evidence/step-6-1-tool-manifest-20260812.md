# Step 6.1 — 统一 ToolManifest

日期：2026-08-12
计划：`Arforge-最终详细实施计划-V2-2026-08-11.md` / 13.阶段 6 / Step 6.1
状态：已完成

## 实施

`packages/core/src/tool/effect-catalog.ts` 现在为每个内置工具提供完整 ToolManifest 合同，包含：

- name/version/schemaDigest；
- pure/read/write/external 分类；
- risk tier、authority、resources；
- idempotency、retryability、compensation、recovery；
- secret/egress；
- deadline、output/artifact limits；
- preflight、executor、observer、verifier、recovery handler；
- supported platforms。

`ToolRegistry.catalog()` 继续是统一对外投影，并根据实际 tool input/output schema 计算 schema digest；未知外部工具只能获得显式的 unclassified external manifest。`auditToolManifestContract()` 对必填字段、限额、分类、secret/egress 一致性执行 fail-closed 检查。

## 验证

```text
bun test --cwd packages/core ./test/tool-effect-catalog.test.ts
bun run --cwd packages/core typecheck
bunx oxlint packages/core/src/tool/effect-catalog.ts packages/core/src/tool/registry.ts packages/core/test/tool-effect-catalog.test.ts --quiet
```

结果：专项测试 `1 pass / 38 assertions`；Core typecheck 通过；相关 lint `0 errors`（仅保留既有非阻断 warning）。
