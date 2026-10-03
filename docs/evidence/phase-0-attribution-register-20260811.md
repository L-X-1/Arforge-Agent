# 阶段 0.2：逐文件归属登记

> 登记时间：2026-08-11
> 计划来源：`Arforge-最终详细实施计划-V2-2026-08-11.md`
> 本登记是阶段 0 的可审计证据，不是 Git 提交，也不改变任何产品代码。

## 2026-08-14 当前复核（不等同于阶段 0.6 关闭）

- 当前分支：`codex/phase-0-checkpoint`；本轮复核起点 HEAD：`c52a1ac1dd631e077a8fcb6f3260e700d0ab1082`。
- 当前工作树状态稳定：连续两次只读 `git status --porcelain=v1` 快照一致。
- 当前状态包含 52 个已跟踪修改，以及两个未跟踪根目录：`.codex-analysis/` 与 `tmp/`；两目录合计 182 个文件、约 167 MiB，内容主要是视频分析图像和临时锁文件。
- 52 个已跟踪修改与两个未跟踪根目录没有新的用户/历史归属证据，继续按“待确认、不可擅自覆盖或清理”处理；本轮未把它们加入提交。
- 本轮已确认的独立变更包括：用户授权的 Tier-2 可恢复退休（`scripts/write_desktop_signed_candidate_evidence.ps1` 已移入回收站，并单独提交为 `c52a1ac1`，对应审计已通过），以及本次本地质量完善批次明确列入 checkpoint 的代码、测试和证据文件；其余混杂工作树仍未加入提交。
- 因此本复核证明了状态稳定和本轮变更可恢复，但不能把尚未归属的 52 个修改及临时根目录误报为阶段 0.6 已满足。

## 登记结论

- 当前基线：`master`，HEAD `90811a85d843836b17a9d446733f0fbd5a118d54`。
- 本次只读快照包含 **340 项**工作树变更（已跟踪、未跟踪均计入）。
- 当前没有可靠的 checkpoint commit，因此不能仅凭当前文件内容判定所有历史修改的作者。
- 归属标记采用“宁可待确认，不臆测”的规则：
  - **本轮直接触及**：本轮确实读写过该文件；不代表整个文件内容均由本轮产生。
  - **生成物/锁文件**：在 checkpoint 前不运行生成、清理或覆盖；仅登记现状。
  - **待确认**：需要用户/历史证据确认，不能作为阶段 0.6 已满足的依据。
- 阶段 0.2 已形成逐文件功能域归属并纳入 checkpoint；15 个跨域候选保留为后续人工审查项，不据此自动拆分。

## 处理规则

1. 保留现有工作树，不 reset、checkout、clean、stash、branch、commit。
2. 不把未跟踪文件自动视为本轮新增；不把 tracked modified 自动视为本轮修改。
3. 生成物、品牌资产、锁文件单独隔离，等 checkpoint 后再执行生成器一致性审计。
4. 任何文件归属确认都必须附带可复核证据（用户说明、提交、补丁包或其他可追溯记录）。

## 文件级快照

