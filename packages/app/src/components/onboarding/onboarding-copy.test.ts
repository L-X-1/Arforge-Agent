import { describe, expect, test } from "bun:test"
import { onboardingCopy, onboardingLocale } from "./onboarding-copy"

describe("Arforge onboarding copy", () => {
  test("uses simplified and traditional Chinese explicitly", () => {
    expect(onboardingLocale("zh")).toBe("zh")
    expect(onboardingLocale("zht")).toBe("zht")
    expect(onboardingCopy("zh").title).toContain("三步")
    expect(onboardingCopy("zht").title).toContain("三步")
  })

  test("falls back to English and provides three user-level examples", () => {
    expect(onboardingLocale("fr")).toBe("en")
    expect(onboardingCopy("fr").examples).toHaveLength(3)
  })

  test("distinguishes automatic work from human decisions", () => {
    const value = onboardingCopy("zh")
    expect(value.automatic).toBe("自动")
    expect(value.manual).toBe("人工")
    expect(value.manualText).toContain("允许或拒绝")
  })
})
