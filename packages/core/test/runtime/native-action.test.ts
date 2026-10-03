import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "bun:test"
import {
  createFileNativeActionJournal,
  createMemoryNativeActionJournal,
  createNativeActionRequest,
  createNativeActionRuntime,
  NativeActionAlreadySettledError,
  NativeActionKind,
  NativeActionRecoveryRequiredError,
} from "@arforge-ai/core/runtime/native-action"
import type { NativeActionReceipt } from "@arforge-ai/core/runtime/native-action"

const captureError = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  )

describe("NativeAction runtime", () => {
  it("validates typed main-process input and settles with action/trace identity", async () => {
    const journal = createMemoryNativeActionJournal()
    const runtime = createNativeActionRuntime({
      journal,
      now: (() => {
        let current = 100
        return () => current++
      })(),
    })
    const request = createNativeActionRequest({
      senderID: 7,
      kind: NativeActionKind.filesystem,
      name: "store-set",
      payload: { name: "settings", key: "theme", value: "dark" },
    })

    let calls = 0
    const result = await runtime.execute(request, (capability) => {
      calls += 1
      expect(capability).toBeObject()
      return undefined
    })

    expect(result.receipt).toMatchObject({
      actionID: request.actionID,
      traceID: request.traceID,
      senderID: 7,
      kind: "filesystem",
      name: "store-set",
      state: "settled",
      observationStatus: "succeeded",
    })
    expect(calls).toBe(1)
    expect((await journal.load()).at(-1)?.state).toBe("settled")

    expect(await captureError(runtime.execute(request, () => undefined))).toBeInstanceOf(
      NativeActionAlreadySettledError,
    )
    expect(calls).toBe(1)
  })

  it("does not persist payload or secret material in the native journal", async () => {
    const secret = "native-secret-that-must-not-be-journaled"
    const journal = createMemoryNativeActionJournal()
    const runtime = createNativeActionRuntime({ journal })
    const request = createNativeActionRequest({
      senderID: 9,
      kind: NativeActionKind.process,
      name: "open-path",
      payload: { path: "C:/tmp/file.txt", secret },
    })

    await runtime.execute(request, () => "ok")
    const serialised = JSON.stringify(await journal.load())
    expect(serialised).not.toContain(secret)
    expect(serialised).not.toContain("C:/tmp/file.txt")
    expect(serialised).toContain(request.inputDigest)
  })

  it("converts an interrupted action into recovery_required and never retries it", async () => {
    const journal = createMemoryNativeActionJournal()
    const runtime = createNativeActionRuntime({ journal })
    const request = createNativeActionRequest({
      senderID: 11,
      kind: NativeActionKind.process,
      name: "open-path",
      payload: { path: "C:/tmp/file.txt" },
    })

    expect(
      await captureError(runtime.execute(request, () => Promise.reject(new Error("process boundary")))),
    ).toMatchObject({
      message: "process boundary",
    })
    expect((await journal.load()).at(-1)?.state).toBe("recovery_required")
    expect(await captureError(runtime.execute(request, () => "must not run"))).toBeInstanceOf(
      NativeActionRecoveryRequiredError,
    )
  })

  it("recovers a persisted in-flight action after a main-process reload", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arforge-native-action-"))
    try {
      const journal = createFileNativeActionJournal(join(directory, "native-actions.jsonl"))
      const request = createNativeActionRequest({
        senderID: 17,
        kind: NativeActionKind.process,
        name: "updater-install",
        payload: {},
      })
      const interrupted: NativeActionReceipt = {
        ...request,
        state: "executing",
        observationStatus: "unknown",
        timeCreated: 100,
        timeUpdated: 101,
      }
      await journal.append(interrupted)

      const runtime = createNativeActionRuntime({ journal, now: () => 200 })
      const recovered = await runtime.recover()
      expect(recovered).toHaveLength(1)
      expect(recovered[0]).toMatchObject({
        actionID: request.actionID,
        state: "recovery_required",
        errorCode: "NATIVE_ACTION_INTERRUPTED",
      })
      expect(await captureError(runtime.execute(request, () => "must not run"))).toBeInstanceOf(
        NativeActionRecoveryRequiredError,
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
