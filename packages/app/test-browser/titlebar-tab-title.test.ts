import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import { plugin } from "bun"
import { createRequire } from "node:module"
import { createComponent, createSignal, type JSX } from "solid-js"
import { render } from "solid-js/web"
import type { ArforgeClient, Session } from "@arforge-ai/sdk/v2/client"
import type { SessionEvent } from "@arforge-ai/schema/session-event"
import type { ServerConnection } from "@/context/server"
import { createServerSession } from "@/context/server-session"

let TabNavItem: typeof import("@/components/titlebar-tab-nav")["TabNavItem"]
let DraftTabItem: typeof import("@/components/titlebar-tab-nav")["DraftTabItem"]
const [unread, setUnread] = createSignal(false)
const [working, setWorking] = createSignal(false)
let cache: ReturnType<typeof createServerSession>
const disposals: (() => void)[] = []
const requests: { sessionID: string; title: string }[] = []
const connection = { key: "sidecar" }
const original = (): Session => ({
  id: "ses_titlebar", slug: "titlebar", projectID: "project", directory: "C:/titlebar",
  title: "Original title", version: "1", time: { created: 1, updated: 9 },
})
const renamed = (title: string): typeof SessionEvent.Renamed.Encoded => ({
  id: "evt_titlebar_rename", type: "session.next.renamed", location: { directory: "C:/titlebar" },
  durable: { aggregateID: "ses_titlebar", seq: 1, version: 1 },
  data: { sessionID: "ses_titlebar", title, timestamp: 1000 },
})
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

