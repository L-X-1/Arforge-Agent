from acceptance_service.repository import WorkItemRepository


def test_repository_round_trip(tmp_path):
    repository = WorkItemRepository(tmp_path / "items.db")
    repository.migrate()

    created = repository.create("  verify project depth  ")
    closed = repository.close(created.item_id)

    assert created.title == "verify project depth"
    assert closed is not None
    assert closed.status == "closed"
    assert repository.list_all() == [closed]
