# Arforge V2 implementation and verification tracker

Approval: The user accepted all V2 recommendations and 11 CSS px model-group labels, then explicitly authorized implementation, tests, self-review, and parallel agents. This record supersedes pending-approval labels in the design review documents, not their preservation constraints.

Goal status: active. The 2026-10-29 approved implementation is ready for user review; formal product functionality acceptance remains gated.

## Current phase override: approved design implementation, 2026-10-29

The user's latest instruction supersedes the earlier implementation/verification order: complete the entire Desktop/Web design and its previews first, obtain user review and an explicit execution instruction, implement afterward, and return the implementation for user review; functional acceptance requires the user explicitly saying 执行验收. The user has now authorized implementing the approved design with “设计工作完成后，开始执行”. Product implementation resumes; final product functionality acceptance remains stopped until 执行验收. Existing work and evidence remain historical; nothing below authorizes resuming functional work before that gate.

The user also reiterated ZCode and Codex as visual/interaction references. Preserve the accepted V2 foundation and Z01–Z29. The user subsequently confirmed all56 R/C design choices as A with “全选A”. The design is approved and explicit implementation authorization has now arrived. Final functionality acceptance still awaits 执行验收 after implementation review. The new independent review draft is `%USERPROFILE%/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-complete-design-review-20261028/index.html`. The design package is complete and approved. Its independent previews do not prove product functionality. Product components/styles and planning records may now be edited within the approved design, preserving functionality, preferences, scope and prior fixes.

Do not resume the older “next functional gaps” items merely because they appear later in this historical tracker. The full product goal remains intact and awaits the user's phased approvals.

## 2026-10-29 implementation submitted for review

[中文实施审查页]汇总64个设计画面、56项细节的源码入口与工程记录。图片明确标为已批准设计参考，不是实机验收截图。审查页不连接业务API、不记录审批，也不启动验收。

The approved 56 A choices and retained V2/ZCode foundation are implemented in the Desktop/Web product sources. The frozen implementation contains94 source files. This is an implementation submission, not final product functionality acceptance; historical interaction evidence below is unchanged.

- Current source/coverage record: [implementation summary](implementation-20261029/implementation-summary.json) and [56-item source map](implementation-20261029/approved-source-map.json).
- UI, Session UI, App and Desktop typechecks passed. Isolated Desktop renderer and Web production builds passed; the running app/server was not restarted.
- Ordinary-load production streaming: one before sample and four after samples, CPU1/history12/deltas32. All four after cases delivered32/32 deltas with no row/markdown replacement or recorded page/console/network errors. Completion was595–619ms versus595.2ms in the single baseline. RAF p95 varied12.6–25ms after versus8.4ms before; this is recorded for later controlled profiling, not accepted as statistical equivalence or a performance improvement.
- Restored details include real narrow More menus, scoped theme confirmations, settings/table layouts, file-tab/diff integration, busy/error/empty states, partitioned read recovery, retained drafts and explicit acknowledged-write/refresh-failure receipts.
- Global native close/navigation draft guards remain synchronous. CLI/TUI, installer acceptance and the separately unresolved30x stress issue remain outside this phase.
- Next: user reviews the implementation, then explicitly says 执行验收 before functional, interaction and live-capability acceptance begins.

## Non-negotiable scope

- Desktop and Web production UI, not the standalone preview and not CLI/TUI.
- Preserve all pages, features, permissions, preferences and scope identity.
- Real business handlers, not fake successful toasts or static demonstration buttons.
- Error, unavailable, permission and missing-configuration states must explain how to recover.
- Installer acceptance remains deferred; the independent 30x stress issue remains unresolved.
- Verify functionality and self-review before declaring completion.

## Work ownership

| Module | Owner | Scope |
| --- | --- | --- |
| Theme/fonts/integration | Main | UI theme, material tokens, font assets, startup preference, integrated verification |
| Model picker | Poincare | Actual model/providers, grouping/search, persistence, selection scope and focus |
| Conversation | Volta | Composer, timeline/history, markdown presentation and message actions |
| Navigation | Pasteur | Shell/sidebar/home/projects/search/session navigation |
| Management/settings | Ramanujan | Control center, settings, onboarding, approvals and session operations |
| Workbench | Newton | Files/previews/diff/browser/terminal/execution/context |

## Required page coverage

A representative screenshot or unit test does not prove every interaction. Each row remains pending until actual implementation and the relevant interaction evidence have been reviewed.