| 路径 | Git 状态 | 计划域 | 当前归属 |
|---|---:|---|---|
| `ARFORGE.md` | ` M` | 根目录/配置 | 待确认：当前工作树无法证明历史归属 |
| `README.cn.md` | ` M` | 根目录/配置 | 待确认：当前工作树无法证明历史归属 |
| `README.md` | ` M` | 根目录/配置 | 待确认：当前工作树无法证明历史归属 |
| `assets/brand/Arforge-logo-app-icon.ico` | ` M` | 品牌与图像资产 | 资产变更；未能从当前快照证明归属，待确认 |
| `bun.lock` | ` M` | 品牌与图像资产 | 资产变更；未能从当前快照证明归属，待确认 |
| `icons/icon.ico` | ` M` | 品牌与图像资产 | 资产变更；未能从当前快照证明归属，待确认 |
| `packages/app/e2e/desktop-evolution-visibility.acceptance.ts` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/e2e/regression/context-fusion-evidence.spec.ts` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/public/favicon-v3.svg` | ` M` | 品牌与图像资产 | 资产变更；未能从当前快照证明归属，待确认 |
| `packages/app/public/favicon.svg` | ` M` | 品牌与图像资产 | 资产变更；未能从当前快照证明归属，待确认 |
| `packages/app/src/app.tsx` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/capabilities/control-center-map.ts` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/components/control-center/capability-workbench.tsx` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/components/control-center/dialog-control-center.tsx` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/components/control-center/evolution-workbench.tsx` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/components/control-center/navigation.test.ts` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/components/control-center/navigation.ts` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/components/control-center/runtime-insight-workbench.tsx` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/components/dialog-select-mcp.tsx` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/components/prompt-input/submit.test.ts` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/components/prompt-input/submit.ts` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/components/session/session-header.tsx` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/components/settings-v2/dialog-settings-v2.tsx` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/components/settings-v2/settings-v2.css` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/components/status-popover-body.tsx` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/components/status-popover-indicator.test.ts` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/components/status-popover-indicator.ts` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/components/titlebar-vertical-tabs.css` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/components/titlebar-vertical-tabs.tsx` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/components/titlebar.tsx` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/context/global-sync/mcp.test.ts` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/context/global-sync/mcp.ts` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/context/global-sync/types.ts` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/context/global-sync/utils.test.ts` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/context/global-sync/utils.ts` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/context/permission-mode.test.ts` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/context/permission-mode.ts` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/context/permission.tsx` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/context/server-sdk.test.ts` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/context/server-sdk.tsx` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/context/server-sync.test.ts` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/context/server-sync.tsx` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/i18n/en.ts` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/i18n/zh.ts` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/i18n/zht.ts` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/pages/home/home-archived-sessions-controller.tsx` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/pages/home/home-archived-sessions-model.test.ts` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/pages/home/home-archived-sessions-model.ts` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/pages/layout-new.tsx` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/pages/layout.tsx` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/pages/layout/workspace-sidebar.tsx` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/pages/new-session.tsx` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/pages/session.tsx` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/pages/session/composer/session-permission-dock.tsx` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/pages/session/composer/session-process-panel.tsx` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/pages/session/session-execution-dock.css` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/pages/session/session-execution-dock.tsx` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/pages/session/timeline/message-timeline.tsx` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/pages/settings.tsx` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/utils/public-error.test.ts` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/utils/server-compat.test.ts` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/utils/server-compat.ts` | ` M` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/auth/index.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/cli/cmd/mcp.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/cli/cmd/run.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/control-plane/adapters/worktree.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/mcp/auth.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/mcp/index.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/mcp/oauth-provider.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/project/project.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/server/routes/instance/httpapi/groups/experimental.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/server/routes/instance/httpapi/groups/mcp.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/server/routes/instance/httpapi/groups/session.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/server/routes/instance/httpapi/groups/workspace.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/server/routes/instance/httpapi/handlers/experimental.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/server/routes/instance/httpapi/handlers/mcp.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/server/routes/instance/httpapi/handlers/session.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/server/routes/instance/httpapi/handlers/workspace.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/server/routes/instance/httpapi/middleware/authorization.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/server/routes/instance/httpapi/server.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/server/shared/workspace-routing.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/session/execution.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/session/prompt.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 本轮直接触及；文件其余内容可能含既有修改 |
| `packages/arforge/src/session/revert.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/session/tools.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/share/session.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/share/share-next.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/tool/code-mode.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/tool/registry.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/tool/shell.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/tool/tool.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/worktree/index.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/test/auth/auth.test.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/test/fixture/mcp-lifecycle-stdio.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/test/mcp/auth.test.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/test/mcp/lifecycle.test.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/test/mcp/oauth-auto-connect.test.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/test/project/worktree.test.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/test/server/httpapi-authorization.test.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/test/server/httpapi-exercise/backend.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 本轮直接触及；文件其余内容可能含既有修改 |
| `packages/arforge/test/server/httpapi-exercise/index.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 本轮直接触及；文件其余内容可能含既有修改 |
| `packages/arforge/test/server/httpapi-experimental.test.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/test/server/httpapi-instance-route-auth.test.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/test/server/httpapi-mcp.test.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/test/server/httpapi-session.test.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/test/server/httpapi-workspace.test.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/test/server/workspace-routing.test.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/test/session/prompt.test.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/test/session/revert-compact.test.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/test/session/snapshot-tool-race.test.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/test/share/share-next.test.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/test/tool/code-mode.test.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/test/tool/registry.test.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/test/tool/shell.test.ts` | ` M` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/client/src/contract.ts` | ` M` | Client | 待确认：当前工作树无法证明历史归属 |
| `packages/client/src/generated-effect/client.ts` | ` M` | 生成物/锁文件 | 生成物或锁文件；本轮未执行生成/清理，待 checkpoint 后审计 |
| `packages/client/src/generated/client.ts` | ` M` | 生成物/锁文件 | 生成物或锁文件；本轮未执行生成/清理，待 checkpoint 后审计 |
| `packages/client/src/generated/types.ts` | ` M` | 生成物/锁文件 | 生成物或锁文件；本轮未执行生成/清理，待 checkpoint 后审计 |
| `packages/client/test/promise.test.ts` | ` M` | Client | 待确认：当前工作树无法证明历史归属 |
| `packages/core/script/generate-postgres-schema.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/script/test-postgres-rls.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/cross-spawn-spawner.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/database/dialect.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/database/migration.gen.ts` | ` M` | 生成物/锁文件 | 生成物或锁文件；本轮未执行生成/清理，待 checkpoint 后审计 |
| `packages/core/src/database/postgres-schema.gen.ts` | ` M` | 生成物/锁文件 | 生成物或锁文件；本轮未执行生成/清理，待 checkpoint 后审计 |
| `packages/core/src/database/schema.gen.ts` | ` M` | 生成物/锁文件 | 生成物或锁文件；本轮未执行生成/清理，待 checkpoint 后审计 |
| `packages/core/src/database/schema.postgres.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/event.ts` | ` M` | Core/Runtime/Durable/Trust | 本轮直接触及；文件其余内容可能含既有修改 |
| `packages/core/src/fs-util.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/global.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/location-services.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/permission.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/plugin/skill.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/runtime/index.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/runtime/verifier.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/session.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/session/input.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/session/revert.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/session/runner/llm.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/session/store.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/system-context/builtins.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/tool/AGENTS.md` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/tool/application-tools.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/tool/apply-patch.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/tool/bash.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/tool/cooperative-wait.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/tool/edit.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/tool/glob.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/tool/goal-update.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/tool/grep.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/tool/multimodal-diagnose.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/tool/notebook.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/tool/primary-delivery.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/tool/question.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/tool/read.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/tool/registry.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/tool/search.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/tool/skill.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/tool/task-graph.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/tool/team.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/tool/todowrite.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/tool/tool.ts` | ` M` | Core/Runtime/Durable/Trust | 本轮直接触及；文件其余内容可能含既有修改 |
| `packages/core/src/tool/tools.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/tool/trigger.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/tool/webfetch.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/tool/websearch.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/tool/write.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/workflow-graph/sql.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/test/application-tools.test.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/test/deferred-tools.test.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/test/effect/cross-spawn-spawner.test.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/test/event.test.ts` | ` M` | Core/Runtime/Durable/Trust | 本轮直接触及；文件其余内容可能含既有修改 |
| `packages/core/test/filesystem/filesystem.test.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/test/global.test.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/test/lib/effect.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/test/permission.test.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/test/runtime/verifier.test.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/test/session-runner-recorded.test.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/test/session-runner-tool-registry.test.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/test/session-runner.test.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/test/system-context/builtins.test.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/test/tool-apply-patch.test.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/test/tool-bash.test.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/test/tool-edit.test.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/test/tool-goal-update.test.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/test/tool-notebook.test.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/test/tool-question.test.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/test/tool-read.test.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/test/tool-skill.test.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/test/tool-task-graph.test.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/test/tool-team.test.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/test/tool-todowrite.test.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/test/tool-webfetch.test.ts` | ` M` | Core/Runtime/Durable/Trust | 本轮直接触及；文件其余内容可能含既有修改 |
| `packages/core/test/tool-websearch.test.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/test/tool-write.test.ts` | ` M` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/desktop/electron-builder.config.test.ts` | ` M` | Desktop/Electron | 待确认：当前工作树无法证明历史归属 |
| `packages/desktop/electron-builder.config.ts` | ` M` | Desktop/Electron | 待确认：当前工作树无法证明历史归属 |
| `packages/desktop/src/main/index.ts` | ` M` | Desktop/Electron | 待确认：当前工作树无法证明历史归属 |
| `packages/desktop/src/main/server.ts` | ` M` | Desktop/Electron | 待确认：当前工作树无法证明历史归属 |
| `packages/docs/favicon-v3.svg` | ` M` | 品牌与图像资产 | 资产变更；未能从当前快照证明归属，待确认 |
| `packages/docs/favicon.svg` | ` M` | 品牌与图像资产 | 资产变更；未能从当前快照证明归属，待确认 |
| `packages/protocol/src/groups/agent-capability.ts` | ` M` | Protocol | 待确认：当前工作树无法证明历史归属 |
| `packages/protocol/src/groups/runtime-insight.ts` | ` M` | Protocol | 待确认：当前工作树无法证明历史归属 |
| `packages/protocol/src/groups/session.ts` | ` M` | Protocol | 待确认：当前工作树无法证明历史归属 |
| `packages/schema/src/durable-event-manifest.ts` | ` M` | Schema/Contract | 待确认：当前工作树无法证明历史归属 |
| `packages/schema/src/event-manifest.ts` | ` M` | Schema/Contract | 待确认：当前工作树无法证明历史归属 |
| `packages/schema/src/index.ts` | ` M` | Schema/Contract | 待确认：当前工作树无法证明历史归属 |
| `packages/schema/src/mcp.ts` | ` M` | Schema/Contract | 待确认：当前工作树无法证明历史归属 |
| `packages/schema/src/permission.ts` | ` M` | Schema/Contract | 待确认：当前工作树无法证明历史归属 |
| `packages/schema/src/session-event.ts` | ` M` | Schema/Contract | 待确认：当前工作树无法证明历史归属 |
| `packages/schema/test/contract-hygiene.test.ts` | ` M` | Schema/Contract | 待确认：当前工作树无法证明历史归属 |
| `packages/schema/test/event-manifest.test.ts` | ` M` | Schema/Contract | 待确认：当前工作树无法证明历史归属 |
| `packages/schema/test/v1-isolation.test.ts` | ` M` | Schema/Contract | 待确认：当前工作树无法证明历史归属 |
| `packages/sdk/js/src/gen/types.gen.ts` | ` M` | SDK | 待确认：当前工作树无法证明历史归属 |
| `packages/sdk/js/src/v2/gen/sdk.gen.ts` | ` M` | SDK | 待确认：当前工作树无法证明历史归属 |
| `packages/sdk/js/src/v2/gen/types.gen.ts` | ` M` | SDK | 待确认：当前工作树无法证明历史归属 |
| `packages/sdk/js/tsconfig.tsbuildinfo` | ` M` | 生成物/锁文件 | 生成物或锁文件；本轮未执行生成/清理，待 checkpoint 后审计 |
| `packages/sdk/openapi.json` | ` M` | 生成物/锁文件 | 生成物或锁文件；本轮未执行生成/清理，待 checkpoint 后审计 |
| `packages/server/src/handlers/agent-capability.ts` | ` M` | Server/HTTP/Runtime | 本轮直接触及；文件其余内容可能含既有修改 |
| `packages/server/src/handlers/runtime-insight.ts` | ` M` | Server/HTTP/Runtime | 待确认：当前工作树无法证明历史归属 |
| `packages/server/src/handlers/session.ts` | ` M` | Server/HTTP/Runtime | 待确认：当前工作树无法证明历史归属 |
| `packages/server/src/routes.ts` | ` M` | Server/HTTP/Runtime | 待确认：当前工作树无法证明历史归属 |
| `packages/ui/src/assets/brand/arforge-logo.ico` | ` M` | 品牌与图像资产 | 资产变更；未能从当前快照证明归属，待确认 |
| `packages/ui/src/assets/brand/arforge-logo.png` | ` M` | 品牌与图像资产 | 资产变更；未能从当前快照证明归属，待确认 |
| `packages/ui/src/assets/favicon/apple-touch-icon-v3.png` | ` M` | 品牌与图像资产 | 资产变更；未能从当前快照证明归属，待确认 |
| `packages/ui/src/assets/favicon/apple-touch-icon.png` | ` M` | 品牌与图像资产 | 资产变更；未能从当前快照证明归属，待确认 |
| `packages/ui/src/assets/favicon/favicon-96x96-v3.png` | ` M` | 品牌与图像资产 | 资产变更；未能从当前快照证明归属，待确认 |
| `packages/ui/src/assets/favicon/favicon-96x96.png` | ` M` | 品牌与图像资产 | 资产变更；未能从当前快照证明归属，待确认 |
| `packages/ui/src/assets/favicon/favicon-v3.ico` | ` M` | 品牌与图像资产 | 资产变更；未能从当前快照证明归属，待确认 |
| `packages/ui/src/assets/favicon/favicon-v3.svg` | ` M` | 品牌与图像资产 | 资产变更；未能从当前快照证明归属，待确认 |
| `packages/ui/src/assets/favicon/favicon.ico` | ` M` | 品牌与图像资产 | 资产变更；未能从当前快照证明归属，待确认 |
| `packages/ui/src/assets/favicon/favicon.svg` | ` M` | 品牌与图像资产 | 资产变更；未能从当前快照证明归属，待确认 |
| `packages/ui/src/assets/favicon/web-app-manifest-192x192.png` | ` M` | 品牌与图像资产 | 资产变更；未能从当前快照证明归属，待确认 |
| `packages/ui/src/assets/favicon/web-app-manifest-512x512.png` | ` M` | 品牌与图像资产 | 资产变更；未能从当前快照证明归属，待确认 |
| `packages/ui/src/assets/images/social-share-black.png` | ` M` | 品牌与图像资产 | 资产变更；未能从当前快照证明归属，待确认 |
| `packages/ui/src/assets/images/social-share-zen.png` | ` M` | 品牌与图像资产 | 资产变更；未能从当前快照证明归属，待确认 |
| `packages/ui/src/assets/images/social-share.png` | ` M` | 品牌与图像资产 | 资产变更；未能从当前快照证明归属，待确认 |
| `packages/ui/src/i18n/ar.ts` | ` M` | UI/品牌/国际化 | 待确认：当前工作树无法证明历史归属 |
| `packages/ui/src/i18n/br.ts` | ` M` | UI/品牌/国际化 | 待确认：当前工作树无法证明历史归属 |
| `packages/ui/src/i18n/bs.ts` | ` M` | UI/品牌/国际化 | 待确认：当前工作树无法证明历史归属 |
| `packages/ui/src/i18n/da.ts` | ` M` | UI/品牌/国际化 | 待确认：当前工作树无法证明历史归属 |
| `packages/ui/src/i18n/de.ts` | ` M` | UI/品牌/国际化 | 待确认：当前工作树无法证明历史归属 |
| `packages/ui/src/i18n/en.ts` | ` M` | UI/品牌/国际化 | 待确认：当前工作树无法证明历史归属 |
| `packages/ui/src/i18n/es.ts` | ` M` | UI/品牌/国际化 | 待确认：当前工作树无法证明历史归属 |
| `packages/ui/src/i18n/fr.ts` | ` M` | UI/品牌/国际化 | 待确认：当前工作树无法证明历史归属 |
| `packages/ui/src/i18n/ja.ts` | ` M` | UI/品牌/国际化 | 待确认：当前工作树无法证明历史归属 |
| `packages/ui/src/i18n/ko.ts` | ` M` | UI/品牌/国际化 | 待确认：当前工作树无法证明历史归属 |
| `packages/ui/src/i18n/no.ts` | ` M` | UI/品牌/国际化 | 待确认：当前工作树无法证明历史归属 |
| `packages/ui/src/i18n/pl.ts` | ` M` | UI/品牌/国际化 | 待确认：当前工作树无法证明历史归属 |
| `packages/ui/src/i18n/ru.ts` | ` M` | UI/品牌/国际化 | 待确认：当前工作树无法证明历史归属 |
| `packages/ui/src/i18n/th.ts` | ` M` | UI/品牌/国际化 | 待确认：当前工作树无法证明历史归属 |
| `packages/ui/src/i18n/tr.ts` | ` M` | UI/品牌/国际化 | 待确认：当前工作树无法证明历史归属 |
| `packages/ui/src/i18n/uk.ts` | ` M` | UI/品牌/国际化 | 待确认：当前工作树无法证明历史归属 |
| `packages/ui/src/i18n/zh.ts` | ` M` | UI/品牌/国际化 | 待确认：当前工作树无法证明历史归属 |
| `packages/ui/src/i18n/zht.ts` | ` M` | UI/品牌/国际化 | 待确认：当前工作树无法证明历史归属 |
| `arforge/bundled_skills/agent_skills/skills/vision-tools/SKILL.md` | `??` | Python CLI/技能 | 待确认：当前工作树无法证明历史归属 |
| `docs/evidence/phase-0-r2-verification-20260811.md` | `??` | 文档/证据 | 本轮直接触及；文件其余内容可能含既有修改 |
| `docs/product-interaction.md` | `??` | 文档/证据 | 待确认：当前工作树无法证明历史归属 |
| `opencode.json` | `??` | 根目录/配置 | 待确认：当前工作树无法证明历史归属 |
| `packages/app/e2e/desktop-crash-recovery.acceptance.ts` | `??` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/components/control-approval/control-approval-center.tsx` | `??` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/components/control-center/runtime-insight-workbench.test.ts` | `??` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/components/control-operation-recovery.tsx` | `??` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/context/control-approval.test.ts` | `??` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/context/control-approval.tsx` | `??` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/pages/session/composer/session-permission-dock.test.ts` | `??` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/utils/control-operation-intent.test.ts` | `??` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/utils/control-operation-intent.ts` | `??` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/utils/control-operation-notice.ts` | `??` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/utils/control-operation-recovery.test.ts` | `??` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/app/src/utils/control-operation-recovery.ts` | `??` | App/UI/E2E | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/control-operation/node.ts` | `??` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/control-operation/service.ts` | `??` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/control-operation/worktree-executor.ts` | `??` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/control-operation/worktree-scheduler.ts` | `??` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/control-operation/worktree-snapshot.ts` | `??` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/control-operation/worktree-worker.ts` | `??` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/control-plane/claim-index-status.ts` | `??` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/control-plane/http-control-subject.ts` | `??` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/control-plane/run-coordinator.ts` | `??` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/mcp/cancellation.ts` | `??` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/mcp/gateway-adapter.ts` | `??` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/mcp/intent-key.ts` | `??` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/session/revert-readonly-inspector.ts` | `??` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/session/revert-readonly-local.ts` | `??` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/session/revert-snapshot.ts` | `??` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/session/tool-authorization.ts` | `??` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/src/share/session-snapshot.ts` | `??` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/test/cli/mcp-logout.test.ts` | `??` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/test/cli/run/share.test.ts` | `??` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/test/control-operation/service.test.ts` | `??` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/test/control-operation/worktree-executor.test.ts` | `??` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/test/control-operation/worktree-scheduler.test.ts` | `??` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/test/control-operation/worktree-snapshot.test.ts` | `??` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/test/control-operation/worktree-worker.test.ts` | `??` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/test/control-plane/claim-index-status.test.ts` | `??` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/test/control-plane/run-coordinator.test.ts` | `??` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/test/mcp/cancellation.test.ts` | `??` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/test/mcp/gateway-adapter.test.ts` | `??` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/test/mcp/local-approval.test.ts` | `??` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/test/server/httpapi-runtime-insight.test.ts` | `??` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/test/session/revert-readonly-inspector.test.ts` | `??` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/test/session/revert-readonly-local.test.ts` | `??` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/test/session/revert-snapshot.test.ts` | `??` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/test/session/tool-authorization.test.ts` | `??` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/test/session/tools-guard.test.ts` | `??` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/test/session/tools-preflight.test.ts` | `??` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/arforge/test/share/session-snapshot.test.ts` | `??` | Arforge HTTP/MCP/Session/Worktree/Control | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/action-gateway.ts` | `??` | Core/Runtime/Durable/Trust | 本轮直接触及；文件其余内容可能含既有修改 |
| `packages/core/src/authorizer.ts` | `??` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/database/migration/20260810101500_control_run_claim_index.ts` | `??` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/database/postgres-migrations/20260810100000_control_run_claim_index/migration.sql` | `??` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/plugin/skill/vision-tools.md` | `??` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/protected-json.ts` | `??` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/runtime/action-state.ts` | `??` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/runtime/control-claim-index.sql.ts` | `??` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/runtime/control-claim-index.ts` | `??` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/runtime/durable-action.ts` | `??` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/runtime/durable-run.ts` | `??` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/runtime/embedded-authorization.ts` | `??` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/secret-environment.ts` | `??` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/secret-provider.ts` | `??` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/tool/authorization-plan.ts` | `??` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/src/tool/effect-semantics.ts` | `??` | Core/Runtime/Durable/Trust | 本轮直接触及；文件其余内容可能含既有修改 |
| `packages/core/src/util/canonical-hash.ts` | `??` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/test/action-gateway.test.ts` | `??` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/test/authorizer.test.ts` | `??` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/test/control-claim-index.test.ts` | `??` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/test/durable-action.test.ts` | `??` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/test/durable-run.test.ts` | `??` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/test/secret-environment.test.ts` | `??` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/test/secret-provider.test.ts` | `??` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/test/session-revert-fail-closed.test.ts` | `??` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/core/test/tool-effect-semantics.test.ts` | `??` | Core/Runtime/Durable/Trust | 本轮直接触及；文件其余内容可能含既有修改 |
| `packages/core/test/util/canonical-hash.test.ts` | `??` | Core/Runtime/Durable/Trust | 待确认：当前工作树无法证明历史归属 |
| `packages/desktop/src/main/isolation-env.test.ts` | `??` | Desktop/Electron | 待确认：当前工作树无法证明历史归属 |
| `packages/desktop/src/main/isolation-env.ts` | `??` | Desktop/Electron | 待确认：当前工作树无法证明历史归属 |
| `packages/schema/src/agent-runtime.ts` | `??` | Schema/Contract | 待确认：当前工作树无法证明历史归属 |
| `packages/schema/test/control-plane-subject.test.ts` | `??` | Schema/Contract | 待确认：当前工作树无法证明历史归属 |
| `packages/sdk/js/test/mcp-oauth-contract.test.ts` | `??` | SDK | 待确认：当前工作树无法证明历史归属 |

