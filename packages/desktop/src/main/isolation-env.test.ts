import { describe, expect, test } from "bun:test"
import { isAbsolute, relative, resolve } from "node:path"
import { isolatedRuntimeEnv, shouldRunLegacyProfileMigration } from "./isolation-env"

describe("isolatedRuntimeEnv", () => {
  test("keeps every runtime data directory inside the acceptance profile", () => {
    const root = resolve("C:/acceptance/arforge-profile")
    const env = isolatedRuntimeEnv(root)

    expect(Object.keys(env).toSorted()).toEqual(
      [
        "APPDATA",
        "ARFORGE_HOME",
        "ARFORGE_TEST_HOME",
        "LOCALAPPDATA",
        "XDG_CACHE_HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_STATE_HOME",
      ].toSorted(),
    )
    for (const value of Object.values(env)) {
      expect(isAbsolute(value)).toBe(true)
      expect(relative(root, value).startsWith("..")).toBe(false)
    }
  })

  test("disables legacy profile import for isolated acceptance", () => {
    expect(
      shouldRunLegacyProfileMigration({ isolatedAcceptance: true, onboardingTest: false }),
    ).toBe(false)
    expect(
      shouldRunLegacyProfileMigration({ isolatedAcceptance: false, onboardingTest: true }),
    ).toBe(false)
    expect(
      shouldRunLegacyProfileMigration({ isolatedAcceptance: false, onboardingTest: false }),
    ).toBe(true)
  })
})
