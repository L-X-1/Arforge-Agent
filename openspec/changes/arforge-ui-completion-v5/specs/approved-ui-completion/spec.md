## ADDED Requirements

### Requirement: Remove the execution pet while preserving execution capabilities
The latest explicit user instruction removes the execution pet module from Desktop and Web. Pet rendering, animation, movement controls, pet resources and exclusive backend pet metadata SHALL be removed. Shared reasoning modes, orchestration, real execution status, current/history tabs and execution-detail functionality SHALL remain intact. Pet removal SHALL precede resuming the other authorized interaction work.

#### Scenario: A user opens execution details after pet removal
- **WHEN** a real execution is running or completed
- **THEN** current execution, durable history and existing detail actions SHALL remain usable without a pet, pet controls or pet asset requests

#### Scenario: Shared execution policy previously also exposed a pet form
- **WHEN** the pet-only form mapping is removed
- **THEN** existing reasoning-level normalization and subagent execution policy SHALL retain their prior behavior

### Requirement: Faithful approved presentation
Desktop and Web SHALL implement the approved F01–F32 layout, visual and interaction rules while preserving every existing capability and explicit personal preference.

#### Scenario: A current rendered component differs from an approved rule
- **WHEN** a measured rendered component conflicts with an approved rule
- **THEN** its existing owner SHALL be corrected and verified with the affected control's real interaction, without deleting actions or resetting stored preferences

### Requirement: User-owned unresolved visible details
An unresolved visible layout or interaction detail MUST follow the latest explicit user decision policy. Initially the user required individual preview confirmation; the subsequent explicit instruction delegates all remaining recommended interface/interaction details to the implementing assistant and reserves user review for the final result. Existing explicit decisions MUST NOT be re-requested or silently replaced.

#### Scenario: A Zcode reference introduces a new shell outline
- **WHEN** the reference suggests framing that the current approved design does not define
- **THEN** the proposed detail SHALL be reviewable and its rationale recorded; under the latest explicit delegation the assistant SHALL select and implement the recommended option without another intermediate approval request

### Requirement: Preserve source-safe functionality
Presentation changes MUST keep existing actions, routes, keyboard/touch behavior, source guards, error recovery, draft persistence, permissions and model selection intact.

#### Scenario: A settings detail view is reorganized
- **WHEN** the user changes server or workspace while an earlier operation is pending
- **THEN** the prior operation MUST NOT update the new owner or its form, and all existing configuration actions SHALL remain reachable

#### Scenario: An opted-in bootstrap GET encounters a transient transport failure
- **WHEN** an existing bootstrap read uses `retryBootstrapRead(read, isCurrent)` in `packages/app/src/context/global-sync/bootstrap-read.ts`
- **THEN** recovery SHALL be bounded to three total attempts with 100ms and 200ms backoff, checking the captured source before and after each request
- **AND** only recognized transport errors or matching transient network messages SHALL retry; HTTP status, tagged domain, authentication, abort and timeout errors SHALL retain their existing failure behavior
- **AND** this policy SHALL apply only to the audited session GET, command list, configuration GET, V1 session status, current project, VCS, permission/question request lists and V2 session-list reads; mutations, global fetch/SDK defaults, existing Query-managed retry layers and the V1 session-list fallback SHALL remain unchanged

#### Scenario: A bootstrap source retires before a read is published
- **WHEN** the captured SDK/scope/directory generation or page lifetime is no longer current, or the session-list Query signal is aborted
- **THEN** the read SHALL NOT publish into the replacement owner; session warming SHALL recheck current immediately before merging, and permission/question publication SHALL recheck after warming
- **AND** unrecovered reads SHALL preserve existing partial/error state, retained session rows and manual retry rather than replaying writes or reporting readiness

Implementation/test pointers: `global-sync/bootstrap.ts`, `context/server-sync.tsx`, `global-sync/bootstrap-read.test.ts` and `global-sync/bootstrap-recovery.test.ts` under `packages/app/src/context/`. Source29 root checks establish these bounded contracts; they do not establish the cause of the Source28 network change or actual packaged recovery. Retry eligible GETs within their captured owner, rather than installing a blanket SDK retry.

### Requirement: UI completion precedes remaining formal acceptance
The implementation stage SHALL precede the resumed original 77 partial and 9 blocked-state acceptance work. Focused engineering checks SHALL remain available during implementation.

#### Scenario: A component-only test passes during polish
- **WHEN** a presentation interaction succeeds against a controlled API boundary
- **THEN** the original state SHALL retain any unproved native, backend, persistence, platform or account requirements until the relevant evidence exists

### Requirement: Existing message actions remain connected end to end
The real message rendering pipeline MUST forward the owner-provided action set into its selected message component. It MUST preserve callback ownership, disabled reasons, busy state, persistent feedback and source checks, rather than merely declaring optional props that the actual App does not deliver.

#### Scenario: Regenerate a failed reply in an ordinary non-Git project
- **WHEN** the user previews Regenerate for a visible original prompt
- **THEN** the existing conversation rewind owner SHALL resolve the exact boundary before that prompt, without requiring Git or performing filesystem restore; preview and cancellation SHALL write no checkpoint or archive
- **AND** the confirmation SHALL state that files, commands, Git history and external effects remain unchanged, and that the unsent draft and pending prompts are retained

#### Scenario: Confirm conversation-only regeneration
- **WHEN** the user confirms the captured message/source preview while the Session is idle
- **THEN** apply SHALL revalidate the authenticated owner, source, current revision token and expected last sequence inside the existing rewind transaction, create its checkpoint there, and archive exactly the later conversation messages
- **AND** pending queue/steer entries, attachment bytes and FIFO order SHALL remain intact; a stale, busy, foreign, moved or missing target SHALL not partially archive, create a checkpoint or resend
- **AND** only a successful acknowledgement in the same source and model-selection scope SHALL permit the existing prompt admission path to resend the original content/references/attachments with a new stable request identity

#### Scenario: A queued prompt was admitted before the previous answer finished
- **WHEN** prompt B is enqueued at sequence 10, answer A completes at 15, and B becomes visible at 20
- **THEN** Regenerate B SHALL use the conversation boundary at 15, retaining A and archiving B from its visible promotion; its exact promoted input SHALL be removed while pending inputs retain their identities, attachments and FIFO order
- **AND** this SHALL NOT rewind to the earlier queue admission boundary

#### Scenario: Regenerate the first visible prompt
- **WHEN** applying the confirmed archive empties the visible conversation
- **THEN** the guarded resend SHALL be acknowledged before the subsequent history refresh can dispose the old timeline owner; the refresh SHALL NOT suppress that legitimate resend or authorize another source
- **AND** SDK/server rebinding or navigation before apply/resend SHALL cancel the continuation, while the newly admitted Run becoming busy SHALL NOT be mistaken for a failed admission

#### Scenario: Change the current model before regenerating
- **WHEN** the user selects another available model/variant for the current Session and confirms Regenerate
- **THEN** the resend SHALL use that explicit current selection, retain original content/attachment MIME and the unsent composer draft, and SHALL NOT fall back silently to the failed message's model

