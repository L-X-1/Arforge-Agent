"""SubAgent base class — the worker unit in multi-agent collaboration.

Each SubAgent has a role definition (AgentRole), a capability whitelist, a
tool whitelist, and a single-method entry point `execute()` that takes a Task
+ Conversation and returns a TaskResult.

By default (agentic_first=True), execute() uses the full agentic tool loop
(run_agentic_task) instead of a single-shot LLM call. This gives every SubAgent
the same multi-step reasoning + tool-use capability as the main agent loop.

Inter-agent communication:
  Agents communicate through conversation.shared_memory (read-visible to all).
  The `notify()` method posts structured messages that dependent agents can
  consume without polling. The `AgentChannel` provides typed, traceable
  inter-agent message passing with delivery guarantees.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from arforge.multiagent.protocol import AgentRole, Task, TaskResult

if TYPE_CHECKING:
    from arforge.multiagent.master_agent import MasterAgent

logger = logging.getLogger(__name__)


def _estimate_tokens(text: str) -> int:
    """Approximate token estimate for token budget checks (P0-1)."""
    from arforge.core.context import estimate_text_tokens
    return estimate_text_tokens(text)


# ——————————————————————————————————————————————
# Inter-agent message types
# ——————————————————————————————————————————————


@dataclass
class AgentMessage:
    """Typed message passed between agents through Conversation.shared_memory."""
    sender: str           # role name
    recipient: str = ""   # empty = broadcast to all
    kind: str = "info"    # info | result | request | alert | handoff
    payload: Any = None
    timestamp: float = field(default_factory=time.time)

    def to_dict(self) -> dict:
        return {
            "sender": self.sender,
            "recipient": self.recipient,
            "kind": self.kind,
            "payload": self.payload,
            "timestamp": self.timestamp,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "AgentMessage":
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


class AgentChannel:
    """Durable, typed inter-agent communication backed by Conversation.shared_memory.

    Usage inside SubAgent.execute():
        channel = AgentChannel(conversation, self.role)
        channel.send("CoderAgent", "info", {"hint": "use file X"})
        msgs = channel.receive()  # get all messages addressed to this role
    """

    _MEMORY_KEY = "_agent_channel_messages"

    def __init__(self, conversation, role: str):
        self._conv = conversation
        self._role = role
        # Initialise the message buffer if missing
        mem = getattr(conversation, "shared_memory", None) or {}
        if self._MEMORY_KEY not in mem:
            mem[self._MEMORY_KEY] = []
            if hasattr(conversation, "shared_memory"):
                conversation.shared_memory = mem

    @property
    def _buffer(self) -> list[dict]:
        with self._conv._lock:
            mem = getattr(self._conv, "shared_memory", None) or {}
            return mem.setdefault(self._MEMORY_KEY, [])

    def send(self, recipient: str, kind: str, payload: Any) -> AgentMessage:
        """Post a message to the shared channel."""
        msg = AgentMessage(sender=self._role, recipient=recipient, kind=kind, payload=payload)
        with self._conv._lock:
            self._buffer.append(msg.to_dict())
        return msg

    def broadcast(self, kind: str, payload: Any) -> AgentMessage:
        """Send to all agents."""
        return self.send("", kind, payload)

    def receive(self, since: float = 0.0) -> list[AgentMessage]:
        """Return messages addressed to this role (or broadcast) since *since*."""
        msgs: list[AgentMessage] = []
        for raw in self._buffer:
            m = AgentMessage.from_dict(raw)
            if m.timestamp <= since:
                continue
            if m.recipient and m.recipient != self._role:
                continue
            msgs.append(m)
        return msgs

    def latest_from(self, sender_role: str, kind: str = "") -> AgentMessage | None:
        """Return the most recent message from a specific sender (optionally filtered by kind)."""
        for raw in reversed(self._buffer):
            m = AgentMessage.from_dict(raw)
            if m.sender == sender_role:
                if not kind or m.kind == kind:
                    return m
        return None


# ——————————————————————————————————————————————
# SubAgent status tracking
# ——————————————————————————————————————————————


@dataclass
class AgentStatus:
    """Runtime status of a SubAgent, stored in Conversation.shared_memory."""
    role: str
    state: str = "idle"      # idle | running | done | error | blocked
    task_id: str = ""
    started_at: float = 0.0
    finished_at: float = 0.0
    progress: str = ""       # human-readable progress note
    tokens_used: int = 0

    def to_dict(self) -> dict:
        return {
            "role": self.role, "state": self.state, "task_id": self.task_id,
            "started_at": self.started_at, "finished_at": self.finished_at,
            "progress": self.progress, "tokens_used": self.tokens_used,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "AgentStatus":
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


def _status_key(role: str) -> str:
    return f"_agent_status_{role}"


def set_agent_status(conversation, status: AgentStatus) -> None:
    """Write agent status into conversation shared_memory (thread-safe for parallel agents)."""
    with conversation._lock:
        mem = getattr(conversation, "shared_memory", None) or {}
        mem[_status_key(status.role)] = status.to_dict()
        if hasattr(conversation, "shared_memory"):
            conversation.shared_memory = mem


def get_agent_status(conversation, role: str) -> AgentStatus:
    """Read agent status from shared_memory."""
    with conversation._lock:
        mem = getattr(conversation, "shared_memory", None) or {}
        raw = mem.get(_status_key(role), {})
    return AgentStatus.from_dict(raw) if raw else AgentStatus(role=role)


def get_all_agent_statuses(conversation) -> dict[str, AgentStatus]:
    """Read all agent statuses."""
    with conversation._lock:
        mem = getattr(conversation, "shared_memory", None) or {}
        result: dict[str, AgentStatus] = {}
        for key, raw in mem.items():
            if key.startswith("_agent_status_"):
                role = key[len("_agent_status_"):]
                result[role] = AgentStatus.from_dict(raw) if raw else AgentStatus(role=role)
    return result


# ——————————————————————————————————————————————
# SubAgent Base
# ——————————————————————————————————————————————


class SubAgent:
    """Base class for all specialized sub-agents.

    Subclasses MUST override:
    - role: str          — role name, e.g. "CoderAgent"
    - capabilities: list[str] — allowed capabilities (whitelist)
    - tools: list[str]        — allowed tools (whitelist)
    - system_prompt: str      — role-specific prompt prefix

    Subclasses MAY override:
    - _run(task, conversation) — core logic (default: single-shot LLM, only when agentic_first=False)
    - _build_prompt(task, conversation) — message construction
    - _build_agentic_task(task, conversation) — prompt for agentic loop
    - max_tokens, timeout — resource limits
    - max_steps: int — max tool loop steps (default 8 for agentic)
    - agentic_first: bool — True = use agentic tool loop (default), False = single-shot
    """

    role: str = "BaseAgent"
    capabilities: list[str] = []
    tools: list[str] = []
    system_prompt: str = ""
    max_tokens: int = 4096
    timeout: int = 0
    max_steps: int = 8           # max tool loop steps when agentic_first=True
    agentic_first: bool = True   # use run_agentic_task() instead of _run()
    prefer_agentic_with_custom_run: bool = False
    required_tool_evidence: frozenset[str] = frozenset()

    def __init_subclass__(cls, **kwargs):
        """Bind built-in worker classes to the canonical role registry.

        Custom agents keep their declared metadata.  Built-ins may retain
        legacy class literals during migration, but those literals are no
        longer authoritative and cannot drift at runtime.
        """

        super().__init_subclass__(**kwargs)
        try:
            from arforge.core.subagent import get_subagent_role_spec

            spec = get_subagent_role_spec(getattr(cls, "role", ""))
        except ValueError:
            return
        if spec.orchestrator_role is None:
            return
        cls.role = spec.orchestrator_role
        cls.capabilities = list(spec.capabilities)
        cls.tools = list(spec.tools)
        cls.system_prompt = spec.system_prompt
        cls.max_steps = spec.max_steps
        cls.max_tokens = spec.max_tokens
        cls.timeout = spec.timeout
        cls.required_tool_evidence = spec.required_tool_evidence

    def __init__(self, master: MasterAgent | None = None):
        self.master = master
        self._adapter = None
        self._channel: AgentChannel | None = None  # set during execute()

    # ——————————————————————————————————————————
    # Public API
    # ——————————————————————————————————————————

    def execute(self, task: Task, conversation) -> TaskResult:
        """Main entry point: execute a Task and return a TaskResult.

        Routes to agentic tool loop by default (agentic_first=True) or
        single-shot _run() for backward-compatible agents.

        Times execution, catches exceptions, and always returns a TaskResult
        (never raises).
        """
        from arforge.core import hooks
        if conversation is None:
            from arforge.multiagent.protocol import Conversation

            conversation = Conversation(master_goal=task.goal)

        custom_run = type(self)._run is not SubAgent._run
        mocked_model_call = "_call_model" in self.__dict__
        use_agentic = (
            self.agentic_first
            and not mocked_model_call
            and (not custom_run or self.prefer_agentic_with_custom_run)
        )

        # Set up inter-agent channel
        self._channel = AgentChannel(conversation, self.role)

        # Fire lifecycle event
        hooks.fire_event(
            hooks.HookEvent.SUBAGENT_START, role=self.role, conversation=conversation,
            metadata={"task_id": task.task_id, "goal": task.goal, "agentic": use_agentic},
        )

        # Update status
        set_agent_status(conversation, AgentStatus(
            role=self.role, state="running", task_id=task.task_id,
            started_at=time.time(),
        ))

        started = time.perf_counter()
        result: TaskResult | None = None

        try:
            if use_agentic:
                result = self._execute_agentic(task, conversation, started)
            else:
                result = self._execute_legacy(task, conversation, started)

            # Post result to shared memory for other agents to consume
            if self._channel:
                with conversation._lock:
                    self._channel.broadcast("result", {
                        "task_id": task.task_id,
                        "role": self.role,
                        "success": result.success,
                        "summary": (result.output or result.error)[:300],
                    })

            return result

        except Exception as exc:  # noqa: BLE001 - public execute() must return TaskResult
            elapsed = int((time.perf_counter() - started) * 1000)
            result = TaskResult(
                task_id=task.task_id,
                role=self.role,
                success=False,
                error=f"{type(exc).__name__}: {exc}",
                elapsed_ms=elapsed,
            )
            if self._channel:
                with conversation._lock:
                    self._channel.broadcast("result", {
                        "task_id": task.task_id,
                        "role": self.role,
                        "success": False,
                        "summary": result.error[:300],
                    })
            return result

        finally:
            elapsed = time.perf_counter() - started
            status = AgentStatus(
                role=self.role, task_id=task.task_id,
                state="done" if (result and result.success) else "error",
                finished_at=time.time(), tokens_used=getattr(result, "tokens_used", 0),
                progress="completed" if (result and result.success) else f"failed: {getattr(result, 'error', '')}",
            )
            set_agent_status(conversation, status)
            hooks.fire_event(
                hooks.HookEvent.SUBAGENT_STOP, role=self.role, conversation=conversation,
                metadata={
                    "task_id": task.task_id,
                    "success": getattr(result, "success", False),
                    "tokens_used": getattr(result, "tokens_used", 0),
                    "elapsed_ms": int(elapsed * 1000),
                },
            )

    def _execute_agentic(self, task: Task, conversation, started: float) -> TaskResult:
        """Execute using the full agentic tool loop (default for agentic_first=True)."""
        from arforge.multiagent import security

        loop_result = self.run_agentic_task(task, conversation, max_steps=self.max_steps)
        elapsed = int((time.perf_counter() - started) * 1000)

        tokens_used = getattr(loop_result, "observability", None)
        if isinstance(tokens_used, dict):
            tokens_used = tokens_used.get("summary", {}).get("tokens_estimated", 0)
        else:
            tokens_used = 0

        # Token budget check
        if not security.check_token_budget(self.get_role(), tokens_used):
            return TaskResult(
                task_id=task.task_id,
                role=self.role,
                success=False,
                output=loop_result.answer,
                error=f"token budget exceeded ({tokens_used}/{self.max_tokens})",
                elapsed_ms=elapsed,
                tokens_used=tokens_used,
                tool_calls=loop_result.tool_calls,
            )

                # Determine success from observability data (not string matching)
        obs = loop_result.observability or {}
        summary = obs.get("summary", {}) if isinstance(obs, dict) else {}
        had_errors = summary.get("errors", 0) > 0
        has_answer = bool(loop_result.answer and len(loop_result.answer.strip()) > 1)
        successful_tools = {
            str(item.get("tool", ""))
            for item in (loop_result.tool_calls or [])
            if item.get("success")
        }
        if self.required_tool_evidence and not (
            successful_tools & self.required_tool_evidence
        ):
            return TaskResult(
                task_id=task.task_id,
                role=self.role,
                success=False,
                output=loop_result.answer,
                error=(
                    "grounding required: no successful evidence tool call; expected one of "
                    + ", ".join(sorted(self.required_tool_evidence))
                ),
                elapsed_ms=elapsed,
                tokens_used=tokens_used,
                tool_calls=loop_result.tool_calls,
                artifacts={"trace": loop_result.trace, "observability": loop_result.observability},
            )
        # A role with explicit grounding requirements may legitimately probe an
        # optional source after it already gathered sufficient evidence (for
        # example, a project search followed by a denied web lookup).  Treat the
        # grounded answer as successful; otherwise one optional-tool denial
        # aborts every dependent planning/coding stage even though the required
        # workspace evidence is present.
        grounded = bool(successful_tools & self.required_tool_evidence)
        success = has_answer and (grounded if self.required_tool_evidence else not had_errors)

        return TaskResult(
            task_id=task.task_id,
            role=self.role,
            success=success,
            output=loop_result.answer,
            tool_calls=loop_result.tool_calls,
            elapsed_ms=elapsed,
            tokens_used=tokens_used,
            artifacts={"trace": loop_result.trace, "observability": loop_result.observability},
        )

    def _execute_legacy(self, task: Task, conversation, started: float) -> TaskResult:
        """Legacy single-shot execution (when agentic_first=False)."""
        from arforge.multiagent import security

        try:
            output, artifacts, evidence, tool_calls = self._run(task, conversation)
            elapsed = int((time.perf_counter() - started) * 1000)
            tokens_used = getattr(self, "_last_tokens", 0)

            if not security.check_token_budget(self.get_role(), tokens_used):
                return TaskResult(
                    task_id=task.task_id, role=self.role, success=False,
                    output=output,
                    error=f"token budget exceeded ({tokens_used}/{self.max_tokens})",
                    elapsed_ms=elapsed, tokens_used=tokens_used,
                )

            return TaskResult(
                task_id=task.task_id, role=self.role, success=True,
                output=output, artifacts=artifacts, evidence=evidence,
                tool_calls=tool_calls, elapsed_ms=elapsed, tokens_used=tokens_used,
            )
        except Exception as exc:
            elapsed = int((time.perf_counter() - started) * 1000)
            return TaskResult(
                task_id=task.task_id, role=self.role, success=False,
                output="", error=f"{type(exc).__name__}: {exc}",
                elapsed_ms=elapsed,
            )

    # ——————————————————————————————————————————
    # Core logic (override in subclasses)
    # ——————————————————————————————————————————

    def _run(self, task: Task, conversation) -> tuple[str, dict, list, list]:
        """Core execution logic — override in subclasses.

        Default implementation: build prompt -> call LLM -> return text output.
        Only used when agentic_first=False.

        Returns:
            (output_text, artifacts_dict, evidence_list, tool_calls_list)
        """
        messages = self._build_prompt(task, conversation)
        raw = self._call_model(messages)
        return raw, {}, [], []

    # ——————————————————————————————————————————
    # Prompt construction
    # ——————————————————————————————————————————

    def _build_prompt(self, task: Task, conversation) -> list[dict]:
        """Build the messages array for the model call.

        Injects: system prompt (role prefix) + task goal + inputs +
        outputs of dependency tasks (but NOT internal prompts).
        Also injects inter-agent messages addressed to this role.
        """
        system = self.system_prompt or f"You are {self.role}. Complete the task and return results."

        # Add whitelist context
        if self.capabilities:
            system += "\n\nAvailable capabilities: " + ", ".join(self.capabilities)
        if self.tools:
            system += "\nAvailable tools: " + ", ".join(self.tools)

        # Inject project memory / context (shared, read-only)
        shared = getattr(conversation, "shared_memory", None)
        if isinstance(shared, dict) and shared.get("context"):
            system += "\n\nReference (from project memory/knowledge, read-only):\n" + str(shared["context"])[:2000]

        # Inject inter-agent messages
        if self._channel:
            msgs = self._channel.receive()
            if msgs:
                parts = ["\n\nInter-agent messages:"]
                for m in msgs[-5:]:  # last 5 messages
                    parts.append(f"  [{m.sender} -> {m.recipient or 'all'}] ({m.kind}): {str(m.payload)[:300]}")
                system += "\n".join(parts)

        # Add task context
        user = f"Task goal: {task.goal}"

        if task.inputs:
            user += f"\n\nInput data:\n{self._format_dict(task.inputs)}"

        if task.constraints:
            user += "\n\nConstraints:\n" + "\n".join(f"- {c}" for c in task.constraints)

        # Add dependency results (outputs only)
        if task.depends_on:
            dep_results = []
            for dep_id in task.depends_on:
                dep_result = conversation.result_for(dep_id)
                if dep_result and dep_result.success:
                    dep_results.append(f"[{dep_result.role}] {dep_result.output[:500]}")
            if dep_results:
                user += "\n\nPreceding task results:\n" + "\n---\n".join(dep_results)

        return [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]

    # ——————————————————————————————————————————
    # Role definition
    # ——————————————————————————————————————————

    @classmethod
    def get_role(cls) -> AgentRole:
        """Return the AgentRole definition for this SubAgent class."""
        try:
            from arforge.core.subagent import get_subagent_role_spec

            spec = get_subagent_role_spec(cls.role)
        except ValueError:
            spec = None
        if spec is not None and spec.orchestrator_role is not None:
            return AgentRole(
                name=spec.orchestrator_role,
                description=spec.description,
                capabilities=list(spec.capabilities),
                tools=list(spec.tools),
                max_tokens=spec.max_tokens,
                timeout=spec.timeout,
                system_prompt=spec.system_prompt,
            )
        return AgentRole(
            name=cls.role,
            description=cls.__doc__ or cls.role,
            capabilities=cls.capabilities,
            tools=cls.tools,
            max_tokens=cls.max_tokens,
            timeout=cls.timeout,
            system_prompt=cls.system_prompt,
        )

    # ——————————————————————————————————————————
    # Helpers
    # ——————————————————————————————————————————

    def _call_model(self, messages: list[dict]) -> str:
        """Call the model adapter. Uses master.agent.adapter if available.

        Records approximate completion tokens to self._last_tokens for
        budget checks (P0-1).
        """
        result = None
        if self.master and self.master.agent:
            try:
                result = self.master.agent.adapter.generate(
                    messages, max_tokens=self.max_tokens, temperature=0.3
                )
            except Exception:
                result = None

        if result is None:
            try:
                from arforge.product.model_config_runtime import get_model_config

                adapter = get_model_config().create_active_adapter()
                result = adapter.generate(messages, max_tokens=self.max_tokens, temperature=0.3)
            except Exception:
                result = f"[{self.role}] Model call failed. Check API configuration."

        self._last_tokens = _estimate_tokens(result)
        return result

    # ——————————————————————————————————————————
    # Agentic execution (P1-6) — real tool loop, replaces single-shot prompt
    # ——————————————————————————————————————————

    def _get_adapter(self):
        """Resolve model adapter: prefer master's shared adapter, otherwise create new."""
        if self.master is not None and getattr(self.master, "agent", None) is not None:
            return self.master.agent.adapter
        from arforge.core.subagent import get_subagent_adapter

        bound_adapter = get_subagent_adapter()
        if bound_adapter is not None:
            return bound_adapter
        from arforge.product.model_config_runtime import get_model_config

        return get_model_config().create_active_adapter()

    def _allowed_tools(self) -> list[dict]:
        """Role-whitelisted function-calling tool set."""
        from arforge.tool_registry import REGISTRY
        all_tools = REGISTRY.to_openai_tools(deferred=False)
        if not self.tools:
            return all_tools
        allowed = set(self.tools)
        include_team_tools = type(self) is SubAgent
        if not include_team_tools:
            try:
                from arforge.team_runtime import TeamRuntimeError, get_team_manager
                from arforge.workspace_context import current_session_id

                get_team_manager().get(current_session_id())
                include_team_tools = True
            except (TeamRuntimeError, OSError, ValueError):
                include_team_tools = False
        if include_team_tools:
            allowed.update({
                "team_message_send",
                "team_message_list",
                "team_shutdown_respond",
            })
        return [t for t in all_tools if t["function"]["name"] in allowed]

    def run_agentic_task(self, task: Task, conversation, max_steps: int = 6):
        """Execute task using real tool loop (P1-6).

        Unlike default _run() (single-shot prompt), this enables the model
        to autonomously call tools, iterate, and self-correct within the
        role's tool whitelist via function calling.

        Reuses core.agentic.run_tool_loop (same implementation as the main
        AgentLoopV2.run_agentic, avoiding duplication).

        Returns ToolLoopResult (answer / tool_calls / trace / observability).
        """
        import config
        from arforge.core.compaction import install_compaction_hook
        from arforge.core.subagent import (
            execute_subagent_loop,
            get_subagent_parent_should_stop,
            get_subagent_role_spec,
        )
        from arforge.multiagent import security
        from arforge.tools import load_builtin_tools

        load_builtin_tools()
        messages = self._build_prompt(task, conversation)
        from arforge.reasoning.effort import adjust_step_budget, normalize_reasoning_effort
        from arforge.reasoning.prompts import select_reasoning_by_effort

        effort = normalize_reasoning_effort(
            getattr(conversation, "get_shared", lambda *_: "medium")(
                "_reasoning_effort",
                "medium",
            )
        )
        max_steps = adjust_step_budget(max_steps, effort, cap=24)
        reasoning_prompt = select_reasoning_by_effort(effort)
        system_message = next(
            (item for item in messages if item.get("role") == "system"),
            None,
        )
        if system_message is None:
            messages.insert(0, {"role": "system", "content": reasoning_prompt})
        else:
            system_message["content"] = (
                f"{system_message.get('content', '')}\n\n{reasoning_prompt}".strip()
            )
        task_deadline = (
            time.monotonic() + task.deadline_ms / 1000.0
            if task.deadline_ms > 0
            else None
        )

        def should_stop() -> bool:
            parent_should_stop = get_subagent_parent_should_stop()
            if callable(parent_should_stop) and parent_should_stop():
                return True
            task_cancelled = getattr(conversation, "task_cancelled", None)
            if callable(task_cancelled) and task_cancelled(task.task_id):
                return True
            return task_deadline is not None and time.monotonic() >= task_deadline

        def report(event: str, **data) -> None:
            emit = getattr(conversation, "emit_progress", None)
            if callable(emit):
                emit(event, task_id=task.task_id, role=self.role, **data)

        def on_intermediate(note: str) -> None:
            report("agent_progress", message=str(note)[:500])

        def on_tool_start(tool_name: str, arguments: dict, step: int) -> None:
            report(
                "agent_tool_start",
                tool=tool_name,
                arguments=arguments,
                step=step,
            )

        def on_tool_complete(tool_name: str, _arguments: dict, result, step: int) -> None:
            report(
                "agent_tool_end",
                tool=tool_name,
                success=bool(getattr(result, "success", False)),
                error=str(getattr(result, "error", "") or "")[:500],
                step=step,
            )

        # Install security + compaction hooks for subagent sandbox
        security.install_security_hooks()
        install_compaction_hook()
        try:
            from arforge.core.change_tracker import install_change_tracker_hook
            install_change_tracker_hook()
        except Exception:
            pass

        run_budget = int(getattr(config, "SUBAGENT_RUN_TOKEN_BUDGET", 0) or 0)
        try:
            # This resolves the execution-session/worktree override that the
            # dispatcher propagated into the worker thread.
            from arforge.tools.file_tools import get_workspace

            task_workspace = get_workspace()
        except Exception:  # noqa: BLE001 - security falls back to its safe default root
            task_workspace = None

        with (
            security.role_scope(self.get_role()),
            security.task_scope(
                conversation,
                task.task_id,
                workspace=task_workspace,
                constraints=task.constraints,
            ),
        ):
            remaining = (
                max(0.001, task_deadline - time.monotonic())
                if task_deadline is not None
                else None
            )
            conversation_remaining = getattr(conversation, "deadline_remaining", None)
            if conversation_remaining is not None:
                remaining = (
                    min(remaining, max(0.001, conversation_remaining))
                    if remaining is not None
                    else max(0.001, conversation_remaining)
                )
            configured_model_timeout = float(self.timeout)
            model_timeout = (
                min(configured_model_timeout, remaining)
                if configured_model_timeout > 0 and remaining is not None
                else configured_model_timeout
                if configured_model_timeout > 0
                else remaining
            )
            tool_schemas = self._allowed_tools()
            try:
                runtime_role = get_subagent_role_spec(self.role).name
            except ValueError:
                runtime_role = self.role
            return execute_subagent_loop(
                self._get_adapter(),
                messages,
                role=runtime_role,
                allowed_tool_names=[
                    item["function"]["name"] for item in tool_schemas
                ],
                tool_schemas=tool_schemas,
                max_steps=max_steps,
                span_name=f"subagent.{self.role}",
                on_intermediate=on_intermediate,
                on_tool_start=on_tool_start,
                on_tool_complete=on_tool_complete,
                should_stop=should_stop,
                model_timeout_seconds=model_timeout,
                token_budget=run_budget,
            )

    # ——————————————————————————————————————————
    # Inter-agent communication helpers
    # ——————————————————————————————————————————

    def notify(self, conversation, recipient: str, kind: str, payload: Any) -> None:
        """Send a typed message to another agent (or broadcast if recipient='')."""
        if self._channel is None:
            self._channel = AgentChannel(conversation, self.role)
        self._channel.send(recipient, kind, payload)

    def ask(self, conversation, recipient: str, question: str) -> None:
        """Ask another agent a question — they'll see it in their injected context."""
        self.notify(conversation, recipient, "request", {"question": question})

    def delegate_to(self, conversation, recipient_role: str, goal: str,
                    context: dict | None = None, priority: int = 100) -> str | None:
        """Spawn a child task delegated to another agent.

        A running agent can dynamically
        create work for another agent. The delegated task is added to the
        conversation delegation queue and will be picked up by the dispatcher.

        Returns the new task_id, or None if the conversation doesn't support delegation.
        """
        import uuid
        from arforge.multiagent.protocol import Task

        if not hasattr(conversation, "enqueue_delegated_task"):
            return None

        task_id = f"delegated_{self.role}_{uuid.uuid4().hex[:8]}"
        inputs = context or {}
        inputs["_delegated_by"] = self.role

        task = Task(
            task_id=task_id,
            role=recipient_role,
            goal=f"[Delegated by {self.role}] {goal}",
            inputs=inputs,
            depends_on=[],  # delegated tasks are independent
            priority=priority,
        )

        conversation.enqueue_delegated_task(task)

        # Also notify via channel for observability
        if self._channel:
            self._channel.send(recipient_role, "delegation", {
                "task_id": task_id,
                "goal": goal,
            })

        return task_id

    def handoff(self, conversation, recipient: str, context: dict) -> str | None:
        """Hand off work to another agent with structured context.

        Unlike delegate_to() which spawns a child task while the sender continues,
        handoff() transfers responsibility: the sender marks this task as handed-off
        and the recipient receives a new task with the full context.

        Returns the new task_id, or None on failure.
        """
        self.notify(conversation, recipient, "handoff", context)

        # Also enqueue a delegated task for the recipient
        goal = context.get("goal", "Handed off from " + self.role)
        return self.delegate_to(conversation, recipient, goal, context, priority=50)

    @staticmethod
    def _format_dict(d: dict, indent: int = 0) -> str:
        """Format a dict for prompt injection (limited depth)."""
        lines = []
        for k, v in d.items():
            if isinstance(v, str) and len(v) > 200:
                v = v[:200] + "..."
            elif isinstance(v, dict):
                v = "{...}"
            elif isinstance(v, list):
                v = f"[{len(v)} items]"
            lines.append(f"{'  ' * indent}{k}: {v}")
        return "\n".join(lines)
