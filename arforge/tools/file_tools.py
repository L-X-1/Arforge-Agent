"""Workspace file tools — safe read/write/list within workspace directory."""

from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

from arforge.core.file_state import get_file_state_tracker, snapshot_file
from arforge.security.file_ops import backup_file, request_confirmation, safe_delete, safe_read, safe_write, write_log
from arforge.tool_registry import (
    ParamSchema,
    REGISTRY,
    adapt_docx_request,
    adapt_filename,
    adapt_filename_content,
    match_read_file_request,
    register_tool,
)

# 工作区根目录：默认 ./workspace（安全沙箱）；用户可通过 ARFORGE_WORKSPACE 授权指向其它目录
# （如桌面），从而允许 agent 在该目录内真实操作文件。
#
# 特殊值（让 agent 直接在真实项目里干活）：
#   ARFORGE_WORKSPACE=.            → 工作区 = 当前工作目录（cwd）的绝对路径
#   ARFORGE_WORKSPACE=trust-cwd    → 同上（语义化别名，推荐用于 CI/自动化）
#   ARFORGE_WORKSPACE=<绝对路径>    → 工作区 = 该路径
# 不设置时仍回退到 ./workspace 沙箱，保持"开箱安全"默认。
_WORKSPACE_RAW = (os.environ.get("ARFORGE_WORKSPACE") or "").strip()
if _WORKSPACE_RAW in {".", "trust-cwd"}:
    # 信任当前目录：解析为绝对路径并在模块加载时冻结，后续 cwd 变化不影响沙箱边界。
    WORKSPACE = Path.cwd().resolve()
elif _WORKSPACE_RAW:
    WORKSPACE = Path(_WORKSPACE_RAW).expanduser()
else:
    WORKSPACE = Path.cwd() / "workspace"


def init_workspace() -> Path:
    workspace = get_workspace()
    workspace.mkdir(parents=True, exist_ok=True)
    return workspace


def set_workspace(path):
    """Override the active workspace root at runtime (used by eval / test runners)."""
    global WORKSPACE
    resolved = Path(path).resolve()
    WORKSPACE = resolved
    WORKSPACE.mkdir(parents=True, exist_ok=True)
    # Some plugin/test reload paths can retain a callable from a previous
    # module instance.  Keep the canonical sys.modules instance synchronized
    # so later dynamically resolved tools do not silently fall back to a stale
    # workspace.
    current = sys.modules.get("arforge.tools.file_tools")
    if current is not None and getattr(current, "WORKSPACE", None) != resolved:
        setattr(current, "WORKSPACE", resolved)


def get_workspace() -> Path:
    """Return the workspace bound to the current execution session."""
    from arforge.workspace_context import current_workspace

    return current_workspace(WORKSPACE)


_USER_HOME_DIRS = {"desktop", "documents", "downloads"}
_LIST_FILES_IGNORED_DIRS = {
    ".git",
    ".hg",
    ".mypy_cache",
    ".next",
    ".nuxt",
    ".pytest_cache",
    ".ruff_cache",
    ".svn",
    ".tox",
    ".turbo",
    ".venv",
    "__pycache__",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "target",
    "venv",
}
_LIST_FILES_LIMIT = 500


def _sandbox_mode() -> str:
    try:
        from arforge.core.permission import PermissionMode, get_permission_manager
        from arforge.core.runtime_sandbox import normalize_mode

        manager = get_permission_manager()
        if not manager.is_active():
            return "workspace-write"
        current = manager.get_mode()
        value = current.value if isinstance(current, PermissionMode) else current
        return normalize_mode(value).value
    except Exception:  # noqa: BLE001 - file tools must remain usable without permission hooks
        return "workspace-write"


def _write_requires_confirmation() -> bool:
    try:
        from arforge.core.permission import get_permission_manager

        manager = get_permission_manager()
        if not manager.is_active():
            return False
        return manager.decide("workspace_write") != "allow"
    except Exception:  # noqa: BLE001 - preserve the conservative fallback
        return True


def _uses_local_computer_paths() -> bool:
    return _sandbox_mode() in {"local-computer", "danger-full"}


_EDITABLE_WORKSPACE_SCRIPT_SUFFIXES = {".bat", ".cmd", ".ps1"}


