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


describe("approved V2 startup preferences", () => {
  const systemDark = () => {
    Object.defineProperty(window, "matchMedia", {
      value: () => ({ matches: true }) as MediaQueryList,
      configurable: true,
    })
  }

  test("an unset preference stays warm light even on a dark operating system", () => {
    systemDark()
    run()
    expect(document.documentElement.dataset.colorScheme).toBe("light")
    expect(["#FAFAF7", "rgb(250, 250, 247)"]).toContain(document.documentElement.style.backgroundColor)
    expect(localStorage.getItem("arforge-color-scheme")).toBeNull()
  })

  test("explicit system mode still follows the operating system", () => {
    systemDark()
    localStorage.setItem("arforge-color-scheme", "system")
    run()
    expect(document.documentElement.dataset.colorScheme).toBe("dark")
    expect(localStorage.getItem("arforge-color-scheme")).toBe("system")
  })

  test("explicit dark mode uses graphite before the application mounts", () => {
    localStorage.setItem("arforge-color-scheme", "dark")
    document.head.innerHTML = '<meta name="theme-color" content="#fff">'
    run()
    expect(document.documentElement.dataset.colorScheme).toBe("dark")
    expect(["#1C1D1B", "rgb(28, 29, 27)"]).toContain(document.documentElement.style.backgroundColor)
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#1C1D1B")
  })

  test("an invalid saved scheme is safe without rewriting the user's stored value", () => {
    localStorage.setItem("arforge-color-scheme", "invalid")
    run()
    expect(document.documentElement.dataset.colorScheme).toBe("light")
    expect(localStorage.getItem("arforge-color-scheme")).toBe("invalid")
  })

  test("custom dark theme css remains available at startup", () => {
    localStorage.setItem("arforge-theme-id", "nightowl")
    localStorage.setItem("arforge-color-scheme", "dark")
    localStorage.setItem("arforge-theme-css-dark", "--background-base:#123456;")
    run()
    expect(document.documentElement.dataset.theme).toBe("nightowl")
    expect(document.getElementById("arforge-theme-preload")?.textContent).toContain("--background-base:#123456;")
  })
})