#### Scenario: Keep filesystem Undo and Edit separate
- **WHEN** Regenerate uses conversation-only rewind
- **THEN** the existing Edit, filesystem Undo/Redo and controlled restore actions SHALL remain reachable through their existing owners and authorization, approval and Git guards; regeneration SHALL NOT claim to reverse workspace or external effects

#### Scenario: Eligible reply actions are provided by the conversation owner
- **WHEN** the real conversation owner provides retry, branch and more actions for an assistant reply
- **THEN** the real App SHALL expose those controls together with copy and the approved model/time toolbar, and an opened action menu SHALL preserve its visible origin and return keyboard focus on close

#### Scenario: No action owner exists
- **WHEN** a read-only or unsupported context does not supply an action handler
- **THEN** the renderer MUST NOT fabricate a successful action or silently bind the control to another conversation

### Requirement: Evidence and protected runtime
The implementation MUST preserve the original 425-state evidence and existing user runtime. New screenshots, source snapshots and test records SHALL identify their exact scope; every remaining state SHALL receive an explicit disposition rather than being dropped.

#### Scenario: Timeline code changes
- **WHEN** a session/timeline component is about to change
- **THEN** a production baseline SHALL be recorded first, and a matched comparison SHALL be performed after the change without restarting the existing user application

#### Scenario: External authorization or platform is unavailable
- **WHEN** a required real account callback or native platform cannot be exercised
- **THEN** the state SHALL remain explicitly unaccepted and the missing prerequisite SHALL be recorded without fake success or substituted platform evidence

### Requirement: Existing manual session rename persists through its native owner
The existing rename action MUST commit a title-only change through the canonical typed native endpoint, Session service, durable event and projection. An empty 204 MUST follow a successful commit. Existing owner/source checks, all unrelated session fields, timestamps, messages, drafts and model selection SHALL remain intact. Manual title edits MUST protect user intent against late generated-title proposals.

#### Scenario: A manual title is committed
- **WHEN** an authorized user renames the session through the existing action
- **THEN** authoritative reads and same-source views SHALL reflect the committed title; no prompt, message or model call SHALL be created

#### Scenario: A second registered window receives a committed title
- **WHEN** the other window already displays that session and receives its source-bound committed rename event
- **THEN** its tab, preview and applicable session lists SHALL react to the canonical title without a reload or replacement request, while retaining its own draft, selection and navigation state

#### Scenario: The rename runs inside an authorized outer transaction
- **WHEN** an enclosing database transaction has not yet committed or ultimately rolls back
- **THEN** live listeners, subscribers and durable-stream wakeups SHALL NOT observe the rename before the outermost successful commit, and a rollback SHALL discard the associated notification

#### Scenario: The session is moved, removed or loses the captured owner before commit
- **WHEN** the durable command revalidates its target inside the projection transaction
- **THEN** it SHALL fail with a typed error and roll back the title, event row and aggregate sequence before any notification

#### Scenario: A generated title arrives after a manual title was changed back to its original default
- **WHEN** the original automatic proposal is projected late
- **THEN** committed manual rename history SHALL prevent it from replacing the user's title

### Requirement: Action glyphs preserve their meaning and contrast
Approved action controls MUST render the intended registered glyph with their own theme foreground. A legacy child-icon style MUST NOT override its parent control's contrast foreground, and a literal icon-name typo MUST NOT silently turn a different action into a plus glyph.

#### Scenario: The composer uses a light contrast button in the dark theme
- **WHEN** Send or Stop is available on the soft white button surface
- **THEN** its actual SVG SHALL use the control's dark contrast foreground and remain distinguishable from that surface, preserving the original handler and state

#### Scenario: The sidebar or compact tab preview shows an action icon
- **WHEN** background jobs, terminal, more actions or rename is rendered
- **THEN** its glyph SHALL identify that action from the existing icon system while retaining its accessible name, focus behavior and original owner

### Requirement: Background execution outlives request transactions safely
Long-lived execution MUST retain the captured authorized principal and source without retaining an expired request SQL transaction or commit-effects frame. Durable admission and event notifications MUST keep their existing commit and rollback guarantees.

#### Scenario: Admitted work starts after the request transaction finishes
- **WHEN** a registered background generation starts after its admission request has committed
- **THEN** its database operations SHALL use valid authorized transaction scopes, and committed progress SHALL reach live views before terminal completion

#### Scenario: Admission rolls back before a scheduled wake
- **WHEN** the enclosing admission transaction rolls back
- **THEN** no execution for that rolled-back admission or corresponding committed notification SHALL escape the transaction

### Requirement: Actual tool results survive presentation conversion
The native event and history presentation pipeline MUST preserve available complete tool inputs, results, errors and their original identities. Model-facing content and structured results SHALL be interpreted through the shared presentation owner without inventing output or exposing binary bytes as prose.

#### Scenario: A successful read returns only structured text
- **WHEN** a native read succeeds with a structured text-page and no model-facing text blocks
- **THEN** the message and execution detail SHALL retain its text, allow the existing long-output disclosure and complete copy actions, and render the same result after history hydration

### Requirement: Existing session commands use the current execution contract
Shell, named commands and manual compaction MUST remain reachable through typed current APIs and their existing authorized execution owners. Request fields, stable identities, status codes and typed failures MUST agree between the actual App, generated client and server.

#### Scenario: A named command is sent immediately or queued
- **WHEN** an existing configured command is submitted with its arguments, attachments and selected route
- **THEN** its existing template and command semantics SHALL reach canonical durable admission and execution rather than being replaced by unexpanded command metadata or a separate runner

#### Scenario: A manual compaction is confirmed
- **WHEN** the user confirms the captured source and context through the existing preview
- **THEN** the server SHALL validate the applicable source and revision, use the existing transactional compaction/checkpoint owner, preserve the selected route, and distinguish admission from a real committed summary or failure

#### Scenario: A real tool awaits human permission
- **WHEN** the execution owner publishes a source-bound pending permission for a tool invocation
- **THEN** the actual request and execution detail SHALL remain usable; an allowance SHALL continue that invocation once and a rejection SHALL prevent its execution

#### Scenario: A stopped or permission-declined run is paused
- **WHEN** the current authorized Run emits its canonical paused transition
- **THEN** the App SHALL release its busy presentation and controls while retaining the durable checkpoint; an older Run's late pause SHALL NOT clear a newer active Run's busy state

#### Scenario: Run history reads authoritative source summaries
- **WHEN** the history panel requests the bounded Personal Workspace snapshot
- **THEN** its request SHALL satisfy the canonical endpoint's limit and source contract, so available current-source runs remain inspectable; a real read failure SHALL remain visible with read-only retry rather than being reported as confirmed missing historical binding

### Requirement: Preview and project navigation preserve actual source state
Preview controls and project selection MUST retain the captured file, draft and source identity across selection, retry and resource loading. Existing file protections, archive limits and HTML resource isolation SHALL remain in force.

#### Scenario: A DOCX contains merged and nested tables
- **WHEN** a supported document is opened through the real file owner
- **THEN** its supported row spans, column spans and nested content order SHALL remain inspectable, without a claim of native Office pagination fidelity

