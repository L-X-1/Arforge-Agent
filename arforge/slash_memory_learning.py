"""Memory and learning slash helpers — backed by real systems."""

from __future__ import annotations

from arforge.memory import delete_memory, query_memories, save_memory_v2


def _parse_id(raw: str) -> int | None:
    text = raw.strip().lstrip("#")
    if not text.isdigit():
        return None
    return int(text)


def memory_status(_: str = "") -> str:
    rows = query_memories(limit=10)
    if not rows:
        return "No memories."
    return "\n".join(f"#{item['id']} [{item['mem_type']}] {item['content']}" for item in rows)


def remember(text: str) -> str:
    if not text.strip():
        return "Usage: /remember <content to save>"
    mem_id = save_memory_v2(text.strip(), mem_type="knowledge", importance=2)
    return f"Saved memory #{mem_id}: {text[:100]}"


def learning_status(_: str = "") -> str:
    """Show comprehensive learning system status.

    Uses the rich learning_cli status display that includes bridge stats,
    injection impact, Ebbinghaus decay, recall quality, and more.
    """
    from arforge.learning_cli import learning_status as _rich_status

    return _rich_status()


def memory_command(args: str = "") -> str:
    """List or delete memories with explicit user control."""
    command, _, rest = args.strip().partition(" ")
    if command == "delete":
        mem_id = _parse_id(rest)
        if mem_id is None:
            return "Usage: /memory delete <id>"
        if delete_memory(mem_id):
            return f"Deleted memory #{mem_id}."
        return f"Memory #{mem_id} not found."
    if command in {"", "list", "status"}:
        return memory_status()
    return "Usage: /memory [list|delete <id>]"


def learning_command(args: str = "") -> str:
    """Show learning stats, consolidate outcomes, or inspect learning details."""
    command, _, rest = args.strip().partition(" ")
    if command == "undo":
        learning_id = _parse_id(rest)
        if learning_id is None:
            return "Usage: /learn undo <id>"
        from arforge.learning_system import undo

        if undo(learning_id):
            return f"Deleted learning #{learning_id}."
        return f"Learning #{learning_id} not found."
    if command == "bridge":
        from arforge.core.learning_memory_bridge import get_bridge_stats

        b = get_bridge_stats()
        return (
            f"Memory-Learning Bridge:\n"
            f"  Memories: {b['total_memories']} total, {b['high_quality_memories']} promotable\n"
            f"  Patterns: {b['total_patterns']} total, {b['auto_promoted_patterns']} auto-promoted\n"
            f"  Threshold: importance >= {b['promotion_threshold']['min_importance']}, "
            f"review >= {b['promotion_threshold']['min_review_level']}"
        )
    if command == "decay":
        from arforge.core.ebbinghaus_overview import get_curve_overview

        summary = get_curve_overview()
        lines = ["Ebbinghaus Forgetting Curve:"]
        for item in summary.get("retentions", []):
            lines.append(f"  {item['label']:>6}: {item['retention']:.0%}")
        lines.append(f"  Review schedule: {summary.get('schedule', 'N/A')}")
        return "\n".join(lines)
    if command == "recall":
        from arforge.semantic_memory import recall_quality_report

        rq = recall_quality_report()
        return (
            f"Memory Recall Quality (BM25 self-recall):\n"
            f"  Indexed: {rq['indexed']} | Evaluated: {rq['evaluated']}\n"
            f"  Top-1 Hit Rate: {rq['top1_hit_rate']:.1%}\n"
            f"  MRR: {rq['mrr']:.3f}\n"
            f"  No Result: {rq['no_result']}"
        )
    if command == "dream":
        from arforge.learning_engine import run_learning_dream

        result = run_learning_dream()
        consolidation = result["consolidation"]
        dream = result["dream"]
        lines = [
            "Learning Reflection:",
            f"  Patterns: {consolidation['patterns_found']} found, "
            f"{consolidation['saved_new']} new, {consolidation['updated_existing']} updated",
            f"  Outcomes: {dream['total_turns']} total, {dream['total_failures']} failed",
        ]
        if dream["insights"]:
            lines.append("  Insights:")
            lines.extend(f"    - {item}" for item in dream["insights"])
        if dream["suggestions"]:
            lines.append("  Suggestions:")
            lines.extend(f"    - {item}" for item in dream["suggestions"])
        return "\n".join(lines)
    if command in {"", "status"}:
        return learning_status()
    return "Usage: /learn [status|undo <id>|bridge|decay|recall|dream]"
