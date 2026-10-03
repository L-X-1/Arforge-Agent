import { expect, test } from "bun:test"
import { isSessionNotFoundError, isUnauthorizedError, Arforge } from "../src"

test("exposes every standard HTTP API group", () => {
  const client = Arforge.make({ baseUrl: "http://localhost:3000" })

  expect(Object.keys(client)).toEqual([
    "health",
    "location",
    "agents",
    "sessions",
    "artifacts",
    "subagentControl",
    "goals",
    "scheduledPrompts",
    "tasks",
    "teams",
    "waits",
    "triggers",
    "memories",
    "learning",
    "feedback",
    "diagnostics",
    "agentCapabilities",
    "mcp",
    "privateOperations",
    "runtimeInsight",
    "messages",
    "models",
    "providers",
    "integrations",
    "credentials",
    "permissions",
    "files",
    "commands",
    "skills",
    "events",
    "ptys",
    "questions",
    "references",
    "projectCopies",
    "personalJobs",
    "personalWorkspace",
    "tenantPlatform",
  ])
  expect(Object.keys(client.messages)).toEqual(["list"])
  expect(Object.keys(client.subagentControl)).toEqual(["children", "steer", "followup", "wait", "cancel", "status"])
  expect(Object.keys(client.artifacts)).toEqual([
    "read",
    "readRange",
    "readScoped",
    "readScopedRange",
    "ownerContext",
    "maintenanceContext",
    "catalog",
    "catalogScoped",
    "audit",
    "auditScoped",
  ])
  expect(Object.keys(client.integrations)).toEqual([
    "list",
    "get",
    "connectKey",
    "connectOauth",
    "attemptStatus",
    "attemptComplete",
    "attemptCancel",
  ])
  expect(Object.keys(client.files)).toEqual(["open", "close", "read", "save", "list", "find"])
  expect(Object.keys(client.ptys)).toEqual(["list", "create", "get", "update", "remove"])
  expect(Object.keys(client.goals)).toEqual([
    "list",
    "create",
    "get",
    "run",
    "pause",
    "resume",
    "complete",
    "block",
    "cancel",
    "replace",
    "deleteQueued",
    "reorder",
  ])
})

test("diagnostics client forwards the fused mode and cancellation signal", async () => {
  let requestedUrl = ""
  let requestedInit: RequestInit | undefined
  const client = Arforge.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      requestedUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      requestedInit = init
      return Response.json({ data: {} })
    },
  })
  const controller = new AbortController()
  await client.diagnostics.diagnose(
    { location: { directory: "C:/workspace" }, filename: "index.html", mode: "frontend" },
    { signal: controller.signal },
  )

  expect(requestedUrl).toBe("http://localhost:3000/api/diagnostics/multimodal?location%5Bdirectory%5D=C%3A%2Fworkspace")
  expect(requestedInit?.signal).toBe(controller.signal)
  expect(JSON.parse(String(requestedInit?.body))).toEqual({ filename: "index.html", mode: "frontend" })
})

test("runtime insight recovery sweep forwards the explicit approval envelope", async () => {
  let requestedUrl = ""
  let requestedInit: RequestInit | undefined
  const client = Arforge.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      requestedUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      requestedInit = init
      return Response.json({
        schemaVersion: 1,
        status: null,
        limit: 10,
        scanned: 0,
        committed: 0,
        pending: 0,
        recoveryRequired: 0,
        failed: 0,
        hasMore: false,
        items: [],
        deterministic: true,
        providerExecutionAllowed: false,
        reason: "No pending recovery receipts were found.",
        access: { role: "owner", scope: "tenant", metadataOnly: true },
      })
    },
  })

  await client.runtimeInsight.childSettlementRecoverySweep({
    location: { directory: "C:/workspace" },
    approval: "recover_settlements",
    limit: 10,
  })

  expect(requestedUrl).toBe(
    "http://localhost:3000/api/runtime-insight/settlements/recover-pending?location%5Bdirectory%5D=C%3A%2Fworkspace",
  )
  expect(requestedInit?.method).toBe("POST")
  expect(JSON.parse(String(requestedInit?.body))).toEqual({ approval: "recover_settlements", limit: 10 })
})