#### Scenario: A configured project directory is no longer available
- **WHEN** the project selector displays that unavailable source
- **THEN** it SHALL communicate the source-specific unavailable reason and prevent unsupported interaction while preserving other project choices, recovery and existing drafts

#### Scenario: An unavailable directory is restored before explicit retry
- **WHEN** the user retries reading that same source after the directory has become available
- **THEN** a failed service construction SHALL NOT permanently prevent recovery, and cleanup of an earlier failure SHALL NOT dispose a newer valid context or an unrelated source

#### Scenario: A browser address omits its protocol prefix
- **WHEN** the user enters a valid hostname or local host-and-port address into an existing built-in browser address control and submits it
- **THEN** the control SHALL accept that address, normalize it to an appropriate HTTP(S) destination through the existing navigation owner, preserve its path/query/fragment and display the actual navigated address
- **AND** explicit HTTP(S) addresses, credential rejection, unsupported-scheme rejection, origin permission and isolated browser protections SHALL remain enforced; native form validation SHALL NOT prevent a supported address from reaching the navigation owner

### Requirement: Supported native runtime retains authentication behavior
The desktop's supported Node runtime MUST provide the existing account registration and verification behavior using compatible password hashes and the existing authentication policy.

#### Scenario: A new isolated account is registered on the native backend
- **WHEN** the supported native runtime executes registration
- **THEN** it SHALL hash and verify the password through the existing credential owner without requiring an unavailable Bun global, weakening authentication or changing existing account credentials

#### Scenario: An authenticated principal creates or retries a session
- **WHEN** a supported backend creates the canonical Session and durable records under that principal
- **THEN** Session, event and sequence ownership SHALL agree with the captured principal, preserve atomic rollback and commit visibility, and reject reuse of another owner's supplied Session ID

#### Scenario: Authenticated durable events project a request and reply
- **WHEN** the canonical event transaction projects an admitted request, its promotion or a supported promoted-only compatibility event
- **THEN** the projected input and all message kinds SHALL explicitly persist the effective execution principal, matching their Session and durable event rather than relying on local SQL defaults
- **AND** the authenticated owner SHALL be able to preview the exact original prompt without writes; foreign-tenant and same-tenant foreign-user requests SHALL remain denied, with no partial event or projection writes
- **AND** the default local/private flow, rollback and after-commit visibility SHALL remain intact; previously inconsistent stored rows SHALL NOT be silently reassigned by a read or accepted by weakened ownership filters

#### Scenario: A retained SQLite projection has the known local-default ownership defect
- **WHEN** the canonical migration owner encounters a child row with both known local-default ownership values whose exact origin event, aggregate sequence and parent Session agree on a nonlocal owner and the child's canonical identity
- **THEN** a dedicated transactional data migration SHALL change only those two ownership columns, preserving all content, identities, queue ordering, archive state and execution lease fields; a repeat application SHALL be a no-op
- **AND** conflicting or incomplete authority, a foreign nondefault child owner or ambiguous origin SHALL leave the row unchanged and access denied; preview and ordinary reads SHALL remain read-only
- **AND** retained-fixture verification SHALL prove owner preview/apply, foreign denial, rollback and idempotence without mutating the original failure evidence or claiming an untested PostgreSQL repair

### Requirement: Model configuration and context usage follow the approved reference
The model-configuration and context-usage surfaces SHALL use the relevant Zcode layout details as a reference while retaining every existing supported configuration, source guard, usage value and interaction. Unavailable or unknown backend values SHALL remain explicitly unknown rather than being invented for visual similarity.

#### Scenario: The refined interfaces are reviewed
- **WHEN** the normal application displays model configuration or context usage
- **THEN** their actual layout and responsive behavior SHALL match the implemented design and recorded reference decisions, preserve user settings and expose existing controls without overlap or lost actions

### Requirement: A normal-use Windows executable starts and stops owned services
After the current interaction repairs/checks, deliver a usable packaged Windows executable and Desktop shortcut. The package SHALL use normal usage branding and configuration, include its required runtime/resources and preserve existing user data. Temporary harness profiles, dummy providers and test-service dependencies SHALL NOT be the delivered usage environment.

#### Scenario: Launch from the Desktop shortcut
- **WHEN** the user opens the shortcut with no owned application runtime running
- **THEN** the packaged application SHALL automatically start its owned backend, wait for actual readiness and connect the interface without requiring a terminal or a separately started development server
- **AND** startup failures SHALL show actionable recovery rather than a blank window or a false connected state

#### Scenario: Exit the application and its background owner
- **WHEN** the user quits the application or closes its last application window under the normal close behavior
- **THEN** it SHALL save supported pending user state, shut down its owned backend, terminals, workers and child windows, and release owned listening ports
- **AND** it SHALL NOT stop an external server, shared database, Docker daemon or another application's processes; closing one of several application windows SHALL preserve the others' functioning service

#### Scenario: Audit the packaged artifact
- **WHEN** the normal-use package is ready
- **THEN** checks SHALL execute that packaged artifact through first launch, relaunch, configuration persistence, principal UI actions and exit cleanup; absent resources, orphan services or unusable interactions SHALL be repaired before delivery
- **AND** package checks SHALL have separate versioned evidence without changing the identities or historical results of the original 425 UI states

#### Scenario: A first launch is still initializing
- **WHEN** a normal empty profile is initializing delivered plugin resources or waiting for the owned backend
- **THEN** the application SHALL expose visible startup feedback without publishing a connected state before a valid healthy backend response
- **AND** SDK bootstrap SHALL use legitimate delivered runtime resources without a private workspace registry package, checkout dependency or QA profile seed

#### Scenario: Quit occurs while the backend is starting
- **WHEN** the user closes the last window or requests Quit before backend readiness
- **THEN** shutdown SHALL include the captured in-flight backend owner and await its exit; repeated requests SHALL NOT start a second cleanup or leave a late-created service running

#### Scenario: A separate ordinary profile is explicitly selected
- **WHEN** the application is launched with a supported explicit profile-directory configuration
- **THEN** it SHALL run the normal product behavior with that persistent profile and its own session data, without enabling a test mode or copying another user's configuration
- **AND** a launch without that override SHALL keep the established normal product data location

### Requirement: Supported custom-provider configuration uses the existing authorized owners
The normal V2 desktop SHALL expose supported host configuration through an explicit capability and typed operations. Configuration writes MUST reuse the canonical document owner, while keys and private request headers MUST use the existing principal-bound encrypted Integration/Credential owner. Existing V1 behavior and unrelated configuration SHALL remain available through their existing owners.

#### Scenario: A host owner configures a supported custom provider after catalog bootstrap
- **WHEN** the authorized host saves a supported OpenAI-compatible provider through the existing form
- **THEN** its nonsecret configuration SHALL be validated and saved with the canonical document revision checks, and the same running backend SHALL expose its models and supported authentication method after refresh
- **AND** a provider that needs no credentials SHALL remain usable without creating a dummy credential; a supplied key or private header SHALL NOT be copied into the configuration document or public diagnostics

