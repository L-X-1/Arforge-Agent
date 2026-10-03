# Phase 8.8 — Plugin/Skill Center evidence

Date: 2026-08-14

## Scope

The existing plugin/skill center now has a typed manifest and security
projection, durable ControlRun routing for every plugin mutation and skill
enable/disable operation, and a reviewable desktop projection. The renderer
does not construct control-plane identity, action identity, authorization
claims, or opaque capability handles.

## Delivered contract

- `plugin.json` metadata is validated for declared permissions, egress,
  secrets, compatibility API version, source, and SHA-256 tree digest.
- Ed25519 signatures are reported as unsigned, untrusted, verified, or
  invalid. Trust is read from the profile-local
  `${ARFORGE_HOME}/config/plugin_trust.json`; unsigned and untrusted packages
  remain visible as warnings, while invalid signatures block installation.
- Package discovery and installation reject forbidden references to EventV2,
  database-admin services, and opaque capability registries. Undeclared
  network egress and secret access are blocking findings.
- Directory and ZIP packages enforce path/link, entry-count, archive-size, and
  expanded-byte limits. ZIP entries are size-checked before inflation.
- Inspect remains read-only and two-phase. Apply, update, remove, restore,
  enable, and disable execute through the L3 human-authority
  `PluginControl -> ControlClaimIndex -> DurableRun -> ActionGateway` path.
- Completed ControlRuns use durable receipts and safe replay. Restored plugin
  recovery receipts survive the original trash metadata move. Restore now
  copies into a bounded staging directory and re-runs manifest/security
  validation before switching it into the managed plugins root.
- Managed skill enable/disable uses the same ControlRun boundary; the
  versioned Skill Lifecycle service remains the owner of skill candidate,
  evaluation, promotion, and rollback state.
- The UI displays source, digest, compatibility, declared scopes, signature
  status, security findings, and the fresh-approval boundary. Blocked
  candidates cannot be applied from the UI or runtime.
- The desktop approval center is stacked above the originating settings
  dialog instead of replacing it. Closing an approval therefore returns the
  user to the exact Plugin/Skill operation they started.
- User-facing cards now distinguish enabled/disabled state, localize profile
  source and known security findings, expose a recoverable removal ID, and
  keep technical digests in the review layer.
- A history-only Session revert remains available after project-local plugin
  management makes the worktree dirty. It seals the observed dirty
  fingerprint and still fails on later drift; file-writing revert plans keep
  the stricter clean, compensatable-source requirement.

## Verification

- `bun test --cwd packages/core test/plugins.test.ts` — 11 passed, 37
  assertions.
- `bun test --cwd packages/core test/plugins.test.ts test/skill-managed.test.ts`
  — 16 passed, 61 assertions.
- `bun test --cwd packages/arforge test/session/revert-snapshot.test.ts` — 7
  passed, 61 assertions.
- `bun test --cwd packages/arforge --timeout 30000
  test/session/revert-readonly-local.test.ts` — 1 passed, 274 assertions.
- `bun run --cwd packages/schema typecheck` — passed.
- `bun run --cwd packages/core typecheck` — passed.
- `bun run --cwd packages/protocol typecheck` — passed.
- `bun run --cwd packages/server typecheck` — passed.
- `bun test --cwd packages/app src/i18n/parity.test.ts` — 6 passed, 255
  assertions.
- Targeted `oxlint` — 0 errors; remaining warnings are existing strictness
  warnings in the touched legacy adapters and generated handler patterns.

Current app typecheck and app unit/browser regression are green; no new
Step 8.8 type or UI error was introduced by the extension center changes.

The development-build desktop acceptance now performs the real user-facing
Skill disable/enable and Plugin inspect/install/update/enable/disable/remove/
restore lifecycle through the shared approval center. Install, update, and
restore all finish disabled. The update path proves the displayed package
changes from 1.0.0 to 2.0.0 only after a fresh `plugin.update` approval. A
second package containing undeclared network and secret access is inspected
read-only, shows localized findings, keeps the apply action disabled, and
does not mutate the managed registry. The removal ID remains usable from the
UI, and the same run then proves Session revert/recovery still works with the
Plugin files present.

After adding these paths, one fresh run passed in 48.5s and three isolated
repeatability rounds passed in 46.79s, 47.44s, and 46.26s. No flaky failure
was ignored, and every round used a separate Electron profile and Arforge
home.

The tampered-recovery follow-up exposed and fixed a lifecycle idempotency
defect: after uninstall, restore, and a second uninstall of the same package,
the second user gesture was previously aliased to the first completed
ControlRun. The UI reported success without removing the restored Plugin.
Typed mutation payloads now accept an optional validated `cpr_` request ID;
the desktop creates one per user gesture, and the server folds that ID into
the canonical Plugin/Skill claim material. Retries with the same ID remain
idempotent, while a later explicit gesture receives a distinct operation.
Legacy callers without an ID keep the deterministic compatibility path.

