"""Authenticated local Web control center for the canonical Agent runtime.

The Web surface is a thin client over the same Bridge contract used by the
desktop application. It does not create a second model loop or bypass
permissions, compaction, persistence, tools, or cancellation.
"""

from __future__ import annotations

import asyncio
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass
import hmac
import json
import os
from pathlib import Path
import queue
import threading
from typing import Any, AsyncIterator

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from arforge.paths import data_path
from arforge.product.action_runtime import ActionRuntime
from arforge.product.feedback_runtime import FeedbackRuntime
from arforge.product.goal_runtime import GoalRuntime
from arforge.product.keybinding_runtime import KeybindingRuntime
from arforge.product.log_runtime import LogRuntime
from arforge.product.prompt_queue_runtime import PromptQueueRuntime
from arforge.product.session_runtime import SessionRuntime
from arforge.product.settings_runtime import SettingsRuntime
from arforge.product.state_store import BridgeStateStore
from arforge.product.direct_dispatch import install_agentic_hooks, register_builtin_tools
from arforge.product.task_runtime import TaskRuntime, TaskStore
from arforge.security_guard import sanitize_for_storage

WEB_PROTOCOL = "arforge.web-control"
WEB_PROTOCOL_VERSION = "1.0"

MAX_WEB_REQUEST_BYTES = 256 * 1024
MAX_WEB_EVENT_BYTES = 128 * 1024
MAX_WEB_EVENTS = 1_000
MAX_WEB_SUBSCRIBER_QUEUE = 256


class WebControlError(Exception):
    """Error surfaced through the web control request envelope."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class WebEvent:
    event_id: int
    payload: dict[str, Any]


class WebEventBroker:
    """Bounded fan-out broker with replay for reconnecting browser clients."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._events: deque[WebEvent] = deque(maxlen=MAX_WEB_EVENTS)
        self._subscribers: set[queue.Queue[WebEvent]] = set()
        self._next_id = 1

    def publish(self, payload: dict[str, Any]) -> None:
        safe = sanitize_for_storage(payload)
        if not isinstance(safe, dict):
            return
        encoded = json.dumps(safe, ensure_ascii=False, default=str)
        if len(encoded.encode("utf-8")) > MAX_WEB_EVENT_BYTES:
            safe = {
                "session_id": str(safe.get("session_id", ""))[:120],
                "operation_id": str(safe.get("operation_id", ""))[:120],
                "sequence": safe.get("sequence", 0),
                "timestamp": str(safe.get("timestamp", ""))[:64],
                "type": str(safe.get("type", "event.truncated"))[:120],
                "data": {"truncated": True},
            }
        with self._lock:
            item = WebEvent(self._next_id, safe)
            self._next_id += 1
            self._events.append(item)
            for subscriber in tuple(self._subscribers):
                if subscriber.full():
                    try:
                        subscriber.get_nowait()
                    except queue.Empty:
                        pass
                try:
                    subscriber.put_nowait(item)
                except queue.Full:
                    pass

    def subscribe(
        self,
        *,
        session_id: str,
        after_id: int,
    ) -> tuple[list[WebEvent], queue.Queue[WebEvent]]:
        subscriber: queue.Queue[WebEvent] = queue.Queue(MAX_WEB_SUBSCRIBER_QUEUE)
        with self._lock:
            backlog = [
                item
                for item in self._events
                if item.event_id > after_id
                and str(item.payload.get("session_id", "")) == session_id
            ]
            self._subscribers.add(subscriber)
        return backlog, subscriber

    def unsubscribe(self, subscriber: queue.Queue[WebEvent]) -> None:
        with self._lock:
            self._subscribers.discard(subscriber)


class WebBridgeRequest(BaseModel):
    method: str = Field(..., min_length=1, max_length=120)
    params: dict[str, Any] = Field(default_factory=dict)


class WebEventRequest(BaseModel):
    session_id: str = Field(..., min_length=1, max_length=120)
    after_id: int = Field(default=0, ge=0)