def _resolve(filename: str, *, purpose: str = "read") -> Path:
    workspace = init_workspace()
    expanded = os.path.expandvars(os.path.expanduser(filename))
    path = Path(expanded)
    if not path.is_absolute():
        parts = path.parts
        uses_home_alias = bool(parts and parts[0].lower() in _USER_HOME_DIRS)
        if not uses_home_alias:
            workspace_candidate = (workspace / path).resolve()
            try:
                workspace_candidate.relative_to(workspace.resolve())
            except ValueError:
                raise ValueError(f"path escapes workspace: {filename}") from None
    if _uses_local_computer_paths():
        if path.is_absolute():
            resolved = path.expanduser().resolve()
        else:
            parts = path.parts
            if parts and parts[0].lower() in _USER_HOME_DIRS:
                resolved = (Path(os.path.expanduser("~")) / path).resolve()
            else:
                resolved = (workspace / path).resolve()
        from arforge.security.sandbox_enforce import protected_path_reason

        reason = protected_path_reason(resolved)
        if reason:
            try:
                inside_primary_workspace = resolved.is_relative_to(workspace.resolve())
            except AttributeError:  # pragma: no cover - Python < 3.9 compatibility
                try:
                    resolved.relative_to(workspace.resolve())
                    inside_primary_workspace = True
                except ValueError:
                    inside_primary_workspace = False
            workspace_script = (
                inside_primary_workspace
                and resolved.suffix.lower() in _EDITABLE_WORKSPACE_SCRIPT_SUFFIXES
                and reason == "executable or system binary writes are blocked"
            )
            if not (workspace_script and purpose in {"read", "write"}):
                raise ValueError(f"protected path: {filename} ({reason})")
        return resolved
    if not path.is_absolute():
        path = workspace / path
    resolved = path.resolve()
    from arforge.ts_workspace import typescript_path_is_authorized

    if not typescript_path_is_authorized(resolved, primary=workspace):
        raise ValueError(f"path escapes workspace and all authorized workspaces: {filename}")
    return resolved


# ---------------------------------------------------------------------------
# Registered tools
# ---------------------------------------------------------------------------


@register_tool(
    "list_files",
    "List project files in the workspace, excluding dependency, cache, VCS, and build-output directories",
    keywords=["list files", "ls", "dir", "文件列表", "列出文件"],
    params=[],
    source=__name__,
)
def list_files() -> str:
    workspace = init_workspace()
    files: list[str] = []
    truncated = False
    for root, directories, filenames in os.walk(workspace):
        directories[:] = sorted(
            directory
            for directory in directories
            if directory.casefold() not in _LIST_FILES_IGNORED_DIRS
        )
        for filename in sorted(filenames):
            files.append(str((Path(root) / filename).relative_to(workspace)))
            if len(files) >= _LIST_FILES_LIMIT:
                truncated = True
                break
        if truncated:
            break
    if not files:
        return "(empty workspace)"
    if truncated:
        files.append(
            f"[truncated after {_LIST_FILES_LIMIT} files; use find_files or code_search to narrow the query]"
        )
    return "\n".join(files)


@register_tool(
    "read_file",
    "Read contents of a file in the workspace. Returns up to 60000 characters so "
    "ordinary single-file web apps can be inspected without temporary helper scripts.",
    keywords=[],
    params=[ParamSchema("filename", "path", "filename inside workspace")],
    output_limit=60000,
    match_fn=match_read_file_request,
    source=__name__,
)
def read_file(filename: str) -> str:
    result = safe_read(_resolve(filename))
    if result.get("success"):
        content = result.get("content", "")
        get_file_state_tracker().observe(_resolve(filename))
        return content
    raise OSError(f"Error reading {filename}: {result.get('error', 'unknown')}")


