# 阶段 3.6 Policy-aware Router

日期：2026-08-12
计划位置：`Arforge-最终详细实施计划-V2-2026-08-11.md`，Step 3.6
状态：纯 Router 已完成硬策略过滤、可解释排序和拒绝证据输出；实际产品入口的 policy/catalog 数据装配仍由后续集成切片接入。

## 已实现

- `packages/core/src/runtime/router.ts` 保留 `rankByCost` 作为纯评分器，并新增 `routeByPolicy`：
  - capability 硬过滤：vision、tool-calling、reasoning、structured-output；
  - provider / region / egress allowlist 硬过滤；
  - credential availability 与 required scope 硬过滤；
  - currency-bound estimated charge 与预算剩余额硬过滤；
  - circuit breaker `open` 硬过滤，`closed` / `half-open` 可进入候选；
  - explicit model 仅在通过硬过滤时置于首位；显式模型缺失或被拦截时不静默 fallback；
  - 结果返回 `ranked`、`rejected`、可读 `reason` 和输入 `evidence`。
- Router 不从 `models.json` legacy cost 推导正式价格；预算 gate 只接受调用方提供的币种和已估算金额，价格目录职责仍由 Step 3.5 Runtime Billing resolver 承担。

## 验证结果

- `bun run typecheck`（`packages/core`）：通过。
- `bun test test/runtime/router.test.ts test/router.test.ts --timeout 30000`：7 pass，0 fail，19 expect。
- 覆盖：硬过滤及逐候选拒绝证据、显式模型优先、显式模型策略失败时 fail-closed，以及原有成本排序回归。

## 下一步

- Step 3.7：在 provider 尚未产生可见/可执行输出的边界内实现安全重试与 fallback，并为每次 fallback 生成独立 Attempt/Action 证据。
