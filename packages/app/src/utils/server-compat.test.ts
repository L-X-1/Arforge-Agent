import { describe, expect, test } from "bun:test"
import { PromptInput } from "@arforge-ai/schema/prompt-input"
import { Schema } from "effect"
import { createApiForServer, createSdkForServer } from "./server"
import { createCompatibleApi } from "./server-compat"

function setup(
  protocol: "v1" | "v2" | Promise<"v1" | "v2">,
  responses?: {
    vcs?: { branch: string; default_branch: string }
    restoreUnavailable?: boolean
    promptError?: 400 | 409 | 503
  },
) {
  const requests: Request[] = []
  const fetcher = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      requests.push(request)
      const pathname = new URL(request.url).pathname
      if (responses?.restoreUnavailable && (pathname.includes("/revert") || pathname.includes("/unrevert"))) {
        return Response.json(
          {
            _tag: "ServiceUnavailableError",
            message: "Controlled restore is unavailable",
            service: "session.revert",
          },
          { status: 503 },
        )
      }
      if (request.method === "PATCH") {
        return Response.json({
          id: "ses_1",
          slug: "ses_1",
          projectID: "project",
          directory: "/repo",
          title: "Session",
          version: "1",
          time: { created: 1, updated: 1 },
        })
      }
      if (request.method === "POST" && request.url.endsWith("/prompt_async"))
        return new Response(undefined, { status: 204 })
      if (request.method === "POST" && request.url.endsWith("/prompt")) {
        if (responses?.promptError) {
          return Response.json({
            _tag: responses.promptError === 400 ? "InvalidRequestError"
              : responses.promptError === 409 ? "ConflictError" : "ServiceUnavailableError",
            message: "Prompt admission rejected",
          }, { status: responses.promptError })
        }
        const body = await request.clone().json()
        return Response.json({
          data: {
            admittedSeq: 7,
            id: body.id ?? "msg_server_generated",
            sessionID: "ses_1",
            timeCreated: 123,
            prompt: body.prompt,
            delivery: body.delivery ?? "steer",
          },
        })
      }
      if (request.method === "GET" && new URL(request.url).pathname === "/vcs")
        return Response.json(responses?.vcs ?? {})
      if (request.method === "GET") return Response.json([])
      return new Response(undefined, { status: 204 })
    },
    { preconnect: globalThis.fetch.preconnect },
  )
  const server = { url: "http://localhost:4096" }
  const api = createCompatibleApi({
    protocol: typeof protocol === "string" ? Promise.resolve(protocol) : protocol,
    current: createApiForServer({ server, fetch: fetcher }),
    legacy: (directory) => createSdkForServer({ server, fetch: fetcher, directory, throwOnError: true }),
    directory: "/repo",
  })
  return { api, requests }
}

