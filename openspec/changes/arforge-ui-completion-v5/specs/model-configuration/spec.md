# Model setup, presets and reasoning controls

## Requirement: Restore the admitted model and reasoning choice from history

Canonical user-turn routing SHALL retain its configured model identity, provider,
agent and explicit reasoning variant during history hydration. Assistant wire
aliases and fallback execution routes SHALL remain assistant execution facts and
SHALL NOT overwrite that user choice. When a legacy turn lacks routing fields,
the existing inference from switch events and assistant history remains available.
The model and agent fields SHALL be resolved independently for partial routes.

#### Scenario: Reopen a historical relay-model session

- GIVEN a user turn admitted with a configured model ID and reasoning variant
- AND its assistant response uses a different API wire alias or fallback model
- WHEN the session is opened through history or original-workspace navigation
- THEN the selector restores the admitted configured model and reasoning variant
- AND assistant details retain the actual execution model
- AND a later legacy turn without an explicit route still uses legacy inference
- AND persisted user choices and drafts are not replaced by history restoration

### Requirement: Canonical runtime insight values remain usable after client generation

The App SHALL decode snapshot and audit-verification JSON responses with the owning Protocol schemas before displaying runtime information. Generated transport declarations SHALL remain canonical. Request location, authentication, cancellation, audit scope and original hashes SHALL be preserved. An invalid successful payload SHALL fail without fabricating an empty success or including response data in its parse error; HTTP and transport failures SHALL retain their existing semantics.

#### Scenario: A saved model inherits the provider adapter

- GIVEN a saved model with a verified supported wire ID whose effective API inherits its provider adapter
- WHEN the catalog generates its supported reasoning choices
- THEN generation SHALL resolve the same effective API as the catalog and runtime
- AND explicit model API overrides, configured variants, preset variants and saved defaults SHALL remain authoritative
- AND a display name alone SHALL NOT supply capability evidence.

## ADDED Requirements

### Requirement: Configured connections and model manufacturers remain distinct

The chooser SHALL organize actual configured connections in a provider column and the selected connection's actual available models in an adjacent column. Preset discovery SHALL group model metadata by its originating manufacturer without renaming, merging or replacing user connection IDs. Choosing a provider for browsing SHALL NOT silently change the active model.

#### Scenario: A relay serves models from several manufacturers

- GIVEN a configured relay containing DeepSeek and Claude model wire IDs
- WHEN the user browses that connection
- THEN both remain under the real relay connection, with manufacturer metadata used only for presets/capabilities
- AND its URL, credentials and original wire IDs remain unchanged.

### Requirement: Reasoning strength follows supported model variants

The chooser SHALL present the selected model's supported reasoning variants as accessible discrete choices. Labels MAY reference Zcode's bottom strength control; the values MUST remain the runtime's supported variants, including distinct default/off/automatic semantics where supported. Keyboard and touch users SHALL be able to operate the same choices. A switch SHALL retain current session/draft/source ownership and the already-running response's captured configuration.

#### Scenario: The user operates the completed reasoning-strength footer

- GIVEN a selected model with explicit executable reasoning variants
- WHEN the user opens its model chooser
- THEN the bottom strength control SHALL show the approved neural pulse dial with discrete supported stops, a clear current value and the existing configurable shortcut hint in warm-white and graphite themes
- AND pointer, touch and native keyboard range operations SHALL select an actual supported variant that persists and reaches the next real model request
- AND reset/default, off and automatic SHALL remain distinguishable; a decorative stop SHALL NOT invent an extra provider-supported tier
- AND provider/model/source changes or disposal during a drag or save SHALL invalidate the old preview and completion without overwriting the new selection or in-flight response
- AND a stale pointer release or cancellation SHALL affect only its original gesture, even if a newer keyboard preview has started

#### Scenario: The user previews strength on the neural pulse dial

- GIVEN the selected model exposes at least two compatible, ordered strength options
- WHEN the user clicks a stop or drags around the dial
- THEN the dial SHALL show only those options and morph the network as the preview changes
- AND reaching the maximum supported strength SHALL show the full network and, with motion enabled, the expansion wave
- AND the user's pause control and system reduced-motion setting SHALL stop animation while retaining the available choices and their selected state
- AND hiding or closing the chooser SHALL stop its animation work

#### Scenario: The selected model has no verified reasoning choices

- WHEN a selected model does not expose executable reasoning metadata
- THEN the footer SHALL explain its unavailable state and retain the existing model-management action instead of silently disappearing or exposing a working-looking unsupported slider
- AND no reasoning parameter SHALL be inferred solely from its display name, relay connection name or a general reasoning capability flag

### Requirement: Model presets reuse the existing catalog

Manufacturer-classified presets SHALL derive from Arforge's existing bundled/cached catalog, supplemented by verified official metadata for current mainstream models. Metadata SHALL retain provenance and verification time and remain available offline through the existing fallback. Unknown capability or limit values SHALL remain unknown. A template SHALL NOT represent account/relay availability as verified merely because an originating manufacturer offers the model.

Every automatic manufacturer configuration field SHALL be supported by that manufacturer's official documentation, with source URL and verification time. Cached metadata without per-field official verification SHALL NOT fill an otherwise unknown preset value or become a highest official default. Source coverage SHALL respect model version, region, protocol and entitlement. Existing general catalog rows and manual configurations SHALL remain available independently of this curated official automatic-preset policy.

#### Scenario: A cached limit has no official documentation support

