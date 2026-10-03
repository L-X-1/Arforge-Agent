## ADDED Requirements

### Requirement: Opt-in isolated static HTML preview
The initial HTML adapter SHALL open in Source mode and offer sanitized HTML/CSS Preview and Split modes. It SHALL not execute document scripts or expose host storage, file APIs or IPC.

#### Scenario: Active content in a document
- WHEN the document contains scripts, event handlers, navigation targets, refresh metadata or resource URLs
- THEN the preview removes unsupported active markup and applies a script-disabled opaque-origin sandbox with restrictive CSP
- AND the host conversation remains usable

### Requirement: Live draft rendering without automatic writes
The editor SHALL render the latest draft with a bounded debounce and SHALL keep preview updates separate from explicit file saving.

#### Scenario: Editing while preview is visible
- WHEN the user changes the HTML buffer
- THEN the preview updates without a save request
- AND the editor DOM and undo state are retained when preview is toggled

### Requirement: Explicit incomplete capability boundary
The first increment SHALL disclose that script execution, local/external linked resources, wrapper attributes and element picking are not supported. It SHALL not advertise the complete interactive-browser capability from the overall plan as delivered.
