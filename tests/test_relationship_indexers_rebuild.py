def test_dependency_import_and_call_graphs():
    from arforge.call_graph import index_call_graph, list_call_graph
    from arforge.dependency_graph import index_dependencies, list_dependency_graph
    from arforge.import_resolver import build_import_bindings, list_import_bindings

    assert index_dependencies()["dependencies"] > 0
    assert list_dependency_graph(limit=5)
    assert build_import_bindings()["bindings"] > 0
    assert list_import_bindings(limit=5)
    assert index_call_graph()["calls"] > 0
    assert list_call_graph(limit=5)


def test_reference_symbol_class_and_type_indexes():
    from arforge.class_relationship_indexer import index_class_relationships, list_class_relationships
    from arforge.reference_indexer import find_references, index_references
    from arforge.symbol_resolver import resolve_symbol_call
    from arforge.type_instance_resolver import index_type_instances, list_variable_types

    assert index_references()["references"] > 0
    assert find_references("ArforgeAgent")
    assert resolve_symbol_call("ArforgeAgent") is not None
    assert index_class_relationships()["classes"] > 0
    assert list_class_relationships(limit=5)
    assert index_type_instances()["variables"] >= 0
    assert isinstance(list_variable_types(limit=5), list)


def test_dirty_files_test_mapping_and_impact():
    from arforge.dirty_file_registry import clear_dirty_history, dirty_file_status, list_dirty_files, mark_dirty, resolve_all_dirty_files
    from arforge.impact_analyzer import analyze_symbol_impact
    from arforge.test_mapping_indexer import list_test_files, recommend_tests_for_file

    clear_dirty_history()
    mark_dirty("arforge/example.py", "test")

    assert dirty_file_status()["dirty"] == 1
    assert list_dirty_files()
    assert resolve_all_dirty_files()["resolved"] == 1
    assert list_test_files()
    assert recommend_tests_for_file("agent_core.py")
    assert "references" in analyze_symbol_impact("ArforgeAgent")
