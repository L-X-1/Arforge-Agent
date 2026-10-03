import { join, relative, resolve } from "node:path"

export type IsolatedRuntimeEnv = Readonly<{
  ARFORGE_HOME: string
  ARFORGE_TEST_HOME: string
  APPDATA: string
  LOCALAPPDATA: string
  XDG_DATA_HOME: string
  XDG_CONFIG_HOME: string
  XDG_CACHE_HOME: string
  XDG_STATE_HOME: string
}>

/** Build a closed local-data boundary for packaged desktop acceptance. */
export function isolatedRuntimeEnv(userDataPath: string): IsolatedRuntimeEnv {
  const root = resolve(userDataPath)
  const env = {
    ARFORGE_HOME: join(root, "runtime"),
    ARFORGE_TEST_HOME: join(root, "home"),
    APPDATA: join(root, "windows", "roaming"),
    LOCALAPPDATA: join(root, "windows", "local"),
    XDG_DATA_HOME: join(root, "xdg", "data"),
    XDG_CONFIG_HOME: join(root, "xdg", "config"),
    XDG_CACHE_HOME: join(root, "xdg", "cache"),
    XDG_STATE_HOME: join(root, "xdg", "state"),
  } as const
  for (const value of Object.values(env)) {
    const path = relative(root, value)
    if (path.startsWith("..") || resolve(root, path) !== resolve(value))
      throw new Error(`Isolated desktop path escaped its user-data root: ${value}`)
  }
  return env
}

/** Legacy profile import must never cross into a disposable acceptance profile. */
export function shouldRunLegacyProfileMigration(options: {
  isolatedAcceptance: boolean
  onboardingTest: boolean
}): boolean {
  return !options.isolatedAcceptance && !options.onboardingTest
}
