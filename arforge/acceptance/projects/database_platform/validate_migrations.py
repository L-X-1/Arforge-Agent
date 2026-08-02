from pathlib import Path

required = {
    "mysql.sql": ("CREATE TABLE", "CHECK", "INSERT"),
    "postgresql.sql": ("CREATE TABLE", "CHECK", "INSERT"),
    "oracle.sql": ("CREATE TABLE", "CHECK", "INSERT"),
}
for name, markers in required.items():
    sql = Path("migrations", name).read_text(encoding="utf-8")
    missing = [marker for marker in markers if marker not in sql.upper()]
    if missing:
        raise RuntimeError(f"{name} lacks {missing}")
print("PASS:migration-contract")