class WebControlBundle:
    """Own the shared Bridge runtimes and their orderly shutdown."""

    def __init__(self, workspace: Path):
        self.workspace = workspace.resolve()
        self.broker = WebEventBroker()
        self.goals = GoalRuntime(data_path("state", "goals.db"))
        self.store = BridgeStateStore(data_path("state", "bridge_state.db"))
        self.project = self.store.ensure_project(self.workspace)
        self.settings = SettingsRuntime(data_path("settings.json"), data_path(".arforge_lang"))
        self.keybindings = KeybindingRuntime(data_path("keybindings.json"))
        self.feedback = FeedbackRuntime(data_path("state", "feedback.db"))
        self.logs = LogRuntime(data_path("logs", "arforge.log"))
        if not os.environ.get("ARFORGE_WORKSPACE"):
            try:
                from arforge.trust_screen import _auto_trust_enabled, is_workspace_trusted

                if _auto_trust_enabled() or is_workspace_trusted():
                    os.environ["ARFORGE_WORKSPACE"] = "trust-cwd"
            except Exception:  # noqa: BLE001 - trust probing must not block startup
                pass
        register_builtin_tools()
        install_agentic_hooks()
        from arforge.scheduled_prompt_runtime import get_scheduled_prompt_manager

        self.scheduler = get_scheduled_prompt_manager()
        self.prompt_queue = PromptQueueRuntime(data_path("state", "prompt_queue.db"))

        def emit_event(event: dict[str, Any]) -> None:
            self.goals.observe_event(event)
            self.broker.publish(event)

        self.runtime = SessionRuntime(
            emit_event,
            store=self.store,
            project=self.project,
            scheduler=self.scheduler,
            prompt_queue=self.prompt_queue,
        )

        def emit_schedule_event(event: dict[str, Any]) -> None:
            data = event.get("data")
            session_id = data.get("session_id") if isinstance(data, dict) else ""
            emit_event({"session_id": session_id or "", "sequence": 0, **event})

        self.scheduler.start(self.runtime.enqueue_scheduled_prompt, on_event=emit_schedule_event)

        def emit_action(event: dict[str, Any]) -> None:
            session_id = event.get("session_id")
            if isinstance(session_id, str) and "operation_id" not in event:
                operation_id = self.runtime.active_operation_id(session_id)
                if operation_id:
                    event = {**event, "operation_id": operation_id}
            emit_event(event)

        self.actions = ActionRuntime(self.workspace, emit_action, store=self.store)
        self.tasks = TaskRuntime(
            self.actions,
            emit_event,
            TaskStore(data_path("state", "bridge_tasks.db")),
        )
        self._request_lock = threading.RLock()
        self._next_request_id = 1

    def request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        with self._request_lock:
            request_id = self._next_request_id
            self._next_request_id += 1
            try:
                data = self._dispatch(method, params)
            except WebControlError as exc:
                return {
                    "protocol": WEB_PROTOCOL,
                    "version": WEB_PROTOCOL_VERSION,
                    "id": request_id,
                    "ok": False,
                    "error": {"code": exc.code, "message": exc.message},
                }
            except ValueError as exc:
                return {
                    "protocol": WEB_PROTOCOL,
                    "version": WEB_PROTOCOL_VERSION,
                    "id": request_id,
                    "ok": False,
                    "error": {"code": "INVALID_PARAMS", "message": str(exc)},
                }
            except Exception as exc:  # noqa: BLE001 - surface a stable envelope
                return {
                    "protocol": WEB_PROTOCOL,
                    "version": WEB_PROTOCOL_VERSION,
                    "id": request_id,
                    "ok": False,
                    "error": {"code": "BACKEND_ERROR", "message": sanitize_for_storage(str(exc))[:1000]},
                }
            response: dict[str, Any] = {
                "protocol": WEB_PROTOCOL,
                "version": WEB_PROTOCOL_VERSION,
                "id": request_id,
                "ok": True,
                "data": data,
            }
            if method == "chat.start":
                self.runtime.release_operation(response["data"]["operation_id"])
            if method == "tool.execute_async":
                self.tasks.release_task(response["data"]["task_id"])
            return response

    def _dispatch(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        """Dispatch session/chat methods straight to the shared runtimes.

        The web control center is a thin client over the canonical agent
        runtime; it never re-implements the loop, permissions, or persistence.
        """
        runtime = self.runtime
        if method == "project.list":
            return runtime.list_projects()
        if method == "session.create":
            return runtime.create_session(project_id=params.get("project_id"))
        if method == "session.fork":
            return runtime.fork_session(params.get("session_id"), params.get("message_id"))
        if method == "session.get":
            return runtime.get_session(params.get("session_id"))
        if method == "session.rename":
            return runtime.rename_session(params.get("session_id"), params.get("title"))
        if method == "session.tags.update":
            return runtime.update_session_tags(params.get("session_id"), params.get("tags"))
        if method == "session.list":
            return runtime.filter_sessions(
                limit=params.get("limit", 50),
                project_id=params.get("project_id"),
                tags=params.get("tags"),
                status=params.get("status"),
                query=params.get("query"),
                archive=params.get("archive", "exclude"),
            )
        if method == "session.messages":
            return runtime.get_messages(params.get("session_id"), params.get("limit", 500))
        if method == "session.export":
            return runtime.export_session(params.get("session_id"), params.get("format", "markdown"))
        if method == "session.import":
            return runtime.import_session(params.get("content"))
        if method == "session.context.import":
            return runtime.import_context(
                params.get("session_id"),
                content=params.get("content"),
                source=params.get("source"),
                source_session_id=params.get("source_session_id"),
            )
        if method == "session.compact":
            return runtime.compact_session(params.get("session_id"), params.get("focus", ""))
        if method == "session.archive":
            return runtime.archive_session(params.get("session_id"))
        if method == "session.resume":
            return runtime.resume_session(params.get("session_id"))
        if method == "session.close":
            return runtime.close_session(params.get("session_id"))
        if method == "session.checkpoint.create":
            return runtime.create_checkpoint(
                params.get("session_id"),
                description=params.get("description", ""),
            )
        if method == "session.checkpoint.list":
            return runtime.list_checkpoints(params.get("session_id"))
        if method == "session.rewind.preview":
            return runtime.preview_rewind(params.get("session_id"), params.get("checkpoint_id"))
        if method == "session.rewind.apply":
            return runtime.apply_rewind(params.get("session_id"), params.get("checkpoint_id"))
        if method == "chat.start":
            return runtime.start_chat(
                params.get("session_id"),
                params.get("input"),
                params.get("timeout_ms"),
                reasoning_effort=params.get("reasoning_effort", "medium"),
                permission_mode=params.get("permission_mode"),
                context=params.get("context"),
            )
        if method == "chat.resume":
            return runtime.resume_incomplete_chat(
                params.get("session_id"),
                params.get("timeout_ms"),
                reasoning_effort=params.get("reasoning_effort", "medium"),
                permission_mode=params.get("permission_mode"),
                context=params.get("context"),
            )
        if method == "chat.enqueue":
            return runtime.enqueue_chat(
                params.get("session_id"),
                params.get("input"),
                params.get("timeout_ms"),
                reasoning_effort=params.get("reasoning_effort", "medium"),
                permission_mode=params.get("permission_mode"),
                context=params.get("context"),
            )
        if method == "chat.queue.list":
            return runtime.list_queued_chats(params.get("session_id"))
        if method == "chat.queue.delete":
            return runtime.delete_queued_chat(params.get("session_id"), params.get("queue_id"))
        if method == "chat.side.ask":
            return runtime.start_side_question(
                params.get("session_id"),
                params.get("question"),
                params.get("timeout_ms"),
                reasoning_effort=params.get("reasoning_effort", "low"),
            )
        if method == "chat.side.get":
            return runtime.get_side_question(params.get("session_id"), params.get("side_question_id"))
        if method == "chat.side.list":
            return runtime.list_side_questions(params.get("session_id"))
        if method == "chat.side.cancel":
            return runtime.cancel_side_question(params.get("session_id"), params.get("side_question_id"))
        if method == "chat.steer":
            return runtime.steer_operation(params.get("operation_id"), params.get("instruction"))
        if method == "history.search":
            return runtime.search_history(params.get("query"), params.get("limit", 50))
        if method == "chat.cancel":
            return runtime.cancel_operation(params.get("operation_id"))
        if method == "operation.get":
            return runtime.get_operation(params.get("operation_id"))
        if method == "tool.execute_async":
            return self.tasks.submit_tool(
                params.get("session_id"),
                params.get("action_id"),
                params.get("approval_id"),
            )
        raise WebControlError("METHOD_NOT_FOUND", f"unknown method: {method}")

    def close(self) -> None:
        self.scheduler.stop()
        self.tasks.shutdown()
        self.runtime.shutdown()


def create_web_control_app(
    *,
    workspace: Path | None = None,
    token: str,
    bundle: WebControlBundle | None = None,
) -> FastAPI:
    """Create an authenticated same-origin control app.

    ``token`` is supplied by the launcher and is never embedded in HTML.
    """

    if not isinstance(token, str) or len(token) < 32:
        raise ValueError("Web control token must contain at least 32 characters")
    resolved_workspace = (workspace or Path.cwd()).resolve()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        owned = bundle is None
        app.state.control = bundle or WebControlBundle(resolved_workspace)
        try:
            yield
        finally:
            if owned:
                app.state.control.close()

    app = FastAPI(
        title="Arforge Local Control",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )

    @app.middleware("http")
    async def secure_web_request(request: Request, call_next):
        if request.url.path.startswith("/api/"):
            content_length = request.headers.get("content-length")
            if content_length:
                try:
                    if int(content_length) > MAX_WEB_REQUEST_BYTES:
                        return JSONResponse(
                            status_code=413,
                            content={"ok": False, "error": {"code": "REQUEST_TOO_LARGE", "message": "request exceeds 256 KiB"}},
                        )
                except ValueError:
                    return JSONResponse(
                        status_code=400,
                        content={"ok": False, "error": {"code": "INVALID_REQUEST", "message": "invalid content length"}},
                    )
            authorization = request.headers.get("authorization", "")
            scheme, _, supplied = authorization.partition(" ")
            if (
                scheme.casefold() != "bearer"
                or not supplied
                or not hmac.compare_digest(supplied, token)
            ):
                return JSONResponse(
                    status_code=401,
                    content={"ok": False, "error": {"code": "UNAUTHORIZED", "message": "authentication required"}},
                    headers={"WWW-Authenticate": "Bearer"},
                )
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; img-src 'self' data:; "
            "style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; "
            "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
        )
        return response

    @app.get("/", response_class=HTMLResponse)
    async def index():
        return HTMLResponse(WEB_CONTROL_HTML)

    @app.get("/api/health")
    async def health(request: Request):
        control: WebControlBundle = request.app.state.control
        return {
            "ok": True,
            "data": {
                "status": "ready",
                "workspace": str(control.workspace),
                "protocol": WEB_PROTOCOL_VERSION,
            },
        }

    @app.post("/api/bridge")
    async def bridge_request(payload: WebBridgeRequest, request: Request):
        control: WebControlBundle = request.app.state.control
        return await asyncio.to_thread(control.request, payload.method, payload.params)

    @app.post("/api/events")
    async def event_stream(payload: WebEventRequest, request: Request):
        control: WebControlBundle = request.app.state.control

        async def generate() -> AsyncIterator[str]:
            backlog, subscriber = control.broker.subscribe(
                session_id=payload.session_id,
                after_id=payload.after_id,
            )
            try:
                for item in backlog:
                    yield _sse(item)
                while not await request.is_disconnected():
                    try:
                        item = await asyncio.to_thread(subscriber.get, True, 15.0)
                    except queue.Empty:
                        yield ": keepalive\n\n"
                        continue
                    if str(item.payload.get("session_id", "")) == payload.session_id:
                        yield _sse(item)
            finally:
                control.broker.unsubscribe(subscriber)

        return StreamingResponse(
            generate(),
            media_type="text/event-stream",
            headers={"X-Accel-Buffering": "no"},
        )

    return app


