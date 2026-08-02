# Arforge Agent Performance Baseline

Date: 2026-06-18
Environment: Windows, Python 3.12, isolated SQLite profile, offline model substitute

## Cold-process budgets

Each measurement starts a new Python process. CI enforces the same budgets on Ubuntu with five runs per case.

| Case | P50 | P95 | P95 budget | Result |
|---|---:|---:|---:|---|
| Package import | 53.3 ms | 72.7 ms | 500 ms | PASS |
| Agent initialization | 85.1 ms | 148.0 ms | 1,000 ms | PASS |
| CLI version | 99.8 ms | 212.6 ms | 750 ms | PASS |
| CLI help | 97.2 ms | 110.0 ms | 750 ms | PASS |
| CLI privacy | 92.1 ms | 112.5 ms | 1,000 ms | PASS |

## Optimization evidence

cProfile showed Agent construction was dominated by eager imports through memory 鈫?SQLAlchemy. Moving memory, semantic search and safe-modifier imports to their call sites reduced Agent initialization:

| Metric | Before | After | Change |
|---|---:|---:|---:|
| P50 | 614.5 ms | 85.1 ms | -86.2% |
| P95 | 636.4 ms | 148.0 ms | -76.7% |

## Offline dogfood

The deterministic suite executes 100 full chat turns through reasoning, memory retrieval and continuous learning, then checks a registered calculation tool, MCP request construction, durable secret redaction and local sensitive-data scanning.

| Metric | Result |
|---|---:|
| Turns | 100 |
| Model substitute calls | 100 |
| Network calls | 0 |
| Failures | 0 |
| Turn P50 | 11.95 ms |
| Turn P95 | 14.01 ms |

This baseline measures local framework overhead, not provider latency or production PostgreSQL performance. Real provider, large-dataset PostgreSQL and multi-agent load baselines remain separate staging gates.
