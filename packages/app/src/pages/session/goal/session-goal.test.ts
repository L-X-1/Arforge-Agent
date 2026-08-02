import { describe, expect, test } from "bun:test"
import type { OperationsApi } from "@/utils/server"
import { sessionGoalText } from "./session-goal-text"
import { startSessionGoal } from "./session-goal-controller"

const locales = [
  "en",
  "zh",
  "zht",
  "ko",
  "de",
  "es",
  "fr",
  "da",
  "ja",
  "pl",
  "ru",
  "uk",
  "ar",
  "no",
  "br",
  "th",
  "bs",
  "tr",
] as const

describe("session Goal mode", () => {
  test("creates and immediately runs a newly active durable Goal", async () => {
    const calls: unknown[] = []
    const api = {
      create: async (input: unknown) => {
        calls.push(["create", input])
        return { id: "gol_active", revision: 3, status: "active" }
      },
      run: async (input: unknown) => {
        calls.push(["run", input])
        return {}
      },
    } as unknown as OperationsApi["goals"]

    await startSessionGoal(api, { sessionID: "ses_1", objective: "完成前后端验收" })

    expect(calls).toEqual([
      ["create", { sessionID: "ses_1", objective: "完成前后端验收", queue: false }],
      ["run", { sessionID: "ses_1", goalID: "gol_active", expectedRevision: 3 }],
    ])
  })

  test("does not run a Goal that the server placed behind an existing active Goal", async () => {
    let runs = 0
    const api = {
      create: async () => ({ id: "gol_queued", revision: 1, status: "queued" }),
      run: async () => {
        runs += 1
        return {}
      },
    } as unknown as OperationsApi["goals"]

    await startSessionGoal(api, { sessionID: "ses_1", objective: "第二个目标" })
    expect(runs).toBe(0)
  })

  test("ships native copy for every supported locale with placeholder parity", () => {
    expect(Object.keys(sessionGoalText).sort()).toEqual([...locales].sort())
    const keys = Object.keys(sessionGoalText.en).sort()
    for (const locale of locales) {
      const copy = sessionGoalText[locale]
      expect(Object.keys(copy).sort()).toEqual(keys)
      expect(Object.keys(copy.status).sort()).toEqual(Object.keys(sessionGoalText.en.status).sort())
      expect(copy.cancelConfirm).toContain("{{objective}}")
      expect(copy.menuDescription.trim().length).toBeGreaterThan(10)
      if (locale !== "en") expect(copy.menuDescription).not.toBe(sessionGoalText.en.menuDescription)
    }
  })
})
