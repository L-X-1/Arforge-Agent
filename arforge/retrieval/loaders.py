"""文档解析 — 多格式 → 纯文本 + 元数据（企业级 RAG 摄入）。

支持：纯文本/代码/markdown、.json、.csv、.docx(python-docx)。
.pdf 需 pypdf（缺失时返回明确错误而非崩溃，便于降级）。
"""

from __future__ import annotations

import csv
import json
import os
from dataclasses import dataclass, field

_TEXT_EXTS = {
    ".txt", ".md", ".markdown", ".rst", ".log", ".text",
    ".py", ".js", ".ts", ".tsx", ".java", ".go", ".rs", ".c", ".cpp", ".h", ".hpp",
    ".cs", ".rb", ".php", ".kt", ".swift", ".scala",
    ".html", ".htm", ".css", ".sql", ".sh", ".bat", ".ps1",
    ".yaml", ".yml", ".toml", ".ini", ".cfg", ".env",
}


@dataclass
class RawDoc:
    text: str
    source: str
    doctype: str = "text"
    metadata: dict = field(default_factory=dict)


def _read_text(path: str) -> str:
    with open(path, encoding="utf-8", errors="replace") as f:
        return f.read()


def _read_json(path: str) -> str:
    with open(path, encoding="utf-8", errors="replace") as f:
        return json.dumps(json.load(f), ensure_ascii=False, indent=2)


def _read_csv(path: str) -> str:
    with open(path, encoding="utf-8", errors="replace", newline="") as f:
        return "\n".join(" | ".join(row) for row in csv.reader(f))


def _read_docx(path: str) -> str:
    try:
        import docx  # python-docx
    except Exception as exc:  # pragma: no cover
        raise RuntimeError("解析 .docx 需要 python-docx") from exc
    document = docx.Document(path)
    return "\n".join(p.text for p in document.paragraphs if p.text)


def _read_pdf(path: str) -> str:
    try:
        import pypdf
    except Exception as exc:
        raise RuntimeError("解析 .pdf 需要 pypdf（pip install pypdf）") from exc
    reader = pypdf.PdfReader(path)
    return "\n".join((page.extract_text() or "") for page in reader.pages)


_HANDLERS = {".json": ("json", _read_json), ".csv": ("csv", _read_csv), ".docx": ("docx", _read_docx), ".pdf": ("pdf", _read_pdf)}


def load_document(path: str) -> RawDoc:
    """解析单个文件 → RawDoc。未知扩展名尽量按文本读取。"""
    ext = os.path.splitext(path)[1].lower()
    if ext in _HANDLERS:
        doctype, handler = _HANDLERS[ext]
        text = handler(path)
    else:
        doctype, text = "text", _read_text(path)
    return RawDoc(text=text, source=path, doctype=doctype, metadata={"ext": ext})


def load_documents(paths) -> list[RawDoc]:
    """批量解析；单文件失败不影响其它（记录到 error 文档）。"""
    docs: list[RawDoc] = []
    for p in paths:
        try:
            docs.append(load_document(p))
        except Exception as exc:  # noqa: BLE001
            docs.append(RawDoc(text="", source=p, doctype="error", metadata={"error": str(exc)}))
    return docs


def load_directory(root: str, exts: set | None = None, max_files: int = 2000) -> list[RawDoc]:
    """递归解析目录下文件（可按扩展名过滤）。"""
    out: list[RawDoc] = []
    for dirpath, _dirs, files in os.walk(root):
        for fn in files:
            ext = os.path.splitext(fn)[1].lower()
            if exts is not None and ext not in exts:
                continue
            try:
                out.append(load_document(os.path.join(dirpath, fn)))
            except Exception as exc:  # noqa: BLE001
                out.append(RawDoc(text="", source=os.path.join(dirpath, fn), doctype="error", metadata={"error": str(exc)}))
            if len(out) >= max_files:
                return out
    return out


def load_text(text: str, source: str = "inline") -> RawDoc:
    """把内存中的字符串包装成 RawDoc。"""
    return RawDoc(text=text, source=source, doctype="text")
