"""Add auditable cache-evidence metadata to token usage.

Revision ID: 0004_cache_evidence
Revises: 0003_memory_review
"""

from alembic import context, op
import sqlalchemy as sa


revision = "0004_cache_evidence"
down_revision = "0003_memory_review"
branch_labels = None
depends_on = None


def _database_kind() -> str:
    return context.config.attributes.get("database_kind", "main")


def _columns() -> dict[str, sa.Column]:
    return {
        "prompt_cache_hit_tokens": sa.Column(
            "prompt_cache_hit_tokens", sa.Integer(), nullable=False, server_default="0"
        ),
        "prompt_cache_miss_tokens": sa.Column(
            "prompt_cache_miss_tokens", sa.Integer(), nullable=False, server_default="0"
        ),
        "provider_name": sa.Column(
            "provider_name", sa.Text(), nullable=False, server_default=""
        ),
        "request_kind": sa.Column(
            "request_kind", sa.Text(), nullable=False, server_default=""
        ),
        "stable_prefix_fingerprint": sa.Column(
            "stable_prefix_fingerprint", sa.Text(), nullable=False, server_default=""
        ),
        "prompt_fingerprint": sa.Column(
            "prompt_fingerprint", sa.Text(), nullable=False, server_default=""
        ),
        "run_id": sa.Column("run_id", sa.Text(), nullable=False, server_default=""),
        "task_id": sa.Column("task_id", sa.Text(), nullable=False, server_default=""),
    }


def upgrade() -> None:
    if _database_kind() != "main":
        return
    bind = op.get_bind()
    existing = {column["name"] for column in sa.inspect(bind).get_columns("token_usage")}
    for name, column in _columns().items():
        if name not in existing:
            op.add_column("token_usage", column)
    indexes = {index["name"] for index in sa.inspect(bind).get_indexes("token_usage")}
    if "ix_token_usage_cache_evidence" not in indexes:
        op.create_index(
            "ix_token_usage_cache_evidence",
            "token_usage",
            ["provider_name", "model_name", "created_at"],
        )
    if "ix_token_usage_run_id" not in indexes:
        op.create_index("ix_token_usage_run_id", "token_usage", ["run_id"])


def downgrade() -> None:
    if _database_kind() != "main":
        return
    bind = op.get_bind()
    indexes = {index["name"] for index in sa.inspect(bind).get_indexes("token_usage")}
    if "ix_token_usage_run_id" in indexes:
        op.drop_index("ix_token_usage_run_id", table_name="token_usage")
    if "ix_token_usage_cache_evidence" in indexes:
        op.drop_index("ix_token_usage_cache_evidence", table_name="token_usage")
    existing = {column["name"] for column in sa.inspect(bind).get_columns("token_usage")}
    for name in reversed(list(_columns())):
        if name in existing:
            op.drop_column("token_usage", name)
