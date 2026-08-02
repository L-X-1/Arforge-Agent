import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  loadProductEnv,
  parseProductEnv,
  resolveProductEnvFile,
} from "@arforge-ai/core/config/product-env"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "arforge-product-env-"))
  roots.push(root)
  return root
}

describe("product environment", () => {
  test("parses comments, export syntax and quoted values without evaluating shell code", () => {
    expect(
      parseProductEnv(`
        # comment
        export ARFORGE_DB_URL="postgresql://user:p@localhost/arforge"
        DEEPSEEK_MODEL='deepseek-v4-pro'
        INVALID-KEY=no
        SHELL=$(whoami)
      `),
    ).toEqual({
      ARFORGE_DB_URL: "postgresql://user:p@localhost/arforge",
      DEEPSEEK_MODEL: "deepseek-v4-pro",
      SHELL: "$(whoami)",
    })
  })

  test("prefers explicit then user configuration over the development workspace", () => {
    const root = tempRoot()
    const home = join(root, "home")
    const workspace = join(root, "workspace")
    mkdirSync(join(home, ".arforge"), { recursive: true })
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(home, ".arforge", ".env"), "SOURCE=user\n")
    writeFileSync(join(workspace, ".env"), "SOURCE=workspace\n")

    expect(resolveProductEnvFile({ env: {}, home, workspaceRoot: workspace })).toEqual({
      path: join(home, ".arforge", ".env"),
      source: "user",
    })

    const explicit = join(root, "private.env")
    writeFileSync(explicit, "SOURCE=explicit\n")
    expect(resolveProductEnvFile({ env: { ARFORGE_ENV_FILE: explicit }, home, workspaceRoot: workspace })).toEqual({
      path: explicit,
      source: "explicit",
    })
  })

  test("loads only missing keys and reports names without returning secret values", () => {
    const root = tempRoot()
    const file = join(root, "private.env")
    writeFileSync(file, "ARFORGE_DB_URL=postgresql://private\nDEEPSEEK_MODEL=from-file\n")
    const env: NodeJS.ProcessEnv = {
      ARFORGE_ENV_FILE: file,
      DEEPSEEK_MODEL: "from-process",
    }

    const result = loadProductEnv({ env, home: join(root, "home") })

    expect(env.ARFORGE_DB_URL).toBe("postgresql://private")
    expect(env.DEEPSEEK_MODEL).toBe("from-process")
    expect(result.loaded).toEqual(["ARFORGE_DB_URL"])
    expect(result.skipped).toEqual(["DEEPSEEK_MODEL"])
    expect(JSON.stringify(result)).not.toContain("postgresql://private")
  })
})
