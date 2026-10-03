# Step 4.7 Context Package Compiler 证据

日期：2026-08-12

计划位置：`Arforge-最终详细实施计划-V2-2026-08-11.md`，Step 4.7

状态：已完成

## Digest-bound package

`packages/core/src/context-package.ts` 基于 canonical Context Unit 输出 `Context Package v3`，包含：

- model 与 compiler version；
- system/project authority、current request、recent turns、run/event、evidence、memory/experience、tool 等 unit 的 provider messages；
- source/evidence/authority/trust manifest；
- selected/omitted 状态与 `budget_exceeded` reason；
- used/usable token allocation；
- protected-fact required/present/missing/complete coverage；
- canonical SHA-256 digest。

编译顺序为：校验 unit → 保留全部 mandatory units → optional units 按 selectionScore/priority 稳定选择 → 恢复 source order → 计算 manifest/omissions/allocation/coverage → 生成 digest。mandatory context 超出窗口直接抛出 `MandatoryContextOverflowError`，不会静默截断。

同 model、同 compiler version、同 units、同 budget 会产生相同结构和 digest；`verify()` 检测消息、manifest、omission、allocation 或 coverage 篡改。package 与其中的 message/manifest/omission 对象深冻结，Context Package 是派生状态，不替代 Event/Run/Memory authority。

## 验证

- `bun run typecheck`：27 包范围 22/22 成功；
- `bun test --cwd packages/core test/context-package.test.ts test/hybrid-ranking.test.ts test/code-retrieval.test.ts test/source-adapter.test.ts test/evidence.test.ts`：19 pass、0 fail；
- `oxlint`：Context Package 新增文件 0 warnings、0 errors；
- 覆盖 deterministic digest、mandatory overflow、optional omission、source-order restore、protected-fact coverage、tamper detection 与 deep immutability。
