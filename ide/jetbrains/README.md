# Arforge for JetBrains IDEs

Install the ZIP produced in `build/distributions` through
**Settings → Plugins → Install Plugin from Disk**.

The plugin starts the TypeScript `arforge bridge` command inside a trusted project.
Startup performs a `protocol.describe` plus `health` handshake and refuses a
retired Python or otherwise unknown runtime. It provides:

- chat, selection explanation/fix and workspace review;
- active file, cursor, selection and live IDE diagnostics as structured context;
- reasoning-effort and permission-mode controls without reducing model capability;
- resumable project sessions across IDE restarts;
- working-tree patch review and direct access to the Version Control tool window.

For local builds, set `ARFORGE_INTELLIJ_SDK` to an IntelliJ IDEA installation to
avoid downloading an SDK. Then run `gradlew.bat test buildPlugin --no-daemon`.
