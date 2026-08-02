from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

destination = Path("dist/arforge-database-migrations.zip")
destination.parent.mkdir(parents=True, exist_ok=True)
with ZipFile(destination, "w", ZIP_DEFLATED) as archive:
    for path in sorted(Path("migrations").glob("*.sql")):
        archive.write(path)
    archive.write("vector_acceptance.py")
if destination.stat().st_size < 500:
    raise RuntimeError("database release artifact is unexpectedly small")
