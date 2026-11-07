import { afterEach, beforeAll, expect, mock, test } from "bun:test"
import { plugin } from "bun"
import { createRequire } from "node:module"
import { createComponent, createEffect, onCleanup, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { base64Encode } from "@arforge-ai/core/util/encode"
import { Arforge } from "@arforge-ai/client/promise"
import { ServerScope } from "@/utils/server-scope"

const require = createRequire(import.meta.resolve("vite-plugin-solid"))
const directory = "/owned-workspace"
const slug = base64Encode(directory)
const [route, setRoute] = createStore({
  modern: true,
  pathname: `/${slug}/session`,
  search: "?draftId=A",
  dir: slug as string | undefined,
  id: undefined as string | undefined,
})
const disposals: (() => void)[] = []
const requests: Request[] = []
let failure: "none" | "http" | "abort" = "none"
let subscriptions = 0
let stops = 0
const location = { directory, project: { id: "owned", directory } }
const api = Arforge.make({
  baseUrl: "http://owned-search.invalid",
  fetch: Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      requests.push(request)
      if (failure === "abort") {
        return await new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(new DOMException("Owned search cancelled", "AbortError"))
          if (request.signal.aborted) abort()
          else request.signal.addEventListener("abort", abort, { once: true })
        })
      }
      if (failure === "http") return new Response("owned failure", { status: 503 })
      const url = new URL(request.url)
      expect(url.pathname).toBe("/api/fs/find")
      const entries = [
        { path: `${directory}/fresh-file.txt`, type: "file" },
        { path: `${directory}/fresh-directory/`, type: "directory" },
      ]
      const type = url.searchParams.get("type")
      const data = entries.filter((entry) => !type || entry.type === type)
      return new Response(JSON.stringify({ location, data }), { headers: { "content-type": "application/json" } })
    },
    { preconnect: globalThis.fetch.preconnect },
  ),
})
const listen = () => {
  subscriptions++
  return () => stops++
}
const serverSDK = { scope: ServerScope.local, url: "http://owned-search.invalid", api, event: { listen } }
const ready = Object.assign(() => true, { promise: Promise.resolve() })
const layout = {
  ready,
  tabs: () => ({ all: () => [] }),
  route: () => ({ type: "draft" }),
  projects: { list: () => [] },
  sidebar: { opened: () => false, width: () => 280, workspaces: () => () => false },
  mobileSidebar: { opened: () => false },
}
const childState = { path: { directory }, session: [], project: undefined }
const sync = { peek: () => [childState], child: () => [childState], data: { project: [], path: { home: "/owned" } } }
let useFile: typeof import("@/context/file").useFile
let FileProvider: typeof import("@/context/file").FileProvider
let LegacyLayout: typeof import("@/pages/layout").default
let NewLayout: typeof import("@/pages/layout-new").default

