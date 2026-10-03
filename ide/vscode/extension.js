"use strict";

const vscode = require("vscode");
const { JsonlBridge } = require("./bridgeClient");
const { buildEditorContext } = require("./ideContext");

let bridge;
let statusBar;
let panel;
let extensionContext;
let sessionId = "";
let activeOperationId = "";
let awaitingOperation = false;
let answer = "";

function workspaceRoot() {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
}

function config() {
  return vscode.workspace.getConfiguration("arforge");
}

function sessionStorageKey() {
  return `arforge.sessionId:${workspaceRoot()}`;
}

async function ensureTrusted() {
  if (vscode.workspace.isTrusted) return true;
  const choice = await vscode.window.showWarningMessage(
    "Arforge 需要受信任工作区才能读取、修改和测试项目。",
    "管理工作区信任"
  );
  if (choice) await vscode.commands.executeCommand("workbench.trust.manage");
  return false;
}

async function ensureBridge() {
  if (!(await ensureTrusted())) throw new Error("当前工作区尚未受信任");
  if (bridge?.running) return bridge;
  bridge = new JsonlBridge({ requestTimeoutMs: 120000 });
  bridge.on("event", onBridgeEvent);
  bridge.on("closed", (error) => {
    setStatus("error", "Arforge Bridge 已断开");
    post({ type: "error", message: error.message });
  });
  const selected = config();
  const command = selected.get("bridge.command", "arforge");
  const args = selected.get("bridge.args", ["bridge"]);
  const profile = selected.get("bridge.profile", "").trim();
  const env = { ARFORGE_WORKSPACE: workspaceRoot() };
  if (profile) env.ARFORGE_HOME = profile;
  setStatus("loading", "Arforge 正在连接");
  await bridge.start({ command, args, cwd: workspaceRoot(), env });
  setStatus("ready", "Arforge 已连接");
  return bridge;
}

function setStatus(state, tooltip) {
  if (!statusBar) return;
  statusBar.text = state === "loading"
    ? "$(sync~spin) Arforge"
    : state === "error"
      ? "$(error) Arforge"
      : "$(sparkle) Arforge";
  statusBar.tooltip = tooltip;
  statusBar.show();
}

async function createSession(client) {
  const session = await client.request("session.create", {});
  sessionId = session.session_id;
  await extensionContext?.workspaceState.update(sessionStorageKey(), sessionId);
  post({ type: "session", sessionId, resumed: false });
  return sessionId;
}

async function ensureSession() {
  const client = await ensureBridge();
  if (sessionId) return sessionId;
  const stored = extensionContext?.workspaceState.get(sessionStorageKey(), "");
  if (stored) {
    try {
      const resumed = await client.request("session.resume", { session_id: stored });
      sessionId = resumed.session_id;
      post({ type: "session", sessionId, resumed: true });
      return sessionId;
    } catch {
      await extensionContext?.workspaceState.update(sessionStorageKey(), undefined);
    }
  }
  return createSession(client);
}

async function newSession() {
  const client = await ensureBridge();
  sessionId = "";
  activeOperationId = "";
  awaitingOperation = false;
  await extensionContext?.workspaceState.update(sessionStorageKey(), undefined);
  await createSession(client);
  post({ type: "clear" });
}

function diagnosticSeverity(severity) {
  const names = ["error", "warning", "information", "hint"];
  return names[severity] || "information";
}

function editorContext() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return { paths: [] };
  const document = editor.document;
  const relative = vscode.workspace.asRelativePath(document.uri, false);
  const diagnosticsEnabled = config().get("includeDiagnostics", true);
  const diagnostics = diagnosticsEnabled
    ? vscode.languages.getDiagnostics(document.uri).map((item) => ({
        severity: diagnosticSeverity(item.severity),
        message: item.message,
        source: item.source || "",
        code: item.code === undefined
          ? ""
          : typeof item.code === "object"
            ? String(item.code.value || "")
            : String(item.code),
        range: item.range
      }))
    : [];
  return {
    paths: [{ path: relative, kind: "file" }],
    editor: buildEditorContext({
      file: relative,
      language: document.languageId,
      selection: document.getText(editor.selection),
      range: editor.selection,
      cursor: editor.selection.active,
      diagnostics
    })
  };
}

async function sendPrompt(input, extra = {}) {
  const client = await ensureBridge();
  const currentSession = await ensureSession();
  answer = "";
  post({ type: "user", content: input });
  post({ type: "assistantStart" });
  const liveContext = editorContext();
  awaitingOperation = true;
  try {
    const operation = await client.request("chat.start", {
    session_id: currentSession,
    input,
    timeout_ms: 0,
    reasoning_effort: config().get("reasoningEffort", "medium"),
    permission_mode: config().get("permissionMode", "autoApprove"),
    context: {
      paths: extra.workspace
        ? [{ path: ".", kind: "directory" }]
        : liveContext.paths,
      ...(liveContext.editor ? { editor: liveContext.editor } : {}),
      long_task: Boolean(extra.longTask)
    }
    });
    activeOperationId = operation.operation_id;
    awaitingOperation = false;
  } catch (error) {
    awaitingOperation = false;
    throw error;
  }
}

