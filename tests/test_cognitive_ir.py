"""Contract tests for the model-independent Agent IR V2 boundary."""

from __future__ import annotations

import json

import pytest


def _ir_api():
    from arforge.core.cognitive_ir import (
        Action,
        AgentTaskIR,
        Belief,
        Evidence,
        EvolutionProposal,
        Goal,
        Hypothesis,
        IRValidationError,
        LearningSignal,
        LifecycleState,
        Observation,
        Decision,
        Verification,
    )

    return {
        "Action": Action,
        "AgentTaskIR": AgentTaskIR,
        "Belief": Belief,
        "Evidence": Evidence,
        "EvolutionProposal": EvolutionProposal,
        "Goal": Goal,
        "Hypothesis": Hypothesis,
        "IRValidationError": IRValidationError,
        "LearningSignal": LearningSignal,
        "LifecycleState": LifecycleState,
        "Observation": Observation,
        "Decision": Decision,
        "Verification": Verification,
    }


def test_create_task_has_stable_v2_envelope():
    api = _ir_api()

    task = api["AgentTaskIR"].create("Repair cache invalidation", task_id="task-cache")

    assert task.schema_version == "2.0"
    assert task.task_id == "task-cache"
    assert task.objective == "Repair cache invalidation"
    assert task.state is api["LifecycleState"].CREATED
    assert task.revision == 0
    assert task.records == ()
    assert task.created_at
    assert task.updated_at == task.created_at


def test_all_typed_records_round_trip_without_semantic_loss():
    api = _ir_api()
    task = api["AgentTaskIR"].create("Ship verified patch", task_id="task-roundtrip")
    records = [
        api["Goal"](
            record_id="goal-1",
            description="Target regression passes",
            success_criteria=("tests/cache_test.py passes",),
            priority=1,
        ),
        api["Evidence"](
            record_id="evidence-1",
            summary="Target test fails before the patch",
            source="pytest:tests/cache_test.py",
            evidence_type="test_result",
            authority=0.95,
            sensitivity="internal",
            digest="sha256:abc",
        ),
        api["Belief"](
            record_id="belief-1",
            statement="The failure is reproducible",
            confidence=0.9,
            evidence_ids=("evidence-1",),
        ),
        api["Hypothesis"](
            record_id="hypothesis-1",
            statement="Path normalization is missing",
            confidence=0.6,
            evidence_ids=("evidence-1",),
        ),
        api["Action"](
            record_id="action-1",
            action_type="run_targeted_test",
            target="tests/cache_test.py",
            expected_information="Confirm the patch fixes the regression",
            risk_level="low",
            estimated_cost=0.2,
            arguments={"case": "windows-path"},
        ),
        api["Observation"](
            record_id="observation-1",
            action_id="action-1",
            summary="The targeted test passes",
            success=True,
            evidence_ids=("evidence-1",),
        ),
        api["Decision"](
            record_id="decision-1",
            statement="Keep the public API unchanged",
            rationale="The defect is internal",
            evidence_ids=("evidence-1",),
            reversible=True,
        ),
        api["Verification"](
            record_id="verification-1",
            criterion="Target regression passes",
            status="passed",
            verifier="pytest",
            evidence_ids=("evidence-1",),
        ),
        api["LearningSignal"](
            record_id="learning-1",
            signal_type="task_outcome",
            outcome="success",
            reward=0.8,
            evidence_ids=("evidence-1",),
        ),
        api["EvolutionProposal"](
            record_id="evolution-1",
            target_component="retrieval-policy",
            change_summary="Prefer the target test after a high-confidence symbol hit",
            hypothesis="This reduces irrelevant execution",
            eval_case_ids=("eval-cache-1",),
            risk_level="medium",
        ),
    ]
    for record in records:
        task = task.with_record(record)

    restored = api["AgentTaskIR"].from_dict(
        json.loads(task.canonical_bytes().decode("utf-8"))
    )

    assert restored == task
    assert {record.kind for record in restored.records} == {
        "goal",
        "evidence",
        "belief",
        "hypothesis",
        "action",
        "observation",
        "decision",
        "verification",
        "learning_signal",
        "evolution_proposal",
    }


