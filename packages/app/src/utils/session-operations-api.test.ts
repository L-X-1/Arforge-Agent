import { expect, test } from "bun:test"
import { createApiForServer } from "./server"
import { createCompatibleApi } from "./server-compat"
import { createSdkForServer } from "./server"

test("actual current App adapter retains Shell identity and route and accepts empty compact 204", async () => {
  const requests: Request[] = []
  const fetcher = Object.assign(async (url: string | URL | Request, init?: RequestInit) => {
    const request = new Request(url, init)
    requests.push(request)
    if (new URL(request.url).pathname.endsWith("/command")) return Response.json({ data: {
      admittedSeq: 9, id: "msg_command", sessionID: "ses_current", timeCreated: 123, delivery: "queue", prompt: { text: "Resolved command" },
    } })
    return new Response(null, { status: 204 })
  }, { preconnect() {} })
  const server = { url: "http://fixture.invalid", username: "fixture", password: "fixture-password" }
  const api = createCompatibleApi({ protocol: Promise.resolve("v2"), current: createApiForServer({ server, fetch: fetcher }), legacy: () => createSdkForServer({ server, fetch: fetcher }) })
  await api.session.shell({ sessionID: "ses_current", messageID: "msg_stable", command: "NOT_EXECUTED", agent: "review", model: { providerID: "fixture", modelID: "model" } })
  const command = await api.session.command({ sessionID: "ses_current", id: "msg_command", command: "review", arguments: "file.ts", agent: "review", model: { providerID: "fixture", id: "model", variant: "deep" }, delivery: "queue", files: [{ uri: "data:image/png;base64,fixture", name: "fixture.png" }] })
  const compact = await api.session.compact({ sessionID: "ses_current", model: { providerID: "fixture", modelID: "model", variant: "deep" }, expectedContext: "[]", expectedDirectory: "E:/fixture" })
  expect(command).toMatchObject({ admittedSeq: 9, data: { text: "Resolved command" }, delivery: "queue" })
  expect(compact).toBeUndefined()
  expect(await requests[0].json()).toEqual({ id: "msg_stable", command: "NOT_EXECUTED", agent: "review", model: { providerID: "fixture", id: "model" } })
  expect(await requests[1].json()).toMatchObject({ id: "msg_command", command: "review", arguments: "file.ts", model: { variant: "deep" }, files: [{ name: "fixture.png" }], delivery: "queue" })
  expect(await requests[2].json()).toEqual({ model: { providerID: "fixture", id: "model", variant: "deep" }, expectedContext: "[]", expectedDirectory: "E:/fixture" })
  expect(requests.every(request => request.headers.get("authorization")?.startsWith("Basic "))).toBe(true)
})

test("current compact App adapter retains typed failures instead of returning a completion receipt", async () => {
  for (const [status, body] of [
    [409, { _tag: "ConflictError", resource: "session.compact", message: "Stale context" }],
    [503, { _tag: "ServiceUnavailableError", service: "session.compact", message: "Summary failed" }],
  ] as const) {
    const api = createApiForServer({ server: { url: "http://fixture.invalid" }, fetch: Object.assign(async () => Response.json(body, { status }), { preconnect() {} }) })
    const error = await api.session.compact({ sessionID: "ses_current" }).then(() => undefined, error => error)
    expect(error).toMatchObject(body)
  }
})
