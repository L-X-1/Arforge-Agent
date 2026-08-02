"""Learning pattern extraction - structured analysis of outcome data."""

from __future__ import annotations


from arforge.database import LearningOutcome, get_session


def extract_patterns(limit: int = 50) -> dict:
    """Extract patterns from recorded learning outcomes.

    Returns a dictionary with:
      - routes: route type distribution
      - errors: total error count
      - error_types: error type distribution
      - recent_failures: list of recent failure descriptions
      - fix_strategies: list of successful fix strategies
      - user_feedback: feedback distribution
    """
    with get_session() as session:
        rows = (
            session.query(LearningOutcome)
            .order_by(LearningOutcome.id.desc())
            .limit(limit)
            .all()
        )

    routes: dict[str, int] = {}
    error_types: dict[str, int] = {}
    errors = 0
    fixes: list[str] = []
    feedback_types: dict[str, int] = {}
    recent_failures: list[dict] = []

    for r in rows:
        route = r.route or "unknown"
        routes[route] = routes.get(route, 0) + 1

        if not r.success:
            errors += 1
            et = r.error_type or "unknown"
            error_types[et] = error_types.get(et, 0) + 1
            recent_failures.append({
                "id": int(r.id),
                "error_type": et,
                "error_message": (r.error_message or "")[:200],
                "user_input": (r.user_input or "")[:100],
                "fix_strategy": r.fix_strategy or "",
            })

        if r.fix_strategy:
            fixes.append(r.fix_strategy)

        if r.user_feedback:
            fb = r.user_feedback
            feedback_types[fb] = feedback_types.get(fb, 0) + 1

    return {
        "routes": dict(sorted(routes.items(), key=lambda x: x[1], reverse=True)),
        "errors": errors,
        "error_types": dict(sorted(error_types.items(), key=lambda x: x[1], reverse=True)),
        "recent_failures": recent_failures[:10],
        "fix_strategies": list(dict.fromkeys(fixes))[:10],
        "user_feedback": feedback_types,
        "total_analyzed": len(rows),
    }


def extract_error_clusters(limit: int = 200) -> list[dict]:
    """Group errors by similarity and return clusters."""
    with get_session() as session:
        rows = (
            session.query(LearningOutcome)
            .filter(LearningOutcome.success == 0)
            .order_by(LearningOutcome.id.desc())
            .limit(limit)
            .all()
        )

    clusters: dict[str, list] = {}
    for r in rows:
        et = r.error_type or "unknown"
        em = (r.error_message or "")[:80]
        key = f"{et}:{em}" if em else et
        clusters.setdefault(key, []).append(r)

    result = []
    for key, group in sorted(clusters.items(), key=lambda x: len(x[1]), reverse=True):
        first = group[0]
        result.append({
            "error_type": first.error_type or "unknown",
            "error_message": (first.error_message or "")[:200],
            "count": len(group),
            "first_seen": first.created_at or "",
            "last_seen": group[-1].created_at or "",
            "has_fix": bool(first.fix_strategy),
        })

    return result


def extract_successful_routes(limit: int = 200) -> dict[str, float]:
    """Calculate success rate per route type."""
    with get_session() as session:
        rows = (
            session.query(LearningOutcome)
            .order_by(LearningOutcome.id.desc())
            .limit(limit)
            .all()
        )

    route_stats: dict[str, dict[str, int]] = {}
    for r in rows:
        route = r.route or "unknown"
        if route not in route_stats:
            route_stats[route] = {"total": 0, "success": 0}
        route_stats[route]["total"] += 1
        if r.success:
            route_stats[route]["success"] += 1

    return {
        route: stats["success"] / max(stats["total"], 1)
        for route, stats in route_stats.items()
        if stats["total"] >= 2
    }
