# Session-scoped embedded browser, manual first increment

The existing session side panel offers Files/Changes and Browser modes on a
capable desktop runtime. Web-only and older-preload runtimes retain the existing
file panel. No browser action executes implicitly on session navigation.

A native WebContentsView owns each page, with a separate ephemeral Electron
session and no host preload, Node integration, permission grant, popup or download.
The main process accepts control only from its registered application main frame.
Only HTTP(S) origins explicitly entered through the trusted address bar may be
used for top-level navigation. Existing credential-bearing URL rejection remains.

Acceptance:
- The page is a bounded native child view, not a host DOM frame.
- Pages are separated by owner window and the full server/workspace/session key.
- Switching away hides and mutes the old page; reopening the same session retains
  its URL, history and in-memory document state.
- Snapshot scope, page generation and revision prevent stale UI replacement.
- Layout sequence and display epoch prevent a delayed show from overtaking a hide,
  session switch, resize, renderer navigation or window closure.
- Host dialogs/menus and clipped panels suppress page display. CSS bounds are
  scaled to Electron coordinates and clipped to the owner content area.
- Up to four session pages are retained; extra pages fail visibly, without silently
  evicting user state. Explicit page close and owner disposal release webContents.
- Page commands/display go through the Core native action boundary. Raw scopes
  and URLs are not persisted in action receipts; hashes bind those inputs.
- Regression tests cover state identity, request validation, layout ordering and
  bounds. Isolated Electron checks exercise the real native controller.
- A production session-switch benchmark is recorded before and after the change.

This increment does not grant AI page observation/execution, durable login,
Office editing, multi-agent collaboration, or packaged CLI acceptance. A native
controller fixture does not certify the full application renderer or installer.

Implementation references:
- https://www.electronjs.org/docs/latest/api/web-contents-view
- https://www.electronjs.org/docs/latest/api/view
