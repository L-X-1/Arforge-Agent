"""Add project and workspace scope to memories.

Revision ID: 0002_memory_project_scope
Revises: 0001_initial
"""

from alembic import context, op
import sqlalchemy as sa


revision = "0002_memory_project_scope"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def _database_kind() -> str:
    return context.config.attributes.get("database_kind", "main")


def upgrade() -> None:
    if _database_kind() == "multiagent":
        return
    op.add_column("memories", sa.Column("project_id", sa.String(80), nullable=False, server_default=""))
    op.add_column("memories", sa.Column("workspace_path", sa.Text(), nullable=False, server_default=""))


def downgrade() -> None:
    if _database_kind() == "multiagent":
        return
    op.drop_column("memories", "workspace_path")
    op.drop_column("memories", "project_id")