- GIVEN a bundled row with an output limit and an official page proving only the model's identity
- WHEN the automatic configuration preset is projected
- THEN that output field remains unknown until official limit evidence is available
- AND the identity page is not treated as proof of the cached numeric value.

### Requirement: Matching prefills editable parameters without replacing manual configuration

Entering a recognized model ID/name SHALL reveal its context-window and maximum-output parameters. Exact IDs, explicit aliases, official display names and unambiguous recognized namespace forms MAY auto-match. Ambiguous or unknown names SHALL allow explicit preset selection/manual setup. Automatic updates SHALL affect only empty or still-auto-owned fields; manual field edits, endpoint, secret, and requested wire ID SHALL remain authoritative.

#### Scenario: A user edits a prefilled output limit

- GIVEN a matched preset filled the context and maximum output fields
- WHEN the user edits maximum output, then changes the model name
- THEN the manual output value is retained and identified as an override
- AND other still-auto-owned fields may follow the new unambiguous match.

#### Scenario: A third-party relay uses a custom model alias

- GIVEN an arbitrary relay wire name with no unambiguous catalog match
- WHEN the user chooses an originating model preset
- THEN supported metadata can populate editable fields while the relay wire name and URL remain unchanged
- AND no arbitrary default capacity or unsupported reasoning parameter is invented.

### Requirement: Saved metadata reaches the real runtime

Context/output limits and supported capabilities/variants SHALL round-trip through supported typed configuration into the catalog, model selection, context usage and actual request configuration. The frontend SHALL NOT display a saved capacity that is silently discarded by the backend. Tests SHALL cover manual overrides, ambiguous names, different providers, persistence and stale-source/draft/ABA callbacks. Owned local services MAY verify request semantics; paid vendor calls and user secrets are not required.

### Requirement: Unspecified configuration uses the highest verified supported values

For a newly configured, unambiguously recognized model, unspecified context and maximum-output limits SHALL use its highest verified supported preset values. If verified executable reasoning tiers exist and no default was explicitly chosen, the default SHALL use the highest verified supported tier. This SHALL NOT change permission modes or orchestration controls. Automatic values SHALL be visible, editable and persisted into the real runtime. Conditional limits and effective runtime budgets SHALL remain enforced.

#### Scenario: Only the model name is entered

- GIVEN a recognized model with verified limits and protocol-compatible executable reasoning tiers
- WHEN the user enters its name and saves without customizing those parameters
- THEN the highest verified supported context/output values and reasoning tier are stored and used
- AND the connection endpoint and requested wire model ID remain unchanged.

#### Scenario: A user deliberately lowers one parameter or disables thinking

- GIVEN automatic maximum values and a verified highest reasoning tier
- WHEN the user supplies a smaller output limit or explicitly selects off, default or automatic
- THEN those explicit choices remain authoritative
- AND unrelated unspecified fields may retain their verified maximum defaults.

#### Scenario: The model is unknown or an existing configuration is edited

- GIVEN an unknown/ambiguous model or a saved model with explicit existing limits/defaults
- WHEN its editor opens or its name is entered
- THEN no unsupported maximum or reasoning tier is guessed
- AND existing explicit values/defaults are preserved until the user changes them.

### Requirement: Provider settings form a complete workspace

Settings SHALL present configured providers beside the selected provider's editable connection details and model list. Base URL, a supported API format, masked credential state, provider availability, and per-model creation, editing, availability and deletion SHALL remain accessible by mouse, keyboard and touch. Existing advanced configuration and other settings pages SHALL remain available. Credential omission during an edit SHALL preserve the existing credential and authentication requirement. Unsupported or read-only sources SHALL show their limitation without exposing an apparently functional write action.

#### Scenario: An existing relay model is edited

- GIVEN a saved relay with credentials, a custom wire ID, transport overrides and model pricing/profile metadata
- WHEN the user edits its display name or context/output limits and saves without entering a new secret
- THEN the change persists through the typed API and runtime
- AND the endpoint, wire identity, existing secret/authentication and unrelated advanced metadata remain unchanged.

### Requirement: API format is an effective runtime setting

The API-format selector SHALL offer only implemented protocol adapters. A confirmed change SHALL persist and determine the actual request path/body. Omission SHALL preserve an existing adapter and MUST NOT silently reset advanced overrides or credentials. Unsupported existing adapters SHALL remain representable without an accidental conversion.

### Requirement: Each configured model can be explicitly tested

A model row SHALL expose a user-invoked connection test against that saved model using its real runtime route and stored credential. The test SHALL use a fixed minimal generation request with bounded output and timeout, report a sanitized result and latency, and support cancellation and source/revision ownership. It SHALL NOT mutate the selected chat model, send chat messages, create history, reveal secrets or run automatically. A successful HTTP connection or model-list response alone SHALL NOT establish model-generation success.

#### Scenario: The service responds successfully but the model cannot generate

- GIVEN a reachable API endpoint returning an authentication error, a missing-model error, or malformed generation content
- WHEN the user tests that model
- THEN the UI reports a clear sanitized failure and permits retry
- AND it does not mark the model as successfully configured or expose credentials in diagnostics.

#### Scenario: The source changes while a test is pending

- GIVEN a pending test captured for one provider revision and source
- WHEN the user changes provider, source or workspace, or closes the owning editor
- THEN the old operation is cancelled or its completion is discarded
- AND its result cannot appear on the new provider/model.
