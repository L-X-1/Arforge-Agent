# Step 8.6 Personal AI OS 执行接入证据

- 日期：2026-08-14
- 计划：`Arforge-最终详细实施计划-V2-2026-08-11.md`，Step 8.6
- 状态：开发期执行垂直闭环完成；发布/部署不在本次范围
- 分支：`codex/phase-0-checkpoint`

## 本次补齐

此前 Personal Job 已具备 durable admission、审批、生命周期、预算字段、通知和逻辑删除，但“立即运行”仍停留在状态变更，未进入真实 Session Runner。本次新增受信 `PersonalJobExecutor`：

1. 只接受期望 revision 对应的 `queued` 任务；状态不符、revision 过期和缺少受信 credential binding 的运行时均 fail-closed。
2. 先通过 Personal Job 的 `start` 进入 `running`，再以稳定 message ID 将 job prompt 投递到 Session 的 `queue`。
3. 通过现有 `SessionV2.resume` 进入真实 Session Runner，不创建第二套 provider 或任务事实源。
4. 从新增的 assistant projection 读取可展示文本；runner/provider 错误、无 assistant 结果或超时预算都会以 failed result durable settle。执行器会在剩余时长预算到期时中断 Session Runner，不让任务无限停留在 `running`。
5. 结果回写使用现有 `recordResult`、revision 和 canonical digest；用户在执行期间 pause/cancel 后，迟到结果不会复活任务。
6. 新增 `POST /api/session/:sessionID/personal-job/:jobID/execute`，桌面端“立即运行”已改为调用该接口。
7. 新增受限调度接口 `POST /api/session/:sessionID/personal-job/dispatch`：在当前用户/会话作用域内推进到期周期任务，并以单次最多 32 个任务的上限调用执行器；单个任务的 stale、审批、凭据未绑定或其他不可运行错误只计为 skipped，不会中断其他任务。调度批次只从真正到期的周期任务中取前 N 条，不会被较早创建但未到期的队列项挡住。个人任务面板在打开期间每 15 秒检查一次，也提供“检查调度器”手动入口。
8. 本地默认用户的进程内执行器在启动后每 15 秒进行一次有界调度轮询，因此关闭任务面板不会让本地后台任务永久失去调度；认证/多租户请求仍必须通过显式 session scope 的调度接口。
9. Personal Jobs 面板新增安全的凭据选择、通知模式和免打扰时间入口；凭据下拉只显示 integration/label，不显示 secret。首次打开先加载任务，再运行调度检查，避免 loading guard 把首屏任务列表卡住。
10. 修复周期任务调度边界：`tick` 推进完成/失败任务的下一次 cron 时间后，dispatcher 会在同一轮保留并执行刚推进的 occurrence，不会跳过一次周期。
11. 暂停或取消接口在持久化状态变更成功后，会按 job/session 绑定中断正在运行的本地 Session Runner；中断只作用于匹配的活动任务，避免继续消耗 provider 或时间预算。
12. 周期 cron 的下一次时间按任务保存的 IANA `timezone` 计算，不再使用调度进程的本地时区；无效时区会在创建/更新时 fail-closed。

## 安全边界

- Personal Job 创建时按当前 tenant/user 校验每个 `credentialID` 的所有权；执行时通过一次性 `resumeWithCredentials` 将同一组 ID 传入 Session Runner。
- Session Runner 的 model resolver 只从该组 ID 中选择与当前 provider integration 匹配的 credential，并通过显式 credential connection resolve；没有匹配项、credential 已删除或 resolve 不可用时返回 `CredentialScopeError`，不会回退到 active/default/env credential。作用域不会被 coordinator 的普通 wakeup 继承。
- 注入式运行时若没有 `resumeWithCredentials` 能力，会在 job 状态变更前返回 `CredentialBindingUnavailableError`，保持 fail-closed。
- 当前执行器没有可信 currency-bound price catalog 接口，因此回写 `costMicros=0`，不把 assistant 的非标准 cost 字段冒充结算金额；租户 billing 仍只消费已结算 usage。
- artifact refs 当前只能回写空数组，不把 session 内的输出路径伪造成 artifact ID。
- 这是开发期本地调度器，不是发布环境调度器：当前 dispatcher 在受信 API/UI 调用或本地默认用户进程轮询中完成 durable `tick` + bounded execute；进程重启后排队任务可由本地轮询重新领取，但跨进程 worker lease、运行中任务的服务重启/崩溃恢复、实时 usage callback 仍作为后续平台化工作保留。