The desktop acceptance now also removes the restored Plugin a second time,
modifies only its recoverable trash copy with undeclared egress and secret
access, approves restore, and proves the runtime returns the expected 400
without recreating the managed Plugin or deleting recovery evidence. The UI
shows a localized, actionable alert rather than raw transport JSON. The fresh
single run passed in 51.6s; three isolated rounds passed in 49.56s, 50.84s,
and 51.23s with no ignored flaky failures.

A focused full-process restart acceptance now uses the real desktop UI to
disable a managed Skill and inspect/install a managed Plugin through fresh
human approvals. It then terminates the complete Electron process tree and
relaunches with the same isolated workspace, Arforge home, and Electron
profile. After restart, the Skill remains disabled and the installed Plugin
remains present, versioned, and disabled. The local TypeScript sidecar is
restarted rather than reused. One fresh run passed in 38.2s; three isolated
repeatability rounds passed in 37.05s, 37.16s, and 37.05s with zero renderer
errors, failed network requests, or ignored flaky failures.

## 2026-08-23 strict completion audit

The local-development completion audit rechecked every Step 8.8 bullet against
the V2 plan and closed the remaining fail-open and user-visibility gaps:

| V2 requirement | Completion evidence |
| --- | --- |
| manifest/schema/signature/source | The immutable inspection token retains a safe source label, validated manifest projection, signature status, compatibility data, and tree digest. Editing the source field now invalidates the inspection and candidate selection immediately. |
| declared permissions/egress/secrets | The scanner compares each statically resolved network target and secret name with the actual declarations instead of accepting any non-empty declaration. Dynamic unresolved access fails closed. The desktop review discloses actions and resources, exact egress targets, and secret names while never rendering secret values. |
| install/update/uninstall ControlRun | The existing fresh human approval path remains mandatory. The desktop acceptance performs each mutation through the real control approval center. |
| enable/disable version | Enable/disable ControlRuns capture the server-observed version and SHA-256 in their canonical request material. Execution refuses a plugin that changed after review. Missing, invalid, or blocked Plugins and Skills cannot be enabled through the runtime even if a client bypasses disabled UI controls. |
| compatibility | API version and current platform are enforced. Platform-incompatible packages remain inspectable so the UI can explain the incompatibility, but both UI and runtime prohibit apply. |
| security scan | Oversized executable source and aggregate scan-limit overflow are blocking instead of silently skipped. Forbidden EventV2 publisher, database-admin, and opaque capability-registry references remain blocking. |
| rollback | An update exposes the old-version Recovery ID. Restoring it atomically replaces the installed version in disabled state and creates a distinct Recovery ID for undoing the rollback. Recovery contents are staged and rescanned before any switch. |
| audit | Every mutation remains a durable, idempotent ControlRun with bound action, resources, reviewed version/digest, result receipt, and replay path. |

The user-facing Plugin review uses progressive disclosure: the primary card
shows status and counts, while an expandable review shows immutable source,
API/platform/runtime compatibility, permission resources, egress targets,
secret names, and localized problems. Raw backend problem strings are no
longer appended to the Chinese installed card.

The same desktop run exposed a separate navigation defect in Personal
Workspace: cross-session Run recovery and Run-authorization attention was
being converted into “open related session,” closing the control center
instead of opening the promised details. Recovery and Run authorization now
always navigate to Runtime Insight; only truly session-owned automation and
artifact actions use the cross-session jump.

Fresh verification after these changes:

- Core Plugin/Skill regression: 24 passed, 0 failed, 78 assertions.
- App unit regression: 1,036 passed, 0 failed, 3,608 assertions.
- App browser regression: 32 passed, 0 failed, 75 assertions.
- Personal Workspace recovery navigation: 2 passed, 0 failed, 16 assertions.
- Core, App, App E2E, Protocol, and Server typechecks: passed.
- Targeted oxlint under the standalone current CLI configuration: 0 errors;
  warnings are pre-existing strictness findings in shared legacy files.
- Development desktop acceptance: passed with zero renderer errors and zero
  failed requests.
- Repeatability: 3/3 isolated rounds passed in 55.748s, 55.399s, and 55.919s;
  no flaky failure was ignored.

The desktop audit records these additional true assertions:
`pluginDeclaredScopesVisible`,
`pluginInspectionInvalidatedOnSourceChange`,
`pluginUpdateRollbackCompleted`,
`pluginUpdateRollbackUndoCompleted`, and
`recoveryAttentionNavigatedToRuntimeInsight`. It also records distinct update
and rollback-undo Recovery IDs.

## Boundary review

No plugin code path receives the EventV2 publisher, database admin service, or
opaque capability registry. The package entrypoint is not imported during
inspection or installation. Push/deployment was intentionally not performed;
this evidence is for the local Phase 8.8 checkpoint only.
