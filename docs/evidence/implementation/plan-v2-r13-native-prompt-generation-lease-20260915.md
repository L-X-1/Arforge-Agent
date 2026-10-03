# R13 原生 MCP prompt generation lease（2026-09-15）

## 结论

原生 MCP prompt 读取现在与 ToolRegistry 的 prompt 投影使用同一代际租约边界。调用方可以携带脱敏的 `McpCapabilityLease`（兼容旧的数字 generation）；服务在 SDK transport 之前校验 server、kind、稳定 capability ID、prompt 名称和当前 registry generation，并重新核对声明的 transport scope。旧代、错配 ID、名称碰撞或 scope 无法解析时直接返回不可用，不会触达替换后的 MCP Client。

这只收紧了 native prompt 的代际/范围边界；它没有把 HTTP/CLI 目录读取误报成已经经过 control Action/Gateway，也没有关闭 R13 的完整生命周期验收。

## 实现

- `packages/arforge/src/mcp/index.ts`
  - `MCP.getPrompt` 接受完整 `McpCapabilityLease` 或历史数字 generation。
  - 通过 `McpCatalog.sanitize(client):sanitize(name)` 重建稳定 ID，严格匹配当前 prompt capability、server、generation 和原始名称。
  - 所有 native prompt 调用（包括无 generation 的历史兼容入口）在进入 `withClient` 前检查 `declaredScope`；不匹配或 scope 缺失 fail-closed。
- `packages/arforge/src/mcp/resource-projection.ts`
  - prompt Tool.Def 将 registry 的 server、kind、ID、generation 组成完整租约传给 native reader。
- `packages/arforge/src/command/index.ts`
  - MCP slash-command 的延迟 prompt getter 使用同一完整租约，避免旧命令草稿在重连后指向新 prompt。
- `packages/arforge/test/mcp/lifecycle.test.ts`
  - 增加真实 HTTP MCP fixture：有效租约成功；断开并替换 transport 后旧租约被拒绝且请求计数不增加；错配 capability ID 被拒绝。
  - 受控配置 scope 消失时，无 generation 的直接 prompt 兼容调用也在 SDK 前返回空值，服务器请求计数保持不变。

数字 generation 和无 generation 的既有调用仍保持接口兼容；携带 generation/lease 的入口启用严格 capability 绑定，所有入口都必须先通过 declared-scope 检查，避免破坏现有不带代际的基础读取测试。

## 验收证据

| 范围 | 命令/结果 |
| --- | --- |
| 原生 prompt 与既有 timeout/读取回归 | `D:\\bun\\bin\\bun.exe test test/mcp/lifecycle.test.ts --grep "catalog reads fail closed|native MCP prompt reads|uses per-server timeouts" --timeout 30000`：**3 pass / 0 fail / 21 assertions，exit 0** |
| Prompt/resource ToolRegistry 投影 | `D:\\bun\\bin\\bun.exe test test/mcp/resource-projection.test.ts --timeout 30000`：**11 pass / 0 fail / 48 assertions，exit 0** |
| Core 类型 | `D:\\bun\\bin\\bun.exe run typecheck`（`packages/core`）：**exit 0** |
| 格式与差异 | 修改文件 Prettier 通过；限定 `git diff --check` 通过 |
| Oxlint | 根目录 scoped 命令覆盖 4 个修改文件：**0 errors，36 warnings**；警告不影响本切片，仓库已有规则命中 |
| Arforge 包类型 | **未因本切片新增诊断**；仍被既有 `packages/tui` JSX/BaseRenderable 类型错误阻断，详见本轮交付说明 |
| 迁移新鲜度 | 按 Python 依赖账本 → TS composition → source snapshot 顺序重生成；`audit:migration-freshness` 校验退出 0（无新鲜度输出错误） |

测试只使用临时 HTTP MCP fixture、临时 SQLite/内存状态和受控请求计数，不读取或修改用户数据，不使用真实凭据。

## 未关闭项

1. HTTP/CLI `catalog/list/read/template/prompt` 的 control Action/Gateway 身份、外发授权、期限、持久 receipt 和恢复仍待 R13 后续切片。
2. MCP 四类本地 stdio/HTTP 生命周期、断连/同地址重连/代际冷恢复、默认全量失败矩阵和真实外部服务仍待验证；已知 Windows/Bun 本地 stdio 边界失败保持单列。
3. Prompt 原生无 generation 的历史兼容入口现在已强制要求 declared scope，但仍保留名称/代际 lease 兼容形态；正式产品入口应继续从 ToolRegistry/命令投影携带 generation，最终移除旧数字/无代际调用仍待全量消费者审计。
4. full Linux/macOS/Windows sandbox 仍按 R30 完成后执行。
