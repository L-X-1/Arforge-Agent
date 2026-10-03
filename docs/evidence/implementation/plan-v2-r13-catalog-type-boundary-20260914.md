# R13 MCP 目录分页类型边界追补（2026-09-14）

## 结论

R13 目录聚合预算切片的运行测试已经通过，但 TypeScript 原生类型检查暴露了一个真实边界：MCP 最后一页可以合法省略 `nextCursor`，而 `paginate` 的原泛型约束会把这类 fixture 的页面错误地推断成只有 `nextCursor` 的约束类型。现已在同一 `McpCatalog.paginate` owner 内修复，不增加第二套分页器，也没有放宽运行时边界。

`paginate` 现在从页面类型推断调用方的条目字段；在 MCP 响应边界读取 `nextCursor`，允许字段缺失，拒绝非字符串 cursor，并继续拒绝重复 cursor、超页和超预算。这样同时覆盖了真实 SDK 页面类型与无 cursor 的最终页，而不是通过修改测试断言规避类型错误。

## 实现与验证

- `packages/arforge/src/mcp/catalog.ts`
  - `paginate<T, R>` 不再以可选 cursor 约束干扰页面泛型推断。
  - 对 wire page 的 `nextCursor` 做 `undefined|string` 运行时校验；非字符串立即 fail-closed。
- `packages/arforge/test/mcp/catalog.test.ts`
  - 新增非字符串 cursor 拒绝用例。

| 范围 | 结果 |
| --- | --- |
| MCP catalog 专项 | **19 pass / 0 fail / 48 assertions / exit 0** |
| `packages/arforge` typecheck | exit 2；已无 `catalog.ts` 或 `catalog.test.ts` 诊断，仅剩既有 `packages/tui` JSX/BaseRenderable 诊断 |
| 本切片 Oxlint（关闭当前仓库失配的嵌套 typeAware 配置） | **0 warnings / 0 errors** |
| 迁移新鲜度（本切片同步后） | `valid=true`；source inputs=7576，TS composition=1757/3/5/3，Python dependency=7293/7500/6；历史 capability links 仍有 4 条缺证据记录 |

## 边界

- 这只修复 R13 聚合预算切片的类型契约与 cursor 运行时校验，不代表 R13 的 Action/Gateway 目录 read/prompt、rich Artifact、stdio/HTTP 完整生命周期已完成。
- 默认 MCP 生命周期中的 2 个 Windows Bun 1.3.14 + BaseContainer 授权 cwd 失败仍按原证据保留；未切换到 partial/legacy sandbox。
- `packages/arforge` 包级 typecheck 仍被既有 TUI 依赖类型问题阻断；本次已确认 MCP 类型错误从阻断集合中移除。

## 迁移新鲜度原始输出

`bun run audit:migration-freshness`：exit 0，`valid=true`。所有 7 个检查（Python capabilities/tests/dependencies、TS composition、TS boot、source inputs、capability links）均为 valid；该门禁只证明证据输入未漂移，不代表 R13 或整计划完成。
