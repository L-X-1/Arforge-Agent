# Phase 8.7 — Personal Workspace

- 计划：`Arforge-最终详细实施计划-V2-2026-08-11.md` § Step 8.7
- 日期：2026-08-23（开发期复审与用户路径补强）
- 分支：`codex/phase-0-checkpoint`
- 状态：Step 8.7 开发验收完成；未发布、未部署、未 push。

## 已实现

- `PersonalWorkspace.Snapshot` 是只读、限量、按当前 tenant/user 与 project 过滤的安全投影。
- 统一返回 project/location、session、Task、Run、Personal Job、成本、artifact 与 Memory Candidate 的安全摘要；Task 现已在 Control Center 中形成真实可见、可返回会话的用户路径。
- `GET /api/personal-workspace` 通过 location middleware 提供，客户端生成层和 sdk-next 均已接入。
- Control Center 的“个人工作区”明确区分“系统自动”“需要人工”“已结束”和“用户可见”；Session 状态由 Task/Run/Personal Job 子状态聚合，不再把待批准自动任务误报为普通可见。
- pending Personal Job、待授权 Run、recovery required、cost、artifact、Memory Candidate 均有明确入口；当前会话的待授权 Run 会进入运行洞察，跨会话 attention 会先准确打开所属会话，避免误入当前会话。
- Task/Run/Job 深层状态已提供中、英、繁中用户文案，桌面 E2E 阻止 `awaiting_authorization`、`awaiting_approval`、`in_progress` 等原始枚举泄漏到中文界面。
- 页面与合同不返回 prompt、raw event、credential IDs、lease owner、control subject、artifact 内容或 destructive maintenance action。
- 投影核心层对 SDK/内部调用的非法 `limit`（例如 `NaN`、非安全整数）收敛到最小安全页大小；HTTP 层仍由 schema 拒绝非法 query。
- Session、Task、Run、Personal Job 和 Memory Candidate 均受 limit/tenant/user/project/workspace 边界约束；Memory Candidate 只包含 `global` 或精确匹配当前 project + workspace path 的记录。
- Durable Run 创建事件损坏时，底层返回类型化错误，Personal Workspace 只输出固定安全原因，不回显 schema/raw event 内容；测试使用哨兵验证无泄漏。
- destructive maintenance 仍由独立 admin/action authority 处理；OpenAPI 合同测试确认本页面只有 GET 快照，没有 POST/PUT/PATCH/DELETE。

## 验证

| 检查 | 结果 |
|---|---|
| `bun run --cwd packages/schema typecheck` | PASS |
| `bun run --cwd packages/core typecheck` | PASS |
| `bun run --cwd packages/protocol typecheck` | PASS |
| `bun run --cwd packages/server typecheck` | PASS |
| `bun run --cwd packages/client typecheck` | PASS |
| `bun run --cwd packages/sdk-next typecheck` | PASS |
| `bun run --cwd packages/app typecheck` | PASS |
| `bun run --cwd packages/app typecheck:e2e` | PASS |
| `bun --cwd packages/core test --timeout 30000 test/personal-workspace.test.ts` | PASS，1/1，7 assertions；含待授权活跃态、损坏 payload/aggregate ID 无泄漏 |
| `bun --cwd packages/core test --timeout 30000 test/durable-run.test.ts` | PASS，36/36，147 assertions |
| `bun --cwd packages/sdk-next test --timeout 120000 test/personal-workspace.test.ts` | PASS，1/1，10 assertions；含每会话 Task limit |
| `bun --cwd packages/server test src/personal-workspace-openapi.test.ts` | PASS，1/1，5 assertions；GET-only |
| Personal Workspace App 定向测试 | PASS，7/7，38 assertions |
| `bun run --cwd packages/app test:unit` | PASS，1036/1036，3606 assertions |
| `bun run --cwd packages/app test:browser` | PASS，32/32，75 assertions |
| Desktop E2E | PASS；Task 投影、中文状态、待批准/恢复入口可见，renderer errors=0、failed requests=0 |
| Desktop repeatability | PASS，3/3，隔离 profile，未忽略 flaky failure；52.190s / 52.636s / 52.702s |
| targeted `oxlint` | PASS，0 errors/0 warnings（仅对既有规则噪声作命令级豁免） |
| `git diff --check` | PASS |

## 已知边界

- Personal Workspace 是 projection/control surface，不是新的 executor，也不创建第二份 Run/Event truth。
- “系统自动/需要人工”是当前持久化 Task/Run/Job 状态的安全汇总，不伪造 runner 的实时心跳。
- 桌面证据位于本地忽略目录 `artifacts/desktop-typescript-runtime-visibility-audit.json` 与 `artifacts/desktop-repeatability-audit.json`，不进入 checkpoint。
- 构建仍会报告仓库既有的 Vite 动态导入与 `eval` 警告；未将其误报为零警告，但本轮没有构建失败、渲染器错误或失败请求。
