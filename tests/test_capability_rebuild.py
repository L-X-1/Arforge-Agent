def test_capability_registry_and_router_find_defaults():
    from arforge.capability.capability_router import capability_names_for
    from arforge.capability.capability_registry import get_capability

    names = capability_names_for("please plan this task")

    assert "planning" in names
    assert get_capability("planning") is not None


def test_capability_engine_runs_planning():
    from arforge.capability.enhancement_engine import run_capability_enhancement

    context = run_capability_enhancement("plan module rebuild")

    assert context.capability_results
    assert context.capability_results[0].success
    assert context.evidence


def test_evidence_fusion_and_security_audit():
    from arforge.capability.evidence_builder import build_evidence
    from arforge.capability.evidence_fusion import fuse_evidence
    from arforge.capability.security_audit import audit_command

    fused = fuse_evidence([build_evidence("test", "content", 0.9)])

    assert fused["items"][0]["source"] == "test"
    assert not audit_command("rm -rf /")["safe"]