beforeAll(async () => {
  // Compile the actual component with Solid's DOM transform; Bun's default
  // JSX transform does not establish the component's reactive DOM bindings.
  const require = createRequire(import.meta.resolve("vite-plugin-solid"))
  const babel = require("@babel/core") as {
    transformSync(source: string, options: Record<string, unknown>): { code?: string | null } | null
  }
  const solid = require("babel-preset-solid")
  await plugin({
    name: "titlebar-title-solid-jsx",
    setup(build) {
      build.onLoad({ filter: /[\\/]components[\\/]titlebar-tab-nav\.tsx$/ }, async ({ path }) => {
        const result = babel.transformSync(await Bun.file(path).text(), {
          filename: path, configFile: false, babelrc: false,
          parserOpts: { plugins: ["typescript", "jsx"] },
          presets: [[solid.default ?? solid, { generate: "dom" }]],
        })
        if (!result?.code) throw new Error("Titlebar Solid compilation failed")
        return { contents: result.code, loader: "ts" }
      })
    },
  })
  mock.module("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
  mock.module("@/context/global", () => ({ useGlobal: () => ({
    servers: { list: () => [connection] },
    ensureServerCtx: () => ({
      sync: { session: cache, data: { path: { home: "C:/" } } }, projects: { list: () => [] },
      sdk: { api: { session: { rename: async (input: { sessionID: string; title: string }) => { requests.push(input) } } } },
    }),
  }) }))
  mock.module("@/context/server", () => ({ ServerConnection: { key: () => "sidecar" }, serverName: () => "Local" }))
  mock.module("@/pages/layout/helpers", () => ({ projectForSession: () => undefined, displayName: () => "workspace" }))
  mock.module("@/pages/layout/project-avatar-state", () => ({ useSessionTabAvatarState: () => ({ unread, loading: working }) }))
  mock.module("@arforge-ai/session-ui/v2/session-progress-indicator-v2", () => ({ SessionProgressIndicatorV2: () => {
    const indicator = document.createElement("span")
    indicator.dataset.testProgress = "true"
    return indicator
  } }))
  mock.module("@/utils/toast", () => ({ showToast: () => { throw new Error("Unexpected rename failure") } }))
  mock.module("@arforge-ai/ui/v2/icon", () => ({ Icon: () => document.createElement("span") }))
  mock.module("@arforge-ai/ui/v2/icon-button-v2", () => ({ IconButtonV2: (props: { "aria-label": string; onClick: (event: MouseEvent) => void }) => {
    const button = document.createElement("button")
    button.setAttribute("aria-label", props["aria-label"])
    button.addEventListener("click", props.onClick)
    return button
  } }))
  // Keep the real tab and editable title; the hover-card shell is unrelated.
  mock.module("@/components/titlebar-tab-popover", () => ({ TabPreviewPopover: (props: { trigger: JSX.Element }) => props.trigger }))
  ;({ TabNavItem, DraftTabItem } = await import("@/components/titlebar-tab-nav"))
})

afterEach(() => {
  disposals.splice(0).reverse().forEach((dispose) => dispose())
  requests.length = 0
  setUnread(false)
  setWorking(false)
})

function mount(preloaded = false) {
  cache = createServerSession({} as ArforgeClient)
  if (preloaded) cache.remember(original())
  const host = document.createElement("div")
  document.body.append(host)
  let navigations = 0, closes = 0
  const dispose = render(() => createComponent(TabNavItem, {
    href: "/session/ses_titlebar", server: "sidecar" as ServerConnection.Key,
    active: true,
    session: () => cache.peek("ses_titlebar"),
    onTitleChange: (title) => cache.remember({ ...cache.get("ses_titlebar")!, title }),
    onNavigate: () => { navigations++ }, onClose: () => { closes++ },
  }), host)
  disposals.push(() => { dispose(); host.remove() })
  const title = () => {
    const element = host.querySelector<HTMLElement>("[data-titlebar-tab-title]")
    if (!element) throw new Error("Expected the real tab title to be mounted")
    return element
  }
  return { host, title, navigations: () => navigations, closes: () => closes }
}

describe("titlebar metadata updates", () => {
  test("updates an asynchronously mounted title after a native rename, retaining the tab and keyboard focus", async () => {
    const view = mount()
    expect(view.host.querySelector("[data-titlebar-tab-title]")).toBeNull()
    cache.remember(original())
    await settle()
    const title = view.title(), tab = title.closest("[data-titlebar-tab]")
    expect(title.textContent).toBe("Original title")
    const link = view.host.querySelector("a")!
    link.focus()
    expect(cache.applyV2(renamed("Committed title"))).toBe(true)
    await settle()
    expect(cache.get("ses_titlebar")?.title).toBe("Committed title")
    expect(view.title().textContent).toBe("Committed title")
    expect(view.title()).toBe(title)
    expect(title.closest("[data-titlebar-tab]")).toBe(tab)
    expect(document.activeElement).toBe(link)
    expect(requests).toEqual([])
  })

  test("keeps an in-progress title edit and Escape restores the latest committed title", async () => {
    const view = mount()
    cache.remember(original())
    await settle()
    const title = view.title()
    title.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }))
    title.textContent = "My unsaved title"
    cache.applyV2(renamed("Renamed in the other window"))
    await settle()
    expect(title.textContent).toBe("My unsaved title")
    title.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
    await settle()
    expect(title.textContent).toBe("Renamed in the other window")
    expect(title.isContentEditable).toBe(false)
    expect(requests).toEqual([])
  })

  test("retains Enter-to-save, keyboard navigation and close actions", async () => {
    const view = mount(true)
    const title = view.title()
    title.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }))
    title.textContent = "Saved with Enter"
    title.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
    await settle()
    expect(requests).toEqual([{ sessionID: "ses_titlebar", title: "Saved with Enter" }])
    expect(title.textContent).toBe("Saved with Enter")
    view.host.querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 }))
    view.host.querySelector("button")!.click()
    expect(view.navigations()).toBe(1)
    expect(view.closes()).toBe(1)
  })

  test("uses the session title as the label and keeps status and close controls distinct", () => {
    const { host } = mount(true)
    const link = host.querySelector("a")!
    expect(link.textContent).toBe("Original title")
    expect(link.getAttribute("aria-current")).toBe("page")
    expect(link.querySelector("[data-slot='project-avatar-slot']")).toBeNull()
    expect(link.querySelector("button")).toBeNull()
    expect(host.querySelector("[data-slot='tab-close'] button")?.getAttribute("aria-label")).toBe("common.closeTab")

    setUnread(true)
    expect(link.querySelector("[data-slot='titlebar-tab-unread']")).not.toBeNull()
    setWorking(true)
    expect(link.querySelector("[data-test-progress]")).not.toBeNull()
    expect(link.querySelector("[data-slot='titlebar-tab-unread']")).not.toBeNull()
  })

  test("keeps the complete draft label separate from its close action", () => {
    const host = document.createElement("div")
    const dispose = render(() => createComponent(DraftTabItem, {
      href: "/session", title: "New session", active: true,
      onNavigate: () => {}, onClose: () => {},
    }), host)
    disposals.push(dispose)
    const link = host.querySelector("a")!
    expect(link.textContent).toBe("New session")
    expect(link.getAttribute("aria-current")).toBe("page")
    expect(link.querySelector("button")).toBeNull()
    expect(host.querySelector("[data-slot='tab-close'] button")?.getAttribute("aria-label")).toBe("common.closeTab")
  })

  test("gives a loaded session with a blank title a readable fallback", async () => {
    const view = mount(true)
    cache.remember({ ...original(), title: "  " })
    await settle()
    expect(view.title().textContent).toBe("session.tab.unknown")
  })
})
