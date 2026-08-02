"""OCR adapter availability checks."""

from __future__ import annotations

from pathlib import Path


def ocr_available() -> bool:
    try:
        import pytesseract  # noqa: F401

        return True
    except Exception:
        return False


def extract_text_from_image(path: str | Path) -> str:
    if not ocr_available():
        return "OCR dependency is not installed."
    try:
        from PIL import Image
        import pytesseract

        return pytesseract.image_to_string(Image.open(path))
    except Exception as exc:
        return f"OCR failed: {exc}"