| Page | Scope | Implementation | Interaction evidence | Self-review |
| --- | --- | --- | --- | --- |
| 主会话 | 01 对话与工作区 | In progress | Pending | Pending |
| 深色会话 | 01 对话与工作区 | In progress | Pending | Pending |
| 首页与新会话 | 01 对话与工作区 | In progress | Pending | Pending |
| 会话搜索与管理 | 01 对话与工作区 | In progress | Pending | Pending |
| 文件工作台 | 01 对话与工作区 | In progress | Pending | Pending |
| 变更审查 | 01 对话与工作区 | In progress | Pending | Pending |
| 隔离浏览器 | 01 对话与工作区 | In progress | Pending | Pending |
| PDF 预览 | 02 文件与内容预览 | In progress | Pending | Pending |
| Word 预览 | 02 文件与内容预览 | In progress | Pending | Pending |
| 表格预览 | 02 文件与内容预览 | In progress | Pending | Pending |
| 演示文稿预览 | 02 文件与内容预览 | In progress | Pending | Pending |
| Markdown 与文本编辑 | 02 文件与内容预览 | In progress | Pending | Pending |
| HTML 与元素预览 | 02 文件与内容预览 | In progress | Pending | Pending |
| 图像与其他附件 | 02 文件与内容预览 | In progress | Pending | Pending |
| 会话内终端 | 01 对话与工作区 | In progress | Pending | Pending |
| 执行详情 | 03 会话管理 | In progress | Pending | Pending |
| 上下文与用量 | 03 会话管理 | In progress | Pending | Pending |
| 目标与任务 | 03 会话管理 | In progress | Partial: Goal 22 interaction definitions + baseline; Task 23 interactions + baseline, 2026-10-28 | Scoped repairs and dependency-draft audit verified; live Core/full route acceptance pending |
| 待发送消息 | 03 会话管理 | In progress | Partial: 12 isolated production-browser interactions + 3 baselines, 2026-10-28 | Scoped review complete; live Core/full route acceptance pending |
| 定时消息 | 03 会话管理 | In progress | Partial: 10 isolated production-browser cases, 2026-10-28 | Scoped review complete; full route/Core acceptance pending |
| 触发器 | 03 会话管理 | In progress | Partial: 7 isolated production-browser cases, 2026-10-28 | Scoped review complete; live host acceptance pending |
| 协作等待 | 03 会话管理 | In progress | Partial: 2 isolated production-browser cases, 2026-10-28 | Scoped review complete; live coordination acceptance pending |
| 团队与子代理 | 03 会话管理 | In progress | Pending | Pending |
| 检查点与对话回退 | 03 会话管理 | In progress | Pending | Pending |
| 会话反馈 | 03 会话管理 | In progress | Partial: 20 isolated production-browser interactions + 6 baselines, 2026-10-28 | Scoped review complete including actual parent location binding; live persistence/full route acceptance pending |
| 个人后台任务 | 03 会话管理 | In progress | Partial: 13 distinct interaction cases across retained runs, 2026-10-28 | Scoped review complete; live execution and remaining job actions pending |
| 个人工作区 | 04 控制中心 | In progress | Pending | Pending |
| 系统概览 | 04 控制中心 | In progress | Pending | Pending |
| 模型服务商 | 05 连接与设置 | In progress | Pending | Pending |
| 模型管理 | 05 连接与设置 | In progress | Pending | Pending |
| 服务器 | 05 连接与设置 | In progress | Pending | Pending |
| 权限与安全 | 04 控制中心 | In progress | Pending | Pending |
| 记忆与学习 | 04 控制中心 | In progress | Pending | Pending |
| 受控自主进化 | 04 控制中心 | In progress | Pending | Pending |
| 运行时透视 | 04 控制中心 | In progress | Pending | Pending |
| 代理配置 | 04 控制中心 | In progress | Pending | Pending |
| 技能 | 04 控制中心 | In progress | Partial: 2 dedicated lifecycle cases plus shared extension scope/read guards, 2026-10-28 | Scoped review complete; remaining lifecycle/live Core acceptance pending |
| 插件 | 04 控制中心 | In progress | Partial: 2 dedicated inspect/control-approval cases plus shared extension guards, 2026-10-28 | Apply/remove/restore and live Core acceptance pending |
| 工作流 | 04 控制中心 | In progress | Partial: extension suite 25 interactions + 1 baseline across workflows/skills/plugins, 2026-10-28 | Scoped repair review complete; remaining node actions/live execution/full route acceptance pending |
| MCP 与资源 | 04 控制中心 | In progress | Pending | Pending |
| 诊断与运行报告 | 04 控制中心 | In progress | Pending | Pending |
| 数据库与本地运维 | 04 控制中心 | In progress | Pending | Pending |
| 开发者能力映射 | 04 控制中心 | In progress | Pending | Pending |
| 数据与租户治理 | 04 控制中心 | In progress | Pending | Pending |
| 产物与审计证据 | 04 控制中心 | In progress | Pending | Pending |
| 通用与外观设置 | 05 连接与设置 | In progress | Pending | Pending |
| 快捷键 | 05 连接与设置 | In progress | Pending | Pending |
| 首次启动引导 | 06 状态与组件 | In progress | Pending | Pending |
| 空白、加载与异常 | 06 状态与组件 | In progress | Pending | Pending |
| 弹窗、菜单与选择器 | 06 状态与组件 | In progress | Pending | Pending |
| 审批与提问 | 06 状态与组件 | In progress | Pending | Pending |
| 完整内容排版 | 06 状态与组件 | In progress | Pending | Pending |
| 手机 Web 会话 | 07 多尺寸与平台 | In progress | Pending | Pending |
| 手机历史预览 | 07 多尺寸与平台 | In progress | Pending | Pending |
| 窄窗口工作区 | 07 多尺寸与平台 | In progress | Pending | Pending |
| 桌面标题栏与原生菜单 | 07 多尺寸与平台 | In progress | Pending | Pending |
| 模型选择器 | 06 状态与组件 | In progress | Pending | Pending |
| 深色模型选择器 | 06 状态与组件 | In progress | Pending | Pending |
| 模型搜索无结果 | 06 状态与组件 | In progress | Pending | Pending |
| 模型不可用与恢复 | 06 状态与组件 | In progress | Pending | Pending |
| 全局搜索 | 01 对话与工作区 | In progress | Pending | Pending |
| 项目与工作区切换 | 01 对话与工作区 | In progress | Pending | Pending |
| 触屏模型选择器 | 07 多尺寸与平台 | In progress | Pending | Pending |
| 深色设置 | 05 连接与设置 | In progress | Pending | Pending |

## Verification evidence available before foundation edits

- `bun run typecheck`, `packages/ui`: exit 0.
- Current process inventory found no running Arforge app or Bun frontend process. Runtime acceptance still needs a controlled startup.
- Source inspection shows old default palette and missing font-face loading for the approved Noto fonts; foundation patch addresses those, while explicit themes/preferences remain respected.

Further test results and remaining gaps must be reported as evidence, not inferred from this tracker.

## Integrated acceptance checkpoint: 2026-09-22, repair batch 3

The user explicitly approved continuing repairs and targeted verification. The current goal remains active. No installer or 30x stress acceptance was performed. The table above is a full-scope checklist, not a claim that untested pages are complete.

