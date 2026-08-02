from __future__ import annotations

import json

import django
from django.conf import settings
from django.http import JsonResponse
from django.urls import path
from django.views.decorators.csrf import csrf_exempt

from .domain import normalize_title

if not settings.configured:
    settings.configure(
        DEBUG=False,
        SECRET_KEY="acceptance-only",
        ROOT_URLCONF=__name__,
        ALLOWED_HOSTS=["testserver"],
        MIDDLEWARE=[],
    )
django.setup()

_items: list[dict[str, object]] = []


@csrf_exempt
def items(request):
    if request.method == "GET":
        return JsonResponse(_items, safe=False)
    try:
        payload = json.loads(request.body or b"{}")
        title = normalize_title(payload.get("title"))
    except (ValueError, json.JSONDecodeError) as exc:
        return JsonResponse({"error": str(exc)}, status=422)
    item = {"id": len(_items) + 1, "title": title, "status": "open"}
    _items.append(item)
    return JsonResponse(item, status=201)


urlpatterns = [path("items", items)]


def reset_items() -> None:
    _items.clear()
