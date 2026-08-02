from pathlib import Path


def test_runtime_packages_do_not_use_recovery_bytecode_loaders():
    root = Path(__file__).resolve().parents[1]
    offenders = []
    for path in (root / "arforge").rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        if "Recovered loader stub" in text or ".recovery_pyc" in text or "marshal.loads" in text:
            offenders.append(str(path.relative_to(root)))

    assert offenders == []


def test_arforge_has_no_source_skeleton_modules():
    root = Path(__file__).resolve().parents[1]
    offenders = []
    for path in (root / "arforge").rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        if '__rebuild_status__ = "source_skeleton"' in text:
            offenders.append(str(path.relative_to(root)))

    assert offenders == []