### Verified evidence

| Scope | Authoritative evidence | Limit of claim |
| --- | --- | --- |
| Conversation startup | Production-browser diagnostic passed at 1440px and 1100px after removing the LocalProvider persistence self-subscription loop | Initial rendering only; does not prove pagination or every session action |
| Model picker | Production browser searched a collapsed provider, selected its model, preserved draft text, restored editor focus, cleared search on reopening, and restored trigger focus on Escape; no page errors | Mouse picker path with controlled API fixtures; keyboard/free-guide bindings and all invalid-model cases require separate evidence |
| File workbench | Isolated production build: 3/3 browser tests passed for PDF search and authorized snapshot download, compact primary-pane switching with Office controls, and save-conflict draft/disk-version comparison | Does not prove all Office formats, native pagination fidelity, terminal controls, or real backend authorization |
| Conversation review | Isolated production build: 4/6 browser tests passed: keyboard history identity/Escape focus, touch explicit jump and 44px targets, streamed Markdown/native lists, nested multi-paragraph list spacing | Hover reading-position and composer-bound assertions failed; remaining IME assertions in the failed test were not reached |
| Terminal controller | 15 tests and 37 assertions passed against the actual workspace controller | Covers operation failure/acknowledgement, duplicate requests and scope/race handling; panel wiring and global dirty-close protection still require integration evidence |
| Navigation repair | 21 tests and 181 assertions passed, including scoped external archive/delete cache invalidation and stale-response rejection | No blanket claim about global navigation or native tabs |
| Management repair | 54 tests and 199 assertions passed, including acknowledged rollback with failed refresh and read-only retry, scope/unmount guards and approval receipt helpers | Helper/source coverage, not browser acceptance of all management capabilities or forms |
| Static checking | App typecheck passed after the three known batch-2 TypeScript errors were corrected | Later concurrent edits must be checked again at the integrated checkpoint |

### Confirmed incomplete work and diagnostic findings

- The first smoke run on port 4193 had two invalid titlebar checks because its fixture persisted literal port 4096. A task-owned 4096 preview removed that mismatch; both tests then reached their real bottom-alignment assertions and failed by 7.8125 CSS px.
- Runtime geometry: the document root is 14 CSS px, so the bottom spacer's Tailwind h-16 is 56 CSS px while virtual-list geometry reserves 64 CSS px. Preserve the existing pixel geometry contract; do not weaken the 64px assertion or change the root text scale to hide the mismatch.
- Native wheel scrolling reproduced a lost prepend anchor: before an older-page response the viewport was at the row for message 0062; after the response it stayed at scrollTop 0 while the first row became message 0000. Earlier content is reachable, but the prior reading position is not preserved.
- The desktop history-hover test observed a 48px scroll change. Font/loading stabilization versus hover-triggered layout still needs diagnosis; neither cause is established yet.
- The composer bound test expected 244.8px from serialized line-height and observed 244.75px from layout. Per-line layout quantization and the floating-point assertion need explicit diagnosis; the product's approved 2-8-line behavior must remain unchanged.
- The real LocalProvider browser harness, unpaid/keyboard model entrypoints, terminal operation feedback, and shared unsaved-draft navigation guards are being completed by their owners. Do not mark these complete from earlier controller tests.
- Full Desktop runtime/native-menu coverage, management form interactions, server/workspace isolation across all entrypoints, and the remaining rows of the page inventory are still required.
- The independent 30x stress issue remains unresolved and outside this acceptance; installer acceptance remains deferred by the user.

### Acceptance rule

Keep product failures, test-harness failures, and unexecuted checks separate. A passing build, a representative screenshot, or a helper test is not evidence that every control on every page works. Delivery remains blocked by the missing and contradictory evidence above, not approved by this progress record.

## Recovery-stage checkpoint: 2026-10-28

The user resumed the paused task and requested completion of this stage before further front-end visual refinement. Every further design adjustment must be presented for detail-level review. Previously approved V2 foundations remain the baseline.

The following scoped recovery items are complete. The full 64-page product acceptance and the overall goal remain active.

| Item | Fresh evidence | Boundary |
| --- | --- | --- |
| Desktop static checking | Node invocation of the installed TypeScript native compiler, `--noEmit -p ../desktop/tsconfig.json`, exit 0 | Does not prove the full desktop application's startup or Core authorization flows |
| Independent browser start page | Production preload plus production browser window in isolated Electron: 8 checks passed, all 18 existing app locales, warm-white/graphite, RTL, retained URL/selection and system-theme setting, validation-language updates, 420px layout, external-page noninterference and cleanup | Main IPC in this fixture is a dedicated appearance handler; its 23 notifications are not Core business-action receipts |
| Existing native browser behavior | Standalone native smoke: 6 check groups passed; embedded native controller smoke: 9 groups passed | Isolated fixture hosts, not installer acceptance or a full application smoke |
| Cross-scope local drafts | 6 actual browser cases passed: cancel/accept navigation and same-path restoration across two directory scopes and two servers; 8 navigation confirms, no page errors or file PUT requests | Actual titlebar navigation; independent server/workspace selectors, distinct workspace IDs sharing one directory, and real file saving remain separate |
| Approval operations | 8 distinct production-component browser cases passed: 2 before the pause plus 6 resumed cases; fixture typecheck exit 0 | Real component/Provider/SDK adapter with in-memory SDK. Scope changes are fixture-driven, not server navigation or real backend writes |

### Durable evidence

