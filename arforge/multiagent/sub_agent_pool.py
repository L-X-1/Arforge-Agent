"""SubAgentPool — singleton registry of all available SubAgent classes.

The pool is the central directory that MasterAgent consults when deciding
which agents to dispatch tasks to.  Each SubAgent class registers itself
with a @register_sub_agent decorator or via the pool.register() method.
"""

from __future__ import annotations

import threading
from collections import deque
from typing import Type

from arforge.multiagent.sub_agent import SubAgent

def _builtin_role_metadata() -> dict[str, dict]:
    """Project the canonical worker contracts into orchestrator metadata."""

    from arforge.core.subagent import orchestrator_subagent_role_specs

    return {
        spec.orchestrator_role: {
            "description": spec.description,
            "capabilities": list(spec.capabilities),
            "tools": list(spec.tools),
            "system_prompt": spec.system_prompt,
            "max_steps": spec.max_steps,
            "max_tokens": spec.max_tokens,
            "timeout": spec.timeout,
        }
        for spec in orchestrator_subagent_role_specs()
        if spec.orchestrator_role is not None
    }


_DEFAULT_ROLES: dict[str, dict] = _builtin_role_metadata()


class SubAgentPool:
    """Singleton registry of SubAgent classes, keyed by role name.

    Usage:
        pool = get_sub_agent_pool()
        pool.register(MyCustomAgent)
        agent_cls = pool.get("CoderAgent")
        agent = agent_cls(master=some_master)
        result = agent.execute(task, conversation)
    """

    _instance: SubAgentPool | None = None

    def __init__(self):
        self._registry: dict[str, Type[SubAgent]] = {}
        self._roles: dict[str, dict] = dict(_DEFAULT_ROLES)  # shallow copy
        self._custom_role_names: set[str] = set()
        self._custom_agent_errors: list[dict[str, str]] = []
        self._agent_cache: dict[str, deque] = {}  # per-role instance pool
        self._cache_lock = threading.Lock()
        self._pool_max_size: int = 8  # max instances per role in cache
        self._builtins_loaded = False
        self._builtins_loading = False

    # ------------------------------------------------------------------
    # Singleton access
    # ------------------------------------------------------------------

    @classmethod
    def instance(cls) -> SubAgentPool:
        # ``instance()`` is part of the documented pool API, so callers must
        # receive the same fully initialized registry as ``get_sub_agent_pool``.
        # Loading under a re-entrant lock also prevents two startup threads from
        # observing a half-populated role table.
        with _BUILTIN_LOAD_LOCK:
            if cls._instance is None:
                cls._instance = cls()
            cls._instance._ensure_builtins()
            return cls._instance

    def _ensure_builtins(self) -> None:
        """Load the concrete built-in role classes exactly once.

        The loading guard is intentionally separate from ``_builtins_loaded``:
        an extension imported while the built-ins are loading may ask for the
        singleton again, and that recursive lookup must return without starting
        a second import pass.
        """
        if self._builtins_loaded or self._builtins_loading:
            return
        self._builtins_loading = True
        try:
            from arforge.multiagent import agents as _agents

            classes = [getattr(_agents, name, None) for name in _BUILTIN_ROLE_NAMES]
            self.register_all([agent_cls for agent_cls in classes if agent_cls is not None])
            self._builtins_loaded = True
        finally:
            self._builtins_loading = False

    # ------------------------------------------------------------------
    # Registration
    # ------------------------------------------------------------------

    def register(self, agent_cls: Type[SubAgent]) -> None:
        """Register a SubAgent class by its role name."""
        role_name = agent_cls.role
        with self._cache_lock:
            self._registry[role_name] = agent_cls
            self._agent_cache.pop(role_name, None)
        # Update role metadata if the class provides richer info
        role_def = agent_cls.get_role()
        self._roles[role_name] = {
            "description": role_def.description,
            "capabilities": role_def.capabilities,
            "tools": role_def.tools,
            "system_prompt": role_def.system_prompt,
        }

    def get(self, role: str) -> Type[SubAgent] | None:
        """Get a SubAgent class by role name. Returns None if not found."""
        return self._registry.get(role)

    def list_roles(self) -> list:
        """Return AgentRole objects for all registered (and default) roles."""
        from arforge.multiagent.protocol import AgentRole

        roles = []
        for name, meta in self._roles.items():
            roles.append(
                AgentRole(
                    name=name,
                    description=meta.get("description", ""),
                    capabilities=meta.get("capabilities", []),
                    tools=meta.get("tools", []),
                    max_tokens=meta.get("max_tokens", 4096),
                    timeout=meta.get("timeout", 60),
                    system_prompt=meta.get("system_prompt", ""),
                )
            )
        return roles

    def list_role_names(self) -> list[str]:
        """Return just the role name strings."""
        return list(self._roles.keys())

    def is_registered(self, role: str) -> bool:
        """Check whether a role is known to the pool."""
        return role in self._roles or role in self._registry

    # ------------------------------------------------------------------
    # Agent creation
    # ------------------------------------------------------------------

    def create_agent(self, role: str, master=None) -> SubAgent | None:
        """Create a SubAgent instance for the given role.

        Uses registered class if available; otherwise returns a base SubAgent
        with the role metadata applied.
        """
        cls = self._registry.get(role)
        if cls is not None:
            return cls(master=master)

        # No registered class — create a generic SubAgent with role metadata
        meta = self._roles.get(role)
        if meta is None:
            return None

        agent = SubAgent(master=master)
        agent.role = role
        agent.capabilities = meta.get("capabilities", [])
        agent.tools = meta.get("tools", [])
        agent.system_prompt = meta.get("system_prompt", "")
        agent.max_steps = meta.get("max_steps", agent.max_steps)
        agent.max_tokens = meta.get("max_tokens", agent.max_tokens)
        agent.timeout = meta.get("timeout", agent.timeout)
        return agent

    # ------------------------------------------------------------------
    # Agent instance pooling (Phase 2c: subagent warmup/pooling)
    # ------------------------------------------------------------------

    def borrow_agent(self, role: str, master=None) -> SubAgent | None:
        """Get a SubAgent instance from the pool, or create one.

        Thread-safe: uses _cache_lock to protect pool mutations.
        Returns None if the role is unknown.
        """
        meta = self._roles.get(role)
        if meta is None:
            return None

        with self._cache_lock:
            cache = self._agent_cache.get(role)
            if cache and len(cache) > 0:
                agent = cache.popleft()
                agent.master = master
                return agent

        cls = self._registry.get(role)
        if cls is not None:
            return cls(master=master)
        # No registered class - create generic SubAgent
        return self.create_agent(role, master=master)

    def return_agent(self, role: str, agent: SubAgent) -> None:
        """Return an agent instance to the pool for reuse.

        Thread-safe. Capped at _pool_max_size per role.
        Clears transient state (channel) before pooling.
        """
        if agent is None:
            return
        # Clear transient execution state
        agent._channel = None
        agent._last_tokens = 0

        with self._cache_lock:
            cache = self._agent_cache.get(role)
            if cache is None:
                cache = deque()
                self._agent_cache[role] = cache
            if len(cache) < self._pool_max_size:
                cache.append(agent)

    def pool_stats(self) -> dict:
        """Return pool hit rates and sizes for observability."""
        with self._cache_lock:
            return {
                role: {"cached": len(q), "max": self._pool_max_size}
                for role, q in self._agent_cache.items()
            }

    def clear_pool(self) -> None:
        """Clear all cached instances (useful for testing)."""
        with self._cache_lock:
            self._agent_cache.clear()

    def replace_custom_roles(self, roles: dict[str, dict], errors: list[dict[str, str]] | None = None) -> None:
        """Atomically replace project-supplied role metadata without touching built-ins."""
        if any(not name.startswith("CustomAgent.") for name in roles):
            raise ValueError("custom role names must use the CustomAgent. prefix")
        with self._cache_lock:
            for name in self._custom_role_names:
                self._roles.pop(name, None)
                self._agent_cache.pop(name, None)
            self._custom_role_names = set(roles)
            self._roles.update({name: dict(meta) for name, meta in roles.items()})
            self._custom_agent_errors = list(errors or [])

    def custom_agent_errors(self) -> list[dict[str, str]]:
        """Return validation diagnostics from the most recent runtime refresh."""
        with self._cache_lock:
            return list(self._custom_agent_errors)

    # ------------------------------------------------------------------
    # Bulk registration
    # ------------------------------------------------------------------

    def register_all(self, classes: list[Type[SubAgent]]) -> None:
        """Register multiple SubAgent classes at once."""
        for cls in classes:
            self.register(cls)

    def reset(self) -> None:
        """Clear registry (useful for testing)."""
        self._registry.clear()
        self._roles = dict(_DEFAULT_ROLES)
        self._custom_role_names = set()
        self._custom_agent_errors = []
        self._builtins_loaded = False
        self._builtins_loading = False
        self.clear_pool()


_BUILTIN_ROLE_NAMES = list(_DEFAULT_ROLES)

_BUILTIN_LOAD_LOCK = threading.RLock()


def get_sub_agent_pool() -> SubAgentPool:
    """Convenience: return the singleton SubAgentPool。

    首次调用时懒注册 8 个内置角色类（P1-5：确保 create_agent 返回具体子类，
    而非回退通用 SubAgent）。懒导入避免与 agents 包的循环导入；幂等。
    """
    pool = SubAgentPool.instance()
    try:
        from arforge.custom_agent_profiles import load_enabled_custom_agent_profiles

        profiles, errors = load_enabled_custom_agent_profiles()
        pool.replace_custom_roles(
            {profile.role_name: profile.pool_metadata() for profile in profiles},
            errors=errors,
        )
    except Exception:
        pool.replace_custom_roles({}, errors=[{"path": "<runtime>", "error": "custom profile refresh failed"}])
    return pool


def register_sub_agent(cls: Type[SubAgent]) -> Type[SubAgent]:
    """Class decorator: register a SubAgent with the pool."""
    get_sub_agent_pool().register(cls)
    return cls
