import { describe, expect, test } from "bun:test"
import { createMemo, createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { hasPromptContent } from "@/context/prompt-state"
import { prependHistoryEntry } from "@/components/prompt-input/history"
import { buildRequestParts } from "@/components/prompt-input/build-request-parts"
import {
  SESSION_OPEN_FILE_TAB,
  createOpenReviewFile,
  createOpenSessionFileTab,
  createSessionTabs,
  focusTerminalById,
  getTabReorderIndex,
  queuedPromptParts,
  shouldShowFileTree,
} from "./helpers"

describe("queued prompt cache-miss restoration", () => {
  test("restores queue mentions in place instead of duplicating the canonical text", () => {
    const uri = "evidence://shared/manual"
    const prompt = {
      text: "@manual @manual",
      files: ["server-A", "server-B"].map((server, index) => ({
        uri,
        name: "manual",
        mime: "text/plain",
        resource: { server, uri },
        source: { text: "@manual", start: index * 8, end: index * 8 + 7 },
      })),
    }
    const restored = queuedPromptParts({ id: "queued", sessionID: "session", prompt })
    expect(restored.map((part) => ("content" in part ? part.content : "")).join("")).toBe(prompt.text)
    expect(restored.filter((part) => part.type === "file").map((part) => part.source)).toEqual(
      ["server-A", "server-B"].map((clientName, index) => ({
        type: "resource",
        clientName,
        uri,
        text: { value: "@manual", start: index * 8, end: index * 8 + 7 },
      })),
    )
  })

  test("keeps MCP identity before classifying data URIs as ordinary images", () => {
    const uri = "data:image/png;base64,AA=="
    const prompt = {
      text: "",
      files: ["server-A", "server-B"].map((server) => ({
        uri,
        mime: "image/png",
        name: "manual.png",
        resource: { server, uri },
      })),
    }
    const result = queuedPromptParts({ id: "queued-resource", sessionID: "session", prompt })
    expect(result.filter((part) => part.type === "image")).toEqual([])
    expect(result.filter((part) => part.type === "file")).toEqual(
      ["server-A", "server-B"].map((clientName) => ({
        type: "file",
        path: uri,
        url: uri,
        mime: "image/png",
        filename: "manual.png",
        content: "",
        start: 0,
        end: 0,
        source: { type: "resource", clientName, uri, text: { value: "", start: 0, end: 0 } },
      })),
    )
    expect(result.map((part) => ("content" in part ? part.content : "")).join("")).toBe("")
    expect(prompt.files[0]?.resource).toEqual({ server: "server-A", uri })
    expect(hasPromptContent(result)).toBe(true)
    expect(prependHistoryEntry([], result)).toHaveLength(1)
    const request = buildRequestParts({
      prompt: result,
      context: [],
      images: [],
      text: "",
      sessionID: "session",
      messageID: "message",
      sessionDirectory: "/owned",
    })
    expect(request.requestParts).toMatchObject(
      ["server-A", "server-B"].map((clientName) => ({
        type: "file",
        mime: "image/png",
        url: uri,
        source: { type: "resource", clientName, uri },
      })),
    )
  })

  test("keeps resource mentions, ordinary uploads and agents in the fallback", () => {
    const uri = "evidence://shared/manual"
    const result = queuedPromptParts({
      id: "queued-mixed",
      sessionID: "session",
      prompt: {
        text: "@manual @review",
        files: [
          {
            uri,
            mime: "text/plain",
            name: "manual",
            resource: { server: "server-B", uri },
            source: { text: "@manual", start: 0, end: 7 },
          },
          { uri: "data:image/png;base64,AA==", mime: "image/png", name: "upload.png" },
          { uri: "data:application/pdf;base64,Qg==", mime: "application/pdf", name: "upload.pdf" },
        ],
        agents: [{ name: "review", source: { text: "@review", start: 8, end: 15 } }],
      },
    })
    expect(result.find((part) => part.type === "file")).toMatchObject({
      type: "file",
      path: uri,
      url: uri,
      filename: "manual",
      mime: "text/plain",
      content: "@manual",
      start: 0,
      end: 7,
      source: { type: "resource", clientName: "server-B", uri, text: { value: "@manual", start: 0, end: 7 } },
    })
    expect(result.find((part) => part.type === "image" && part.filename === "upload.png")).toMatchObject({
      type: "image",
      filename: "upload.png",
      mime: "image/png",
      dataUrl: "data:image/png;base64,AA==",
    })
    expect(result.find((part) => part.type === "image" && part.filename === "upload.pdf")).toMatchObject({
      type: "image",
      filename: "upload.pdf",
      mime: "application/pdf",
      dataUrl: "data:application/pdf;base64,Qg==",
    })
    expect(result.find((part) => part.type === "agent")).toEqual({
      type: "agent",
      name: "review",
      content: "@review",
      start: 8,
      end: 15,
    })
    expect(result.map((part) => ("content" in part ? part.content : "")).join("")).toBe("@manual @review")
  })
})

describe("shouldShowFileTree", () => {
  test("does not reserve space for a disabled file tree", () => {
    expect(shouldShowFileTree({ visible: false, opened: true })).toBe(false)
    expect(shouldShowFileTree({ visible: true, opened: true })).toBe(true)
  })
})

describe("createOpenReviewFile", () => {
  test("opens and loads selected review file", () => {
    const calls: string[] = []
    const openReviewFile = createOpenReviewFile({
      showAllFiles: () => calls.push("show"),
      tabForPath: (path) => {
        calls.push(`tab:${path}`)
        return `file://${path}`
      },
      openTab: (tab) => calls.push(`open:${tab}`),
      setActive: (tab) => calls.push(`active:${tab}`),
      loadFile: (path) => calls.push(`load:${path}`),
    })

    openReviewFile("src/a.ts")

    expect(calls).toEqual(["show", "load:src/a.ts", "tab:src/a.ts", "open:file://src/a.ts", "active:file://src/a.ts"])
  })
})

describe("createOpenSessionFileTab", () => {
  test("activates the opened file tab", () => {
    const calls: string[] = []
    const openTab = createOpenSessionFileTab({
      normalizeTab: (value) => {
        calls.push(`normalize:${value}`)
        return `file://${value}`
      },
      openTab: (tab) => calls.push(`open:${tab}`),
      pathFromTab: (tab) => {
        calls.push(`path:${tab}`)
        return tab.slice("file://".length)
      },
      loadFile: (path) => calls.push(`load:${path}`),
      openReviewPanel: () => calls.push("review"),
      setActive: (tab) => calls.push(`active:${tab}`),
    })

    openTab("src/a.ts")

    expect(calls).toEqual([
      "normalize:src/a.ts",
      "open:file://src/a.ts",
      "path:file://src/a.ts",
      "load:src/a.ts",
      "review",
      "active:file://src/a.ts",
    ])
  })
})

describe("focusTerminalById", () => {
  test("focuses textarea when present", () => {
    document.body.innerHTML = `<div id="terminal-wrapper-one"><div data-component="terminal"><textarea></textarea></div></div>`

    const focused = focusTerminalById("one")

    expect(focused).toBe(true)
    expect(document.activeElement?.tagName).toBe("TEXTAREA")
  })

  test("falls back to terminal element focus", () => {
    document.body.innerHTML = `<div id="terminal-wrapper-two"><div data-component="terminal" tabindex="0"></div></div>`
    const terminal = document.querySelector('[data-component="terminal"]') as HTMLElement
    let pointerDown = false
    terminal.addEventListener("pointerdown", () => {
      pointerDown = true
    })

    const focused = focusTerminalById("two")

    expect(focused).toBe(true)
    expect(document.activeElement).toBe(terminal)
    expect(pointerDown).toBe(true)
  })
})

describe("getTabReorderIndex", () => {
  test("returns target index for valid drag reorder", () => {
    expect(getTabReorderIndex(["a", "b", "c"], "a", "c")).toBe(2)
  })

  test("returns undefined for unknown droppable id", () => {
    expect(getTabReorderIndex(["a", "b", "c"], "a", "missing")).toBeUndefined()
  })
})

describe("createSessionTabs", () => {
  test("normalizes the effective file tab", () => {
    createRoot((dispose) => {
      const [state] = createStore({
        active: undefined as string | undefined,
        all: ["file://src/a.ts", "context"],
      })
      const tabs = createMemo(() => ({ active: () => state.active, all: () => state.all }))
      const result = createSessionTabs({
        tabs,
        pathFromTab: (tab) => (tab.startsWith("file://") ? tab.slice("file://".length) : undefined),
        normalizeTab: (tab) => (tab.startsWith("file://") ? `norm:${tab.slice("file://".length)}` : tab),
      })

      expect(result.activeTab()).toBe("norm:src/a.ts")
      expect(result.activeFileTab()).toBe("norm:src/a.ts")
      expect(result.closableTab()).toBe("norm:src/a.ts")
      dispose()
    })
  })

  test("prefers context and review fallbacks when no file tab is active", () => {
    createRoot((dispose) => {
      const [state] = createStore({
        active: undefined as string | undefined,
        all: ["context"],
      })
      const tabs = createMemo(() => ({ active: () => state.active, all: () => state.all }))
      const result = createSessionTabs({
        tabs,
        pathFromTab: () => undefined,
        normalizeTab: (tab) => tab,
        review: () => true,
        hasReview: () => true,
      })

      expect(result.activeTab()).toBe("context")
      expect(result.closableTab()).toBe("context")
      dispose()
    })

    createRoot((dispose) => {
      const [state] = createStore({
        active: undefined as string | undefined,
        all: [],
      })
      const tabs = createMemo(() => ({ active: () => state.active, all: () => state.all }))
      const result = createSessionTabs({
        tabs,
        pathFromTab: () => undefined,
        normalizeTab: (tab) => tab,
        review: () => true,
        hasReview: () => true,
      })

      expect(result.activeTab()).toBe("review")
      expect(result.activeFileTab()).toBeUndefined()
      expect(result.closableTab()).toBeUndefined()
      dispose()
    })
  })

  test("exposes the Open File tab without treating it as a file tab", () => {
    createRoot((dispose) => {
      const [state] = createStore({
        active: SESSION_OPEN_FILE_TAB as string | undefined,
        all: ["file://src/a.ts", SESSION_OPEN_FILE_TAB],
      })
      const tabs = createMemo(() => ({ active: () => state.active, all: () => state.all }))
      const result = createSessionTabs({
        tabs,
        pathFromTab: (tab) => (tab.startsWith("file://") ? tab.slice("file://".length) : undefined),
        normalizeTab: (tab) => tab,
        fileBrowser: () => true,
      })

      expect(result.openFileOpen()).toBe(true)
      expect(result.panelTabs()).toEqual(["file://src/a.ts", SESSION_OPEN_FILE_TAB])
      expect(result.openedTabs()).toEqual(["file://src/a.ts"])
      expect(result.activeTab()).toBe(SESSION_OPEN_FILE_TAB)
      expect(result.activeFileTab()).toBeUndefined()
      expect(result.closableTab()).toBe(SESSION_OPEN_FILE_TAB)
      dispose()
    })
  })

  test("hides the Open File placeholder when the file browser is unavailable", () => {
    createRoot((dispose) => {
      const [state] = createStore({
        active: SESSION_OPEN_FILE_TAB as string | undefined,
        all: ["file://src/a.ts", SESSION_OPEN_FILE_TAB],
      })
      const tabs = createMemo(() => ({ active: () => state.active, all: () => state.all }))
      const result = createSessionTabs({
        tabs,
        pathFromTab: (tab) => (tab.startsWith("file://") ? tab.slice("file://".length) : undefined),
        normalizeTab: (tab) => tab,
        fileBrowser: () => false,
      })

      expect(result.openFileOpen()).toBe(false)
      expect(result.panelTabs()).toEqual(["file://src/a.ts"])
      expect(result.activeTab()).toBe("file://src/a.ts")
      dispose()
    })
  })
})