- Appearance report: `packages/desktop/test-results/ui-v2-20261028-appearance-painted/appearance-report.json`.
- Stable light/dark captures: `appearance-light.png` and `appearance-dark.png` in the same directory. Capture waits for paint; earlier pre-paint captures are not the visual evidence.
- Native regressions: `browser-workbench-smoke.json` and `browser-embed-smoke.json` under `packages/desktop/test-results/ui-v2-20261028-appearance/`.
- Cross-scope report and traces: `packages/app/test-results/ui-v2-20261028-cross-scope/runs/2026-10-28T11-09-16-498Z-37460-d3c3892c/`.
- Approval resumed report: `packages/app/e2e/reproduction/ui-v2-approval-acceptance/results/resume-mvs0gtob/browser-report.json`; 6 expected, 0 skipped, 0 unexpected, 0 flaky. The two earlier success-handler cases are in the retained pre-pause results.

The September conversation diagnostics above are historical: the later timeline/composer repairs passed all 11 conversation and timeline browser cases on October 28, including cold/cached first paint and traversal of all 331 seeded parts. This does not imply that every message action or all remaining page rows have been accepted.

### Next visual refinement

Create review-only, independently selectable comparisons for ordinary secondary-button treatment, button radius, resting icon-button treatment, settings-group separation and keyboard focus styling. Preserve the approved palettes, typography, reading width, layout, input behavior and all functional entrypoints. Choices record design decisions; apply further product visual changes only after the user's explicit execution instruction.

Installer acceptance remains deferred and the independent 30x stress issue remains unresolved. No full-product delivery claim is made.

## User-directed ZCode reference study: 2026-10-28

The user requested launching the desktop ZCode app and using its visible details as the next UI reference. The ordinary desktop shortcut launched version 3.16.3.8992. Seventeen distinct visible UI states were recorded, including model/provider menus, access modes, history preview, settings, command center, terminal, right workbench and new-task view. Only the listed states are evidence; no claim of exhaustive ZCode workflow acceptance is made.

The review-only artifact is `%USERPROFILE%/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/zcode-reference-20261028/index.html`, with `observations.json` and actual screenshots beside it. It contains an interactive Arforge adaptation and the staged review plan. Its browser checks passed with no page errors, including all five comparison controls and a 390px-wide review page.

The user's ZCode steering changes the next review batch to: sidebar width (216/264/240 CSS px), composer toolbar placement, settings-group treatment, execution-summary framing, and command-palette background. These are pending design decisions. The previous approved warm-white/graphite direction, content typography, model-picker behavior and complete feature-preservation requirements remain the baseline. No additional Arforge production visual changes were applied during the ZCode reference study.

The user subsequently selected B for all five first-batch questions: 264px default sidebar without overriding personal preferences; attachments/mode left and model/send right; grouped rounded settings sections with fine dividers; lightweight execution summary with details/expansion preferences retained; global command-palette dimming plus blur. These are confirmed design decisions, not a new instruction to apply product edits. Next, review exact settings radii/padding and command-overlay range/strength. Model-picker no-dimming behavior remains unchanged.


### ZCode detail batch 02 confirmed, 2026-10-28

User confirmed 6B–11B: settings groups radius 16 CSS px; setting rows padding 16 CSS px on both axes; command palette overlay includes the sidebar and all application content, blur 5 CSS px, black opacity 12% in both themes. Existing model selector no-dim rule remains. These are recorded design choices; new ZCode-derived visual changes await an explicit execution instruction.

Functional acceptance continues independently for prompt queue and personal automatic jobs using isolated in-memory backends. No global delivery claim follows from these scoped checks.


### Prompt queue functional acceptance, 2026-10-28

Production-built current queue control, real ServerSDKProvider and OperationsApi adapter were exercised through an isolated memory fetch. Initial run reproduced structured API errors becoming `[object Object]` and an editor staying open after its queue item was removed. Fixed only `session-prompt-queue-control.tsx`: retain error values for the existing public-message/status renderer; close the editor after confirmed removal of that same item. Removing another item and failed removals preserve the draft. No new visual design was applied.

After correction: 12 interaction cases plus 3 baseline checks passed (15/15), no page errors, unknown SDK/native calls or network violations. Covers cancel, busy/acknowledgement, exact revision/model/attachment payload preservation and FIFO, explicit retry with draft retention, confirmation/removal, different source and same-URL replacement SDKs, another session, late list fencing and keyboard follow-up disclosure/actions. One initial harness selector was narrowed to the exact accessible icon-button name, preserving its keyboard behavior assertions. App and fixture typecheck passed.

Evidence: `packages/app/e2e/reproduction/ui-v2-queue-acceptance/results/fixed-2026-10-28T12-30-18-847Z/report.json`, corresponding per-case traces, and `results/comparison.json`. Before/after cold-ready median 511.8/696.5ms; edit-ready 40.4/51.1ms (3 contexts each, concurrent work on this machine). These samples record the required production comparison, but do not establish a no-regression performance acceptance. This isolated SDK fixture does not establish live Core/database or full native navigation acceptance. Installer acceptance and the separate 30x stress issue remain excluded.

Queue fix final build: full app production `node ./node_modules/vite/bin/vite.js build --logLevel warn` exited 0. Existing dynamic/static-import, large-chunk and duplicate WASM sourcemap warnings remain; no new build error. Task-owned queue preview on 4339 was stopped after acceptance; user application processes and ZCode were left untouched.


### ZCode detail batch 03 confirmed, 2026-10-28

User confirmed 12B–17B: attachment menu follows available composer width, maximum 760 CSS px; grouped single-column rows; mode menu width 320 CSS px; mode item radius 8 CSS px; selected mode check plus light fill; existing attachment shortcuts displayed as small keycaps. Only existing file, conditional goal, command, context and shell entries and the three existing modes are retained. No new permissions or shortcut bindings were added. Review-only HTML/light-dark PNG and 12 browser validation groups are in `zcode-reference-20261028/batch-03-main*`. Product visual execution still requires explicit instruction.

Personal jobs: 12 distinct fixture browser cases passed across earlier runs, but the once-creation payload/busy/receipt case remains unaccepted due to initial local GET transport failures before the component loaded. Production-build/static-preview fallback is being attempted with unchanged business assertions. No product defect or full acceptance is claimed from those transport failures.


