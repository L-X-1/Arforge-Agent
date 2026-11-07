import { expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import type { Project } from "@arforge-ai/sdk/v2/client"
import { ServerScope } from "@/utils/server-scope"
import { captureProjectMetadata, resolveProjectMetadataID, updateProjectMetadata } from "./project-metadata"
import { createRequestLifetime } from "./request-lifetime"
import { createServerProjects } from "./server"

const row = { id: "shared-git-id", worktree: "E:/repo/packages/app", expanded: true }
const root = "E:/repo"
const project = (name: string, updated = 1): Project => ({
  id: row.id,
  worktree: root,
  name,
  vcs: "git",
  time: { created: 1, updated },
  sandboxes: [],
})
type Source = Parameters<typeof captureProjectMetadata>[0]
type Update = Source["sdk"]["api"]["project"]["update"]
type Current = Source["sdk"]["api"]["project"]["current"]
type List = Source["sdk"]["api"]["project"]["list"]

function projectRows() {
  const [store, setStore] = createStore({ projects: {}, lastProject: {}, recentlyClosed: {} })
  const rows = createServerProjects({ scope: () => ServerScope.local, store, setStore })
  rows.open(row.worktree)
  return rows
}

function fixture(initial: Project[], handlers: { update?: Update; current?: Current; list?: List } = {}) {
  const [data, set] = createStore({ project: initial })
  const [child, setChild] = createStore({ project: "" })
  const page = new EventTarget()
  const lifetime = createRequestLifetime(page)
  const updates: Parameters<Update>[0][] = []
  const lookups: Parameters<Current>[0][] = []
  let listCalls = 0
  const source = {
    sdk: {
      api: {
        project: {
          async current(input) {
            lookups.push(input)
            return handlers.current ? handlers.current(input) : { id: row.id, directory: row.worktree }
          },
          async list() {
            listCalls++
            return handlers.list ? handlers.list() : [project("discovered")]
          },
          async update(input) {
            updates.push(input)
            if (handlers.update) return handlers.update(input)
            return { ...project(input.name ?? "updated", 2), icon: input.icon, commands: input.commands }
          },
        },
      },
    },
    sync: { data, set, captureRequestLifetime: () => lifetime.capture(), child: () => [child, setChild] as const },
  } satisfies {
    sdk: { api: { project: { update: Update; current: Current; list: List } } }
    sync: {
      data: typeof data
      set: typeof set
      captureRequestLifetime: typeof lifetime.capture
      child: () => readonly [typeof child, typeof setChild]
    }
  }
  return {
    source: source as unknown as Source,
    data,
    set,
    child,
    lifetime,
    page,
    updates,
    lookups,
    listCalls: () => listCalls,
  }
}

test.each([
  ["automatic color", { icon: { color: "mint" } }],
  ["inline rename", { name: "renamed" }],
  [
    "edit dialog",
    { name: "edited", icon: { color: "lime", override: "data:image/png;base64,eA==" }, commands: { start: "bun dev" } },
  ],
] as const)("%s writes to the known Git root and keeps the local row", async (_action, patch) => {
  const f = fixture([project("original")])
  const rows = projectRows()
  const request = captureProjectMetadata(f.source, rows.list, row, () => true)!
  rows.open("E:/other")
  rows.move(row.worktree, 0)

  expect(await updateProjectMetadata(request, patch)).toBe("saved")
  expect(f.updates).toEqual([{ ...patch, projectID: row.id, directory: root }])
  expect(f.lookups).toEqual([])
  expect(rows.list()[0]?.worktree).toBe(row.worktree)
  expect(f.data.project[0]).toMatchObject({ ...patch, worktree: root })
})

test("a cold nested row resolves its identity and writes to the listed root", async () => {
  const other = { ...project("other"), id: "other", worktree: "E:/other" }
  const f = fixture([], { list: async () => [other, project("discovered")] })
  const rows = projectRows()
  const request = captureProjectMetadata(f.source, rows.list, { ...row, id: undefined }, () => true)!
  const id = await resolveProjectMetadataID(request)
  expect(id).toBe(row.id)
  expect(f.child.project).toBe(row.id)
  expect(f.lookups).toEqual([{ location: { directory: row.worktree } }])
  expect(await updateProjectMetadata({ ...request, id }, { name: "new" })).toBe("saved")
  expect(f.listCalls()).toBe(1)
  expect(f.updates).toEqual([{ name: "new", projectID: row.id, directory: root }])
  expect(f.data.project[0]?.name).toBe("new")
  expect(rows.list()[0]?.worktree).toBe(row.worktree)
})

test("a listing without the exact Git ID never starts a PATCH", async () => {
  const f = fixture([], { list: async () => [{ ...project("other"), id: "different-id" }] })
  const request = captureProjectMetadata(f.source, projectRows().list, row, () => true)!

  expect(await updateProjectMetadata(request, { name: "new" })).toBeUndefined()
  expect(f.listCalls()).toBe(1)
  expect(f.lookups).toEqual([])
  expect(f.updates).toEqual([])
})

test("retiring the page during the root listing prevents the PATCH after pageshow", async () => {
  const held = Promise.withResolvers<Awaited<ReturnType<List>>>()
  const f = fixture([], { list: () => held.promise })
  const request = captureProjectMetadata(f.source, projectRows().list, row, () => true)!
  const pending = updateProjectMetadata(request, { name: "new" })
  expect(f.listCalls()).toBe(1)
  f.page.dispatchEvent(new Event("pagehide"))
  f.page.dispatchEvent(new Event("pageshow"))
  held.resolve([project("discovered")])

  expect(await pending).toBeUndefined()
  expect(f.updates).toEqual([])
})

test("a nested identity read cannot tag a reopened project row", async () => {
  const held = Promise.withResolvers<Awaited<ReturnType<Current>>>()
  const f = fixture([], { current: () => held.promise })
  const rows = projectRows()
  const request = captureProjectMetadata(f.source, rows.list, { ...row, id: undefined }, () => true)!
  const pending = resolveProjectMetadataID(request)
  rows.close(row.worktree)
  rows.open(row.worktree)
  held.resolve({ id: row.id, directory: row.worktree })

  expect(await pending).toBeUndefined()
  expect(f.child.project).toBe("")
  expect(f.updates).toEqual([])
})

test("a delayed response for the same Git ID cannot publish on a replacement server", async () => {
  const held = Promise.withResolvers<Project>()
  const a = fixture([project("server A")], { update: () => held.promise })
  const b = fixture([project("server B")])
  const rows = projectRows()
  let source = a.source
  const request = captureProjectMetadata(source, rows.list, row, () => source === a.source)!
  const pending = updateProjectMetadata(request, { name: "late A" })
  expect(a.updates).toHaveLength(1)

  source = b.source
  held.resolve(project("late A", 2))
  expect(await pending).toBeUndefined()
  expect(a.data.project[0]?.name).toBe("server A")
  expect(b.data.project[0]?.name).toBe("server B")
  expect(b.updates).toEqual([])

  const fresh = captureProjectMetadata(source, rows.list, row, () => source === b.source)!
  expect(await updateProjectMetadata(fresh, { name: "new B" })).toBe("saved")
  expect(b.data.project[0]?.name).toBe("new B")
})

test("closing and reopening the same project invalidates an admitted response", async () => {
  const held = Promise.withResolvers<Project>()
  const f = fixture([project("original")], { update: () => held.promise })
  const rows = projectRows()
  const request = captureProjectMetadata(f.source, rows.list, row, () => true)!
  const pending = updateProjectMetadata(request, { name: "late" })
  expect(f.updates).toHaveLength(1)

  rows.close(row.worktree)
  rows.open(row.worktree)
  const fresh = captureProjectMetadata(f.source, rows.list, row, () => true)!
  expect(fresh.current()).toBe(true)
  held.resolve(project("late", 2))
  expect(await pending).toBeUndefined()
  expect(f.data.project[0]?.name).toBe("original")
})

test("disposing the sync owner invalidates a response even while the sidebar row remains", async () => {
  const held = Promise.withResolvers<Project>()
  const original = fixture([project("original")], { update: () => held.promise })
  const rows = projectRows()
  const request = captureProjectMetadata(original.source, rows.list, row, () => true)!
  const pending = updateProjectMetadata(request, { name: "late" })
  expect(original.updates).toHaveLength(1)

  original.lifetime.dispose()
  const reopened = fixture([project("reopened")])
  const fresh = captureProjectMetadata(reopened.source, rows.list, row, () => true)!
  expect(fresh.current()).toBe(true)
  held.resolve(project("late", 2))
  expect(await pending).toBeUndefined()
  expect(original.data.project[0]?.name).toBe("original")
  expect(reopened.data.project[0]?.name).toBe("reopened")
})

test("an older PATCH response keeps the newer synchronized metadata", async () => {
  const held = Promise.withResolvers<Project>()
  const f = fixture([project("original")], { update: () => held.promise })
  const request = captureProjectMetadata(f.source, projectRows().list, row, () => true)!
  const pending = updateProjectMetadata(request, { name: "older" })
  f.set("project", [project("newer", 3)])
  held.resolve(project("older", 2))

  expect(await pending).toBe("superseded")
  expect(f.data.project[0]?.name).toBe("newer")
})
