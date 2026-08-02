from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

destination = Path("dist/arforge-delivery-platform.zip")
destination.parent.mkdir(parents=True, exist_ok=True)
with ZipFile(destination, "w", ZIP_DEFLATED) as archive:
    for pattern in (
        "Dockerfile",
        "nginx.conf",
        "site/*",
        "k8s/*.yaml",
        ".github/workflows/*.yml",
        "pipeline.py",
    ):
        for path in Path(".").glob(pattern):
            archive.write(path)
if destination.stat().st_size < 1000:
    raise RuntimeError("delivery artifact is unexpectedly small")