### ZCode detail batch 04 confirmed, 2026-10-28

User confirmed 18B–23B for attachment/mode menus only: outer radius 16 CSS px; padding 8 CSS px on all sides; existing-color border 1 CSS px; shadow 0 10px 28px black at 8% light / 24% dark; unselected hover uses existing soft fill; keyboard focus uses a 2 CSS px outer outline, offset 2 CSS px, existing accent color. Earlier model-menu rules, mode item radius, dimensions and permissions remain. `batch-04.html`, light/dark PNGs and validation JSON have 10 passing preview groups, including exact computed styles, visible keyboard focus and no horizontal overflow at 390px. All 23 new design choices are now recorded, with no product visual execution instruction. Next review group is sidebar/session list details.


### Personal automatic jobs acceptance closed, 2026-10-28

The last once-create payload/busy/receipt test passed unchanged after switching the isolated fixture from dev serving to production build/static preview. Latest targeted run: 1 passed, 0 failed/skipped/flaky, suite 6.096s, case 1.438s; fixture typecheck/build exit 0. Original case body SHA-256 `7d480aef382bbb9ae1cfd1cc3c6daee4c2078c413a63874de7936ee2a9bcb67c` unchanged. Main reviewed actual assertions and structured browser result. Earlier 12 distinct cases were not rerun; cumulative 13 distinct cases passed, not a single 13-case production run. Real component/Provider/SDK adapter, memory-only business calls; no page errors, unexpected SDK/native/network calls. Own preview exited and 4338 has no listener.

Evidence: `packages/app/e2e/reproduction/ui-v2-personal-jobs-acceptance/results/jobs-production-mvs485bs/production-closeout.txt`, `browser-report.json`, `assertion-preservation.json`, `cleanup.json`; earlier `results/acceptance-evidence.json` lists the other 12 passed cases. Functional scope does not establish live Core persistence/execution, credential selection, every job action, real server-picker navigation, native/touch/installer or stress acceptance. No product code was changed for this fixture environment repair. Queue + personal-jobs bounded batch now has 25 passed interaction cases plus 3 queue baseline checks. The overall 64-page checklist remains incomplete.

Rules/self-review: no authorization, ownership, sensitive-data or destructive-effect boundary was crossed; scope and evidence limits remain explicit.


### ZCode detail batch 05 review ready, 2026-10-28

Prepared review-only `batch-05.html` and light/dark PNGs for six sidebar/session-list details (24–29). Previously confirmed sidebar width stays 264 CSS px; no new product visual edits. Ten preview groups passed: actual row sizes, selected-line/fill variants, hover/focus/permanent more action visibility, existing-time visibility, arrow positions, local selection/disclosure, and 390px no-overflow plus >=44px touch targets with permanent more actions. No page errors or external requests. Candidate radios remain unselected pending user answers. Global product feature acceptance remains incomplete; installer and separate stress work are still deferred.


### ZCode detail batch 05 confirmed, 2026-10-28

User individually confirmed 24B–29B: full-width soft-fill new-session button; desktop rows minimum 36 CSS px with touch targets >=44px; selected session uses soft fill without a side line; more actions show on desktop hover/focus and remain permanent on touch; existing short modification time remains visible; project collapse arrow appears before the folder icon. All 29 newly reviewed choices are now confirmed. Review-only `confirmed-details.html` consolidates the exact choices and links to all five interactive previews. These choices do not themselves authorize product visual execution. Further newly proposed details still require user review; overall feature acceptance remains incomplete.


### Session automation repair and acceptance, 2026-10-28

Main owns `session-operations-dialog.tsx`; no new ZCode-derived visual changes were applied. Production baseline reproduced nine product scenarios plus one test-only hidden-checkbox-input locator failure. Repairs: refresh the schedule list entry from the current GET before editing so save uses the fetched revision; close the editor after confirmed deletion of its item; disable schedule toggles while blocked; show durability as fixed at creation when editing because the existing update contract cannot change it; isolate trigger ID/JSON drafts per Host Profile within the originating SDK/session lifetime; reject `ok:false` trigger envelopes for list/get/create/update/run using a public action/profile/status error rather than host response serialization; apply the same freshness/scope gate to the run button. Core HTTP Trigger code and the server handler establish that upstream non-2xx can be returned inside an outer successful response, so checking only HTTP transport was insufficient.

Targeted production-browser result: 19 interaction cases + 3 production baseline checks, 22/22 passed; 0 page errors, external/business HTTP requests, unknown SDK calls or native attempts. Actual current SessionSettingsPanels, ServerSDKProvider and OperationsApi adapter were used with an isolated memory fetch. Covers schedule create/edit/save/delete/run/missed, exact revisions, busy states, read-only recovery without duplicate writes, per-profile drafts/IDs, Host rejection for three mutations, normal trigger create/open/update/confirm-run, stale data blocking, Wait owner/confirmation/failure/retry, and late create across another session, different server and same-URL replacement SDK. These switches are fixture-driven, not real app navigation.

Evidence: `packages/app/e2e/reproduction/ui-v2-automation-acceptance/results/fixed-2026-10-28T13-24-58-586Z/report.json`, per-case traces, `results/comparison.json`. Main reviewed the structured result and the changed source paths. Fixture/app typecheck and full app production build exited 0. Existing import/chunk/WASM-map warnings remain; fixture also preserves its existing public-font reference warnings. The initial readiness check was corrected to wait for an editable field because an empty create form is correctly disabled. Checkbox interaction uses the visible label and still asserts checked state. No business assertion was weakened.

Production comparison (3 contexts each): ready median 648.49ms before / 613.59ms after; form-ready median 36.17ms / 40.65ms. These shared-machine samples do not establish statistical no-regression or 30x stress acceptance. Task-owned preview 4341 stopped after verification; user app/server and ZCode untouched. Live Core persistence/execution, actual HTTP host authentication, live cooperative waits and full route/navigation remain unaccepted. Goal control is being independently verified; Task controls remain a separate required batch. Overall goal active, no delivery claim.

