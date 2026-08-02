"""一次性数据迁移：SQLite（历史本地库）→ PostgreSQL（生产主库）。

Scope A —— 仅核心应用数据：
  ~/.arforge/memory.db      → PG 主库  (memories, learning_experiences,
                                         learning_outcomes, learning_patterns,
                                         token_usage)
  ~/.arforge/multiagent.db  → PG 多智能体库 (multiagent_conversations,
                                              multiagent_tasks)

策略：增量合并（ADDITIVE MERGE）。
  - 保留 PG 现有数据，绝不清空。
  - 整数代理主键表（id 自增）：复制除 id 外的数据列，按数据列去重，由 PG 重新分配 id。
  - 自然主键表（multiagent 的 conversation_id / task_id）：连主键一起复制，按主键去重。
  - 幂等：重复运行不会产生重复行（已存在的签名会被跳过）。

不读取/打印任何数据库密码（连接串由 .env 经 config 注入）。

用法：
  python scripts/migrate_sqlite_to_pg.py --dry-run   # 只报告，不写入
  python scripts/migrate_sqlite_to_pg.py             # 实际迁移
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from pathlib import Path

# 让脚本独立运行时能 import 仓库包
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import config  # noqa: F401,E402  触发 .env 加载（含 ARFORGE_DB_URL）

from sqlalchemy import Integer  # noqa: E402

from arforge.database import (  # noqa: E402
    LearningExperience,
    LearningOutcome,
    LearningPattern,
    Memory,
    MultiagentConversation,
    MultiagentTask,
    TokenUsage,
    get_ma_session,
    get_session,
)

HOME = Path(os.path.expanduser("~")) / ".arforge"
SRC_MAIN = HOME / "memory.db"
SRC_MA = HOME / "multiagent.db"

MAIN_MODELS = [Memory, LearningExperience, LearningOutcome, LearningPattern, TokenUsage]
MA_MODELS = [MultiagentConversation, MultiagentTask]


def _read_rows(db_path: Path, table: str):
    """原始读取 sqlite 表（按实际列，容忍 schema 漂移）。返回 (列名 | None, 行 dict 列表)。"""
    if not db_path.exists():
        return None, []
    con = sqlite3.connect(str(db_path))
    con.row_factory = sqlite3.Row
    try:
        cur = con.execute(f'SELECT * FROM "{table}"')
        colnames = [d[0] for d in cur.description]
        rows = [dict(r) for r in cur.fetchall()]
        return colnames, rows
    except sqlite3.OperationalError:
        return None, []  # 源表不存在
    finally:
        con.close()


def _pk_info(model):
    """返回 (主键种类, 主键列名列表)。单一整数主键视为代理键。"""
    pks = list(model.__table__.primary_key.columns)
    if len(pks) == 1 and isinstance(pks[0].type, Integer):
        return "surrogate", [pks[0].name]
    return "natural", [c.name for c in pks]


def _migrate(model, db_path: Path, session_factory, dry_run: bool):
    table = model.__tablename__
    model_cols = [c.name for c in model.__table__.columns]
    kind, pk_cols = _pk_info(model)

    colnames, rows = _read_rows(db_path, table)
    if colnames is None:
        return table, 0, 0, "源表不存在/空"

    if kind == "surrogate":
        copy_cols = [c for c in model_cols if c not in pk_cols and c in colnames]
        sig_cols = copy_cols
    else:  # 自然主键：连主键一起复制，按主键去重
        copy_cols = [c for c in model_cols if c in colnames]
        sig_cols = pk_cols

    with session_factory() as sess:
        existing = set()
        for obj in sess.query(model).all():
            existing.add(tuple(getattr(obj, c) for c in sig_cols))

        to_insert = []
        for r in rows:
            sig = tuple(r.get(c) for c in sig_cols)
            if sig in existing:
                continue
            existing.add(sig)
            to_insert.append({c: r.get(c) for c in copy_cols})

        if not dry_run:
            for kw in to_insert:
                sess.add(model(**kw))
        # 上下文管理器在退出时 commit（dry-run 时无新增对象，等价 no-op）

    return table, len(rows), len(to_insert), "ok"


def main() -> int:
    ap = argparse.ArgumentParser(description="SQLite→PostgreSQL 核心数据迁移 (Scope A)")
    ap.add_argument("--dry-run", action="store_true", help="只报告将迁移多少行，不写入")
    args = ap.parse_args()

    mode = "DRY-RUN（不写入）" if args.dry_run else "MIGRATE（写入 PG）"
    print(f"== SQLite → PostgreSQL 迁移 · Scope A · {mode} · 增量合并 ==")
    print(f"主库源     : {SRC_MAIN}  (exists={SRC_MAIN.exists()})")
    print(f"多智能体源 : {SRC_MA}  (exists={SRC_MA.exists()})")
    print("-" * 66)

    total_src = total_new = 0
    for model in MAIN_MODELS:
        table, src_n, new_n, note = _migrate(model, SRC_MAIN, get_session, args.dry_run)
        total_src += src_n
        total_new += new_n
        print(f"[main] {table:26s} 源={src_n:5d}  {'将' if args.dry_run else ''}新增={new_n:5d}  {note}")
    for model in MA_MODELS:
        table, src_n, new_n, note = _migrate(model, SRC_MA, get_ma_session, args.dry_run)
        total_src += src_n
        total_new += new_n
        print(f"[ma]   {table:26s} 源={src_n:5d}  {'将' if args.dry_run else ''}新增={new_n:5d}  {note}")

    print("-" * 66)
    suffix = "（dry-run，未写入）" if args.dry_run else "（已写入 PG）"
    print(f"合计：源 {total_src} 行 → {'将' if args.dry_run else ''}新增 {total_new} 行 {suffix}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