beforeAll(async () => {
  const babel = require("@babel/core"),
    preset = require("babel-preset-solid")
  plugin({
    name: "legacy-boundaries-real-components",
    setup(build) {
      build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => ({
        contents: babel.transformSync(await Bun.file(path).text(), {
          filename: path,
          configFile: false,
          babelrc: false,
          parserOpts: { plugins: ["typescript", "jsx"] },
          presets: [[preset.default ?? preset, { generate: "dom" }]],
        }).code,
        loader: "ts",
      }))
      build.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }))
    },
  })
  await mock.module("@solidjs/router", () => ({
    useParams: () => route,
    useLocation: () => route,
    useNavigate: () => () => {},
  }))
  await mock.module("@/context/sdk", () => ({
    useSDK: () => () => ({ directory, event: { listen }, client: {} }),
  }))
  await mock.module("@/context/sync", () => ({ useSync: () => () => ({}) }))
  await mock.module("@/context/server-sync", () => ({ useServerSync: () => () => sync }))
  await mock.module("@/context/server-sdk", () => ({ useServerSDK: () => () => serverSDK }))
  await mock.module("@/context/layout", () => ({ useLayout: () => layout }))
  await mock.module("@/context/platform", () => ({ usePlatform: () => ({ platform: "web" }) }))
  await mock.module("@/context/settings", () => ({
    useSettings: () => ({ general: { newLayoutDesigns: () => route.modern } }),
  }))
  await mock.module("@/context/global", () => ({ useGlobal: () => ({}) }))
  await mock.module("@/context/server", () => ({
    useServer: () => ({ isLocal: () => false, projects: { last: () => undefined } }),
    ServerConnection: { key: () => "owned" },
  }))
  await mock.module("@/context/language", () => ({
    useLanguage: () => ({ t: (key: string) => key, locale: () => "en", locales: ["en"], label: () => "English" }),
  }))
  await mock.module("@/context/command", () => ({ useCommand: () => ({ register: () => {}, keybind: () => "" }) }))
  await mock.module("@/context/permission", () => ({ usePermission: () => ({}) }))
  await mock.module("@/context/notification", () => ({ useNotification: () => ({}) }))
  await mock.module("@/context/tabs", () => ({ useTabs: () => ({}) }))
  await mock.module("@/context/terminal", () => ({ clearWorkspaceTerminals: () => {} }))
  await mock.module("@/hooks/use-providers", () => ({ useProviders: () => ({ all: () => new Map(), paid: () => [] }) }))
  await mock.module("@/components/directory-picker", () => ({ useDirectoryPicker: () => () => {} }))
  await mock.module("@arforge-ai/ui/context/dialog", () => ({ useDialog: () => ({}) }))
  await mock.module("@arforge-ai/ui/theme/context", () => ({ useTheme: () => ({ ids: () => [], themes: () => ({}) }) }))
  const persistence = await import("@/utils/persist")
  await mock.module("@/utils/persist", () => ({
    ...persistence,
    persisted: (_target: unknown, store: readonly [unknown, unknown]) => [store[0], store[1], undefined, ready],
  }))
  await mock.module("@/utils/toast", () => ({ showToast: () => {}, setV2Toast: () => {}, ToastRegion: () => null }))
  await mock.module("@/utils/notification-click", () => ({ setNavigate: () => {} }))
  await mock.module("@/components/debug-bar", () => ({ DebugBar: () => null }))
  await mock.module("@/components/help-button", () => ({ TabsInfoPopup: () => null }))
  await mock.module("@/components/titlebar", () => ({
    Titlebar: () => {
      const header = document.createElement("header")
      header.dataset.component = "titlebar"
      header.textContent = "New session | Existing session"
      const portal = document.createElement("div")
      portal.id = "arforge-titlebar-right"
      header.append(portal)
      return header
    },
  }))
  await mock.module("@/components/titlebar-vertical-tabs", () => ({ TitlebarVerticalTabs: () => null }))
  await mock.module("@/pages/layout/workspace-sidebar", () => ({ WorkspaceSidebar: () => null }))
  await mock.module("@/pages/home/session-navigation", () => ({
    SessionNavigationProvider: (props: ParentProps) => props.children,
  }))
  await mock.module("@arforge-ai/ui/context/presentation", () => ({
    UIPresentationProvider: (props: ParentProps) => props.children,
    useUIPresentation: () => "workspace",
  }))
  await mock.module("@/pages/layout/sidebar-shell", () => ({ SIDEBAR_RAIL_WIDTH: 64, SidebarContent: () => null }))
  await mock.module("@/pages/layout/sidebar-workspace", () => ({
    LocalWorkspace: () => null,
    SortableWorkspace: () => null,
    WorkspaceDragOverlay: () => null,
  }))
  await mock.module("@/pages/layout/sidebar-project", () => ({
    ProjectDragOverlay: () => null,
    SortableProject: () => null,
  }))
  ;({ useFile, FileProvider } = await import("@/context/file"))
  LegacyLayout = (await import("@/pages/layout")).default
  NewLayout = (await import("@/pages/layout-new")).default
})

afterEach(() => {
  for (const dispose of disposals.splice(0).reverse()) dispose()
  expect(stops).toBe(subscriptions)
  document.body.replaceChildren()
  requests.length = 0
  subscriptions = stops = 0
  failure = "none"
  setRoute({ modern: true, pathname: `/${slug}/session`, search: "?draftId=A", dir: slug, id: undefined })
})
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((done) => setTimeout(done, 0))
}
function mountedFiles() {
  let files!: ReturnType<typeof useFile>
  const host = document.createElement("div")
  document.body.append(host)
  disposals.push(
    render(
      () =>
        createComponent(FileProvider, {
          get children() {
            files = useFile()
            return null
          },
        }),
      host,
    ),
  )
  return files
}
function mountLayout(embedded = true) {
  let files!: ReturnType<typeof useFile>,
    mounts = 0,
    cleaned = 0
  const content = () =>
    createComponent(FileProvider, {
      get children() {
        files = useFile()
        mounts++
        onCleanup(() => cleaned++)
        const composer = document.createElement("textarea")
        composer.setAttribute("aria-label", "Owned composer")
        createEffect(() => {
          composer.dataset.draft = new URLSearchParams(route.search).get("draftId") ?? ""
        })
        return composer
      },
    })
  const body = () =>
    embedded
      ? createComponent(LegacyLayout, {
          get children() {
            return content()
          },
        })
      : content()
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(
    () =>
      route.modern
        ? createComponent(NewLayout, {
            get children() {
              return body()
            },
          })
        : body(),
    host,
  )
  disposals.push(dispose)
  return {
    host,
    get files() {
      return files
    },
    get mounts() {
      return mounts
    },
    get cleaned() {
      return cleaned
    },
  }
}