test("subagent control client preserves the safe request envelope", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const client = Arforge.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      requests.push({ url, init })
      return Response.json({
        operation: "steer",
        parentRunID: "run_parent",
        childRunID: "run_child",
        status: "running",
        timedOut: false,
        requestID: "req_1",
        admission: {
          messageID: "msg_1",
          sessionID: "ses_child",
          delivery: "steer",
          promptDigest: "a".repeat(64),
          envelopeDigest: "b".repeat(64),
        },
        controlRunID: "run_control",
        actionID: "act_control",
        claim: "claimed",
      })
    },
  })

  const result = await client.subagentControl.steer({
    parentRunID: "run_parent",
    childRunID: "run_child",
    location: "C:/workspace",
    requestID: "req_1",
    prompt: "continue",
  })

  expect(result.admission?.delivery).toBe("steer")
  expect(requests[0]?.url).toBe(
    "http://localhost:3000/api/subagent-control/run_parent/run_child/steer?location=C%3A%2Fworkspace",
  )
  expect(requests[0]?.init?.method).toBe("POST")
  const body = requests[0]?.init?.body
  if (typeof body !== "string") throw new Error("Expected JSON request body")
  expect(JSON.parse(body)).toEqual({ requestID: "req_1", prompt: "continue" })
  expect(body).not.toContain("leaseID")
  expect(body).not.toContain("ownerID")
})

test("subagent control status reads a durable claim without sending lease material", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const client = Arforge.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      requests.push({ url, init })
      return Response.json({
        operation: "cancel",
        parentRunID: "run_parent",
        childRunID: "run_child",
        status: "cancelled",
        timedOut: false,
        requestID: "cpr_status",
        controlRunID: "run_control",
        actionID: "act_control",
        claim: "existing",
      })
    },
  })

  const result = await client.subagentControl.status({
    parentRunID: "run_parent",
    childRunID: "run_child",
    operation: "cancel",
    requestID: "cpr_status",
    location: "C:/workspace",
  })

  expect(result.status).toBe("cancelled")
  expect(requests[0]?.url).toBe(
    "http://localhost:3000/api/subagent-control/run_parent/run_child/cancel/cpr_status?location=C%3A%2Fworkspace",
  )
  expect(requests[0]?.init?.method).toBe("GET")
  expect(requests[0]?.init?.body).toBeUndefined()
  expect(JSON.stringify(result)).not.toContain("leaseID")
  expect(JSON.stringify(result)).not.toContain("reason")
})

test("subagent control children lists metadata-only direct child summaries", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const client = Arforge.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      requests.push({ url, init })
      return Response.json({
        parentRunID: "run_parent",
        children: [
          {
            childRunID: "run_child",
            sessionID: "ses_child",
            status: "running",
            depth: 1,
            objectiveDigest: "a".repeat(64),
          },
        ],
      })
    },
  })

  const result = await client.subagentControl.children({
    parentRunID: "run_parent",
    location: "C:/workspace",
  })

  expect(result.children[0]?.status).toBe("running")
  expect(requests[0]?.url).toBe(
    "http://localhost:3000/api/subagent-control/run_parent/children?location=C%3A%2Fworkspace",
  )
  expect(requests[0]?.init?.method).toBe("GET")
  expect(requests[0]?.init?.body).toBeUndefined()
  expect(JSON.stringify(result)).not.toContain("delegatedObjective")
  expect(JSON.stringify(result)).not.toContain("leaseID")
})

test("artifacts.ownerContext exposes only the authenticated profile and tenant scopes", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const client = Arforge.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      requests.push({ url, init })
      return Response.json({
        profile: { scope: "profile", id: "usr_test" },
        tenant: { scope: "tenant", id: "ten_test" },
        tenantReadable: false,
      })
    },
  })

  const context = await client.artifacts.ownerContext()

  expect(context).toEqual({
    profile: { scope: "profile", id: "usr_test" },
    tenant: { scope: "tenant", id: "ten_test" },
    tenantReadable: false,
  })
  expect(requests[0]?.url).toBe("http://localhost:3000/api/artifacts/owner-context")
  expect(requests[0]?.init?.method).toBe("GET")
  expect(JSON.stringify(context)).not.toContain("path")
  expect(JSON.stringify(context)).not.toContain("secret")
})

