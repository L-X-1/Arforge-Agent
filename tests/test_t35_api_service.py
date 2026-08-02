"""Tests for FastAPI service (T35)."""

import asyncio

import pytest
from fastapi.testclient import TestClient

from arforge.api_service import app

client = TestClient(app)
TOKEN = "test-token-that-is-at-least-thirty-two-characters"


@pytest.fixture(autouse=True)
def enabled_authenticated_proxy(monkeypatch):
    monkeypatch.setenv("ARFORGE_ENABLE_HTTP_API", "1")
    monkeypatch.setenv("ARFORGE_ENABLE_RAW_MODEL_API", "1")
    monkeypatch.setenv("ARFORGE_API_TOKEN", TOKEN)


def auth_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {TOKEN}"}


class TestHealth:
    def test_health_returns_ok(self):
        response = client.get("/health")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"
        assert "version" in data
        assert data["api_enabled"] is True

    def test_health_reports_disabled_without_provider_details(self, monkeypatch):
        monkeypatch.delenv("ARFORGE_ENABLE_HTTP_API")
        response = client.get("/health")
        data = response.json()
        assert response.status_code == 200
        assert data["status"] == "disabled"
        assert data["api_enabled"] is False
        assert "provider" not in data
        assert "providers_available" not in data

    def test_providers_list(self):
        response = client.get("/providers", headers=auth_headers())
        assert response.status_code == 200
        data = response.json()
        assert "providers" in data
        assert "deepseek" in data["providers"]


class TestChat:
    def test_chat_empty_message_rejected(self):
        response = client.post("/chat", json={"message": ""}, headers=auth_headers())
        assert response.status_code == 422

    def test_chat_missing_message_rejected(self):
        response = client.post("/chat", json={}, headers=auth_headers())
        assert response.status_code == 422

    def test_chat_invalid_provider_rejected(self):
        response = client.post(
            "/chat",
            json={"message": "hello", "provider": "nonexistent_xyz"},
            headers=auth_headers(),
        )
        assert response.status_code == 400
        body = response.json()
        msg = body.get("error", body.get("detail", ""))
        assert "Unsupported" in str(msg)

    def test_chat_message_too_long_rejected(self):
        response = client.post("/chat", json={"message": "x" * 20000}, headers=auth_headers())
        assert response.status_code == 422

    def test_chat_uses_the_secure_runtime_adapter(self, monkeypatch):
        from arforge.api_service import ChatRequest, chat

        calls = []

        class Adapter:
            model_name = "configured-model"

            def generate(self, messages):
                calls.append(messages)
                return "configured response"

        class Runtime:
            def create_adapter(self, provider_id=None):
                calls.append(provider_id)
                return Adapter()

            def get_active_provider(self):
                return "openai"

        monkeypatch.setattr(
            "arforge.product.model_config_runtime.get_model_config",
            lambda: Runtime(),
        )

        response = asyncio.run(chat(ChatRequest(message="hello")))

        assert response.provider == "openai"
        assert response.model == "configured-model"
        assert calls == [None, [{"role": "user", "content": "hello"}]]

    def test_provider_failure_does_not_leak_exception_detail(self, monkeypatch):
        class Adapter:
            def generate(self, _messages):
                raise RuntimeError("secret-upstream-detail")

        class Runtime:
            def create_adapter(self, provider_id=None):
                return Adapter()

            def get_active_provider(self):
                return "openai"

        monkeypatch.setattr(
            "arforge.product.model_config_runtime.get_model_config",
            lambda: Runtime(),
        )
        response = client.post("/chat", json={"message": "hello"}, headers=auth_headers())
        assert response.status_code == 502
        assert "secret-upstream-detail" not in response.text


class TestStreaming:
    def test_stream_endpoint_accepts_request(self, monkeypatch):
        class Chunk:
            text = "hello"

        class Adapter:
            def stream_generate(self, messages):
                assert messages == [{"role": "user", "content": "hello"}]
                yield Chunk()

        class Runtime:
            def create_adapter(self, provider_id=None):
                assert provider_id == "deepseek"
                return Adapter()

        monkeypatch.setattr("arforge.product.model_config_runtime.get_model_config", lambda: Runtime())
        response = client.post(
            "/chat/stream",
            json={"message": "hello", "provider": "deepseek"},
            headers=auth_headers(),
        )
        # Should return SSE
        assert response.status_code == 200
        assert "text/event-stream" in response.headers["content-type"]

    def test_stream_invalid_provider_rejected(self):
        response = client.post(
            "/chat/stream",
            json={"message": "hello", "provider": "invalid"},
            headers=auth_headers(),
        )
        assert response.status_code == 400


class TestServiceStructure:
    def test_non_health_routes_fail_closed_without_enablement(self, monkeypatch):
        monkeypatch.delenv("ARFORGE_ENABLE_HTTP_API")
        response = client.get("/providers", headers=auth_headers())
        assert response.status_code == 503
        assert response.json()["code"] == "API_DISABLED"

    def test_non_health_routes_require_bearer_token(self):
        response = client.get("/providers")
        assert response.status_code == 401
        assert response.json()["code"] == "UNAUTHORIZED"

    def test_raw_model_routes_require_separate_opt_in(self, monkeypatch):
        monkeypatch.delenv("ARFORGE_ENABLE_RAW_MODEL_API")
        response = client.post("/chat", json={"message": "hello"}, headers=auth_headers())
        assert response.status_code == 503

    def test_all_routes_registered(self):
        routes = {r.path for r in app.routes if hasattr(r, "path")}
        assert "/health" in routes
        assert "/providers" in routes
        assert "/chat" in routes
        assert "/chat/stream" in routes
        assert "/docs" in routes

    def test_cors_middleware_configured(self):
        cors = next(middleware for middleware in app.user_middleware if middleware.cls.__name__ == "CORSMiddleware")
        assert cors.kwargs["allow_origins"] == []
        assert cors.kwargs["allow_credentials"] is False
        assert cors.kwargs["allow_methods"] == ["GET", "POST"]
        assert cors.kwargs["allow_headers"] == ["Authorization", "Content-Type"]
