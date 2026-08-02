"""MCP Server Framework — M3 (T32): Resource/Prompt + Sampling Bridge + ExternalMCPBridge.

Completes the MCP ecosystem:
  - ResourceRegistry: expose read-only data (files, configs, schemas)
  - PromptRegistry: templated prompts with argument binding
  - SamplingBridge: DeepSeek-powered LLM sampling for MCP servers
  - ExternalMCPBridge: connect Arforge Agent tools to external MCP servers
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

logger = logging.getLogger(__name__)


# ====================================================================
# Resource
# ====================================================================


@dataclass
class MCPResource:
    """An MCP resource — typed, readable data exposed by the server."""

    uri: str
    name: str
    description: str = ""
    mime_type: str = "text/plain"
    size: int = 0
    metadata: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "uri": self.uri,
            "name": self.name,
            "description": self.description,
            "mimeType": self.mime_type,
            "size": self.size,
        }


class ResourceRegistry:
    """Registry of MCP resources with URI-based resolution."""

    def __init__(self) -> None:
        self._resources: dict[str, MCPResource] = {}
        self._readers: dict[str, Callable[[str], str]] = {}

    def register(self, resource: MCPResource, reader: Callable[[str], str] | None = None) -> None:
        self._resources[resource.uri] = resource
        if reader:
            self._readers[resource.uri] = reader

    def list_resources(self) -> list[dict]:
        return [r.to_dict() for r in self._resources.values()]

    def read_resource(self, uri: str) -> dict:
        resource = self._resources.get(uri)
        if resource is None:
            return {"isError": True, "content": []}
        reader = self._readers.get(uri)
        text = reader(uri) if reader else ""
        return {
            "contents": [
                {
                    "uri": uri,
                    "mimeType": resource.mime_type,
                    "text": text,
                }
            ]
        }

    def add_file_resource(self, base_uri: str, path: Path) -> list[MCPResource]:
        """Register file(s) as resources. Directories are expanded recursively."""
        resources = []
        if path.is_file():
            try:
                content = path.read_text(encoding="utf-8")
                size = path.stat().st_size
            except (OSError, UnicodeDecodeError):
                content = ""
                size = 0
            uri = f"{base_uri}/{path.name}"
            r = MCPResource(uri, path.name, f"File: {path.name}",
                            mime_type="text/plain", size=size)
            self.register(r, lambda u, c=content: c)
            resources.append(r)
        elif path.is_dir():
            for child in sorted(path.rglob("*")):
                if child.is_file() and child.suffix in {".py", ".md", ".json", ".yaml", ".yml", ".toml", ".txt", ".cfg"}:
                    try:
                        content = child.read_text(encoding="utf-8")
                    except (OSError, UnicodeDecodeError):
                        content = ""
                    rel = child.relative_to(path)
                    uri = f"{base_uri}/{rel.as_posix()}"
                    r = MCPResource(uri, rel.as_posix(), f"File: {rel.as_posix()}",
                                    size=child.stat().st_size)
                    self.register(r, lambda u, c=content: c)
                    resources.append(r)
        return resources


# ====================================================================
# Prompt
# ====================================================================


@dataclass
class MCPPrompt:
    """An MCP prompt template with argument binding."""

    name: str
    description: str = ""
    template: str = ""
    arguments: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "description": self.description,
            "arguments": self.arguments,
        }

    def render(self, args: dict | None = None) -> str:
        args = args or {}
        result = self.template
        for key, value in args.items():
            result = result.replace(f"{{{{{key}}}}}", str(value))
        return result


class PromptRegistry:
    """Registry of MCP prompt templates."""

    def __init__(self) -> None:
        self._prompts: dict[str, MCPPrompt] = {}

    def register(self, prompt: MCPPrompt) -> None:
        self._prompts[prompt.name] = prompt

    def list_prompts(self) -> list[dict]:
        return [p.to_dict() for p in self._prompts.values()]

    def get_prompt(self, name: str, arguments: dict | None = None) -> dict:
        prompt = self._prompts.get(name)
        if prompt is None:
            return {"isError": True, "messages": []}
        rendered = prompt.render(arguments)
        return {
            "description": prompt.description,
            "messages": [
                {"role": "user", "content": {"type": "text", "text": rendered}}
            ],
        }


# ====================================================================
# Sampling Bridge (DeepSeek)
# ====================================================================


@dataclass
class SamplingRequest:
    messages: list[dict]
    model: str = "deepseek-v4-flash"
    max_tokens: int = 1024
    temperature: float = 0.7


@dataclass
class SamplingResponse:
    content: str
    model: str = ""
    usage: dict = field(default_factory=dict)
    finish_reason: str = "stop"


class SamplingBridge:
    """Bridge MCP sampling requests to DeepSeek (or any OpenAI-compatible API).

    Allows MCP servers to request LLM completions through the Arforge model layer.
    """

    def __init__(self, api_key: str = "", base_url: str = "", model: str = "deepseek-v4-flash") -> None:
        self.api_key = api_key
        self.base_url = base_url
        self.model = model
        self._client = None

    def _ensure_client(self):
        if self._client is None:
            # Sampling is another model egress path.  Keep it inside the same
            # endpoint policy as the primary adapters so an MCP server cannot
            # turn a custom sampling URL into an unchecked network target.
            from arforge.product.model_config_runtime import (
                ModelConfigError,
                get_model_config,
                validate_model_endpoint,
            )

            runtime = get_model_config()
            resolved = runtime.get_resolved_config("deepseek")
            if not self.base_url and resolved.get("error"):
                raise ModelConfigError(
                    "INVALID_PROVIDER_CONFIG",
                    str(resolved["error"]),
                )
            # Environment credentials remain supported for headless MCP
            # deployments, followed by the encrypted local credential store.
            # This matches the primary runtime's precedence order.
            import os

            key = (
                self.api_key
                or os.getenv("DEEPSEEK_API_KEY", "")
                or runtime.get_api_key("deepseek")
            )
            url = validate_model_endpoint(
                self.base_url or resolved.get("base_url") or "https://api.deepseek.com/v1",
                allow_empty=False,
            )
            try:
                from openai import OpenAI

                self._client = OpenAI(api_key=key, base_url=url)
            except ImportError:
                raise RuntimeError("openai package required for SamplingBridge")

    def sample(self, request: SamplingRequest) -> SamplingResponse:
        self._ensure_client()
        resp = self._client.chat.completions.create(
            model=request.model or self.model,
            messages=request.messages,
            max_tokens=request.max_tokens,
            temperature=request.temperature,
        )
        choice = resp.choices[0]
        return SamplingResponse(
            content=choice.message.content or "",
            model=resp.model,
            usage={
                "prompt_tokens": resp.usage.prompt_tokens if resp.usage else 0,
                "completion_tokens": resp.usage.completion_tokens if resp.usage else 0,
            },
            finish_reason=choice.finish_reason or "stop",
        )

    def sample_text(self, prompt: str, system: str = "") -> str:
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})
        return self.sample(SamplingRequest(messages)).content


# ====================================================================
# External MCP Bridge
# ====================================================================


class ExternalMCPBridge:
    """Bridge external MCP servers into Arforge Agent's tool registry.

    Connects to external MCP servers (via stdio, HTTP/SSE, or WebSocket) and
    dynamically registers their tools into the Arforge tool registry.
    """

    def __init__(self) -> None:
        from arforge.mcp_client_runtime import MCPClientManager

        self._manager = MCPClientManager()

    def connect_stdio(self, name: str, command: list[str]) -> dict:
        """Connect through the bounded production stdio client."""

        result = self._manager.connect_stdio(name, command)
        return {
            "name": result["name"],
            "tools": result["tool_count"],
            "transport": "stdio",
        }

    def connect_http(
        self,
        name: str,
        url: str,
        *,
        transport: str = "http",
        token_provider=None,
    ) -> dict:
        """Connect through streamable HTTP or SSE bootstrap."""

        result = self._manager.connect_http(
            name,
            url,
            transport=transport,
            token_provider=token_provider,
        )
        return {
            "name": result["name"],
            "tools": result["tool_count"],
            "transport": transport,
        }

    def connect_websocket(
        self,
        name: str,
        url: str,
        *,
        token_provider=None,
    ) -> dict:
        """Connect through a bounded generic WS/WSS transport."""

        result = self._manager.connect_websocket(
            name,
            url,
            token_provider=token_provider,
        )
        return {
            "name": result["name"],
            "tools": result["tool_count"],
            "transport": "websocket",
        }

    def call_tool(self, server_name: str, tool_name: str, arguments: dict | None = None) -> dict:
        """Call a tool on a connected MCP server."""
        from arforge.mcp_client_runtime import MCPClientError

        try:
            return self._manager.call_tool(server_name, tool_name, arguments or {})
        except MCPClientError as exc:
            return {
                "isError": True,
                "content": [{"type": "text", "text": exc.message}],
            }

    def list_servers(self) -> list[dict]:
        return self._manager.list_servers()

    def register_into_arforge(self) -> int:
        """Return the number of tools already synchronized by the manager."""

        return sum(len(item["registered_tools"]) for item in self.list_servers())

    def refresh_tools(self, name: str) -> dict:
        return self._manager.refresh_tools(name)

    def list_resources(self, name: str) -> list[dict]:
        return self._manager.list_resources(name)

    def read_resource(self, name: str, uri: str) -> dict:
        return self._manager.read_resource(name, uri)

    def disconnect(self, name: str) -> None:
        self._manager.disconnect(name)

    def disconnect_all(self) -> None:
        self._manager.disconnect_all()
