import { describe, expect, test } from "bun:test"
import { runTerminalNewShortcut, terminalPanelOperationPending, terminalPanelOperationText, type TerminalPanelOperation } from "./terminal-panel-operations"

describe("terminal panel operation feedback", () => {
  test("create uses the workspace create operation rather than a PTY identifier", () => {
    const calls: unknown[][] = []
    expect(terminalPanelOperationPending((...args) => { calls.push(args); return true }, "create", "pty")).toBe(true)
    expect(calls).toEqual([["create"]])
  })

  test("close and reconnect are blocked while this PTY closes or clones", () => {
    for (const operation of ["close", "clone"] as const) {
      for (const action of ["close", "reconnect", "rename"] as const) {
        const pending = (kind: TerminalPanelOperation, id?: string) => kind === operation && id === "one"
        expect(terminalPanelOperationPending(pending, action, "one")).toBe(true)
        expect(terminalPanelOperationPending(pending, action, "two")).toBe(false)
      }
    }
  })

  test("renaming waits for an existing update, without blocking connection-only remounts", () => {
    const pending = (operation: TerminalPanelOperation) => operation === "update"
    expect(terminalPanelOperationPending(pending, "rename", "one")).toBe(true)
    expect(terminalPanelOperationPending(pending, "reconnect", "one")).toBe(false)
    expect(terminalPanelOperationPending(() => false, "close")).toBe(true)
  })

  test("every operation has fixed localized progress and error text, with no raw error input", () => {
    for (const operation of ["create", "clone", "update", "close"] as const) {
      expect(terminalPanelOperationText(operation, false)).not.toBe(terminalPanelOperationText(operation, false, false))
      expect(terminalPanelOperationText(operation, true)).not.toBe(terminalPanelOperationText(operation, false))
    }
    expect(terminalPanelOperationText("close", false)).toContain("retained")
  })
})

describe("new terminal shortcut", () => {
  const run = (count: number, opened: boolean, busy = false) => {
    const calls: unknown[] = []
    runTerminalNewShortcut({
      count,
      opened,
      pending: (operation, id) => {
        expect(operation).toBe("create")
        expect(id).toBeUndefined()
        return busy
      },
      create: (options) => { calls.push(["create", options]) },
      requestFocus: () => { calls.push("focus") },
      open: () => { calls.push("open") },
    })
    return calls
  }

  test("retries real creation in an already-open empty panel", () => {
    expect(run(0, true)).toEqual([["create", { focus: true }], "focus", "open"])
  })

  test("does not create again while creation is pending", () => {
    expect(run(0, true, true)).toEqual(["focus", "open"])
    expect(run(1, true, true)).toEqual(["open"])
  })

  test("leaves initial creation to the closed empty panel's existing opening effect", () => {
    expect(run(0, false)).toEqual(["focus", "open"])
  })

  test("preserves the explicit new-terminal action when PTYs already exist", () => {
    expect(run(1, true)).toEqual([["create", { focus: true }], "open"])
  })

  test("does not queue focus, opening, or retries after an async creation changes scope", async () => {
    const calls: string[] = []
    let scope = "original"
    let finish!: () => void
    const request = new Promise<void>((resolve) => { finish = resolve })
    runTerminalNewShortcut({
      count: 0,
      opened: true,
      pending: () => false,
      create: () => { calls.push("create:" + scope); return request },
      requestFocus: () => { calls.push("focus:" + scope) },
      open: () => { calls.push("open:" + scope) },
    })
    scope = "other"
    finish()
    await request
    expect(calls).toEqual(["create:original", "focus:original", "open:original"])
  })
})