async function refreshChanges() {
  try {
    const client = await ensureBridge();
    const changes = await client.request("git.diff", { max_chars: 240000 });
    post({ type: "changes", changes });
    return changes;
  } catch (error) {
    post({ type: "changesError", message: error.message || String(error) });
    return undefined;
  }
}

async function cancelActiveOperation() {
  if (!activeOperationId) return;
  const client = await ensureBridge();
  await client.request("chat.cancel", { operation_id: activeOperationId });
}

function onBridgeEvent(event) {
  if (!activeOperationId) {
    if (awaitingOperation && event.type === "operation.started" && event.session_id === sessionId) {
      activeOperationId = event.operation_id;
      awaitingOperation = false;
    } else {
      return;
    }
  }
  if (event.operation_id !== activeOperationId) return;
  const data = event.data || {};
  if (event.type === "answer.reset") {
    answer = "";
    post({ type: "assistantReset" });
  } else if (event.type === "answer.delta" && typeof data.content === "string") {
    answer += data.content;
    post({ type: "assistantDelta", content: data.content });
  } else if (event.type === "reasoning.started") {
    post({ type: "activity", content: "正在完整推理…" });
  } else if (event.type === "tool.started" || event.type === "tool.prepared") {
    post({ type: "activity", content: `正在执行：${String(data.tool_name || "工具")}` });
  } else if (event.type === "question.requested") {
    post({ type: "activity", content: "任务需要进一步确认，请在 Arforge 桌面端处理该问题。" });
  } else if (event.type === "operation.completed") {
    if (typeof data.answer === "string") answer = data.answer;
    post({ type: "assistantDone", content: answer });
    activeOperationId = "";
    awaitingOperation = false;
    setStatus("ready", "Arforge 已连接");
    void refreshChanges();
  } else if (event.type === "operation.cancelled") {
    post({ type: "activity", content: "任务已停止。" });
    activeOperationId = "";
    awaitingOperation = false;
    setStatus("ready", "Arforge 已连接");
  } else if (event.type === "operation.timed_out") {
    post({ type: "error", message: String(data.error || data.message || "任务超时") });
    activeOperationId = "";
    awaitingOperation = false;
    setStatus("error", "Arforge 任务超时");
  } else if (event.type === "operation.failed") {
    post({ type: "error", message: String(data.error || data.message || "任务未完成") });
    activeOperationId = "";
    awaitingOperation = false;
    setStatus("error", "Arforge 任务失败");
  }
}

function post(message) {
  void panel?.webview.postMessage(message);
}

function openPanel() {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Beside);
    return panel;
  }
  panel = vscode.window.createWebviewPanel(
    "arforge.chat",
    "Arforge",
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = webviewHtml();
  panel.webview.onDidReceiveMessage(async (message) => {
    try {
      if (message.type === "send" && typeof message.content === "string") {
        await sendPrompt(message.content);
      } else if (message.type === "openScm") {
        await vscode.commands.executeCommand("workbench.view.scm");
      } else if (message.type === "refreshChanges") {
        await refreshChanges();
      } else if (message.type === "newSession") {
        await newSession();
      } else if (message.type === "cancel") {
        await cancelActiveOperation();
      }
    } catch (error) {
      post({ type: "error", message: bridgeHelp(error) });
    }
  });
  panel.onDidDispose(() => { panel = undefined; });
  void ensureBridge()
    .then(() => ensureSession())
    .then(() => refreshChanges())
    .catch((error) => {
      setStatus("error", error.message);
      post({ type: "error", message: bridgeHelp(error) });
    });
  return panel;
}

function bridgeHelp(error) {
  const message = error?.message || String(error);
  if (/lock|already running|另一个/i.test(message)) {
    return `${message}\n\n默认配置正在被另一个 Arforge 进程使用。请关闭该进程，或在 arforge.bridge.profile 中设置独立目录。`;
  }
  return message;
}

async function commandPrompt(prompt, options = {}) {
  openPanel();
  try {
    await sendPrompt(prompt, options);
  } catch (error) {
    post({ type: "error", message: bridgeHelp(error) });
  }
}

