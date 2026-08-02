import { describe, expect, test } from "bun:test"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ConfigPluginDependency } from "../../src/config/dependency"

describe("config plugin dependency", () => {
  test("uses a runtime-neutral file URL instead of Bun-only import metadata", () => {
    expect(ConfigPluginDependency.name).toBe("@arforge-ai/plugin")
    if (!ConfigPluginDependency.version.startsWith("file:")) return

    const directory = path.dirname(fileURLToPath(import.meta.url))
    const expected = path.resolve(directory, "../../../plugin").replaceAll("\\", "/")
    expect(ConfigPluginDependency.version).toBe(`file:${expected}`)
  })
})
