import { describe, expect, test } from "bun:test"
import { hasOperationDirectory, isMissingTeam, resolveOperationLocation } from "./session-operation-boundary"

describe("session operation boundary", () => {
  test("uses the current workspace for imported sessions without a recorded directory", () => {
    expect(resolveOperationLocation({ directory: "" }, " E:\\Arforge-Agent ")).toEqual({
      directory: "E:\\Arforge-Agent",
    })
  })

  test("preserves a session-owned directory and workspace", () => {
    expect(
      resolveOperationLocation(
        { directory: "E:\\worktree", workspaceID: "workspace-1" },
        "E:\\Arforge-Agent",
      ),
    ).toEqual({
      directory: "E:\\worktree",
      workspace: "workspace-1",
    })
  })

  test("rejects empty operation locations and recognizes the Core team empty state", () => {
    expect(hasOperationDirectory({ location: { directory: " " } })).toBe(false)
    expect(hasOperationDirectory({ location: { directory: "E:\\Arforge-Agent" } })).toBe(true)
    expect(isMissingTeam({ _tag: "Team.NotFoundError" })).toBe(true)
    expect(isMissingTeam({ _tag: "TeamNotFoundError" })).toBe(true)
    expect(isMissingTeam({ _tag: "Session.NotFoundError" })).toBe(false)
  })
})