def _open_with_default_app(path: Path, *, launcher=None) -> None:
    """Open one file with the platform default application without a shell."""
    if launcher is not None:
        launcher(path)
        return
    if sys.platform == "win32":
        os.startfile(str(path))  # type: ignore[attr-defined]
        return
    command = ["open", str(path)] if sys.platform == "darwin" else ["xdg-open", str(path)]
    subprocess.Popen(  # noqa: S603 - fixed executable and one validated local path
        command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


@register_tool(
    "open_file",
    "Launch an existing local file with the operating system's default application. "
    "This only launches the app: it does not inspect, test, or validate file contents, "
    "runtime behavior, rendering, or visual correctness.",
    keywords=[],
    params=[ParamSchema("filename", "path", "existing file path to open")],
    risk="high",
    requires_confirmation=True,
    timeout=10,
    category="system",
    source=__name__,
)
def open_file(filename: str) -> str:
    path = _resolve(filename, purpose="execute")
    if not path.exists():
        raise FileNotFoundError(f"file does not exist: {path}")
    if not path.is_file():
        raise ValueError(f"path is not a file: {path}")
    _open_with_default_app(path)
    return (
        f"opened {path}; launch_only=true; "
        "no content, runtime, rendering, or visual validation was performed"
    )


@register_tool(
    "file_state",
    "Return metadata for a workspace file: sha256, size, mtime, and read_count if it has been observed.",
    keywords=["file state", "file hash", "sha256", "hash"],
    params=[ParamSchema("filename", "path", "filename inside workspace")],
    input_adapter=adapt_filename,
    source=__name__,
)
def file_state(filename: str) -> dict:
    path = _resolve(filename)
    observed = get_file_state_tracker().get(path)
    current = snapshot_file(path)
    return {
        "filename": filename,
        "exists": current is not None,
        "current": current.to_dict() if current else None,
        "observed": observed.to_dict() if observed else None,
        "changed_since_observed": (
            observed is not None
            and (current is None or observed.sha256 != current.sha256)
        ),
    }


@register_tool(
    "read_file_if_changed",
    "Read a workspace file only when its sha256 differs from known_sha256; otherwise return metadata without content.",
    keywords=["read if changed", "read changed file", "读取变更"],
    params=[
        ParamSchema("filename", "path", "filename inside workspace"),
        ParamSchema("known_sha256", "string", "previous sha256; when unchanged content is omitted", required=False, default=""),
    ],
    source=__name__,
)
def read_file_if_changed(filename: str, known_sha256: str = "") -> dict:
    path = _resolve(filename)
    current = snapshot_file(path)
    if current is None:
        raise FileNotFoundError(f"file does not exist: {path}")
    if known_sha256 and current.sha256 == known_sha256:
        observed = get_file_state_tracker().get(path)
        return {
            "filename": filename,
            "changed": False,
            "content": None,
            "current": current.to_dict(),
            "observed": observed.to_dict() if observed else None,
        }
    result = safe_read(path)
    if not result.get("success"):
        raise OSError(f"Error reading {filename}: {result.get('error', 'unknown')}")
    content = result.get("content", "")
    observed = get_file_state_tracker().observe(path)
    return {
        "filename": filename,
        "changed": True,
        "content": content,
        "current": observed.to_dict(),
        "observed": observed.to_dict(),
    }


@register_tool(
    "write_file",
    "Write content to a file in the workspace",
    keywords=["write file", "write", "save", "写", "写入", "保存"],
    params=[
        ParamSchema("filename", "path", "filename inside workspace"),
        ParamSchema("content", "string", "content to write"),
    ],
    input_adapter=adapt_filename_content,
    risk="medium",
    requires_confirmation=True,
    category="workspace_write",
    source=__name__,
)
def write_file(filename: str, content: str) -> str:
    result = safe_write(_resolve(filename, purpose="write"), content, require_confirm=_write_requires_confirmation())
    if result.get("success"):
        return f"wrote {filename}"
    raise PermissionError(f"Error writing {filename}: {result.get('error', 'unknown')}")


def _safe_write_bytes(file_path: Path, content: bytes, require_confirm: bool = True) -> dict:
    path = Path(file_path)
    if require_confirm and not request_confirmation("write", str(path)):
        return {"success": False, "error": "not confirmed"}
    backup = backup_file(path) if path.exists() else None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile("wb", delete=False, dir=str(path.parent)) as handle:
            handle.write(content)
            temp_name = handle.name
        os.replace(temp_name, path)
        return {"success": True, "file_path": str(path), "backup_path": str(backup) if backup else "", "error": ""}
    except Exception as exc:  # noqa: BLE001
        write_log("error", f"safe binary write failed for {path}: {exc}")
        return {"success": False, "file_path": str(path), "backup_path": str(backup) if backup else "", "error": str(exc)}


def _docx_bytes(
    content: str,
    *,
    font_name: str | None = None,
    font_size_pt: float | None = None,
) -> bytes:
    import io

    # Keep this writer dependency-free for the packaged sidecar, but emit a
    # complete, portable OOXML document rather than a bare document.xml.  The
    # earlier minimal package omitted page size and styles; Word repaired it as
    # US Letter and strict renderers rejected it.
    safe_font = escape(font_name or "宋体", {'"': "&quot;"})
    base_half_points = round(float(font_size_pt or 12.0) * 2)

    def clean_inline(text: str) -> str:
        text = re.sub(r"!\[([^\]]*)\]\([^)]+\)", r"\1", text)
        text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
        text = re.sub(r"(\*\*|__)(.+?)\1", r"\2", text)
        text = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"\1", text)
        return text.replace("`", "").strip()

    def run_xml(text: str, *, bold: bool = False, size: int | None = None) -> str:
        props = (
            f'<w:rFonts w:ascii="{safe_font}" w:hAnsi="{safe_font}" '
            f'w:eastAsia="{safe_font}"/>'
            f'<w:sz w:val="{size or base_half_points}"/>'
            f'<w:szCs w:val="{size or base_half_points}"/>'
            + ("<w:b/><w:bCs/>" if bold else "")
        )
        return (
            f"<w:r><w:rPr>{props}</w:rPr>"
            f'<w:t xml:space="preserve">{escape(clean_inline(text))}</w:t></w:r>'
        )

    def paragraph_xml(
        text: str,
        *,
        style: str = "Normal",
        bold: bool = False,
        size: int | None = None,
        page_break: bool = False,
        indent: int = 0,
    ) -> str:
        before = '<w:pageBreakBefore/>' if page_break else ""
        indentation = f'<w:ind w:left="{indent}" w:hanging="360"/>' if indent else ""
        return (
            f'<w:p><w:pPr><w:pStyle w:val="{style}"/>{before}{indentation}</w:pPr>'
            f"{run_xml(text, bold=bold, size=size)}</w:p>"
        )

    paragraphs: list[str] = []
    first_heading = True
    for raw_line in str(content).splitlines() or [""]:
        line = raw_line.rstrip()
        stripped = line.strip()
        if stripped in {"<!-- pagebreak -->", "\\pagebreak", "[PAGE BREAK]"}:
            paragraphs.append('<w:p><w:r><w:br w:type="page"/></w:r></w:p>')
            continue
        heading = re.match(r"^(#{1,6})\s+(.+?)\s*#*\s*$", stripped)
        if heading:
            level = len(heading.group(1))
            title = clean_inline(heading.group(2))
            is_title = level == 1 and first_heading
            section_break = (
                not is_title
                and level <= 2
                and bool(
                    re.match(
                        r"^(?:目录|摘要|abstract|第[一二三四五六七八九十\d]+章|参考文献|致谢)",
                        title,
                        re.IGNORECASE,
                    )
                )
            )
            paragraphs.append(
                paragraph_xml(
                    title,
                    style="Title" if is_title else f"Heading{min(level, 3)}",
                    page_break=section_break,
                )
            )
            first_heading = False
            if title.casefold() == "目录":
                paragraphs.append(
                    '<w:p><w:pPr><w:pStyle w:val="TOCHeading"/></w:pPr>'
                    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
                    '<w:r><w:instrText xml:space="preserve">'
                    ' TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r>'
                    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
                    '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
                )
            continue
        bullet = re.match(r"^[-*+]\s+(.+)$", stripped)
        numbered = re.match(r"^(\d+[.)、])\s*(.+)$", stripped)
        if bullet:
            paragraphs.append(paragraph_xml("• " + bullet.group(1), indent=360))
        elif numbered:
            paragraphs.append(
                paragraph_xml(numbered.group(1) + " " + numbered.group(2), indent=360)
            )
        elif stripped.startswith(">"):
            paragraphs.append(paragraph_xml(stripped[1:].strip(), style="Quote"))
        else:
            paragraphs.append(paragraph_xml(stripped))

    body = "".join(paragraphs)
    document_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        f"<w:body>{body}<w:sectPr>"
        '<w:footerReference w:type="default" r:id="rId2"/>'
        '<w:pgSz w:w="11906" w:h="16838"/>'
        '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" '
        'w:header="720" w:footer="720" w:gutter="0"/>'
        '<w:cols w:space="720"/><w:docGrid w:linePitch="312"/>'
        "</w:sectPr></w:body></w:document>"
    )
    styles_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        '<w:docDefaults><w:rPrDefault><w:rPr>'
        f'<w:rFonts w:ascii="{safe_font}" w:hAnsi="{safe_font}" w:eastAsia="{safe_font}"/>'
        f'<w:sz w:val="{base_half_points}"/><w:szCs w:val="{base_half_points}"/>'
        '</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr>'
        '<w:spacing w:line="360" w:lineRule="auto"/><w:jc w:val="both"/>'
        '</w:pPr></w:pPrDefault></w:docDefaults>'
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">'
        '<w:name w:val="Normal"/><w:qFormat/></w:style>'
        '<w:style w:type="paragraph" w:styleId="Title">'
        '<w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>'
        '<w:qFormat/><w:pPr><w:jc w:val="center"/><w:spacing w:before="240" w:after="360"/>'
        '</w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>'
        + "".join(
            (
                f'<w:style w:type="paragraph" w:styleId="Heading{level}">'
                f'<w:name w:val="heading {level}"/><w:basedOn w:val="Normal"/>'
                '<w:next w:val="Normal"/><w:qFormat/>'
                f'<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="{before}" '
                f'w:after="{after}"/><w:outlineLvl w:val="{level - 1}"/></w:pPr>'
                f'<w:rPr><w:b/><w:bCs/><w:sz w:val="{size}"/>'
                f'<w:szCs w:val="{size}"/></w:rPr></w:style>'
            )
            for level, size, before, after in (
                (1, 32, 360, 240),
                (2, 28, 300, 180),
                (3, 24, 240, 120),
            )
        )
        + '<w:style w:type="paragraph" w:styleId="TOCHeading">'
        '<w:name w:val="TOC Heading"/><w:basedOn w:val="Heading1"/><w:qFormat/></w:style>'
        '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/>'
        '<w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720" w:right="720"/></w:pPr></w:style>'
        "</w:styles>"
    )
    settings_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        '<w:updateFields w:val="true"/><w:compat/></w:settings>'
    )
    footer_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        '<w:p><w:pPr><w:jc w:val="center"/></w:pPr>'
        '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
        '<w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>'
        '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>'
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as docx:
        docx.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/word/document.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
            '<Override PartName="/word/styles.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
            '<Override PartName="/word/settings.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>'
            '<Override PartName="/word/footer1.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>'
            "</Types>",
        )
        docx.writestr(
            "_rels/.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
            'Target="word/document.xml"/>'
            "</Relationships>",
        )
        docx.writestr("word/document.xml", document_xml)
        docx.writestr(
            "word/_rels/document.xml.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" '
            'Target="styles.xml"/>'
            '<Relationship Id="rId2" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" '
            'Target="footer1.xml"/>'
            '<Relationship Id="rId3" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" '
            'Target="settings.xml"/>'
            "</Relationships>",
        )
        docx.writestr("word/styles.xml", styles_xml)
        docx.writestr("word/settings.xml", settings_xml)
        docx.writestr("word/footer1.xml", footer_xml)
    return buffer.getvalue()


