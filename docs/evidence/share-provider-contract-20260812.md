# Step 6.7 — Share/Unshare Provider contract 阶段记录

日期：2026-08-12
计划：`Arforge-最终详细实施计划-V2-2026-08-11.md`，Step 6.7
分支：`codex/phase-0-checkpoint`
状态：self-hosted provider 已落地并接入默认 Provider node；未执行 Git push。

## 已落地

- 定义 `publish(operationID, frozenExport, exportDigest, target)`。
- 定义 `lookup(operationID)`，状态包括 `missing/pending/settled/conflict`。
- 定义 `revoke(operationID, publicationID, originalDigest, target)`。
- 定义 `lookupRevoke(operationID)`，同样保留可重协调状态。
- publish receipt 固定返回 provider receipt ID、publication ID/URL、stored digest、visibility、organization。
- revoke receipt 固定绑定 publication ID、原始 export digest、visibility、organization。
- verifier 拒绝 endpoint origin 漂移、HTTPS/credential/fragment 异常、digest/target/publication identity 不匹配和不完整 settled receipt。
- provider adapter 缺失时返回 typed `ProviderUnavailableError`，不把 POST 返回或本地猜测当作 settled 证明。
- experimental Share/Unshare 新请求在 capture/claim 前读取 provider 的本地 readiness；disabled/unavailable 时直接 HTTP 503，既有 requestID 只允许读取原 durable 状态，且不会新建审批或 ControlRun。
- 新增只读本地 exporter：在同一数据库事务内捕获 Event HWM 前后边界，读取 session/message/part 投影并二次校验 HWM 与 canonical hash；share 只允许无既有 publication 的 Session，unshare 只允许从已验证 durable share receipt 解析原始 publication；通过后才 seal immutable export。该路径不调用 provider、不写 session share 元数据。
- 新增 append-only `session_share_operation_receipt` durable projection 及 SQLite/PostgreSQL 迁移；receipt store 只接受通过 provider verifier 的 settled publish/revoke 响应，绑定 operation/run/action/request、snapshot/export digest、publication identity、target 和 response digest，并对同 operationID 做幂等/冲突保护。
- Share/Unshare 已接入现有 Durable ControlRun：request handler 只负责 capture、claim、L3 approval 与 schedule；location-bound scheduler 复用通用 lease/heartbeat/deadline/recovery worker；executor 先执行 publish/revoke + lookup，再写 verified receipt，最后更新 Session publication pointer。disabled provider 会产生 RecoveryRequired/paused，不会推测网络结果。
- legacy `SessionShare`、`ShareNext` 与 auto-share 入口继续 hard-block/suppress。
- 新增 self-hosted provider 事实源：`self_hosted_share_publication` 保存不可变 frozen export、operation digest、export digest 与 publication receipt；`self_hosted_share_revocation` 保存 append-only 撤销事实。两张表均有 SQLite/PostgreSQL 迁移、租户/用户隔离和唯一 operation/publication 约束。
- self-hosted 实现已成为默认 `SessionShareProvider.node`；同 operationID + 同 export/original digest 重试返回相同 receipt，不同 digest 冲突；target/publication 变化会被拒绝，不会把同 digest 的不同目标误报成可 settled 结果。
- 新增受进程内 capability 保护的 HTTP API：`POST /api/self-hosted-share/publish`、`GET /api/self-hosted-share/lookup/:operationID`、`POST /api/self-hosted-share/revoke`、`GET /api/self-hosted-share/revoke/:operationID`。缺少 `x-arforge-provider-internal` capability 时返回 403，避免绕过 ControlRun/L3 直接写 Provider。
- self-hosted provider 在落库前重算 canonical export digest 与 canonical byte count；响应仍必须经过现有 provider verifier 和 durable receipt store 才能更新 Session publication pointer。

## Repository contract audit

历史 `ShareNext` 实现只证明了以下旧接口形状：创建使用 `/api/share` 或 `/api/shares`，body 为 `sessionID`，响应为 `id/url/secret`；同步使用 `POST /:id/sync`，删除使用 `DELETE /:id` 并携带 `secret`。该接口没有 `operationID` 幂等键、`lookup`/`lookupRevoke`、`storedDigest` 或冲突响应语义，因此不能作为 Step 6.7 的真实 provider adapter，也不能据此推断远端已 settled。

## Fresh verification

```powershell
bun run --cwd packages/arforge typecheck
bun run --cwd packages/core typecheck
bun run --cwd packages/core script/migration.ts --check
bun test --cwd packages/arforge test/control-operation/session-share-operation.test.ts test/share/readonly-local.test.ts test/share/receipt-store.test.ts test/share/provider.test.ts test/share/session-snapshot.test.ts test/share/share-next.test.ts --max-concurrency=1 --parallel=1
bun test --cwd packages/arforge test/server/httpapi-experimental.test.ts --max-concurrency=1 --parallel=1
```

结果：arforge/core typecheck 通过；数据库迁移检查通过；原有 Share/ControlRun 测试 25/25 通过，新增 self-hosted persistence 测试 1/1 通过；self-hosted HTTP publish/lookup/revoke/reconcile/conflict E2E 1/1 通过；HTTP experimental 回归 11/11 通过。

## 剩余边界

self-hosted provider 已满足 Step 6.7 的本地真实合同和 E2E；仍未宣称第三方 remote provider、网络故障 crash matrix 或多节点部署证据。旧 `SessionShare`、`ShareNext` 写入口继续 hard-block，后续按计划进入 Step 6.8 及其阶段门禁。
