"""Multimodal adapters."""

from arforge.capability.multimodal.document_adapter import document_metadata, read_document_text
from arforge.capability.multimodal.image_adapter import inspect_image, is_image_file
from arforge.capability.multimodal.ocr_adapter import extract_text_from_image, ocr_available

__all__ = ["document_metadata", "read_document_text", "inspect_image", "is_image_file", "extract_text_from_image", "ocr_available"]