## V2 八类切片汇总与人工复核候选

以下统计针对本登记的 340 项只读快照；登记文件和后续证据矩阵本身是在快照之后新增的证据文件，不计入下表。

| V2 分类 | 条目数 | 当前处理 |
|---|---:|---|
| 1 Durable/Trust Kernel | 30 | 逐文件保留，待归属确认 |
| 2 Direct Shell/Permission/UI | 103 | 逐文件保留，待归属确认 |
| 3 Worktree Control Operation | 32 | 逐文件保留，待归属确认 |
| 4 MCP/OAuth | 23 | 逐文件保留，待归属确认 |
| 5 Session revert/share fail-closed/snapshot | 18 | 逐文件保留，待归属确认 |
| 6 Memory/Learning/Evolution/Workflow | 15 | 逐文件保留，待归属确认 |
| 7 App/branding/website | 92 | 非阶段 0 主路径，待归属确认 |
| 8 generated/lockfile/binary assets | 27 | checkpoint 前不生成、不清理、不覆盖 |

以下文件跨越多个运行时边界，列为人工复核候选；这不是自动拆分或归属结论：

- `packages/app/src/app.tsx`
- `packages/app/src/context/server-sdk.tsx`
- `packages/app/src/pages/session.tsx`
- `packages/app/src/pages/session/composer/session-permission-dock.tsx`
- `packages/arforge/src/server/routes/instance/httpapi/groups/session.ts`
- `packages/arforge/src/server/routes/instance/httpapi/groups/mcp.ts`
- `packages/arforge/src/server/routes/instance/httpapi/server.ts`
- `packages/arforge/src/session/tools.ts`
- `packages/arforge/src/tool/registry.ts`
- `packages/core/src/runtime/index.ts`
- `packages/core/src/session.ts`
- `packages/core/src/tool/registry.ts`
- `packages/schema/src/index.ts`
- `packages/client/src/contract.ts`
- `packages/server/src/routes.ts`

## 当前阻断与下一步

- 需要继续完成：用户确认/历史证据补齐待确认文件的归属，并将 DB ledger、生成物、手工源文件分层登记。
- V2 Step 0.5 已在本地 `codex/phase-0-checkpoint` 分支完成分批提交；不会推送、远程传送、迁移数据库或打包桌面端。
- 后续阶段仍需逐项复核跨域候选和 generated 前后快照，不把 checkpoint 误报为产品阶段完成。
- 当前主证据见 [phase-0-r2-verification-20260811.md](./phase-0-r2-verification-20260811.md)。

## 自检

本文件记录工作树事实和归属边界；本地 checkpoint 提交已按授权完成，没有推送、远程传送、数据库写入或生成器写入。