#### Scenario: The selected source is not authorized to change host configuration
- **WHEN** the current authenticated source lacks the explicit host configuration capability
- **THEN** the UI SHALL communicate the unavailable reason and the server SHALL reject mutation without changing configuration or credentials

#### Scenario: Configuration succeeds but credential connection fails
- **WHEN** the canonical configuration was saved and the following credential operation fails
- **THEN** the form SHALL retain its input and explain the partial result; retry SHALL target that same committed provider revision without duplicating configuration or reporting a successful connection prematurely
- **AND** a changed source or committed revision SHALL prevent the captured credential operation from continuing against another target

#### Scenario: Another window changes the provider target during connection
- **WHEN** an earlier credential connection is held while another authorized operation changes that provider's Base URL
- **THEN** the earlier key SHALL NOT become usable for a request to the replacement target; the operation SHALL preserve the newer configuration and report its actual conflict or partial result
- **AND** any durable target binding SHALL remain valid after a normal restart when the target has not changed

#### Scenario: Another window reconnects while an older disconnect is pending
- **WHEN** a newer connection has been committed after the disconnect captured its original credential identity
- **THEN** the older disconnect SHALL NOT remove that newer credential or overwrite the newer configuration; its response SHALL describe the actual source/revision outcome

### Requirement: Request projection retains supported original attachment data
Canonical and legacy request projections SHALL preserve supported attachment bytes/URIs, MIME, names and mention ranges. Regeneration SHALL retain the original explicit request/turn system instruction while using the currently selected model/variant; injected runtime or project context SHALL NOT be promoted to an original user instruction.

Live native prompt promotion and history reload SHALL both preserve each MCP attachment's registered connection and resource URI. Regenerating a live message SHALL NOT replace a registered resource with an unbound URI, including when two connections expose the same URI or the attachment has no mention text.

#### Scenario: A queued PNG prompt is regenerated with a newly selected route
- **WHEN** the user regenerates the original admitted prompt after selecting another available model/variant
- **THEN** the actual new admission and model request SHALL contain the original PNG and source ranges without an undefined data URI, retain the original explicit turn instruction, and preserve sibling queue entries and the current draft

### Requirement: Typed provider diagnostics do not enter learned recovery context
Typed provider HTTP failures SHALL pass through the shared safe public projection before learning maintenance. Public reads of retained typed provider outcomes and derived patterns SHALL use the same safe boundary, preserving available status facts and unrelated user learning text.

#### Scenario: A later request includes learning from a provider failure
- **WHEN** fresh or retained typed provider failure evidence contributes to recovery learning
- **THEN** public Learning views, persisted recovery envelopes and their authorized live event projection SHALL exclude private provider body/header diagnostics
- **AND** retained outcome rows, original execution Cause, identities and unrelated user notes SHALL remain intact; flattened historical diagnostics SHALL NOT invent a quota-versus-rate classification

### Requirement: Capability descriptions cover generated operations
New generated operations SHALL appear exactly once in the existing descriptive capability mapping according to their product feature. This mapping SHALL remain separate from execution evidence and authorization enforcement.

#### Scenario: Provider configuration operations are generated
- **WHEN** capability, save, credential and disconnect operations are added to the typed client
- **THEN** the existing provider/model/integration feature mapping SHALL account for each operation, while the existing server capability and principal checks continue to govern actual use

### Requirement: Deferred server configuration remains bound to its originating form
Existing server add/edit and connection-preview requests SHALL capture their source, form lifetime and target identity. Normal successful operations and explicit global default-server actions SHALL retain their existing semantics.

#### Scenario: A server response arrives after the form or target changed
- **WHEN** a pending health/protocol response finishes after reset, disposal, source change, target removal/replacement or a newer form operation
- **THEN** it SHALL NOT commit old server configuration or credentials, resurrect a removed target, reset the new form, navigate or publish an error/status into the new owner
- **AND** a display-name edit alone SHALL preserve a still-valid connection preview; a valid uninterrupted save SHALL continue to work

### Requirement: Terminal mouse selection preserves keyboard input focus
The terminal SHALL forward focus from its own container to its actual input synchronously, including focus issued by the existing mouse selection library. Mouse selection and existing clipboard, link, rename and composer interactions SHALL remain available.

#### Scenario: A user clicks the terminal canvas after it is ready
- **WHEN** the mouse selection handler focuses the terminal container after pointer-down focused the input
- **THEN** the real textarea SHALL retain focus and typed input SHALL reach the owned PTY
- **AND** no mouse event SHALL be cancelled by this focus handoff; a later rename or composer focus SHALL NOT be stolen by a delayed callback
- **AND** terminal disposal SHALL remove the focus listener

### Requirement: Memory substring search treats user text literally
The existing memory inventory search SHALL match literal underscores, percent signs and backslashes in user-entered text. Existing visibility, scope, source, type and importance filters SHALL continue to apply.

