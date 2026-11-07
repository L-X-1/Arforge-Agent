import { expect, test } from "bun:test"
import path from "node:path"
import { desktopProfile } from "./profile"

test("normal prod retains its established profile without copying dev or QA data", () => {
  const appData = path.resolve("owned-app-data")
  expect(desktopProfile({ appData, appId: "ai.arforge.desktop" })).toEqual({
    userData: path.join(appData, "ai.arforge.desktop"),
    sessionData: undefined,
    documents: undefined,
  })
})

test("standard absolute portable override owns both Desktop and Chromium session data", () => {
  const root = path.resolve("owned-portable")
  const profile = desktopProfile({
    appData: path.resolve("unused"),
    appId: "ai.arforge.desktop",
    commandLineUserData: root,
    environmentUserData: path.resolve("lower-priority"),
  })
  expect(profile).toEqual({
    userData: root,
    sessionData: path.join(root, "session"),
    documents: path.join(root, "documents"),
  })
  expect(desktopProfile({ appData: "unused", appId: "unused", environmentUserData: root })).toEqual(profile)
})

test("relative portable overrides fail before any user store is selected", () => {
  expect(() => desktopProfile({ appData: "unused", appId: "unused", commandLineUserData: "relative/profile" })).toThrow(
    "absolute",
  )
  expect(() => desktopProfile({ appData: "unused", appId: "unused", environmentUserData: "../profile" })).toThrow(
    "absolute",
  )
})
