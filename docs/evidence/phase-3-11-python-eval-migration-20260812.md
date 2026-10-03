# 阶段 3.11 Python Eval 行为迁移

日期：2026-08-12
计划位置：`Arforge-最终详细实施计划-V2-2026-08-11.md`，Step 3.11
状态：进行中（已完成 7 个 Python formal family 的全部 50 个 case、26 个 capability-eval contract，以及 10 个 multistack toolchain 的全部 50 个 manifest case 对齐）

## 本批已完成

- 对照 `arforge/eval/formal_tasks.py::_pricing(1)` 和 `builtin_formal_tasks()[0]`，冻结 `formal-pricing-01` 的 prompt、source、tests、legacy task/category、expected files 和 timeout metadata。
- 对照 `arforge/eval/formal_tasks.py::_inventory(1)`，新增 `formal-inventory-01`，冻结第二个 Python formal family 的相同字段，并保留 `self.audit` 行为提示。
- 对照 `arforge/eval/multistack_formal_tasks.py::_setup_sql(51,101)` 与 SQL scenario builder，新增 `multistack-sql-01`，并通过同一 deterministic Evaluation Core draft 路径验证其 suite/case identity。
- 对照 `arforge/eval/formal_tasks.py::_slug(1)`，新增 `formal-slug-01`，冻结 Unicode/标点折叠与截断边界的 source、tests、prompt 和 legacy metadata。
- 对照 `arforge/eval/formal_tasks.py::_retry(1)`，新增 `formal-retry-01`，冻结 retries=3、精确调用次数和 retry_on 语义的 source、tests、prompt 和 legacy metadata。
- 对照 `arforge/eval/formal_tasks.py::_state(1)`、`_refactor(1)`、`_architecture(1)`，新增 `formal-state-01`、`formal-refactor-01`、`formal-architecture-01`；保留多文件 legacy expected files、服务层/兼容入口/架构文档要求，并通过 deterministic Evaluation Core replay 验证。
- 对照 `arforge/eval/multistack_formal_tasks.py::_setup_javascript(51,101)`，新增 `multistack-javascript-01`；冻结 JavaScript policy、service、package、contract 的完整多文件 fixture，并通过 deterministic Evaluation Core replay 验证。
- 对照 `arforge/eval/multistack_formal_tasks.py::_setup_java(51,101)`，新增 `multistack-java-01`；冻结 Java Policy、ScoreService、Contract 的完整多文件 fixture，并通过 deterministic Evaluation Core replay 验证。
- 对照 `_setup_rust(51,101)`、`_setup_c(51,101)`、`_setup_cpp(51,101)`、`_setup_csharp(51,101)`，新增 `multistack-rust-01`、`multistack-c-01`、`multistack-cpp-01`、`multistack-csharp-01`；冻结 Cargo/header/project/entrypoint 等完整 fixture，并通过 deterministic Evaluation Core replay 验证。当前主机未安装 Go、PHP、Ruby，因此不把这些 toolchain 宣称为已运行验证。
- 对照 `_setup_go(51,101)`、`_setup_php(51,101)`、`_setup_ruby(51,101)`，新增 `multistack-go-01`、`multistack-php-01`、`multistack-ruby-01`；完整 fixture 已冻结并通过 Python/TS manifest 对齐，但因当前主机缺少运行时，未宣称 contract/runtime 通过，也未启动容器下载镜像。
- TS `GoldenCase` 现在保留 Python source reference，并使用与 Python builder 完全相同的 source/tests/prompt；`EvaluationResult` 仍只由 TS Evaluation Core 产生。
- 新增 `packages/core/test/runtime/python-manifest.test.ts`：在当前主机执行 Python builder，通过 UTF-8 JSON 边界逐字段比较 TS manifest 与 Python scenario，避免两套结果长期双写。
- 扩展 TS formal manifest factory，覆盖 Python 的 7 个 family 全部 50 个 index case；测试逐字段比较 family/index/category、prompt、主文件、supporting files、tests、legacy metadata、expected files 和 timeout，确认 TS/ Python 迁移输入一致。
- 扩展 TS multistack manifest factory，以 10 个 toolchain 的第 01 个完整 fixture 为种子，按 Python builder 的 threshold/maximum 规则生成全部 02–05 变体；测试逐文件比较 50 个 multistack case 的 fixture、contract、supporting files、prompt、expected files 和 timeout，并对 50 个 case 做 deterministic replay。
- 新增 `packages/core/src/runtime/migration.ts` 的纯双跑比较门禁：身份、fixture digest、通过结果和 score 的差异会阻断等价；tool surface、token estimator、platform、provider adapter 差异会保留为明确解释项。比较结果只在内存中生成，不写第二份 EvaluationResult。
- 对照 `arforge/core/capability_eval.py::builtin_capability_eval_tasks()`，新增 26 个 `capability-eval` GoldenCase；Python `migration_contract` 与 TS manifest 逐字段比较 objective、source、fixture、tests、expected files、timeout、正/负断言，并全部进入 deterministic Evaluation Core replay。
- 新增 Python/TS capability-eval 实际双跑门禁：Python 本地执行 26 个 contract 并输出内存 JSON，TS 对同一 26 个 GoldenCase 执行 deterministic replay，再由迁移比较器逐项确认结果等价；差异只记录为解释，不产生第二个 durable result writer。
- Golden regression 比较门禁已接入：完整 Golden manifest baseline 回放通过；候选 case identity、suite revision、fixture digest、passed 或 score 退化均会阻断。

## 当前验证

命令：

```text
bun --cwd packages/core test runtime/evaluation.test.ts runtime/golden.test.ts runtime/python-manifest.test.ts runtime/verifier.test.ts runtime/insight.test.ts
```

结果：本批相关运行时回归集合 72 pass，0 fail，1919 expects；Python capability-eval 原有测试 4 pass，完整 capability-eval contract 26/26；Python/TS capability-eval 双跑 26/26 等价；50 个 multistack manifest 对齐并完成 deterministic replay；完整 Golden manifest regression gate 通过；全仓 typecheck 22/22 通过。

## 未关闭

- Python formal 的 7 个 family 已冻结全部 50 个 index case，并完成 TS/Python manifest 逐字段对齐；Python/TS verifier 的真实双跑仍未完成。
- multistack 已迁移全部 10 个 toolchain 的 50 个 index case；Go/PHP/Ruby 以及其他变体尚未完成本机 runtime smoke，因此不把 deterministic replay 误报为真实 toolchain 通过。
- 迁移比较门禁本身已完成并覆盖阻断/解释差异；仍未使用真实模型分别运行 Python 与 TS 并生成实际结果差异报告，也未作 Python runner 退役/兼容决策。
- 当前迁移测试已覆盖 capability-eval 的 Python/TS 实际双跑；Python 输出仍不写入 TS durable evaluation fact，formal/multistack 尚未完成真实模型双跑。
