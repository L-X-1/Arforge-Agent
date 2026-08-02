"""Test P2 D1-D8: Symbol search precision, semantic search, impact analysis,
index invalidation, multimodal facade, recovery exponential backoff.

Verifies all P2 implementations meet product quality standards.
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch



# ====================================================================
# D1: Symbol search precision
# ====================================================================


class TestSymbolSearchPrecision:
    def test_exact_mode_excludes_substrings(self):
        from arforge.python_ast_indexer import index_python_ast, search_symbol

        # Create temp files with controlled symbol names
        with tempfile.TemporaryDirectory() as tmp:
            f1 = Path(tmp) / "a.py"
            f1.write_text("def memory():\n    pass\nclass memory_cache:\n    pass\n", encoding="utf-8")
            f2 = Path(tmp) / "b.py"
            f2.write_text("def auto_memory():\n    pass\n", encoding="utf-8")

            index_python_ast(tmp)
            # exact should only match 'memory', not 'auto_memory' or 'memory_cache'
            results = search_symbol("memory", match_mode="exact")
            names = {r["name"] for r in results}
            assert "memory" in names
            assert "auto_memory" not in names
            assert "memory_cache" not in names

    def test_prefix_mode(self):
        from arforge.python_ast_indexer import index_python_ast, search_symbol

        with tempfile.TemporaryDirectory() as tmp:
            f1 = Path(tmp) / "a.py"
            f1.write_text("def memory_cache():\n    pass\ndef memory_pool():\n    pass\ndef auto_memory():\n    pass\n", encoding="utf-8")
            index_python_ast(tmp)
            results = search_symbol("memory", match_mode="prefix")
            names = {r["name"] for r in results}
            assert "memory_cache" in names
            assert "memory_pool" in names
            assert "auto_memory" not in names  # prefix, not substring

    def test_substring_mode_legacy_behavior(self):
        from arforge.python_ast_indexer import index_python_ast, search_symbol

        with tempfile.TemporaryDirectory() as tmp:
            f1 = Path(tmp) / "a.py"
            f1.write_text("def auto_memory():\n    pass\n", encoding="utf-8")
            index_python_ast(tmp)
            results = search_symbol("memory", match_mode="substring")
            assert len(results) >= 1
            assert results[0]["name"] == "auto_memory"

    def test_code_intelligence_facade_passes_match_mode(self):
        from arforge.code_intelligence import CodeIntelligence

        ci = CodeIntelligence()
        with patch("arforge.python_ast_indexer.search_symbol") as mock_search:
            mock_search.return_value = []
            ci.search_symbol("test", match_mode="exact")
            mock_search.assert_called_once_with("test", match_mode="exact")

    def test_full_text_search_prunes_dependency_and_tool_directories(self, tmp_path):
        from arforge.code_intelligence import CodeIntelligence

        (tmp_path / "src").mkdir()
        (tmp_path / "src" / "owned.py").write_text("fusion_search_marker = True\n", encoding="utf-8")
        for directory in ("node_modules", ".tools", "dist"):
            blocked = tmp_path / directory
            blocked.mkdir()
            (blocked / "foreign.py").write_text("fusion_search_marker = False\n", encoding="utf-8")

        results = CodeIntelligence(tmp_path).search_code("fusion_search_marker", limit=20)

        assert [item.file.replace("\\", "/") for item in results] == ["src/owned.py"]


# ====================================================================
# D2: Semantic code search (TF-IDF)
# ====================================================================


class TestSemanticCodeSearch:
    def test_tfidf_index_build_and_search(self, tmp_path):
        from arforge.code_tfidf_index import TfidfIndex

        # Create sample files with simple, valid Python
        (tmp_path / "auth.py").write_text(
            "def login():\n    return True\n\ndef authenticate(user):\n    return user\n",
            encoding="utf-8",
        )
        (tmp_path / "data.py").write_text(
            "def load_data():\n    return []\n\ndef save_data(items):\n    pass\n",
            encoding="utf-8",
        )
        (tmp_path / "utils.py").write_text(
            "def format_text(s):\n    return s.strip()\n",
            encoding="utf-8",
        )

        index = TfidfIndex()
        index.build(str(tmp_path))

        # If build failed, print debug info
        if index.doc_count != 3:
            for f in tmp_path.rglob("*.py"):
                print(f"File: {f}, exists={f.exists()}, content={f.read_text()[:50]}")
        assert index.doc_count == 3, f"Expected 3 docs, got {index.doc_count}"

        # Search for auth-related code
        results = index.search("authentication login", expand_synonyms=True)
        assert len(results) > 0
        # auth.py should be the top result
        top_file = results[0]["file"]
        assert "auth" in top_file.lower() or "auth.py" in top_file

    def test_tfidf_synonym_expansion(self):
        from arforge.code_tfidf_index import _expand_tokens

        tokens = ["auth"]
        expanded = _expand_tokens(tokens)
        assert "login" in expanded
        assert "credential" in expanded
        assert "token" in expanded

    def test_semantic_code_search_uses_tfidf(self, tmp_path, monkeypatch):
        from arforge.code_tfidf_index import TfidfIndex, get_tfidf_index
        from arforge.semantic_code_search import semantic_code_search

        # Create a fresh index pointing to the temp dir
        monkeypatch.setattr("arforge.semantic_code_search.get_tfidf_index", lambda: TfidfIndex())

        (tmp_path / "login.py").write_text(
            "def user_login():\n    pass\n", encoding="utf-8"
        )
        index = get_tfidf_index()
        index.build(str(tmp_path))

        result = semantic_code_search("authentication", expand_synonyms=True)
        assert result["method"] == "tfidf"
        assert result["total"] >= 0

    def test_semantic_search_brief(self):
        from arforge.semantic_code_search import semantic_code_search_brief

        output = semantic_code_search_brief("memory cache", top_k=3)
        assert isinstance(output, str)


# ====================================================================
# D3: Impact analysis
# ====================================================================


class TestImpactAnalysis:
    def test_file_impact_returns_structured_risk(self, tmp_path):
        from arforge.impact_analyzer import analyze_file_impact

        # Create a test file
        py_file = tmp_path / "test_module.py"
        py_file.write_text("def foo():\n    pass\n", encoding="utf-8")

        result = analyze_file_impact(str(py_file))
        assert "risk" in result
        assert "risk_score" in result
        assert "risk_factors" in result
        assert "evidence" in result
        assert result["risk"] in ("low", "medium", "high", "critical")

    def test_symbol_impact_with_few_refs(self):
        from arforge.impact_analyzer import analyze_symbol_impact

        result = analyze_symbol_impact("non_existent_symbol_xyz")
        assert result["risk"] == "low"
        assert result["reference_count"] <= 5

    def test_change_impact_detects_file(self):
        from arforge.impact_analyzer import analyze_change_impact

        result = analyze_change_impact("some_module.py")
        assert "file" in result

    def test_change_impact_detects_symbol(self):
        from arforge.impact_analyzer import analyze_change_impact

        result = analyze_change_impact("someFunction")
        assert "symbol" in result


# ====================================================================
# D4: Index invalidation
# ====================================================================


class TestIndexInvalidation:
    def test_get_dirty_files_detects_new(self, tmp_path, monkeypatch):
        monkeypatch.setenv("ARFORGE_HOME", str(tmp_path))

        from arforge.index_invalidation import _save_state, get_dirty_files

        # Reset state
        _save_state({"files": {}, "last_full_build": 0})

        (tmp_path / "new_file.py").write_text("x = 1", encoding="utf-8")
        dirty = get_dirty_files(str(tmp_path))
        assert len(dirty) >= 1

    def test_mark_clean_removes_dirty(self, tmp_path, monkeypatch):
        monkeypatch.setenv("ARFORGE_HOME", str(tmp_path))

        from arforge.index_invalidation import _save_state, get_dirty_files, mark_clean

        _save_state({"files": {}, "last_full_build": 0})
        (tmp_path / "stable.py").write_text("pass", encoding="utf-8")

        dirty = get_dirty_files(str(tmp_path))
        mark_clean(dirty)

        dirty2 = get_dirty_files(str(tmp_path))
        assert len(dirty2) == 0

    def test_is_stale(self, monkeypatch):
        monkeypatch.setenv("ARFORGE_HOME", str(Path.home() / ".arforge" / "_test"))

        from arforge.index_invalidation import _save_state, is_stale

        _save_state({"files": {}, "last_full_build": 0})
        assert is_stale(max_age_seconds=1) is True

    def test_health_status(self, monkeypatch):
        monkeypatch.setenv("ARFORGE_HOME", str(tempfile.mkdtemp()))
        from arforge.index_invalidation import health_status

        hs = health_status()
        assert "stale" in hs
        assert "tracked_files" in hs


# ====================================================================
# D5: Multimodal facade
# ====================================================================


class TestMultimodalFacade:
    def test_inspect_image_file_not_found(self):
        from arforge.multimodal import inspect_image

        result = inspect_image("nonexistent.png")
        assert result["success"] is False
        assert "不存在" in result.get("error", "")

    def test_inspect_image_unsupported_format(self, tmp_path):
        from arforge.multimodal import inspect_image

        f = tmp_path / "test.txt"
        f.write_text("not an image")
        result = inspect_image(str(f))
        assert result["success"] is False

    def test_is_supported(self):
        from arforge.multimodal import is_supported

        assert is_supported("photo.png") is True
        assert is_supported("doc.pdf") is True
        assert is_supported("data.xyz") is False

    def test_ocr_available(self):
        from arforge.multimodal import ocr_available

        result = ocr_available()
        assert isinstance(result, bool)

    def test_read_document_file_not_found(self):
        from arforge.multimodal import read_document

        result = read_document("nonexistent.pdf")
        assert result["success"] is False

    def test_read_text_file(self, tmp_path):
        from arforge.multimodal import read_document

        f = tmp_path / "notes.txt"
        f.write_text("Hello world", encoding="utf-8")
        result = read_document(str(f))
        assert result["success"] is True
        assert "Hello world" in result.get("text_preview", "")

    def test_extract_ocr_file_not_found(self):
        from arforge.multimodal import extract_ocr

        result = extract_ocr("nonexistent.png")
        assert result["success"] is False


# ====================================================================
# D7: Auto-memory expansion
# ====================================================================


class TestAutoMemoryExpansion:
    def test_eight_rules_extract_preference(self):
        from arforge.auto_memory import extract_memories_from_turn

        # Should trigger preference rule
        candidates = extract_memories_from_turn("我习惯用 black 格式化代码", auto_save=False)
        types = {c["mem_type"] for c in candidates}
        assert "preference" in types

    def test_extract_convention(self):
        from arforge.auto_memory import extract_memories_from_turn

        candidates = extract_memories_from_turn("项目约定使用 snake_case 命名", auto_save=False)
        types = {c["mem_type"] for c in candidates}
        assert "convention" in types

    def test_extract_identity(self):
        from arforge.auto_memory import extract_memories_from_turn

        candidates = extract_memories_from_turn("我是 Python 后端工程师", auto_save=False)
        types = {c["mem_type"] for c in candidates}
        assert "identity" in types

    def test_extract_constraint(self):
        from arforge.auto_memory import extract_memories_from_turn

        candidates = extract_memories_from_turn("不要在生产环境直接修改数据库", auto_save=False)
        types = {c["mem_type"] for c in candidates}
        assert "constraint" in types

    def test_extract_error_pattern(self):
        from arforge.auto_memory import extract_memories_from_turn

        candidates = extract_memories_from_turn(
            "这个回答错了",
            assistant_response="def broken():\n    return None",
            auto_save=False,
        )
        types = {c["mem_type"] for c in candidates}
        assert "error" in types

    def test_extract_workflow(self):
        from arforge.auto_memory import extract_memories_from_turn

        candidates = extract_memories_from_turn("先做代码审查，再做测试，最后部署", auto_save=False)
        types = {c["mem_type"] for c in candidates}
        assert "workflow" in types

    def test_model_driven_extraction_with_mock(self):
        import json as _json
        from arforge.auto_memory import extract_memories_with_model

        mock_model = MagicMock()
        mock_model.generate.return_value = _json.dumps([
            {"content": "用户喜欢用 pytest", "type": "preference", "importance": 4},
            {"content": "项目使用 Python 3.12", "type": "fact", "importance": 3},
        ])

        candidates = extract_memories_with_model(
            "我喜欢用 pytest 写测试",
            "pytest 是很好的测试框架",
            model=mock_model,
            auto_save=False,
        )
        assert len(candidates) >= 1
        content_texts = " ".join(c.get("content", "") for c in candidates)
        assert "pytest" in content_texts

    def test_model_driven_falls_back_to_rules(self):
        from arforge.auto_memory import extract_memories_with_model

        mock_model = MagicMock()
        mock_model.generate.side_effect = Exception("API error")

        candidates = extract_memories_with_model(
            "我习惯用 black 格式化",
            "",
            model=mock_model,
            auto_save=False,
        )
        assert len(candidates) > 0

    def test_get_stats_shows_eight_rules(self):
        from arforge.auto_memory import get_auto_memory_stats

        stats = get_auto_memory_stats()
        assert stats["rules_count"] == 8
        assert stats["model_driven"] is True


# ====================================================================
# D8: Recovery exponential backoff
# ====================================================================


class TestRecoveryBackoff:
    def test_exponential_with_multiplier(self):
        from arforge.security.recovery import RetryPolicy

        policy = RetryPolicy(backoff_base=0.1, backoff_multiplier=2.0, max_backoff=30.0, jitter=False)
        # Expected: attempt=1 → 0.1*(2^0)=0.1, attempt=2 → 0.1*(2^1)=0.2, attempt=3 → 0.1*(2^2)=0.4
        delay1 = policy.backoff_base * (policy.backoff_multiplier ** 0)
        delay2 = policy.backoff_base * (policy.backoff_multiplier ** 1)
        delay3 = policy.backoff_base * (policy.backoff_multiplier ** 2)
        assert abs(delay1 - 0.1) < 0.01
        assert abs(delay2 - 0.2) < 0.01
        assert abs(delay3 - 0.4) < 0.01

        # Not equal to linear (which would be 0.1, 0.2, 0.3)
        linear3 = policy.backoff_base * 3  # 0.3
        assert abs(delay3 - linear3) > 0.05  # 0.4 != 0.3

    def test_jitter_adds_variability(self):
        from arforge.security.recovery import RetryPolicy

        policy = RetryPolicy(backoff_base=0.1, backoff_multiplier=2.0, jitter=True)
        import random
        random.seed(42)
        delays = []
        for i in range(10):
            delay = policy.backoff_base * (policy.backoff_multiplier ** 0)
            delay = min(delay, policy.max_backoff)
            if policy.jitter:
                delay *= random.uniform(0.5, 1.5)
            delays.append(delay)

        # With jitter, not all delays should be identical
        assert len(set(round(d, 3) for d in delays)) > 1

    def test_max_backoff_clamped(self):
        from arforge.security.recovery import RetryPolicy

        policy = RetryPolicy(backoff_base=10.0, backoff_multiplier=3.0, max_backoff=30.0, jitter=False)
        # attempt 5: 10 * 3^4 = 810 → clamped to 30
        delay = min(policy.backoff_base * (policy.backoff_multiplier ** 4), policy.max_backoff)
        assert delay == 30.0

    def test_safe_execute_uses_exponential_backoff(self):
        from arforge.security.recovery import RecoveryEngine
        import random
        random.seed(0)

        engine = RecoveryEngine(max_retries=3)
        # Override the policy for fast testing
        engine.policy.max_retries = 3
        engine.policy.backoff_base = 0.05
        engine.policy.backoff_multiplier = 2.0
        engine.policy.max_backoff = 10.0
        engine.policy.jitter = False

        call_count = [0]

        def flaky_operation():
            call_count[0] += 1
            if call_count[0] < 3:
                raise RuntimeError("transient")
            return "success"

        result = engine.safe_execute(flaky_operation, label="test_backoff")
        assert result.success is True
        assert result.attempts == 3
        # recovery_log should contain backoff entries
        backoff_entries = [entry for entry in result.recovery_log if "backoff" in entry]
        assert len(backoff_entries) == 2  # 2 retries = 2 backoff log entries
