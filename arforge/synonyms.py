"""Code-domain synonym mapping for semantic search expansion.

Each key maps to a list of semantically related terms.  Used by the TF-IDF
search to find code even when the user's vocabulary differs from the codebase.
"""

from __future__ import annotations

SYNONYMS: dict[str, list[str]] = {
    # -- Memory / storage --
    "memory": ["cache", "store", "persist", "save", "retain", "keep", "buffer", "heap", "stack", "mem"],
    "cache": ["memory", "store", "buffer", "redis", "memcache", "lru", "ttl"],
    "store": ["save", "persist", "write", "commit", "flush", "storage", "memory"],
    "persist": ["save", "store", "write", "commit", "serialize", "dump", "marshal"],
    # -- Authentication / security --
    "auth": ["login", "permission", "credential", "token", "oauth", "jwt", "sso", "authenticate", "authorize"],
    "login": ["auth", "signin", "authenticate", "credential", "password", "oauth"],
    "permission": ["acl", "rbac", "access", "grant", "deny", "allow", "role", "privilege"],
    "credential": ["password", "secret", "key", "token", "api_key", "apikey", "auth"],
    "token": ["jwt", "oauth", "bearer", "session", "key", "credential"],
    "security": ["auth", "encrypt", "hash", "ssl", "tls", "permission", "sandbox", "audit"],
    # -- Error handling --
    "error": ["exception", "fail", "bug", "crash", "fault", "panic", "err", "traceback", "throw", "raise"],
    "exception": ["error", "throw", "raise", "catch", "try", "except", "finally", "traceback"],
    "bug": ["defect", "error", "fault", "flaw", "issue", "regression", "fix"],
    "crash": ["error", "panic", "segfault", "abort", "terminate", "fatal"],
    # -- Configuration --
    "config": ["setting", "option", "preference", "env", "environment", "dotenv", "ini", "yaml", "json", "toml"],
    "setting": ["config", "option", "preference", "flag", "toggle", "switch", "parameter"],
    "env": ["environment", "config", "dotenv", "variable", "VAR", "PATH"],
    # -- Database --
    "database": ["db", "sql", "nosql", "postgres", "mysql", "sqlite", "mongo", "redis", "orm", "migration"],
    "sql": ["query", "select", "insert", "update", "delete", "join", "table", "schema", "index"],
    "query": ["sql", "select", "filter", "search", "find", "aggregate", "join"],
    # -- HTTP / API --
    "http": ["request", "response", "rest", "api", "endpoint", "router", "server", "client", "url"],
    "api": ["endpoint", "router", "rest", "graphql", "rpc", "handler", "controller", "route"],
    "request": ["http", "fetch", "curl", "get", "post", "put", "delete", "header", "payload"],
    "response": ["http", "json", "status", "code", "body", "header", "payload"],
    # -- File I/O --
    "file": ["read", "write", "open", "close", "io", "path", "fs", "directory", "stream"],
    "read": ["load", "open", "parse", "fetch", "get", "retrieve", "input"],
    "write": ["save", "dump", "output", "export", "serialize", "persist", "flush"],
    "path": ["file", "directory", "folder", "fs", "uri", "location", "route"],
    # -- Testing --
    "test": ["pytest", "unittest", "assert", "mock", "fixture", "coverage", "spec", "expect"],
    "pytest": ["test", "fixture", "conftest", "parametrize", "mark", "assert", "mock"],
    "mock": ["stub", "fake", "dummy", "spy", "patch", "double", "simulate"],
    # -- Build / CI --
    "build": ["compile", "package", "make", "cmake", "gradle", "maven", "pip", "npm", "docker"],
    "deploy": ["release", "publish", "ship", "ci", "cd", "kubernetes", "docker", "ansible"],
    "ci": ["github", "actions", "jenkins", "pipeline", "workflow", "build", "test", "deploy"],
    # -- Data / Analysis --
    "data": ["dataset", "csv", "json", "dataframe", "pandas", "numpy", "array", "table", "statistic"],
    "analysis": ["analytics", "insight", "metric", "statistic", "report", "dashboard", "chart"],
    "chart": ["plot", "graph", "histogram", "bar", "line", "scatter", "visualize", "matplotlib"],
    # -- Refactoring --
    "refactor": ["rename", "extract", "move", "clean", "simplify", "split", "merge", "optimize"],
    "optimize": ["perf", "speed", "fast", "cache", "lazy", "parallel", "async", "profile"],
    # -- Documentation --
    "document": ["doc", "readme", "comment", "docstring", "manual", "guide", "spec", "api doc"],
    # -- CLI --
    "cli": ["command", "argparse", "click", "typer", "terminal", "console", "shell", "flag", "option"],
    "command": ["cli", "run", "exec", "invoke", "subprocess", "cmd", "script"],
}
