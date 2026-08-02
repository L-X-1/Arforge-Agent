from __future__ import annotations

from pathlib import Path
import tempfile

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .repository import WorkItemRepository


class CreateWorkItem(BaseModel):
    title: str = Field(min_length=1, max_length=200)


def create_app(database: str | Path | None = None) -> FastAPI:
    resolved = Path(database or Path(tempfile.gettempdir()) / "arforge-acceptance.db")
    repository = WorkItemRepository(resolved)
    repository.migrate()
    app = FastAPI(title="Arforge project-depth acceptance")

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/items", status_code=201)
    def create_item(payload: CreateWorkItem) -> dict[str, object]:
        try:
            item = repository.create(payload.title)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return item.__dict__

    @app.get("/items")
    def list_items() -> list[dict[str, object]]:
        return [item.__dict__ for item in repository.list_all()]

    @app.post("/items/{item_id}/close")
    def close_item(item_id: int) -> dict[str, object]:
        item = repository.close(item_id)
        if item is None:
            raise HTTPException(status_code=404, detail="work item not found")
        return item.__dict__

    return app