def write_docx(
    filename: str,
    content: str,
    font_name: str | None = None,
    font_size_pt: float | None = None,
) -> str:
    raw = str(filename).strip()
    if not raw:
        raise ValueError("filename is required")
    candidate = Path(raw)
    if candidate.suffix == "":
        raw = raw + ".docx"
    elif candidate.suffix.lower() != ".docx":
        raise ValueError("write_docx only creates .docx files")
    normalized_font = str(font_name).strip() if font_name is not None else None
    if normalized_font and (len(normalized_font) > 80 or any(ord(ch) < 32 for ch in normalized_font)):
        raise ValueError("font_name is invalid")
    normalized_size = float(font_size_pt) if font_size_pt is not None else None
    if normalized_size is not None and not 5.0 <= normalized_size <= 72.0:
        raise ValueError("font_size_pt must be between 5 and 72")
    path = _resolve(raw, purpose="write")
    result = _safe_write_bytes(
        path,
        _docx_bytes(content, font_name=normalized_font, font_size_pt=normalized_size),
        require_confirm=_write_requires_confirmation(),
    )
    if result.get("success"):
        return f"wrote {path}"
    raise PermissionError(f"Error writing {raw}: {result.get('error', 'unknown')}")


def register_legacy_write_docx() -> None:
    """Register the legacy DOCX wrapper only from the explicit Office seam.

    The product boot path is TypeScript/Core and owns the canonical ``write``
    tool.  Keeping this registration behind ``arforge.tools.office_tools``
    preserves old Python callers without exposing a second default Office
    owner from the general file-tools module.
    """

    if REGISTRY.get("write_docx") is not None:
        return
    register_tool(
        "write_docx",
        "Create an A4 Microsoft Word .docx document at a workspace or authorized local path. "
        "Markdown headings, lists, page-break markers, a TOC field, paragraph styles, margins, "
        "and page-number footer are converted into portable OOXML.",
        keywords=["word", "docx", "word 文档", "文档", "写word", "生成word"],
        params=[
            ParamSchema("filename", "path", "target .docx filename; .docx is appended when no suffix is provided"),
            ParamSchema("content", "string", "full text or Markdown content to put into the Word document"),
            ParamSchema("font_name", "string", "optional font name, for example 宋体", required=False, default=None),
            ParamSchema("font_size_pt", "float", "optional font size in points; 小四 is 12", required=False, default=None),
        ],
        input_adapter=adapt_docx_request,
        risk="medium",
        requires_confirmation=True,
        category="workspace_write",
        source=__name__,
    )(write_docx)


