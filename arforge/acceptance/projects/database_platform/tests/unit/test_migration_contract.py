from pathlib import Path


def test_every_relational_migration_has_constraints_and_seed_data():
    migrations = list(Path("migrations").glob("*.sql"))
    assert {path.stem for path in migrations} == {
        "mysql",
        "postgresql",
        "oracle",
    }
    for migration in migrations:
        sql = migration.read_text(encoding="utf-8").upper()
        assert "CHECK" in sql
        assert "INSERT" in sql
