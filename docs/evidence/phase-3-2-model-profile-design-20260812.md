# Phase 3.2 — ModelProfile V1 设计决策备忘

- 日期：2026-08-12
- 计划：`Arforge-最终详细实施计划-V2-2026-08-11.md`，Step 3.2
- 状态：已实现并完成专项验证；采用新增 optional `profile`、保留旧字段的兼容策略

## 当前事实

现有 `packages/schema/src/model.ts` 的 `Model.Info` 已被以下路径直接依赖：

- `packages/core/src/model.ts` 和 `packages/core/src/catalog.ts`；
- `packages/core/src/config/provider.ts`、插件 provider loader；
- Provider/Model catalog 的 merge、normalize、available/default/small 查询；
- Client/Server 对现有 `capabilities`、`cost`、`limit`、`request`、`variants` 的投影。

当前 capabilities 只有：

```text
tools: boolean
input: string[]
output: string[]
```

当前 schema 没有独立承载 reasoning、structured output、cache、token estimator、
probe evidence/expiry、region/egress/data policy 的 profile 合同。

## 计划字段到现有结构的映射

| V2 要求 | 现有落点 | ModelProfile V1 需要补足 |
| --- | --- | --- |
| providerID/modelID/version | `Info.providerID`、`Info.id` | 明确 profile version，避免把 model catalog release time 当 schema version |
| modality | `capabilities.input/output` 的自由字符串 | 受控 modality vocabulary 与静态/观测来源区分 |
| context/output limits | `Info.limit` | 统一 input/context/output 语义，避免 optional/zero 默认混淆 |
| tool/structured/reasoning/cache capability | `capabilities.tools`、request variants 零散表达 | 独立 capability contract，区分 native、synthetic、unsupported 与 observed incompatibility |
| tokenizer/estimator identifier | 无 | 明确 estimator kind/id 与 unknown 状态 |
| price catalog revision | `Info.cost` 无 revision | 增加 opaque revision；数值成本继续兼容现有 catalog，暂不推断货币单位 |
| observed latency/error/capability evidence | 无统一模型 | observation kind/status/value/source/observedAt/expiry |
| probe time/source/expiry | 无 | evidence freshness 与过期策略 |
| region/egress/data policy | provider options/baseURL/env 分散 | 静态 policy contract，禁止从 live observation 反向扩大授权范围 |

## 已采用的实现形态

推荐在 `Model.Info` 上**新增可选的 `profile` 字段**，并保留全部旧字段：

1. 新增带 identifier `Model.Profile`、版本字面量 `v1` 的 schema；
2. `Model.Info.profile` 为 optional，旧 provider/catalog/config 输入继续合法；
3. 新 loader 先填充静态 profile，再追加独立的 live observations；
4. live observation 只能把静态 capability 标记为 `inconclusive` 或 `incompatible`，不能把静态声明升级为未探测的能力，也不能扩大 region/egress/data policy；
5. 现有 `capabilities`、`limit`、`cost` 在过渡期继续作为兼容投影，后续步骤再收敛调用方；
6. 不在本步骤执行数据库迁移或回填未知 capability。

这个形态的优点是可以先冻结合同，再逐包迁移 consumer；直接替换 `Model.Info`
会同时影响配置解码、catalog merge、插件 API 和生成客户端合同，属于更大范围的
迁移决策，不应在没有确认的情况下隐含执行。

## 实现与验证结果

- `packages/schema/src/model.ts` 增加 `Model.Profile` 及 modality、limits、capability state、
  observation、region/egress/data policy 子合同；`Model.Info.profile` 为 optional，旧字段完整保留。
- `packages/core/src/config/provider.ts` 接受配置中的 Profile；配置插件将 Core 内部解码值编码为
  JSON 形态后交给公开插件接口，Plugin Host 再解码回 Core，避免 DateTime 与 JSON 时间戳混用。
- `packages/sdk/js/src/v2/gen/types.gen.ts` 已由现有 OpenAPI 生成链更新，公开 `ModelV2Info.profile`
  与 `ModelProfile` 合同同步。
- 配置成本映射同时修复为省略未设置的 `tier`，避免严格 JSON→Core 解码遇到显式 `undefined`。
- 专项测试覆盖：Profile 编解码与过期时间省略、旧 `Model.Info` 无 Profile 兼容、非法限制/能力状态拒绝、
  配置插件跨 JSON 边界保留 Profile 与 DateTime；Schema/Core/Plugin/SDK typecheck 均通过。
- 本步骤未执行数据库迁移、未知能力回填、live provider request、凭据读取或费用操作。

Step 3.2 的合同与兼容落地已完成；后续 Step 3.3 才开始受授权范围约束的真实 Provider
探测与证据采集。
