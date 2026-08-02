import { createServer } from "node:net"
import { afterEach, describe, expect, test } from "bun:test"
import {
  parsePlaywrightPort,
  parsePlaywrightListenPort,
  playwrightBaseURL,
  playwrightReadinessPath,
  playwrightReadinessFile,
  playwrightScenarioServer,
  playwrightTemporaryOutputDir,
  parsePlaywrightServerManifest,
  resolveInheritedPlaywrightPort,
  resolvePlaywrightBunExecutable,
  resolvePlaywrightCLIExecutable,
  resolvePlaywrightPort,
} from "../playwright-server"

const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        }),
    ),
  )
})

describe("Playwright temporary server", () => {
  test("validates explicit ports", () => {
    expect(parsePlaywrightPort(undefined)).toBeUndefined()
    expect(parsePlaywrightPort("3100")).toBe(3100)
    expect(() => parsePlaywrightPort("0")).toThrow("between 1 and 65535")
    expect(() => parsePlaywrightPort("not-a-port")).toThrow("between 1 and 65535")
  })

  test("allows the temporary server to atomically request an operating-system port", () => {
    expect(parsePlaywrightListenPort(undefined)).toBe(0)
    expect(parsePlaywrightListenPort("0")).toBe(0)
    expect(parsePlaywrightListenPort("3100")).toBe(3100)
    expect(() => parsePlaywrightListenPort("-1")).toThrow("between 0 and 65535")
  })

  test("asks the operating system for an available loopback port", async () => {
    const port = await resolvePlaywrightPort(undefined)
    expect(port).toBeGreaterThan(0)
    expect(playwrightBaseURL(port)).toBe(`http://127.0.0.1:${port}`)
  })

  test("uses the isolated app origin as the production scenario server", () => {
    expect(playwrightScenarioServer({ ARFORGE_PLAYWRIGHT_TEMP_PORT: "43210" })).toBe("http://127.0.0.1:43210")
    expect(playwrightScenarioServer({ PLAYWRIGHT_SERVER_HOST: "localhost", PLAYWRIGHT_SERVER_PORT: "4097" })).toBe(
      "http://localhost:4097",
    )
  })

  test("accepts inherited ports only when the current process owns them", () => {
    const env = {
      ARFORGE_PLAYWRIGHT_TEMP_PORT: "43210",
      ARFORGE_PLAYWRIGHT_TEMP_PORT_OWNER: "1234",
    }
    expect(resolveInheritedPlaywrightPort(env, 1234, 9999)).toBe(43210)
    expect(resolveInheritedPlaywrightPort(env, 4321, 1234)).toBe(43210)
    expect(resolveInheritedPlaywrightPort(env, 4321, 9999)).toBeUndefined()
  })

  test("creates a run-specific readiness path", () => {
    expect(playwrightReadinessPath("run/id 1")).toBe("/__arforge_playwright_ready__/run%2Fid%201")
    expect(playwrightTemporaryOutputDir("E:\\repo\\packages\\app", "run/id 1").outDir).toBe(
      "E:\\repo\\packages\\app\\e2e\\.playwright-temp\\run_id_1",
    )
    expect(playwrightReadinessFile("E:\\repo\\packages\\app", "run/id 1")).toBe(
      "E:\\repo\\packages\\app\\e2e\\.playwright-temp\\run_id_1.ready.json",
    )
  })

  test("validates the atomic server manifest identity and endpoint", () => {
    const runID = "run-1"
    expect(
      parsePlaywrightServerManifest(
        {
          ready: true,
          runID,
          pid: 42,
          port: 43210,
          baseURL: "http://127.0.0.1:43210",
          readinessURL: `http://127.0.0.1:43210${playwrightReadinessPath(runID)}`,
          outDir: "E:\\repo\\packages\\app\\e2e\\.playwright-temp\\run-1",
          startedAt: "2026-07-29T00:00:00.000Z",
        },
        runID,
      ).port,
    ).toBe(43210)
    expect(() =>
      parsePlaywrightServerManifest(
        {
          ready: true,
          runID: "another-run",
          pid: 42,
          port: 43210,
          baseURL: "http://127.0.0.1:43210",
          readinessURL: "http://127.0.0.1:43210/wrong",
          outDir: "out",
          startedAt: "now",
        },
        runID,
      ),
    ).toThrow("identity mismatch")
  })

  test("prefers an explicit or bundled Bun executable without relying on PATH", () => {
    const seen: string[] = []
    const exists = (path: string) => {
      seen.push(path)
      return path.endsWith("bun.exe")
    }
    expect(resolvePlaywrightBunExecutable("E:\\repo\\packages\\app\\e2e\\performance", {}, "node.exe", exists)).toBe(
      "E:\\repo\\.tools\\bun-1.3.14\\bun.exe",
    )
    expect(seen).toContain("E:\\repo\\.tools\\bun-1.3.14\\bun.exe")

    expect(
      resolvePlaywrightBunExecutable(
        "E:\\repo\\packages\\app\\e2e\\performance",
        { PLAYWRIGHT_BUN_EXECUTABLE: "D:\\tools\\bun.exe" },
        "node.exe",
        exists,
      ),
    ).toBe("D:\\tools\\bun.exe")
  })

  test("resolves the platform Playwright launcher instead of running its CLI under Bun", () => {
    expect(resolvePlaywrightCLIExecutable("E:\\repo\\packages\\app", "win32", () => true)).toBe(
      "E:\\repo\\packages\\app\\node_modules\\.bin\\playwright.exe",
    )
    expect(() => resolvePlaywrightCLIExecutable("E:\\repo\\packages\\app", "win32", () => false)).toThrow(
      "Playwright CLI executable does not exist",
    )
  })

  test("rejects an occupied explicit port before Playwright starts", async () => {
    const server = createServer()
    servers.push(server)
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => resolve())
    })
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Expected a TCP address")

    await expect(resolvePlaywrightPort(String(address.port))).rejects.toThrow(
      `PLAYWRIGHT_PORT ${address.port} is unavailable`,
    )
  })
})
