import { describe, expect, test } from "bun:test"
import { workspaceExpansionKeys, workspaceExpansionValue } from "./workspace-expansion"

describe("sidebar workspace expansion persistence", () => {
  test("isolates the same workspace key by project", () => {
    const first = workspaceExpansionKeys("C:\\projects\\one", "C:\\shared\\sandbox")
    const second = workspaceExpansionKeys("C:\\projects\\two", "C:\\shared\\sandbox")
    const state = {
      [first.project]: { [first.directory]: true },
      [second.project]: { [second.directory]: false },
    }

    expect(
      workspaceExpansionValue({
        byProject: state,
        project: "C:\\projects\\one",
        directory: "C:\\shared\\sandbox",
        local: false,
      }),
    ).toBe(true)
    expect(
      workspaceExpansionValue({
        byProject: state,
        project: "C:\\projects\\two",
        directory: "C:\\shared\\sandbox",
        local: false,
      }),
    ).toBe(false)
  })

  test("uses legacy state as a migration fallback", () => {
    expect(
      workspaceExpansionValue({
        legacy: { "C:\\projects\\one\\sandbox": true },
        project: "C:\\projects\\one",
        directory: "C:\\projects\\one\\sandbox",
        local: false,
      }),
    ).toBe(true)
  })

  test("defaults only the local workspace to expanded", () => {
    expect(
      workspaceExpansionValue({
        project: "/projects/one",
        directory: "/projects/one",
        local: true,
      }),
    ).toBe(true)
    expect(
      workspaceExpansionValue({
        project: "/projects/one",
        directory: "/projects/one/sandbox",
        local: false,
      }),
    ).toBe(false)
  })
})
