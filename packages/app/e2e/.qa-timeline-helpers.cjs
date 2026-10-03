var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toCommonJS = (from) => {
  var entry = (__moduleCache ??= new WeakMap).get(from), desc;
  if (entry)
    return entry;
  entry = __defProp({}, "__esModule", { value: true });
  if (from && typeof from === "object" || typeof from === "function") {
    for (var key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(entry, key))
        __defProp(entry, key, {
          get: __accessProp.bind(from, key),
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
        });
  }
  __moduleCache.set(from, entry);
  return entry;
};
var __moduleCache;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};

// e2e/performance/timeline/timeline-test-helpers.ts
var exports_timeline_test_helpers = {};
__export(exports_timeline_test_helpers, {
  stressSessionHref: () => stressSessionHref,
  stressDraftHref: () => stressDraftHref,
  mockStressTimeline: () => mockStressTimeline,
  installTimelineSettings: () => installTimelineSettings,
  installStressSessionTabs: () => installStressSessionTabs,
  createReviewDiffs: () => createReviewDiffs
});
module.exports = __toCommonJS(exports_timeline_test_helpers);

// ../core/src/util/encode.ts
function base64Encode(value) {
  const bytes = new TextEncoder().encode(value);
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

// e2e/utils/mock-server.ts
var emptyList = new Set(["/skill", "/command", "/lsp", "/formatter", "/vcs/status", "/vcs/diff"]);
var emptyObject = new Set(["/global/config", "/config", "/provider/auth", "/mcp", "/experimental/resource"]);
async function mockArforgeServer(page, config) {
  const cursors = new Map;
  let nextCursor = 0;
  const staticRoutes = {
    "/provider": config.provider,
    "/path": {
      state: config.directory,
      config: config.directory,
      worktree: config.directory,
      directory: config.directory,
      home: "C:/Arforge"
    },
    "/project": [config.project],
    "/project/current": config.project,
    "/agent": [{ name: "build", mode: "primary" }],
    "/vcs": { branch: "main", default_branch: "main" },
    "/session": config.sessions
  };
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const targetPort = process.env.PLAYWRIGHT_SERVER_PORT ?? "4096";
    const appPort = process.env.ARFORGE_PLAYWRIGHT_TEMP_PORT ?? new URL(process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? "3000"}`).port;
    if (url.port !== targetPort && url.port !== appPort)
      return route.fallback();
    const path = url.pathname;
    if (route.request().method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers: corsHeaders(route) });
    }
    if (path === "/auth/session")
      return json(route, { authenticated: true });
    if (path === "/global/event" || path === "/event" || path === "/api/event") {
      const events = config.events?.();
      return sse(route, path === "/api/event" ? [{ id: "evt_mock_connected", type: "server.connected", data: {} }, ...events?.map(currentEvent) ?? []] : [
        ...path === "/global/event" ? [{ payload: { id: "evt_mock_connected", type: "server.connected", properties: {} } }] : [],
        ...events ?? []
      ], config.eventRetry);
    }
    if (path === "/global/health")
      return config.protocol === "v2" ? json(route, {}, undefined, 404) : json(route, { healthy: true });
    if (path === "/api/health" && config.protocol === "v2")
      return json(route, { healthy: true, version: "2.0.0", pid: 1 });
    if (path === "/experimental/capabilities")
      return json(route, { backgroundSubagents: true });
    if (path === "/permission")
      return json(route, typeof config.permissions === "function" ? config.permissions() : config.permissions ?? []);
    if (path === "/question")
      return json(route, typeof config.questions === "function" ? config.questions() : config.questions ?? []);
    if (path === "/session/status")
      return json(route, typeof config.sessionStatus === "function" ? config.sessionStatus() : config.sessionStatus ?? {});
    if (path === "/vcs/diff" && config.vcsDiff)
      return json(route, config.vcsDiff);
    if (path === "/file" && config.fileList)
      return json(route, await config.fileList(url.searchParams.get("path") ?? ""));
    if (path === "/file/content" && config.fileContent)
      return json(route, await config.fileContent(url.searchParams.get("path") ?? ""));
    if (path === "/find/file" && config.findFiles)
      return json(route, await config.findFiles({
        query: url.searchParams.get("query") ?? "",
        dirs: url.searchParams.get("dirs") ?? undefined,
        limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined
      }));
    if (path === "/api/reference")
      return json(route, {
        location: {
          directory: config.directory,
          project: { id: config.project.id, directory: config.directory }
        },
        data: []
      });
    if (path === "/api/agent")
      return json(route, {
        location: location(config),
        data: [
          {
            id: "build",
            name: "Build",
            mode: "primary",
            hidden: false,
            request: { settings: {}, headers: {}, body: {} },
            permissions: []
          }
        ]
      });
    if (path === "/api/provider") {
      const provider = config.provider;
      const data = Array.isArray(provider) ? provider : provider.all ?? [];
      return json(route, { location: location(config), data: data.map(withProviderPackage) });
    }
    if (path === "/api/model")
      return json(route, { location: location(config), data: config.models ?? [] });
    if (path === "/api/model/default")
      return json(route, { location: location(config), data: config.defaultModel ?? null });
    if (path === "/api/command")
      return json(route, { location: location(config), data: [] });
    if (path === "/api/mcp")
      return json(route, { location: location(config), data: [] });
    if (path === "/api/mcp/resource")
      return json(route, { location: location(config), data: { resources: [], templates: [] } });
    const integration = path.match(/^\/api\/integration\/([^/]+)$/)?.[1];
    if (integration && route.request().method() === "GET")
      return json(route, {
        location: location(config),
        data: { id: integration, name: integration, methods: [{ type: "key", label: "API key" }], connections: [] }
      });
    if (/^\/api\/integration\/[^/]+\/connect\/key$/.test(path) && route.request().method() === "POST")
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } });
    if (path === "/api/project")
      return json(route, [config.project]);
    if (path === "/api/project/current")
      return json(route, { id: config.project.id, directory: config.directory });
    if (path.startsWith("/api/project/") && route.request().method() === "PATCH")
      return json(route, config.project);
    if (path === "/api/path")
      return json(route, {
        state: config.directory,
        config: config.directory,
        worktree: config.directory,
        directory: config.directory,
        home: "C:/Arforge"
      });
    if (path === "/api/location")
      return json(route, {
        directory: config.directory,
        project: { id: config.project.id, directory: config.directory }
      });
    if (path === "/api/permission/request")
      return json(route, {
        location: location(config),
        data: (typeof config.permissions === "function" ? config.permissions() : config.permissions ?? []).map(currentPermission)
      });
    if (path === "/api/question/request")
      return json(route, {
        location: location(config),
        data: typeof config.questions === "function" ? config.questions() : config.questions ?? []
      });
    if (path === "/api/vcs")
      return json(route, { location: location(config), data: { branch: "main", defaultBranch: "main" } });
    if (path === "/api/vcs/status")
      return json(route, { location: location(config), data: [] });
    if (path === "/api/vcs/diff")
      return json(route, { location: location(config), data: config.vcsDiff ?? [] });
    if (path === "/api/pty/shells")
      return json(route, { location: location(config), data: [] });
    if (/^\/api\/pty\/[^/]+\/connect-token$/.test(path))
      return json(route, { location: location(config), data: { ticket: "e2e-ticket", expires_in: 60 } });
    if (emptyObject.has(path))
      return json(route, {});
    if (emptyList.has(path))
      return json(route, []);
    if (path === "/api/session") {
      const directory = url.searchParams.get("directory");
      const parentID = url.searchParams.get("parentID");
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const offset = Number(url.searchParams.get("cursor") ?? 0);
      const sessions = config.sessions.filter((session) => !directory || session.directory === directory).filter((session) => parentID !== "null" || session.parentID === undefined).filter((session) => {
        const search = url.searchParams.get("search")?.toLowerCase();
        return !search || String(session.title ?? "").toLowerCase().includes(search);
      });
      const ordered = url.searchParams.get("order") === "asc" ? sessions.toReversed() : sessions;
      const data = ordered.slice(offset, offset + limit);
      const next = offset + limit < ordered.length ? String(offset + limit) : undefined;
      return json(route, {
        data: data.map((session) => currentSession(session, config.directory)),
        cursor: { next }
      });
    }
    if (path === "/api/session/active") {
      const statuses = config.sessionStatus ?? {};
      return json(route, {
        data: Object.fromEntries(Object.entries(statuses).flatMap(([id, status]) => status.type === "idle" ? [] : [[id, { type: "running" }]]))
      });
    }
    if (/^\/api\/session\/[^/]+\/shell$/.test(path) && route.request().method() === "POST") {
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } });
    }
    if (/^\/api\/session\/[^/]+\/question\/[^/]+\/(reply|reject)$/.test(path) && route.request().method() === "POST") {
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } });
    }
    if (/^\/api\/session\/[^/]+\/permission\/[^/]+\/reply$/.test(path) && route.request().method() === "POST") {
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } });
    }
    if (/^\/question\/[^/]+\/(reply|reject)$/.test(path) && route.request().method() === "POST") {
      return json(route, true);
    }
    if (/^\/session\/[^/]+\/permissions\/[^/]+$/.test(path) && route.request().method() === "POST") {
      return json(route, true);
    }
    if (/^\/api\/session\/[^/]+\/(archive|rename|interrupt|revert\/clear|revert\/commit)$/.test(path) && route.request().method() === "POST") {
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } });
    }
    if (/^\/api\/session\/[^/]+$/.test(path) && route.request().method() === "DELETE") {
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } });
    }
    if (path in staticRoutes)
      return json(route, staticRoutes[path]);
    const currentSessionMatch = path.match(/^\/api\/session\/([^/]+)$/);
    if (currentSessionMatch) {
      const session = config.sessions.find((item) => item.id === currentSessionMatch[1]);
      if (!session)
        return json(route, { error: "Session not found" }, undefined, 404);
      return json(route, {
        data: currentSession(session, config.directory)
      });
    }
    const sessionMatch = path.match(/^\/session\/([^/]+)$/);
    if (sessionMatch) {
      const session = config.sessions.find((s) => s.id === sessionMatch[1]);
      return json(route, session ?? {});
    }
    const projectMatch = path.match(/^\/project\/([^/]+)$/);
    if (projectMatch)
      return json(route, config.project);
    const messageMatch = path.match(/^\/session\/([^/]+)\/message\/([^/]+)$/);
    if (messageMatch) {
      config.onMessage?.({ sessionID: messageMatch[1], messageID: messageMatch[2] });
      if (config.messageDelay !== undefined)
        await new Promise((resolve) => setTimeout(resolve, config.messageDelay));
      const message = config.message?.(messageMatch[1], messageMatch[2]);
      if (message === undefined)
        return json(route, { error: "Message not found" }, undefined, 404);
      return json(route, message);
    }
    const todoMatch = path.match(/^\/session\/([^/]+)\/todo$/);
    if (todoMatch)
      return json(route, config.todos?.(todoMatch[1]) ?? []);
    if (/^\/session\/[^/]+\/(children|diff)$/.test(path))
      return json(route, []);
    const currentMessagesMatch = path.match(/^\/api\/session\/([^/]+)\/message$/);
    if (currentMessagesMatch) {
      const token = url.searchParams.get("cursor") ?? undefined;
      const before = token ? cursors.get(token) : undefined;
      if (token && !before)
        return json(route, { error: "Invalid cursor" }, undefined, 400);
      config.onMessages?.({ sessionID: currentMessagesMatch[1], before, phase: "start" });
      await config.beforeMessagesResponse?.({ sessionID: currentMessagesMatch[1], before });
      if (config.messageDelay !== undefined)
        await new Promise((resolve) => setTimeout(resolve, config.messageDelay));
      const pageData = config.pageMessages(currentMessagesMatch[1], Number(url.searchParams.get("limit") ?? 50), before);
      config.onMessages?.({ sessionID: currentMessagesMatch[1], before, phase: "end" });
      const cursor = pageData.cursor ? `cursor_${++nextCursor}` : undefined;
      if (cursor)
        cursors.set(cursor, pageData.cursor);
      return json(route, {
        data: pageData.items.map(currentMessage).reverse(),
        cursor: { next: cursor }
      });
    }
    const messagesMatch = path.match(/^\/session\/([^/]+)\/message$/);
    if (messagesMatch) {
      const token = url.searchParams.get("before") ?? undefined;
      const before = token ? cursors.get(token) : undefined;
      if (token && !before)
        return json(route, { error: "Invalid cursor" }, undefined, 400);
      config.onMessages?.({ sessionID: messagesMatch[1], before, phase: "start" });
      await config.beforeMessagesResponse?.({ sessionID: messagesMatch[1], before });
      if (config.messageDelay !== undefined)
        await new Promise((resolve) => setTimeout(resolve, config.messageDelay));
      const limit = Number(url.searchParams.get("limit") ?? 80);
      const pageData = config.pageMessages(messagesMatch[1], limit, before);
      config.onMessages?.({ sessionID: messagesMatch[1], before, phase: "end" });
      if (!pageData.cursor)
        return json(route, pageData.items);
      const cursor = `cursor_${++nextCursor}`;
      cursors.set(cursor, pageData.cursor);
      return json(route, pageData.items, { "x-next-cursor": cursor });
    }
    if (url.port === targetPort && targetPort !== appPort)
      return json(route, {});
    return route.fallback();
  });
}
function location(config) {
  return {
    directory: config.directory,
    project: { id: config.project.id, directory: config.directory }
  };
}
function withProviderPackage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return value;
  const provider = value;
  return { package: String(provider.package ?? provider.id ?? "mock-provider"), ...provider };
}
function currentPermission(value) {
  const permission = value;
  if (permission.action)
    return permission;
  const tool = permission.tool;
  return {
    id: permission.id,
    sessionID: permission.sessionID,
    action: permission.permission,
    resources: permission.patterns ?? [],
    save: permission.always,
    metadata: permission.metadata,
    source: tool?.messageID && tool.callID ? { type: "tool", messageID: tool.messageID, callID: tool.callID } : undefined
  };
}
function currentSession(session, fallbackDirectory) {
  const time = session.time && typeof session.time === "object" ? session.time : {};
  return {
    id: session.id,
    parentID: session.parentID,
    projectID: session.projectID ?? "project",
    agent: session.agent ?? "build",
    model: session.model ?? { id: "mock-model", providerID: "mock-provider" },
    cost: session.cost ?? 0,
    tokens: session.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: {
      created: "created" in time && typeof time.created === "number" ? time.created : 0,
      updated: "updated" in time && typeof time.updated === "number" ? time.updated : 0,
      ...session.time && typeof session.time === "object" && "archived" in session.time ? { archived: session.time.archived } : {}
    },
    title: session.title ?? session.id,
    location: {
      directory: typeof session.directory === "string" ? session.directory : fallbackDirectory,
      ...typeof session.workspaceID === "string" ? { workspaceID: session.workspaceID } : {}
    },
    subpath: session.path,
    revert: session.revert
  };
}
function currentMessage(value) {
  const item = value;
  if (item.info.role === "user") {
    return {
      id: item.info.id,
      type: "user",
      time: item.info.time,
      text: item.parts.flatMap((part) => part.type === "text" && typeof part.text === "string" ? [part.text] : []).join(`
`)
    };
  }
  return {
    id: item.info.id,
    type: "assistant",
    time: item.info.time,
    agent: item.info.agent ?? "build",
    model: { id: item.info.modelID ?? "model", providerID: item.info.providerID ?? "provider" },
    cost: item.info.cost,
    tokens: item.info.tokens,
    error: item.info.error,
    content: item.parts.flatMap((part) => {
      if (part.type === "text" || part.type === "reasoning")
        return [{ type: part.type, text: part.text ?? "" }];
      if (part.type !== "tool")
        return [];
      const state = part.state;
      return [
        {
          type: "tool",
          id: part.id,
          name: part.tool,
          time: state.time ?? { created: item.info.time.created },
          state: state.status === "pending" ? { status: "streaming", input: state.raw ?? JSON.stringify(state.input ?? {}) } : state.status === "completed" ? {
            status: "completed",
            input: state.input ?? {},
            structured: state.metadata ?? {},
            content: [{ type: "text", text: state.output ?? "" }]
          } : state.status === "error" ? {
            status: "error",
            input: state.input ?? {},
            structured: state.metadata ?? {},
            content: [],
            error: { type: "ToolError", message: state.error ?? "Tool failed" }
          } : { status: "running", input: state.input ?? {}, structured: state.metadata ?? {}, content: [] }
        }
      ];
    })
  };
}
function json(route, body, headers, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: {
      ...corsHeaders(route),
      "access-control-expose-headers": "x-next-cursor",
      ...headers
    },
    body: JSON.stringify(body ?? null)
  });
}
function sse(route, events, retry) {
  return route.fulfill({
    status: 200,
    contentType: "text/event-stream",
    headers: corsHeaders(route),
    body: `${retry === undefined ? "" : `retry: ${retry}

`}${events?.map((event) => `data: ${JSON.stringify(event)}

`).join("") || `: ok

`}`
  });
}
function corsHeaders(route) {
  const origin = route.request().headers()["origin"];
  return {
    "access-control-allow-origin": origin ?? "*",
    ...origin ? { "access-control-allow-credentials": "true", vary: "Origin" } : {},
    "access-control-allow-methods": "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": route.request().headers()["access-control-request-headers"] ?? "authorization,content-type,x-arforge-directory"
  };
}
function currentEvent(input) {
  if (!input || typeof input !== "object" || !("payload" in input))
    return input;
  const envelope = input;
  if (!envelope.payload || typeof envelope.payload !== "object")
    return input;
  const payload = envelope.payload;
  if (!payload.type)
    return input;
  return {
    id: payload.id ?? `evt_mock_${Date.now()}`,
    created: Date.now(),
    type: payload.type,
    data: payload.properties ?? {},
    location: envelope.directory && envelope.directory !== "global" ? { directory: envelope.directory } : undefined
  };
}

// e2e/performance/playwright-server.ts
var loopbackHost = "127.0.0.1";
function parsePlaywrightPort(value) {
  if (value === undefined || value.trim() === "")
    return;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PLAYWRIGHT_PORT must be an integer between 1 and 65535; received "${value}"`);
  }
  return port;
}
function playwrightBaseURL(port) {
  return `http://${loopbackHost}:${port}`;
}
function playwrightScenarioServer(env = process.env) {
  const isolatedAppPort = parsePlaywrightPort(env.ARFORGE_PLAYWRIGHT_TEMP_PORT);
  if (isolatedAppPort)
    return playwrightBaseURL(isolatedAppPort);
  return `http://${env.PLAYWRIGHT_SERVER_HOST ?? loopbackHost}:${env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`;
}

