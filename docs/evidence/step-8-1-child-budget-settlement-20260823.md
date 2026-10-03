# Step 8.1 — Child Run 预算、结算与恢复证据

- 计划：`Arforge-最终详细实施计划-V2-2026-08-11.md` § Step 8.1
- 日期：2026-08-23
- 分支：`codex/phase-0-checkpoint`
- 状态：token/cost/time budget、provider 输出上限、usage 结算与崩溃恢复子步骤完成；未发布、未部署、未 push

## 计划对应

本子步骤补齐 Step 8.1 中 `token/cost/time budget` 的执行闭环，并与已完成的 parent/child identity、显式最小 capability、project/location、deliverable/evidence、deadline/cancel、result digest/status 合并到同一个 DurableRun 事实源。

## 已实现

- `AgentRuntime.Budget` 增加 `maxTokens/tokensUsed`，Child budget 与 attempt-finished 事件增加 token usage；旧历史通过保守默认值继续 strict decode。
- 每个 Session/Child attempt 在开始前持久化 cost/token 累计基线；正常结束和进程中断恢复都按持久化 Session usage 差值结算，不再把崩溃 attempt 记为零消耗。
- provider 请求在发送前扣除已结算 usage、当前 attempt 增量、子任务预留和估算 input token，并把剩余额度作为强制 `maxOutputTokens`；同时遵守模型级或 route 级输出上限，未知模型默认最多 32,000 output tokens。
- V2 `Step.Ended` projector 将 provider cost/token 累加到 Session，确保 DurableRun 恢复读取的是持久事实而非进程内计数。
- Task 子代理默认上限为 2 attempts、15 分钟、1,000,000 cost micros、250,000 tokens，并进一步受父 Run 剩余额度约束；每个 child 的 reservation 与 actual usage 都持久结算回 parent。
- stable `callID` 下的崩溃重试先按 `parentRunID + callID` 恢复既有 child，再复用冻结的 delegation/budget/Session binding，避免重算后的父余额改变已创建合同。
- provider 返回后若观测到的 child cost 或 tokens 超过冻结额度，运行 fail-closed，child 标记 failed，parent 以最大责任额结算，并保留观测值摘要；不会把超额结果伪装成成功。
- 权限审批面板以渐进披露方式显示 attempts、time、cost、token、deadline 和 legacy 警告；文案明确区分执行前输出限制与执行后总 usage/cost 结算。

## 验证结果

| 检查 | 结果 |
|---|---:|
| schema compatibility | 3 passed，0 failed，6 expects |
| DurableRun + ChildRun + Session projector | 51 passed，0 failed，193 expects |
| Core SessionRunner full regression | 95 passed，0 failed，319 expects |
| Arforge Task full regression | 25 passed，0 failed，119 expects |
| Arforge Prompt full regression | 56 passed，14 environment skips，0 failed，317 expects |
| provider request cap regression | 10 passed，357 filtered，0 failed，21 expects |
| permission UX regression | 2 passed，0 failed，6 expects |
| schema/core/arforge/app/ui typecheck | 5 packages successful |

## 失败与恢复场景

- 旧 budget/attempt 事件缺少 token 字段：解码为保守默认值，不把历史当作无限额度。
- provider context overflow：有效输出上限同时读取 model 和 route defaults，避免错误的 32k 默认值触发重复压缩；完整 Core 回归覆盖自动压缩、一次恢复、二次 overflow、raw overflow 与 summary failure。
- worker 在 provider usage 已投影后崩溃：恢复时用 attempt baseline 结算已持久化差值，再开始下一 attempt。
- child 已预留但创建中断：DurableRun 修复 reservation/child aggregate；stable `callID` 重试复用冻结合同。
- provider 报告超预算 usage：child 失败、reservation 清零、parent 结算有界最大责任；不会记录成功 receipt。

## 已知边界

- catalog-backed Core billing 可在请求前做价格预算 reservation；成熟桌面 provider 尚未统一可信价格目录，因此 token/output 可请求前硬限制，实际总 cost 只能在 provider usage 返回后 fail-closed 结算。界面没有把它描述成“费用绝不会超额”。
- input token 使用本地估算器，可能与 provider tokenizer 有偏差；output cap 限制新增输出，provider 返回后的实际 token 仍以观测 usage 为准并执行超额失败。
- 崩溃幂等恢复依赖稳定 `callID`。正式工具调用均提供该标识；手工调用若省略 `callID`，不能获得同等级的 child identity 恢复保证。
- OpenAPI/JS SDK 生成目录当前还混有多个阶段的未审计生成差异；本 checkpoint 不选择性伪造生成快照，下一子步骤将从服务端契约统一重建并核对 capability package。
- 本轮只执行本地 SQLite/fixture 测试和静态检查；没有真实 provider 请求、外部数据库操作、网络写入、发布或部署。
