# Arforge V2 implementation and verification tracker

Approval: The user accepted all V2 recommendations and 11 CSS px model-group labels, then explicitly authorized implementation, tests, self-review, and parallel agents. This record supersedes pending-approval labels in the design review documents, not their preservation constraints.

Goal status: active. No claim of delivery readiness.

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
| 目标与任务 | 03 会话管理 | In progress | Pending | Pending |
| 待发送消息 | 03 会话管理 | In progress | Pending | Pending |
| 定时消息 | 03 会话管理 | In progress | Pending | Pending |
| 触发器 | 03 会话管理 | In progress | Pending | Pending |
| 协作等待 | 03 会话管理 | In progress | Pending | Pending |
| 团队与子代理 | 03 会话管理 | In progress | Pending | Pending |
| 检查点与对话回退 | 03 会话管理 | In progress | Pending | Pending |
| 会话反馈 | 03 会话管理 | In progress | Pending | Pending |
| 个人后台任务 | 03 会话管理 | In progress | Pending | Pending |
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
| 技能 | 04 控制中心 | In progress | Pending | Pending |
| 插件 | 04 控制中心 | In progress | Pending | Pending |
| 工作流 | 04 控制中心 | In progress | Pending | Pending |
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
