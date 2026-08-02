from __future__ import annotations

from flask import Flask, jsonify, request

from .domain import normalize_title


def create_flask_app() -> Flask:
    app = Flask(__name__)
    items: list[dict[str, object]] = []

    @app.post("/items")
    def create_item():
        try:
            title = normalize_title((request.get_json(silent=True) or {}).get("title"))
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 422
        item = {"id": len(items) + 1, "title": title, "status": "open"}
        items.append(item)
        return jsonify(item), 201

    @app.get("/items")
    def list_items():
        return jsonify(items)

    return app
