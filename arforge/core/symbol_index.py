"""v1-3.1：多语言符号索引（tree-sitter）。

用 tree-sitter 解析 JS/TS/Go 源码，提取函数/类/方法/类型/接口符号 + 行号，补 Python
AST 之外的多语言符号级理解（之前 JS/TS/Go 只能文本搜）。tree-sitter 或某语言包未安装
时优雅返回空（调用方退回文本搜），绝不抛。
"""

from __future__ import annotations

from pathlib import Path

_EXT_LANG = {
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".go": "go",
    ".rs": "rust",
}

# 每语言视为"符号定义"的 tree-sitter node 类型
_SYMBOLS = {
    "javascript": {
        "function_declaration",
        "generator_function_declaration",
        "class_declaration",
        "method_definition",
        "lexical_declaration",
    },
    "typescript": {
        "function_declaration",
        "generator_function_declaration",
        "class_declaration",
        "abstract_class_declaration",
        "method_definition",
        "lexical_declaration",
        "interface_declaration",
        "type_alias_declaration",
        "enum_declaration",
    },
    "go": {"function_declaration", "method_declaration", "type_declaration"},
    "rust": {
        "function_item",
        "function_signature_item",
        "struct_item",
        "enum_item",
        "union_item",
        "trait_item",
        "impl_item",
        "mod_item",
        "const_item",
        "static_item",
        "type_item",
        "associated_type",
        "macro_definition",
        "macro_invocation",
        "use_declaration",
        "field_declaration",
        "enum_variant",
    },
}

_TYPE_LABEL = {
    "function_declaration": "function",
    "generator_function_declaration": "function",
    "class_declaration": "class",
    "abstract_class_declaration": "class",
    "method_definition": "method",
    "method_declaration": "method",
    "interface_declaration": "interface",
    "type_alias_declaration": "type",
    "enum_declaration": "enum",
    "type_declaration": "type",
    "lexical_declaration": "const",
    "function_item": "function",
    "struct_item": "struct",
    "enum_item": "enum",
    "union_item": "union",
    "trait_item": "trait",
    "impl_item": "impl",
    "mod_item": "module",
    "const_item": "const",
    "static_item": "static",
    "type_item": "type",
    "associated_type": "associated_type",
    "macro_definition": "macro",
    "macro_invocation": "macro_call",
    "use_declaration": "import",
    "field_declaration": "field",
    "enum_variant": "variant",
}

_parsers: dict = {}  # lang -> Parser | None（lazy，缓存探测结果）


def _get_parser(language: str):
    if language in _parsers:
        return _parsers[language]
    parser = None
    try:
        from tree_sitter import Language, Parser

        if language == "javascript":
            import tree_sitter_javascript as mod

            ts_lang = mod.language()
        elif language == "typescript":
            import tree_sitter_typescript as mod

            ts_lang = mod.language_typescript()
        elif language == "go":
            import tree_sitter_go as mod

            ts_lang = mod.language()
        elif language == "rust":
            import tree_sitter_rust as mod

            ts_lang = mod.language()
        else:
            ts_lang = None
        if ts_lang is not None:
            parser = Parser(Language(ts_lang))
    except Exception:  # noqa: BLE001  未装 tree-sitter/语言包 → 降级
        parser = None
    _parsers[language] = parser
    return parser


def language_for(path) -> str | None:
    """按扩展名返回支持的语言；不支持返回 None。"""
    return _EXT_LANG.get(Path(path).suffix.lower())


def tree_sitter_available() -> bool:
    """tree-sitter + javascript 语言包是否可用（探测代表整体可用性）。"""
    return _get_parser("javascript") is not None


def _node_name(node) -> str | None:
    nm = node.child_by_field_name("name")
    if nm is not None:
        return nm.text.decode("utf-8", "replace")
    # lexical_declaration → variable_declarator → name；type_declaration → type_spec → name
    for child in node.children:
        if child.type in ("variable_declarator", "type_spec"):
            n = child.child_by_field_name("name")
            if n is not None:
                return n.text.decode("utf-8", "replace")
    return None


def _rust_field_text(node, field: str) -> str:
    child = node.child_by_field_name(field)
    if child is None:
        return ""
    return child.text.decode("utf-8", "replace").strip()


def _rust_visibility(node, owner_type: str = "", trait_impl: bool = False) -> str:
    for child in node.children:
        if child.type == "visibility_modifier":
            return child.text.decode("utf-8", "replace").strip()
    # The Rust grammar represents ``pub macro_rules!`` as a visibility sibling
    # immediately before the macro node instead of as one of its children.
    previous = getattr(node, "prev_named_sibling", None)
    if previous is not None and previous.type == "visibility_modifier":
        return previous.text.decode("utf-8", "replace").strip()
    # Trait declarations and trait implementations cannot repeat ``pub`` on
    # their members; their effective visibility comes from the trait contract.
    if owner_type == "trait_item" or (owner_type == "impl_item" and trait_impl):
        return "trait"
    return "private"