@register_tool(
    "create_file",
    "Create an empty file in the workspace",
    keywords=["create file", "touch", "new file", "新建", "创建文件"],
    params=[ParamSchema("filename", "path", "filename inside workspace")],
    input_adapter=adapt_filename,
    category="workspace_write",
    source=__name__,
)
def create_file(filename: str) -> str:
    path = _resolve(filename, purpose="write")
    if path.exists():
        return f"file already exists: {filename}"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.touch()
    return f"created {filename}"


@register_tool(
    "delete_file",
    "Delete one file in the workspace/local authorized path. This is the safe cleanup path for temporary files; "
    "it never deletes directories recursively and uses the file backup/confirmation layer.",
    keywords=["delete file", "remove file", "cleanup file", "clean up file", "删除文件", "清理文件"],
    params=[ParamSchema("filename", "path", "filename inside workspace")],
    input_adapter=adapt_filename,
    risk="medium",
    requires_confirmation=True,
    category="workspace_write",
    source=__name__,
)
def delete_file(filename: str) -> str:
    path = _resolve(filename, purpose="write")
    if path.is_dir():
        raise IsADirectoryError(f"refusing to delete directory with delete_file: {filename}")
    if not path.exists():
        return f"file already absent: {filename}"
    result = safe_delete(path, require_confirm=_write_requires_confirmation())
    if result.get("success"):
        backup = result.get("backup_path", "")
        suffix = f" (backup: {backup})" if backup else ""
        return f"deleted {filename}{suffix}"
    raise PermissionError(f"Error deleting {filename}: {result.get('error', 'unknown')}")


