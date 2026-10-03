# Phase 2.5 主体 opaque ID 合同复验

- 计划：`Arforge-最终详细实施计划-V2-2026-08-11.md` 的 Step 2.5
- 日期：2026-08-14
- 当前结论：`COMPLETED LOCALLY`
- 发布含义：本阶段本地合同门禁关闭；不改变第 8 阶段的 `candidate / DO_NOT_EXIT` 状态

## 目标

Step 2.5 要求控制面主体必须由服务端认证上下文推导，客户端不能通过请求体伪造
`tenantID`、`userID`、`actor` 或 `principalRef`。控制面 ID 还必须绑定认证主体、
location、project 和 action；MCP、local、desktop、OAuth 路径应使用同一主体公式；
迁移或远程路径不能把远程主体降级为 local actor。

## 本次实现

1. `ControlPrincipal.controlPlaneID(...)` 统一生成稳定的 opaque `ctl_` ID，输入为
   服务端派生的 `principalRef`、`location`、`projectID` 和 `action`，不把请求别名
   `requestID` 纳入持久身份。
2. `ControlClaimIndex` 在 claim 派生时 fail-closed 校验主体 opaque ID 与认证主体及
   operation binding 是否一致；仅有正确的 `principalRef` 但使用伪造 ID 也会被拒绝。
3. HTTP control subject、MCP local subject、Evolution governed subject 统一调用共享
   主体公式，移除固定的 `ctl_evolution` 和重复的 inline hash 实现。
4. Protocol 提供 `ControlPlaneMutationPayload`，客户端 mutation envelope 只声明
   `requestID`；主体、租户、用户和 actor 字段由服务端 `IdentityContext` 推导。
5. HTTP mutation groups 复用该协议合同；补充跨租户、跨用户、跨 project、跨 action、
   request alias 和 forged-ID 的回归测试。

## 复验结果

### TypeScript 类型检查

以下命令均通过（exit code 0）：

```text
bun run --cwd packages/protocol typecheck
bun run --cwd packages/core typecheck
bun run --cwd packages/arforge typecheck
```

### 合同与回归测试

```text
packages/schema
  bun test test/control-plane-subject.test.ts
  10 pass, 0 fail, 33 expects

packages/protocol
  bun test test/control-principal.test.ts
  1 pass, 0 fail, 5 expects

packages/core
  bun test test/control-claim-index.test.ts test/authorizer.test.ts test/action-gateway.test.ts
  106 pass, 0 fail, 516 expects

  bun test test/evolution-governed.test.ts
  1 pass, 0 fail, 10 expects

packages/arforge
  bun test test/control-plane/principal-contract.test.ts \
    test/control-operation/service.test.ts \
    test/control-plane/claim-index-status.test.ts \
    test/control-plane/run-coordinator.test.ts \
    test/mcp/local-approval.test.ts
  36 pass, 0 fail, 219 expects
```

目标文件的 Oxlint 检查为 `0 errors`；仍存在既有 warning，因此本记录不把 targeted
lint 写成全仓 lint 全绿。全仓 lint 的历史阻塞项另记于阶段 3.12 证据。

## 边界与未覆盖项

- 本次证据证明的是本地 Schema/Protocol/Core/HTTP/MCP/Evolution 合同和回归，不等同于
  真实生产 Identity Provider、远程 PostgreSQL 或 OAuth 部署证明。
- staging、DigiCert 签名、canary、rollback 和上一份 signed release 属于后续第 8 阶段
  外部门禁，本记录不伪造这些证据。
- `docs/evidence/phase-0-evidence-matrix-20260811.md` 是历史基线，没有被改写；本文件
  是 2026-08-14 的当前复验记录。

## 阶段判断

Step 2.5 的本地实现、合同测试和类型检查已完成。按 V2 顺序，下一项最早未完成的正式
门禁是 Step 3.12；在阶段 0–7 的独立总审查完成前，不进入第 8 阶段发布门禁。
