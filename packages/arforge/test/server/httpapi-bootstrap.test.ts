import { describe, expect } from "bun:test"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { FSUtil } from "@arforge-ai/core/fs-util"
import { Effect, FileSystem, Layer } from "effect"
import path from "path"
import { resetDatabase } from "../fixture/db"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, request } from "./httpapi-layer"

const testStateLayer = Layer.effectDiscard(
  Effect.acquireRelease(
    Effect.promise(() => resetDatabase()),
    () => Effect.promise(() => resetDatabase()),
  ),
)
const it = testEffect(Layer.mergeAll(testStateLayer, LayerNode.compile(FSUtil.node), httpApiLayer))
const projectOptions = { config: { formatter: false, lsp: false } }

describe("current protocol bootstrap", () => {
  it.instance("returns existing paths and honors deep-object directory before the header", Effect.gen(function* () {
    const directory = (yield* TestInstance).directory
    const selected = path.join(directory, "selected project")
    yield* (yield* FileSystem.FileSystem).makeDirectory(selected)
    const current = yield* request(`/api/path?location[directory]=${encodeURIComponent(selected)}`, {
      headers: { "x-arforge-directory": directory },
    })
    expect(current.status).toBe(200)
    const legacy = yield* request("/path", { headers: { "x-arforge-directory": selected } })
    expect(legacy.status).toBe(200)
    const body = yield* current.json
    expect(body).toEqual(yield* legacy.json)
    expect(body).toMatchObject({ directory: selected })
  }), projectOptions, 30_000)

  it.instance("shares the project store while adapting the current-project contract", Effect.gen(function* () {
    const directory = (yield* TestInstance).directory
    const init = { headers: { "x-arforge-directory": directory } }
    const legacyCurrent = yield* request("/project/current", init)
    expect(legacyCurrent.status).toBe(200)
    const legacy = (yield* legacyCurrent.json) as { id: string; worktree: string }
    const current = yield* request("/api/project/current", init)
    expect(current.status).toBe(200)
    expect(yield* current.json).toEqual({ id: legacy.id, directory: legacy.worktree })
    const list = yield* request("/api/project", init)
    const legacyList = yield* request("/project", init)
    expect(list.status).toBe(200)
    expect(legacyList.status).toBe(200)
    expect(yield* list.json).toEqual(yield* legacyList.json)
  }), projectOptions, 30_000)

  it.instance("wraps VCS information in the selected location without inventing branches", Effect.gen(function* () {
    const directory = (yield* TestInstance).directory
    const init = { headers: { "x-arforge-directory": directory } }
    const current = yield* request("/api/vcs", init)
    const legacyResponse = yield* request("/vcs", init)
    const projectResponse = yield* request("/api/project/current", init)
    expect(current.status).toBe(200)
    expect(legacyResponse.status).toBe(200)
    expect(projectResponse.status).toBe(200)
    const legacy = (yield* legacyResponse.json) as { branch?: string; default_branch?: string }
    const body = (yield* current.json) as { data: { branch?: string; defaultBranch?: string }; location: unknown }
    expect(body.location).toEqual({ directory, project: yield* projectResponse.json })
    expect(body.data.branch).toBe(legacy.branch)
    expect(body.data.defaultBranch).toBe(legacy.default_branch)
    expect(body.data).not.toHaveProperty("default_branch")
  }), projectOptions, 30_000)

  it.instance("serves current VCS differences through the existing owner and selected location", Effect.gen(function* () {
    const directory = (yield* TestInstance).directory
    const selected = path.join(directory, "diff selected project")
    yield* (yield* FileSystem.FileSystem).makeDirectory(selected)
    const init = { headers: { "x-arforge-directory": directory } }
    const location = `location[directory]=${encodeURIComponent(selected)}`
    const projectResponse = yield* request(`/api/project/current?${location}`, init)
    expect(projectResponse.status).toBe(200)
    const project = yield* projectResponse.json
    for (const mode of ["working", "branch"] as const) {
      const response = yield* request(`/api/vcs/diff?${location}&mode=${mode}&context=0`, init)
      expect(response.status).toBe(200)
      expect(response.headers["content-type"]).toContain("application/json")
      const body = (yield* response.json) as { location: unknown; data: unknown[] }
      const legacy = yield* request(`/vcs/diff?mode=${mode === "working" ? "git" : mode}&context=0`, {
        headers: { "x-arforge-directory": selected },
      })
      expect(legacy.status).toBe(200)
      expect(body.location).toEqual({ directory: selected, project })
      const legacyData = yield* legacy.json
      expect(Array.isArray(legacyData)).toBe(true)
      if (!Array.isArray(legacyData)) throw new Error("Expected legacy VCS differences to be an array")
      expect(body.data).toEqual(legacyData)
      // Non-Git locations must use the owner's real empty result, not a Web UI fallback.
      expect(body.data).toEqual([])
    }
  }), projectOptions, 30_000)

  it.instance("rejects invalid current VCS diff modes, contexts and workspace selectors", Effect.gen(function* () {
    const directory = (yield* TestInstance).directory
    const invalidQueries = [
      "", "mode=git", "mode=unknown", "mode=working&context=-1",
      "mode=working&context=1.5", "mode=branch&context=NaN",
      "mode=working&location[workspace]=not-a-workspace",
    ]
    for (const query of invalidQueries) {
      const response = yield* request(`/api/vcs/diff?${query}`, {
        headers: { "x-arforge-directory": directory },
      })
      expect(response.status).toBe(400)
    }
  }), projectOptions, 30_000)

  it.instance("rejects malformed current workspace selectors instead of using the local project", Effect.gen(function* () {
    const directory = (yield* TestInstance).directory
    for (const endpoint of ["/api/path", "/api/project/current", "/api/vcs"]) {
      const response = yield* request(`${endpoint}?location[workspace]=not-a-workspace`, {
        headers: { "x-arforge-directory": directory },
      })
      expect(response.status).toBe(400)
    }
    const response = yield* request("/api/path", {
      headers: { "x-arforge-directory": directory, "x-arforge-workspace": "not-a-workspace" },
    })
    expect(response.status).toBe(400)
  }), projectOptions, 30_000)

  it.instance("returns the default model from the same current catalog, or explicit null", Effect.gen(function* () {
    const directory = (yield* TestInstance).directory
    const init = { headers: { "x-arforge-directory": directory } }
    const response = yield* request("/api/model/default", init)
    expect(response.status).toBe(200)
    const body = (yield* response.json) as {
      location: { directory: string }
      data: null | { id: string; providerID: string }
    }
    expect(body.location.directory).toBe(directory)
    const listResponse = yield* request("/api/model", init)
    expect(listResponse.status).toBe(200)
    const list = (yield* listResponse.json) as { data: Array<{ id: string; providerID: string }> }
    if (list.data.length === 0) {
      expect(body.data).toBeNull()
      return
    }
    expect(body.data).not.toBeNull()
    if (body.data === null) throw new Error("Expected a default model from the non-empty catalog")
    expect(list.data).toContainEqual(body.data)
  }), projectOptions, 30_000)
})