## 验证

```text
bun test --cwd packages/core --timeout 30000 test/personal-job.test.ts test/personal-job-executor.test.ts  PASS (14/14, 59 assertions)
bun test --cwd packages/core --timeout 30000 test/scheduled-prompt-cron.test.ts test/personal-job.test.ts test/personal-job-executor.test.ts PASS (19/19, 75 assertions)
bun test --cwd packages/core --timeout 30000 test/scheduled-prompt-cron.test.ts test/personal-job.test.ts test/personal-job-executor.test.ts test/session-run-coordinator.test.ts test/session-runner-model.test.ts test/session-prompt.test.ts test/scheduled-prompt.test.ts PASS (83/83, 211 assertions)
bun run --cwd packages/core typecheck                                                    PASS
bun run --cwd packages/protocol typecheck                                                 PASS
bun run --cwd packages/server typecheck                                                    PASS
bun run --cwd packages/client typecheck                                                    PASS
bun run --cwd packages/sdk-next typecheck                                                  PASS
bun run --cwd packages/app typecheck                                                       PASS
bun test --cwd packages/server --timeout 30000 src/personal-job-openapi.test.ts src/tenant-platform-openapi.test.ts PASS (2/2)
bun test --cwd packages/sdk-next --timeout 30000 test/personal-job.test.ts                 PASS (1/1, 9 assertions; execute stale-revision contract)
bun test --cwd packages/client --timeout 30000 test/contract-identity.test.ts test/effect.test.ts PASS (8/8, 42 assertions)
bun test --cwd packages/app --preload ./happydom.ts ./src                                   PASS (975/975, 3365 assertions)
bun run typecheck                                                                            PASS (22/22 packages)
git diff --check                                                                              PASS (targeted files)
```

本次调度增量的直接验证：`PersonalJobExecutor` 测试为 `9/9`，覆盖到期任务限量 dispatch、完成/失败计数、不可运行任务 fail-closed skipped、“tick 推进周期后同轮执行 occurrence”，以及只中断匹配活动 Session 的取消围栏；`PersonalJob` 测试覆盖到期任务不会被较早创建的非周期队列项挡住；cron 测试覆盖保存时区与进程时区不同的下一次 occurrence 和无效时区拒绝。Server OpenAPI 同时确认 `v2.personalJob.execute` 与 `v2.personalJob.dispatch`。

本次 credential binding 的直接验证：`SessionRunnerModel` 测试为 `15/15`，覆盖只使用显式作用域中的正确 integration credential、禁止 active connection 回退，以及跨 integration 无匹配时返回 `CredentialScopeError`；`SessionRunCoordinator` 测试覆盖显式 scope 在当前运行完成后启动且不泄漏到普通 wakeup。

说明：`packages/client` 的 `check:generated` 是基于整个 dirty worktree 的 `git diff --exit-code` 门禁；当前仓库已有大量未提交的生成文件和其他阶段改动，因此不能作为本次改动的干净基线。客户端生成已重新执行，类型检查、合同测试和定向 diff 检查均通过。

## 当前可用性结论

在 Session Personal Jobs 面板中，用户可以创建可见后台任务、选择限定凭据、设置审批/通知/免打扰策略，完成审批后点击“立即运行”，然后在同一任务卡片看到 `completed/failed`、摘要、预算用量和通知。带有 credential scope 的任务通过同一执行链使用指定凭据；没有可用 provider、执行错误、无结果或凭据作用域不匹配时，任务会停在可解释的 failed/blocked 状态，不会显示“成功”或越权执行。