Rules/self-review: authorization, source ownership, sensitive-data and destructive-effect boundaries respected; requested scope and evidence limits preserved.


### Goal control repair in progress, 2026-10-28

Independent production-component acceptance found 18 of 20 distinct cases passing (including one baseline) and two concrete defects. Main inspected the current Goal source, original case coverage and raw baseline. Applied only `session-goal-control.tsx`: retain unknown read/write errors for ManagementStatus public-message projection, using managementErrorText when constructing the read-recovery Error; after acknowledged queued-goal deletion cancel only the editor for that same ID. App typecheck passed after these edits. Targeted production regression of both failures, different-editor preservation, replace conflict and a matching baseline is pending with the Goal worker. The existing Run Goal handler was an identified coverage gap and its real adapter/busy/receipt test has been requested; actual Core execution remains outside that fixture proof.

Goal baseline: `packages/app/e2e/reproduction/ui-v2-goal-acceptance/results/goal-production-mvs55uny/baseline.json`, one read-only production navigation sample 823ms; normalized source SHA-256 `878b4e79a2053a815af0495050217bc1ae2816dbf7dfd298d4900be9f6b258d6`. Original failed/positive evidence is under `results/goal-production-mvs5d49t/` and `results/acceptance-report.txt`. Do not mark the Goal row complete before regression and gap checks pass.

Task controls in the same parent page are separately assigned to the existing workbench worker for read-only product inspection and independent production-fixture acceptance, own port 4342/artifact; main retains sole ownership of the parent product source. Goal worker uses 4340. No additional new visual changes were authorized or applied. Overall goal remains active.


### Goal conflict recovery verified, 2026-10-28

Both earlier Goal repairs passed current-production regression: public structured errors no longer render as [object Object], and acknowledged queued-item deletion closes only that item's editor. A stronger test advanced the in-memory server's active Goal revision from 7 to 8 before the first save. It proved a third defect: explicit Refresh displayed revision 8 but retained editor base 7, causing another genuine conflict. The repair adopts the visible revision only on an explicit successful Refresh/Retry, retaining the objective draft. Automatic reads after another write preserve the original CAS guard. Save remains an explicit request; no automatic overwrite/retry occurs.

Current evidence: 23 distinct passing definitions (22 interactions and one baseline) across two current-source runs. The full run goal-production-mvs77xve had 22 passed and one new harness-selector failure: the actual accessible name is Move goal up, not Move up. Only that selector changed; the automatic-read CAS assertions and matching baseline passed in the 2-case goal-production-mvs7cxn5 run. This is not described as one 23-case green run. Production source hashes match between both runs. Existing Run Goal, busy, receipt, draft/error, queue ordering, history, session/server/same-URL SDK and unmount checks remain covered in those passed cases.

Evidence: packages/app/e2e/reproduction/ui-v2-goal-acceptance/results/current-acceptance.json and its linked raw browser reports. The matching pre-conflict-fix production baseline was 669ms; current samples were 933ms and 675ms, independent shared-machine navigations, not statistical performance acceptance. Real Core execution and full application navigation remain outside these fixtures. Own 4340 preview was cleaned up by the runner.

### Feedback error and session location binding verified, 2026-10-28

Retain unknown error values for the existing ManagementStatus public-error projection. The initial 13 direct interactions plus 3 baseline checks passed, but did not enforce workspace policy. Main inspected the actual protocol LocationMiddleware (query/header/server-cwd resolution, not body.sessionID inference) and Core Feedback session-directory validation. Strengthened the fixture to mount actual SessionSettingsPanels with ServerSDKProvider and the real OperationsApi adapter, provide the current SessionsGetOutput.location shape, and reject feedback without its session location. The parent submission reproduced the public workspace error before the product fix.

SessionSettingsContent now retains the authoritative session location and supplies it to SessionFeedbackControl. Submission is disabled until its directory is known and sends location[directory]/location[workspace] while preserving the exact feedback body. The strengthened run passed all 26 checks: 20 interactions and 6 readiness baselines. Seven interactions use the actual parent, including late success/error across another session, a different server and a replacement SDK at the same URL. Original direct payload/options, busy, error/draft/retry, disabled and disposal assertions were retained under the stricter location policy. No page errors, unknown/native calls or external requests occurred.

Evidence: packages/app/e2e/reproduction/ui-v2-feedback-acceptance/results/workspace-baseline-2026-10-28T14-21-26-953Z/report.json (3 baselines pass, scoped submission fails) and workspace-fixed-2026-10-28T14-23-48-966Z/report.json (26/26 pass), with current-acceptance.json comparison. Parent ready median 625.26ms before / 619.72ms after, three contexts each; this is not statistical performance acceptance. Fixture/app typecheck and full app production build exit 0. Existing import/chunk/WASM sourcemap warnings remain. Own preview 4343 was stopped; user app/server and ZCode untouched. Live database persistence and actual global/native navigation remain unaccepted.

### Task and extension follow-up, 2026-10-28

The Task worker's original production host failed before rendering because its connection resolver was not configured before provider initialization. That was a fixture setup failure, not a product failure. After correcting only the harness and the current Session DTO location shape, the actual Task controls reproduced three product failures: stale editor revision after explicit refresh; Save remaining after deleting the edited Task; Save remaining after clearing its terminal Task. Main fixed only those paths. Explicit Refresh/Retry adopts the latest visible Task revision while preserving the draft; automatic reads retain CAS protection. Delete/clear acknowledgements cancel only editors whose IDs were removed, preserving other active editors and drafts.