@register_tool(
    "edit_file",
    "Make a surgical edit: replace old_string with new_string in a workspace file. "
    "For files under 5000 lines / 100KB only. For LARGE files (HTML, generated code, "
    "full pages), use write_file instead to rewrite the entire file. "
    "old_string must match exactly and be unique unless replace_all=true.",
    keywords=["edit file", "edit", "replace in file", "修改文件", "替换", "编辑"],
    params=[
        ParamSchema("filename", "path", "filename inside workspace"),
        ParamSchema("old_string", "string", "exact text to replace"),
        ParamSchema("new_string", "string", "replacement text"),
        ParamSchema("replace_all", "bool", "replace every occurrence (default false)", required=False, default=False),
    ],
    risk="medium",
    requires_confirmation=True,
    category="workspace_write",
    source=__name__,
)
def edit_file(filename: str, old_string: str, new_string: str, replace_all: bool = False) -> str:
    """精确编辑：按 old_string 唯一命中做行内替换，绝不整文件覆盖（DU-3）。

    命中校验：old_string 必须存在；非 replace_all 时必须唯一，否则报错让模型给更具体的串。
    """
    path = _resolve(filename, purpose="write")  # 工作区沙箱：越界自动报错
    read = safe_read(path)
    if not read.get("success"):
        raise OSError(f"Error reading {filename}: {read.get('error', 'unknown')}")
    content = read.get("content", "")
    # Large file guard: for files > 5000 lines or > 100KB, redirect to write_file
    _LARGE_FILE_LINES = 5000
    _LARGE_FILE_BYTES = 100_000
    line_count = content.count('\n') + 1
    byte_size = len(content.encode('utf-8'))
    if line_count > _LARGE_FILE_LINES or byte_size > _LARGE_FILE_BYTES:
        raise ValueError(
            f"{filename} is large ({line_count} lines, {byte_size} bytes). "
            "edit_file works best on files under 5000 lines. "
            "For large files, use write_file to rewrite the entire file instead."
        )
    if old_string == new_string:
        raise ValueError("old_string and new_string are identical")
    count = content.count(old_string)
    if count == 0:
        raise ValueError(f"old_string not found in {filename}")
    if count > 1 and not replace_all:
        raise ValueError(
            f"old_string appears {count} times in {filename}; pass replace_all=true "
            "or provide a longer, unique old_string"
        )
    new_content = content.replace(old_string, new_string) if replace_all else content.replace(old_string, new_string, 1)
    result = safe_write(path, new_content, require_confirm=_write_requires_confirmation())
    if not result.get("success"):
        raise PermissionError(f"Error writing {filename}: {result.get('error', 'unknown')}")

    import difflib

    diff_lines = list(
        difflib.unified_diff(
            content.splitlines(), new_content.splitlines(),
            fromfile=f"a/{filename}", tofile=f"b/{filename}", lineterm="", n=2,
        )
    )
    n = count if replace_all else 1
    diff_preview = "\n".join(diff_lines[:40])
    return f"edited {filename} ({n} replacement{'s' if n != 1 else ''})\n{diff_preview}"