test("mounted FileProvider mixed search omits type on the actual HTTP request and returns file plus directory", async () => {
  const files = mountedFiles()
  expect(await files.searchFilesAndDirectories("fresh")).toEqual(["fresh-file.txt", "fresh-directory/"])
  expect(requests).toHaveLength(1)
  const url = new URL(requests[0].url)
  expect(url.searchParams.has("type")).toBe(false)
  expect(url.searchParams.get("query")).toBe("fresh")
  expect(url.searchParams.get("location[directory]")).toBe(directory)
})

test("file-only Provider requests retain file, limit and signal; explicit directory API filtering remains distinct", async () => {
  const files = mountedFiles()
  const abort = new AbortController()
  expect(await files.searchFiles("fresh", { limit: 7, signal: abort.signal })).toEqual(["fresh-file.txt"])
  const first = new URL(requests[0].url)
  expect(first.searchParams.get("type")).toBe("file")
  expect(first.searchParams.get("limit")).toBe("7")
  abort.abort()
  expect(requests[0].signal.aborted).toBe(true)
  const result = await api.file.find({ location: { directory }, query: "fresh", type: "directory" })
  expect(result.data).toEqual([{ path: `${directory}/fresh-directory/`, type: "directory" }])
  expect(new URL(requests[1].url).searchParams.get("type")).toBe("directory")
})

test("mounted Provider preserves failed-search empty results and caller cancellation rejection", async () => {
  const files = mountedFiles()
  failure = "http"
  expect(await files.searchFilesAndDirectories("fresh")).toEqual([])
  failure = "abort"
  const abort = new AbortController()
  const pending = files.searchFiles("fresh", { signal: abort.signal })
  await settle()
  abort.abort()
  await pending.then(
    () => {
      throw new Error("Cancelled search unexpectedly resolved")
    },
    () => {},
  )
  expect(requests.at(-1)!.signal.aborted).toBe(true)
})

test("real new/legacy layout owners render one header for compatibility drafts and keep FileProvider across A/B/A", async () => {
  const view = mountLayout()
  await settle()
  expect(view.host.querySelectorAll('[data-component="titlebar"]')).toHaveLength(1)
  expect(view.host.querySelectorAll("#arforge-titlebar-right")).toHaveLength(1)
  expect(view.host.querySelector('[data-component="workspace-primary"] > header')).not.toBeNull()
  // The outer workspace main aligns children to start; the nested compatibility
  // shell must fill its cross axis even after removing its intrinsic-width header.
  expect(view.host.querySelector("#workspace-main > [data-arforge-atmosphere]")?.classList.contains("w-full")).toBe(
    true,
  )
  const files = view.files
  for (const draft of ["B", "A"]) {
    setRoute("search", `?draftId=${draft}`)
    await settle()
    expect(view.host.querySelector("textarea")?.dataset.draft).toBe(draft)
    expect(view.files).toBe(files)
    expect(view.host.querySelectorAll('[data-component="titlebar"]')).toHaveLength(1)
  }
  expect(view.mounts).toBe(1)
  expect(view.cleaned).toBe(0)
  expect(subscriptions).toBe(2) // Legacy notifications plus the single workspace FileProvider watcher.
  expect(stops).toBe(0)
  expect(await view.files.searchFilesAndDirectories("fresh")).toContain("fresh-file.txt")
})

test("V1 legacy route retains its original titlebar and composer", async () => {
  setRoute("modern", false)
  const view = mountLayout()
  await settle()
  expect(view.host.querySelectorAll('[data-component="titlebar"]')).toHaveLength(1)
  expect(view.host.querySelector('[data-component="workspace-shell"]')).toBeNull()
  expect(view.host.querySelector("[data-arforge-atmosphere]")?.classList.contains("w-full")).toBe(false)
  expect(view.host.querySelector("textarea")).not.toBeNull()
})

test("normal new-session and server Session keep the global header and portal mount", async () => {
  for (const pathname of ["/new-session", "/server/owned/session/session-id"]) {
    setRoute({ pathname, dir: undefined })
    const view = mountLayout(false)
    await settle()
    expect(view.host.querySelectorAll('[data-component="titlebar"]')).toHaveLength(1)
    expect(view.host.querySelector("#arforge-titlebar-right")).not.toBeNull()
    expect(view.host.querySelector("textarea")).not.toBeNull()
    disposals.pop()!()
    view.host.remove()
  }
})

test("legacy suppression excludes session IDs, missing draft IDs and invalid directory routes", async () => {
  for (const entry of [
    { pathname: `/${slug}/session/id`, id: "id", search: "?draftId=A", dir: slug },
    { pathname: `/${slug}/session`, id: undefined, search: "", dir: slug },
    { pathname: "/bad=/session", id: undefined, search: "?draftId=A", dir: "bad=" },
  ]) {
    setRoute(entry)
    const view = mountLayout()
    await settle()
    expect(view.host.querySelectorAll('[data-component="titlebar"]')).toHaveLength(2)
    expect(view.host.querySelector("#workspace-main > [data-arforge-atmosphere]")?.classList.contains("w-full")).toBe(
      false,
    )
    disposals.pop()!()
    view.host.remove()
  }
})
