# Step 8.5 A2A V1 私有协议证据

日期：2026-08-23
状态：本地私有协议、持久 transport 与 child 结算闭环完成；网络入口保持 fail-closed

## 计划对应

本阶段对应 V2 Step 8.5：authenticated agent identity、task envelope、delegated capability reference、budget/deadline、status stream、artifact/evidence receipt、cancel/revoke、nonce/idempotency、signature/channel policy，以及“远端不能直接获得本地 filesystem/tool token，remote result 必须由本地 verifier 或可信 receipt 验证”。

## 已实现

### 1. 严格 wire contract

- `packages/schema/src/a2a.ts` 定义 bounded A2A V1 Schema：peer identity、channel、task、capability reference、budget、status、result usage、artifact/evidence refs、cancel/revoke 和 durable events。
- `packages/core/src/runtime/a2a.ts` 对所有 envelope/receipt/control request 做 strict decode 与 canonical digest 校验；额外 local token、过期 delegation、跨 tenant/channel、payload 漂移和 divergent replay 均 fail-closed。
- capability 只能缩小 action/resource/access/expiry；read 不得升级为 write。
- ResultReceipt 必须携带 attempts/duration/cost/tokens，且不能超过 task budget；completed/failed 至少包含一次 attempt。

### 2. 不可伪造的本地 admission

- transport 配置启动时验证 local Ed25519 公私钥配对、peer allowlist 唯一性、同 tenant/channel、bounded verifier allowlist 与 capability resolver。
- sender 必须命中固定 peer identity + Ed25519 key；recipient 必须是本地 node；channel 必须与本地 policy 完全一致。
- capability 的 `referenceID/grantDigest/scope/expiry` 必须由本地 capability registry resolver 返回完全一致的授权元数据；随后 DurableRun 再次按父 SessionRun 的 delegable capability 与剩余预算执行 admission。
- 只传 capability reference 与 bounded scope，不传 filesystem token、tool token、secret 或本地 bearer capability。

### 3. nonce、幂等与 durable aggregate

- task/control nonce 使用独立 EventV2 aggregate 和 CAS claim，防止跨 task 重放。
- nonce 在 child admission 之前占用；重复 nonce 被拒绝时不会留下已排队的孤儿 child Run；同一 signed envelope 的崩溃重试仍可复用 claim。
- task aggregate 强制 accepted 起点、连续 sequence、单向状态机、单一 result、terminal 后无尾事件，并拒绝 nonce/task 跨 aggregate family 混入。
- status lookup 对 cursor/page size 做 safe-integer 与 1-100 边界检查；非法值不会被静默截断。

### 4. verifier-bound result 与 child 结算

- 当前本地 transport 只接受 `local-verifier` receipt；verifier ID 必须在显式 allowlist，证据验证回调必须返回通过，receipt 再由本地 Ed25519 key 验证。
- verified usage 被物化为 Durable child attempts；completed、failed、cancelled 会同步 child 终态、usage、ChildRunResult 与父预算结算。
- 多次失败 attempt、零 attempt cancellation 与 idempotent result replay 均有测试；cancel/revoke/超时也会写入 cancelled ChildRunResult，而不只改变 Run 状态。
- TaskResult 已提交、child 尚未结算的崩溃间隙由 `recover()` 补齐；过期/terminal task 与 child 的不一致也会 fail-closed 处理。

### 5. Protocol/Effect HttpApi

- `packages/protocol/src/groups/a2a.ts` 定义 submit、status、result、cancel、revoke 五类 Effect HttpApi/OpenAPI 合同。
- 该 group 不加入默认 public API。只有显式配置 peer request-context、key registry/mTLS 和 private transport 后才可由后续私有 server adapter 挂载，避免出现未经认证却“看似可用”的入口。
- `script/run-stage8-local-evidence.ts` 改为 minimum pass count，新增安全测试时不会因脆弱的固定总数而误判；本地 capability/revocation evidence 已实际执行为 pass。

## 验证结果

| 检查 | 结果 |
|---|---:|
| A2A contract + local transport | 15 passed，0 failed，64 expects |
| A2A + DurableRun/ChildRun + manifest 扩展回归 | 62 passed，0 failed，253 expects |
| schema event/manifest 回归 | 5 passed，0 failed，32 expects |
| core/schema/protocol typecheck | 3 packages passed |
| 本阶段 7 个相关文件定向 oxlint | 0 warnings，0 errors |
| local capability/revocation evidence runner | pass；11 tests observed |

## 明确边界

- 本阶段完成的是可注入、可持久恢复的私有 A2A V1 后端与 HttpApi 合同，不是公网部署。当前未挂载默认路由，也未发送网络请求。
- `trusted-receipt` 保留在 wire schema，但本地 transport 仍禁用；启用前需要独立 verifier key allowlist、轮换与撤销策略。
- 本地 verifier 必须先验证远端结果/证据，再生成并签名 canonical receipt；transport 不接受未经验证的 raw remote output。
- 真正跨机器运行仍需要用户以后提供 peer key registry/mTLS CA、私有 server identity binding 和 remote executor 环境；这些属于显式网络配置/部署，不阻塞当前本地功能交付。
- 未执行外部网络调用、发布、部署或 git push。
