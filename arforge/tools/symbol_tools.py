"""v1-3.1：多语言符号工具 ``code_symbols``。

列出源文件的符号（函数/类/方法/类型/接口）+ 行号，支持 Python（AST）与 JS/TS/Go
（tree-sitter）。比读整文件更快定位结构，让 agent 在多语言项目里也能做符号级导航。
"""

from __future__ import annotations

from arforge.tool_registry import ParamSchema, register_tool


@register_tool(
    "code_symbols",
    "列出源文件的符号（函数/类/方法/类型/接口）及行号，支持 Python / JS / TS / Go。"
    "比读整文件更快定位结构；JS/TS/Go 需 tree-sitter（未装则提示用 code_search 文本搜）。",
    params=[ParamSchema("filename", "path", "工作区内的源文件路径")],
    risk="low",
    category="read",
    source=__name__,
)
def code_symbols(filename: str) -> str:
    from arforge.core.symbol_index import extract_symbols_from_file, language_for
    from arforge.tools.file_tools import _resolve

    try:
        path = _resolve(filename)
    except Exception as exc:  # noqa: BLE001  越界等
        return f"ERROR: {exc}"
    if not path.is_file():
        return f"ERROR: file not found: {filename}"

    lang = language_for(path)
    if lang is not None:  # JS / TS / Go
        symbols = extract_symbols_from_file(path)
        if not symbols:
            return (
                f"(在 {filename} 未提取到符号；可能是 tree-sitter 未安装或文件无顶层符号。"
                "可改用 code_search 文本搜。)"
            )
        lines = [f"  {s['line']}: {s['type']} {s['name']}" for s in symbols]
        return f"{len(symbols)} 个符号 in {filename}（{lang}）:\n" + "\n".join(lines)

    if path.suffix == ".py":  # Python 复用既有 AST 摘要
        try:
            from arforge.code_summarizer import summarize_code_file

            return summarize_code_file(str(path)) or "(empty summary)"
        except Exception as exc:  # noqa: BLE001
            return f"ERROR summarizing {filename}: {exc}"

    return f"暂不支持 {path.suffix} 的符号提取；请用 code_search 做文本搜索。"
