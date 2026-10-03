"""Native Chromium DevTools runtime used for evidence-backed web validation."""

from __future__ import annotations

import json
import hashlib
import os
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path
from urllib.parse import unquote, urlparse

from arforge.browser_policy import (
    BrowserPolicyError,
    classify_browser_actions,
    validate_browser_target_url,
    validate_redirect,
)


def resolve_browser_target(value: str, workspace: Path) -> str:
    """Resolve a web URL or a workspace-local file to a browser-safe URL."""
    raw = str(value or "").strip()
    if raw.startswith(("http://", "https://")):
        return raw
    query = ""
    fragment = ""
    if raw.startswith("file://"):
        parsed = urlparse(raw)
        local = Path(unquote(parsed.path.lstrip("/") if os.name == "nt" else parsed.path))
        query = parsed.query
        fragment = parsed.fragment
    else:
        local_text, separator, fragment = raw.partition("#")
        local_text, query_separator, query = local_text.partition("?")
        if not separator:
            fragment = ""
        if not query_separator:
            query = ""
        local = Path(local_text)
        if not local.is_absolute():
            local = workspace / local
    resolved_workspace = workspace.resolve()
    resolved = local.resolve()
    try:
        resolved.relative_to(resolved_workspace)
    except ValueError:
        # Mirror the file-tool permission contract.  Full/local-computer mode
        # deliberately authorizes user-selected absolute paths such as Desktop
        # deliverables, while ordinary workspace modes remain fail-closed.
        from arforge.tools.file_tools import _uses_local_computer_paths

        if not _uses_local_computer_paths():
            raise ValueError(
                "local browser target must be inside the active workspace"
            ) from None
        from arforge.security.sandbox_enforce import protected_path_reason

        reason = protected_path_reason(resolved)
        if reason:
            raise ValueError(f"protected browser target: {resolved} ({reason})") from None
    if not resolved.is_file():
        raise FileNotFoundError(f"browser target does not exist: {resolved}")
    if resolved.suffix.lower() in {".php", ".asp", ".aspx", ".jsp"}:
        raise ValueError(
            "server-side pages cannot be validated through file:// because the browser only "
            "shows source code; start the project server and use an http(s) URL"
        )
    target = resolved.as_uri()
    if query:
        target += "?" + query
    if fragment:
        target += "#" + fragment
    return target