describe("createCompatibleApi", () => {
  test("routes V1 archive through the legacy session update", async () => {
    const { api, requests } = setup("v1")
    await api.session.archive({ sessionID: "ses_1", directory: "/repo" })

    const url = new URL(requests[0]!.url)
    expect(url.pathname).toBe("/session/ses_1")
    expect(requests[0]!.headers.get("x-arforge-directory")).toBe("%2Frepo")
    expect(requests[0]!.method).toBe("PATCH")
    expect(await requests[0]!.json()).toMatchObject({ time: { archived: expect.any(Number) } })
  })

  test("converts current prompts to the V1 prompt contract", async () => {
    const { api, requests } = setup("v1")
    await api.session.prompt({
      sessionID: "ses_1",
      id: "msg_1",
      text: "hello @src/index.ts",
      system: "推理过程和思考摘要必须使用简体中文",
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
      files: [
        { uri: "file:///repo/src/index.ts", name: "index.ts", mention: { text: "@src/index.ts", start: 6, end: 19 } },
        { uri: "data:text/plain;base64,aGVsbG8=", name: "notes.txt" },
      ],
    })

    expect(new URL(requests[0]!.url).pathname).toBe("/session/ses_1/prompt_async")
    const body = await requests[0]!.json()
    expect(body).toMatchObject({
      messageID: "msg_1",
      system: "推理过程和思考摘要必须使用简体中文",
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
      parts: [
        { type: "text", text: "hello @src/index.ts" },
        {
          type: "file",
          mime: "text/plain",
          url: "file:///repo/src/index.ts",
          filename: "index.ts",
          source: {
            type: "file",
            text: { value: "@src/index.ts", start: 6, end: 19 },
            path: "file:///repo/src/index.ts",
          },
        },
        {
          type: "file",
          mime: "text/plain",
          url: "data:text/plain;base64,aGVsbG8=",
          filename: "notes.txt",
        },
      ],
    })
    expect(body.parts[2]).not.toHaveProperty("source")
  })

  test("preserves original parts for V1 optimistic reconciliation", async () => {
    const { api, requests } = setup("v1")
    await api.session.prompt({
      sessionID: "ses_1",
      id: "msg_1",
      text: "look",
      files: [{ uri: "data:image/png;base64,AAAA", name: "image.png" }],
      legacyParts: [
        { id: "prt_text", type: "text", text: "look" },
        { id: "prt_image", type: "file", mime: "image/png", url: "data:image/png;base64,AAAA", filename: "image.png" },
      ],
    })

    expect((await requests[0]!.json()).parts).toEqual([
      { id: "prt_text", type: "text", text: "look" },
      { id: "prt_image", type: "file", mime: "image/png", url: "data:image/png;base64,AAAA", filename: "image.png" },
    ])
  })

  test("keeps V2 session actions on the current API", async () => {
    const { api, requests } = setup("v2")
    await api.session.archive({ sessionID: "ses_1" })

    expect(new URL(requests[0]!.url).pathname).toBe("/api/session/ses_1/archive")
    expect(requests[0]!.method).toBe("POST")
  })

  test("sends V2 prompt data, frozen HTML references, and routing in the canonical envelope", async () => {
    const { api, requests } = setup("v2")
    const text = 'Change the selected heading.\r\n<html_selection_snapshot>\r\n&lt;h1&gt;Before&lt;/h1&gt;\r\n</html_selection_snapshot>'
    const receipt = await api.session.prompt({
      sessionID: "ses_1",
      id: "msg_frozen_html",
      text,
      agent: "build",
      model: { providerID: "test", modelID: "test-model" },
      variant: "high",
      system: "Keep the existing human approval boundary.",
      files: [{ uri: "file:///repo/example.html", name: "example.html", mention: { start: 0, end: 7, text: "example" } }],
      agents: [{ name: "review", mention: { start: 8, end: 15, text: "@review" } }],
      legacyParts: [
        { id: "prt_text", type: "text", text },
        { id: "prt_file", type: "file", mime: "text/html", url: "file:///repo/example.html", filename: "example.html" },
      ],
    })

    expect(requests).toHaveLength(1)
    expect(new URL(requests[0]!.url).pathname).toBe("/api/session/ses_1/prompt")
    const body = await requests[0]!.json()
    expect(body).toEqual({
      id: "msg_frozen_html",
      prompt: {
        text,
        files: [{ uri: "file:///repo/example.html", name: "example.html", mime: "text/html", source: { start: 0, end: 7, text: "example" } }],
        agents: [{ name: "review", source: { start: 8, end: 15, text: "@review" } }],
        system: { text: "Keep the existing human approval boundary.", source: "request", scope: "turn" },
        route: { agent: "build", model: { id: "test-model", providerID: "test", variant: "high" } },
      },
    })
    expect(Schema.decodeUnknownSync(PromptInput.Prompt)(body.prompt)).toEqual(body.prompt)
    expect(receipt).toEqual({
      admittedSeq: 7,
      id: "msg_frozen_html",
      sessionID: "ses_1",
      timeCreated: 123,
      type: "user",
      data: { text },
      delivery: "steer",
    })
  })

  test("preserves deferred V2 admission and does not invent a route or system prompt", async () => {
    const { api, requests } = setup("v2")
    await api.session.prompt({ sessionID: "ses_1", text: "later", delivery: "queue", resume: false })
    expect(await requests[0]!.json()).toEqual({ prompt: { text: "later" }, delivery: "queue", resume: false })
  })

  test("preserves V2 data-URI MIME types and file and agent mention ranges", async () => {
    const { api, requests } = setup("v2")
    await api.session.prompt({
      sessionID: "ses_1",
      text: "look",
      files: [
        { uri: "data:image/png;base64,AAAA", name: "image.png" },
        { uri: "file:///repo/notes.txt", mention: { start: 1, end: 4, text: "abc" } },
      ],
      agents: [{ name: "review" }],
    })
    expect((await requests[0]!.json()).prompt).toEqual({
      text: "look",
      files: [
        { uri: "data:image/png;base64,AAAA", name: "image.png", mime: "image/png" },
        { uri: "file:///repo/notes.txt", mime: "text/plain", source: { start: 1, end: 4, text: "abc" } },
      ],
      agents: [{ name: "review" }],
    })
  })

  test.each([400, 409, 503] as const)("does not retry rejected V2 admission through V1 (%s)", async (status) => {
    const { api, requests } = setup("v2", { promptError: status })
    await expect(api.session.prompt({ sessionID: "ses_1", id: "msg_1", text: "hello" })).rejects.toBeDefined()
    expect(requests).toHaveLength(1)
    expect(new URL(requests[0]!.url).pathname).toBe("/api/session/ses_1/prompt")
  })

  test("keeps authentication on the canonical V2 prompt transport", async () => {
    const requests: Request[] = []
    const fetcher = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      requests.push(request)
      const body = await request.clone().json()
      return Response.json({ data: {
        admittedSeq: 9, id: "msg_authenticated", sessionID: "ses_1", timeCreated: 456,
        prompt: body.prompt, delivery: "steer",
      } })
    }, { preconnect: globalThis.fetch.preconnect })
    const api = createApiForServer({
      server: { url: "http://localhost:4096", username: "test-user", password: "test-only-password" },
      fetch: fetcher,
    })
    const result = await api.session.prompt({ sessionID: "ses_1", text: "hello" })
    expect(requests[0]!.headers.get("Authorization")).toBe(`Basic ${btoa("test-user:test-only-password")}`)
    expect(requests[0]!.headers.get("content-type")).toContain("application/json")
    expect(result.id).toBe("msg_authenticated")
    expect(result.admittedSeq).toBe(9)
  })

  test("does not fabricate revert success when the V1 desktop adapter receives typed fail-closed", async () => {
    const { api, requests } = setup("v1", { restoreUnavailable: true })

    await expect(api.session.revert.stage({ sessionID: "ses_1", messageID: "msg_1" })).rejects.toBeDefined()
    await expect(api.session.revert.clear({ sessionID: "ses_1" })).rejects.toBeDefined()
    await expect(api.session.revert.commit({ sessionID: "ses_1" })).rejects.toBeDefined()

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/session/ses_1/revert",
      "/session/ses_1/unrevert",
      "/api/session/ses_1/revert/commit",
    ])
  })

  test("keeps typed fail-closed on the V2 desktop adapter", async () => {
    const { api, requests } = setup("v2", { restoreUnavailable: true })

    await expect(api.session.revert.stage({ sessionID: "ses_1", messageID: "msg_1" })).rejects.toBeDefined()
    await expect(api.session.revert.clear({ sessionID: "ses_1" })).rejects.toBeDefined()
    await expect(api.session.revert.commit({ sessionID: "ses_1" })).rejects.toBeDefined()

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/session/ses_1/revert/stage",
      "/api/session/ses_1/revert/clear",
      "/api/session/ses_1/revert/commit",
    ])
  })

  test("preserves the stable direct-Shell message identity through the V1 adapter", async () => {
    const { api, requests } = setup("v1")
    await api.session.shell({
      sessionID: "ses_1",
      messageID: "msg_direct_shell_stable",
      command: "node -e \"process.stdout.write('safe')\"",
      agent: "build",
    })

    expect(new URL(requests[0]!.url).pathname).toBe("/session/ses_1/shell")
    expect(await requests[0]!.json()).toMatchObject({
      messageID: "msg_direct_shell_stable",
      command: "node -e \"process.stdout.write('safe')\"",
      agent: "build",
    })
  })

  test("resolves protocol detection once across implementation methods", async () => {
    let detections = 0
    const resolved = Promise.resolve<"v1" | "v2">("v2")
    const protocol = new Proxy(resolved, {
      get(target, property) {
        if (property !== "then") return Reflect.get(target, property, target)
        detections++
        return target.then.bind(target)
      },
    })
    const { api } = setup(protocol)

    await api.session.archive({ sessionID: "ses_1" })
    await api.session.list()

    expect(detections).toBe(1)
  })

  test("uses the global V1 session search endpoint", async () => {
    const { api, requests } = setup("v1")
    await api.session.list({ parentID: null, search: "session", limit: 50 })

    expect(new URL(requests[0]!.url).pathname).toBe("/experimental/session")
  })

  test("projects the V1 default branch", async () => {
    const { api } = setup("v1", { vcs: { branch: "feature", default_branch: "dev" } })

    expect(await api.vcs.get({ location: { directory: "/repo" } })).toMatchObject({
      data: { branch: "feature", defaultBranch: "dev" },
    })
  })

  test("translates current file searches to the V1 dirs parameter", async () => {
    const { api, requests } = setup("v1")
    await api.file.find({ location: { directory: "/repo" }, query: "src", type: "file", limit: 20 })

    const url = new URL(requests[0]!.url)
    expect(url.pathname).toBe("/find/file")
    expect(url.searchParams.get("dirs")).toBe("false")
    expect(url.searchParams.get("limit")).toBe("20")
  })

  test("routes V1 permission replies through the unified permission bridge", async () => {
    const { api, requests } = setup("v1")
    await api.permission.reply({
      sessionID: "ses_1",
      requestID: "permission_1",
      reply: "once",
      location: { directory: "/other" },
    })

    expect(new URL(requests[0]!.url).pathname).toBe("/permission/permission_1/reply")
    expect(new URL(requests[0]!.url).searchParams.get("directory")).toBe("/other")
    expect(await requests[0]!.json()).toEqual({ reply: "once" })
  })
})
