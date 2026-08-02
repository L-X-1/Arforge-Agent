import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import {
  anchoredSidebarScrollTop,
  createSidebarScrollAnchorController,
  newSidebarSessionIDsBeforeAnchor,
  visibleSidebarScrollAnchors,
} from "./sidebar-scroll-anchor"

const layout = readFileSync(new URL("../layout.tsx", import.meta.url), "utf8")
const workspace = readFileSync(new URL("./sidebar-workspace.tsx", import.meta.url), "utf8")

const rect = (top: number, bottom: number) =>
  ({
    top,
    bottom,
    left: 0,
    right: 240,
    width: 240,
    height: bottom - top,
    x: 0,
    y: top,
    toJSON: () => undefined,
  }) as DOMRect

describe("sidebar visible session anchoring geometry", () => {
  test("orders only visible session rows from top to bottom", () => {
    expect(
      visibleSidebarScrollAnchors(20, 180, [
        { id: "below", top: 180, bottom: 220 },
        { id: "second", top: 58, bottom: 98 },
        { id: "above", top: -30, bottom: 20 },
        { id: "first", top: 4, bottom: 44 },
      ]),
    ).toEqual([
      { id: "first", offset: -16 },
      { id: "second", offset: 38 },
    ])
  })

  test("keeps the captured row offset and clamps at both scroll edges", () => {
    expect(
      anchoredSidebarScrollTop({
        scrollTop: 80,
        capturedOffset: -12,
        currentOffset: 36,
        scrollHeight: 600,
        clientHeight: 240,
      }),
    ).toBe(128)
    expect(
      anchoredSidebarScrollTop({
        scrollTop: 8,
        capturedOffset: 30,
        currentOffset: -20,
        scrollHeight: 600,
        clientHeight: 240,
      }),
    ).toBe(0)
    expect(
      anchoredSidebarScrollTop({
        scrollTop: 340,
        capturedOffset: 0,
        currentOffset: 80,
        scrollHeight: 600,
        clientHeight: 240,
      }),
    ).toBe(360)
  })

  test("detects only newly inserted sessions before the preserved anchor", () => {
    expect(
      newSidebarSessionIDsBeforeAnchor(
        ["existing-a", "anchor", "existing-b"],
        ["new-a", "existing-a", "new-b", "anchor", "existing-b", "new-after"],
        "anchor",
      ),
    ).toEqual(["new-a", "new-b"])
    expect(
      newSidebarSessionIDsBeforeAnchor(
        ["existing-a", "anchor", "existing-b"],
        ["existing-b", "existing-a", "anchor"],
        "anchor",
      ),
    ).toEqual([])
    expect(newSidebarSessionIDsBeforeAnchor(["existing-a"], ["new-a"], "missing")).toEqual([])
  })
})

