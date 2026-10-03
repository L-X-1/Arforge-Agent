# 阶段 3.12 退出门禁

日期：2026-08-12
计划位置：`Arforge-最终详细实施计划-V2-2026-08-11.md`，Step 3.12
状态：进行中

## 已完成

- 新增 `packages/llm/test/offline-contract.test.ts`，以 fixture key 和 fixture endpoint 编译 20 条 provider/route 合同，覆盖 OpenAI Chat/Responses/WebSocket、Anthropic、Google Gemini、xAI Chat/Responses、OpenRouter、Azure Chat/Responses、Amazon Bedrock、Cloudflare AI Gateway/Workers AI，以及 baseten、cerebras、deepinfra、deepseek、fireworks、groq、togetherai 七个 OpenAI-compatible family。
- 该合同测试只调用 `LLMClient.prepare`，断言 provider identity、body 存在且没有 `apiKey`，不创建 HTTP client、不读取真实环境 credential、不发送网络请求。
- `packages/core/src/runtime/router.ts` 现在在候选带有 `Model.Profile v1` 时以 profile 的 capability、region/egress policy 和 identity 为权威，并把 profile version、tokenizer、estimator、price catalog、capability、modality、policy、observation count 写入安全路由 evidence；profile identity/capability 不一致时 fail closed。
- `packages/core/test/router.test.ts` 新增 profile 权威能力和不一致拒绝合同，共 5 个 router test 全部通过；ModelProfile 已能解释路由 evidence，且 identity/capability 不一致时 fail closed。
- LLM 包离线回归：302 pass，30 skip，0 fail，708 expects；跳过项均是缺少授权环境或未启用录制的 live/recorded 场景。
- Core Runtime 相关回归：72 pass，0 fail，1919 expects；Python capability-eval 26/26；Python/TS capability-eval 双跑 26/26 等价；50 个 multistack manifest 对齐并完成 deterministic replay；完整 Golden manifest regression gate 通过；全仓 typecheck 22/22 通过。
- App/Desktop 本地回归：App unit 975 pass、0 fail、3362 expects；Desktop 86 pass、0 fail、224 expects；UI 19 pass、0 fail、78 expects；App production/E2E typecheck 与全仓 typecheck 均通过。
- packaged desktop 本地验收已完成：`desktop-evolution-visibility.acceptance.ts` 通过，6 个 capability 请求与 2 个 runtime-insight 请求均为 200，Python runtime 未分派，渲染错误与失败请求均为 0；`desktop-crash-boundaries.acceptance.ts` 的 pending-approval、authorized-before-spawn、effect-before-observation、junction-reparse 4/4 场景通过；`desktop-crash-recovery.acceptance.ts` 通过同一 Run 跨进程恢复、write 副作用不重复、Windows DPAPI 凭据迁移与明文消失验证，渲染错误与失败请求均为 0。对应审计产物：`artifacts/desktop-typescript-runtime-visibility-audit.json`、`artifacts/desktop-step-2-12-crash-boundaries-audit.json`、`artifacts/desktop-real-crash-recovery-audit.json`。
- 已完成授权 DeepSeek live fault/recovery probe：`deepseek/deepseek-v4-flash` 使用固定 capability probe prompt，严格执行 3/3 网络请求（基线、受控流中断、恢复），流中断阶段在 terminal event 前观察到 1 个事件，恢复请求成功；按当前 CNY price catalog 结算 4 minor units（¥0.04），未超过 500 minor units（¥5）。审计产物 `artifacts/phase-3-12-deepseek-live-fault-recovery-20260812.json` 仅保存 provider/model、阶段状态、token 计数和预算，不保存 prompt 正文或 secret。
- `RuntimeEvaluation.fromCapabilityProbe` 已将 `ModelProbe.Result` 映射到唯一 `EvaluationResult` CreateInput；集成测试验证 provider/model identity、sample/score、latency metrics、source 标记和 evidence IDs 均随 Evaluation service 持久化，未新增第二结果写入器。
- OTLP trace exporter 与 OTLP logger 增加统一 telemetry scrubber：prompt/content/message/token/secret/credential 等敏感属性和值在出口前被替换，异常 cause 不发送到 OTLP；loopback OTLP payload 测试确认敏感 span 值未出网。
- 本批修复了控制审批状态工厂在 headless startup 未触发 Solid `createEffect`、导致服务端 pending approval 不恢复的问题；并为 App/UI locale 加入 English fallback，确保新增安全审批与 permission 文案不会在非英文 locale 缺失。
- Python 文档合同 `tests/test_documentation_contract.py` 5/5 通过；完整 Python suite 在排除已登记 brand policy 单项后，于 300 秒上限内未完成且未产生可靠汇总，因此不计作通过证据。

