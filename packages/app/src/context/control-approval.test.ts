import { describe, expect, test } from "bun:test"
import type { AgentRuntimeControlRequest } from "@arforge-ai/sdk/v2/client"
import { createRoot } from "solid-js"
import {
  controlApprovalDOMID,
  controlApprovalKey,
  controlApprovalRouteLocation,
  createControlApprovalState,
  knownControlAction,
  parseControlApprovalEvent,
  SAFE_CONTROL_ACTIONS,
  safeControlMetadataDetails,
  safeControlResourceKinds,
  safeControlServerLabel,
  type ControlApprovalReceipt,
  type ControlApprovalBinding,
  type ControlApprovalEnvelope,
  type ControlApprovalTransport,
} from "./control-approval"
import { ServerConnection } from "./server"

const directory = "C:/workspace/arforge"
const secondDirectory = "C:/workspace/arforge-second"

const defaultSubject = {
  type: "control-plane",
  id: "ctl_1",
  location: directory,
  project: "prj_1",
  actor: "user",
  principalRef: "prn_1",
  requestID: "cpr_1",
} satisfies AgentRuntimeControlRequest["subject"]

const request = (
  input: Partial<AgentRuntimeControlRequest> & { id: string } = { id: "apr_1" },
): AgentRuntimeControlRequest => ({
  id: input.id,
  action: input.action ?? "worktree.remove",
  resources: input.resources ?? ["filesystem:C:/workspace/arforge/.worktrees/demo", "git:worktree-remove"],
  metadata: input.metadata ?? { reason: "Removing this worktree deletes its files and branch." },
  subject: input.subject ?? defaultSubject,
})

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function harness(
  input: {
    list?: (directory: string) => Promise<readonly AgentRuntimeControlRequest[]>
    reply?: (directory: string, requestID: string, reply: "once" | "reject") => Promise<void>
    bindings?: readonly ControlApprovalBinding[]
    serverKey?: ServerConnection.Key
    onReceipt?: (receipt: ControlApprovalReceipt) => void
  } = {},
) {
  let eventListener: ((event: ControlApprovalEnvelope) => void) | undefined
  const replies: Array<{ directory: string; requestID: string; reply: "once" | "reject" }> = []
  const listCalls: string[] = []
  const transport: ControlApprovalTransport = {
    list: async (nextDirectory) => {
      listCalls.push(nextDirectory)
      return input.list?.(nextDirectory) ?? []
    },
    reply: async (nextDirectory, requestID, reply) => {
      replies.push({ directory: nextDirectory, requestID, reply })
      await input.reply?.(nextDirectory, requestID, reply)
    },
    subscribe(listener) {
      eventListener = listener
      return () => {
        eventListener = undefined
      }
    },
  }

  let dispose: () => void = () => {}
  const state = createRoot((cleanup) => {
    dispose = cleanup
    return createControlApprovalState({
      serverKey: input.serverKey ?? ServerConnection.Key.make("sidecar"),
      onReceipt: input.onReceipt,
      bindings: () => input.bindings ?? [{ project: defaultSubject.project, location: directory }],
      transport,
    })
  })

  return {
    state,
    replies,
    listCalls,
    emit(details: unknown, name = directory) {
      eventListener?.({ name, details })
    },
    dispose,
  }
}

