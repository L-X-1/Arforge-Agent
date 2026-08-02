from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from arforge.web_control import WebEventBroker, create_web_control_app


TOKEN = "web-control-test-token-that-is-at-least-32-characters"


def test_web_control_requires_bearer_and_exposes_real_bridge_sessions(monkeypatch, tmp_path):
    monkeypatch.setenv("ARFORGE_HOME", str(tmp_path / "profile"))
    monkeypatch.chdir(tmp_path)
    app = create_web_control_app(workspace=tmp_path, token=TOKEN)

    with TestClient(app) as client:
        root = client.get("/")
        unauthorized = client.get("/api/health")
        headers = {"Authorization": f"Bearer {TOKEN}"}
        health = client.get("/api/health", headers=headers)
        created = client.post(
            "/api/bridge",
            headers=headers,
            json={"method": "session.create", "params": {}},
        )
        listed = client.post(
            "/api/bridge",
            headers=headers,
            json={"method": "session.list", "params": {"limit": 20, "archive": "exclude"}},
        )

    assert root.status_code == 200
    assert "Arforge 本地控制端" in root.text
    assert TOKEN not in root.text
    assert root.headers["x-frame-options"] == "DENY"
    assert unauthorized.status_code == 401
    assert unauthorized.json()["error"]["code"] == "UNAUTHORIZED"
    assert health.json()["data"]["workspace"] == str(tmp_path.resolve())
    assert created.json()["ok"] is True
    session_id = created.json()["data"]["session_id"]
    assert any(item["session_id"] == session_id for item in listed.json()["data"]["items"])


def test_web_control_rejects_large_requests_before_json_parsing(tmp_path):
    app = create_web_control_app(
        workspace=tmp_path,
        token=TOKEN,
        bundle=_FakeBundle(tmp_path),
    )
    with TestClient(app) as client:
        response = client.post(
            "/api/bridge",
            headers={
                "Authorization": f"Bearer {TOKEN}",
                "Content-Length": str(300 * 1024),
            },
            content=b"{}",
        )

    assert response.status_code == 413
    assert response.json()["error"]["code"] == "REQUEST_TOO_LARGE"


def test_web_event_broker_replays_only_matching_bounded_session_events():
    broker = WebEventBroker()
    broker.publish({"session_id": "one", "type": "answer.delta", "data": {"content": "a"}})
    broker.publish({"session_id": "two", "type": "answer.delta", "data": {"content": "b"}})
    broker.publish({"session_id": "one", "type": "operation.completed", "data": {}})

    backlog, subscriber = broker.subscribe(session_id="one", after_id=1)
    try:
        assert len(backlog) == 1
        assert backlog[0].payload["type"] == "operation.completed"
        broker.publish({"session_id": "one", "type": "assistant.note", "data": {"content": "next"}})
        assert subscriber.get_nowait().payload["type"] == "assistant.note"
    finally:
        broker.unsubscribe(subscriber)


class _FakeBundle:
    def __init__(self, workspace: Path):
        self.workspace = workspace.resolve()
        self.broker = WebEventBroker()

    def request(self, method, params):
        return {"protocol": "arforge.bridge", "version": "1.2", "id": 1, "ok": True, "data": {}}

    def close(self):
        raise AssertionError("injected bundles are not owned by the app")
