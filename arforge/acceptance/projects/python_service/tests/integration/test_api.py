from fastapi.testclient import TestClient

from acceptance_service.app import create_app


def test_create_list_and_close_work_item(tmp_path):
    client = TestClient(create_app(tmp_path / "api.db"))

    assert client.get("/health").json() == {"status": "ok"}
    created = client.post("/items", json={"title": "release acceptance"})
    assert created.status_code == 201
    item_id = created.json()["item_id"]

    listed = client.get("/items")
    assert listed.status_code == 200
    assert listed.json()[0]["title"] == "release acceptance"

    closed = client.post(f"/items/{item_id}/close")
    assert closed.status_code == 200
    assert closed.json()["status"] == "closed"
