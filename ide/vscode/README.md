# Arforge for VS Code

Arforge runs its local Bridge inside a trusted workspace and keeps model
execution in the same full-capability agent core used by the CLI and Desktop.

Features:

- chat, explain/fix selection and whole-workspace review;
- active file, cursor, selected text and live VS Code diagnostics as structured context;
- resumable workspace sessions across VS Code restarts;
- working-tree patch preview and one-click access to Source Control review;
- reasoning-effort and permission-mode controls;
- cancellable operations and Bridge restart/status commands.

The extension does not truncate reasoning, lower model context limits or change
the selected model. Editor context is bounded separately to protect Bridge
stability and is appended as request-specific context.

Run `npm test`, `npm run build`, then `npm run package` to produce the VSIX.
