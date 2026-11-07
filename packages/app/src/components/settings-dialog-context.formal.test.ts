import { expect, test } from "bun:test"
import { settingsReturnTarget, settingsRoute } from "./settings-dialog-context"

test("settings keeps the current unified-home draft, history and legacy draft return targets", () => {
  expect(settingsReturnTarget("/?draftId=draft-1&ignored=other")).toBe("/?draftId=draft-1")
  expect(settingsReturnTarget("/new-session?draftId=old-1")).toBe("/new-session?draftId=old-1")
  expect(settingsReturnTarget("/")).toBe("/")
  expect(settingsReturnTarget("/?history=1")).toBe("/?history=1")
  expect(settingsReturnTarget("/?archived=1")).toBe("/?archived=1")
  expect(settingsRoute(undefined, "/?draftId=draft-1")).toBe("/settings?returnTo=%2F%3FdraftId%3Ddraft-1")
})

test("settings return links cannot substitute an external URL or another session owner", () => {
  for (const target of ["https://external.invalid/", "//external.invalid/", "/?returnTo=https://external.invalid", "/settings?draftId=draft-1", "/new-session?draftId=%20"])
    expect(settingsReturnTarget(target)).toBeUndefined()
  expect(settingsRoute("ses_first", "/server/local/session/ses_second")).toBe("/settings?sessionID=ses_first")
})
