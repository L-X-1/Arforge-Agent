import { describe, expect, test } from "bun:test"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ConfigPluginDependency, pluginDependencyVersion } from "../../src/config/dependency"

describe("config plugin dependency", () => {
  test("normal packaged SDK resolves to a local resource, never the private registry", () => {
    const bundled = path.resolve("owned-sdk-resource")
    expect(pluginDependencyVersion({ bundled, local: false, version: "1.0.0" })).toBe(
      `file:${bundled.replaceAll("\\", "/")}`,
    )
    expect(() => pluginDependencyVersion({ bundled: "relative/not-owned", local: false, version: "1.0.0" })).toThrow(
      "absolute",
    )
  })
  test("uses a runtime-neutral file URL instead of Bun-only import metadata", () => {
    expect(ConfigPluginDependency.name).toBe("@arforge-ai/plugin")
    if (!ConfigPluginDependency.version.startsWith("file:")) return

    const directory = path.dirname(fileURLToPath(import.meta.url))
    const expected = path.resolve(directory, "../../../plugin").replaceAll("\\", "/")
    expect(ConfigPluginDependency.version).toBe(`file:${expected}`)
  })
})
