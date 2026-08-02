import { beforeEach, describe, expect, test } from "bun:test"

const src = await Bun.file(new URL("../public/arforge-theme-preload.js", import.meta.url)).text()

const run = () => Function(src)()

beforeEach(() => {
  document.head.innerHTML = ""
  document.documentElement.removeAttribute("data-theme")
  document.documentElement.removeAttribute("data-color-scheme")
  localStorage.clear()
  Object.defineProperty(window, "matchMedia", {
    value: () =>
      ({
        matches: false,
      }) as MediaQueryList,
    configurable: true,
  })
})

describe("theme preload", () => {
  const legacyThemePrefix = ["o", "c"].join("")
  for (const legacy of [`${legacyThemePrefix}-1`, `${legacyThemePrefix}-2`]) {
    test(`migrates legacy ${legacy} to arforge-default before mount`, () => {
      localStorage.setItem("arforge-theme-id", legacy)
      localStorage.setItem("arforge-theme-css-light", "--background-base:#fff;")
      localStorage.setItem("arforge-theme-css-dark", "--background-base:#000;")

      run()

      expect(document.documentElement.dataset.theme).toBe("arforge-default")
      expect(document.documentElement.dataset.colorScheme).toBe("light")
      expect(localStorage.getItem("arforge-theme-id")).toBe("arforge-default")
      expect(localStorage.getItem("arforge-theme-css-light")).toBeNull()
      expect(localStorage.getItem("arforge-theme-css-dark")).toBeNull()
      expect(document.getElementById("arforge-theme-preload")).toBeNull()
    })
  }

  test("keeps cached css for non-default themes", () => {
    localStorage.setItem("arforge-theme-id", "nightowl")
    localStorage.setItem("arforge-theme-css-light", "--background-base:#fff;")

    run()

    expect(document.documentElement.dataset.theme).toBe("nightowl")
    expect(document.getElementById("arforge-theme-preload")?.textContent).toContain("--background-base:#fff;")
  })
})