describe("sidebar scroll anchor controller", () => {
  test("preserves the first surviving visible row with no animated scrolling", () => {
    const frames: FrameRequestCallback[] = []
    const requestFrame = (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    }
    const container = document.createElement("div")
    const first = document.createElement("div")
    const firstRow = document.createElement("a")
    const second = document.createElement("div")
    const secondRow = document.createElement("a")
    first.dataset.sessionId = "first"
    second.dataset.sessionId = "second"
    firstRow.dataset.sidebarSessionRow = ""
    secondRow.dataset.sidebarSessionRow = ""
    first.append(firstRow)
    second.append(secondRow)
    container.append(first, second)

    let firstRect = rect(-8, 32)
    let secondRect = rect(36, 76)
    container.getBoundingClientRect = () => rect(0, 160)
    firstRow.getBoundingClientRect = () => firstRect
    secondRow.getBoundingClientRect = () => secondRect
    Object.defineProperties(container, {
      scrollTop: { value: 80, writable: true },
      scrollHeight: { value: 500 },
      clientHeight: { value: 160 },
    })

    const controller = createSidebarScrollAnchorController({
      requestFrame,
      cancelFrame: () => undefined,
      now: () => 500,
    })
    controller.register(container)
    controller.preserve()

    first.remove()
    firstRect = rect(80, 120)
    secondRect = rect(68, 108)
    frames.shift()?.(0)

    expect(container.scrollTop).toBe(112)
    expect(container.hasAttribute("data-sidebar-scroll-anchoring")).toBe(true)
    frames.shift()?.(0)
    expect(container.hasAttribute("data-sidebar-scroll-anchoring")).toBe(false)
  })

  test("does not intervene during the user interaction suppression window", () => {
    const frames: FrameRequestCallback[] = []
    let now = 100
    const container = document.createElement("div")
    const item = document.createElement("div")
    const row = document.createElement("a")
    item.dataset.sessionId = "session"
    row.dataset.sidebarSessionRow = ""
    item.append(row)
    container.append(item)
    container.getBoundingClientRect = () => rect(0, 160)
    row.getBoundingClientRect = () => rect(10, 50)

    const controller = createSidebarScrollAnchorController({
      requestFrame: (callback) => {
        frames.push(callback)
        return frames.length
      },
      cancelFrame: () => undefined,
      now: () => now,
    })
    controller.register(container)
    controller.suppress()
    controller.preserve()
    expect(frames).toHaveLength(0)

    now = 500
    controller.preserve()
    expect(frames).toHaveLength(1)
  })

  test("reports a new session only when it lands fully above the preserved viewport", () => {
    const frames: FrameRequestCallback[] = []
    const container = document.createElement("div")
    const existing = document.createElement("div")
    const existingRow = document.createElement("a")
    existing.dataset.sessionId = "existing"
    existingRow.dataset.sidebarSessionRow = ""
    existing.append(existingRow)
    container.append(existing)

    container.getBoundingClientRect = () => rect(0, 160)
    existingRow.getBoundingClientRect = () => rect(12, 52)
    Object.defineProperties(container, {
      scrollTop: { value: 80, writable: true },
      scrollHeight: { value: 500 },
      clientHeight: { value: 160 },
    })

    const notices: { id: string; ids: string[]; count: number }[] = []
    const controller = createSidebarScrollAnchorController({
      requestFrame: (callback) => {
        frames.push(callback)
        return frames.length
      },
      cancelFrame: () => undefined,
      now: () => 500,
      onNewSessionsAbove: (notice) => notices.push({ id: notice.id, ids: notice.ids, count: notice.count }),
    })
    controller.register(container)
    controller.preserve()

    const added = document.createElement("div")
    const addedRow = document.createElement("a")
    added.dataset.sessionId = "added"
    addedRow.dataset.sidebarSessionRow = ""
    added.append(addedRow)
    container.prepend(added)
    addedRow.getBoundingClientRect = () => rect(-40, 0)
    existingRow.getBoundingClientRect = () => rect(52, 92)
    frames.shift()?.(0)

    expect(container.scrollTop).toBe(120)
    expect(notices).toEqual([{ id: "added", ids: ["added"], count: 1 }])
  })

  test("does not report a reorder or a new session that remains visible", () => {
    const frames: FrameRequestCallback[] = []
    const container = document.createElement("div")
    const first = document.createElement("div")
    const firstRow = document.createElement("a")
    const second = document.createElement("div")
    const secondRow = document.createElement("a")
    first.dataset.sessionId = "first"
    second.dataset.sessionId = "second"
    firstRow.dataset.sidebarSessionRow = ""
    secondRow.dataset.sidebarSessionRow = ""
    first.append(firstRow)
    second.append(secondRow)
    container.append(first, second)
    container.getBoundingClientRect = () => rect(0, 160)
    firstRow.getBoundingClientRect = () => rect(8, 48)
    secondRow.getBoundingClientRect = () => rect(52, 92)
    Object.defineProperties(container, {
      scrollTop: { value: 0, writable: true },
      scrollHeight: { value: 500 },
      clientHeight: { value: 160 },
    })

    const notices: string[] = []
    const controller = createSidebarScrollAnchorController({
      requestFrame: (callback) => {
        frames.push(callback)
        return frames.length
      },
      cancelFrame: () => undefined,
      now: () => 500,
      onNewSessionsAbove: (notice) => notices.push(notice.id),
    })
    controller.register(container)
    controller.preserve()
    container.prepend(second)
    firstRow.getBoundingClientRect = () => rect(52, 92)
    secondRow.getBoundingClientRect = () => rect(8, 48)
    frames.shift()?.(0)
    frames.shift()?.(0)

    controller.preserve()
    const added = document.createElement("div")
    const addedRow = document.createElement("a")
    added.dataset.sessionId = "visible-added"
    addedRow.dataset.sidebarSessionRow = ""
    added.append(addedRow)
    container.prepend(added)
    addedRow.getBoundingClientRect = () => rect(-8, 32)
    secondRow.getBoundingClientRect = () => rect(52, 92)
    frames.shift()?.(0)

    expect(notices).toEqual([])
  })
})

describe("sidebar session anchoring integration contract", () => {
  test("captures before session sorting and excludes hover preview panels", () => {
    expect(workspace).toContain("props.ctx.preserveScrollAnchor()")
    expect(workspace.indexOf("props.ctx.preserveScrollAnchor()")).toBeLessThan(
      workspace.indexOf("sortedRootSessions(workspaceStore"),
    )
    expect(layout).toMatch(
      /const scrollAnchorController = createSidebarScrollAnchorController\(\{[\s\S]*enabled: \(\) => !!surface/,
    )
  })

  test("suppresses anchoring for user input, route positioning, and project restoration", () => {
    expect(layout).toContain('"pointerdown"')
    expect(layout).toContain('"pointermove"')
    expect(layout).toContain('"wheel"')
    expect(layout).toContain('"touchmove"')
    expect(layout).toContain('"keydown"')
    expect(layout).toContain("scrollAnchorController.suppress()")
    expect(layout).toContain("for (const suppress of scrollAnchorSuppressors) suppress()")
    expect(layout).toContain("data-sidebar-scroll-restoring")
  })

  test("keeps background correction silent and free of animated scrolling", () => {
    expect(workspace).toContain('hasAttribute("data-sidebar-scroll-anchoring")')
    expect(layout).toContain('hasAttribute("data-sidebar-scroll-anchoring")')
    expect(readFileSync(new URL("./sidebar-scroll-anchor.ts", import.meta.url), "utf8")).not.toContain("scrollBy(")
    expect(readFileSync(new URL("./sidebar-scroll-anchor.ts", import.meta.url), "utf8")).not.toContain("smooth")
  })
})
