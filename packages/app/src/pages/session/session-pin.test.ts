import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createSessionPin } from "./session-pin"

describe("session pin lifetime", () => {
  test("does not resolve the provider again while disposing", () => {
    const calls: string[] = []
    let disposing = false
    const dispose = createRoot((dispose) => {
      createSessionPin(
        () => {
          if (disposing) throw new Error("provider read during disposal")
          return { pin: (id) => calls.push(`pin:${id}`), unpin: (id) => calls.push(`unpin:${id}`) }
        },
        () => "session-a",
      )
      return dispose
    })
    expect(calls).toEqual(["pin:session-a"])
    disposing = true
    expect(dispose).not.toThrow()
    expect(calls).toEqual(["pin:session-a", "unpin:session-a"])
  })

  test("balances pins when the session changes or disappears", () => {
    const calls: string[] = []
    const [id, setID] = createSignal<string | undefined>("session-a")
    const dispose = createRoot((dispose) => {
      createSessionPin(
        () => ({ pin: (id) => calls.push(`pin:${id}`), unpin: (id) => calls.push(`unpin:${id}`) }),
        id,
      )
      return dispose
    })
    setID("session-b")
    setID(undefined)
    dispose()
    expect(calls).toEqual(["pin:session-a", "unpin:session-a", "pin:session-b", "unpin:session-b"])
  })

  test("releases the old server registry before pinning the new server", () => {
    const calls: string[] = []
    const registry = (server: string) => ({
      pin: (id: string) => calls.push(`${server}:pin:${id}`),
      unpin: (id: string) => calls.push(`${server}:unpin:${id}`),
    })
    const [server, setServer] = createSignal(registry("first"))
    const dispose = createRoot((dispose) => {
      createSessionPin(server, () => "session-a")
      return dispose
    })
    setServer(registry("second"))
    dispose()
    expect(calls).toEqual([
      "first:pin:session-a", "first:unpin:session-a", "second:pin:session-a", "second:unpin:session-a",
    ])
  })
})