def _rust_signature(node) -> str:
    raw = node.text
    # Only remove a semantic body. Splitting on the first ``{`` corrupts grouped
    # imports such as ``use crate::{A, B}`` and macro token trees.
    if node.type in {"function_item", "trait_item", "impl_item", "mod_item", "foreign_mod_item"}:
        body = node.child_by_field_name("body")
        if body is not None:
            raw = raw[: max(0, body.start_byte - node.start_byte)]
    text = raw.decode("utf-8", "replace").strip().rstrip(";")
    return " ".join(text.split())[:1000]


def _rust_named_child_text(node, child_type: str) -> str:
    for child in node.children:
        if child.type == child_type:
            return child.text.decode("utf-8", "replace").strip()
    return ""


def _join_rust_path(prefix: str, path: str) -> str:
    prefix = prefix.strip(":")
    path = path.strip()
    if not prefix:
        return path
    if not path or path == "self":
        return prefix
    return f"{prefix}::{path.lstrip(':')}"


def _rust_imports(node) -> list[dict[str, str]]:
    """Expand a Rust ``use`` tree into searchable leaf imports."""
    argument = node.child_by_field_name("argument")
    if argument is None:
        return []
    imports: list[dict[str, str]] = []

    def add(name: str, path: str, alias: str = "") -> None:
        if not name or not path:
            return
        item = {"name": name, "import_path": path}
        if alias:
            item["alias"] = alias
        if item not in imports:
            imports.append(item)

    def walk(current, prefix: str = "") -> None:
        kind = current.type
        if kind == "scoped_use_list":
            path_node = current.child_by_field_name("path")
            list_node = current.child_by_field_name("list")
            path = path_node.text.decode("utf-8", "replace") if path_node is not None else ""
            next_prefix = _join_rust_path(prefix, path)
            if list_node is not None:
                for child in list_node.named_children:
                    walk(child, next_prefix)
            return
        if kind == "use_list":
            for child in current.named_children:
                walk(child, prefix)
            return
        if kind == "use_as_clause":
            path_node = current.child_by_field_name("path")
            alias_node = current.child_by_field_name("alias")
            if path_node is None or alias_node is None:
                return
            path = _join_rust_path(prefix, path_node.text.decode("utf-8", "replace"))
            alias = alias_node.text.decode("utf-8", "replace")
            add(alias, path, alias)
            return
        if kind == "use_wildcard":
            text = current.text.decode("utf-8", "replace").strip()
            base = text[:-3] if text.endswith("::*") else ("" if text == "*" else text)
            path = _join_rust_path(prefix, base)
            add("*", f"{path}::*" if path else "*")
            return
        text = current.text.decode("utf-8", "replace").strip()
        path = _join_rust_path(prefix, text)
        if kind == "self":
            name = prefix.rsplit("::", 1)[-1] if prefix else "self"
        else:
            name = text.rsplit("::", 1)[-1]
        add(name, path)

    walk(argument)
    return imports


