import path from "node:path"
import { fileURLToPath } from "node:url"
import { InstallationLocal, InstallationVersion } from "@arforge-ai/core/installation/version"

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
const localPlugin = path.resolve(moduleDirectory, "../../../plugin").replaceAll("\\", "/")

/**
 * Type/runtime support installed beside user-authored config plugins.
 *
 * Source checkouts must resolve the workspace package without contacting npm;
 * release builds keep using the exact application version so plugin APIs stay
 * aligned with the running binary.
 */
export const ConfigPluginDependency = {
  name: "@arforge-ai/plugin",
  version: pluginDependencyVersion({
    bundled: process.env.ARFORGE_BUNDLED_PLUGIN_SDK,
    local: InstallationLocal,
    version: InstallationVersion,
  }),
} as const

export function pluginDependencyVersion(input: { bundled?: string; local: boolean; version: string }) {
  if (input.bundled) {
    if (!path.isAbsolute(input.bundled)) throw new Error("Bundled plugin SDK path must be absolute")
    return `file:${input.bundled.replaceAll("\\", "/")}`
  }
  return input.local ? `file:${localPlugin}` : input.version
}
