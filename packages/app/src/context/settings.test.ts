import { describe, expect, test } from "bun:test"
import { SOUND_OPTIONS, resolveSoundPreference, soundSrc } from "@/utils/sound"
import {
  hasExistingWebState,
  isAppUpgrade,
  layoutTransitionState,
  maximumSunsetTimeout,
  newLayoutDesignsDefault,
  nextSunsetCheckDelay,
  resolveNewLayoutDesigns,
  shouldDisplayTabsToast,
  shouldEnableNewLayout,
  sansFontFamily,
  sansUnsetDefault,
  monoFontFamily,
  monoUnsetDefault,
} from "./settings"

describe("notification sound preferences", () => {
  test("offers all 12 bundled cues in palette order", async () => {
    expect(SOUND_OPTIONS.map((option) => option.id)).toEqual([
      "soft-glass-complete.wav",
      "soft-glass-permission.wav",
      "soft-glass-error.wav",
      "warm-wood-complete.wav",
      "warm-wood-permission.wav",
      "warm-wood-error.wav",
      "minimal-electronic-complete.wav",
      "minimal-electronic-permission.wav",
      "minimal-electronic-error.wav",
      "soft-piano-complete.wav",
      "soft-piano-permission.wav",
      "soft-piano-error.wav",
    ])
    for (const { id } of SOUND_OPTIONS) {
      const asset = Bun.file(new URL(`../../../ui/src/assets/audio/${id}`, import.meta.url))
      expect(await asset.exists()).toBe(true)
    }
  })

  test("maps legacy preferences to Soft Glass and preserves explicit choices across palettes", async () => {
    for (const fallback of ["soft-glass-complete.wav", "soft-glass-permission.wav", "soft-glass-error.wav"] as const) {
      for (const legacy of ["alert-10", "bip-bop-10", "staplebops-07", "nope-12", "yup-06"]) {
        expect(resolveSoundPreference(legacy, fallback)).toBe(fallback)
      }
      expect(resolveSoundPreference(undefined, fallback)).toBe(fallback)
      for (const { id } of SOUND_OPTIONS) {
        expect(resolveSoundPreference(id, fallback)).toBe(id)
      }
      expect(resolveSoundPreference("none", fallback)).toBe("none")
      expect(resolveSoundPreference("nope-13", fallback)).toBe("none")
      expect(resolveSoundPreference(["alert-01"], fallback)).toBe("none")
    }
    expect(await soundSrc("none")).toBeUndefined()
    expect(await soundSrc("constructor")).toBeUndefined()
  })
})

describe("layout transition", () => {
  test("blank profiles default to the new layout", () => {
    expect(newLayoutDesignsDefault).toBe(true)
  })

  test("hides the transition until a sunset is scheduled", () => {
    expect(layoutTransitionState(false, true, false, false)).toEqual({ available: false, notice: false })
  })

  test("existing profiles can switch before sunset", () => {
    expect(layoutTransitionState(true, true, false, false)).toEqual({ available: true, notice: false })
  })

  test("classifies web profiles from existing settings or a recorded version", () => {
    expect(hasExistingWebState("{}", undefined)).toBe(true)
    expect(hasExistingWebState(null, "1.17.19")).toBe(true)
    expect(hasExistingWebState(null, undefined)).toBe(false)
  })

  test("preserves explicit and default layout preferences", () => {
    expect(resolveNewLayoutDesigns(false, false, true)).toBe(false)
    expect(resolveNewLayoutDesigns(false, undefined, false)).toBe(false)
    expect(resolveNewLayoutDesigns(false, undefined, true)).toBe(true)
  })

  test("sunset replaces the toggle with a dismissible notice", () => {
    expect(layoutTransitionState(true, true, true, false)).toEqual({ available: false, notice: true })
    expect(layoutTransitionState(true, true, true, true)).toEqual({ available: false, notice: false })
    expect(resolveNewLayoutDesigns(true, false)).toBe(true)
  })

  test("caps checks for sunsets beyond the browser timeout limit", () => {
    expect(nextSunsetCheckDelay(maximumSunsetTimeout + 1_000, 0)).toBe(maximumSunsetTimeout)
    expect(nextSunsetCheckDelay(10_000, 9_000)).toBe(1_000)
    expect(nextSunsetCheckDelay(9_000, 10_000)).toBe(0)
  })

  test("enables the new layout when upgrading from 1.17.19 or earlier", () => {
    expect(shouldEnableNewLayout("v1.17.19", "1.17.20")).toBe(true)
    expect(shouldEnableNewLayout("1.16.9", "2.0.0")).toBe(true)
  })

  test("enables the new layout when no previous version was recorded", () => {
    expect(shouldEnableNewLayout(undefined, "1.17.20")).toBe(true)
  })

  test("detects upgrades only when a previous version is older", () => {
    expect(isAppUpgrade("1.17.19", "1.17.20")).toBe(true)
    expect(isAppUpgrade(undefined, "1.17.20")).toBe(false)
    expect(isAppUpgrade("1.17.20", "1.17.20")).toBe(false)
    expect(isAppUpgrade("1.17.21", "1.17.20")).toBe(false)
  })

  test("shows the tabs toast for upgrades and existing installs without a recorded version", () => {
    expect(shouldDisplayTabsToast("1.17.19", "1.17.20", false)).toBe(true)
    expect(shouldDisplayTabsToast(undefined, "1.17.20", true)).toBe(true)
    expect(shouldDisplayTabsToast(undefined, "1.17.20", false)).toBe(false)
  })

  test("does not enable the new layout without a qualifying upgrade", () => {
    expect(shouldEnableNewLayout("1.17.19", "1.17.19")).toBe(false)
    expect(shouldEnableNewLayout("1.17.20", "1.17.21")).toBe(false)
    expect(shouldEnableNewLayout(undefined, "1.17.19")).toBe(false)
    expect(shouldEnableNewLayout("dev", "1.17.20")).toBe(false)
  })
})

describe("V2 font preference defaults", () => {
  test("uses bundled code font only for absent preference and retains explicit system/custom fonts", () => {
    expect(monoUnsetDefault).toBe("JetBrains Mono")
    expect(monoFontFamily(undefined)).toStartWith('"JetBrains Mono", ')
    expect(monoFontFamily("")).not.toContain("JetBrains Mono")
    expect(monoFontFamily("   ")).not.toContain("JetBrains Mono")
    expect(monoFontFamily("User Mono")).toStartWith('"User Mono", ')
  })
  test("uses the bundled UI family only for an unset preference", () => {
    expect(sansUnsetDefault).toBe("Noto Sans SC")
    expect(sansFontFamily(undefined)).toStartWith('"Noto Sans SC", ')
  })

  test("preserves explicit system and named preferences", () => {
    expect(sansFontFamily("")).not.toContain("Noto Sans SC")
    expect(sansFontFamily("   ")).not.toContain("Noto Sans SC")
    expect(sansFontFamily("User Font")).toStartWith('"User Font", ')
    expect(sansFontFamily("Noto Serif SC")).toStartWith('"Noto Serif SC", ')
  })
})
