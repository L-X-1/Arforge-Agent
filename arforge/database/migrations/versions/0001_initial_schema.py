"""Initial versioned schema baseline.

Revision ID: 0001_initial
Revises: None
"""

from alembic import context, op
import sqlalchemy as sa


revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None


def _database_kind() -> str:
    return context.config.attributes.get("database_kind", "main")


def upgrade() -> None:
    if _database_kind() == "multiagent":
        op.create_table(
            "multiagent_tasks",
            sa.Column("task_id", sa.Text(), primary_key=True),
            sa.Column("conversation_id", sa.Text(), nullable=False),
            sa.Column("parent_task_id", sa.Text(), nullable=False),
            sa.Column("role", sa.Text(), nullable=False),
            sa.Column("goal", sa.Text(), nullable=False),
            sa.Column("inputs", sa.Text(), nullable=False),
            sa.Column("constraints", sa.Text(), nullable=False),
            sa.Column("depends_on", sa.Text(), nullable=False),
            sa.Column("deadline_ms", sa.Integer(), nullable=False),
            sa.Column("priority", sa.Integer(), nullable=False),
            sa.Column("success", sa.Integer(), nullable=False),
            sa.Column("output", sa.Text(), nullable=False),
            sa.Column("artifacts", sa.Text(), nullable=False),
            sa.Column("evidence", sa.Text(), nullable=False),
            sa.Column("tool_calls", sa.Text(), nullable=False),
            sa.Column("elapsed_ms", sa.Integer(), nullable=False),
            sa.Column("tokens_used", sa.Integer(), nullable=False),
            sa.Column("error", sa.Text(), nullable=False),
            sa.Column("created_at", sa.Text(), nullable=False),
            sa.Column("updated_at", sa.Text(), nullable=False),
        )
        op.create_table(
            "multiagent_conversations",
            sa.Column("conversation_id", sa.Text(), primary_key=True),
            sa.Column("master_goal", sa.Text(), nullable=False),
            sa.Column("shared_memory", sa.Text(), nullable=False),
            sa.Column("created_at", sa.Text(), nullable=False),
            sa.Column("updated_at", sa.Text(), nullable=False),
        )
        return

    op.create_table(
        "memories",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("mem_type", sa.String(50), nullable=False),
        sa.Column("tags", sa.Text(), nullable=False),
        sa.Column("importance", sa.Integer(), nullable=False),
        sa.Column("source", sa.String(50), nullable=False),
        sa.Column("related_to", sa.Text(), nullable=False),
        sa.Column("strength", sa.Float(), nullable=False),
    )
    op.create_table(
        "learning_experiences",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("payload", sa.Text(), nullable=False),
        sa.Column("route_type", sa.Text(), nullable=False),
        sa.Column("has_error", sa.Integer(), nullable=False),
        sa.Column("importance", sa.Float(), nullable=False),
    )
    op.create_table(
        "learning_outcomes",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("session_id", sa.Text(), nullable=False),
        sa.Column("turn_index", sa.Integer(), nullable=False),
        sa.Column("user_input", sa.Text(), nullable=False),
        sa.Column("intent", sa.Text(), nullable=False),
        sa.Column("route", sa.Text(), nullable=False),
        sa.Column("tools_used", sa.Text(), nullable=False),
        sa.Column("success", sa.Integer(), nullable=False),
        sa.Column("error_type", sa.Text(), nullable=False),
        sa.Column("error_message", sa.Text(), nullable=False),
        sa.Column("user_feedback", sa.Text(), nullable=False),
        sa.Column("fix_strategy", sa.Text(), nullable=False),
        sa.Column("regression", sa.Integer(), nullable=False),
        sa.Column("tokens_used", sa.Integer(), nullable=False),
        sa.Column("response_time_ms", sa.Float(), nullable=False),
        sa.Column("tags", sa.Text(), nullable=False),
        sa.Column("importance", sa.Float(), nullable=False),
        sa.Column("injected_context_size", sa.Integer(), nullable=False),
    )
    op.create_table(
        "learning_patterns",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.Column("pattern_type", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("frequency", sa.Integer(), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=False),
        sa.Column("tags", sa.Text(), nullable=False),
    )
    op.create_table(
        "token_usage",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("model_name", sa.Text(), nullable=False),
        sa.Column("prompt_tokens", sa.Integer(), nullable=False),
        sa.Column("completion_tokens", sa.Integer(), nullable=False),
        sa.Column("total_tokens", sa.Integer(), nullable=False),
    )


def downgrade() -> None:
    if _database_kind() == "multiagent":
        op.drop_table("multiagent_conversations")
        op.drop_table("multiagent_tasks")
        return
    for table in ("token_usage", "learning_patterns", "learning_outcomes", "learning_experiences", "memories"):
        op.drop_table(table)
