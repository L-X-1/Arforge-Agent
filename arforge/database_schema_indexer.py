"""Database schema inspection — SQLAlchemy backend."""

from __future__ import annotations

from sqlalchemy import inspect as sa_inspect

from arforge.database import get_engine


def index_database_schema() -> dict:
    return {"success": True, "tables": len(list_database_tables())}


def list_database_sources():
    from arforge.database.config import get_database_url
    return [get_database_url()]


def list_database_tables():
    insp = sa_inspect(get_engine())
    return insp.get_table_names()


def show_database_table_schema(table_name: str):
    insp = sa_inspect(get_engine())
    columns = insp.get_columns(table_name)
    return [{"name": c["name"], "type": str(c["type"])} for c in columns]


def list_table_usages(table_name: str):
    from arforge.database.config import get_database_url
    if table_name in list_database_tables():
        return [{"table": table_name, "database": get_database_url()}]
    return []


def list_database_schema_risks():
    return []


def database_schema_status():
    return index_database_schema()
