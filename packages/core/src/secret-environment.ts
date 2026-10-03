const PROTECTED_NAMES = new Set([
  "ARFORGE_SECRET_MASTER_KEY",
  "ARFORGE_AUTH_CONTENT",
  "ARFORGE_DB_URL",
  "ARFORGE_DB_ADMIN_URL",
])

/**
 * Values needed to launch a local process, but which do not normally grant it
 * access to the parent process's credentials or control plane. Keep this
 * deliberately small: third-party MCP servers receive only this baseline plus
 * values that the user explicitly configured for that server.
 */
const CHILD_RUNTIME_ENVIRONMENT_ALLOWLIST = new Set([
  "APPDATA",
  "COMSPEC",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
])

export function isProtectedSecretEnvironmentKey(name: string): boolean {
  return PROTECTED_NAMES.has(name.toUpperCase())
}

/**
 * Builds the baseline environment for an explicitly configured third-party
 * child process. It never inherits arbitrary process variables: credentials
 * must be supplied through the caller's explicit overrides instead.
 */
export function allowlistedChildEnvironment(
  input: NodeJS.ProcessEnv | undefined,
  overrides: Readonly<Record<string, string | undefined>> | undefined = undefined,
): Record<string, string> {
  const environment: Record<string, string> = {}

  for (const [name, value] of Object.entries(input ?? {})) {
    if (value === undefined) continue
    const key = name.toUpperCase()
    if (isProtectedSecretEnvironmentKey(key) || !CHILD_RUNTIME_ENVIRONMENT_ALLOWLIST.has(key)) continue
    environment[name] = value
  }

  // These values belong to the configured MCP server rather than to the
  // ambient parent environment. Preserve them exactly as requested, except
  // for Arforge control-plane credentials, which must never leave the host.
  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (isProtectedSecretEnvironmentKey(name)) continue
    const existing = Object.keys(environment).find((candidate) => candidate.toUpperCase() === name.toUpperCase())
    if (existing) delete environment[existing]
    if (value !== undefined) environment[name] = value
  }

  return environment
}

/** Removes Arforge control-plane secrets before any child or Agent tool process starts. */
export function sanitizeChildEnvironment(input: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv | undefined {
  if (!input) return input
  return Object.fromEntries(Object.entries(input).filter(([name]) => !isProtectedSecretEnvironmentKey(name)))
}
