# Phase 2.5 — Control principal / actor identity inventory

日期：2026-08-11
计划基线：`Arforge-最终详细实施计划-V2-2026-08-11.md`
状态：方案 A 已实施并完成 focused 验证；数据库/RLS 仍按计划保留到 Step 2.10

## V2 要求

Step 2.5 要求同时收敛 Schema、Core、Protocol、MCP 和测试：

1. principal 只能来自 server authentication / `IdentityContext`，不能来自 request body。
2. actor 使用 server-derived opaque principal reference，或在 subject 中增加不可伪造 `principalRef`。
3. `operationID` / `claimDigest` 绑定 tenant、user、project、location。
4. MCP/local/desktop/OAuth 使用统一 principal 公式。
5. 保留本地 `ten_local/usr_local` 兼容，但 remote 不得降级为 local actor。

## 已实施合同

- `AgentRuntime.ControlPrincipalRef` 是 `prn_` branded ID。
- `AgentRuntime.ControlPlaneSubject` 增加必填 `principalRef`，`actor: "user"` 保持 A1 角色语义。
- `packages/core/src/runtime/control-principal.ts` 统一派生公式：
  `prn_ + sha256("arforge.control-principal/v1" + NUL + tenantID + NUL + userID).slice(0, 32)`。
- HTTP、MCP/local 和 detached-compatible local principal 都使用同一公式；HTTP 的 subject ID 使用
  `arforge.control-subject/v3` 并绑定 principalRef、location、project、action。

## 当前真实链路

### 身份来源

- `packages/server/src/identity-context.ts` 已提供 request-scoped `IdentityContext.Current`，字段包括 `tenantID`、`userID`、role、sessionID。
- `packages/arforge/src/server/routes/instance/httpapi/handlers/experimental.ts` 的 HTTP control 入口从 `IdentityContext.Current` 读取 tenant/user；不存在身份时 fail closed。
- `packages/core/src/runtime/control-claim-index.ts` 使用 request-scoped `CurrentPrincipal` Context，不从长生命周期 Location layer 捕获 principal。

### 收敛结果

- `AgentRuntime.ControlPlaneActor` 仍是 `Schema.Literal("user")`。
- `AgentRuntime.ControlPlaneSubject` 现在要求 `principalRef`，缺失时 Schema decode fail closed。
- HTTP 与 MCP/local subject 都携带服务端派生 principalRef；MCP/local 不再仅按 directory/server key 推导 subject。
- `ControlClaimIndex` 在 claim 时重新由 authenticated principal 计算 principalRef，不匹配即拒绝；`fixedSubject`、subject equality、Action ID、DurableRun operation/run ID、claim digest、approval key 和状态查询均纳入 principalRef。
- HTTP worktree control 目前只允许 `ten_local/usr_local` 进入 detached worker；非本地主体会在准备/接受前 fail closed。这是现状兼容闸门，不是最终多租户方案。

## 已确认的方案决策

用户已明确选择方案 A：在 `ControlPlaneSubject` 增加必填、服务端派生的 opaque `principalRef`，保留 `actor: "user"` 作为角色类别。

影响已落实：Schema、OpenAPI/Protocol 可见生成面、generated SDK、所有 subject 构造器和 focused tests 已同步。

## 已确认的不变量

- request body 中不得出现可信 principal 字段。
- remote authenticated principal 缺失时必须拒绝，不能退回 `ten_local/usr_local`。
- detached recovery 必须重新从可信 server-side principal index / durable binding 验证主体，不能信任浏览器或 MCP 传入的 actor。
- 本盘点未执行数据库迁移、RLS、备份恢复或远端 Git 操作。

## 新鲜验证证据

通过：

- `bun run typecheck`：`packages/schema`、`packages/core`、`packages/arforge`、`packages/protocol`、`packages/sdk/js`、`packages/server`、`packages/app`。
- Schema subject focused test：10/10。
- Core ActionGateway、Authorizer、ControlClaimIndex、DurableRun focused tests：129/129。
- arforge ControlOperation service focused test：6/6；相关 scheduler/worker/status/coordinator/runtime-insight tests此前及本批通过。
- SDK contract tests：2/2。
- `packages/sdk/openapi.json` 与 `packages/sdk/js/src/v2/gen/types.gen.ts` 均包含必填 `principalRef`。

已隔离、未归因于 principalRef 的既有测试差异：

- arforge MCP local-approval 全文件首个失败仍是旧的 metadata 断言；后续等待断言因该失败级联。
- app control-approval focused test 有 4 个既有异步 harness 失败；本批只更新其 subject fixture 以满足新契约。
- OpenAPI 生成入口的最终 `./script/format.ts` 调用在 Windows 下报告 `bun: command not found`，但 SDK 生成和类型检查已完成；该脚本兼容性另记为工具链问题。
