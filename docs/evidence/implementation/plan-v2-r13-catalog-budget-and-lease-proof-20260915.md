# R13 MCP catalog 共享预算与目标租约 proof（2026-09-15）

## 结论

本切片继续收紧 R13 的统一 MCP 管线：`MCP.catalog()` 的 prompts、resources、resourceTemplates 三类刷新现在共用一次 `CatalogBudget` 事务预算；每个服务器的分页结果先 reserve，完整遍历成功后 commit，失败释放 reservation，不会用一个坏服务器永久占满同一次完整快照的总预算。原有每类分页的 1000 页、10000 项、10 MiB 上限和 semaphore 并发边界保留。

同时，生产 MCP service 增加 `leaseForCapability`。Prompt、resource、resource-template 的 Tool.Def、MCP slash-command 与用户资源读取在最终 native transport 前申请当前 generation lease；资源/模板 lease 由安装级 sealer 对精确 URI（模板还绑定脱敏源模板）计算不可伪造 proof。读取端重新计算 proof，修改 URI、模板或 prompt reference 的租约在 SDK request 前 fail-closed。旧的测试替身和数字 generation/无租约兼容调用仍保持，但生产投影不再自行猜测 lease proof。

HTTP/CLI 的两个 catalog 投影现已接入同一枚 one-shot durable ControlRun 与 `ActionGateway`：HTTP `mcp.capabilities`、`mcp.resource.catalog` 和 TS CLI `mcp capabilities` 共享同一个 service-owned adapter，并在 transport 前冻结 scope、generation 与 action intent。`mcp.list` 仍是只读 supervisor 状态查询；read/template/prompt 的 HTTP/CLI 端点、外发授权、期限、持久 receipt/recovery 仍未完成，因此 R13 继续开放。

## 实现

- `packages/arforge/src/mcp/catalog.ts`
  - 新增 `FullCatalogLimits` 和可共享的 `CatalogBudget`；分页 traversal 通过 transaction lease 进行 reserve/commit/release。
  - `MCP.catalog()` 对三类刷新传递同一预算，完成或失败都关闭总 deadline。
- `packages/arforge/src/mcp/index.ts`
  - `McpCapabilityLease` 增加可选安装绑定 `proof` 与脱敏 `template`。
  - 新增 `leaseForCapability` service method，验证 connected/current generation/registry/current scope，并对本次 generation 目录保留的原始 resource URI/source template 做 exact comparison 后再签发 proof；原始 target 只留在进程内，不进入 capability projection。
  - `getPrompt`、`readResource` 校验 lease reference/proof；服务层仍保持 scope、registry 与 generation fence。
- `packages/arforge/src/mcp/resource-projection.ts`
  - prompt/resource/resource-template/generic resource Tool.Def 统一在 Gateway 执行体内调用 service-owned lease minting；mint 失败不进入 native reader。
- `packages/arforge/src/command/index.ts`
  - MCP slash-command 延迟 getter 申请同一 prompt lease；没有 generation 的历史命令仍走兼容的 scope-gated 读取。
- `packages/arforge/src/mcp/control-gateway.ts`
  - 通过 `ControlClaimIndex`、`DurableRun` 和 `ActionGateway` 创建一条短生命周期、单次执行的 `mcp.catalog.read` control action；scope 漂移、执行异常和父任务中断均 best-effort 收敛到 failed 并释放 opaque lease，不削弱 Core 的 automatic control projection invariant。
- `packages/arforge/src/server/routes/instance/httpapi/handlers/mcp-v2.ts`、`packages/arforge/src/cli/cmd/mcp.ts`
  - HTTP capabilities/resource catalog 与 TS CLI capabilities 调用统一 adapter，并将控制失败映射为用户可理解的 typed error；status/list 保持纯 supervisor 查询。
- `packages/arforge/test/mcp/catalog.test.ts`
  - 保留并回归 aggregate budget 的失败 reservation 释放、共享 deadline、页/项/字节上限。
- `packages/arforge/test/mcp/lifecycle.test.ts`
  - 真实 HTTP fixture 覆盖 prompt proof、篡改 reference 零请求拒绝、含 query/fragment 的 resource exact target proof、resource-template 精确展开 URI proof、篡改模板零请求拒绝；原代际/URI/重连测试继续通过。