function webviewHtml() {
  const nonce = String(Date.now());
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body{font:13px var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);margin:0}
main{display:flex;flex-direction:column;height:100vh}.toolbar{display:flex;gap:8px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--vscode-panel-border)}
.toolbar .session{flex:1;color:var(--vscode-descriptionForeground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.messages{flex:1;overflow:auto;padding:16px}.message{white-space:pre-wrap;line-height:1.55;margin:0 0 14px;padding:10px 12px;border-radius:8px}
.user{background:var(--vscode-input-background)}.assistant{border:1px solid var(--vscode-panel-border)}
.activity{color:var(--vscode-descriptionForeground);font-size:12px}.error{color:var(--vscode-errorForeground)}
.changes{margin:0 16px 10px;border:1px solid var(--vscode-panel-border);border-radius:8px;padding:8px 10px}
.changes summary{cursor:pointer}.changes pre{max-height:260px;overflow:auto;white-space:pre;font:12px var(--vscode-editor-font-family)}
form{display:flex;gap:8px;padding:12px;border-top:1px solid var(--vscode-panel-border)}
textarea{flex:1;resize:vertical;min-height:52px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);padding:8px}
button{color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;padding:6px 12px;cursor:pointer}
button.secondary{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}
</style></head><body><main>
<div class="toolbar"><span id="session" class="session">正在连接…</span><button id="new" class="secondary">新对话</button><button id="cancel" class="secondary">停止</button></div>
<div id="messages" class="messages"></div><div id="changes"></div>
<form id="form"><textarea id="input" placeholder="向 Arforge 描述任务…"></textarea><button>发送</button></form></main>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi(),messages=document.getElementById('messages'),input=document.getElementById('input'),changes=document.getElementById('changes'),session=document.getElementById('session');let current;
function add(cls,text=''){const el=document.createElement('div');el.className='message '+cls;el.textContent=text;messages.appendChild(el);messages.scrollTop=messages.scrollHeight;return el}
document.getElementById('form').addEventListener('submit',e=>{e.preventDefault();const value=input.value.trim();if(!value)return;vscode.postMessage({type:'send',content:value});input.value=''});
document.getElementById('new').addEventListener('click',()=>vscode.postMessage({type:'newSession'}));
document.getElementById('cancel').addEventListener('click',()=>vscode.postMessage({type:'cancel'}));
window.addEventListener('message',e=>{const m=e.data;
if(m.type==='user')add('user',m.content);
if(m.type==='assistantStart')current=add('assistant','');
if(m.type==='assistantDelta'){if(!current)current=add('assistant','');current.textContent+=m.content}
if(m.type==='assistantReset'&&current)current.textContent='';
if(m.type==='assistantDone'){if(!current)current=add('assistant','');current.textContent=m.content||current.textContent;current=null}
if(m.type==='activity')add('activity',m.content);
if(m.type==='error')add('error',m.message);
if(m.type==='clear'){messages.textContent='';changes.textContent=''}
if(m.type==='session')session.textContent=(m.resumed?'已恢复对话 · ':'当前对话 · ')+m.sessionId.slice(0,8);
if(m.type==='changes'){const c=m.changes||{};changes.textContent='';if(c.available&&c.files&&c.files.length){const d=document.createElement('details');d.className='changes';const s=document.createElement('summary');s.textContent=c.files.length+' 个文件已更改';const p=document.createElement('pre');p.textContent=c.patch||'';const b=document.createElement('button');b.textContent='在源代码管理中审查';b.addEventListener('click',()=>vscode.postMessage({type:'openScm'}));d.append(s,p,b);changes.appendChild(d)}}
});
</script></body></html>`;
}

function activate(context) {
  extensionContext = context;
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "arforge.openChat";
  context.subscriptions.push(
    statusBar,
    vscode.commands.registerCommand("arforge.openChat", openPanel),
    vscode.commands.registerCommand("arforge.newSession", () => newSession()),
    vscode.commands.registerCommand("arforge.explainSelection", () =>
      commandPrompt("解释所选代码的行为、关键依赖和潜在风险。只分析，不修改文件。")),
    vscode.commands.registerCommand("arforge.fixSelection", () =>
      commandPrompt("修复所选代码中的问题，保持改动最小，完成后运行相关测试。", { longTask: true })),
    vscode.commands.registerCommand("arforge.reviewWorkspace", () =>
      commandPrompt("审查当前项目的架构、正确性、安全性和测试缺口，给出有文件证据的结论。只分析，不修改文件。", { workspace: true, longTask: true })),
    vscode.commands.registerCommand("arforge.reviewChanges", () => {
      openPanel();
      return refreshChanges();
    }),
    vscode.commands.registerCommand("arforge.showStatus", async () => {
      try {
        const client = await ensureBridge();
        const health = await client.request("health", {});
        vscode.window.showInformationMessage(`Arforge Bridge：${health.status || "ok"}，协议 1.2`);
      } catch (error) {
        vscode.window.showErrorMessage(bridgeHelp(error));
      }
    }),
    vscode.commands.registerCommand("arforge.restartBridge", async () => {
      await bridge?.stop();
      bridge = undefined;
      activeOperationId = "";
      awaitingOperation = false;
      await ensureBridge();
      await ensureSession();
      vscode.window.showInformationMessage("Arforge Bridge 已重启");
    })
  );
  setStatus("ready", "点击打开 Arforge");
}

async function deactivate() {
  await bridge?.stop();
}

module.exports = { activate, deactivate };
