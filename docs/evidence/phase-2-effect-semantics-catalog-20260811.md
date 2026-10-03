# Phase 2.4 — Action effect semantics catalog evidence

日期：2026-08-11
计划基线：`Arforge-最终详细实施计划-V2-2026-08-11.md`
范围：Core `ToolRegistry` 内置工具、HTTP control operation worktree handlers

## 结论

Step 2.4 的 catalog/audit 基础已落地：所有已注册 Core 内置工具都通过中心化 `ToolManifest` 记录 deadline、recovery、外部操作、network egress 和 secret ownership；风险等级、authority、幂等性、重试性、补偿、资源、artifact、success criteria 和具体 scope 继续由工具的 canonical `EffectSemantics` 声明产生。

HTTP control operation 的 `worktree.create`、`worktree.remove`、`worktree.reset` 也已进入独立 control catalog；三类操作共用一个中心化 `worktreeEffectSemantics` 构造器，snapshot handler 只提供 operation-specific resources 和 verification criteria。

## 生成式审计合同

### Core

- manifest：`packages/core/src/tool/effect-catalog.ts`
- runtime declaration：`packages/core/src/tool/tool.ts`
- registry read-only inventory：`packages/core/src/tool/registry.ts` 的 `ToolRegistry.catalog`
- audit：`auditBuiltInToolCatalog`
- 内置覆盖数：36/36
- `missing`：0
- `undeclaredEffects`（仍使用 default-deny）：0
- `invalidDeadlines`：0

### HTTP control operation

- manifest 和语义构造器：`packages/arforge/src/control-operation/effect-catalog.ts`
- handler 接入：`packages/arforge/src/control-operation/worktree-snapshot.ts`
- 覆盖数：3/3
- `missing`：0
- `invalidDeadlines`：0
- recovery：三类均为 `manual`

## 语义边界

1. `EffectSemantics` 是实际 ActionGateway intent 的唯一风险和 scope 合同；handler 不再为 worktree control operation 复制 L3/authority/retry/egress 常量。
2. 具有显式 leaf `context.permission.assert` 的工具保持 L3 human 声明，防止把已有用户授权路径错误降级为自动执行；纯 session projection、只读查询和无 leaf 授权的操作才使用 L0/L1 或 scoped change。
3. catalog 只补充不能从任意输入推导的 operational metadata，不接受 request body 中的 secret 或 network scope 作为可信授权来源。
4. 本步骤没有数据库迁移、RLS、备份恢复、远端 Git 或 Windows 打包操作。

## 新鲜验证证据

通过：

- `bun run typecheck`（`packages/core`）
- `bun run typecheck`（`packages/arforge`）
- `bun test test/tool-effect-catalog.test.ts`（Core：1/1）
- `bun test test/control-operation/effect-catalog.test.ts`（arforge：2/2）
- `bun test test/control-operation/worktree-snapshot.test.ts test/control-operation/service.test.ts test/control-operation/worktree-worker.test.ts test/control-operation/effect-catalog.test.ts`（arforge：33/33，196 assertions）
- Core 受影响工具回归：goal update 2/2、notebook 5/5、question 4/4、skill 1/1、task graph 1/1、team 1/1、todo write 2/2、multimodal diagnosis 的领域单元测试 2/2。

已隔离、未归因于本批 catalog 的既有 Core 测试差异：

- `multimodal-diagnosis.test.ts` 的一个工具授权 metadata 断言仍期待旧的 leaf metadata 投影；即使临时移除本批新增的 catalog introspection 和该工具 effect declaration，该断言仍失败。
- `primary-delivery.test.ts` 的一个测试仍观察到重复的 `deliver_user_message` permission action；同样在临时移除本批 catalog introspection 和该工具 effect declaration 后仍存在。

这两项不作为 Step 2.4 的通过证据；它们应在后续授权收敛/Tool Gateway 清理中单独处理。Step 2.4 的 catalog 审计本身为通过状态。

## 下一步

按 V2 继续进入 Step 2.5：收敛 control principal 与 actor 身份。该步骤涉及 Schema、Core、Protocol、MCP 和测试，开始前仍不进行数据库迁移或远端传送。