## 验收证据

| 范围                                      | 命令/结果                                                                                                                                                                                                                          |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| catalog budget                            | `D:\\bun\\bin\\bun.exe test test/mcp/catalog.test.ts --timeout 30000`：**19 pass / 0 fail / 48 assertions，exit 0**                                                                                                                |
| native lease proof                        | `D:\\bun\\bin\\bun.exe test test/mcp/lifecycle.test.ts --grep "native MCP prompt reads                                                                                                                                             | rejects a resource lease" --timeout 30000`：**2 pass / 0 fail / 31 assertions，exit 0** |
| control gateway durable run               | `D:\\bun\\bin\\bun.exe test test/mcp/lifecycle.test.ts --grep "catalog control gateway settles" --timeout 30000`：**1 pass / 0 fail / 5 assertions，exit 0**；验证 action 对应 ControlRun 已 completed、lease/activeAttempt 已释放 |
| full MCP lifecycle（隔离 Windows native） | `ARFORGE_SANDBOX_DISABLE_WINDOWS_NATIVE=1 D:\\bun\\bin\\bun.exe test test/mcp/lifecycle.test.ts --timeout 30000`：**44 pass / 0 fail / 175 assertions，exit 0**                                                                    |
| resource/prompt projection                | `D:\\bun\\bin\\bun.exe test test/mcp/resource-projection.test.ts --timeout 30000`：**11 pass / 0 fail / 48 assertions，exit 0**                                                                                                    |
| CLI smoke                                 | `D:\\bun\\bin\\bun.exe test test/cli/mcp-capabilities.test.ts --timeout 30000`：**1 pass / 0 fail / 2 assertions，exit 0**                                                                                                         |
| HTTP MCP routes                           | `D:\\bun\\bin\\bun.exe test test/server/httpapi-mcp.test.ts test/server/httpapi-mcp-read-paths.test.ts --timeout 30000`：**9 pass / 0 fail / 73 assertions，exit 0**                                                               |
| HTTP route exercise                       | `D:\\bun\\bin\\bun.exe run script/httpapi-exercise.ts --mode coverage`：**428 pass / 0 fail / 0 skip / 4 missing**，退出 0（4 个既有 `/api/fs/*` 场景缺失；严格 `--fail-on-missing` 会按工具合同退出 1）                           |
| 迁移 freshness                             | 按 Python 依赖 → TS composition → source snapshot 顺序重生成后 `D:\\bun\\bin\\bun.exe run audit:migration-freshness -- --root .`：**valid=true**；Python 扫描 5095、依赖叶 6709、资产 6；TS source 1797、composition root/binding/runner 3/5/3；source inputs 7700；capability links 4 records / 4 missing evidence |
| TypeScript                                | `packages/arforge` `D:\\bun\\bin\\bun.exe run typecheck`：exit 2；仅报告既有 `packages/tui` JSX/BaseRenderable 诊断，本切片的 MCP/command/resource-projection 没有新增诊断                                                         |
| 格式/差异                                 | 修改文件 Prettier 通过；限定 `git diff --check` 通过                                                                                                                                                                               |

测试只使用临时 HTTP MCP fixture、临时 SQLite/内存状态和受控 request counter，不读取或修改用户数据，不使用真实凭据，不执行三平台 full sandbox。

## 未关闭项

1. HTTP/CLI `mcp.capabilities`、`mcp.resource.catalog` 与 `mcp capabilities` 已使用 one-shot control Action/Gateway；`mcp.list` 仍为 supervisor 状态读取，read/template/prompt 端点尚不存在，所有用户侧操作的外发授权、期限、持久 receipt 与恢复仍未闭合。
2. RFC 6570 模板的更细 pattern 授权仍依赖当前 registry source template 与安装 proof，尚未形成独立的用户可配置 pattern policy。
3. 默认 Windows native lifecycle 的 `current_directory` 与 stdio fixture PID 两个已知边界仍未关闭；完整冷恢复、默认全量 MCP 矩阵和真实外部 Provider 继续待验收。
4. 旧数字/无 generation 消费者、HTTP/CLI/桌面全旅程和 full Linux/macOS/Windows sandbox 仍按计划后置；R13 未关闭，R31 仍只在 R30 后执行。
