# Step 6.10 — External API Action 阶段记录

日期：2026-08-12
计划：`Arforge-最终详细实施计划-V2-2026-08-11.md`，Step 6.10
分支：`codex/phase-0-checkpoint`
状态：Core 通用 External API Action 受控 client 与本地 HTTP/Fetch E2E 已落地；未执行 Git push。

## 已落地

- 新增 `@arforge-ai/core/runtime/external-api-action`，所有请求先校验 allowlisted scheme、exact host 和 method；禁止 URL credentials、fragment 及敏感 query 参数。
- Fetch 使用 `redirect: manual`；每个 redirect 都重新执行 scheme/host/credential/query policy，跨 origin 的 secret 默认不转发，只有 `allowedOrigins` 显式允许时才可注入。
- secret 通过 `ExternalApiSecretResolver(ref, target)` 按 `name/scope/origin` 注入 header；原始 secret 不进入 canonical digest、receipt、journal 或错误消息。
- request digest 对 canonical URL、排序后的普通 headers、secret reference、idempotency key、body digest/byte length 计算 SHA-256；真实 body 只在网络边界短暂存在。
- 每次请求强制携带 `Idempotency-Key`；non-idempotent write 的 `maxAttempts > 1` 没有 `lookup` 会在网络请求前 hard-block。
- response 预先检查 `Content-Length`，并以 stream 读取限制最大 byte；可选 content-type allowlist；超限或类型不符不会把 response body 写入诊断。
- `redactExternalText` 覆盖 secret、Bearer、敏感 query value 和 email PII；receipt 只保存 action/trace/operation identity、digest、status、大小、content-type 和脱敏 error 摘要。
- non-read operation 必须提供 read-after-write `verify`；缺失、返回 false 或 verifier 抛错均进入 `ExternalApiRecoveryRequiredError`，不会猜测 settled。
- transport/5xx retry 仅在 read/idempotent write 或 non-idempotent write 的 lookup 报告 `missing` 时允许；lookup 返回 `pending/settled` 直接 RecoveryRequired，不重复发送副作用。
- 提供 `ExternalApiActionJournal` 注入点和进程内 memory journal 作为测试实现；生产路径应由现有 Durable Action/数据库 authority 注入持久 journal，当前阶段没有把 memory journal 宣称为跨进程 durable truth。

## Fresh verification

```powershell
bun run --cwd packages/core typecheck
bun run --cwd packages/arforge typecheck
bun test --cwd packages/core test/runtime/external-api-action.test.ts test/runtime/native-action.test.ts test/durable-action.test.ts
bunx prettier --check packages/core/src/runtime/external-api-action.ts packages/core/src/runtime/index.ts packages/core/test/runtime/external-api-action.test.ts packages/core/src/runtime/native-action.ts packages/core/test/runtime/native-action.test.ts
bunx oxlint packages/core/src/runtime/external-api-action.ts packages/core/test/runtime/external-api-action.test.ts packages/core/src/runtime/index.ts
```

结果：Core/Arforge 类型检查通过；External API Action 6/6、Native Action 4/4、Durable Action 既有回归 16/16；合计 26/26，92 assertions；Prettier 通过；oxlint 0 errors。E2E 覆盖本地 HTTP server 的真实 request header/body、redirect revalidation、scoped secret、response limit/content-type、verifier/recovery，以及 Fetch transport failure + lookup retry。

## 未宣称完成的边界

- 尚未接入某一个具体第三方 API 的生产 adapter，也未使用真实 API key 或访问外部网络；需要明确 provider、host allowlist、secret scope 和 fresh authorization 后才能做实网实验。
- 生产 Durable Action/数据库 journal adapter 尚未在本 Step 新增；调用方必须显式把本地 client receipt 接入现有 Durable Action authority，不能依赖默认 memory journal 做跨进程恢复。
- Step 6.11 的 process/filesystem/worktree/network egress 资源治理尚未开始。
