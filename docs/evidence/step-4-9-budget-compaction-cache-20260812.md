# Step 4.9 Budget、Compaction 与 Cache 证据

日期：2026-08-12

计划位置：`Arforge-最终详细实施计划-V2-2026-08-11.md`，Step 4.9

状态：已完成

## Budget

`packages/core/src/context-budget.ts` 提供统一预算计划：

- provider-specific tokenizer 可用时使用其 revision 和结果；未提供、抛错或返回非法值时回退到 `Token.estimate`，并记录 `method` 与 `fallbackReason`；
- `outputTokens`、`toolTokens`、`recoveryTokens` 和 `safetyBufferTokens` 在计算 `usableInputTokens` 前预留；
- `planPackage()` 从 digest-bound Context Package 的 provider messages 计算实际输入预算，供后续编译/请求层使用。

## Compaction

`compact()` 使用完整 atomic groups 选择 recent window：

- `tool-call` 与同 `pairID` 的 `tool-response` 作为一个不可拆分边界；
- summary 生成函数只接收待压缩 entries；objective、policy、protected facts 在模型输出外由固定 anchor 重新组装，不能被 summary 覆盖；
- provider 失败、空输出、没有 head、未达到预算或压缩后不减小均返回 no-op，并保留原 entries。

## Cache

cache key 绑定：

- tenant ID；
- Context Package digest；
- model profile revision；
- tool schema digest。

`makeCache()` 只保存 digest、revision 和 token count 等 metadata，没有 prompt、summary、content 或 secret 字段；不同 tenant 或任一绑定字段变化都无法命中同一条记录。

## 验证结果

- Step 4.1–4.9 相关 11 个 core 测试文件：56 pass、0 fail、188 assertions；
- `bun run typecheck`：22/22 workspace typecheck 成功；
- `oxlint`：`context-budget.ts` 与其测试 0 warnings、0 errors。

## 数据安全

测试只使用固定合成文本、digest、tokenizer 与 cache metadata；没有使用网络请求，没有记录 API key 或真实 provider 内容。
