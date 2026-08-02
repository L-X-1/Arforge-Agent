"""Image metadata adapter."""

from __future__ import annotations

from pathlib import Path


def inspect_image(path: str | Path) -> dict:
    image = Path(path)
    result = {"path": str(image), "exists": image.exists(), "bytes": image.stat().st_size if image.exists() else 0}
    try:
        from PIL import Image

        with Image.open(image) as img:
            result.update({"width": img.width, "height": img.height, "format": img.format})
    except Exception as exc:
        result["error"] = str(exc)
    return result


def is_image_file(path: str | Path) -> bool:
    return Path(path).suffix.lower() in {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"}
