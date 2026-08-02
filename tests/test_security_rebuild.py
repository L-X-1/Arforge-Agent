from pathlib import Path


def test_diff_generation_counts_changes():
    from arforge.security.diff_generator import generate_unified_diff

    result = generate_unified_diff(Path("demo.py"), "x = 1\n", "x = 2\n")

    assert result.has_changes
    assert result.stats.additions == 1
    assert result.stats.deletions == 1
    assert result.hunks


def test_safe_modify_file_writes_and_can_rollback(tmp_path):
    from arforge.security.diff_applicator import rollback_last_change
    from arforge.security.safe_modifier import safe_modify_file

    target = tmp_path / "sample.py"
    target.write_text("value = 1\n", encoding="utf-8")

    result = safe_modify_file(target, "value = 2\n", verify=True)

    assert result.success
    assert result.verification_status == "passed"
    assert target.read_text(encoding="utf-8") == "value = 2\n"

    rollback = rollback_last_change(target)

    assert rollback["success"]
    assert target.read_text(encoding="utf-8") == "value = 1\n"


def test_safe_modify_file_rolls_back_invalid_python(tmp_path):
    from arforge.security.safe_modifier import safe_modify_file

    target = tmp_path / "bad.py"
    target.write_text("value = 1\n", encoding="utf-8")

    result = safe_modify_file(target, "value = \n", verify=True, auto_rollback=True)

    assert not result.success
    assert result.verification_status == "failed"
    assert result.rolled_back
    assert target.read_text(encoding="utf-8") == "value = 1\n"