// e2e/performance/timeline/session-timeline-stress.fixture.ts
var words = [
  "alpha",
  "bravo",
  "charlie",
  "delta",
  "echo",
  "foxtrot",
  "golf",
  "hotel",
  "india",
  "juliet",
  "kilo",
  "lima",
  "metro",
  "nova",
  "orbit",
  "pixel",
  "quartz",
  "river",
  "signal",
  "vector"
];
var sourceID = "ses_smoke_source";
var targetID = "ses_smoke_target";
var childID = "ses_smoke_child";
var directory = "C:/Arforge/SmokeProject";
var projectID = "proj_smoke_timeline";
var model = { providerID: "arforge", modelID: "claude-opus-4-6", variant: "max" };
function lorem(seed, length) {
  let out = "";
  let i = seed;
  while (out.length < length) {
    const word = words[i % words.length];
    out += (out ? " " : "") + word;
    if (i % 17 === 0)
      out += `.

`;
    i += 7;
  }
  return out.slice(0, length);
}
function id(prefix, value) {
  return `${prefix}_smoke_${String(value).padStart(4, "0")}`;
}
function userMessage(sessionID, index, textLength, diffs = []) {
  const messageID = id("msg_user", index);
  return {
    info: {
      id: messageID,
      sessionID,
      role: "user",
      time: { created: 1700000000000 + index * 1e4 },
      summary: { diffs },
      agent: "build",
      model
    },
    parts: [
      {
        id: id("prt_user_text", index),
        sessionID,
        messageID,
        type: "text",
        text: lorem(index, textLength)
      }
    ]
  };
}
function assistantMessage(sessionID, index, parentID, parts) {
  const messageID = id("msg_assistant", index);
  return {
    info: {
      id: messageID,
      sessionID,
      role: "assistant",
      time: { created: 1700000000000 + index * 1e4 + 1000, completed: 1700000000000 + index * 1e4 + 8000 },
      parentID,
      modelID: model.modelID,
      providerID: model.providerID,
      mode: "build",
      agent: "build",
      path: { cwd: directory, root: directory },
      cost: 0.01,
      tokens: { input: 100, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
      variant: "max",
      finish: "stop"
    },
    parts: parts.map((part) => ({
      ...part,
      sessionID,
      messageID
    }))
  };
}
function textPart(index, partIndex, length) {
  const prose = lorem(index * 13 + partIndex, length);
  const text = index % 12 === 0 ? `${prose}

\`\`\`ts
${code(index, 80)}
\`\`\`` : index % 5 === 0 ? `${prose}

\`\`\`ts
export const value = "${lorem(index, 220)}"
\`\`\`` : index % 7 === 0 ? `${prose}

The wrapped inline value is \`${lorem(index, 180)}\`.` : prose;
  return { id: id(`prt_text_${partIndex}`, index), type: "text", text };
}
function reasoningPart(index, partIndex, length) {
  return {
    id: id(`prt_reasoning_${partIndex}`, index),
    type: "reasoning",
    text: lorem(index * 19 + partIndex, length),
    time: { start: 1700000000000 + index * 1e4, end: 1700000000000 + index * 1e4 + 500 }
  };
}
function toolPart(index, partIndex, tool, input, outputLength = 160, metadataOverride) {
  const metadata = metadataOverride ?? (tool === "apply_patch" ? { files: [patchFile(index, "update"), patchFile(index + 1, index % 2 === 0 ? "add" : "delete")] } : tool === "edit" || tool === "write" ? {
    filediff: fileDiff(String(input.filePath ?? `src/generated/file-${index}.ts`), index),
    diff: patch(index, outputLength),
    preview: patch(index + 1, 420)
  } : tool === "question" ? { answers: [["Proceed"], ["Keep sample output"]] } : {});
  return {
    id: id(`prt_tool_${tool}_${partIndex}`, index),
    type: "tool",
    callID: id("call", index * 10 + partIndex),
    tool,
    state: {
      status: "completed",
      input,
      output: lorem(index * 23 + partIndex, outputLength),
      title: tool === "bash" ? "Verify generated output" : input.filePath || input.path || input.pattern || "completed",
      metadata,
      time: { start: 1700000000000 + index * 1e4, end: 1700000000000 + index * 1e4 + 400 }
    }
  };
}
function patchFile(seed, type) {
  return {
    filePath: `src/generated/patch-${seed}.ts`,
    relativePath: `src/generated/patch-${seed}.ts`,
    type,
    additions: seed % 7 + 1,
    deletions: type === "add" ? 0 : seed % 4,
    patch: patch(seed, 520),
    before: type === "add" ? undefined : code(seed, 18),
    after: type === "delete" ? undefined : code(seed + 1, 24)
  };
}
function fileDiff(file, seed) {
  const lines = seed % 12 === 0 ? 300 : seed % 8 === 0 ? 2 : 38;
  const before = code(seed, lines, seed % 10 === 0 ? 280 : 32);
  const after = lines === 2 ? before.replace("value1", "updatedValue1") : lines === 300 ? code(seed + 1, lines, seed % 10 === 0 ? 280 : 32) : before.replace("value4", "updatedValue4").replace("value20", "updatedValue20");
  return {
    file,
    additions: lines === 300 ? 300 : lines === 2 ? 1 : 2,
    deletions: lines === 300 ? 300 : lines === 2 ? 1 : 2,
    before,
    after
  };
}
function patch(seed, length) {
  return `diff --git a/src/generated/file-${seed}.ts b/src/generated/file-${seed}.ts
+${lorem(seed, length).replace(/\n/g, `
+`)}`;
}
function code(seed, lines, width = 32) {
  return Array.from({ length: lines }, (_, index) => `export const value${index} = "${lorem(seed + index, width)}"`).join(`
`);
}
function turn(index) {
  const diff = index % 9 === 0 ? [fileDiff(`src/generated/summary-${index}.ts`, index)] : [];
  const user = userMessage(targetID, index, 100 + index % 4 * 80, diff);
  const parts = [
    ...index % 5 === 0 ? [reasoningPart(index, 0, 420)] : [],
    ...index % 3 === 0 ? [
      toolPart(index, 0, "read", { filePath: `src/generated/file-${index}.ts`, offset: 0, limit: 80 }, 220),
      toolPart(index, 5, "glob", { path: directory, pattern: `**/*sample-${index}*.ts` }, 140),
      toolPart(index, 1, "grep", { path: directory, pattern: `sample-${index}`, include: "*.ts" }, 180),
      toolPart(index, 6, "list", { path: `src/generated/${index}` }, 120)
    ] : [],
    textPart(index, 2, 160 + index % 6 * 90),
    ...index % 4 === 0 ? [toolPart(index, 3, "edit", { filePath: `src/generated/file-${index}.ts` }, 700)] : [],
    ...index % 6 === 0 ? [toolPart(index, 7, "write", { filePath: `src/generated/write-${index}.ts`, content: code(index, 28) }, 560)] : [],
    ...index % 8 === 0 ? [toolPart(index, 8, "apply_patch", { files: [`src/generated/patch-${index}.ts`] }, 620)] : [],
    ...index % 7 === 0 ? [toolPart(index, 4, "bash", { command: "bun typecheck", description: "Verify generated output" }, 620)] : [],
    ...index % 10 === 0 ? [toolPart(index, 9, "webfetch", { url: "https://example.com/docs/sample" }, 120)] : [],
    ...index % 11 === 0 ? [toolPart(index, 10, "websearch", { query: "sample movement notes" }, 240)] : [],
    ...index % 13 === 0 ? [
      toolPart(index, 11, "question", { questions: [{ question: "Use generated fixture?" }, { question: "Keep same row shape?" }] }, 120)
    ] : [],
    ...index % 17 === 0 ? [toolPart(index, 12, "task", { description: "Inspect generated fixture", subagent_type: "explore" }, 160)] : []
  ];
  return [user, assistantMessage(targetID, index, user.info.id, parts)];
}
var targetMessages = Array.from({ length: 72 }, (_, index) => turn(index)).flat();
var sourceMessages = Array.from({ length: 12 }, (_, index) => [
  userMessage(sourceID, index + 1000, 120),
  assistantMessage(sourceID, index + 1000, id("msg_user", index + 1000), [
    textPart(index + 1000, 0, 240),
    ...index === 11 ? [
      toolPart(index + 1000, 1, "task", { description: "Inspect child navigation", subagent_type: "explore" }, 160, { sessionId: childID })
    ] : []
  ])
]).flat();
var childMessages = Array.from({ length: 4 }, (_, index) => [
  userMessage(childID, index + 2000, 120),
  assistantMessage(childID, index + 2000, id("msg_user", index + 2000), [textPart(index + 2000, 0, 240)])
]).flat();
function renderable(part) {
  if (part.type === "tool" && part.tool === "todowrite")
    return false;
  if (part.type === "text")
    return !!part.text.trim();
  if (part.type === "reasoning")
    return !!part.text.trim();
  return part.type !== "step-start" && part.type !== "step-finish" && part.type !== "patch";
}
function orderedParts(message) {
  return message.parts.slice().sort((a, b) => a.id.localeCompare(b.id));
}
var fixture = {
  directory,
  project: {
    id: projectID,
    worktree: directory,
    vcs: "git",
    name: "smoke-project",
    time: { created: 1700000000000, updated: 1700000000000 },
    sandboxes: []
  },
  provider: {
    all: [
      {
        id: "arforge",
        name: "Arforge",
        models: { "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200000 } } }
      }
    ],
    connected: ["arforge"],
    default: { providerID: "arforge", modelID: "claude-opus-4-6" }
  },
  sessions: [
    {
      id: sourceID,
      slug: "source",
      projectID,
      directory,
      title: "Uncommitted changes inquiry",
      version: "dev",
      time: { created: 1700000000000, updated: 1700000000000 }
    },
    {
      id: targetID,
      slug: "target",
      projectID,
      directory,
      title: "Example Game: sample jump movement & sample physics analysis",
      version: "dev",
      time: { created: 1700000001000, updated: 1700000001000 }
    },
    {
      id: childID,
      parentID: sourceID,
      slug: "child",
      projectID,
      directory,
      title: "Inspect child navigation",
      version: "dev",
      time: { created: 1700000002000, updated: 1700000002000 }
    }
  ],
  sourceID,
  targetID,
  childID,
  messages: { [sourceID]: sourceMessages, [targetID]: targetMessages, [childID]: childMessages },
  expected: {
    sourceTitle: "Uncommitted changes inquiry",
    targetTitle: "Example Game: sample jump movement & sample physics analysis",
    childTitle: "Inspect child navigation",
    sourceMessageIDs: sourceMessages.filter((message) => message.info.role === "user").map((message) => message.info.id),
    targetMessageIDs: targetMessages.filter((message) => message.info.role === "user").map((message) => message.info.id),
    childMessageIDs: childMessages.filter((message) => message.info.role === "user").map((message) => message.info.id),
    targetPartIDs: targetMessages.flatMap((message) => orderedParts(message).filter(renderable).map((part) => part.id))
  }
};
function pageMessages(sessionID, limit, before) {
  const messages = fixture.messages[sessionID] ?? [];
  const end = before ? Math.max(0, messages.findIndex((message) => message.info.id === before)) : messages.length;
  const start = Math.max(0, end - limit);
  return {
    items: messages.slice(start, end),
    cursor: start > 0 ? messages[start].info.id : undefined
  };
}

// e2e/performance/timeline/timeline-test-helpers.ts
async function installTimelineSettings(page) {
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({
      general: {
        newLayoutDesigns: true,
        editToolPartsExpanded: true,
        shellToolPartsExpanded: true,
        showReasoningSummaries: true
      }
    }));
  });
}
function mockStressTimeline(page, input) {
  return mockArforgeServer(page, {
    sessions: fixture.sessions,
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
    onMessages: input?.onMessages,
    vcsDiff: input?.vcsDiff
  });
}
async function installStressSessionTabs(page, input) {
  const server = stressServer();
  await page.addInitScript(({ directory: directory2, sessionIDs, dirBase64, server: server2, draftID }) => {
    localStorage.setItem("arforge.global.dat:server", JSON.stringify({
      projects: { local: [{ worktree: directory2, expanded: true }] },
      lastProject: { local: directory2 }
    }));
    localStorage.setItem("arforge.window.browser.dat:tabs", JSON.stringify([
      ...sessionIDs.map((sessionId) => ({
        type: "session",
        server: server2,
        dirBase64,
        sessionId
      })),
      ...draftID ? [{ type: "draft", draftID, server: server2, directory: directory2 }] : []
    ]));
  }, {
    directory: fixture.directory,
    sessionIDs: input?.sessionIDs ?? [fixture.sourceID, fixture.targetID],
    dirBase64: base64Encode(fixture.directory),
    server,
    draftID: input?.draftID
  });
}
function stressSessionHref(sessionID) {
  return `/server/${base64Encode(stressServer())}/session/${sessionID}`;
}
function stressDraftHref(draftID) {
  return `/new-session?draftId=${encodeURIComponent(draftID)}`;
}
function stressServer() {
  return playwrightScenarioServer();
}
function createReviewDiffs() {
  return Array.from({ length: Number(process.env.REVIEW_PANE_DIFF_COUNT ?? 72) }, (_, index) => {
    const lines = index % 3 === 0 ? 300 : index % 3 === 1 ? 120 : 38;
    const file = `src/review/generated-${String(index).padStart(3, "0")}.ts`;
    const before = reviewSource(index, lines);
    const after = before.replace(`value_${index}_4`, `updated_${index}_4`).replace(`value_${index}_${Math.max(8, Math.floor(lines / 2))}`, `updated_${index}_${Math.max(8, Math.floor(lines / 2))}`).replace(`value_${index}_${lines - 4}`, `updated_${index}_${lines - 4}`);
    return {
      file,
      patch: reviewPatch(file, before, after),
      additions: 3,
      deletions: 3,
      status: "modified"
    };
  });
}
function reviewSource(seed, lines) {
  return Array.from({ length: lines }, (_, index) => `export const value_${seed}_${index} = "${reviewWords(seed + index, index % 5 === 0 ? 180 : 42)}"`).join(`
`);
}
function reviewPatch(file, before, after) {
  const beforeLines = before.split(`
`);
  const afterLines = after.split(`
`);
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
    ...beforeLines.flatMap((line, index) => {
      const next = afterLines[index];
      if (line === next)
        return [` ${line}`];
      return [`-${line}`, `+${next}`];
    })
  ].join(`
`);
}
function reviewWords(seed, length) {
  const words2 = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];
  return Array.from({ length: Math.ceil(length / 7) }, (_, index) => words2[(seed + index * 3) % words2.length]).join(" ");
}
