# R01 → R08：失败工具调用阻断融入现有 Repeat Guard

日期：2026-09-05。用户目标仍为完整新计划；本批只完成失败重复调用的一个运行时切片，不关闭 R01/R08。

## 需求与实现

旧 `arforge/core/capability_eval.py::_eval_self_correct_repeat_block` 的关键要求是：相同失败工具调用提出两次，executor 只执行一次，并产生阻断事件。检查发现现有 TS Guard 只按连续调用次数计数，默认允许前三次；它已接入正式 Runner 和持久工具结果路径，但没有消费失败结果。

本批直接扩展既有 `session/repeat-guard.ts`：

- 同一用户周期、同一连续调用输入的结果已确认失败后，下一次原样调用立即阻断。
- 成功调用保留原三次阈值；改变输入/工具、用户 steer 或新的 queued cycle 保留既有重置行为。
- 只保存已有规范摘要及失败标志，不保存输入原文、不新增失败数据库或第二 Registry。
- `recordOutcome` 只在 Runner 有序发布实际结果之后调用；不从后台完成回调乱序更新 Guard。类型化工具错误及非中断 defect 都覆盖。中断/用户拒绝仍沿原收敛路径处理。
- 阻断仍发生在现有 Runner → ToolRegistry/ActionGateway 之前，继续使用既有 Tool.Failed 投影；审计增加 blockReason，模型下一轮可以读取“上次执行失败，请修改输入或改换行动”。

此处不是给任意错误自动重试的授权；无需改写既有 Provider Retry、scheduler、settlement 或 Action 恢复系统。

## 实际测试

1. 新 Guard 测试先得到 2 failed（缺少 recordOutcome），实现后通过。
2. 新增实际 SessionRunner 场景，类型化工具失败和 defect 各一例：两次同输入调用只执行一次 executor；第三轮请求含 previous execution failed；持久会话投影为两个错误结果；审计 reason=previous-failure、repeatCount=2。
3. 单元测试确认规范键顺序相同仍被阻断、修改输入允许、无关失败不污染当前连续调用、成功/显式 reset 不误阻断。
4. 最终全量运行受影响的两文件：**115 passed / 441 assertions / 55.56 s**，其中包含原三次成功调用阈值、并发工具、授权、取消、恢复、输入推进等既有 Runner 场景。
5. Core 全包 typecheck 通过；两 Guard 文件 oxlint --deny-warnings 为 0 warnings / 0 errors；四个受影响 TS 文件及关联 JSON 的 Prettier check 通过。
6. 四文件整体 oxlint --deny-warnings **未通过**：检查报告 57 warnings / 0 errors，含 Runner 中未使用 ResultPruner、测试中已有类型断言等。未禁用规则或清理无关代码；本批不得宣称全文件 lint 或整体交付门禁通过。
7. 原生成器刷新 composition/dependency 投影后，统一新鲜度集成测试 **2 passed / 7 assertions**、七项检查通过；关联数为 4，均缺完整 receipt。最终本批 **117 passed / 448 assertions**，源码输入 7,452 项。这不是整体功能验收分母。

```powershell
# packages/core
bun test test/session-repeat-guard.test.ts test/session-runner.test.ts --rerun-every
bun run typecheck
# 根目录
bun run oxlint --deny-warnings packages/core/src/session/repeat-guard.ts packages/core/test/session-repeat-guard.test.ts
```

Runner 测试使用真实 TS Runner/Registry/事件投影和受控工具 executor，Provider 为确定性测试替身；不是外部模型、真实 shell 副作用或三平台测试。旧 Python sc2 本批读取实码要求，未运行旧工具循环。

## 受测文件摘要

| 文件 | SHA-256 |
|---|---|
| packages/core/src/session/repeat-guard.ts | 148c5b3c92a2a7fcb4ad187d2219d08a9c050e4b0e2a73212af9db8739cde304 |
| packages/core/src/session/runner/llm.ts | ad067a14ebc47b1ceb4266d875f1acb412a34eac92dbe02af849ba9cb55803c4 |
| packages/core/test/session-repeat-guard.test.ts | 0dfe5c39ecc64172dae44a76379ce7744553dc78880804fca240032979a58c71 |
| packages/core/test/session-runner.test.ts | 511219ae4b92e2535f3e88745e68579deeb2c2d946ce27695afb0941abc5effc |

## 明确未完成

- 同一 Provider 批次在失败结果尚未可见时已派发的多个调用，仍受既有次数上限/调度规则约束，不承诺“并发失败只启动一次”。
- 非连续重复、跨用户周期以及真实进程重启后，尚无本批失败标志重建；不能称冷恢复完整通过。
- Guard 不代替 ActionGateway 的幂等和 outcome_unknown 处理，也不涵盖 providerExecuted hosted tools 或所有非 Runner 来源。
- R08 全来源成功/拒绝/取消矩阵、R05/R07 前置闭合、R01 完整语义映射与环境 receipt 仍待完成。第四条能力关联仍 accepted=false。
- 全文件 lint 债务保留为待处理项；不运行真实 full sandbox，不调整用户 PATH、配置、数据库，不删除既有成果。

后续继续按计划核对剩余旧自纠错合同及统一管线来源，优先补真实行为和运行时缺口；不将本切片扩大成全阶段完成声明。
