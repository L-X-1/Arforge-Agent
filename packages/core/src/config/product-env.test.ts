import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadProductEnv } from "./product-env"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(value: string) {
  const home = mkdtempSync(join(tmpdir(), "arforge-product-env-"))
  roots.push(home)
  const privateDir = join(home, ".arforge")
  mkdirSync(privateDir, { recursive: true })
  writeFileSync(join(privateDir, ".env"), `ARFORGE_DB_URL=${value}\n`, { encoding: "utf8", flag: "w" })
  return home
}

describe("loadProductEnv", () => {
  test("preserves explicitly inherited values by default", () => {
    const env = { ARFORGE_DB_URL: "postgresql://inherited" }
    const result = loadProductEnv({ env, home: fixture("postgresql://private") })

    expect(env.ARFORGE_DB_URL).toBe("postgresql://inherited")
    expect(result.loaded).toEqual([])
    expect(result.skipped).toEqual(["ARFORGE_DB_URL"])
  })

  test("lets interactive launchers make the selected private file authoritative", () => {
    const env = { ARFORGE_DB_URL: "postgresql://stale" }
    const result = loadProductEnv({ env, home: fixture("postgresql://private"), override: true })

    expect(env.ARFORGE_DB_URL).toBe("postgresql://private")
    expect(result.loaded).toEqual(["ARFORGE_DB_URL"])
    expect(result.skipped).toEqual([])
  })
})
