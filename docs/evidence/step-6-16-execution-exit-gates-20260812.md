# Step 6.16 — Execution / Workflow / Verifier 退出门禁证据

日期：2026-08-12
计划：`Arforge-最终详细实施计划-V2-2026-08-11.md`

## 已实现

- Tool manifest 已有 deadline、egress、secret、observer、verifier、recovery contract 字段；`auditToolManifestContract` 现在拒绝 executor 与 verifier 使用同一实现标识。
- 新增 `auditToolExitGate`，启用工具只有在 manifest、observer、verifier、recovery contract 都 ready 时才通过退出门禁；缺失任一项会列入 `missingContracts`。
- `completionGate` 汇总 durable checkpoint/action settlement 与独立 verifier 结论；模型/provider stop reason 只作为诊断字段，不能使 completion 通过。
- 生产 Workflow 入口继续使用 `DurableWorkflowGraphRuntime`；旧表型 `WorkflowGraphRuntime` 保留为迁移/兼容测试源，不作为生产 writer 或 lease authority。
- Share/revoke 的 self-hosted provider、receipt store、lookup/digest/visibility 校验和 E2E 已在前序 checkpoint 完成，本 Step 不重新开放旧 legacy writer。

## 验证

```text
bun run --cwd packages/core typecheck       PASS
bun test --cwd packages/core test/runtime/verifier.test.ts test/tool-effect-catalog.test.ts  PASS (12 tests)
bunx oxlint changed verifier/catalog files PASS (0 errors)
git diff --check                            PASS
```
