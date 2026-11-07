## Context

The source and rendered Desktop/Web application use SolidJS and shared UI packages. The user has approved F01–F32 and earlier R/C/Z decisions, then asked for a further faithful visual completion pass before reopening the 86 remaining acceptance states. Live Zcode 3.16.3.8992 is running for read-only observation. Existing Arforge PID16064 is protected from reload/restart.

## Goals / Non-Goals

**Goals:** complete approved UI structure and visual consistency; maintain all interactions and source ownership; make proposed unresolved changes concrete in previews; subsequently address every original partial/blocked state with appropriately scoped evidence.

**Non-Goals:** replace existing frameworks, change user credentials/models, reset preferences/data, weaken access checks, redesign CLI/TUI, claim unavailable-platform acceptance, or release/deploy. Missing prerequisites remain visible rather than disappearing from the ledger.

## Decisions

1. Use the approved design as the normative source; Zcode/Codex are observed references, not substitutes for user choices. Keep 264px default sidebar, 44px titlebar, approved warm-white/graphite palettes, 17px body typography, 2–8-line composer, model switching and history gestures.
2. Implement layout changes in their real owning components and scoped styles, using existing handlers and tokens. Prefer ordinary grid/flex/container layouts to page-global DOM selectors or decorative mock actions. Reuse ManagementDetail and existing route/context infrastructure where present.
3. Keep UI implementation and final acceptance as ordered stages. During implementation use typechecks and necessary focused engineering checks to prevent regressions; do not reclassify the old acceptance rows until the UI stage is complete and the corresponding complete requirement has fresh evidence.
4. Use isolated build/browser/profile fixtures for changed UI, with source hash receipts. Existing user windows, drafts, configurations and sessions remain intact. Before timeline/session changes capture the production streaming baseline and compare the same configuration afterward.
5. The latest explicit user instruction delegates remaining recommended visible/interaction choices to the assistant and requests final-result review. Record the selected detail and rationale with concrete current-build previews, implement directly, and retain all earlier explicit user choices. This supersedes the earlier per-detail confirmation requirement; no elapsed-time assumption serves as approval.

## Risks / Trade-offs

- Visual polish could obscure navigation or reduce capabilities → preserve explicit action inventories and inspect actual keyboard/pointer behavior at the affected owner.
- Old green fixtures could hide missing backend contracts → keep the original row limitations and distinguish UI evidence from native/account/persistence evidence.
- Concurrent changes could mix tested and built sources → allocate non-overlapping owners and check source hashes before/after builds.
- Reshaping a shell around native caption controls could alter drag/zoom geometry → require explicit design confirmation for new framing and use platform-aware geometry, not fixed screenshot offsets.

## Migration Plan

Additive presentation changes only; retain preference/storage schemas and compatibility commands. Build to owned output directories. Do not overwrite the approved preview artifacts or automatically restart the user application.

## Open Questions

U01/U02/U03 were explicitly answered A by the user. All later interface details are now delegated to the assistant's recommendation; real account/platform/data prerequisites remain evidence requirements and cannot be invented. See `docs/ui-redesign/ui-completion-v5-20261030/authorization.json`.