def _sse(item: WebEvent) -> str:
    payload = {"web_event_id": item.event_id, **item.payload}
    return f"id: {item.event_id}\ndata: {json.dumps(payload, ensure_ascii=False, separators=(',', ':'))}\n\n"


WEB_CONTROL_HTML = r"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Arforge 本地控制端</title>
<style>
:root{color-scheme:dark;font-family:Inter,"Segoe UI",sans-serif;background:#101211;color:#e7e9e6}
*{box-sizing:border-box}body{margin:0;height:100vh;overflow:hidden}button,input,textarea,select{font:inherit}
button{cursor:pointer}.app{display:grid;grid-template-columns:280px minmax(0,1fr);height:100vh}
aside{display:flex;flex-direction:column;border-right:1px solid #303431;background:#171a18}
.brand{padding:20px;border-bottom:1px solid #303431}.brand strong{display:block;font-size:18px}.brand small{color:#8d9690}
.new{margin:14px;padding:10px;border:1px solid #3e4740;border-radius:8px;color:#e7e9e6;background:#242925}
#sessions{min-height:0;overflow:auto;padding:0 10px 12px}.session{display:block;width:100%;padding:10px;border:0;border-radius:8px;color:#aab1ac;background:transparent;text-align:left}
.session:hover,.session.active{color:#fff;background:#252a26}.session strong,.session small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.session small{margin-top:3px;color:#78817b;font-size:11px}
main{min-width:0;display:grid;grid-template-rows:auto minmax(0,1fr) auto;background:#121513}
header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:13px 18px;border-bottom:1px solid #303431;background:#171a18}
.meta{min-width:0}.meta strong,.meta small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.meta small{color:#8d9690}
.controls{display:flex;align-items:center;gap:8px}.controls select,.controls button{height:34px;border:1px solid #39403b;border-radius:7px;color:#d8ddd9;background:#232824}
.controls button{padding:0 10px}.gauge{display:flex;align-items:center;gap:7px;color:#9aa29c;font-size:12px}.bar{width:74px;height:6px;overflow:hidden;border-radius:9px;background:#303631}.bar i{display:block;height:100%;background:#83d5a7}
#messages{overflow:auto;padding:24px max(24px,calc((100% - 880px)/2));scrollbar-width:thin}.message{display:grid;grid-template-columns:34px minmax(0,1fr);gap:10px;margin-bottom:20px}.avatar{display:grid;width:30px;height:30px;place-items:center;border-radius:8px;background:#29302b;color:#9ee0b7}.message.user .avatar{color:#edc777}.bubble{min-width:0}.bubble b{display:block;margin-bottom:6px;font-size:12px}.bubble pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.65 Inter,"Segoe UI",sans-serif}.activity{color:#879089;font-size:12px}
.composer-wrap{padding:10px max(20px,calc((100% - 920px)/2)) 18px}.composer{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;padding:10px;border:1px solid #3b423d;border-radius:12px;background:#202421}
textarea{min-height:62px;max-height:180px;resize:vertical;padding:7px;border:0;outline:0;color:#eef0ed;background:transparent}
.composer-actions{display:flex;align-items:flex-end;gap:6px}.composer button{min-width:68px;height:36px;border:1px solid #465048;border-radius:8px;color:#e6eae7;background:#2c332e}.composer button.primary{color:#152018;background:#9ed8af}
.notice{min-height:18px;margin:0 4px 7px;color:#98a19b;font-size:12px}.error{color:#ff9c8d}
.login{position:fixed;inset:0;z-index:10;display:none;place-items:center;background:#101211}.login.show{display:grid}.login form{width:min(420px,calc(100% - 32px));display:grid;gap:12px;padding:24px;border:1px solid #343a36;border-radius:14px;background:#1b1f1c}.login input{padding:10px;border:1px solid #3d453f;border-radius:8px;color:#fff;background:#111412}
@media(max-width:720px){.app{grid-template-columns:1fr}aside{display:none}header{align-items:flex-start;flex-direction:column}.controls{width:100%;flex-wrap:wrap}#messages{padding:18px}.composer-wrap{padding:8px 10px 12px}}
</style></head><body>
<div class="login" id="login"><form id="loginForm"><strong>连接本地 Arforge</strong><small>输入启动命令显示的访问令牌。令牌只保存在当前浏览器会话。</small><input id="tokenInput" type="password" autocomplete="off" placeholder="访问令牌"><button>连接</button></form></div>
<div class="app"><aside><div class="brand"><strong>Arforge</strong><small id="workspace">本地控制端</small></div><button class="new" id="newSession">＋ 新建会话</button><div id="sessions"></div></aside>
<main><header><div class="meta"><strong id="title">选择或新建会话</strong><small id="state">未连接</small></div><div class="controls"><div class="gauge"><span id="contextText">上下文 —</span><span class="bar"><i id="contextBar" style="width:0"></i></span></div><select id="permission"><option value="requestApproval">需要审批</option><option value="autoApprove">自动审批</option><option value="fullAccess">完全访问</option></select><button id="refresh">刷新</button></div></header>
<section id="messages"></section><div class="composer-wrap"><p class="notice" id="notice"></p><form class="composer" id="composer"><textarea id="input" placeholder="向 Arforge 描述任务…"></textarea><div class="composer-actions"><button type="button" id="steer">引导</button><button type="button" id="cancel">停止</button><button class="primary" id="send">发送</button></div></form></div></main></div>
<script>
const state={token:"",sessions:[],session:null,operation:null,lastEvent:0,abort:null};
const $=id=>document.getElementById(id);
function tokenFromLocation(){const hash=new URLSearchParams(location.hash.slice(1));return hash.get("token")||sessionStorage.getItem("arforge.web.token")||""}
async function api(method,params={}){const r=await fetch("/api/bridge",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+state.token},body:JSON.stringify({method,params})});if(r.status===401){showLogin();throw new Error("身份验证失败")}const v=await r.json();if(!v.ok)throw new Error((v.error&&v.error.message)||"请求失败");return v.data}
function showLogin(){state.token="";$("login").classList.add("show")}
function notice(text,error=false){$("notice").textContent=text;$("notice").className=error?"notice error":"notice"}
function escText(value){return String(value??"")}
function renderSessions(){const box=$("sessions");box.replaceChildren();for(const s of state.sessions){const b=document.createElement("button");b.className="session"+(state.session&&state.session.session_id===s.session_id?" active":"");const strong=document.createElement("strong");strong.textContent=s.title;const small=document.createElement("small");small.textContent=s.message_count+" 条消息 · "+s.status;b.append(strong,small);b.onclick=()=>selectSession(s);box.append(b)}}
function renderMessage(role,content,id){let node=id?document.querySelector('[data-message-id="'+CSS.escape(id)+'"]'):null;if(!node){node=document.createElement("article");node.className="message "+role;if(id)node.dataset.messageId=id;const avatar=document.createElement("span");avatar.className="avatar";avatar.textContent=role==="assistant"?"A":"你";const bubble=document.createElement("div");bubble.className="bubble";const name=document.createElement("b");name.textContent=role==="assistant"?"Arforge":"你";const pre=document.createElement("pre");bubble.append(name,pre);node.append(avatar,bubble);$("messages").append(node)}node.querySelector("pre").textContent=escText(content);$("messages").scrollTop=$("messages").scrollHeight;return node}
async function loadSessions(){const page=await api("session.list",{limit:100,archive:"exclude"});state.sessions=page.items;renderSessions();if(state.session){const next=state.sessions.find(x=>x.session_id===state.session.session_id);if(next){state.session=next;updateHeader()}}}
async function loadMessages(){if(!state.session)return;const page=await api("session.messages",{session_id:state.session.session_id,limit:500});$("messages").replaceChildren();for(const m of page.items)if(m.role==="user"||m.role==="assistant")renderMessage(m.role,m.content,m.message_id);state.session=page.session;updateHeader()}
function updateHeader(){const s=state.session;$("title").textContent=s?s.title:"选择或新建会话";$("state").textContent=state.operation?"运行中":s?s.status:"未连接";const c=s&&s.context_status||{};const p=Math.max(0,Math.min(100,Number(c.usage_percent||0)));$("contextText").textContent=s?Math.round(p)+"% / "+formatTokens(c.context_window_tokens||0):"上下文 —";$("contextBar").style.width=p+"%";renderSessions()}
function formatTokens(v){return v>=1e6?(v/1e6).toFixed(v%1e6?1:0)+"m":v>=1e3?(v/1e3).toFixed(v%1e3?1:0)+"k":String(v)}
async function selectSession(s){state.session=s;state.operation=null;state.lastEvent=0;updateHeader();await loadMessages();connectEvents()}
async function createSession(){const s=await api("session.create",{});await loadSessions();await selectSession(s)}
async function connectEvents(){if(state.abort)state.abort.abort();if(!state.session)return;const controller=new AbortController();state.abort=controller;try{const r=await fetch("/api/events",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+state.token},body:JSON.stringify({session_id:state.session.session_id,after_id:state.lastEvent}),signal:controller.signal});if(!r.ok)throw new Error("事件流连接失败");const reader=r.body.getReader(),decoder=new TextDecoder();let buffer="";while(true){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let split;while((split=buffer.indexOf("\n\n"))>=0){const block=buffer.slice(0,split);buffer=buffer.slice(split+2);const line=block.split("\n").find(x=>x.startsWith("data: "));if(line)handleEvent(JSON.parse(line.slice(6)))}}}catch(e){if(!controller.signal.aborted)notice(e.message,true)}}
function handleEvent(e){state.lastEvent=Math.max(state.lastEvent,Number(e.web_event_id||0));const d=e.data||{};if(e.type==="operation.started"){state.operation=e.operation_id;renderMessage("assistant","",e.operation_id);updateHeader()}if(e.type==="answer.delta"){const n=renderMessage("assistant","",e.operation_id);n.querySelector("pre").textContent+=escText(d.content)}if(e.type==="assistant.note")notice(escText(d.content));if(e.type==="question.requested")notice("智能体正在等待结构化问题回答，请在桌面端或 Bridge 客户端处理。",true);if(["operation.completed","operation.failed","operation.cancelled","operation.timed_out"].includes(e.type)){state.operation=null;notice(e.type==="operation.completed"?"任务已完成":e.type,true);loadMessages().then(loadSessions);updateHeader()}}
async function send(text){if(!state.session)await createSession();if(state.operation){await api("chat.enqueue",{session_id:state.session.session_id,input:text,timeout_ms:0,reasoning_effort:"medium",permission_mode:$("permission").value});notice("消息已加入等待队列");return}renderMessage("user",text,"local-"+Date.now());const op=await api("chat.start",{session_id:state.session.session_id,input:text,timeout_ms:0,reasoning_effort:"medium",permission_mode:$("permission").value});state.operation=op.operation_id;updateHeader()}
$("loginForm").onsubmit=async e=>{e.preventDefault();state.token=$("tokenInput").value.trim();try{const r=await fetch("/api/health",{headers:{"Authorization":"Bearer "+state.token}});if(!r.ok)throw new Error();sessionStorage.setItem("arforge.web.token",state.token);history.replaceState(null,"",location.pathname);$("login").classList.remove("show");await boot()}catch{showLogin();notice("访问令牌无效",true)}}
$("newSession").onclick=()=>createSession().catch(e=>notice(e.message,true));$("refresh").onclick=()=>Promise.all([loadSessions(),loadMessages()]).catch(e=>notice(e.message,true));
$("composer").onsubmit=e=>{e.preventDefault();const text=$("input").value.trim();if(!text)return;$("input").value="";send(text).catch(e=>notice(e.message,true))};
$("steer").onclick=()=>{const text=$("input").value.trim();if(!state.operation||!text)return;api("chat.steer",{operation_id:state.operation,instruction:text}).then(()=>{$("input").value="";notice("引导已提交")}).catch(e=>notice(e.message,true))};
$("cancel").onclick=()=>{if(state.operation)api("chat.cancel",{operation_id:state.operation}).catch(e=>notice(e.message,true))};
$("input").onkeydown=e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();$("composer").requestSubmit()}};
async function boot(){const h=await fetch("/api/health",{headers:{"Authorization":"Bearer "+state.token}}).then(r=>r.json());$("workspace").textContent=h.data.workspace;await loadSessions();if(state.sessions.length)await selectSession(state.sessions[0])}
state.token=tokenFromLocation();if(!state.token)showLogin();else{sessionStorage.setItem("arforge.web.token",state.token);history.replaceState(null,"",location.pathname);boot().catch(()=>showLogin())}
</script></body></html>"""