@register_tool(
    "patch_plan",
    "Analyze a unified diff before applying it. Reports files, hunks, additions, "
    "deletions, large-file warnings and suggested hunk batches for safer large or "
    "multi-file patches. This tool is read-only and does not apply the patch.",
    keywords=["patch plan", "analyze patch", "large patch", "multi hunk patch"],
    params=[
        ParamSchema("patch_text", "string", "unified diff text to analyze"),
        ParamSchema("max_hunks_per_batch", "int", "suggested max hunks per batch", required=False, default=5),
    ],
    risk="low",
    timeout=10,
    category="read",
    source=__name__,
)
def patch_plan(patch_text: str, max_hunks_per_batch: int = 5) -> str:
    from arforge.core.patch_plan import analyze_patch_plan, format_patch_plan

    try:
        plan = analyze_patch_plan(
            patch_text,
            root=get_workspace(),
            max_hunks_per_batch=max_hunks_per_batch,
        )
    except Exception as exc:  # noqa: BLE001
        return f"ERROR analyzing patch: {exc}"
    return format_patch_plan(plan)


@register_tool(
    "apply_patch_batch",
    "Preview or apply one suggested hunk batch from a unified diff. Use patch_plan first "
    "for large or multi-hunk patches, then apply batches one at a time.",
    keywords=["apply patch batch", "apply hunk batch", "large patch apply"],
    params=[
        ParamSchema("patch_text", "string", "unified diff text to apply"),
        ParamSchema("batch_index", "int", "zero-based suggested batch index", required=False, default=0),
        ParamSchema("max_hunks_per_batch", "int", "same batch size used by patch_plan", required=False, default=5),
        ParamSchema("dry_run", "bool", "preview only when true; write when false", required=False, default=True),
    ],
    risk="medium",
    requires_confirmation=True,
    category="workspace_write",
    source=__name__,
)
def apply_patch_batch(
    patch_text: str,
    batch_index: int = 0,
    max_hunks_per_batch: int = 5,
    dry_run: bool = True,
) -> dict:
    from arforge.core.patch_plan import apply_patch_batch as _apply_patch_batch

    return _apply_patch_batch(
        patch_text,
        root=get_workspace(),
        batch_index=batch_index,
        max_hunks_per_batch=max_hunks_per_batch,
        dry_run=dry_run,
    )
