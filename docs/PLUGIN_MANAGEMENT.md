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
arforge plugins install https://source.example.com/repository.git
arforge plugins install "https://source.example.com/repository.git#ref=develop&subdir=plugins/my-plugin"
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

Supported remote inputs are public HTTPS ZIP downloads and public HTTPS Git
repositories. Git sources accept optional `ref` and `subdir` fragment values.
Remote redirects are revalidated, private/reserved network destinations are
blocked, Git credential prompting is disabled, and downloaded/expanded sizes
are bounded.

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
- Install, update, remove and restore use a cross-process profile lock.
- Installation is staged and manifest-validated before the target directory is
  replaced.
- Package inspection and installation never import the plugin entrypoint.
