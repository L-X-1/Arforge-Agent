import { describe, expect, test } from "bun:test"
import { contextReadRevision, createContextPreviewController, type ContextPreviewSnapshot, type ContextPreviewState } from "./session-context-preview"

const snapshot = (revision = "v1"): ContextPreviewSnapshot => ({
  sessionID: "ses_owned", directory: "C:/isolated/context", projectID: "project", updatedAt: 1,
  revision, sampledAt: 2, candidates: [{ id: "msg_real", type: "user", createdAt: 1 }], contextJSON: '[{"id":"msg_real"}]',
})
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

describe("context preview owner", () => {
  test("only reads on open/cancel and rechecks exact evidence before original compact; admission is not completion", async () => {
    let reads = 0, writes = 0
    let state: ContextPreviewState = { phase: "closed" }
    const controller = createContextPreviewController({
      capture: () => ({ key: "A", isCurrent: () => true, read: async () => { reads++; return snapshot() }, compact: async () => { writes++ } }),
      update: next => { state = next },
    })
    await controller.open(); expect(reads).toBe(1); expect(writes).toBe(0)
    controller.close(); expect(writes).toBe(0)
    await controller.open(); await controller.confirm()
    expect(reads).toBe(3); expect(writes).toBe(1); expect(state.phase).toBe("admitted")
    await controller.confirm(); expect(writes).toBe(1)
  })
  test("same IDs with changed content revision invalidate the preview without writing", async () => {
    let reads = 0, writes = 0
    let state: ContextPreviewState = { phase: "closed" }
    const controller = createContextPreviewController({ capture: () => ({ key: "A", isCurrent: () => true,
      read: async () => snapshot(++reads === 1 ? "v1" : "v2"), compact: async () => { writes++ } }), update: next => { state = next } })
    await controller.open(); await controller.confirm()
    expect(state.phase).toBe("stale"); expect(state.snapshot).toBeUndefined(); expect(writes).toBe(0)
  })
  for (const phase of ["read", "confirm"] as const) test(`server/session/model A→B→A invalidation drops late ${phase} and prevents compact`, async () => {
    const pending = deferred<ContextPreviewSnapshot>(); let reads = 0, writes = 0
    let state: ContextPreviewState = { phase: "closed" }
    const controller = createContextPreviewController({ capture: () => ({ key: "A", isCurrent: () => true,
      read: async () => ++reads === (phase === "read" ? 1 : 2) ? pending.promise : snapshot(), compact: async () => { writes++ } }), update: next => { state = next } })
    const open = controller.open()
    if (phase === "confirm") await open
    const action = phase === "read" ? open : controller.confirm()
    controller.invalidate(); pending.resolve(snapshot()); await action
    expect(state.phase).toBe("stale"); expect(state.snapshot).toBeUndefined(); expect(writes).toBe(0)
  })
  test("real unsupported/error response stays failure with retained evidence; retry must reread", async () => {
    let reads = 0, writes = 0; let state: ContextPreviewState = { phase: "closed" }
    const controller = createContextPreviewController({ capture: () => ({ key: "A", isCurrent: () => true,
      read: async () => { reads++; return snapshot() }, compact: async () => { writes++; throw new Error("compact unavailable503") } }), update: next => { state = next } })
    await controller.open(); await controller.confirm()
    expect(state.phase).toBe("error"); expect(String(state.error)).toContain("503"); expect(state.snapshot?.revision).toBe("v1")
    await controller.confirm(); expect(reads).toBe(3); expect(writes).toBe(2); expect(state.phase).toBe("error")
  })
  test("content digest detects same-length edits and source changes", async () => {
    expect(await contextReadRevision({ id: "same", text: "abc" })).not.toBe(await contextReadRevision({ id: "same", text: "xyz" }))
    expect(await contextReadRevision({ directory: "A" })).not.toBe(await contextReadRevision({ directory: "B" }))
  })
  test("an identical display fingerprint cannot hide changed exact context bytes", async () => {
    let reads = 0, writes = 0; let state: ContextPreviewState = { phase: "closed" }
    const controller = createContextPreviewController({ capture: () => ({ key: "A", isCurrent: () => true,
      read: async () => ({ ...snapshot("same-display-fingerprint"), contextJSON: ++reads === 1 ? "original" : "changed!" }),
      compact: async () => { writes++ } }), update: next => { state = next } })
    await controller.open(); await controller.confirm()
    expect(state.phase).toBe("stale"); expect(writes).toBe(0)
  })
})
