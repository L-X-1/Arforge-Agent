## Why

The approved F01–F32 design has source implementations, but the user's current visual review and the 425-state ledger show remaining presentation, navigation and capability gaps. The user has explicitly requested completing Desktop/Web interface reconstruction and polish using live Zcode/Codex references before resuming the 77 partial and 9 blocked acceptance items.

## What Changes

- Compare the approved design against current rendered Arforge and a live, read-only Zcode reference; record exact layout and interaction differences.
- Complete approved shell, conversation, composer, workbench, settings and control-center presentation through existing SolidJS owners and semantic theme tokens.
- Show concrete previews and record each design choice. The initial per-detail confirmation rule is superseded by the user's later explicit delegation to execute recommended details directly and review the final result. Existing confirmed dimensions, typography, themes and gestures remain authoritative.
- Preserve every current route, action, shortcut, model configuration, draft, source binding, permission and native integration.
- Keep the original 425-state ledger and its evidence intact. After the UI implementation stage, revisit every remaining partial/blocked item with stronger evidence or a direct repair; never infer full acceptance from component-only coverage.

## Capabilities

### New Capabilities

- `approved-ui-completion`: Requirement-level tracking for faithful Desktop/Web presentation, source-safe interactions, user-owned design decisions, and implementation-first/acceptance-second sequencing.

### Modified Capabilities

None. No existing canonical OpenSpec capability is being replaced; this change binds the already approved design and the explicit continuation objective.

## Impact

Presentation owners in `packages/app`, `packages/session-ui`, `packages/ui`, and platform integration in `packages/desktop`; capability gaps may later require scoped Core/Server work after interface decisions are resolved. No new framework, credential migration, database reset, release or automatic restart of existing user processes. References and updated progress live under `docs/ui-redesign/ui-completion-v5-20261030` and the linked Trellis task.