def test_canonical_digest_ignores_mapping_insertion_order():
    api = _ir_api()
    left = api["AgentTaskIR"].create(
        "Stable serialization",
        task_id="task-canonical",
        extensions={"vendor": {"b": 2, "a": 1}},
    )
    right = api["AgentTaskIR"].create(
        "Stable serialization",
        task_id="task-canonical",
        extensions={"vendor": {"a": 1, "b": 2}},
        created_at=left.created_at,
    )

    assert left.canonical_bytes() == right.canonical_bytes()
    assert left.digest() == right.digest()


def test_missing_evidence_reference_reports_record_path():
    api = _ir_api()
    task = api["AgentTaskIR"].create("Validate provenance", task_id="task-provenance")

    with pytest.raises(api["IRValidationError"], match=r"beliefs\[belief-1\]\.evidence_ids.*missing"):
        task.with_record(
            api["Belief"](
                record_id="belief-1",
                statement="Unsupported belief",
                confidence=0.5,
                evidence_ids=("missing",),
            )
        )


def test_hypothesis_without_evidence_remains_explicitly_unverified():
    api = _ir_api()
    task = api["AgentTaskIR"].create("Investigate", task_id="task-hypothesis")

    task = task.with_record(
        api["Hypothesis"](
            record_id="hypothesis-1",
            statement="A cache race may exist",
            confidence=0.25,
        )
    )

    hypothesis = task.record("hypothesis-1")
    assert hypothesis.kind == "hypothesis"
    assert hypothesis.status == "proposed"
    assert hypothesis.evidence_ids == ()


@pytest.mark.parametrize("confidence", [-0.01, 1.01])
def test_confidence_outside_unit_interval_is_rejected(confidence):
    api = _ir_api()
    task = api["AgentTaskIR"].create("Validate bounds", task_id="task-bounds")

    with pytest.raises(api["IRValidationError"], match=r"hypotheses\[hypothesis-1\]\.confidence"):
        task.with_record(
            api["Hypothesis"](
                record_id="hypothesis-1",
                statement="Invalid confidence",
                confidence=confidence,
            )
        )


def test_duplicate_record_identifier_is_rejected_across_kinds():
    api = _ir_api()
    task = api["AgentTaskIR"].create("Unique ids", task_id="task-ids")
    task = task.with_record(api["Goal"](record_id="shared-1", description="Goal"))

    with pytest.raises(api["IRValidationError"], match=r"records\[shared-1\].*duplicate"):
        task.with_record(
            api["Hypothesis"](
                record_id="shared-1",
                statement="Collision",
                confidence=0.5,
            )
        )


def test_unknown_namespaced_extensions_survive_round_trip():
    api = _ir_api()
    task = api["AgentTaskIR"].create(
        "Forward compatibility",
        task_id="task-extension",
        extensions={"com.example.future": {"strategy": "new", "weight": 3}},
    ).with_record(
        api["Evidence"](
            record_id="evidence-1",
            summary="Observed",
            source="tool:read",
            extensions={"com.example.lineage": {"node": "n1"}},
        )
    )

    restored = api["AgentTaskIR"].from_dict(task.to_dict())

    assert restored.extensions == task.extensions
    assert restored.record("evidence-1").extensions == {
        "com.example.lineage": {"node": "n1"}
    }


def test_unknown_governed_risk_level_is_rejected_on_load():
    api = _ir_api()
    task = api["AgentTaskIR"].create("Risk validation", task_id="task-risk")
    payload = task.to_dict()
    payload["records"] = [
        {
            "kind": "action",
            "record_id": "action-1",
            "action_type": "write_file",
            "target": "src/core.py",
            "risk_level": "probably-safe",
        }
    ]
    payload["revision"] = 1

    with pytest.raises(api["IRValidationError"], match=r"actions\[action-1\]\.risk_level"):
        api["AgentTaskIR"].from_dict(payload)


def test_task_identifier_and_objective_are_validated():
    api = _ir_api()

    with pytest.raises(api["IRValidationError"], match="task_id"):
        api["AgentTaskIR"].create("Objective", task_id="../escape")
    with pytest.raises(api["IRValidationError"], match="objective"):
        api["AgentTaskIR"].create("  ", task_id="task-empty")