#### Scenario: Memory content contains SQL pattern characters
- **WHEN** the user searches for a substring containing `_`, `%`, `\` or a combination of these characters
- **THEN** the matching visible memory SHALL be returned without treating those characters as wildcards or dropping the match
- **AND** other workspaces' or otherwise non-visible memories SHALL remain excluded

### Requirement: Audit verification status reflects the latest attempt
The existing audit inventory SHALL retain its rows and available actions while verification status remains bound to the latest request and its source.

#### Scenario: A recheck fails after an earlier successful verification
- **WHEN** the user starts a new audit verification and its genuine transport request fails
- **THEN** the previous green verification banner SHALL NOT remain displayed as the current result during loading or after failure
- **AND** the current error and existing retry action SHALL remain available without fabricating an invalid-chain verdict or clearing the retained audit entries
- **AND** a response from an older request or previous source SHALL NOT restore an obsolete success result

### Requirement: Explicit theme choice controls the rendered browser scheme
The selected light or dark scheme SHALL govern both theme tokens and the root computed `color-scheme`, independently of the operating system preference. Existing theme selection, system following and persistence SHALL remain available.

#### Scenario: The user selects Dark while the system prefers Light
- **WHEN** the user selects Dark through the normal General settings control
- **THEN** the stored choice, rendered theme scheme and root computed `color-scheme` SHALL all be dark
- **AND** shortcut reset/cancel SHALL preserve that choice; normal and immediate-close relaunches SHALL restore it

#### Scenario: General settings loads the built-in theme catalog
- **WHEN** the user opens General settings after the application module graph has loaded
- **THEN** the existing built-in definitions SHALL be available through the eager local JSON glob in `packages/ui/src/theme/context.tsx`, retaining the `file(): Promise<{ default: DesktopTheme }>` facade and all theme IDs, names and selection APIs without optional per-theme network imports
- **AND** loading the catalog SHALL preserve the selected theme, cached light/dark CSS, color-scheme choice and drafts; it SHALL NOT reload the Root or drop a theme whose former lazy import failed

#### Scenario: Theme work completes after a newer preview or Provider disposal
- **WHEN** a theme continuation is superseded or its Provider is disposed
- **THEN** it SHALL NOT publish a cache/CSS/callback update after disposal or restore an older preview over a newer one
- **AND** cancelling a preview SHALL check its preview version and captured committed selection/version before restoration; existing storage and persistence fences SHALL remain intact

Implementation/test pointers: `packages/ui/src/theme/context-loading.test.ts` exercises the real Provider and Vite glob transform; `review-foundation.test.ts` retains the approved colors and semantic tokens. The current 36 JSON payloads total 92,875 raw bytes, including 69,583 bytes beyond the already eager default; this is a source-payload budget, not a measured bundle delta. Source29 compiled settings/network, theme selection and persistence evidence remains required; component/compiler checks alone do not promote packaged or historical acceptance.

### Requirement: Mentioned MCP resources retain their canonical source identity
Existing MCP resource mentions SHALL retain their server and URI identity through admission and execution. Resource content SHALL use the established authenticated and authorized MCP resource reader rather than being lowered to unsupported provider media.

#### Scenario: A configured resource is included in a chat request
- **WHEN** the user selects a connected MCP text resource and sends the message
- **THEN** canonical execution SHALL preserve its resource identity and obtain its bytes through the existing resource owner before constructing the model request
- **AND** existing principal, workspace, authentication and resource permission checks SHALL continue to apply; missing authorization SHALL NOT cause an unauthorized read or silent content omission
- **AND** ordinary file, image and other supported attachments SHALL retain their existing behavior

#### Scenario: A resource draft has no inline mention text
- **WHEN** history, a branch or a queued request restores an MCP attachment without an inline mention, or an edited queued message removes only the mention text
- **THEN** the original server/URI and MIME SHALL remain attached, visible and removable without adding phantom text to the request
- **AND** a resource-only draft SHALL be sendable and queueable without being mistaken for an empty Stop action; genuinely empty input SHALL retain its existing behavior
- **AND** both existing input implementations SHALL preserve this behavior, including cached and uncached queue restoration

#### Scenario: A queued request is edited and submitted again
- **WHEN** the user edits its text or selected model
- **THEN** inline mention text SHALL appear once, and attachments SHALL retain their exact server identity rather than matching another server by URI or name alone
- **AND** original request-level instructions and other supported metadata without an editing control SHALL remain intact
- **AND** generated client contracts SHALL expose the additive resource reference consistently with the current Schema and Protocol

#### Scenario: An attachment reference contains inconsistent URI targets
- **WHEN** a new admission or queued-request update contains a file URI that differs from its explicit resource URI
- **THEN** the authoritative Core boundary SHALL reject it before durable input/event mutation with the existing typed invalid-input behavior
- **AND** shared transport schemas SHALL remain portable for canonical client generation; generator checks SHALL NOT be disabled or bypassed

### Requirement: Concurrent MCP requests preserve rotating OAuth credentials
Concurrent catalog, health and resource operations for one authenticated MCP owner SHALL coordinate refresh-token exchanges without losing a successful rotation. Existing authentication errors, generation retirement and permission checks SHALL remain effective.

#### Scenario: Several requests encounter the same expired access token
- **WHEN** concurrent requests for the same credential owner and exact refresh request need a rotating token exchange
- **THEN** they SHALL share the in-flight exchange and retain the successfully saved replacement credentials, including a caller arriving between HTTP completion and token persistence
- **AND** different owners, endpoints, clients, resources or scopes SHALL NOT share credentials or responses
- **AND** every response consumer SHALL retain an independent readable response; unrelated requests SHALL remain unchanged

#### Scenario: A refresh is cancelled, revoked or superseded
- **WHEN** a request is cancelled or its owning connection/authorization is retired while refresh is pending
- **THEN** the operation SHALL preserve existing cancellation and ownership checks and SHALL NOT restore retired credentials or erase newer credentials
- **AND** genuine authentication failure SHALL remain visible without unauthorized resource reads, fabricated healthy status or blind resource retries

#### Scenario: A committed OAuth provider saves refreshed tokens from an SDK callback
- **WHEN** the SDK invokes credential persistence after the pending authorization has become a connected client
- **THEN** configuration and credential operations SHALL run with that State's existing captured workspace context
- **AND** current configuration, generation, lease and retirement checks SHALL remain authoritative; a missing callback context SHALL NOT be replaced with cached configuration or another workspace's context

#### Scenario: Two providers share the same physical credential record
- **WHEN** two provider and service instances address one protected credential store, auth key and equivalent frozen OAuth request for the same credential epoch
- **THEN** refresh coordination SHALL apply to the credential record rather than only one provider object; a consumed refresh token SHALL NOT be exchanged twice
- **AND** both valid callers SHALL retain their own readable response and ownership checks without a late loser clearing the saved winner
- **AND** releasing one transport SHALL NOT cancel another live owner, while explicit credential revocation or replacement SHALL retire the relevant shared epoch
- **AND** different stores, auth keys or authorization targets SHALL remain isolated; in-process evidence SHALL NOT be described as cross-process coordination

#### Scenario: Concurrent reads repeat Windows credential decryption
- **WHEN** multiple requests read the same protected MCP credential envelope in one service lifetime
- **THEN** a short-lived private cache MAY reuse a successful exact-ciphertext decryption while every operation still reads the file, validates its envelope, decodes a fresh value and obeys the existing file lock
- **AND** returned bytes and parsed entries SHALL NOT mutate the cached value; failed reads/decryptions, removal, ciphertext replacement, expiry and scope closure SHALL clear private cached bytes
- **AND** cache identity SHALL NOT grant authorization or replace credential epochs, revocation, CAS, configured request deadlines or genuine SDK health checks

### Requirement: Unknown context capacity remains distinct from actual zero usage
Model details and the session context view SHALL display an unknown or nonpositive configured context capacity as an em dash while retaining the existing layout and all model selection and context actions.

#### Scenario: A configured model omits its context capacity
- **WHEN** the tooltip or session context view renders that model
- **THEN** unknown capacity SHALL display as `—`, rather than asserting a capacity of zero
- **AND** actual zero token usage, zero cost and zero percent SHALL retain their real values; known positive capacity SHALL retain locale formatting

### Requirement: The packaged desktop provides an explicit PostgreSQL maintenance entry
The Windows usage EXE SHALL provide an explicitly invoked maintenance mode that reuses the canonical administrative PostgreSQL migrator without depending on Bun or a source checkout.

#### Scenario: An administrator invokes packaged schema recovery
- **WHEN** the maintenance mode is explicitly requested and confirmed with its private administrative environment configured
- **THEN** an owned no-server utility SHALL call the existing ordered transactional migrator with its advisory lock and durable migration ledger
- **AND** credentials SHALL remain outside command-line arguments, IPC results, logs and dialogs; only a safe outcome and revision/count SHALL be returned
- **AND** success SHALL require the utility to exit; failure, cancellation or timeout SHALL clean up only the owned utility and SHALL NOT become a successful normal startup

#### Scenario: Normal startup or missing administrator configuration
- **WHEN** the application starts normally, or maintenance lacks its administrative configuration
- **THEN** it SHALL NOT silently change database backend, grant DDL privileges, use the application URL as an administrator fallback, or start/stop shared PostgreSQL or Docker
- **AND** missing configuration SHALL produce actionable safe guidance; ordinary frontend/backend ownership and exit behavior SHALL remain available

### Requirement: Provider save feedback is independent of catalog refresh latency
Custom provider configuration SHALL acknowledge the durable configuration and any required credential connection separately from subsequent inventory refresh, retaining the existing fields and source-bound retry behavior.

#### Scenario: The configuration is saved while directory reads remain pending
- **WHEN** the authoritative configuration and required credential operations complete for the current form
- **THEN** the form SHALL complete without waiting for unrelated provider/model/integration directory reads
- **AND** a failed credential connection SHALL remain visible and retryable promptly without reporting that the connection succeeded
- **AND** inventory refresh SHALL continue with visible failure/retry feedback; saving configuration SHALL NOT assert model availability before its actual directory read

#### Scenario: A detached refresh fails after form or source disposal
- **WHEN** directory refresh completes after the form closes
- **THEN** its feedback and retry SHALL remain bound to the captured live source and SHALL NOT affect a different server or workspace
- **AND** disposing the source provider root SHALL invalidate the continuation even if its memo retains the former SDK/sync value
- **AND** a write that never committed SHALL NOT be described as saved merely because a later directory refresh failed

### Requirement: A visible workbench never occludes an active composer

The measured desktop row MUST use the existing compact chat/review width floors when both panes fit. Opening context/files MUST leave active model and send controls pointer-reachable, preserve the draft and stored width preference, and avoid horizontal overflow. Below those floors an existing real Session MAY use the existing full-workbench presentation, with underlying chat inert and hidden to accessibility until return.

#### Scenario: Context beside a desktop conversation
- GIVEN a measured 1280 CSS px window and the approved sidebar
- WHEN the user opens context usage
- THEN the model and send controls remain unobscured and retain the same draft.

#### Scenario: Compact full workbench
- GIVEN a real Session and insufficient room for both compact panes
- WHEN the workbench opens
- THEN it uses the existing full view and provides Back to conversation. Returning retains the draft, does not overwrite the stored panel width, and restores input focus only while the captured Session generation and server SDK remain current.

#### Scenario: Unsent compatibility draft
- GIVEN a session route with a draftId and no Session ID
- WHEN the window is compact and the file-tree preference is open
- THEN automatic full-workbench layout MUST NOT hide the unsent composer behind an absent Session side panel.
### Requirement: Skill evaluation and canary admission preserve the regression gate
Existing Skill evaluation and human-reviewed canary actions MUST reject reported new failures. Historical evaluation records MUST remain unchanged; a stored passed flag alone SHALL NOT authorize a canary when the stored report fails integrity or the applicable regression and safety requirements.

#### Scenario: An evaluation reports a new failure without a success-rate decrease
- **WHEN** a supported evaluation reports a candidate new failure, including a case where both baseline and candidate fail or the candidate reports success
- **THEN** evaluation SHALL fail the regression check and SHALL NOT authorize a canary merely because the aggregate success rate did not decrease

#### Scenario: A historical passed evaluation no longer satisfies the gate
- **WHEN** a trusted human requests canary admission using a persisted report with a new failure or a mismatched canonical report digest
- **THEN** the existing store SHALL reject admission before any candidate transition or canary write, preserving the original evaluation and the candidate revision
- **AND** an intact passed report with no regressions or new safety failures SHALL retain the existing reviewed canary path

### Requirement: Terminal Session Memory proposals retain genuine source evidence
Existing automatic Memory extraction SHALL run after the durable terminal transition and committed Session history validation. A successful bounded ordinary workspace text write MAY contribute independently verified file provenance to a proposed candidate. It SHALL NOT activate Memory, assert semantic truth of a remembered sentence, or invent comparative evaluation metrics.

#### Scenario: A completed owned write supports a review-only candidate
- **WHEN** a real completed Session has an admitted remember request and a successful settled write Action in its exact owned workspace
- **THEN** the producer SHALL match the committed tool input to Action.inputDigest, validate the sealed successful Observation, and independently reread the bounded file through existing path guards
- **AND** matching bytes SHALL create canonical Run/Action/Observation Evidence and one proposed Memory candidate in the same transaction, with an explicit provenance-only claim
- **AND** the existing human review, correction and activation actions SHALL remain required

#### Scenario: Unsupported or changed outcomes preserve ordinary extraction
- **WHEN** no independent file evidence is available, the Run failed, the file changed, the target is external, or the source bindings do not match
- **THEN** no verified file provenance SHALL be attached
- **AND** ordinary same-source remember extraction SHALL remain available as an unverified proposed candidate, while foreign owner, tenant and location bindings SHALL be rejected

#### Scenario: Repeated settlement preserves existing review and edits
- **WHEN** settlement is observed again for the same owner, workspace, Run, admitted request and candidate content
- **THEN** it SHALL reuse the candidate without duplicate Evidence or proposal audit writes, preserving human review and revisions
- **AND** a later real Run with the same text SHALL retain its distinct request source
- **AND** issued provenance SHALL be immutable at runtime, with stable tenant/user identity rather than login-session metadata determining replay identity

### Requirement: Runtime diagnostics respect the current authenticated owner
The existing private local profile SHALL retain its profile-wide process diagnostics. Authenticated multi-user reads SHALL derive visibility from the trusted tenant/user principal and canonical owned Sessions, including in-memory telemetry that database RLS cannot filter. Existing role gates and owned recovery actions SHALL remain available.

#### Scenario: Another principal has newer records or corrupt history
- **WHEN** an authenticated user reads a runtime snapshot or verifies their audit records
- **THEN** foreign, unknown-owner and foreign corrupt records SHALL be excluded before pagination or aggregate reconstruction, without starving the user's own records
- **AND** an audit record with declared ownership SHALL require the complete matching tenant/user pair; undeclared ownership MAY use a canonical owned Session, never actor text or a guessed resource identity
- **AND** another principal's record count, integrity result, head hash or dropped-record count SHALL NOT be exposed as the current user's result

#### Scenario: Principal-scoped integrity has a different scope from the profile chain
- **WHEN** only the current user's original audit fragments are visible
- **THEN** verification SHALL check the actual visible record digests without fabricating a re-chained principal history
- **AND** an optional typed verification scope and the rendered label SHALL distinguish those record checks from full-profile chain continuity; unavailable retention counts SHALL be labeled unavailable
- **AND** the existing private local verifier SHALL retain its genuine valid/invalid chain behavior and original legacy response shape

### Requirement: Directory search keeps displayed rows selectable

- Windows directory rows SHALL match both native backslash and canonical forward-slash input, including existing trailing-separator forms, without changing their selection keys or filesystem requests.
- POSIX aliases, recent-project names and source ownership SHALL remain intact. Search aliases SHALL NOT create directories or authorize additional filesystem access.

### Requirement: Output copy actions remain reachable above their content

- The existing output Copy button SHALL receive ordinary pointer and keyboard activation while visible, including when long output scrolls beneath it.
- Copy SHALL retain the full original output while the displayed preview is bounded; content SHALL NOT intercept the button's pointer hit.

### Requirement: MCP connection details include the existing complete configuration form

The existing MCP integrations management surface SHALL account for the assigned service name, connection configuration, authorization state, resource catalog, tool description and source Session reference. A status summary SHALL NOT substitute for the complete connection form.

#### Scenario: Edit a configured local or remote MCP connection
- The form SHALL load the effective configuration for the captured server and workspace through the existing configuration owner.
- Local command arguments, working directory, read-only paths, environment, startup enablement and both timeout phases SHALL remain configurable. Remote URL, headers, OAuth disabled/automatic/configured state, client ID/secret, scopes, callback port/redirect URI, enablement and both timeout phases SHALL remain configurable.
- Secret inputs SHALL be masked by default and unchanged values SHALL survive edits to other fields. Existing inherited fields and unrelated connections SHALL not be erased. Saving SHALL use the existing configuration writer; it SHALL NOT introduce a second configuration store or automatically call a tool.
- Invalid input and failed saves SHALL retain the user's entered fields and display a useful error. Retired source/item callbacks and delayed read/save completions SHALL NOT replace a new form's state or act on a new source.
- A successful new connection save SHALL retain its visible acknowledgement and invoke the current completion callback. Reconciliation that re-emits an unchanged selection SHALL NOT count as a new edit; a real subsequent edit SHALL clear the acknowledgement and remain saveable.

#### Scenario: Inspect one current tool definition
- Selecting a tool SHALL allow reading its actual advertised description and input/output contract through a typed, server/capability/generation-bound read.
- Inspection SHALL read the existing cached definition and SHALL NOT execute the tool, request a new permission, add a model call or restart a connection. Removed, disconnected, changed-generation and configuration-drifted capabilities SHALL report unavailable rather than return stale cached data.
- The definition SHALL render as escaped readable data. Parameter schemas SHALL not be inferred from capability patterns, and connection credentials or transport objects SHALL not be added to a tool description.

#### Scenario: Keep a complete form usable in a narrow view
- The existing management detail layout SHALL retain all configured fields and action controls at narrow widths. Collapsing and reopening the same form SHALL retain entered values; source changes SHALL keep their existing isolation rules.
- Connection/authentication controls, resource selection and source Session navigation SHALL retain their current owners and permission checks. Full-form acceptance SHALL require real rendered edit/error/save/readback and narrow-layout evidence.

#### Scenario: Distinguish catalog objects sharing a display name
- Resource, resource-template, tool, prompt and access-capability rows SHALL display their existing object type and service name, including when a resource and its access capability share the same display name.
- Presentation SHALL preserve each distinct existing row, identity and details action. It SHALL NOT deduplicate by a display name or guess identity from a sanitized resource reference.
- Resource-template details SHALL show the actual advertised URI template, description and MIME type when present. Access-capability details SHALL retain ID, generation and permission patterns and show their actual safe resource reference when present.
- Reading or selecting these catalog records SHALL NOT call a tool, submit a prompt or mutate configuration. Unchanged connection-form checks need not be replayed solely for these presentation changes.

# File reads retain their live workspace owner

File-content and directory-listing completions SHALL belong to the live provider
and request generation that initiated them. Resetting a source or disposing its
workspace SHALL retire its pending reads. Returning to the same directory SHALL
not reactivate a retired response. Retired reads SHALL NOT update current content,
directory nodes, shared cache accounting, error notices or a newer in-flight entry.
Current reads SHALL retain ordinary deduplication, visible errors and explicit retry.

#### Scenario: A closed workspace finishes a file request

- GIVEN a pending file-content or directory-listing request
- WHEN the owning workspace is closed or replaced before its response arrives
- THEN neither a successful body nor an error may update the retired view or show a new error notice
- AND a newer read remains registered and can complete normally

#### Scenario: A source resets and returns to the same directory

- GIVEN an old request from source A before a reset
- WHEN the user visits B and returns to A with a new read
- THEN the original response cannot replace the new content or clear its pending entry
- AND a current-source failure still appears and can be retried

# Shared workspace state survives its first consumer

#### Scenario: One of several views closes

- GIVEN two live consumers share one directory SDK or sync context
- WHEN the first consumer closes
- THEN the remaining consumer SHALL retain reactive updates and event subscriptions
- AND the shared context SHALL release its resources once after its last reference or parent server owner retires
- AND a retired parent SHALL reject new acquisitions

#### Scenario: An initial directory read has a transient transport error

- The existing read-only bootstrap retry classifier SHALL bound retries for a live directory owner.
- A successful retry SHALL allow the ordinary source validation to mark that directory ready.
- Forbidden responses, cancellation, timeout and retired owners SHALL NOT gain mutation replay or permission bypasses.

# Native terminal process identity follows readiness

#### Scenario: Windows ConPTY finishes asynchronous initialization

- GIVEN a terminal has an initial unknown PID of zero while its native data pipe starts
- WHEN the native process reports its positive PID
- THEN the existing adapter, session get/list and JSON response SHALL expose that live PID
- AND the existing PTY identifier, native process, output buffer and subscriptions SHALL remain unchanged
- AND reconnect verification SHALL wait for this actual readiness and compare the same process before and after reconnect

# Message history survives a network interruption

#### Scenario: A message page GET has a wrapped transient transport failure

- The live page/session SHALL retry the same read at most three times.
- A successful read SHALL preserve the original cursor and message reconciliation.
- Forbidden responses, cancellation and timeouts SHALL NOT gain retries.
- A retired page/session SHALL NOT issue another read or publish a late response.

#### Scenario: Automatic history pagination remains unavailable

- Existing messages and the history cursor SHALL remain available.
- The page SHALL own the rejection, restore its reading anchor and offer explicit retry.
- Automatic refill SHALL stop for that source until an explicit retry succeeds.
- A stale owner SHALL NOT show an error or operate on the replacement session.

# Interrupted permission prompts follow the server

#### Scenario: An interrupted waiter disappears without a human decision

- The App SHALL read the captured Session's actual pending permission list.
- Only captured, untouched request IDs absent from that response SHALL be retired.
- Existing valid requests and newer Asked/Replied events SHALL remain authoritative.
- The composer draft SHALL remain available once obsolete prompts are retired.
- The App SHALL NOT fabricate a rejection, grant, saved rule or new durable action.

#### Scenario: A permission reconciliation read fails or its source changes

- Read failure SHALL preserve existing asks and offer a current-owner retry.
- Forbidden or malformed responses SHALL NOT be interpreted as an empty list.
- Move/delete, page retirement and disposal SHALL fence old results and retry actions.
- A completed run without cached asks SHALL NOT add polling.

# Saved provider configuration read recovery

#### Scenario: A saved provider encounters a transient network change

- The App SHALL retry only the current capability and selected-detail GETs, at most three attempts using the existing strict transient-transport policy.
- A successful saved-provider read SHALL restore its visible selection without repeating configuration, credential or connection-test writes.
- A persistent failure SHALL stop automatic attempts and retain explicit current-source Retry rather than masquerading as an empty or read-only configuration.
- Disposal, source or selection changes SHALL retire pending retries and prevent stale publication.
- Typed refusal, cancellation, timeout and source/provider mismatch SHALL retain their existing behavior.

# Recovered Agent catalogs update the directory projection

#### Scenario: The catalog recovers after the initial directory bootstrap fails

- The active directory Agent list SHALL follow successful data from its current scoped query, even after the initial bootstrap completion copy would have failed.
- Bootstrap and composer Windows path aliases SHALL share one query key while preserving the original request location and server scope.
- Existing nonempty drafts, model choices, real directory/path checks and server health gates SHALL remain intact; Send SHALL require an actually available Agent.
- Successful removal SHALL make an explicitly selected Agent unavailable without substituting a fallback; background read failure SHALL retain the last successful list.
- Passive directory metadata SHALL NOT fetch Agents. Existing active query callers SHALL deduplicate reads.
- Parent server disposal SHALL release every owned directory query root, including pinned directories; retired managers SHALL NOT create new observers or publish into replacements.

# Artifact inspector respects narrow available width

#### Scenario: A genuine tool-output receipt is inspected in a 390 CSS pixel window

- Long artifact identifiers, digests and verified text SHALL wrap within the existing inspector without expanding its grid track beyond available width.
- Preview, download and close-preview controls SHALL remain visible and reachable when authenticated content is displayed.
- The correction SHALL preserve the full original bytes, digest checks, authorization, source fences, cancellation, download behavior and original Session draft.
- A real Session tool execution SHALL produce the receipt used for actual UI verification; seeded output or a substituted content response SHALL NOT replace the producer.
- Existing successful wide-window and foreign-owner cases SHALL be retained with exact source qualification; only the missing narrow interaction SHALL be rerun.


# Queue submission waits for durable acknowledgement

#### Scenario: A queued edit is rejected, retried or acknowledged after another edit

- A queued admission or edit SHALL preserve its captured text, attachments, context and edit identity until the existing public mutation acknowledges success. Failure SHALL keep the draft available for an explicit retry of the original entry and FIFO revision.
- An in-flight submission for the same PromptState SHALL NOT admit duplicate messages through repeated submit gestures.
- A successful acknowledgement SHALL consume only the unchanged captured draft; newer text, model and context SHALL survive. A newer queue edit target SHALL NOT be cleared by an older acknowledgement.
- Mutation and subsequent query invalidation SHALL use their captured server, workspace and Session. If permission validation finishes after the originating view retires, a reactive callback SHALL NOT dispatch into the replacement view.
- Existing system, format, scheduled tasks, model selection, attachment and queue runner/authorization behavior SHALL remain unchanged. No automatic replay of failed write requests or silent model substitution is introduced.

#### Scenario: An existing queued message is edited while ordinary follow-ups use steer mode

- Loading an existing queue entry into the composer SHALL save subsequent submission back to that original entry and FIFO revision, including if the current Run becomes idle before submission.
- The ordinary follow-up preference SHALL NOT convert this explicit edit into removal of the original entry followed by a new immediate message.
- Existing child-Session restrictions and pending permission/question input blocking SHALL remain in effect. Ordinary unedited follow-ups retain their current behavior.

#### Scenario: Permissions are pending while the user changes the queue editor

- The originating queue intent, source, entry identity, FIFO revision and retained prompt fields SHALL be captured before permission validation can yield.
- The same PromptState SHALL reserve that submission before validation starts, so another submit cannot later become an unintended ordinary steer after the first queue save finishes.
- Loading another queue entry SHALL NOT change the pending submission target or allow its original text to overwrite the newly selected entry.
- Every explicit queue edit SHALL have its own edit generation. Reopening the same entry with the same FIFO sequence while a save is pending SHALL preserve the new edit generation after the earlier acknowledgement.
- Existing newer-draft ownership, source retirement, explicit retry and ordinary follow-up behavior SHALL remain in effect.

#### Scenario: A queued model preset is not selected in the current composer

- When editing a queued message for the same model without a conflicting composer preset or an explicit Default selection, a supported preset from the durable entry SHALL be restored in this Session. The projection cache and previous messages SHALL NOT invent a preset for an entry saved with Default.
- If the original preset has become unavailable, text and attachment editing SHALL still work. Saving without a replacement SHALL preserve the original preset. Choosing an available preset or explicitly using Default for that edit SHALL allow replacement without changing defaults for other Sessions.
- An unavailable-preset action SHALL apply only to its source, entry, FIFO revision and edit generation. A choice made after a submission has been captured SHALL NOT change that submission.
- While a Save is pending, its composer SHALL disable this action. When saving explicit Default for a retired preset, the server SHALL reject a changed original model route without modifying the queued entry.
- Promotion of an older queue entry SHALL NOT replace the model of an already-bound unsent draft with text, attachments or context. A Session without an active bound draft SHALL retain its existing last-message restoration behavior.

# Window close waits for owned persistence

#### Scenario: A draft is changed and its main window is closed immediately

- Native window destruction SHALL wait for all admitted renderer storage mutations and preload writes, including staged transfers and native settlement, through their existing operation promises.
- Preparation SHALL keep its owning window alive and prevent additional user edits until it finishes or is cancelled. A failed write, missing acknowledgement or timeout SHALL retain the window and restore its prior input state.
- A genuine preparation failure MAY offer a native choice to close that specific window without waiting, with the possible loss stated and keeping it open selected by default. Only this explicit choice may skip the saving barrier; normal document unload protection and other windows SHALL remain effective. This SHALL NOT claim a successful save or replay a failed write.
- Completion SHALL observe original failures even when a scheduling tail catches a rejection. An unrelated successful write SHALL NOT turn a failed draft write into successful persistence. A later successful explicit write or namespace clear may supersede the relevant old failure; closing SHALL NOT replay failed writes automatically.
- Acknowledgements SHALL belong to the registered application window's current main frame and current close request generation. Other windows, child frames and stale requests SHALL NOT release it.
- Existing validation, staging budgets, ordered chunks, native execution, store coordination and source/capability checks SHALL remain on the write path; direct or synchronous persistence shortcuts SHALL NOT replace it.

#### Scenario: Explicit Quit includes multiple application windows

- Every application window SHALL finish persistence preparation before any is closed. A preparation failure SHALL retain all windows and SHALL NOT start backend shutdown.
- Normal document unload cancellation SHALL remain effective. Quit SHALL stop owned backends only after its main windows close, so a cancelled close retains a usable application.
- Successful last-window Close and explicit Quit SHALL release owned services and ports. Shared or external services SHALL NOT be stopped.
- Actual ordinary-use validation SHALL retain the immediate-typing/close sequence without inserting an artificial delay, persistence read or flush before the native close request.

#### Scenario: Reopening a saved Session encounters a transient metadata transport failure

- Session metadata GET SHALL use at most three attempts for recognized transient transport failures, with bounded backoff, while its captured source and Session generation remain current.
- An authorization, cancellation, timeout, missing-Session or other authoritative business error SHALL NOT gain automatic retries. Mutations SHALL NOT be replayed by this recovery.
- Concurrent readers SHALL continue sharing the same in-flight resolution; a retired source SHALL NOT dispatch another retry or republish old metadata.
- The existing completion behavior of an already-started obsolete metadata read SHALL remain: obsolete loads may settle without publishing into the replacement generation. Message-history lifetime fences SHALL remain unchanged.
