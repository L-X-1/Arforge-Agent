# R09 压缩请求身份与事务恢复切片（2026-09-14）

## 结论

本批补齐 R09 的一个请求边界切片：事务式压缩的摘要模型请求继续由既有 `SessionCompaction` 唯一 owner 准备、提交、读取和发送，并把外层 `SessionRunner` 的 `runID`、`turnStep`、`attempt` 写入同一 `RequestEnvelope.execution`。摘要请求的最终 transmission 仍在发送前复核；请求事件、摘要 checkpoint、Session settlement 使用同一 operation/candidate identity，重启恢复继续只接受已发布的 settlement，不重调模型。此次没有新增 compaction engine、Action owner 或第二份摘要日志。

这不是 R09 整项完成。prepare/summarize/revalidate/commit/close 每个故障点的完整强杀矩阵、摘要未知结果的用户处置、跨入口正式旅程、Artifact 失效/回收和压缩后的结算/费用投影仍开放。

## 实现与唯一 owner

- `packages/core/src/session/compaction.ts`
  - `TransactionInput`/压缩输入接受可选的外层 `runID`、`turnStep`、`attempt`。
  - 摘要 `RequestEnvelope` 沿现有 prepare/streamPrepared 管线写入这些执行身份，并继续用提交后的事件内容复核 digest 与 transmission。
- `packages/core/src/session/runner/llm.ts`
  - automatic overflow 与 proactive compaction 都把当前 durable active attempt/step 传给同一 `SessionCompaction` owner。
- `packages/core/test/session-runner.test.ts`
  - 实际 overflow 旅程断言摘要请求 envelope 具备 run/step/attempt 身份，同时保留请求持久化失败、摘要不完整、billing 与恢复回归。

## 验收证据

| 范围 | 命令/结果 | 原始输出 |
| --- | --- | --- |
| 正式 SessionRunner 压缩/overflow/故障边界 | 15 pass / 0 fail / 70 assertions；187 filtered，exit 0 | [compaction runner test](./plan-v2-r09-compaction-request-identity-20260914.txt) |
| ContextSurface async transaction | 12 pass / 0 fail / 68 assertions，exit 0 | [compaction runner test](./plan-v2-r09-compaction-request-identity-20260914.txt) |
| Durable checkpoint/recovery | 5 pass / 0 fail / 21 assertions，exit 0 | [compaction runner test](./plan-v2-r09-compaction-request-identity-20260914.txt) |
| Compaction prompt/invariant | 3 pass / 0 fail / 8 assertions，exit 0 | [compaction runner test](./plan-v2-r09-compaction-request-identity-20260914.txt) |
| Core 类型 | `bun run typecheck` exit 0 | [compaction runner test](./plan-v2-r09-compaction-request-identity-20260914.txt) |

## 边界

1. RequestEnvelope execution identity 是摘要请求的 durable 关联信息，不包含 credential value；它不能把 Provider 发送与数据库提交变成物理原子操作。
2. `RequestPrepared` 事件仍保持旧字段兼容，旧摘要事件缺少新 execution 字段时由既有 envelope 解析规则处理；新压缩请求由当前 SessionRunner 填充。
3. 本批未宣称真实外部 Provider、跨平台 sandbox 或所有中途强杀点通过；full Linux/macOS/Windows sandbox 仍按用户顺序后置到 R31。

## 计划归属

对应 R09 第 1 项“接入 R06 相同请求准备、attempt、durable dispatch”的摘要请求身份切片，并为后续 prepare/summarize/commit 故障注入复用同一 durable owner。R09、R08、R13、R17 仍开放。
