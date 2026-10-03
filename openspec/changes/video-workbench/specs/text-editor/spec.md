## ADDED Requirements

### Requirement: Explicit guarded text editing
The workbench SHALL remain read-only until the user selects Edit file. A save SHALL carry the exact original byte version, execute through core mutation services and refuse stale content without an unconditional retry.

#### Scenario: External file modification
- WHEN a file changes after its editable snapshot was read
- THEN saving returns a conflict, retains the draft and does not overwrite the external edit

#### Scenario: Editing during an in-flight save
- WHEN the user types additional text before a save response arrives
- THEN the acknowledged base updates while the additional text remains an unsaved draft

### Requirement: Safe file boundaries and format preservation
The initial editor SHALL accept only existing workspace UTF-8 text within bounded size. It SHALL preserve BOM and uniform LF/CRLF and reject unsafe paths, symlinks, invalid encoding and unsupported newline mixtures.

### Requirement: Recoverable scoped drafts
Draft identity SHALL include server scope, workspace directory and file path. File-tab replacement SHALL retain drafts for recovery. Storage failure SHALL be visible rather than treated as durable success.

#### Scenario: Accidental exit from editing
- WHEN a user requests Back to preview with dirty text
- THEN the editor offers save, discard or cancel without silently dropping the draft