test("artifacts.maintenanceContext projects a profile-only capability without bytes or paths", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const client = Arforge.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      requests.push({ url, init })
      return Response.json({
        owner: { scope: "profile", id: "usr_test" },
        maintenanceScope: "profile",
        canMaintain: true,
        scan: null,
        reason: "No profile maintenance scan has started.",
      })
    },
  })

  const context = await client.artifacts.maintenanceContext({ scope: "profile" })

  expect(context).toEqual({
    owner: { scope: "profile", id: "usr_test" },
    maintenanceScope: "profile",
    canMaintain: true,
    scan: null,
    reason: "No profile maintenance scan has started.",
  })
  expect(requests[0]?.url).toBe("http://localhost:3000/api/artifacts/maintenance-context?scope=profile")
  expect(requests[0]?.init?.method).toBe("GET")
  expect(JSON.stringify(context)).not.toContain("path")
  expect(JSON.stringify(context)).not.toContain("bytes")
  expect(JSON.stringify(context)).not.toContain("secret")
})

test("artifacts.read returns authenticated opaque bytes", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const client = Arforge.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      requests.push({ url, init })
      return new Response(new Uint8Array([0, 1, 255]), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      })
    },
  })

  const bytes = await client.artifacts.read({
    sessionID: "ses_test",
    reference: {
      version: 1,
      artifactID: "art_test",
      kind: "tool_output",
      digest: "sha256:abc",
      mime: "application/octet-stream",
      sizeBytes: 3,
      owner: { scope: "session", id: "ses_test" },
      retention: { mode: "session" },
      retrievalHint: { kind: "managed", handle: "h_test" },
      createdAt: 1_717_171_717_000,
    },
    maxBytes: 3,
  })

  expect(bytes).toEqual(new Uint8Array([0, 1, 255]))
  expect(requests[0]?.url).toBe("http://localhost:3000/api/session/ses_test/artifacts/read")
  expect(requests[0]?.init?.method).toBe("POST")
  const body = requests[0]?.init?.body
  if (typeof body !== "string") throw new Error("Expected JSON request body")
  expect(JSON.parse(body)).toMatchObject({ reference: { artifactID: "art_test" }, maxBytes: 3 })
})

test("artifacts.readScoped resolves profile and tenant receipts through the shared binary contract", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const client = Arforge.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      requests.push({ url, init })
      return new Response(new Uint8Array([7, 8, 9]), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      })
    },
  })

  const bytes = await client.artifacts.readScoped({
    reference: {
      version: 1,
      artifactID: "art_profile",
      kind: "tool_output",
      digest: "sha256:def",
      mime: "application/octet-stream",
      sizeBytes: 3,
      owner: { scope: "profile", id: "usr_test" },
      retention: { mode: "durable" },
      retrievalHint: { kind: "managed", handle: "h_profile" },
      createdAt: 1_717_171_717_000,
    },
    maxBytes: 3,
  })

  expect(bytes).toEqual(new Uint8Array([7, 8, 9]))
  expect(requests[0]?.url).toBe("http://localhost:3000/api/artifacts/read")
  expect(requests[0]?.init?.method).toBe("POST")
})

test("artifacts.catalog returns a metadata-only cursor page for the session owner", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const client = Arforge.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      requests.push({ url, init })
      return new Response(
        JSON.stringify({
          entries: [
            {
              reference: {
                version: 1,
                artifactID: "art_catalog",
                kind: "tool_output",
                digest: "a".repeat(64),
                mime: "text/plain",
                sizeBytes: 4,
                owner: { scope: "session", id: "ses_test" },
                retention: { mode: "session" },
                retrievalHint: { kind: "managed", handle: "h_catalog" },
                createdAt: 1_717_171_717_000,
              },
              firstSeenAt: 1_717_171_717_000,
              lastSeenAt: 1_717_171_717_100,
              lastSequence: 8,
              readCount: 2,
            },
          ],
          nextSequence: 7,
          headSequence: 8,
          headHash: "b".repeat(64),
          droppedAuditEntries: 0,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    },
  })

  const page = await client.artifacts.catalog({ sessionID: "ses_test", limit: 2, beforeSequence: 9 })
  expect(page.entries[0]?.reference.artifactID).toBe("art_catalog")
  expect(page.entries[0]?.readCount).toBe(2)
  expect(requests[0]?.url).toBe("http://localhost:3000/api/session/ses_test/artifacts/catalog")
  expect(requests[0]?.init?.method).toBe("POST")
  const body = requests[0]?.init?.body
  if (typeof body !== "string") throw new Error("Expected JSON request body")
  expect(JSON.parse(body)).toEqual({ limit: 2, beforeSequence: 9 })
  expect(body).not.toContain("path")
})

