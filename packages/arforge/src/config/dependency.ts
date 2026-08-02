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
  version: InstallationLocal ? `file:${localPlugin}` : InstallationVersion,
} as const
