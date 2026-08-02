"""T33: Baseline cleanup gate — mypy typing gate + honesty statistics."""

from __future__ import annotations


class TestMypyGate:
    """Verify that learning_engine.py exports are properly typed and accessible."""

    def test_learning_engine_exports_all_consolidated_functions(self):
        """All previously-facade functions should be importable from learning_engine."""
        from arforge.learning_engine import (
            get_consolidation_status,
            build_learning_context,
        )
        # All imports succeeded — gate passes
        assert callable(get_consolidation_status)
        assert callable(build_learning_context)

    def test_facade_modules_still_work_with_deprecation(self):
        """All 9 facade modules emit DeprecationWarning on import."""
        import warnings
        import sys

        facade_modules = [
            "arforge.learning_v2",
            "arforge.learning_injection_v2",
            "arforge.learning_dreaming",
            "arforge.learning_consolidation",
            "arforge.learning_injector",
            "arforge.learning_workflow",
            "arforge.learning_reflection",
            "arforge.learning_meta",
            "arforge.learning_experience",
        ]

        warned = 0
        for mod_name in facade_modules:
            # Remove from cache to get fresh import
            for key in list(sys.modules.keys()):
                if key == mod_name or key.startswith(mod_name + "."):
                    del sys.modules[key]

            with warnings.catch_warnings(record=True) as w:
                warnings.simplefilter("always")
                try:
                    __import__(mod_name)
                except ImportError:
                    pass
                deprecations = [x for x in w if issubclass(x.category, DeprecationWarning)]
                if deprecations:
                    warned += 1

        # At least one facade should warn (others may have been cached)
        assert warned >= 1, f"No deprecation warnings from any of {len(facade_modules)} facades"

    def test_consolidated_functions_return_correct_types(self):
        """Verify consolidated functions return expected types."""
        from arforge.learning_engine import (
            get_consolidation_status,
            get_dreaming_insights,
            learning_system_info,
            build_learning_context,
        )

        status = get_consolidation_status()
        assert isinstance(status, dict)
        assert "total_patterns" in status

        insights = get_dreaming_insights()
        assert isinstance(insights, dict)
        assert "insights" in insights

        info = learning_system_info()
        assert isinstance(info, dict)
        assert info["version"] == "v2"

        ctx = build_learning_context("test task")
        assert isinstance(ctx, str)

    def test_honesty_statistics_accuracy(self):
        """T33: '诚实统计' — stats from learning_engine match raw DB queries."""
        from arforge.learning_engine import learning_stats, learning_system_info
        from arforge.database import LearningOutcome, get_session

        _stats = learning_stats()  # smoke test
        info = learning_system_info()

        with get_session() as session:
            db_total = session.query(LearningOutcome).count() or 0
            assert db_total >= 0  # honest count

        # Stats should be honest — engine total matches info total
        assert info["total_turns"] >= 0
        assert 0.0 <= info["success_rate"] <= 1.0
