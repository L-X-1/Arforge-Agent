# Static HTML element selection and source locations

## Increment

The HTML preview gains an explicit Select elements mode. Clicking a rendered static element, using the element list, or pressing Up/Down inside the iframe selects an indexed source element. Locate source shows the current file path, one-based line/UTF-16 column, and a read-only excerpt. Escape returns to ordinary safe preview.

This remains source inspection, not AI editing or a saved DOM modification. It does not create change proposals, write a file, run document scripts, or map framework-generated DOM back to JSX/Vue components. These are separate increments.

## Editor navigation and AI references

- Jump to editor is available when the user has explicitly opened Edit file and enabled live preview. It finds one visible CodeMirror instance inside the current file tab, compares its complete buffer with the source snapshot (allowing CodeMirror newline normalization), then selects and scrolls the mapped UTF-16 range. It does not open another editor, replace a draft, or save anything. Changed/ambiguous buffers are refused.
- Reference in AI adds a removable context card to the current prompt session without changing prompt text or sending a request. A typed snapshot captures the exact source digest, workspace/server scope, range, source kind, and up to 8,000 excerpt characters. Editor snapshots may contain unsaved changes; file-preview snapshots are not promises of current disk contents.
- Sending a normal message serializes the snapshot as escaped, explicitly quoted source data. It does not generate a file-read attachment or scan source `@mentions` for other files. Path, directory, server scope, range and size are validated again at serialization. Later source edits do not silently update a captured reference.
- Snapshots survive the existing prompt-session persistence and send-failure restoration path. They are not flattened into ordinary file comments when navigating prompt history. Slash commands and direct Shell reject these references rather than silently dropping them. Goal text, when explicitly requested by the user, includes the quoted snapshot instead of an unversioned file label.
- There is no claim that the server enforces snapshot hashes as write permissions. Before any future AI edit, the normal read/version-check/proposal pipeline still has to validate the current file. This increment does not implement AI source rewriting.

## Source identity

- `parse5` is pinned to 7.3.0 as a direct app dependency. Its source-location information supplies exact UTF-16 offsets into the original buffer, including entities and line endings.
- Implicit parser-created elements have no source range and are excluded. Ambiguous reconstructed ranges are not advertised as unique source targets.
- Parsing is bounded to 500,000 characters; indexes to 1,500 candidates; displayed excerpts to 12,000 characters. Limits are visible rather than silently pretending full coverage.
- Every selection frame has a random identity and SHA-256 digest of the exact source buffer. File, draft, server, location, or resource authorization changes clear the selection and replace its frame identity.
- Source positions come only from the host's map. The iframe reports an element ID, never an authoritative filename, offset, instruction, or write request.

## Rendering and trust

The existing HTML preview builder remains the owner of HTML sanitization and local resource restrictions. A random temporary title marker transports source identities through sanitization; surviving identities receive application-owned data attributes. Original titles are restored only as text attributes. Markers are never saved to user files.

Selection mode replaces the ordinary empty-sandbox iframe with `sandbox="allow-scripts"`, without `allow-same-origin`, forms, popups, top navigation, or application IPC. Its CSP permits only one application-generated nonce script; inline event handlers remain denied. The original document's scripts still pass through the existing removal policy.

The trusted bridge captures clicks, draws a frame-local outline, handles keyboard movement, and reports selection/lifecycle messages. Both directions validate window identity, frame identity, and revision. The host additionally requires the opaque `null` origin and a known mapped ID. Opaque-origin messaging needs a wildcard target origin, so source-window and identity checks are mandatory, not optional substitutes for a real origin policy.

Local CSS/raster authorization is reused from the containing preview. No new listener, grant scope, filesystem operation, cookie forwarding, or remote request capability is introduced. Grant expiry or disable rebuilds the selection frame without those resources.

## Acceptance scenarios

1. Select one of two identical headings and locate its distinct original line and exact source text.
2. Use Chinese text, entities, quoted angle brackets, multiline elements, and CRLF without drifting the source range.
3. Verify that source scripts and event handlers do not execute, the parent cannot read the iframe DOM, and forged or stale messages do not select an element.
4. Select with the keyboard/list and leave with Escape. Buttons and focus indicators remain accessible on narrow panes.
5. Refresh or edit the source and confirm the old selection is cleared before the new frame becomes ready.
6. Enable local resources and confirm the selected preview still uses the scoped stylesheet without widening its CSP.
7. Confirm that selecting and locating never issue a text-document write or save a draft.

The new index uses parser positions as documented by [parse5](https://parse5.js.org/interfaces/parse5.ParserOptions.html). Frame permissions follow the [iframe sandbox model](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe); bridge validation follows the [postMessage security guidance](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage).

## Guarded AI source editing increment

A validated, complete file-preview reference now includes guidance for the existing
`edit` tool's optional `htmlSelection` precondition. The guard binds the active
workspace, file, full BOM-free UTF-8 source SHA-256, and exact UTF-16 source range.
The existing Action Gateway handles the proposal and human-authority approval;
this increment does not introduce a separate proposal store or write endpoint.

The guarded edit requires the full selected element as `oldString`, rejects
`replaceAll`, stale source, mismatched paths/ranges, editor-buffer references and
truncated-sized selections, and limits both selected and replacement text to
8,000 UTF-16 units. The complete document remains limited to 500,000 units.
Existing UTF-8 BOM/CRLF behavior and `FileMutation` conditional commit protection
remain in force. A stale selection must be recaptured, not retried without a guard.
Editor snapshots remain useful for discussion; save and reopen the read-only file
preview before requesting this source-edit path.

After a successful edit settlement, the tool publishes the existing location-scoped
`file.watcher.updated` change event. Open file previews can reload through their
existing invalidation path even without the native watcher. A failed notification
adds a refresh warning to the successful result; it does not claim the committed
write failed or invite a duplicate edit. Notifications are not durable refresh
receipts: reconnect/reload/manual Refresh preview remains necessary if an event is
missed. This is not a guarantee that every open editor buffer reloads automatically.

The guard is a conditional-write contract, not a signed UI capability. Ordinary
`edit`, `write`, `apply_patch`, shell and other existing tools keep their own
permission rules; this increment does not globally restrict every model action to
the selected element. Guidance tells the model not to bypass the guard, but that
instruction is not itself a cross-tool enforcement boundary.

Focused coverage includes saved-source matching, exact-range replacement, stale
and concurrent source protection, permission denial, scoped post-settlement
notifications, and a mocked browser refresh/reopen scenario. These test definitions
do not establish that a live-model or packaged-desktop end-to-end run has passed.
Document scripts remain disabled in the preview.