test("artifacts.catalogScoped keeps profile and tenant owner selection explicit", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const client = Arforge.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      requests.push({ url, init })
      return new Response(
        JSON.stringify({ entries: [], headSequence: 0, headHash: "genesis", droppedAuditEntries: 0 }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    },
  })

  const page = await client.artifacts.catalogScoped({ owner: { scope: "profile", id: "usr_test" } })
  expect(page.entries).toEqual([])
  expect(requests[0]?.url).toBe("http://localhost:3000/api/artifacts/catalog")
  expect(requests[0]?.init?.method).toBe("POST")
  const body = requests[0]?.init?.body
  if (typeof body !== "string") throw new Error("Expected JSON request body")
  expect(JSON.parse(body)).toEqual({ owner: { scope: "profile", id: "usr_test" } })
})

test("artifacts.audit exposes bounded hash-chain records without local paths", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const client = Arforge.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      requests.push({ url, init })
      return new Response(
        JSON.stringify([
          {
            sequence: 4,
            recordedAt: 1_717_171_717_100,
            actor: "usr_test",
            action: "removed",
            artifactID: "art_catalog",
            digest: "a".repeat(64),
            owner: { scope: "session", id: "ses_test" },
            reason: "retention_expired",
            previousHash: "b".repeat(64),
            recordHash: "c".repeat(64),
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    },
  })

  const records = await client.artifacts.audit({ sessionID: "ses_test", limit: 20, beforeSequence: 10 })
  expect(records[0]?.action).toBe("removed")
  expect(records[0]?.reason).toBe("retention_expired")
  expect(requests[0]?.url).toBe("http://localhost:3000/api/session/ses_test/artifacts/audit")
  const body = requests[0]?.init?.body
  if (typeof body !== "string") throw new Error("Expected JSON request body")
  expect(JSON.parse(body)).toEqual({ limit: 20, beforeSequence: 10 })
  expect(body).not.toContain("path")
})

test("artifacts.auditScoped preserves the explicit profile or tenant owner", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const client = Arforge.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      requests.push({ url, init })
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } })
    },
  })

  expect(await client.artifacts.auditScoped({ owner: { scope: "tenant", id: "ten_test" } })).toEqual([])
  expect(requests[0]?.url).toBe("http://localhost:3000/api/artifacts/audit")
  const body = requests[0]?.init?.body
  if (typeof body !== "string") throw new Error("Expected JSON request body")
  expect(JSON.parse(body)).toEqual({ owner: { scope: "tenant", id: "ten_test" } })
})

test("artifacts range methods preserve byte offsets, ETags, and 206 responses", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const client = Arforge.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      requests.push({ url, init })
      return new Response(new Uint8Array([3, 4, 5]), {
        status: 206,
        headers: { "content-type": "application/octet-stream", etag: '"' + "a".repeat(64) + '"' },
      })
    },
  })
  const reference = {
    version: 1 as const,
    artifactID: "art_range",
    kind: "tool_output",
    digest: "a".repeat(64),
    mime: "application/octet-stream",
    sizeBytes: 10,
    owner: { scope: "session" as const, id: "ses_test" },
    retention: { mode: "session" as const },
    retrievalHint: { kind: "managed" as const, handle: "h_range" },
    createdAt: 1_717_171_717_000,
  }

  expect(
    await client.artifacts.readRange({
      sessionID: "ses_test",
      reference,
      offset: 2,
      length: 3,
      ifMatch: `"${reference.digest}"`,
    }),
  ).toEqual(new Uint8Array([3, 4, 5]))
  expect(
    await client.artifacts.readScopedRange({
      reference: { ...reference, owner: { scope: "profile", id: "usr_test" } },
      offset: 1,
      length: 3,
    }),
  ).toEqual(new Uint8Array([3, 4, 5]))
  expect(requests.map((request) => [request.init?.method, request.url])).toEqual([
    ["POST", "http://localhost:3000/api/session/ses_test/artifacts/read-range"],
    ["POST", "http://localhost:3000/api/artifacts/read-range"],
  ])
  const body = requests[0]?.init?.body
  if (typeof body !== "string") throw new Error("Expected JSON request body")
  expect(JSON.parse(body)).toMatchObject({ offset: 2, length: 3, ifMatch: `"${reference.digest}"` })
})

