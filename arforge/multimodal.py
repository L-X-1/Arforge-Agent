"""Multimodal facade — unified top-level import for image/OCR/document inspection.

Provides a clean public API:
  from arforge.multimodal import inspect_image, extract_ocr, read_document, is_supported
"""

from __future__ import annotations

from pathlib import Path


def inspect_image(file_path: str | Path) -> dict:
    """Inspect an image file — return width, height, format, mode.

    Falls back gracefully when PIL/Pillow is not installed.
    """
    path = Path(file_path)
    if not path.exists():
        return {"success": False, "error": f"文件不存在: {path}", "path": str(path)}

    suffix = path.suffix.lower()
    if suffix not in _SUPPORTED_IMAGE:
        return {"success": False, "error": f"不支持的图片格式: {suffix}", "supported": _SUPPORTED_IMAGE}

    try:
        from arforge.capability.multimodal.image_adapter import inspect_image as _im_inspect

        return _im_inspect(path)
    except ImportError:
        pass

    # Fallback: PIL
    try:
        from PIL import Image

        img = Image.open(path)
        return {
            "success": True,
            "path": str(path),
            "width": img.width,
            "height": img.height,
            "format": img.format or suffix,
            "mode": img.mode,
            "file_size": path.stat().st_size,
        }
    except ImportError:
        return {"success": False, "error": "PIL/Pillow 未安装。pip install Pillow", "path": str(path)}
    except Exception as e:
        return {"success": False, "error": f"图片读取失败: {e}", "path": str(path)}


def extract_ocr(file_path: str | Path, language: str = "chi_sim+eng") -> dict:
    """Extract text from an image via OCR.

    Tries pytesseract → easyocr → paddleocr in order.
    """
    path = Path(file_path)
    if not path.exists():
        return {"success": False, "error": f"文件不存在: {path}"}

    try:
        from arforge.capability.multimodal.ocr_adapter import extract_text_from_image as _ocr

        return _ocr(path)
    except ImportError:
        pass

    # Try pytesseract
    try:
        import pytesseract
        from PIL import Image

        img = Image.open(path)
        text = pytesseract.image_to_string(img, lang=language)
        return {"success": True, "text": text.strip(), "engine": "pytesseract", "path": str(path)}
    except ImportError:
        pass
    except Exception as e:
        return {"success": False, "error": f"OCR 失败: {e}", "engine": "pytesseract"}

    return {"success": False, "error": "未安装 OCR 引擎。pip install pytesseract", "path": str(path)}


def read_document(file_path: str | Path, max_chars: int = 5000) -> dict:
    """Read and extract text from PDF/Word/Excel documents."""
    path = Path(file_path)
    if not path.exists():
        return {"success": False, "error": f"文件不存在: {path}"}

    try:
        from arforge.capability.multimodal.document_adapter import read_document_text as _doc_read, document_metadata as _doc_meta

        meta = _doc_meta(path)
        text = _doc_read(path, max_chars=max_chars)
        return {"success": True, **meta, "text_preview": text[:max_chars], "text_length": len(text)}
    except ImportError:
        pass

    suffix = path.suffix.lower()
    if suffix in {".txt", ".md", ".rst"}:
        text = path.read_text(encoding="utf-8", errors="replace")
        return {"success": True, "format": suffix, "text_preview": text[:max_chars], "text_length": len(text)}

    # Fallback: try pypdf / python-docx / openpyxl
    if suffix == ".pdf":
        try:
            from pypdf import PdfReader
            reader = PdfReader(str(path))
            text = "\n".join(page.extract_text() or "" for page in reader.pages[:20])
            return {"success": True, "format": "pdf", "pages": len(reader.pages), "text_preview": text[:max_chars], "text_length": len(text)}
        except ImportError:
            return {"success": False, "error": "pypdf 未安装。pip install pypdf"}

    if suffix == ".docx":
        try:
            from docx import Document
            doc = Document(str(path))
            text = "\n".join(p.text for p in doc.paragraphs[:100])
            return {"success": True, "format": "docx", "text_preview": text[:max_chars], "text_length": len(text)}
        except ImportError:
            return {"success": False, "error": "python-docx 未安装。pip install python-docx"}

    return {"success": False, "error": f"不支持的文档格式: {suffix}", "supported": [".pdf", ".docx", ".txt", ".md", ".rst"]}


def is_supported(file_path: str | Path) -> bool:
    """Check if the file type is supported by any multimodal adapter."""
    suffix = Path(file_path).suffix.lower()
    return suffix in _SUPPORTED_IMAGE or suffix in _SUPPORTED_DOC


def ocr_available() -> bool:
    """Check if any OCR engine is installed."""
    for engine in ["pytesseract", "easyocr", "paddleocr"]:
        try:
            __import__(engine)
            return True
        except ImportError:
            continue
    return False


_SUPPORTED_IMAGE = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tiff"}
_SUPPORTED_DOC = {".pdf", ".docx", ".xlsx", ".xls", ".txt", ".md", ".rst"}
