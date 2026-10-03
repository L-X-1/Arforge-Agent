# Step 4.3 Evidence Unit 证据

日期：2026-08-12

计划位置：`Arforge-最终详细实施计划-V2-2026-08-11.md`，Step 4.3

状态：已完成

## Canonical schema 与 service

复用 `packages/schema/src/agent-runtime.ts` 的 `AgentRuntime.Evidence`，在兼容既有 `source/sourceDigest` wire 字段的基础上补齐：

- extraction method/version；
- observation、run、action refs；
- content/artifact digest；
- sensitivity、capturedAt/validAt；
- bounded summary；
- original artifact reference；
- verification status。

`packages/core/src/evidence.ts` 是唯一 Core 创建入口。它生成不可变 `AgentRuntime.Evidence`，并通过 `project()` 输出面向 Context 的 bounded `Projection`，对外统一使用 `sourceID/contentDigest` 语义。service 只保留 digest、摘要和引用，不复制 raw payload。

## Fail-closed 约束

- 未注册 sourceID 会被拒绝（当 service 绑定 Source Registry 时）；
- evidence 不能把 source 的 instruction 权限扩大；
- 只有 trusted evidence 可以声明 `instructionAllowed=true`；
- secret source 的 evidence 不能降低 sensitivity；
- summary 必须非空且不超过 2,000 字符；
- extraction method/version 与 content digest 必须存在；
- 相同 evidenceID 只有完全相同内容才幂等，内容漂移拒绝；
- evidence 与 projection 冻结，Context 只读取有限 projection。

## 验证

- `bun run --cwd packages/schema typecheck`：通过；
- `bun run --cwd packages/core typecheck`：通过；
- `bun test --cwd packages/core test/evidence.test.ts`：4 pass、0 fail；
- `bun test --cwd packages/schema test/compatibility.test.ts test/contract-hygiene.test.ts`：6 pass、0 fail；
- `oxlint`：新增 Evidence Core 文件 0 warnings、0 errors。
