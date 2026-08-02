def test_import_main_entrypoint():
    import main

    assert callable(main.main)


def test_arforge_public_db_path_uses_new_brand_namespace():
    import arforge

    assert ".arforge" in arforge.get_db_path()
    assert arforge.get_db_path().endswith("memory.db")


def test_arforge_cli_version(capsys):
    from arforge.cli import main

    assert main(["--version"]) == 0
    output = capsys.readouterr().out
    assert "Arforge Agent" in output


def test_arforge_doctor_checks_are_structured():
    from arforge.product.doctor import run_checks

    results = run_checks()
    assert results
    assert any(item.name == "Python" and item.ok for item in results)
    assert any(item.name == "Package versions" and item.ok for item in results)
    assert any(item.name == "Disk space" and item.ok for item in results)
    assert any(item.name == "Database configuration" for item in results)
