import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import { resolve } from "node:path"
import { createComponent, createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import type { ServerConnection } from "@/context/server"
import type { useServerManagementController } from "./dialog-select-server"

// Context module mocks stay in a child test process, as in the existing tabs
// owner regressions. The real controller, Solid store, QueryClient mutations,
// health cache and protocol detector run unchanged against deferred fetches.
if (!process.env.ARFORGE_SERVER_CONTROLLER_TEST_CHILD) {
  test("server management controller fences deferred work in an isolated owner", async () => {
    const child = Bun.spawn({
      cmd: [process.execPath, "test", "--conditions=browser", "--rerun-every", "--preload", "./happydom.ts", import.meta.path],
      cwd: resolve(import.meta.dir, "../.."),
      env: { ...process.env, ARFORGE_SERVER_CONTROLLER_TEST_CHILD: "1" },
      stdout: "pipe", stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    expect({ code, output: stdout + stderr }).toMatchObject({ code: 0 })
    expect(stdout + stderr).toContain("0 fail")
  }, 20_000)
} else {
  type Controller = ReturnType<typeof useServerManagementController>
  type Http = ServerConnection.Http
  type Probe = { url: URL; authorization: string | null; resolve: (healthy: boolean, protocol?: "v1" | "v2") => void }
  const connection = (url: string, password = "owned-original") => ({
    type: "http" as const, displayName: "Original", http: { url, username: "owner", password },
  })
  const a = connection("http://owned-a.test"), b = connection("http://owned-b.test")
  let controllerFactory: typeof useServerManagementController
  let connectionKey: typeof import("@/context/server").ServerConnection.key
  let environment: ReturnType<typeof makeEnvironment>
  let dispose = () => {}
  let client: QueryClient

  function makeEnvironment() {
    const [state, setState] = createStore<{ active: string; list: Http[]; modern: boolean }>({
      active: a.http.url, list: [structuredClone(a), structuredClone(b)], modern: true,
    })
    const probes: Probe[] = [], writes: Http[] = [], removals: string[] = [], tabRemovals: string[] = [], navigations: string[] = []
    const defaults: Array<string | null> = []
    let selected = 0
    const server = {
      get key() { return state.active },
      get current() { return state.list.find(item => item.http.url === state.active) },
      get list() { return state.list },
      add(conn: Http) {
        writes.push(structuredClone(conn))
        const index = state.list.findIndex(item => item.http.url === conn.http.url)
        if (index < 0) setState("list", state.list.length, conn)
        else setState("list", index, conn)
        setState("active", conn.http.url)
        return conn
      },
      setActive(key: string) { setState("active", key) },
      remove(key: string) {
        removals.push(key)
        setState("list", state.list.filter(item => item.http.url !== key))
      },
    }
    const platform = {
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
        return new Promise<Response>(done => probes.push({ url, authorization: headers.get("Authorization"),
          resolve: (healthy, protocol = "v1") => done(Response.json({ healthy, version: "owned-fixture", protocol })),
        }))
      }) as typeof globalThis.fetch,
      getDefaultServer: async () => state.active,
      setDefaultServer: async (key: string | null) => { defaults.push(key) },
    }
    return { state, setState, probes, writes, removals, tabRemovals, navigations, defaults, server, platform,
      selected: () => selected, onSelect: () => { selected++ },
    }
  }

  beforeAll(async () => {
    // Bun does not apply the App's Solid JSX transform. This controller-only
    // test discards its decorative title JSX; no rendered UI claim is made.
    Object.defineProperty(globalThis, "React", { configurable: true, value: { createElement: () => null } })
    for (const [path, name] of [
      ["@arforge-ai/ui/button", "Button"], ["@arforge-ai/ui/dialog", "Dialog"],
      ["@arforge-ai/ui/dropdown-menu", "DropdownMenu"], ["@arforge-ai/ui/icon", "Icon"],
      ["@arforge-ai/ui/icon-button", "IconButton"], ["@arforge-ai/ui/list", "List"],
      ["@arforge-ai/ui/text-field", "TextField"],
    ]) mock.module(path, () => ({ [name]: () => null }))
    mock.module("@arforge-ai/ui/context/dialog", () => ({ useDialog: () => ({ close: () => {} }) }))
    mock.module("@/components/server/server-row", () => ({ ServerHealthIndicator: () => null, ServerRow: () => null }))
    mock.module("@/utils/toast", () => ({ showToast: () => {} }))
    mock.module("@solidjs/router", () => ({ useNavigate: () => (path: string) => environment.navigations.push(path) }))
    mock.module("@/context/platform", () => ({ usePlatform: () => environment.platform }))
    mock.module("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
    mock.module("@/context/settings", () => ({ useSettings: () => ({ general: { newLayoutDesigns: () => environment.state.modern } }) }))
    mock.module("@/context/global", () => ({ useGlobal: () => ({ servers: { health: {} }, ensureServerCtx: () => ({ sdk: { protocolKind: () => "v1" } }) }) }))
    mock.module("@/context/tabs", () => ({ useTabs: () => ({ removeServer: (key: string) => environment.tabRemovals.push(key) }) }))
    const actual = await import("@/context/server")
    connectionKey = actual.ServerConnection.key
    mock.module("@/context/server", () => ({ ...actual, useServer: () => environment.server }))
    const baseline = process.env.ARFORGE_SERVER_CONTROLLER_BASELINE
    if (baseline) await Bun.plugin({ name: "captured-controller-baseline", setup(builder) {
      builder.onLoad({ filter: /dialog-select-server\.tsx$/ }, async () => ({ contents: await Bun.file(baseline).text(), loader: "tsx" }))
    } })
    ;({ useServerManagementController: controllerFactory } = await import("./dialog-select-server"))
  })

  const flush = () => new Promise<void>(done => setTimeout(done, 0))
  async function until(check: () => boolean) {
    for (let index = 0; index < 100; index++) {
      if (check()) return
      await flush()
    }
    expect(check()).toBe(true)
  }
  function setup(navigateOnAdd = false) {
    environment = makeEnvironment()
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false, gcTime: 0 } } })
    let controller!: Controller
    createRoot(cleanup => {
      dispose = cleanup
      createComponent(QueryClientProvider, { client, get children() {
        return createComponent(() => {
          controller = controllerFactory({ navigateOnAdd, onSelect: environment.onSelect })
          return null
        }, {})
      } })
    })
    return controller
  }
  afterEach(async () => {
    dispose()
    for (const probe of environment.probes) probe.resolve(true)
    await flush()
    client.clear()
  })
  async function pendingAdd(controller: Controller) {
    controller.startAdd()
    controller.handleFormNameChange()("Pending add")
    controller.handleFormPasswordChange()("owned-pending-add")
    controller.handleFormChange()("http://owned-new.test")
    await until(() => environment.probes.length === 1)
    controller.submitForm()
    await until(() => controller.formBusy())
    return environment.probes[0]
  }
  async function pendingEdit(controller: Controller, value = b.http.url) {
    controller.startEdit(b)
    controller.handleFormNameChange()("Pending edit")
    controller.handleFormPasswordChange()("owned-pending-edit")
    if (value !== b.http.url) controller.handleFormChange()(value)
    await until(() => environment.probes.length === (value === b.http.url ? 1 : 2))
    controller.submitForm()
    await until(() => controller.formBusy())
    return environment.probes.at(-1)!
  }
  async function settle(_controller: Controller, probe: Probe, healthy = true) {
    probe.resolve(healthy)
    await until(() => client.getMutationCache().getAll().every(item => item.state.status !== "pending"))
    await flush()
  }

  describe("deferred server controller operations", () => {
    test("current explicit add persists credentials and its ordinary navigation", async () => {
      const controller = setup(true), probe = await pendingAdd(controller)
      await settle(controller, probe)
      expect(environment.writes).toEqual([{ type: "http", displayName: "Pending add", http: {
        url: "http://owned-new.test", username: "arforge", password: "owned-pending-add",
      } }])
      expect(environment.navigations).toEqual(["/"])
      expect(environment.selected()).toBe(1)
      expect(controller.isFormMode()).toBe(false)
    })

    test("global edit of a nonactive server still saves after a healthy check", async () => {
      const controller = setup(), probe = await pendingEdit(controller)
      await settle(controller, probe)
      expect(environment.writes).toHaveLength(1)
      expect(environment.writes[0]?.http).toEqual({ url: b.http.url, username: "owner", password: "owned-pending-edit" })
      expect(controller.isFormMode()).toBe(false)
      expect(environment.navigations).toEqual([])
    })

    test("current URL replacement retains the original active server and removes its old tabs", async () => {
      const controller = setup(), probe = await pendingEdit(controller, "http://owned-replacement.test")
      await settle(controller, probe)
      expect(environment.writes).toHaveLength(1)
      expect(environment.server.key).toBe(a.http.url)
      expect(environment.server.list.map(item => item.http.url)).toEqual([a.http.url, "http://owned-replacement.test"])
      expect(environment.tabRemovals).toEqual([b.http.url])
      expect(controller.isFormMode()).toBe(false)
    })

    test("a new destination revision cannot be overwritten by a pending URL replacement", async () => {
      const controller = setup(), probe = await pendingEdit(controller, "http://owned-replacement.test")
      const newer = connection("http://owned-replacement.test", "owned-newer-destination")
      environment.setState("list", environment.state.list.length, newer)
      await settle(controller, probe)
      expect(environment.writes).toEqual([])
      expect(environment.server.list.find(item => item.http.url === newer.http.url)?.http.password).toBe("owned-newer-destination")
      expect(environment.tabRemovals).toEqual([])
    })

    test("cancel before the mutation starts cannot capture the replacement form", async () => {
      const controller = setup(true)
      controller.startAdd(); controller.handleFormChange()("http://before-start.test")
      controller.submitForm(); controller.resetForm(); controller.startAdd()
      controller.handleFormNameChange()("Replacement form")
      controller.handleFormPasswordChange()("owned-replacement-credential")
      await until(() => environment.probes.length === 1)
      await settle(controller, environment.probes[0])
      expect(environment.writes).toEqual([])
      expect(controller.formName()).toBe("Replacement form")
      expect(controller.formPassword()).toBe("owned-replacement-credential")
      expect(environment.navigations).toEqual([])
    })

    for (const action of ["reset", "dispose", "source", "source-return"] as const) {
      test(`pending add cannot commit after ${action}`, async () => {
        const controller = setup(true), probe = await pendingAdd(controller)
        if (action === "reset") {
          controller.resetForm(); controller.startAdd()
          controller.handleFormNameChange()("Newer draft")
        }
        if (action === "dispose") dispose()
        if (action.startsWith("source")) environment.server.setActive(b.http.url)
        if (action === "source-return") environment.server.setActive(a.http.url)
        await settle(controller, probe)
        expect(environment.writes).toEqual([])
        expect(environment.navigations).toEqual([])
        expect(environment.selected()).toBe(0)
        if (action === "reset") expect(controller.formName()).toBe("Newer draft")
      })
    }

    for (const action of ["reset", "dispose", "source", "remove", "same-key-revision", "remove-return"] as const) {
      test(`pending edit cannot restore its old target after ${action}`, async () => {
        const controller = setup(), probe = await pendingEdit(controller, "http://owned-replacement.test")
        if (action === "reset") {
          controller.resetForm(); controller.startAdd()
          controller.handleFormNameChange()("Unrelated new draft")
        }
        if (action === "dispose") dispose()
        if (action === "source") environment.server.setActive(b.http.url)
        if (action === "remove" || action === "remove-return") environment.server.remove(b.http.url)
        if (action === "same-key-revision") environment.setState("list", 1, "http", "password", "owned-newer-key")
        if (action === "remove-return") environment.setState("list", environment.state.list.length, structuredClone(b))
        const before = environment.state.list.map(item => ({ ...item, http: { ...item.http } }))
        await settle(controller, probe)
        expect(environment.writes).toEqual([])
        expect([...environment.state.list]).toEqual(before)
        expect(environment.tabRemovals).toEqual([])
        expect(environment.navigations).toEqual([])
        if (action === "reset") expect(controller.formName()).toBe("Unrelated new draft")
      })
    }

    test("an old failed health result cannot put an error on a newer form", async () => {
      const controller = setup(), probe = await pendingAdd(controller)
      controller.resetForm(); controller.startEdit(b)
      await settle(controller, probe, false)
      expect(controller.formError()).toBe("")
      expect(controller.formValue()).toBe(b.http.url)
      expect(environment.writes).toEqual([])
    })

    for (const mode of ["add", "edit"] as const) {
      test(`${mode} revalidates ownership after the separate protocol await`, async () => {
        const controller = setup(true)
        environment.setState("modern", false)
        const health = mode === "add" ? await pendingAdd(controller) : await pendingEdit(controller)
        health.resolve(true)
        await until(() => environment.probes.length === 2)
        controller.resetForm(); controller.startAdd()
        const protocol = environment.probes[1]
        await settle(controller, protocol)
        expect(environment.writes).toEqual([])
        expect(environment.navigations).toEqual([])
        expect(controller.isAddMode()).toBe(true)
      })
    }

    test("late preview cannot overwrite the newer address result", async () => {
      const controller = setup()
      controller.startAdd(); controller.handleFormChange()("http://preview-old.test")
      controller.handleFormChange()("http://preview-new.test")
      await until(() => environment.probes.length === 2)
      environment.probes[1].resolve(true)
      await until(() => controller.formStatus() === true)
      environment.probes[0].resolve(false)
      await flush(); await flush()
      expect(controller.formStatus()).toBe(true)
      expect(controller.formValue()).toBe("http://preview-new.test")
    })

    test("editing the display name keeps the current connection preview valid", async () => {
      const controller = setup()
      controller.startAdd(); controller.handleFormChange()("http://preview-name.test")
      await until(() => environment.probes.length === 1)
      controller.handleFormNameChange()("A useful name")
      environment.probes[0].resolve(true)
      await until(() => controller.formStatus() === true)
      expect(controller.formName()).toBe("A useful name")
      expect(environment.probes).toHaveLength(1)
    })

    test("late preview cannot cross reset, source change or owner disposal", async () => {
      const controller = setup()
      controller.startAdd(); controller.handleFormChange()("http://preview-reset.test")
      await until(() => environment.probes.length === 1)
      controller.resetForm(); controller.startAdd()
      environment.probes[0].resolve(true)
      await flush(); await flush()
      expect(controller.formStatus()).toBeUndefined()
      controller.handleFormChange()("http://preview-source.test")
      await until(() => environment.probes.length === 2)
      environment.server.setActive(b.http.url)
      environment.probes[1].resolve(true)
      await flush(); await flush()
      expect(controller.formStatus()).toBeUndefined()
      controller.handleFormChange()("http://preview-dispose.test")
      await until(() => environment.probes.length === 3)
      dispose(); environment.probes[2].resolve(true)
      await flush(); await flush()
      expect(controller.formStatus()).toBeUndefined()
    })

    test("default-server actions keep their explicit global owner", async () => {
      const controller = setup()
      await until(() => controller.defaultKey() === a.http.url)
      await controller.setDefault(connectionKey(b))
      expect(environment.defaults).toEqual([b.http.url])
      expect(controller.defaultKey()).toBe(connectionKey(b))
    })
  })
}
