"""Add review_level and last_reviewed_at columns to memories table.

Revision ID: 0003_memory_review
Revises: 0002_memory_project_scope
"""

from alembic import context, op
import sqlalchemy as sa


revision = "0003_memory_review"
down_revision = "0002_memory_project_scope"
branch_labels = None
depends_on = None


def _database_kind() -> str:
    return context.config.attributes.get("database_kind", "main")


def upgrade() -> None:
    if _database_kind() == "main":
        op.add_column(
            "memories",
            sa.Column("review_level", sa.Integer(), nullable=False, server_default="0"),
        )
        op.add_column(
            "memories",
            sa.Column("last_reviewed_at", sa.Text(), nullable=False, server_default=""),
        )


def downgrade() -> None:
    if _database_kind() == "main":
        op.drop_column("memories", "last_reviewed_at")
        op.drop_column("memories", "review_level")
