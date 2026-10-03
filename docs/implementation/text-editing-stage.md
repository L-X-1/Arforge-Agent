# Workbench implementation: guarded text editing

Date: 2026-09-14

This increment follows the history rail and read-only Markdown Source / Preview / Split increment. It does not mark the complete video workbench plan as delivered.

## Scope

- Read-only remains the default. Edit file loads CodeMirror 6 on demand.
- Basic editor setup supplies line numbers, undo/redo and local search. Markdown has syntax support; other text starts with plain-text editing.
- Explicit Save or Ctrl/Cmd+S calls the location-scoped text API. There is no autosave to workspace files.
- GET /api/fs/text returns text and an exact-byte SHA-256 base version. PUT requires that base version.
- Core owns all reads and mutations. LocationMutation enforces the workspace boundary; FileMutation.writeIfUnchanged provides guarded replacement and conflict reporting.
- Existing UTF-8 files only, at most 500,000 text characters and 2,000,000 source bytes. BOM and uniform LF/CRLF are preserved. Binary, invalid encoding, mixed/CR-only newlines, symlinks, directory targets and external targets are rejected.
- Disk conflicts keep the draft, disable save and require explicit discard before reload. There is no force-overwrite fallback.
- Responses to in-flight saves update the saved base without discarding newer edits.
- Draft recovery is keyed by server scope, workspace directory and path. Dedicated local storage keys are outside the ordinary cache-eviction namespace.
- Storage failures retain in-memory edits and surface a warning. Other-window draft changes are not silently overwritten. This storage comparison is best-effort, not a cross-window transaction.
- Back to preview offers Save and close / Discard / Cancel. Closing or replacing the outer file tab preserves the draft; reopening Edit file restores it. A full tab-level dirty indicator and navigation interception remain follow-up work.

## Validation entry points

Run the targeted core text-document tests, app text-document API/draft tests, existing preview/history/resize unit tests, and affected package typechecks before browser acceptance.

Browser acceptance adds text-editor.spec.ts beside file-preview.spec.ts and history-rail.spec.ts. Use the existing isolated production Playwright runner with the streaming benchmark; do not restart the user's running application or server.

The browser fixtures mock the HTTP server; real temporary-file read/write and conflict checks are covered separately by the core tests. Passing these tests alone does not certify a packaged Electron release or every server deployment.

## Still outside this increment

- HTML sandboxed live preview and element picking.
- Office/PDF rich rendering and browser panels.
- Multi-root resource identity, shared workspace preview tabs and full dirty-tab close interception.
- Three-way merge, forced overwrite, creating new files, arbitrary encodings and format conversion.
- Autosave, remote collaborative editing, crash-proof draft storage and a complete syntax-language registry.
