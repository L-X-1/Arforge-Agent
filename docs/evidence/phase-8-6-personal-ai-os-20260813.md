# Step 8.6 — Personal AI OS 基础证据

- 日期：2026-08-23（开发期复审补充）
- 计划：`Arforge-最终详细实施计划-V2-2026-08-11.md`，Step 8.6
- 分支：`codex/phase-0-checkpoint`
- 状态：durable Personal Job 控制平面、后台执行、API、SDK、Session Automation UI 与边界测试已落地；未执行 Git push

## 已落地

- 新增 `PersonalJob` schema 与 `personal.job.created/changed/deleted` durable event manifest。
- `PersonalJobV2` 以 EventV2 为事实源，提供 admission、幂等重放、revision 乐观并发、审批、启动/暂停/恢复/取消、周期 tick、结果/工件引用、通知、保留期与逻辑删除。
- 创建时校验 Session 与 Credential 所有权；credential 只保存 scoped ID，不进入事件或 UI 明文。
- 每个任务固定带有 `{ mode: "background", label: "后台自动", userVisible: true }`，并保存 schedule、预算、审批策略、quiet hours、notification policy 与 retention。
- 预算在启动和结果结算时 fail-closed 检查 attempts、duration、cost；结果带 canonical digest，artifact 只保存引用。
- 运行时再次校验 result usage 的非负 safe integer、结果状态/摘要/工件引用形态；`tick.limit` 也有正 safe integer 边界，避免仅依赖 TypeScript 类型。
- `user_each_run` 的审批在每次启动时消耗；暂停后恢复会重新进入 `awaiting_approval`，不能通过 start 绕过审批。
- quiet hours 会推迟通知可用时间；逻辑删除保留审计历史，活动 retention 会阻止删除。
- 新增 `/api/session/:sessionID/personal-job` 全套 create/list/get/approve/reject/start/pause/resume/cancel/notifications/read/delete 合同，并完成 generated client 与 Effect SDK 更新。
- Session Automation 面板显示“后台自动”、状态、revision、预算、审批、通知和终态删除入口；操作具备 loading、disabled、状态语义与键盘可达性，并可将已到达静默时段的通知标记为已读。
- 高级设置已提供限定凭据选择、免打扰时段、通知模式和删除保护期限（无保护/7/30/90/365 天）；密钥值不显示，删除保护期内的终态记录会在界面禁用删除并解释原因。

## Fresh verification

```text
core PersonalJob/Executor/Cron                                  PASS (27/27, 107 assertions)
Stage 8 bounded local evidence contract                         PASS (1/1, 6 assertions)
SDK Next Personal Job embedded HTTP E2E                         PASS (1/1, 9 assertions)
App Personal Job schedule/UX helpers                            PASS (5/5, 25 assertions)
App unit/browser/build                                          PASS (1036/32/build)
schema/core/protocol/server/client/sdk-next/app/arforge typecheck PASS
targeted oxlint                                                 PASS (0 warnings, 0 errors)
git diff --check                                                PASS
```

SDK E2E 使用真实 embedded server、SQLite、HTTP API 与 generated Effect client，覆盖了审批、启动、暂停、恢复、取消、通知已读、跨 Session 访问隔离和逻辑删除。

PostgreSQL 继续使用前序已授权的 durable event schema；本步骤没有新增个人任务专用 SQL 表，避免重复引入第二套事实源。本机数据库 migration ledger 已推进到 `20260823090000_workflow_node_read_default`。

## 明确边界

- `BackgroundJob` 仍保持其既有 process-local 语义，不能冒充 durable Personal Job 状态；Personal Job 的 durable 状态只来自 EventV2。
- `recordResult` 只由受信 runner/执行适配器提交，UI 不能伪造结果或 usage；当前本地执行接入、detached launch、租约心跳和崩溃恢复的最新证据见 `phase-8-6-personal-ai-os-execution-20260814.md` 的 2026-08-23 增补。
- `tick` 负责周期任务的 durable schedule advancement；公网 provider、跨进程平台 worker 与发布环境调度仍属于后续平台/部署范围，不冒充本地交付事实。
- UI 已提供一次性日期时间、周期预设/自定义 Cron、限定凭据、quiet hours、retention 预设等控制；仍不暴露 secret 明文，也不允许通过 UI 伪造受信执行结果或 usage。复杂保留策略编辑器不是本步骤的必需范围。
- 本次复审未发现新增类型错误；app、protocol、server、client、sdk-next 和 core 定向类型检查均通过。

本记录不宣称阶段 8.11 的 Personal AI OS 全阶段退出门禁已通过，也不宣称已经接入真实第三方 provider。提交仅保留在本地 checkpoint 分支。