describe("control approval state", () => {
  test("derives only an absolute workspace directory from a desktop deep link", () => {
    const encoded = btoa(directory).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
    expect(controlApprovalRouteLocation(`/${encoded}/session/ses_1`)).toBe(directory)
    expect(controlApprovalRouteLocation("/settings")).toBeUndefined()
    expect(controlApprovalRouteLocation(`/${btoa("relative/path")}/session/ses_1`)).toBeUndefined()
  })

  test("recognizes every server-backed action and resource category while failing closed for unknown values", () => {
    expect(SAFE_CONTROL_ACTIONS.map(knownControlAction)).toEqual([...SAFE_CONTROL_ACTIONS])
    expect(knownControlAction("plugin.execute")).toBeUndefined()

    expect(
      safeControlResourceKinds([
        "skill:writer",
        "plugin:publisher",
        "recovery:receipt-1",
        "session:ses_1",
        "session-event:ses_1@4",
        "project:prj_1",
        "project-registry:prj_1",
        "process:repository-configured-git-filter",
        "git-head:abc123",
        "git-index:index-1",
        "git-dirty:dirty-1",
        "snapshot:rev-1",
        "share-endpoint:https://share.invalid",
        "share-publication:pub_1",
        "organization:org_1",
        "evolution:candidate-1",
      ]),
    ).toEqual({
      kinds: [
        "skill",
        "plugin",
        "recovery",
        "session",
        "project",
        "process",
        "gitMetadata",
        "snapshot",
        "sharing",
        "organization",
        "evolution",
      ],
      unavailable: false,
    })
    expect(safeControlResourceKinds(["network:unreviewed"])).toEqual({ kinds: [], unavailable: true })
  })

  test("keeps raw action, resources, reasons, and metadata out of the safe presentation helpers", () => {
    const hostileResource = "filesystem:C:/workspace?token=sk-live-secret"
    const hostileReason = "https://user:password@example.test/path?token=sk-live-secret"
    const hostileMetadata = "postgres://user:password@example.test/db?token=sk-live-secret"
    const resourceDetails = safeControlResourceKinds([hostileResource, "custom:api-key=sk-live-secret"])
    const metadataDetails = safeControlMetadataDetails({
      reason: hostileReason,
      connection: hostileMetadata,
      riskTier: "critical",
      policyVersion: "policy-v3",
      apiToken: "sk-live-secret",
    })
    const presentation = JSON.stringify({
      action: knownControlAction("unknown.action"),
      resources: resourceDetails,
      metadata: metadataDetails,
    })

    expect(resourceDetails).toEqual({ kinds: ["filesystem"], unavailable: true })
    expect(metadataDetails).toEqual([
      { field: "riskTier", value: "critical" },
      { field: "policyVersion", value: "policy-v3" },
    ])
    expect(presentation).not.toContain(hostileResource)
    expect(presentation).not.toContain(hostileReason)
    expect(presentation).not.toContain(hostileMetadata)
    expect(presentation).not.toContain("sk-live-secret")
  })

  test("restores server-backed pending approvals on startup", async () => {
    const pending = request({ id: "apr_startup" })
    const app = harness({ list: async () => [pending] })

    await flush()

    expect(app.listCalls).toEqual([directory])
    expect(app.state.items()).toHaveLength(1)
    expect(app.state.items()[0]?.id).toBe("apr_startup")
    app.dispose()
  })

  test("restores a server-verified approval when a deep link knows the directory before project metadata", async () => {
    const pending = request({ id: "apr_directory_first" })
    const app = harness({ bindings: [{ location: directory }], list: async () => [pending] })

    await flush()

    expect(app.listCalls).toEqual([directory])
    expect(app.state.items().map((item) => item.id)).toEqual(["apr_directory_first"])
    app.dispose()
  })

  test("retries startup restoration after the local control principal initially returns an empty list", async () => {
    const pending = request({ id: "apr_startup_retry" })
    let attempts = 0
    const app = harness({
      bindings: [{ location: directory }],
      list: async () => (++attempts === 1 ? [] : [pending]),
    })

    await new Promise((resolve) => setTimeout(resolve, 650))

    expect(attempts).toBeGreaterThanOrEqual(2)
    expect(app.state.items().map((item) => item.id)).toEqual(["apr_startup_retry"])
    app.dispose()
  })

  test("refreshes a verified asked event from the server list, removes a verified reply, and de-duplicates replays", async () => {
    const pending = request({ id: "apr_event" })
    const listed: AgentRuntimeControlRequest[] = []
    const app = harness({ list: async () => listed })
    await flush()

    listed.push(pending)
    app.emit({ type: "authorizer.control.asked", properties: pending })
    app.emit({ type: "authorizer.control.asked", properties: pending })
    await flush()
    expect(app.state.items()).toHaveLength(1)
    expect(app.state.items()[0]?.id).toBe("apr_event")

    listed.splice(0)
    app.emit({
      type: "authorizer.control.replied",
      properties: { subject: pending.subject, requestID: pending.id },
    })
    await flush()
    expect(app.state.items()).toEqual([])
    app.dispose()
  })

  test("sends only an exact one-time approval or rejection to the real-compatible reply channel", async () => {
    const first = request({ id: "apr_once" })
    const second = request({
      id: "apr_reject",
      subject: { ...first.subject, location: secondDirectory, project: "prj_2", requestID: "cpr_2" },
    })
    const app = harness({
      bindings: [
        { project: first.subject.project, location: first.subject.location },
        { project: second.subject.project, location: second.subject.location },
      ],
      list: async (nextDirectory) => (nextDirectory === directory ? [first] : [second]),
    })
    await flush()

    await app.state.reply(app.state.items().find((item) => item.id === "apr_once")!, "once")
    await app.state.reply(app.state.items().find((item) => item.id === "apr_reject")!, "reject")

    expect(app.replies).toEqual([
      { directory, requestID: "apr_once", reply: "once" },
      { directory: secondDirectory, requestID: "apr_reject", reply: "reject" },
    ])
    expect(app.state.items()).toEqual([])
    app.dispose()
  })

  test("keeps matching request IDs isolated by canonical server, project, and location", async () => {
    const first = request({ id: "apr_shared" })
    const second = request({
      id: "apr_shared",
      subject: { ...first.subject, location: secondDirectory, project: "prj_2", requestID: "cpr_2" },
    })
    let firstPending = true
    const app = harness({
      bindings: [
        { project: first.subject.project, location: first.subject.location },
        { project: second.subject.project, location: second.subject.location },
      ],
      list: async (nextDirectory) => (nextDirectory === directory ? (firstPending ? [first] : []) : [second]),
    })
    await flush()

    firstPending = false
    app.emit(
      { type: "authorizer.control.replied", properties: { subject: first.subject, requestID: first.id } },
      directory,
    )
    await flush()

    expect(app.state.items()).toHaveLength(1)
    expect(app.state.items()[0]?.subject.project).toBe("prj_2")
    expect(app.state.items()[0]?.subject.location).toBe(secondDirectory)
    app.dispose()
  })

  test("never auto-replies, and retains a failed request with loading and an actionable error", async () => {
    const pending = request({ id: "apr_retry" })
    let fail: ((error: Error) => void) | undefined
    const app = harness({
      list: async () => [pending],
      reply: () =>
        new Promise<void>((_, reject) => {
          fail = reject
        }),
    })
    await flush()

    expect(app.replies).toEqual([])
    const sending = app.state.reply(app.state.items()[0]!, "reject")
    expect(app.state.busy(app.state.items()[0]!)).toBe(true)
    fail?.(new Error("The server is unavailable."))
    await sending

    expect(app.replies).toEqual([{ directory, requestID: "apr_retry", reply: "reject" }])
    expect(app.state.items()).toHaveLength(1)
    expect(app.state.busy(app.state.items()[0]!)).toBe(false)
    expect(app.state.error(app.state.items()[0]!)).toBe("The server is unavailable.")
    app.dispose()
  })

  test("does not upsert raw events, mismatched directories, or unknown project bindings", async () => {
    const pending = request({ id: "apr_verified" })
    const listed: AgentRuntimeControlRequest[] = []
    const app = harness({ list: async () => listed })
    await flush()
    const startupCalls = app.listCalls.length

    const malformed: unknown = {
      type: "authorizer.control.asked",
      properties: { ...pending, action: "worktree.remove\u0000hidden" },
    }
    app.emit(malformed)
    app.emit({ type: "authorizer.control.asked", properties: pending }, secondDirectory)
    app.emit({
      type: "authorizer.control.asked",
      properties: { ...pending, subject: { ...pending.subject, project: "prj_unknown" } },
    })
    await flush()

    expect(app.state.items()).toEqual([])
    expect(app.listCalls).toHaveLength(startupCalls)
    app.dispose()
  })

  test("does not hide a pending request from an untrusted replied event", async () => {
    const pending = request({ id: "apr_still_pending" })
    const app = harness({ list: async () => [pending] })
    await flush()

    app.emit({
      type: "authorizer.control.replied",
      properties: { subject: pending.subject, requestID: pending.id },
    })
    await flush()

    expect(app.state.items()).toHaveLength(1)
    expect(app.state.items()[0]?.id).toBe(pending.id)
    app.dispose()
  })

  test("rejects NUL and oversized event identifiers before they can enter state", () => {
    const malformedNul: unknown = {
      type: "authorizer.control.asked",
      properties: { ...request(), id: "apr_\u0000hidden" },
    }
    const oversized: unknown = {
      type: "authorizer.control.asked",
      properties: { ...request(), subject: { ...defaultSubject, location: "x".repeat(1_025) } },
    }

    expect(parseControlApprovalEvent(malformedNul)).toBeUndefined()
    expect(parseControlApprovalEvent(oversized)).toBeUndefined()
  })

  test("uses a base64url aria identifier rather than the NUL-delimited approval key", () => {
    const key = controlApprovalKey(request({ id: "apr_aria" }))
    expect(key).toBeDefined()
    const ariaID = controlApprovalDOMID(key!)

    expect(ariaID).toMatch(/^control-approval-[A-Za-z0-9_-]+$/)
    expect(ariaID).not.toContain("\u0000")
    expect(ariaID).not.toContain(directory)
  })
})

