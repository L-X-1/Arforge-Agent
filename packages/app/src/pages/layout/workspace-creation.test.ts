import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import {
  runWorkspaceCreation,
  workspaceCreationAnnouncement,
  workspaceCreationCommandDisabled,
} from "./workspace-creation"

const layoutSource = readFileSync(new URL("../layout.tsx", import.meta.url), "utf8")

describe("workspace creation gate", () => {
  test("suppresses duplicate work for the same project while preserving pending feedback", async () => {
    const pending = new Set<string>()
    const changes: boolean[] = []
    let calls = 0
    let resolve!: (value: string) => void

    const first = runWorkspaceCreation(
      pending,
      "project",
      () => {
        calls += 1
        return new Promise<string>((done) => {
          resolve = done
        })
      },
      (_key, value) => changes.push(value),
    )

    const duplicate = await runWorkspaceCreation(
      pending,
      "project",
      async () => {
        calls += 1
        return "duplicate"
      },
      (_key, value) => changes.push(value),
    )

    expect(duplicate).toBeUndefined()
    expect(calls).toBe(1)
    expect(changes).toEqual([true])

    resolve("created")
    expect(await first).toBe("created")
    expect(changes).toEqual([true, false])
    expect(pending.size).toBe(0)
  })

  test("releases the project after failure so the action can be retried", async () => {
    const pending = new Set<string>()
    const changes: boolean[] = []

    await expect(
      runWorkspaceCreation(
        pending,
        "project",
        async () => {
          throw new Error("failed")
        },
        (_key, value) => changes.push(value),
      ),
    ).rejects.toThrow("failed")

    expect(
      await runWorkspaceCreation(
        pending,
        "project",
        async () => "retried",
        (_key, value) => changes.push(value),
      ),
    ).toBe("retried")
    expect(changes).toEqual([true, false, true, false])
  })

  test("disables every command entry while creation is unavailable or pending", () => {
    expect(workspaceCreationCommandDisabled(false, false)).toBeTrue()
    expect(workspaceCreationCommandDisabled(true, true)).toBeTrue()
    expect(workspaceCreationCommandDisabled(true, false)).toBeFalse()
    expect(layoutSource).toContain(
      "disabled: workspaceCreationCommandDisabled(workspaceSetting(), currentWorkspaceCreating()),",
    )
  })

  test("announces only while workspace creation is pending", () => {
    expect(workspaceCreationAnnouncement(true, "Creating workspace")).toBe("Creating workspace")
    expect(workspaceCreationAnnouncement(false, "Creating workspace")).toBe("")
  })
})
