def test_config_api_directory_and_architecture_indexes():
    from arforge.api_route_indexer import api_route_status, list_api_routes
    from arforge.config_environment_indexer import config_environment_status, list_config_files
    from arforge.directory_metadata import build_directory_metadata, list_directory_metadata
    from arforge.project_architecture_analyzer import analyze_project_architecture

    assert config_environment_status()["config_files"] >= 1
    assert "pyproject.toml" in list_config_files()
    assert "routes" in api_route_status()
    assert isinstance(list_api_routes(), list)
    assert build_directory_metadata()["items"] > 0
    assert list_directory_metadata()
    assert analyze_project_architecture()["count"] > 0


def test_database_schema_and_error_patterns():
    from arforge.database_schema_indexer import index_database_schema, list_database_tables
    from arforge.error_pattern_indexer import analyze_error_text, list_error_patterns, record_error_log

    assert "tables" in index_database_schema()
    assert isinstance(list_database_tables(), list)
    assert analyze_error_text("SyntaxError: bad")["type"] == "syntax"
    record_error_log("ImportError: missing")
    assert list_error_patterns()
