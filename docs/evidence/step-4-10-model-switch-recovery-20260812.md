# Step 4.10 Model Switch 与恢复证据

日期：2026-08-12

计划位置：`Arforge-最终详细实施计划-V2-2026-08-11.md`，Step 4.10

状态：已完成

## Durable recompile

`packages/core/src/context-recovery.ts` 的 `recompile()` 接收 durable Session/Run/Checkpoint 引用及其 canonical Context Units，并从这些事实重新调用 `ContextPackage.compile()`。接口没有旧 prompt/package bytes 参数，因此旧 prompt 只能作为历史派生物，不能成为恢复事实源。

每次恢复结果记录：

- `recompiledFrom.sessionID/runID/checkpointID`；
- Context Package `compilerVersion`；
- 新 `modelID` 与 `modelProfileRevision`；
- 新 tokenizer revision 与 provider-tokenizer/estimator method；
- missing evidence IDs 与 `recompiled/degraded` 状态。

Context Package 在本步骤扩展记录 `modelProfileRevision`、`tokenizerRevision`、`tokenizerMethod`，并将这些字段纳入 package digest；新的 tokenizer 重新计算 token layout，不继承旧模型的 token 数。

## Missing evidence policy

- `missingEvidence: "block"`：任一 durable evidence reference 缺失时抛出 `Context.RecoveryError`，并返回 missing IDs；
- `missingEvidence: "degrade"`：缺失 evidence 的 unit 被改为 `derived_summary` / `derived` / `instructionAllowed=false`，移除不可验证的 evidence/source digest 绑定，并在结果中显式报告 degraded 状态。

## 验证结果

- `context-recovery.test.ts` 与 `context-package.test.ts`：6 pass、0 fail、23 assertions；
- `bun run typecheck`：22/22 workspace typecheck 成功；
- `oxlint`：本步骤涉及的 3 个文件 0 warnings、0 errors；
- 验证了新模型/profile/tokenizer、旧 token layout 不复用、durable provenance、degrade 和 block 两种 missing-evidence policy。

## 数据安全

恢复测试使用固定合成 durable IDs、evidence summary 和 tokenizer；没有读取旧 prompt 字节，没有网络请求，也没有记录 API key。