本证据不宣称 Step 8.6 的跨进程自动调度守护进程、实时 billing callback 和 crash-recovery runner 已完成，也不宣称 Step 8.11 或 Step 8.10 已通过。

## 2026-08-14 开发期复审增补（以本节为准）

前文是执行器初版的历史记录，以下结论覆盖其中关于 artifact、billing 和运行中恢复的旧描述：

- Personal Job 现在持久化 execution lease 与 heartbeat；调度前执行 bounded recovery。工作进程失联后，任务会按 attempts/approval policy 安全地重新排队或以失败收口；pause/cancel 与迟到结果仍由 revision + lease fence 保护。
- 执行完成后只把已由 Session Assistant delivery metadata 提供、且带有内容 digest 的 primary-delivery attachment 写入 `result.artifacts`。artifact receipt 只保存 URI、名称、MIME、大小和 digest，不复制内容、不把未经核验的 snapshot 路径冒充 artifact。
- 已验证的 price catalog 会通过 `SessionRunner` 的 billing settlement observer 回写真实 `costMicros`；没有有效目录时保持 `0`，不虚构价格。实际结算超过预算时，任务以 `failed` 收口并保存真实用量，避免永久停留在 `running`。
- 带 credential scope 或 billing contract 的桌面 Personal Job 仍经过同一个 `SessionRunCoordinator`，但由其 scoped execution 分支调用 Core Session Runner；Core Runner 接收显式 credential scope 和 billing，不回退到 active/default/env credential。普通会话继续使用成熟桌面适配器；该适配器对未配置 scoped contract 的普通路径不改变行为。
- 当前开发环境的直接回归：`PersonalJob` 6/6、`PersonalJobExecutor` 11/11（合计 17/17，75 assertions）；core typecheck PASS；arforge typecheck PASS。此前已通过的 app/client/protocol/server/sdk-next 回归仍有效，后续会再跑全量门禁。

本次交付仍只覆盖本地开发功能，不包含 Step 8.10 发布运维、Step 8.11 signed release/canary/rollback 证据，也不注册未经配置的公网 A2A remote executor。

## 2026-08-23 本地交付复审（以本节为准）

### 发现并修复的真实断链

1. 周期任务的 `tick` 原先先把 `nextRunAt` 推进到未来，再在同一轮交给执行器；真实 `start` 因“尚未到期”而拒绝，旧测试使用伪执行器所以未发现。现在 Durable `time.started` 明确标识已准入或待恢复的 occurrence，调度器可在 schedule advancement 后立即执行，并可跨进程重启间隙继续恢复。
2. 面板“立即运行”原先会被同一个到期检查拒绝。现在只有受信 `PersonalJobExecutor` 的显式手动入口可设置 `allowEarly`；普通 `start` 和自动调度不能任意绕过计划时间。
3. HTTP“立即运行”和 dispatch 原先等待 Session Runner 完整结束，导致整个任务面板在长任务期间被禁用。新增 detached `launch`：先以 revision/CAS 持久化 `running` 和 execution lease，立即返回可见状态，再在本地后台 Fiber 中执行、心跳并结算；pause/cancel 仍通过 job/session 绑定中断活动 Runner，迟到结果不能复活任务。
4. `maxCostMicros=0` 原先在第一次启动前即被判定耗尽，无法承载免费/本地模型。现在允许零成本运行；任何正结算金额仍会越预算并以失败收口。周期任务耗尽 attempts/duration/cost 后会 durable `cancelled` 并写入 `budget_exhausted` 通知，不再永久留在 queued/skipped 循环。

### 用户可见体验

