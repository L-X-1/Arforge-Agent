"""Map source files to tests."""

from __future__ import annotations

from pathlib import Path


def index_test_mappings() -> dict:
    return {"success": True, "mappings": len(list_test_mappings())}


def list_test_files() -> list[str]:
    return [str(path) for path in Path("tests").glob("test_*.py")]


def list_test_mappings():
    mappings = []
    sources = [(source, source.stem) for source in Path("arforge").rglob("*.py")]
    for test in list_test_files():
        stem = Path(test).stem.replace("test_", "")
        for source, source_stem in sources:
            if stem in source_stem or source_stem in stem:
                mappings.append({"test": test, "source": str(source)})
    return mappings


def list_tests_for_file(source_file_path: str):
    return [item for item in list_test_mappings() if item["source"].endswith(source_file_path)]


def recommend_tests_for_file(source_file_path: str):
    matches = list_tests_for_file(source_file_path)
    return matches or [{"source": source_file_path, "recommendation": "Add a focused tests/test_<module>.py"}]


def list_test_recommendations(limit: int = 20):
    return [recommend_tests_for_file(str(path))[0] for path in list(Path("arforge").rglob("*.py"))[:limit]]