def _extract_rust_symbols(root) -> list[dict]:
    """Extract definitions and advanced Rust relationships with scope metadata."""
    out: list[dict] = []
    seen: set[tuple] = set()

    def visit(
        node,
        scopes: tuple[str, ...] = (),
        owner_type: str = "",
        owner_trait_impl: bool = False,
    ) -> None:
        node_type = node.type
        name = _node_name(node)
        symbol_type = _TYPE_LABEL.get(node_type, node_type)
        trait_target = ""
        impl_target = ""

        if node_type == "impl_item":
            trait_target = _rust_field_text(node, "trait")
            impl_target = _rust_field_text(node, "type")
            name = f"{trait_target} for {impl_target}" if trait_target else impl_target
            symbol_type = "impl"
        elif node_type == "macro_invocation":
            name = _rust_field_text(node, "macro")
        elif node_type == "use_declaration":
            name = None
        elif node_type in {"function_item", "function_signature_item"}:
            if owner_type in {"trait_item", "impl_item"}:
                symbol_type = "method"
            elif owner_type == "foreign_mod_item":
                symbol_type = "foreign_function"
            else:
                symbol_type = "function"
        elif node_type == "const_item" and owner_type in {"trait_item", "impl_item"}:
            symbol_type = "associated_const"
        elif node_type in {"type_item", "associated_type"} and owner_type in {"trait_item", "impl_item"}:
            symbol_type = "associated_type"

        if node_type == "use_declaration":
            line = node.start_point[0] + 1
            visibility = _rust_visibility(node, owner_type, owner_trait_impl)
            signature = _rust_signature(node)
            for imported in _rust_imports(node):
                imported_name = imported["name"]
                import_path = imported["import_path"]
                key = (imported_name, "import", line, import_path)
                if key in seen:
                    continue
                seen.add(key)
                item = {
                    "name": imported_name,
                    "type": "import",
                    "line": line,
                    "end_line": node.end_point[0] + 1,
                    "qualified_name": "::".join((*scopes, imported_name)) if scopes else imported_name,
                    "visibility": visibility,
                    "signature": signature,
                    "import_path": import_path,
                }
                if "alias" in imported:
                    item["alias"] = imported["alias"]
                if visibility != "private":
                    item["is_reexport"] = True
                out.append(item)

        if node_type != "use_declaration" and node_type in _SYMBOLS["rust"] and name:
            line = node.start_point[0] + 1
            key = (name, symbol_type, line)
            if key not in seen:
                seen.add(key)
                qualified = "::".join((*scopes, name)) if scopes else name
                item = {
                    "name": name,
                    "type": symbol_type,
                    "line": line,
                    "end_line": node.end_point[0] + 1,
                    "qualified_name": qualified,
                    "visibility": _rust_visibility(node, owner_type, owner_trait_impl),
                    "signature": _rust_signature(node),
                }
                optional = {
                    "generics": _rust_field_text(node, "type_parameters"),
                    "where_clause": next(
                        (
                            child.text.decode("utf-8", "replace").strip()
                            for child in node.children
                            if child.type == "where_clause"
                        ),
                        "",
                    ),
                    "return_type": _rust_field_text(node, "return_type"),
                    "parameters": _rust_field_text(node, "parameters"),
                    "bounds": _rust_named_child_text(node, "trait_bounds"),
                    "trait": trait_target,
                    "impl_target": impl_target,
                }
                if node_type != "impl_item":
                    optional["value_type"] = _rust_field_text(node, "type")
                item.update({key: value for key, value in optional.items() if value})
                if node_type == "macro_invocation":
                    item["is_reference"] = True
                out.append(item)

        next_scopes = scopes
        if node_type in {
            "mod_item",
            "trait_item",
            "impl_item",
            "struct_item",
            "enum_item",
            "union_item",
            "enum_variant",
        } and name:
            prefix = "impl " if node_type == "impl_item" else ""
            next_scopes = (*scopes, prefix + name)

        if node_type in {"trait_item", "impl_item", "foreign_mod_item"}:
            next_owner = node_type
            next_owner_trait_impl = bool(trait_target) if node_type == "impl_item" else False
        elif node_type in {"source_file", "declaration_list"}:
            next_owner = owner_type
            next_owner_trait_impl = owner_trait_impl
        else:
            next_owner = ""
            next_owner_trait_impl = False
        for child in node.children:
            visit(child, next_scopes, next_owner, next_owner_trait_impl)

    visit(root)
    out.sort(key=lambda symbol: (symbol["line"], symbol["type"], symbol["name"]))
    return out


def extract_rust_symbols_from_tree(root) -> list[dict]:
    """Public zero-reparse adapter for project-level Rust indexers."""
    return _extract_rust_symbols(root)


def extract_symbols(source: str, language: str) -> list[dict]:
    """提取源码符号 ``[{name, type, line}]``（按行号排序）。不可用/解析失败 → 空列表。"""
    parser = _get_parser(language)
    if parser is None or language not in _SYMBOLS:
        return []
    try:
        tree = parser.parse(bytes(source, "utf-8"))
    except Exception:  # noqa: BLE001
        return []
    if language == "rust":
        return _extract_rust_symbols(tree.root_node)
    wanted = _SYMBOLS[language]
    out: list[dict] = []
    seen: set = set()
    stack = [tree.root_node]
    while stack:
        node = stack.pop()
        if node.type in wanted:
            name = _node_name(node)
            if name:
                key = (name, node.start_point[0])
                if key not in seen:
                    seen.add(key)
                    out.append(
                        {"name": name, "type": _TYPE_LABEL.get(node.type, node.type), "line": node.start_point[0] + 1}
                    )
        stack.extend(node.children)
    out.sort(key=lambda s: s["line"])
    return out


def extract_symbols_from_file(path) -> list[dict]:
    lang = language_for(path)
    if lang is None:
        return []
    try:
        source = Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    return extract_symbols(source, lang)