## 尚未关闭

- ModelProfile/policy-aware router 的本地可解释路由门禁已完成；capability probe observation 已具备统一 EvaluationResult 持久化映射，真实 live audit 与历史 recorded/deterministic 结果仍按 lane 分栏保存。
- packaged desktop E2E 已在现有 Windows 独立临时 profile 中运行并通过；历史 formal 结果仍与当前结果分栏保存。
- Python 全量基线尚未全绿：`pytest -q --maxfail=1` 在 141 个通过后被既有 brand audit 阻断；当前命中 `opencode.json` 与两份历史 evidence 文档中的旧品牌归因（仓库既有 Step 2.13 证据已登记）。本批已按生成脚本修复 canonical PNG/ICNS 漂移，`tests/test_brand_assets.py` 3/3 通过，但未删除用户配置或篡改历史证据。

## 2026-08-14 当前候选复验增补

本节追加当前候选结果，不改写上面的历史记录。

- 当前提交基线：`8c66f61e` (`fix: enforce control principal binding`)；工作树仍包含用户此前的未提交修改。
- 修复 `packages/arforge/src/server/routes/instance/httpapi/server.ts` 的真实启动缺陷：主 `app` 图构建时补传 `SessionExecution` 到 `SessionExecutionMature` 的替换，消除 `Unbound layer node: @arforge/v2/SessionExecution`。直接 CLI `--help` 和 `tests/test_m6_packaging.py::test_node_launcher_delegates_to_unified_typescript_cli` 均通过。
- 修复 `arforge/capability/capability_registry.py` 的空模型响应处理：transport 成功但返回空文本时现在按失败处理并进入确定性离线 fallback，不再产生空的 code review。

### Python 当前全量分片

`python -m pytest --collect-only -q` 收集 3123 项。按排序后的测试文件完整执行以下 12 个不重叠分片，结果为 **3117 pass、6 skip、0 fail**：

| 文件索引 | 结果 |
|---:|---:|
| 0–99 | 1006 pass |
| 100–109 | 87 pass |
| 110–115 | 134 pass |
| 116–135 | 243 pass |
| 136–154 | 270 pass、6 skip |
| 155–174 | 243 pass |
| 175–194 | 153 pass |
| 195–214 | 212 pass |
| 215–234 | 152 pass |
| 235–254 | 290 pass |
| 255–274 | 228 pass |
| 275–289 | 99 pass |

6 个 skip 均来自 `tests/test_multistack_formal_acceptance.py`，原因是当前 Windows 主机没有 Go、PHP、Ruby runtime；不是失败，也没有被静默排除。此前 brand policy 单测已独立通过，故旧的“brand 阻断”结论不再适用于当前候选。

### 当前 TypeScript provider 复验

- `packages/llm/test/offline-contract.test.ts`：1 pass、0 fail、61 expects。
- `bun run --cwd packages/llm typecheck`：通过。
- `bun run --cwd packages/core typecheck`：通过。

### 当前门禁判断

- 每个启用 provider 的 offline contract：通过；
- 已授权 live provider fault/recovery：使用 `artifacts/phase-3-12-deepseek-live-fault-recovery-20260812.json`，3/3 请求、fault 后 recovery、¥0.04，内容与 secret 未持久化；
- ModelProfile 可解释路由、EvaluationResult 统一持久化、Golden regression、OTLP scrubber：沿用上方已记录的独立通过证据；
- 2026-08-14 DeepSeek stable 实验的失败结果仍按 live experiment 独立记录，不被 deterministic/历史成功结果覆盖，也不伪造为质量提升。

因此，Step 3.12 的本地退出条件在当前候选上已完成；第 8 阶段的 signed release、staging canary、rollback 和 release gate 仍是独立外部门禁，不能由本地结果替代。
