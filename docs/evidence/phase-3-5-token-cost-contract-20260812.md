# 阶段 3.5 Token 与成本计量（离线合同切片）

日期：2026-08-12
计划位置：`Arforge-最终详细实施计划-V2-2026-08-11.md`，Step 3.5
状态：Step 3.5 的计量合同、内存计量、数据库持久化，以及可配置的 Session 运行时价格目录注入、调用前预留和调用后结算已实现；生产环境价格目录的具体来源注册仍保持显式注入，不使用未经核验的默认价格。

## 已实现

- `packages/schema/src/billing.ts` 增加 `Billing` 合同：
  - 非重叠 token breakdown，包含 unknown/image/audio/cache/reasoning/output 维度；
  - `provider` / `estimated` usage source 与具名 estimator ID；
  - 独立版本化价格目录，记录 currency、minor unit、rate unit、effective time 和 source；
  - charge、budget、reservation、settlement 合同。
- `packages/core/src/runtime/billing.ts` 增加纯计量核心：
  - Provider usage 优先；
  - 无 usage 时必须提供具名 estimator，内置 `arforge:chars-per-token-v1` 仅作为确定性 fallback；
  - 缺失价格的非零 token 维度显式进入 `unpricedCategories`，不静默按零收费；
  - 调用前 reserve，调用后 settle，并显式标记 over-budget；
  - 每个 charge 保留调用时 `priceCatalogRevision`，避免按当前价格重算历史结果。
  - `RunScope` 接收明确的币种预算和 provider/model 价格目录 resolver；已配置时在构造 provider stream 前 reserve，stream 结束后按 provider usage settle；缺少已验证目录时 fail-closed，不发起 provider 调用。
- `packages/core/src/runtime/sql.ts` 增加 `session_run_usage` 投影：
  - 按 `run_id` / `session_id` 关联每次 provider 调用；
  - 分列保存 cache、reasoning、image、audio 等 token 维度；
  - 价格 revision、货币、amount、reservation 和 over-budget 字段可为空/可记录，未获得已验证价格目录时不伪造计价；
  - SQLite migration `20260811184807_runtime_billing` 与 PostgreSQL RLS migration 同步加入。
- `RuntimeInsight.recordBilling` 与 `attachRuntimePersistence` 已接入数据库写入；Session runner 在每个 provider step 后记录 provider usage，配置 `billing` 时同时记录调用时价格 revision、charge 和 settlement（provider 失败也会释放 reservation）。

## 验证结果

- `bun run --cwd packages/schema typecheck`：通过。
- `bun run --cwd packages/core typecheck`：通过。
- Schema billing/contract-hygiene 专项：7 pass，0 fail。
- Core billing/LLM unified/model probe 专项：10 pass，1 skip，0 fail。
- RuntimeInsight/SQLite migration 专项：31 pass，0 fail（包含新表存在性和 usage snapshot 记录）。
- `bun run migration -- --check`：通过，schema/registry 无漂移。
- `git diff --check`：通过。
- `bun test test/billing.test.ts --timeout 30000`：6 pass，0 fail。
- `bun test test/session-runner.test.ts -t "reserves and settles a configured billing scope" --timeout 30000`：1 pass，0 fail，验证真实 Runner provider turn 的 reserve/settle 接线。
- DeepSeek live probe：1 pass，0 fail；4 个 live observations，预算结算未超 ¥5。
- 价格来源：DeepSeek 官方价格页 `https://api-docs.deepseek.com/zh-cn/quick_start/pricing/`，本次记录 revision `deepseek-v4-flash-official-2026-04-24`。

## 尚未关闭的计划要求

- 当前 runner 的 resolver 和币种预算通过显式 `run({ billing })` 注入；生产启动路径尚未建立统一的 provider/model catalog registry，也不会把 `models.json` 的 legacy cost 当作官方价格。
- Step 3.5 的剩余收口是把受信价格目录来源接入统一配置/持久化入口，并决定各产品入口如何传入货币预算；这不阻塞已完成的计量合同和 runtime reserve/settle 机制。
- 本次 live probe 使用 `ANTHROPIC_API_KEY` 作为 DeepSeek 凭据入口，未读取或记录其值。
