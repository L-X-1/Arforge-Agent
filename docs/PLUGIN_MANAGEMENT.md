# Plugin management

Arforge discovers plugins from the profile directory and the current project's
`.arforge/plugins` directory. Package inspection validates files and
`plugin.json` without importing the plugin entrypoint.

Two existing extension styles are supported side by side:

- Python factory plugins use `entrypoint: "plugin.py:create_plugin"` and keep
  the original MCP plugin lifecycle.
- Data-declared command plugins use a `tools` array. Each tool has a name,
  description, no-shell command array and object JSON Schema. Arforge sends
  arguments as JSON on standard input and returns bounded standard output.

Command tools are exposed as `plugin_<plugin_name>_<tool_name>`. They enter the
Agent registry only after a persisted explicit enable action, are marked
high-risk, and require the active permission policy to approve execution. The
subprocess has a 60-second limit, 1 MiB input/output bounds, a plugin-directory
working directory, and a reduced environment that excludes model credentials.

## CLI

```powershell
arforge plugins list
arforge plugins inspect C:\packages\my-plugin
arforge plugins install C:\packages\my-plugin.zip
arforge plugins update https://downloads.example.com/my-plugin.zip
arforge plugins remove my-plugin
arforge plugins restore <recovery-id>
arforge plugins enable my-plugin
```

A directory or archive may contain one plugin at its root or multiple plugins
in immediate subdirectories. When it contains multiple plugins, pass the
selected name after the source:

```powershell
arforge plugins install C:\packages\plugin-suite.zip selected-plugin
```

Supported remote inputs are public HTTPS ZIP downloads. Git clones and opaque
repository sources are intentionally not part of the native contract. Remote
downloads and expanded sizes are bounded.

## Desktop

Open **Settings → Extensions**, enter a source and select **Inspect**. The
desktop shows the validated name, version and SHA-256 before installation.
New and updated plugins remain disabled. Enabling a plugin is a separate
explicit action because loading it executes third-party code.

Managed profile plugins have a remove action. Removal first disables the
plugin, moves it to profile-local recovery storage, and presents an undo
action. Updates also retain the replaced version as a recoverable copy.

## Package safety contract

- ZIP absolute paths, traversal, links, reparse points and unsafe Windows
  device paths are rejected.
- Expanded packages are limited to 2,000 entries and 100 MiB.
- Inspection tokens expire after 30 minutes.
- Install, update, remove, restore, enable and disable are submitted as durable
  L3 human-authority `ControlRun` actions and execute through `ActionGateway`.
- A ControlRun is bound to the server-derived principal, location, operation,
  payload and authorization plan. The renderer cannot supply those identities.
- Installation is staged and manifest-validated before the target directory is
  replaced.
- Package inspection and installation never import the plugin entrypoint.
- `plugin.json` may declare `permissions`, `egress`, `secrets`,
  `compatibility.api_version`, and an Ed25519 `signature`. The local trust store
  is `${ARFORGE_HOME}/config/plugin_trust.json`; unsigned or untrusted packages
  are visible as warnings, while invalid signatures and forbidden boundaries
  block installation.
- The bounded security scan rejects references to the EventV2 publisher,
  database-admin services, opaque capability registries, undeclared network
  egress and undeclared secret access. Plugins receive no direct access to
  those runtime services.
- Security findings, source, digest, signature state and declared scopes are
  returned by the typed Agent Capability API for review before Apply.

Managed prompt skills remain discoverable in the same center. Their existing
versioned candidate/evaluation/rollback lifecycle stays owned by the Skill
Lifecycle service; enable/disable is now a durable L3 ControlRun and never
mutates the skill content itself. This keeps prompt evolution and executable
plugin installation under separate contracts while sharing the same audit and
approval boundary.
