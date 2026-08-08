# Cognitive Runtime Foundation — Pre-change Baseline

Date: 2026-08-03  
Workspace: `E:\Arforge-Agent`  
Purpose: freeze the existing behavior of AgentRun, entity/lifecycle contracts, Task Ledger, message checkpoints, run transactions/rollback, and portable run traces before cognitive-runtime production changes.

## Command

```powershell
python -m pytest tests/test_phase1_agent_run.py tests/test_d3_d4_entities_state.py tests/test_g4_task_ledger.py tests/test_g18_g2_g6.py tests/test_v1_5_run_transaction.py tests/test_run_trace_portability.py -q
```

## Result

```text
........................................................................ [ 52%]
.................................................................        [100%]
137 passed in 3.28s
```

Exit code: `0`  
Elapsed wall time reported by the command runner: `12.8s`

This is a focused compatibility baseline, not evidence that the repository's entire suite was green before the change. Full affected and repository verification remains a delivery task.
