"""Add governed Memory OS state, history, relations, and recall telemetry.

Revision ID: 0005_memory_os
Revises: 0004_cache_evidence
"""

from __future__ import annotations

import hashlib
import uuid

from alembic import context, op
import sqlalchemy as sa


revision = "0005_memory_os"
down_revision = "0004_cache_evidence"
branch_labels = None
depends_on = None


def _database_kind() -> str:
    return context.config.attributes.get("database_kind", "main")


def _memory_class(mem_type: str) -> str:
    kind = str(mem_type or "").casefold()
    if kind in {"preference", "identity"}:
        return "user"
    if kind in {"workflow", "constraint"}:
        return "procedural"
    if kind in {"convention", "project"}:
        return "project"
    if kind == "error":
        return "episodic"
    return "semantic"


def upgrade() -> None:
    if _database_kind() != "main":
        return
    bind = op.get_bind()
    existing = {column["name"] for column in sa.inspect(bind).get_columns("memories")}
    columns = {
        "memory_uid": sa.Column("memory_uid", sa.String(64), nullable=False, server_default=""),
        "memory_class": sa.Column("memory_class", sa.String(32), nullable=False, server_default="semantic"),
        "lifecycle": sa.Column("lifecycle", sa.String(24), nullable=False, server_default="active"),
        "confidence": sa.Column("confidence", sa.Float(), nullable=False, server_default="1.0"),
        "version": sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        "content_digest": sa.Column("content_digest", sa.Text(), nullable=False, server_default=""),
        "provenance": sa.Column("provenance", sa.Text(), nullable=False, server_default="{}"),
    }
    for name, column in columns.items():
        if name not in existing:
            op.add_column("memories", column)

    learning_columns = {
        column["name"] for column in sa.inspect(bind).get_columns("learning_patterns")
    }
    if "provenance" not in learning_columns:
        op.add_column(
            "learning_patterns",
            sa.Column("provenance", sa.Text(), nullable=False, server_default="{}"),
        )

    memories = bind.execute(
        sa.text("SELECT id, created_at, content, mem_type FROM memories")
    ).mappings()
    for row in memories:
        content = str(row["content"] or "")
        seed = f"{row['id']}:{row['created_at']}:{content}"
        memory_uid = uuid.uuid5(uuid.NAMESPACE_URL, f"arforge-memory:{seed}").hex
        content_digest = "sha256:" + hashlib.sha256(content.encode("utf-8")).hexdigest()
        bind.execute(
            sa.text(
                "UPDATE memories SET memory_uid=:memory_uid, memory_class=:memory_class, "
                "content_digest=:content_digest WHERE id=:memory_id"
            ),
            {
                "memory_uid": memory_uid,
                "memory_class": _memory_class(row["mem_type"]),
                "content_digest": content_digest,
                "memory_id": row["id"],
            },
        )

    indexes = {index["name"] for index in sa.inspect(bind).get_indexes("memories")}
    if "ux_memories_memory_uid" not in indexes:
        op.create_index("ux_memories_memory_uid", "memories", ["memory_uid"], unique=True)
    if "ix_memories_scope_lifecycle" not in indexes:
        op.create_index(
            "ix_memories_scope_lifecycle",
            "memories",
            ["project_id", "workspace_path", "lifecycle"],
        )

    op.create_table(
        "memory_revisions",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("memory_id", sa.Integer(), sa.ForeignKey("memories.id", ondelete="CASCADE"), nullable=False),
        sa.Column("memory_uid", sa.String(64), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("operation", sa.String(32), nullable=False),
        sa.Column("actor", sa.String(80), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False, server_default=""),
        sa.Column("source_run_id", sa.Text(), nullable=False, server_default=""),
        sa.Column("source_event_sequence", sa.Integer(), nullable=False, server_default="-1"),
        sa.Column("snapshot", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("content_digest", sa.Text(), nullable=False),
        sa.Column("previous_revision_digest", sa.Text(), nullable=False, server_default=""),
        sa.Column("revision_digest", sa.Text(), nullable=False),
        sa.UniqueConstraint("memory_id", "version", name="uq_memory_revision_version"),
        sa.UniqueConstraint("revision_digest", name="uq_memory_revision_digest"),
    )
    op.create_index("ix_memory_revisions_memory_id", "memory_revisions", ["memory_id"])
    op.create_index("ix_memory_revisions_memory_uid", "memory_revisions", ["memory_uid"])

    op.create_table(
        "memory_relations",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("relation_uid", sa.String(64), nullable=False, unique=True),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("source_memory_id", sa.Integer(), sa.ForeignKey("memories.id", ondelete="CASCADE"), nullable=False),
        sa.Column("target_memory_id", sa.Integer(), sa.ForeignKey("memories.id", ondelete="CASCADE"), nullable=False),
        sa.Column("relation_type", sa.String(24), nullable=False),
        sa.Column("status", sa.String(24), nullable=False, server_default="proposed"),
        sa.Column("confidence", sa.Float(), nullable=False, server_default="1.0"),
        sa.Column("evidence", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("actor", sa.String(80), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False, server_default=""),
    )
    op.create_index("ix_memory_relations_source_memory_id", "memory_relations", ["source_memory_id"])
    op.create_index("ix_memory_relations_target_memory_id", "memory_relations", ["target_memory_id"])

    op.create_table(
        "memory_retrieval_events",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("retrieval_uid", sa.String(64), nullable=False, unique=True),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("scope_id", sa.String(80), nullable=False),
        sa.Column("query_fingerprint", sa.Text(), nullable=False),
        sa.Column("algorithm", sa.String(64), nullable=False),
        sa.Column("algorithm_version", sa.String(32), nullable=False),
        sa.Column("candidate_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("returned", sa.Text(), nullable=False, server_default="[]"),
        sa.Column("latency_ms", sa.Float(), nullable=False, server_default="0.0"),
        sa.Column("feedback", sa.Text(), nullable=False, server_default="{}"),
    )
    op.create_index("ix_memory_retrieval_events_created_at", "memory_retrieval_events", ["created_at"])
    op.create_index("ix_memory_retrieval_events_scope_id", "memory_retrieval_events", ["scope_id"])


def downgrade() -> None:
    if _database_kind() != "main":
        return
    op.drop_table("memory_retrieval_events")
    op.drop_table("memory_relations")
    op.drop_table("memory_revisions")
    op.drop_column("learning_patterns", "provenance")
    op.drop_index("ix_memories_scope_lifecycle", table_name="memories")
    op.drop_index("ux_memories_memory_uid", table_name="memories")
    for name in (
        "provenance",
        "content_digest",
        "version",
        "confidence",
        "lifecycle",
        "memory_class",
        "memory_uid",
    ):
        op.drop_column("memories", name)
