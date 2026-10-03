# R14 Embedding SecretProvider 接线切片（2026-09-14）

## 结论

本批把 R14 的密钥边界再推进一层：`RuntimeEmbedding.RemoteRequest` 不再携带明文 `apiKey`，而是只携带名称和延迟解析函数；新增的 `makeSecretBackedRemoteRequest` 复用现有 `SecretProvider`。`embedBatch` 先检查取消/期限、endpoint、输入上限和 `Egress.Authorizer`，通过后才解析凭据，随后才进入 HTTP transport。凭据解析失败不会被标记为已发送，网络拒绝时解析函数调用次数为 0。

该切片没有新增凭据存储、网络策略或 embedding engine。Memory/CodeRetrieval 的调用者仍必须显式构造并传入授权请求；Credential store、生产 Memory 远程服务注入、真实外部入口矩阵和外发审计持久化仍是 R14 开放项。

## 实现

- `packages/core/src/runtime/embedding.ts`
  - 新增 `RemoteCredential`，将 API key 改为 `{ name, resolve }`，请求规格本身不含 secret value。
  - 新增 `makeSecretBackedRemoteRequest` Effect 构造器，唯一复用 `SecretProvider.Service.resolve`；拒绝非法环境名。
  - transport 顺序固定为 Egress assertion → bounded body validation → credential resolve → `onTransportStart` → `fetch`。
  - 凭据缺失/解析错误在 transport 前回退到 hashing，并保留 `egress=denied`；发送后的失败继续保留 `egress=sent/unknown` 与 `localOnly=false`。
- 既有 `Memory` 测试 fixture 已迁移到不携带明文 key 的 RemoteRequest；没有修改既有 Credential/Integration owner。

## 验收证据

| 范围 | 命令/结果 | 原始输出 |
| --- | --- | --- |
| RuntimeEmbedding | 10 pass / 0 fail / 24 assertions，exit 0 | [原始测试输出](./plan-v2-r14-embedding-secret-provider-20260914.txt) |
| Memory regression | 11 pass / 0 fail / 76 assertions，exit 0 | [原始测试输出](./plan-v2-r14-embedding-secret-provider-20260914.txt) |
| Core 类型 | `bun run typecheck` exit 0 | [原始测试输出](./plan-v2-r14-embedding-secret-provider-20260914.txt) |
| 修改文件 scoped Oxlint | 0 warnings / 0 errors | [原始测试输出](./plan-v2-r14-embedding-secret-provider-20260914.txt) |

专项覆盖：SecretProvider-backed request 的 JSON 不含 secret value；授权通过后 loopback fixture 收到 `Bearer`；Egress 拒绝时 resolver 不被调用；既有未授权零网络、远程失败 fallback 和预取消场景仍通过。所有网络均为本机 loopback fixture，无真实凭据或用户数据。

## 计划归属与边界

对应 R14 第 2—5 项的 SecretProvider/transport seam。它只证明“密钥不进入请求规格且在 Egress 之后解析”，不等于生产 Memory 远程入口或全外部入口验收；R14、R08、R09、R13、R17、R30 仍开放，真实 Linux/macOS/Windows full sandbox 仍按用户要求最后执行。