- 创建表单把“一次运行”设为安全默认，用户可直接选择本地日期时间；每日、工作日、每周和自定义 Cron 仍按渐进披露提供。
- 每张任务卡显示一次/周期语义、精确下一计划时间和保存的 IANA 时区；“立即运行”明确表示不等待计划时间。
- 后台 launch 返回后，用户可继续使用 Arforge，并能立即暂停或取消；15 秒有界刷新最终展示 completed/failed、摘要、预算和工件。
- 调度反馈区分后台启动、完成、失败和 skipped；界面明确说明本地自动任务在 Arforge 打开期间运行，重启后依据 Durable 状态恢复，避免把本地能力误解为云端常驻服务。

### 新鲜验证

```text
bun test --cwd packages/core test/personal-job.test.ts test/personal-job-executor.test.ts test/scheduled-prompt-cron.test.ts
  PASS (27/27, 107 assertions)
bun test --cwd packages/core test/stage8-local-evidence-contract.test.ts
  PASS (1/1, 6 assertions)
bun run script/run-stage8-local-evidence.ts --suite background_visibility_stop_audit ...
  PASS (22 observed, 22 minimum, 0 failed checks, external_network=false)
bun test --cwd packages/app --preload ./happydom.ts ./src/components/session/session-personal-jobs-control.test.ts
  PASS (5/5, 25 assertions)
bun test --cwd packages/app --preload ./happydom.ts ./src
  PASS (1036/1036, 3595 assertions)
bun run --cwd packages/app test:browser
  PASS (32/32, 75 assertions)
bun run --cwd packages/app build
  PASS（仅有既存 chunk/dynamic-import 警告）
bun test --cwd packages/server src/personal-job-openapi.test.ts
  PASS (1/1, 2 assertions)
bun test --cwd packages/sdk-next test/personal-job.test.ts
  PASS (1/1, 9 assertions)
core/app/schema/protocol/server/client/sdk-next/arforge typecheck
  PASS
oxlint（10 个相关文件，禁用失真的 nested config，并仅豁免既存 assertion/Effect generator 规则）
  PASS (0 warnings, 0 errors)
```

本机 PostgreSQL 已按既有授权应用 migration `20260823090000_workflow_node_read_default` 后重跑嵌入式 SDK 测试通过；本工作包没有新增数据库 migration。证据运行未调用真实 provider、未产生外网请求、未执行发布部署或 Git push。跨进程平台 worker、应用关闭后的云端常驻调度、真实 provider staging 和发布运维仍不在本地功能交付范围内。

## 2026-08-15 复审与用户体验收敛

- 核心新鲜回归：PersonalJob/Executor/Cron `22/22`，`91` assertions；覆盖审批、租约心跳、失联恢复、时区 Cron、预算、凭据边界、暂停/取消防迟到结果复活。
- 跨模块新鲜回归：Session Prompt/Coordinator/Runner Model/Scheduled Prompt `64/64`，`136` assertions；core、schema、protocol、server、arforge typecheck 均通过。
- 服务合同：Personal Job OpenAPI `1/1`，SDK Personal Job `1/1`；App Personal Job UI 单元测试 `3/3`，`14` assertions；App typecheck 与生产构建通过。
- 桌面重复性证据：`artifacts/desktop-repeatability-audit.json`，隔离 profile 三轮全部零退出码，`passed=true`，单轮耗时约 52–55 秒。首次外层 180 秒窗口超时是构建加三轮运行超过窗口，放宽至 300 秒后完整通过，不计为产品失败。
- 前端体验修复：预设/自定义 Cron 首次运行时间按保存的 IANA 时区计算下一次 occurrence；避免新建任务被错误地立即调度；手动调度检查始终有成功/空闲反馈并防止并发轮询；高级预算字段改为用户可理解的分钟和服务商计价单位；关键表单控件使用至少 44px 触控高度。

仍需后续阶段处理：Personal Job 的跨进程平台 worker、发布运维证据，以及完整的真实 provider/多租户 staging 验证；这些不属于当前本地功能交付范围。