function deferredApproval<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe("control approval ordering and independent receipts", () => {
  test("an old list cannot resurrect a confirmed approval, even without a replied event", async () => {
    const oldList = deferredApproval<readonly AgentRuntimeControlRequest[]>()
    let calls = 0
    const h = harness({ list: async () => ++calls === 1 ? [request()] : oldList.promise })
    try {
      await flush()
      const item = h.state.items()[0]!
      const pending = h.state.refresh()
      expect(await h.state.reply(item, "once")).toBe(true)
      oldList.resolve([request()])
      await pending
      expect(h.state.items()).toEqual([])
      expect(h.state.loading()).toBe(false)
      expect(h.state.receipts()[0]?.status).toBe("confirmed")
      await h.state.refresh()
      expect(h.state.items()).toEqual([])
    } finally { h.dispose() }
  })

  test("overlapping lists cannot reintroduce a card removed by a newer list", async () => {
    const oldList = deferredApproval<readonly AgentRuntimeControlRequest[]>()
    const newList = deferredApproval<readonly AgentRuntimeControlRequest[]>()
    let calls = 0
    const h = harness({ list: async () => ++calls === 1 ? [request()] : calls === 2 ? oldList.promise : newList.promise })
    try {
      await flush()
      const first = h.state.refresh()
      const second = h.state.refresh()
      newList.resolve([])
      await second
      oldList.resolve([request()])
      await first
      expect(h.state.items()).toEqual([])
      expect(h.state.loading()).toBe(false)
    } finally { h.dispose() }
  })

  test("authoritative card removal before HTTP failure does not hide the failure receipt", async () => {
    let listed: readonly AgentRuntimeControlRequest[] = [request()]
    const reply = deferredApproval<void>()
    const h = harness({ list: async () => listed, reply: () => reply.promise })
    try {
      await flush()
      const item = h.state.items()[0]!
      const pending = h.state.reply(item, "reject")
      listed = []
      h.emit({ type: "authorizer.control.replied", properties: { subject: item.subject, requestID: item.id } })
      await flush()
      expect(h.state.items()).toEqual([])
      expect(h.state.busy(item)).toBe(true)
      reply.reject(new Error("reply denied"))
      expect(await pending).toBe(false)
      const receipt = h.state.receipts()[0]!
      expect(receipt.status).toBe("failed")
      expect(receipt.error).toBe("reply denied")
      expect(receipt.requestID).toBe(item.id)
      expect(receipt.project).toBe(defaultSubject.project)
      expect(receipt.location).toBe(directory)
      expect(receipt.sourceID).toBe(item.sourceID!)
    } finally { h.dispose() }
  })

  test("out-of-order replies retain separate success and failure with the user's own decision", async () => {
    const first = deferredApproval<void>(), second = deferredApproval<void>()
    const h = harness({
      list: async () => [request({ id: "apr_1" }), request({ id: "apr_2" })],
      reply: (_directory, id) => id === "apr_1" ? first.promise : second.promise,
    })
    try {
      await flush()
      const one = h.state.items().find((item) => item.id === "apr_1")!
      const two = h.state.items().find((item) => item.id === "apr_2")!
      const firstReply = h.state.reply(one, "once")
      const secondReply = h.state.reply(two, "reject")
      second.reject(new Error("not confirmed"))
      await secondReply
      first.resolve()
      await firstReply
      expect(h.state.receipts().map((receipt) => [receipt.requestID, receipt.reply, receipt.status])).toEqual([
        ["apr_1", "once", "confirmed"], ["apr_2", "reject", "failed"],
      ])
      expect(h.state.items().map((item) => item.id)).toEqual(["apr_2"])
    } finally { h.dispose() }
  })

  test("a replacement instance cannot process a card from the old instance", async () => {
    const first = harness({ list: async () => [request()] })
    const second = harness({ list: async () => [request()] })
    try {
      await flush()
      expect(first.state.sourceID).not.toBe(second.state.sourceID)
      expect(await second.state.reply(first.state.items()[0]!, "once")).toBe(false)
      expect(second.replies).toEqual([])
      expect(await first.state.reply(first.state.items()[0]!, "reject")).toBe(true)
      expect(first.replies).toHaveLength(1)
    } finally { first.dispose(); second.dispose() }
  })

  test("two source servers with matching request IDs retain isolated receipts", async () => {
    const first = harness({ serverKey: ServerConnection.Key.make("sidecar"), list: async () => [request()] })
    const second = harness({ serverKey: ServerConnection.Key.make("http://localhost:4096"), list: async () => [request()] })
    try {
      await flush()
      await first.state.reply(first.state.items()[0]!, "once")
      expect(second.state.items()).toHaveLength(1)
      await second.state.reply(second.state.items()[0]!, "reject")
      expect(first.state.receipts()[0]?.server).toBe("sidecar")
      expect(second.state.receipts()[0]?.server).toBe("http://localhost:4096")
      expect(first.state.receipts()[0]?.reply).toBe("once")
      expect(second.state.receipts()[0]?.reply).toBe("reject")
    } finally { first.dispose(); second.dispose() }
  })

  test("in-flight receipts survive source disposal in the independent receipt sink", async () => {
    const reply = deferredApproval<void>()
    const receipts: ControlApprovalReceipt[] = []
    const h = harness({ list: async () => [request()], reply: () => reply.promise, onReceipt: (item) => receipts.push(item) })
    await flush()
    const operation = h.state.reply(h.state.items()[0]!, "once")
    h.dispose()
    reply.reject(new Error("source connection lost"))
    expect(await operation).toBe(false)
    expect(receipts.map((item) => item.status)).toEqual(["pending", "failed"])
    expect(receipts[0]?.sourceID).toBe(receipts[1]?.sourceID)
  })

  test("duplicate clicks while HTTP is pending never send a second reply", async () => {
    const reply = deferredApproval<void>()
    const h = harness({ list: async () => [request()], reply: () => reply.promise })
    try {
      await flush()
      const item = h.state.items()[0]!
      const pending = h.state.reply(item, "once")
      expect(await h.state.reply(item, "reject")).toBe(false)
      expect(h.replies).toHaveLength(1)
      reply.resolve()
      await pending
    } finally { h.dispose() }
  })

  test("connection and error receipts redact credentials rather than transport details", async () => {
    expect(safeControlServerLabel("https://user:secret@example.test:443/private?token=secret")).toBe("https://example.test")
    const h = harness({
      list: async () => [request()],
      reply: async () => { throw new Error("Authorization: Bearer secret") },
    })
    try {
      await flush()
      await h.state.reply(h.state.items()[0]!, "once")
      expect(h.state.receipts()[0]?.status).toBe("failed")
      expect(h.state.receipts()[0]?.error).not.toContain("secret")
      expect(h.state.receipts()[0]?.error).not.toContain("Bearer")
    } finally { h.dispose() }
  })
})
