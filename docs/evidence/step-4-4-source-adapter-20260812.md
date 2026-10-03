# Step 4.4 Source Adapter 证据

日期：2026-08-12

计划位置：`Arforge-最终详细实施计划-V2-2026-08-11.md`，Step 4.4

状态：已完成

## 统一 adapter contract

`packages/core/src/source-adapter.ts` 为 static、session、filesystem、Git、LSP、MCP、web、memory、learning、workflow、tool-output 提供显式 adapter factory。factory 只接收宿主已有的 read/search loader，因此 adapter 不拥有新的 authority，也不复制既有 service。

每次读取都会：

1. 校验 source type/adapter identity；
2. 传播 cancellation signal，并执行 deadline；
3. 规范化换行；
4. 同时执行 source 与 request 的 byte/token bound；
5. 计算 bounded text digest，标记 truncation；
6. 按 Source Registry redaction policy 生成 bounded Evidence summary；
7. 通过唯一 Evidence service 生成 source/artifact reference，不持久化 raw payload。

失败会归一化为 `cancelled`、`deadline`、`byte_limit`、`not_found`、`permission`、`unavailable`、`invalid` 或 `unknown`，外部 MCP/web 来源沿用 Source Registry 的 untrusted trust/instruction policy。

## 验证

- `bun run --cwd packages/core typecheck`：通过；
- `bun test --cwd packages/core test/source-adapter.test.ts test/evidence.test.ts test/runtime/compiler.test.ts`：17 pass、0 fail；
- `oxlint`：Source Adapter/Evidence 新增文件 0 warnings、0 errors；
- 测试覆盖 filesystem/web adapter factory、换行规范化、byte/token 限制、digest、取消/deadline、redaction、Evidence 唯一写入与不提升外部指令权限。

实际 filesystem/Git/session/memory/LSP 读取函数由现有宿主 service 注入，下一步 Code Retrieval 在 adapter contract 上组合检索，不另建来源真相。
