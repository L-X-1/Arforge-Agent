import { afterEach, describe, expect, test } from "bun:test"
import { Context } from "effect"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

const context = Context.empty() as Context.Context<unknown>

function request(route: string, directory: string, init?: RequestInit) {
  return HttpApiApp.webHandler().handler(
    new Request(`http://localhost${route}`, {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init?.headers).entries()),
        "x-arforge-directory": directory,
      },
    }),
    context,
  )
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("Python Agent capability HttpApi", () => {
  test("routes governed evolution and actual recall APIs through the typed HTTP surface", async () => {
    await using workspace = await tmpdir()

    const evolutionStatusResponse = await request("/api/agent-capabilities/evolution/status", workspace.path)
    expect(evolutionStatusResponse.status).toBe(200)
    expect(await evolutionStatusResponse.json()).toMatchObject({
      location: { directory: workspace.path },
      data: {
        schema_version: 1,
        total: expect.any(Number),
        active: expect.any(Number),
        constitution: {
          self_approval_allowed: false,
          source_mutation_allowed: false,
        },
        audit: {
          schema_version: 1,
          valid: true,
        },
      },
    })

    const candidatesResponse = await request("/api/agent-capabilities/evolution/candidates", workspace.path)
    expect(candidatesResponse.status).toBe(200)
    expect(await candidatesResponse.json()).toMatchObject({
      location: { directory: workspace.path },
      data: { schema_version: 1, count: expect.any(Number), items: expect.any(Array) },
    })

    const opportunitiesResponse = await request("/api/agent-capabilities/evolution/opportunities", workspace.path)
    expect(opportunitiesResponse.status).toBe(200)
    expect(await opportunitiesResponse.json()).toMatchObject({
      location: { directory: workspace.path },
      data: { schema_version: 1, count: expect.any(Number), items: expect.any(Array) },
    })

    const contextResponse = await request("/api/agent-capabilities/evolution/context", workspace.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userInput: "review the current task safely", cohortKey: "httpapi-regression" }),
    })
    expect(contextResponse.status).toBe(200)
    expect(await contextResponse.json()).toMatchObject({
      location: { directory: workspace.path },
      data: {
        schema_version: 1,
        text: expect.any(String),
        candidate_ids: expect.any(Array),
        cohorts: expect.any(Object),
      },
    })

    const recallQualityResponse = await request("/api/agent-capabilities/memory/actual-recall-quality", workspace.path)
    expect(recallQualityResponse.status).toBe(200)
    expect(await recallQualityResponse.json()).toMatchObject({
      location: { directory: workspace.path },
      data: {
        schema_version: 1,
        measurement: "actual_recall",
        synthetic_self_recall: false,
      },
    })
  }, 30_000)

  test("exposes the preserved capability engine through the selected Core location", async () => {
    await using workspace = await tmpdir()

    const healthResponse = await request("/api/agent-capabilities/health", workspace.path)
    expect(healthResponse.status).toBe(200)
    const health = (await healthResponse.json()) as {
      location: { directory: string }
      data: { status: string; brand: string; python_supported: boolean }
    }
    expect(health.location.directory).toBe(workspace.path)
    expect(health.data).toMatchObject({
      status: "ok",
      brand: "Arforge Agent",
      python_supported: true,
    })

    const listResponse = await request("/api/agent-capabilities", workspace.path)
    expect(listResponse.status).toBe(200)
    const capabilities = (await listResponse.json()) as {
      location: { directory: string }
      data: { count: number; items: Array<{ name: string; enabled: boolean }> }
    }
    expect(capabilities.location.directory).toBe(workspace.path)
    expect(capabilities.data.count).toBe(capabilities.data.items.length)
    expect(capabilities.data.count).toBeGreaterThan(0)
    expect(capabilities.data.items).toContainEqual(expect.objectContaining({ name: "memory_search", enabled: true }))

    await Bun.write(`${workspace.path}/module.py`, "value = 1\n")
    const qualityResponse = await request("/api/agent-capabilities/quality", workspace.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: ["module.py"] }),
    })
    expect(qualityResponse.status).toBe(200)
    const quality = (await qualityResponse.json()) as {
      location: { directory: string }
      data: { passed: boolean; score: number; files_checked: number; issues: unknown[] }
    }
    expect(quality.location.directory).toBe(workspace.path)
    expect(quality.data).toMatchObject({
      passed: true,
      score: 100,
      files_checked: 1,
      issues: [],
    })

    await Bun.write(`${workspace.path}/search.ts`, "export const repositoryNeedle = true\n")
    const repoScaleResponse = await request("/api/agent-capabilities/repository-scale", workspace.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: ".", query: "repositoryNeedle", maxFiles: 50, limit: 5 }),
    })
    expect(repoScaleResponse.status).toBe(200)
    const repoScale = (await repoScaleResponse.json()) as {
      location: { directory: string }
      data: {
        schema_version: number
        root: string
        scan: { total: number; truncated: boolean }
        suffix_counts: Record<string, number>
        search: { total: number; searched_files: number; items: Array<{ path: string; line: number }> }
      }
    }
    expect(repoScale.location.directory).toBe(workspace.path)
    expect(repoScale.data).toMatchObject({
      schema_version: 1,
      root: workspace.path,
      scan: { truncated: false },
      search: {
        total: 1,
        items: [{ path: "search.ts", line: 1 }],
      },
    })
    expect(repoScale.data.scan.total).toBeGreaterThanOrEqual(2)
    expect(repoScale.data.suffix_counts[".py"]).toBe(1)
    expect(repoScale.data.suffix_counts[".ts"]).toBe(1)
    expect(repoScale.data.search.searched_files).toBeGreaterThanOrEqual(2)

    const escapedRepoScaleResponse = await request("/api/agent-capabilities/repository-scale", workspace.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: ".." }),
    })
    expect(escapedRepoScaleResponse.status).toBe(400)

    const runsResponse = await request("/api/agent-capabilities/runs?limit=5", workspace.path)
    expect(runsResponse.status).toBe(200)
    const runs = (await runsResponse.json()) as {
      location: { directory: string }
      data: { schema_version: number; count: number; items: unknown[] }
    }
    expect(runs.location.directory).toBe(workspace.path)
    expect(runs.data.schema_version).toBe(1)
    expect(runs.data.count).toBe(runs.data.items.length)

    const missingRunResponse = await request(
      "/api/agent-capabilities/run-report?runID=definitely-missing-run",
      workspace.path,
    )
    expect(missingRunResponse.status).toBe(200)
    expect(await missingRunResponse.json()).toMatchObject({
      location: { directory: workspace.path },
      data: {
        schema_version: 1,
        found: false,
        run_id: "definitely-missing-run",
        report: null,
      },
    })

    const invalidRunsResponse = await request("/api/agent-capabilities/runs?limit=0", workspace.path)
    expect(invalidRunsResponse.status).toBe(400)
  }, 30_000)
})