The production run at packages/app/test-results/ui-v2-tasks-acceptance/runs/2026-10-28T14-31-31-536Z-5b58b429/report.json passed 22/22 (21 interactions + baseline), including different-editor preservation, failed delete/clear retention and automatic-read CAS. No page errors, unknown SDK/native calls, external requests or findings; owned Chrome/static preview were closed. Main's further audit found the memory delete policy incorrectly incremented surviving dependent Task revisions, whereas actual Core removal relies on edge FK cascade without bumping surviving rows. The worker is correcting this model and checking affected assertions plus hidden deleted-blocker drafts before closing this scoped batch. Do not infer Core graph persistence from the memory fixture.

Extension production acceptance uses actual ArforgeSettingsPanels and its real SDK/location lifecycle, with read-only sibling dependencies and memory business transport. Baselines reproduced stale lists remaining writable after partial read failure, duplicate workflow control, old-session list/started-run results leaking into the current context, and an old child starting follow-up reads after parent location refresh. Main added a keyed SDK/location/session child, its own disposal-bound API scope, partition freshness, shared busy/write guards, and acknowledged-workflow read recovery. Permission and candidate controls use the same freshness/busy gate; their visual structure is unchanged. Workflow writes whose acknowledgement succeeds but refresh fails retain the acknowledgement and recover through reads without repeating the write.

Raw fixed report packages/app/e2e/reproduction/ui-v2-extension-acceptance/results/extension-production-mvs7sey8/browser-report.json has 26 expected, 0 skipped/unexpected/flaky (25 interactions + baseline), including all original failures and added rejected-start, acknowledged-start/control read-failure and pending-read control guards. Main reviewed the structured per-case results and source paths; fixture cleanup/comparison is being finalized. Skills/plugin control approvals in this proof are typed memory policy, not live human approval receipts; actual plugin apply/remove/restore and workflow node approval/retry are still distinct gaps. No new ZCode-derived visual design was applied.

Integrated app typecheck and production build after these product repairs exited 0. The full 64-page goal remains active; installer acceptance and the independent 30x stress issue remain excluded. All 29 ZCode choices remain confirmed review decisions awaiting explicit visual execution. Rules/self-review: scope, ownership, authorization, sensitive-data and destructive-effect boundaries respected; no user application/server restart.


### Session controls batch self-review closed, 2026-10-28

Task dependency audit completed. With the corrected Core-faithful memory deletion policy, the retained editor still sent deleted blocker IDs and received an actual modeled invalid-dependency rejection. Terminal clear had the same issue. The first clear precondition incorrectly looked for a terminal checkbox even though the actual product excludes terminal tasks from selectable blockers; main corrected only that fixture precondition to inspect the existing stored relation, kept the exact save assertions, and reproduced the stale-ID failure. Product fix prunes only the acknowledged deleted/cleared IDs from taskBlockers, preserving the title, description, other checked blockers and CAS base. Failed operations still preserve everything.

Final complete Task production run: packages/app/test-results/ui-v2-tasks-acceptance/runs/2026-10-28T14-44-50-945Z-41ace624/report.json, 24/24 passed (23 interactions + baseline), no findings/page errors/unknown/native/external calls, owned preview/browser closed. Its three captured product/SDK/adapter snapshots match current source. Current comparison is test-results/ui-v2-tasks-acceptance/current-acceptance.json. Ready baseline 431.05ms before / 471.70ms after, single samples, not statistical performance acceptance.

Extension source audit is complete. Full 26-case passing run had correct captured hashes; its runner embedded those literal values. Main changed future capture to read source dynamically and verified a fresh byte-identical production entry in extension-production-mvs82z9j. Baseline plus five original failure scenarios passed again (6/6), without changing business assertions or product code. Entry SHA-256 is 2b839edcfbfc7ca52c00dcba6686312d13bf22930e0822c382ac4fefbd5fcf84. Current source/manifest/case comparison is e2e/reproduction/ui-v2-extension-acceptance/results/current-acceptance.json. Ready samples: 713ms before, 824ms full after, 815ms audited after, not statistical performance acceptance.

Fresh checks after the final Task dependency patch: app typecheck exit 0; desktop typecheck exit 0; full app production build exit 0, retaining existing import/chunk/WASM-map warnings. Per-module count and command evidence are in packages/app/test-results/ui-v2-20261028-controls-closeout.json. Owned process/port observations are in the adjacent controls-cleanup.json; no application/server restart and no user ZCode process touched. Main reviewed the modified source paths, exact payload/version assertions, acknowledgement-versus-read-failure handling, raw reports, source/asset hashes and scope limitations.

This bounded repair batch is verified. Overall 64-page delivery is still incomplete. Next functional gaps include workflow node approval/rejection and branch retry, plugin apply/remove/restore, remaining session team/checkpoint operations, and broader real route/Core/native coverage. These are not credited by the passing scoped cases. New ZCode-derived visual work remains review-only with all 29 choices confirmed. Rules/self-review: existing authorization and source ownership respected, no Git/config changes, no business data/credentials written and no user application/server restart.


### Latest user sequencing and design-only handoff, 2026-10-28

The user explicitly changed the order to all design first, their review and explicit execution instruction second, product implementation third, functional acceptance last, then reiterated ZCode and Codex details as references. Both functional workers stopped. Their completed process handles were terminal and owned services/browser processes cleaned up. No new product fixes or functional acceptance continue after this instruction. Existing workingtree/evidence is preserved; earlier results do not authorize bypassing the new gate.

Historical evidence received before the stop: extension node/transaction production-component memory suite at extension-production-mvs8wqpb has 29 new interactions plus a matching baseline, 30/30 passed, with zero page/API/native/external violations. Original26 were not rerun and remain separate. Real Core health probe using the existing .tools/bun-1.3.14/bun.exe, sanitized child environment, fresh private profile/SQLite and original server/routes.webHandler returned200; this is not full UI/Core or persistence acceptance. The native Node loader/compiled exploration failed and is retained diagnostically. The Team worker retained two before product findings without modifying source; all such repairs await the later execution phase. No real plugin transaction was started by that worker.