test("goal methods use the durable session-owned HTTP contract", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const client = Arforge.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      requests.push({ url, init })
      if (init?.method === "POST") return Response.json({ data: goal })
      return Response.json({ data: { active: goal, queued: [], history: [], items: [goal] } })
    },
  })

  const page = await client.goals.list({ sessionID: "ses_test", history: "false" })
  const created = await client.goals.create({ sessionID: "ses_test", objective: "Finish fusion" })

  expect(page.active?.id).toBe("gol_test")
  expect(created.objective).toBe("Finish fusion")
  expect(requests.map((request) => [request.init?.method, request.url])).toEqual([
    ["GET", "http://localhost:3000/api/session/ses_test/goal?history=false"],
    ["POST", "http://localhost:3000/api/session/ses_test/goal"],
  ])
  const body = requests[1]?.init?.body
  if (typeof body !== "string") throw new Error("Expected JSON request body")
  expect(JSON.parse(body)).toEqual({ objective: "Finish fusion" })
})

test("sessions.get returns the wire projection", async () => {
  const client = Arforge.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input) => {
      expect(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).toBe(
        "http://localhost:3000/api/session/ses_test",
      )
      return Response.json(session)
    },
  })

  const result = await client.sessions.get({ sessionID: "ses_test" })

  expect(result.time.created).toBe(1_717_171_717_000)
})

test("events.subscribe exposes the Promise event stream wire projection", async () => {
  const client = Arforge.make({
    baseUrl: "http://localhost:3000",
    fetch: async () =>
      new Response(
        `: heartbeat\n\ndata: ${JSON.stringify({ id: "evt_connected", type: "server.connected", data: {} })}\n\n` +
          `data: ${JSON.stringify(modelSwitchedEvent)}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
  })
  const events = []
  for await (const event of client.events.subscribe()) events.push(event)

  expect(events).toEqual([{ id: "evt_connected", type: "server.connected", data: {} }, modelSwitchedEvent])
  expect(events[1]?.type === "session.next.model.switched" && events[1].data.timestamp).toBe(1_717_171_717_000)
})

test("events.subscribe terminates on malformed Promise SSE data", async () => {
  const client = Arforge.make({
    baseUrl: "http://localhost:3000",
    fetch: async () => new Response("data: {not-json}\n\n", { headers: { "content-type": "text/event-stream" } }),
  })

  await expect(client.events.subscribe()[Symbol.asyncIterator]().next()).rejects.toMatchObject({
    name: "ClientError",
    reason: "MalformedResponse",
  })
})

test("session methods use the public HTTP contract", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  let historyPage = 0
  const client = Arforge.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      requests.push({ url, init })
      if (url.includes("/event")) {
        return new Response(`data: ${JSON.stringify(modelSwitchedEvent)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        })
      }
      if (url.includes("/history")) {
        historyPage++
        return Response.json(
          historyPage === 1 ? { data: [modelSwitchedEvent], hasMore: true } : { data: [], hasMore: false },
        )
      }
      if (url.includes("/prompt")) return Response.json(admission)
      if (url.includes("/context")) return Response.json({ data: [] })
      if (url.includes("/message/")) return Response.json({ data: modelSwitchedMessage })
      if (url.endsWith("/api/session/active")) return Response.json({ data: { ses_test: { type: "running" } } })
      if (init?.method === "POST" && url.endsWith("/api/session")) return Response.json(session)
      if (init?.method === "POST") return new Response(null, { status: 204 })
      return Response.json({ data: [session.data], cursor: { next: "next" } })
    },
  })

  const page = await client.sessions.list({ limit: 10, order: "desc" })
  const active = await client.sessions.active()
  const created = await client.sessions.create({ location: { directory: "/tmp/project" } })
  await client.sessions.switchAgent({ sessionID: "ses_test", agent: "build" })
  await client.sessions.switchModel({
    sessionID: "ses_test",
    model: { id: "claude", providerID: "anthropic" },
  })
  const admitted = await client.sessions.prompt({
    sessionID: "ses_test",
    prompt: { text: "Hello" },
    resume: false,
  })
  await client.sessions.compact({ sessionID: "ses_test" })
  await client.sessions.wait({ sessionID: "ses_test" })
  const context = await client.sessions.context({ sessionID: "ses_test" })
  const history = await client.sessions.history({ sessionID: "ses_test", after: 0, limit: 1 })
  const historyAfter = history.data.at(-1)?.durable?.seq
  const historyNext = history.hasMore
    ? await client.sessions.history({ sessionID: "ses_test", after: historyAfter, limit: 2 })
    : undefined
  const events = []
  for await (const event of client.sessions.events({ sessionID: "ses_test", after: 0 })) events.push(event)
  await client.sessions.interrupt({ sessionID: "ses_test" })
  const message = await client.sessions.message({ sessionID: "ses_test", messageID: "msg_model" })

  expect(page.cursor.next).toBe("next")
  expect(active).toEqual({ ses_test: { type: "running" } })
  expect(created.id).toBe("ses_test")
  expect(admitted.id).toBe("msg_test")
  expect(context).toEqual([])
  expect(history).toEqual({ data: [modelSwitchedEvent], hasMore: true })
  expect(historyNext).toEqual({ data: [], hasMore: false })
  expect(events).toEqual([modelSwitchedEvent])
  expect(message).toEqual(modelSwitchedMessage)
  expect(requests.map((request) => [request.init?.method, request.url])).toEqual([
    ["GET", "http://localhost:3000/api/session?limit=10&order=desc"],
    ["GET", "http://localhost:3000/api/session/active"],
    ["POST", "http://localhost:3000/api/session"],
    ["POST", "http://localhost:3000/api/session/ses_test/agent"],
    ["POST", "http://localhost:3000/api/session/ses_test/model"],
    ["POST", "http://localhost:3000/api/session/ses_test/prompt"],
    ["POST", "http://localhost:3000/api/session/ses_test/compact"],
    ["POST", "http://localhost:3000/api/session/ses_test/wait"],
    ["GET", "http://localhost:3000/api/session/ses_test/context"],
    ["GET", "http://localhost:3000/api/session/ses_test/history?limit=1&after=0"],
    ["GET", "http://localhost:3000/api/session/ses_test/history?limit=2&after=1"],
    ["GET", "http://localhost:3000/api/session/ses_test/event?after=0"],
    ["POST", "http://localhost:3000/api/session/ses_test/interrupt"],
    ["GET", "http://localhost:3000/api/session/ses_test/message/msg_model"],
  ])
  const body = requests.find((request) => request.url.endsWith("/api/session/ses_test/prompt"))?.init?.body
  if (typeof body !== "string") throw new Error("Expected JSON request body")
  expect(JSON.parse(body)).toEqual({
    prompt: { text: "Hello" },
    resume: false,
  })
})

