# Arforge for JetBrains IDEs

Install the ZIP produced in `build/distributions` through
**Settings → Plugins → Install Plugin from Disk**.

The plugin starts `python -m arforge.bridge` inside a trusted project. It provides:

- chat, selection explanation/fix and workspace review;
- active file, cursor, selection and live IDE diagnostics as structured context;
- reasoning-effort and permission-mode controls without reducing model capability;
- resumable project sessions across IDE restarts;
- working-tree patch review and direct access to the Version Control tool window.

For local builds, set `ARFORGE_INTELLIJ_SDK` to an IntelliJ IDEA installation to
avoid downloading an SDK. Then run `gradlew.bat test buildPlugin --no-daemon`.
