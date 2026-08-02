from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

destination = Path("dist/arforge-electron-app.zip")
destination.parent.mkdir(parents=True, exist_ok=True)
with ZipFile(destination, "w", compression=ZIP_DEFLATED) as package:
    for name in ("main.cjs", "checks.cjs", "renderer.html", "verify.cjs"):
        package.write(name)
if destination.stat().st_size < 100:
    raise RuntimeError("Electron release package is unexpectedly small")
