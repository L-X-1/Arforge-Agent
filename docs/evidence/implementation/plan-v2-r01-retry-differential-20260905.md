# R01：旧 sc11 与 TS 重试边界的实际对照

日期：2026-09-05。承接能力关联校验首批；本批只增加测试与迁移差异记录，未改产品重试算法或 Python 产品代码。

## 实际执行与发现

旧 capability-eval 包含 26 个基础设施合同任务，其中 sc11 调用 self_correct.is_transient 和 retry_config。TS Golden 中的同名记录保存 fixture/断言定义，本身不是调用这 26 个函数的证据。

新增 Core 测试 `test/runtime/legacy-retry-differential.test.ts`：用真实 Python 子进程运行旧纯函数，再调用真实 TS RuntimeRetry.decide。Python 使用 -I -S -B、临时工作目录、隔离 ARFORGE_HOME，不运行旧工具循环、不调用模型、不访问用户数据库。缺少 Python 显式失败，不静默跳过。测试临时目录在 finally 清理。

| 输入/边界 | 旧函数实测 | TS 实测 | 融合决定 |
|---|---|---|---|
| 超时、限流、503、拒绝连接四条 sc11 文本 | true | 测试显式构造对应 LLMError 类型后，在输出前且有额度时 retry | 正向意图相容；不证明产品错误适配器已正确映射 |
| SyntaxError / NameError | false | 普通 Error 为 unknown / stop | 保留停止行为；不声称完整分类器相同 |
| 相同超时文本但仅普通 Error | true | unknown / stop | 不能仅靠文本授权 Provider 重试 |
| request rejected; try again later | true | 类型为 InvalidRequest 时 stop | TS 类型边界更严格，不能把旧正则直接接入 Provider 判断 |
| 输出已开始或工具调用已开始 | 旧纯分类函数无该入参 | 四类瞬态错误均 stop，包括 fallback 可用时 | 保留防重复工作边界；没有执行真实副作用来证明整个链路 |
| 重试额度耗尽/为零 | 旧默认配置五次、1 秒、倍率 2、上限 30 秒 | 以输入额度决定 stop / fallback | 不将旧默认参数覆盖既有运行时预算 |

这里只对照旧分类函数与 TS Provider 决策函数；前者面向工具错误、自纠错反馈，后者面向 Provider 传输，不能认定它们是同一个完整能力。没有执行自动退避、网络请求、fallback 切换或工具重试。其他 25 个旧任务本批未做行为对照。

## 代码与验证

- 新增 4 项差分测试；同既有 retry 3 项测试运行：**7 passed / 37 assertions**。
- 关联校验回归：**10 passed / 26 assertions**。本批上述定向检查合计 **17 passed / 63 assertions**。
- Core 全包 typecheck 通过；新增测试 oxlint --deny-warnings 通过。去掉 lint 提示的多余非空断言后重跑通过。
- 关联文件新增 SELF-CORRECT-TRANSIENT-RETRY，分类 merge-differences，登记四个适用场景。当前三条关联均未声明功能验收；此文不是完整依赖/环境绑定 receipt。
- 首轮统一 freshness 集成测试出现 1 pass / 1 fail；实际报告定位为 PY002-013：capability/file 投影与重生成不一致。新增 TS 差分测试引入旧 Python 函数消费者，已使用原生成器刷新 capability/file 及 dependency 投影，未改变 OPEN 状态或放宽校验。
- 刷新后集成测试重跑 **2 passed / 7 assertions**，七项检查均通过。本批最终共 **19 passed / 70 assertions**；源码输入 7,451 项。历史失败保留以上记录，不计入通过结果。

```powershell
# packages/core 目录
bun test test/runtime/legacy-retry-differential.test.ts test/runtime/retry.test.ts --rerun-every
bun run typecheck
# script 目录
bun test arforge-capability-links.test.ts --rerun-every
```

| 文件 | SHA-256 |
|---|---|
| packages/core/test/runtime/legacy-retry-differential.test.ts | a5f5d91eee2692d2e85f5d4e299206eaacb4268476b6147903b1df72d2aba8b7 |
| arforge/core/self_correct.py | 5dc67b5c360ffb558b5af7970c5e4102ffa71b13dab32e76862f684719d0dbf8 |
| arforge/core/capability_eval.py | b34e960554d8d4eeefa81e0e14d13d604da735fa889940a82a88a2d28f2802cc |
| packages/core/src/runtime/retry.ts | 60eec6e9804927400c492daac640337dc528a36efab4d5c410b195d18c9e39fc |

## 后续实施约束

1. 保留既有 RuntimeRetry；旧工具错误分类/反思/重试需求应在现有工具管线的授权、取消、幂等与反馈边界内补齐，不建立第二 retry owner，也不能把所有失败视为可安全重试。
2. 下一批继续其余旧合同及工具自纠错调用链，补正常、错误、恢复的实际行为证据；需验证适配器、执行器与副作用，而非继续仅比较 Golden 名称。
3. 库存稳定多对一映射、完整环境/传递依赖 receipt 与全域消费者图仍未完成。没有整阶段完成率或产品交付声明。
4. 不变更用户配置/PATH，不重开 Python 入口；真实三平台 full sandbox 仍后置。
