# Step 4.8 Context Firewall 证据

日期：2026-08-12

计划位置：`Arforge-最终详细实施计划-V2-2026-08-11.md`，Step 4.8

状态：已完成

## 边界规则

`packages/core/src/context-firewall.ts` 在 Context Package 进入 provider message 前再次执行 digest、manifest、source、evidence、trust、instruction permission 与 sensitivity 校验：

- web、MCP resource、file、memory、tool output 等外部来源默认不能进入 instruction segment；
- 只有 Source Registry 中明确登记且 `trusted + instructionAllowed=true` 的 system/project rule 可以保留为 instruction；
- package 不能提升 source trust、放宽 source instruction permission 或降低 source sensitivity；
- secret 或超过 firewall sensitivity 上限的内容被阻断，不进入 provider message；
- evidence 必须存在、绑定同一 source，并匹配 source digest；
- 未获 instruction permission 的内容统一用 `context_fragment` CDATA wrapper 作为数据传递；即使原 message role 是 `system`，也会降为 `context`；
- provider message 数量、unit ID 与 selected manifest 不一致，或 package digest 被篡改时 fail closed。

Context Package manifest 同时保留 `sourceID`、`evidenceID`、`sourceDigest`、`trust`、`instructionAllowed` 与 `sensitivity`，防止 provider 边界丢失 provenance。

## 攻击回归

`packages/core/test/context-firewall-package.test.ts` 覆盖：

- prompt injection 与 `ignore previous` 文本只作为 CDATA 数据；
- HTML hidden text、Markdown fenced block、nested quote；
- memory poisoning 被包装且 system role 不获得权限；
- source trust elevation 被拒绝；
- project rule 只有 registry 明确授权时才进入 instruction；
- secret material 被阻断；
- source-bound evidence digest mismatch 被拒绝。

## 验证结果

- 直接关联 Step 4.1–4.8 的 10 个 core 测试文件：50 pass、0 fail、162 assertions；
- `bun run typecheck`：22/22 workspace typecheck 成功；
- `oxlint`：本步骤涉及的 4 个文件 0 warnings、0 errors；
- core 全量 `bun test` 在 304 秒时无输出并超时，未将其记为通过；本证据只采信上面的受影响测试集与类型/lint 结果。

## 数据安全

测试只使用固定的合成文本、合成 digest 与本地 source metadata；未记录 API key、真实提示词、provider header 或原始外部内容。
