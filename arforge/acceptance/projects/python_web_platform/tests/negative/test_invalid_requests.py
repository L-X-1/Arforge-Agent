from django.test import Client

from web_platform.django_app import reset_items
from web_platform.flask_app import create_flask_app


def test_frameworks_reject_blank_titles_without_mutation():
    reset_items()
    django_client = Client()
    assert (
        django_client.post(
            "/items",
            data='{"title":"   "}',
            content_type="application/json",
        ).status_code
        == 422
    )
    assert django_client.get("/items").json() == []

    flask_client = create_flask_app().test_client()
    assert flask_client.post("/items", json={"title": "   "}).status_code == 422
    assert flask_client.get("/items").get_json() == []
