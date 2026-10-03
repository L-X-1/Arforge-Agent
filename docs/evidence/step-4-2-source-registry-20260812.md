# Step 4.2 Source Registry 证据

日期：2026-08-12

计划位置：`Arforge-最终详细实施计划-V2-2026-08-11.md`，Step 4.2

状态：已完成

## Canonical registry

`packages/core/src/source-registry.ts` 建立了无数据库迁移的 Schema/Core Source Registry。每条 `SourceRecord` 包含：

- `sourceID`、source type、owner、project/location；
- `trust` 与 `instructionAllowed`；
- `sensitivity`；
- `freshness.observedAt / expiresAt`；
- `limits.maxBytes / maxTokens`；
- `provenance.locator / digest`；
- `redactionPolicy`；
- 显式 `retrievalAdapter`。

已覆盖计划列出的 13 类来源：system rules、project rules、user message、session history、file、Git、LSP、MCP resource、web、memory、learning、workflow、tool output。每种 source type 只允许其对应 adapter，避免把来源类型和检索实现隐式混用。

## Fail-closed 约束

- 只有 trusted system/project rules 可以设置 `instructionAllowed=true`；
- source type 与 retrieval adapter 不匹配时拒绝；
- expiry 不晚于 observedAt 时拒绝；
- secret source 不允许使用空 redaction policy；
- source ID 和 provenance digest 必须通过 schema，source ID 拒绝 `..` 路径片段；
- 同一 sourceID 的完全相同记录幂等，元数据或 digest 漂移会抛出冲突；
- Registry 只保存元数据与 digest，不保存来源正文，保持 Event/Run、Memory OS 与 Context Package 的 authority 边界。

## 验证

- `bun run --cwd packages/core typecheck`：通过；
- `bun test --cwd packages/core test/source-registry.test.ts`：6 pass、0 fail；
- `oxlint`：0 errors，新增文件仅保留既有项目级规则兼容。