test("middleware errors remain declared client errors", async () => {
  const client = Arforge.make({
    baseUrl: "http://localhost:3000",
    fetch: async () =>
      Response.json({ _tag: "UnauthorizedError", message: "Authentication required" }, { status: 401 }),
  })

  try {
    await client.sessions.create({})
    throw new Error("Expected request to fail")
  } catch (error) {
    expect(isUnauthorizedError(error)).toBe(true)
  }
})

test("sessions.history decodes SessionNotFoundError", async () => {
  const client = Arforge.make({
    baseUrl: "http://localhost:3000",
    fetch: async () =>
      Response.json(
        { _tag: "SessionNotFoundError", sessionID: "ses_missing", message: "Session not found" },
        { status: 404 },
      ),
  })

  try {
    await client.sessions.history({ sessionID: "ses_missing" })
    throw new Error("Expected request to fail")
  } catch (error) {
    expect(isSessionNotFoundError(error)).toBe(true)
  }
})

const session = {
  data: {
    id: "ses_test",
    projectID: "project",
    cost: 0,
    tokens: {
      input: 1,
      output: 2,
      reasoning: 3,
      cache: { read: 4, write: 5 },
    },
    time: {
      created: 1_717_171_717_000,
      updated: 1_717_171_717_000,
    },
    title: "Test",
    location: { directory: "/tmp/project" },
  },
}

const admission = {
  data: {
    admittedSeq: 0,
    id: "msg_test",
    sessionID: "ses_test",
    prompt: { text: "Hello" },
    delivery: "steer",
    timeCreated: 1_717_171_717_000,
  },
}

const goal = {
  id: "gol_test",
  sessionID: "ses_test",
  objective: "Finish fusion",
  status: "active",
  queuePosition: 0,
  revision: 1,
  lastError: "",
  time: {
    created: 1_717_171_717_000,
    updated: 1_717_171_717_000,
  },
}

const modelSwitchedMessage = {
  id: "msg_model",
  type: "model-switched",
  time: { created: 1_717_171_717_000 },
  model: { id: "claude", providerID: "anthropic" },
}

const modelSwitchedEvent = {
  id: "evt_model",
  type: "session.next.model.switched",
  durable: { aggregateID: "ses_test", seq: 1, version: 1 },
  data: {
    timestamp: 1_717_171_717_000,
    sessionID: "ses_test",
    messageID: "msg_model",
    model: { id: "claude", providerID: "anthropic" },
  },
}