New independent design draft: %USERPROFILE%/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-complete-design-review-20261028/index.html. Includes all64 existing page layouts, per-page action/state plans, the29 confirmed ZCode choices,36 new comparison choices and20 component specifications, all unanswered. The ordinary36px button baseline is preserved; the new compact-toolbar height question is separate. The8–9px ordinary-button range,760/800px reading width,264px sidebar and current model rules retain their latest accepted authority. Old previews remain archived, and no product stylesheet or component was changed for this draft.

Only independent-preview rendering/layout links were checked (not product functionality):64 layouts render,56 review cards, zero preselected answers/page errors/external requests and no overall overflow in the inspected desktop/390px hub. Representative browser-rendered design images are in renders/. This does not establish image/pixel review or product accessibility/functionality acceptance. phase-lock.json records remaining design work: complete per-page state drawings, all existing settings fields, file-preview variants and consistency of new parameter choices with their context. The entire design is still a draft; no final approval request or product execution follows merely from the default64 frames rendering.

Rules/self-review: latest user order, reference limits and all inherited decisions preserved. Current work is limited to standalone design assets and planning records, with implementation and functional testing stopped.


### Complete independent design review draft, 2026-10-29

Design-only continuation preserves the latest user gate and the accepted V2/Z01–Z29 foundation. No product source or product functionality test changed or ran in this phase. The new review root now includes all64 inherited page layouts,425 named state scenes,36 R decisions plus20 component specifications (56 total),168 option/anatomy sketches, per-page preservation/state links, and a22-image gallery linking the older preview archive. Recommendations are visible but all56 choices remain unanswered. The expanded details retain P03 desktop24px margins and440px detail width. File/editor/menu themes bind to the accepted warm-white/graphite tokens.

Complete settings draft reads current source for27 live UI fields plus44 named command examples and45 sound choices. Three persistence-only keys (fontSize,autoSave,showTerminal) remain in the preservation inventory and were removed as newly proposed active controls after main found no demonstrated current app UI consumer. No global permission setting or arbitrary send-shortcut preference was invented. Settings/onboarding/shortcut exact-label scenes include scoped reset, migration, IME capture/conflict, retained Shell draft, update confirmation and connection states. File draft covers10 views plus tablet variants and67 exact named file scenes; source limits distinguish read-only office previews, existing editor behavior and unverified affordances.

Latest renders/state-render-check.json is ok:true:425/425 named scenes,128 selected narrow/phone examples,56 cards/168 sketches/zero checked, zero script/resource errors/external requests and no inspected overall or recorded local overflow. renders/render-check.json separately records64/64 default page renders and the review hub. These are local HTML rendering/DOM geometry results, not pixel review, accessibility acceptance or real product behavior/persistence evidence. Own headless Chrome contexts were closed by the rendering scripts; no server or user application was restarted.

Entry: %USERPROFILE%/.codex/visualizations/2026/09/09/01a08447-eb04-7ba0-acac-ee4885be7f75/arforge-complete-design-review-20261028/index.html; image gallery: preview-images.html; scope/implementation handoff: design-handoff.json; phase authority: phase-lock.json. The draft is ready for user design review, not finally adopted. User may adjust every detail or adopt the recommendation package; implementation still requires explicit 执行, then final functionality acceptance requires explicit 执行验收 after implementation review. The overall front-end goal stays active; installer acceptance and unresolved30x stress work remain excluded.

Rules/self-review: latest authorization/order, source/evidence boundaries and inherited preferences respected; no Git/config changes, dependency installation, credentials/business writes, or user app/server/ZCode restart.


### User selected preview-first, per-item design review, 2026-10-29

The user answered the pending design-review question with “我先看预览，再按编号逐项确认（推荐）”. This confirms the review method only. No R01–R36 or C01–C20 selection was approved, no new product implementation was authorized, and no functionality acceptance was requested. Preserve all existing design assets and await numbered choices/adjustments. Phase and handoff records now retain this answer; no product source or preview UI was changed and no render/test process was started.


### User approved all56 A design options, 2026-10-29

The user explicitly said “全选A”, approving R01–R36 and C01–C20 as A. The full choice IDs, labels and component specifications are captured in approved-design-choices.json; generator and review UI now consume that record and seed all56 approved choices over older unconfirmed local selections once per approval revision. Future local B/C selections remain adjustment drafts; they do not alter the authoritative A record without user confirmation. Phase/handoff now mark the design approved and awaiting execution, with zero pending design choices. No product source changed and no product functionality acceptance started. The explicit user gate from the prior review question still requires 执行 for implementation and 执行验收 after implementation review for acceptance.


### All-A confirmation closeout and explicit user pause, 2026-10-29

The independent review now shows56/56 A selections and56 confirmed labels, including migration over older unconfirmed B cache entries. renders/approved-choice-display.json reports no page errors/external requests/overall overflow. This check covers the review artifact only, not product functionality acceptance; its owned headless browser was closed. The current authoritative choice source is approved-design-choices.json.

The user then instructed “先不开始执行，你完成当前工作就先暂停”. Current confirmation cleanup is complete. Phase/handoff record an explicit pause; no product implementation or acceptance starts. Resume requires user instruction. No product source, service/application process, existing preference or business data changed during this closeout.


### User authorized approved design implementation, 2026-10-29

User: “设计工作完成后，开始执行”. All56 A choices are confirmed and design work is complete, so this supersedes the prior pause and authorizes Desktop/Web product implementation. The final functionality acceptance gate is unchanged: await explicit 执行验收 after implementation review. Main owns shared visual primitives/navigation/composer; management and file-preview agents use disjoint product paths under existing parallel authorization. Compile/typecheck and the mandatory before/after production benchmark are engineering checks, not final functionality acceptance. No installer/30x stress acceptance, dependency downloads, Git actions or application/server restart.
