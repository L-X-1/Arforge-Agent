import path from "node:path"

/**
 * Resolve files owned by the Arforge product rather than by the user's active
 * workspace. Desktop injects the canonical runtime root into its sidecar; a
 * directly started development server intentionally falls back to its cwd.
 *
 * Do not use Bun-only `import.meta.dir` here: this module is bundled into the
 * Electron sidecar and then executed by Node.
 */
export function resolveProductRoot(
  runtimeRoot = process.env.ARFORGE_AGENT_RUNTIME_ROOT,
  workingDirectory = process.cwd(),
) {
  return path.resolve(runtimeRoot || workingDirectory)
}