def find_chromium_executable() -> str:
    configured = os.environ.get("ARFORGE_BROWSER_EXECUTABLE", "").strip()
    candidates = [
        configured,
        shutil.which("msedge") or "",
        shutil.which("msedge.exe") or "",
        shutil.which("chrome") or "",
        shutil.which("chrome.exe") or "",
        shutil.which("chromium") or "",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/usr/bin/microsoft-edge",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return str(Path(candidate))
    raise RuntimeError(
        "No supported Chromium browser was found. Install Microsoft Edge, Google Chrome, "
        "or Chromium, or set ARFORGE_BROWSER_EXECUTABLE."
    )


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class _CDP:
    def __init__(self, websocket) -> None:
        self.websocket = websocket
        self.next_id = 1
        self.events: list[dict] = []

    def call(self, method: str, params: dict | None = None, timeout: float = 10) -> dict:
        request_id = self.next_id
        self.next_id += 1
        self.websocket.send(json.dumps({"id": request_id, "method": method, "params": params or {}}))
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            message = json.loads(self.websocket.recv(timeout=max(0.01, deadline - time.monotonic())))
            if message.get("id") == request_id:
                if "error" in message:
                    raise RuntimeError(f"CDP {method} failed: {message['error']}")
                return message.get("result", {})
            if "method" in message:
                self.events.append(message)
        raise TimeoutError(f"CDP {method} timed out")

    def evaluate(self, expression: str, *, await_promise: bool = False) -> object:
        result = self.call(
            "Runtime.evaluate",
            {
                "expression": expression,
                "returnByValue": True,
                "awaitPromise": await_promise,
                "userGesture": True,
            },
        )
        remote = result.get("result", {})
        if remote.get("subtype") == "error":
            raise RuntimeError(str(remote.get("description") or remote.get("value")))
        return remote.get("value")


_KEY_CODES = {
    "Enter": ("Enter", "Enter", 13),
    "ArrowLeft": ("ArrowLeft", "ArrowLeft", 37),
    "ArrowUp": ("ArrowUp", "ArrowUp", 38),
    "ArrowRight": ("ArrowRight", "ArrowRight", 39),
    "ArrowDown": ("ArrowDown", "ArrowDown", 40),
    "Space": (" ", "Space", 32),
    "Escape": ("Escape", "Escape", 27),
    "Tab": ("Tab", "Tab", 9),
    "p": ("p", "KeyP", 80),
    "P": ("P", "KeyP", 80),
}


def _selector_lookup_js(selector: str) -> str:
    """Return JS that resolves CSS plus stable text/label selector shorthands."""
    raw = json.dumps(str(selector or ""))
    return (
        "(() => { const raw=" + raw + "; const norm=v=>String(v||'').replace(/\\s+/g,' ').trim(); "
        "if(raw.startsWith('xpath=')){return document.evaluate(raw.slice(6),document,null,"
        "XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;} "
        "if(raw.startsWith('placeholder=')){const wanted=norm(raw.slice(12)); return "
        "[...document.querySelectorAll('input,textarea')].find(el=>norm(el.placeholder)===wanted)||null;} "
        "if(raw.startsWith('label=')){const wanted=norm(raw.slice(6)); const label="
        "[...document.querySelectorAll('label')].find(el=>norm(el.textContent)===wanted||"
        "norm(el.textContent).includes(wanted)); return label?(label.control||label.querySelector('input,textarea,select')):null;} "
        "if(!raw.startsWith('text=')){try{const css=document.querySelector(raw);if(css)return css;}catch(_error){}} "
        "let tag=''; let wanted=raw.startsWith('text=')?raw.slice(5):raw; const split=raw.indexOf(':'); "
        "if(!raw.startsWith('text=')&&split>0&&/^[a-z][a-z0-9-]*$/i.test(raw.slice(0,split))){"
        "tag=raw.slice(0,split);wanted=raw.slice(split+1);} wanted=norm(wanted); "
        "const scope=tag||'button,a,[role=button],input[type=button],input[type=submit],label,[data-action],.wk-block,.cl-item,.tl-item'; "
        "const candidates=[...document.querySelectorAll(scope)]; return "
        "candidates.find(el=>norm(el.innerText||el.value||el.getAttribute('aria-label'))===wanted)||"
        "candidates.find(el=>norm(el.innerText||el.value||el.getAttribute('aria-label')).includes(wanted))||null; })()"
    )


def _click_selector(cdp: _CDP, selector: str) -> str:
    result = cdp.evaluate(
        "(() => { const el = " + _selector_lookup_js(selector) + "; "
        "if (!el) return 'missing'; "
        "el.scrollIntoView({block:'center',inline:'center'}); const r=el.getBoundingClientRect(); "
        "const init={bubbles:true,cancelable:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2,"
        "button:0,buttons:1,pointerId:1,pointerType:'mouse',isPrimary:true}; "
        "if(typeof PointerEvent==='function')el.dispatchEvent(new PointerEvent('pointerdown',init)); "
        "el.dispatchEvent(new MouseEvent('mousedown',init)); "
        "if(typeof PointerEvent==='function')el.dispatchEvent(new PointerEvent('pointerup',{...init,buttons:0})); "
        "el.dispatchEvent(new MouseEvent('mouseup',{...init,buttons:0})); "
        "el.click(); return 'clicked'; })()"
    )
    return str(result)


def _resolve_upload_path(value: str, workspace: Path) -> Path:
    candidate = Path(str(value or "").strip())
    resolved = (candidate if candidate.is_absolute() else workspace / candidate).resolve()
    try:
        resolved.relative_to(workspace.resolve())
    except ValueError as exc:
        raise BrowserPolicyError("upload path must stay inside the active workspace") from exc
    if not resolved.is_file():
        raise FileNotFoundError(f"upload file does not exist: {resolved}")
    return resolved


def _upload_file(cdp: _CDP, selector: str, path: Path) -> str:
    document = cdp.call("DOM.getDocument", {"depth": -1})
    root_id = document.get("root", {}).get("nodeId")
    if not root_id:
        raise RuntimeError("browser DOM root is unavailable for upload")
    result = cdp.call("DOM.querySelector", {"nodeId": root_id, "selector": selector})
    node_id = result.get("nodeId")
    if not node_id:
        raise ValueError(f"upload target not found: {selector}")
    cdp.call("DOM.setFileInputFiles", {"nodeId": node_id, "files": [str(path)]})
    return f"uploaded {selector}"


def _collect_downloads(download_dir: Path) -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    if not download_dir.is_dir():
        return records
    for path in sorted(download_dir.iterdir()):
        if not path.is_file() or path.name.endswith(".crdownload"):
            continue
        digest = hashlib.sha256()
        size = 0
        with path.open("rb") as stream:
            while chunk := stream.read(1024 * 1024):
                size += len(chunk)
                digest.update(chunk)
        records.append({"name": path.name, "bytes": size, "sha256": digest.hexdigest()})
    return records


def _validate_navigation_events(
    events: list[dict],
    initial_url: str,
    *,
    workspace: Path,
    allowed_origins: list[str] | tuple[str, ...] | None,
) -> None:
    for event in events:
        if event.get("method") != "Page.frameNavigated":
            continue
        frame = event.get("params", {}).get("frame", {})
        if frame.get("parentId"):
            continue
        candidate = str(frame.get("url") or "")
        if candidate:
            validate_redirect(
                initial_url,
                candidate,
                workspace=workspace,
                allowed_origins=allowed_origins,
            )


def _perform_action(
    cdp: _CDP,
    action: str,
    *,
    workspace: Path | None = None,
) -> str:
    action = str(action or "").strip()
    if action.startswith("wait:"):
        milliseconds = max(0, min(10000, int(action.split(":", 1)[1])))
        cdp.evaluate(f"new Promise(resolve => setTimeout(resolve, {milliseconds}))", await_promise=True)
        return f"waited {milliseconds}ms"
    if action.startswith("navigate:"):
        target = action.split(":", 1)[1].strip()
        if not target.startswith(("http://", "https://", "file://")):
            if workspace is None:
                raise BrowserPolicyError("navigate action requires a workspace context for local paths")
            target = resolve_browser_target(target, workspace)
        validate_browser_target_url(target)
        cdp.call("Page.navigate", {"url": target}, timeout=15)
        return f"navigated {target}"
    if action.startswith("press:"):
        requested = action.split(":", 1)[1]
        key, code, virtual = _KEY_CODES.get(
            requested,
            (requested[:1], f"Key{requested[:1].upper()}", ord(requested[:1].upper()) if requested else 0),
        )
        if not key or not virtual:
            raise ValueError(f"unsupported key action: {action}")
        payload = {
            "key": key,
            "code": code,
            "windowsVirtualKeyCode": virtual,
            "nativeVirtualKeyCode": virtual,
        }
        cdp.call("Input.dispatchKeyEvent", {"type": "keyDown", **payload})
        cdp.call("Input.dispatchKeyEvent", {"type": "keyUp", **payload})
        return f"pressed {requested}"
    if action.startswith("click:"):
        selector = action.split(":", 1)[1]
        result = _click_selector(cdp, selector)
        if result != "clicked":
            raise ValueError(f"click target not found: {selector}")
        return f"clicked {selector}"
    if action.startswith("download:"):
        selector = action.split(":", 1)[1]
        result = _click_selector(cdp, selector)
        if result != "clicked":
            raise ValueError(f"download target not found: {selector}")
        return f"download requested {selector}"
    if action.startswith("upload:"):
        parts = action.split(":", 2)
        if len(parts) != 3 or not parts[1] or workspace is None:
            raise BrowserPolicyError("upload action must be upload:<selector>:<workspace-file>")
        return _upload_file(cdp, parts[1], _resolve_upload_path(parts[2], workspace))
    if action.startswith("fill:"):
        parts = action.split(":", 2)
        if len(parts) != 3 or not parts[1]:
            raise ValueError("fill action must be fill:<selector>:<text>")
        selector, value = parts[1], parts[2]
        result = cdp.evaluate(
            "(() => { const el = " + _selector_lookup_js(selector) + "; "
            "if (!el || !('value' in el)) return 'missing'; el.focus(); el.value = "
            + json.dumps(value)
            + "; el.dispatchEvent(new Event('input',{bubbles:true})); "
            "el.dispatchEvent(new Event('change',{bubbles:true})); return 'filled'; })()"
        )
        if result != "filled":
            raise ValueError(f"fill target not found or unsupported: {selector}")
        return f"filled {selector}"
    if action.startswith("select:"):
        parts = action.split(":", 2)
        if len(parts) != 3 or not parts[1]:
            raise ValueError("select action must be select:<selector>:<value>")
        selector, value = parts[1], parts[2]
        result = cdp.evaluate(
            "(() => { const el = " + _selector_lookup_js(selector) + "; "
            "if (!(el instanceof HTMLSelectElement)) return 'missing'; const value="
            + json.dumps(value)
            + "; if (![...el.options].some(o=>o.value===value)) return 'option-missing'; "
            "el.value=value; el.dispatchEvent(new Event('input',{bubbles:true})); "
            "el.dispatchEvent(new Event('change',{bubbles:true})); return 'selected'; })()"
        )
        if result == "option-missing":
            raise ValueError(f"select option not found for {selector}: {value}")
        if result != "selected":
            raise ValueError(f"select target not found or unsupported: {selector}")
        return f"selected {selector}={value}"
    if action.startswith("check:") or action.startswith("uncheck:"):
        checked = action.startswith("check:")
        selector = action.split(":", 1)[1]
        result = cdp.evaluate(
            "(() => { const el = " + _selector_lookup_js(selector) + "; "
            "if (!(el instanceof HTMLInputElement) || !['checkbox','radio'].includes(el.type)) "
            "return 'missing'; el.checked="
            + ("true" if checked else "false")
            + "; el.dispatchEvent(new Event('input',{bubbles:true})); "
            "el.dispatchEvent(new Event('change',{bubbles:true})); return 'changed'; })()"
        )
        if result != "changed":
            raise ValueError(f"check target not found or unsupported: {selector}")
        return f"{'checked' if checked else 'unchecked'} {selector}"
    if action.startswith("touch:"):
        selector = action.split(":", 1)[1]
        rect = cdp.evaluate(
            "(() => { const el = " + _selector_lookup_js(selector) + "; "
            "if (!el) return null; const r=el.getBoundingClientRect(); "
            "return {x:r.left+r.width/2,y:r.top+r.height/2}; })()"
        )
        if not isinstance(rect, dict):
            raise ValueError(f"touch target not found: {selector}")
        point = [{"x": rect["x"], "y": rect["y"], "radiusX": 1, "radiusY": 1, "force": 1}]
        cdp.call("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": point})
        cdp.call("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        return f"touched {selector}"
    raise ValueError(
        "unsupported browser action; use navigate:<url>, press:<key>, click:<selector>, touch:<selector>, "
        "fill:<selector>:<text>, select:<selector>:<value>, check:<selector>, "
        "uncheck:<selector>, upload:<selector>:<workspace-file>, download:<selector>, or wait:<ms>"
    )


def _page_error_text(exception_details: dict) -> str:
    """Return the actionable exception description instead of generic CDP 'Uncaught'."""
    exception = exception_details.get("exception") or {}
    description = exception.get("description") if isinstance(exception, dict) else ""
    text = exception_details.get("text")
    return str(description or text or "exception")[:500]


def run_browser_diagnostics(
    target: str,
    *,
    workspace: Path,
    wait_ms: int = 1500,
    viewport_width: int = 1280,
    viewport_height: int = 720,
    actions: list[str] | None = None,
    allowed_origins: list[str] | None = None,
) -> dict:
    """Launch a real local Chromium process and collect runtime evidence through CDP."""
    from websockets.sync.client import connect
    from arforge.security_guard import detect_injection

    url = validate_browser_target_url(resolve_browser_target(target, workspace))
    action_plans = classify_browser_actions(actions)
    width = max(320, min(3840, int(viewport_width)))
    height = max(320, min(2160, int(viewport_height)))
    delay = max(0, min(10000, int(wait_ms)))
    port = _free_port()
    executable = find_chromium_executable()
    profile = tempfile.TemporaryDirectory(prefix="arforge-browser-")
    creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    process = subprocess.Popen(
        [
            executable,
            "--headless=new",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            "--remote-allow-origins=*",
            f"--remote-debugging-port={port}",
            f"--user-data-dir={profile.name}",
            "about:blank",
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=creationflags,
    )
    try:
        download_dir = Path(profile.name) / "downloads"
        download_dir.mkdir()
        pages = None
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=1) as response:
                    pages = json.loads(response.read().decode("utf-8"))
                if pages:
                    break
            except Exception:
                time.sleep(0.1)
        if not pages:
            raise RuntimeError("browser started but its diagnostics endpoint did not become ready")
        websocket_url = next(
            (item.get("webSocketDebuggerUrl") for item in pages if item.get("type") == "page"),
            None,
        )
        if not websocket_url:
            raise RuntimeError("browser diagnostics page endpoint is unavailable")

        with connect(websocket_url, open_timeout=5, close_timeout=1) as websocket:
            cdp = _CDP(websocket)
            for domain in ("Page.enable", "Runtime.enable", "Network.enable"):
                cdp.call(domain)
            if any(plan.kind == "upload" for plan in action_plans):
                cdp.call("DOM.enable")
            if any(plan.kind == "download" for plan in action_plans):
                cdp.call(
                    "Browser.setDownloadBehavior",
                    {"behavior": "allow", "downloadPath": str(download_dir), "eventsEnabled": True},
                )
            elif action_plans:
                cdp.call("Browser.setDownloadBehavior", {"behavior": "deny"})
            cdp.call(
                "Emulation.setDeviceMetricsOverride",
                {"width": width, "height": height, "deviceScaleFactor": 1, "mobile": width <= 600},
            )
            cdp.call("Page.navigate", {"url": url}, timeout=15)
            cdp.evaluate(
                "new Promise(resolve => { if (document.readyState === 'complete') resolve(); "
                "else window.addEventListener('load', resolve, {once:true}); "
                f"setTimeout(resolve, {max(3000, delay + 2000)}); }})",
                await_promise=True,
            )
            _validate_navigation_events(
                cdp.events,
                url,
                workspace=workspace,
                allowed_origins=allowed_origins,
            )
            if delay:
                cdp.evaluate(f"new Promise(resolve => setTimeout(resolve, {delay}))", await_promise=True)
            initial_page_text = cdp.evaluate(
                "String((document.body && document.body.innerText) || '').slice(0, 12000)"
            )
            prompt_injection = detect_injection(str(initial_page_text or ""))
            if action_plans and not prompt_injection["clean"]:
                raise BrowserPolicyError(
                    "prompt injection detected in untrusted page content; browser actions were blocked"
                )
            action_results: list[str] = []
            for plan in action_plans:
                action_results.append(_perform_action(cdp, plan.raw, workspace=workspace))
                _validate_navigation_events(
                    cdp.events,
                    url,
                    workspace=workspace,
                    allowed_origins=allowed_origins,
                )
            if actions:
                cdp.evaluate("new Promise(resolve => setTimeout(resolve, 250))", await_promise=True)
            raw_snapshot = cdp.evaluate(
                "JSON.stringify((() => { const body=document.body; const root=document.documentElement; "
                "const selectorFor=el=>{const parts=[];let node=el;while(node&&node.nodeType===1){"
                "if(node.id){parts.unshift('#'+CSS.escape(node.id));return parts.join(' > ');} "
                "let part=node.tagName.toLowerCase();const classes=[...node.classList].filter(Boolean).map(v=>'.'+CSS.escape(v)).join('');"
                "if(classes)part+=classes;const parent=node.parentElement;if(parent){let siblings=[];"
                "try{siblings=[...parent.children].filter(x=>x.matches(part));}catch(_e){} "
                "if(siblings.length>1){const peers=[...parent.children].filter(x=>x.tagName===node.tagName);"
                "part+=':nth-of-type('+(peers.indexOf(node)+1)+')';}}parts.unshift(part);"
                "const candidate=parts.join(' > ');try{if(document.querySelectorAll(candidate).length===1)return candidate;}catch(_e){} "
                "node=parent;}return parts.join(' > ');}; "
                "const canvases=[...document.querySelectorAll('canvas')].map((c,i)=>{const r=c.getBoundingClientRect();"
                "return {index:i,width:c.width,height:c.height,clientWidth:c.clientWidth,clientHeight:c.clientHeight,"
                "rect:{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}}});"
                "const bodyText=body?(body.innerText||'').trim():'';"
                "const bodyTextSample=bodyText.length<=3200?bodyText:"
                "bodyText.slice(0,900)+'\\n...[middle omitted]...\\n'+bodyText.slice(-2200);"
                "return {url:location.href,title:document.title,readyState:document.readyState,"
                "bodyTextLength:bodyText.length,bodyText:bodyTextSample,"
                "viewport:{width:innerWidth,height:innerHeight,devicePixelRatio},"
                "document:{scrollWidth:root.scrollWidth,scrollHeight:root.scrollHeight,clientWidth:root.clientWidth,clientHeight:root.clientHeight,"
                "horizontalOverflow:root.scrollWidth>root.clientWidth+1},canvases,"
                "buttons:[...document.querySelectorAll('button')].slice(0,50).map(b=>({id:b.id||'',className:b.className||'',"
                "selector:selectorFor(b),text:(b.innerText||'').trim().slice(0,80),title:b.title||'',"
                "ariaLabel:b.getAttribute('aria-label')||'',type:b.type||'',disabled:b.disabled})),"
                "interactives:[...document.querySelectorAll('a,[role=button],[tabindex],[data-action],.wk-block,.cl-item,.tl-item')].filter(el=>"
                "!['BUTTON','INPUT','SELECT','TEXTAREA'].includes(el.tagName)).slice(0,80).map(el=>({tag:el.tagName.toLowerCase(),id:el.id||'',"
                "className:el.className||'',selector:selectorFor(el),text:(el.innerText||'').trim().slice(0,160),"
                "title:el.title||'',ariaLabel:el.getAttribute('aria-label')||''})),"
                "selects:[...document.querySelectorAll('select')].slice(0,30).map(s=>({id:s.id||'',name:s.name||'',className:s.className||'',selector:selectorFor(s),value:s.value,disabled:s.disabled,"
                "options:[...s.options].slice(0,100).map(o=>({value:o.value,text:(o.textContent||'').trim().slice(0,120),selected:o.selected}))})),"
                "inputs:[...document.querySelectorAll('input,textarea')].slice(0,50).map(i=>({id:i.id||'',name:i.name||'',className:i.className||'',selector:selectorFor(i),placeholder:i.placeholder||'',ariaLabel:i.getAttribute('aria-label')||'',type:i.type||i.tagName.toLowerCase(),"
                "value:(i.type==='password'||i.type==='hidden')?'[redacted]':String(i.value||'').slice(0,200),checked:!!i.checked,disabled:!!i.disabled}))}; })())"
            )
            snapshot = json.loads(str(raw_snapshot))
            try:
                screenshot_data = str(cdp.call("Page.captureScreenshot", {"format": "png"}).get("data") or "")
                screenshot_observation = {
                    "available": bool(screenshot_data),
                    "sha256": hashlib.sha256(screenshot_data.encode("ascii")).hexdigest()
                    if screenshot_data
                    else None,
                    "base64_bytes": len(screenshot_data),
                }
            except Exception as exc:
                screenshot_observation = {
                    "available": False,
                    "sha256": None,
                    "base64_bytes": 0,
                    "error": str(exc)[:200],
                }
            snapshot["url"] = validate_redirect(
                url,
                str(snapshot.get("url") or ""),
                workspace=workspace,
                allowed_origins=allowed_origins,
            )
            prompt_injection = detect_injection(str(snapshot.get("bodyText") or ""))
            downloads = _collect_downloads(download_dir)
            console_errors: list[str] = []
            page_errors: list[str] = []
            network_failures: list[str] = []
            http_errors: list[str] = []
            for event in cdp.events:
                method = event.get("method")
                params = event.get("params", {})
                if method == "Runtime.consoleAPICalled" and params.get("type") == "error":
                    values = [str(item.get("value") or item.get("description") or "") for item in params.get("args", [])]
                    console_errors.append(" ".join(values)[:500])
                elif method == "Runtime.exceptionThrown":
                    detail = params.get("exceptionDetails", {})
                    page_errors.append(_page_error_text(detail))
                elif method == "Network.loadingFailed" and not params.get("canceled"):
                    network_failures.append(str(params.get("errorText") or "network failure")[:500])
                elif method == "Network.responseReceived":
                    response = params.get("response", {})
                    if int(response.get("status", 0)) >= 400:
                        http_errors.append(f"HTTP {int(response['status'])} {response.get('url', '')}"[:500])
            return {
                "engine": Path(executable).name,
                "target": url,
                "snapshot": snapshot,
                "actions": action_results,
                "action_plans": [
                    {
                        "action": plan.raw,
                        "kind": plan.kind,
                        "risk_level": plan.risk_level,
                        "requires_confirmation": plan.requires_confirmation,
                        "destructive": plan.destructive,
                    }
                    for plan in action_plans
                ],
                "downloads": downloads,
                "screenshot_observation": screenshot_observation,
                "credential_scope": "ephemeral-empty-profile",
                "allowed_origins": list(allowed_origins or []),
                "prompt_injection": prompt_injection,
                "console_errors": console_errors,
                "page_errors": page_errors,
                "network_failures": network_failures,
                "http_errors": http_errors,
            }
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)
        try:
            profile.cleanup()
        except PermissionError:
            pass
