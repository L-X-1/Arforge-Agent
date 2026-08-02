import { describe, expect, test } from "bun:test"
import { controlCenterMessageKeys } from "../components/control-center/control-center-text"

const appLocales = [
  "ar",
  "br",
  "bs",
  "da",
  "de",
  "es",
  "fr",
  "ja",
  "ko",
  "no",
  "pl",
  "ru",
  "uk",
  "th",
  "tr",
  "zh",
  "zht",
] as const
const desktopLocales = appLocales.filter((locale) => locale !== "th" && locale !== "tr")

const domains = [
  {
    name: "app",
    source: "./en.ts",
    target: (locale: string) => `./${locale}.ts`,
    locales: appLocales,
  },
  {
    name: "ui",
    source: "../../../ui/src/i18n/en.ts",
    target: (locale: string) => `../../../ui/src/i18n/${locale}.ts`,
    locales: appLocales,
  },
  {
    name: "desktop",
    source: "../../../desktop/src/renderer/i18n/en.ts",
    target: (locale: string) => `../../../desktop/src/renderer/i18n/${locale}.ts`,
    locales: desktopLocales,
  },
] as const

describe.skipIf(!!process.env.CI)("i18n parity", () => {
  test("non-English locales have every English key", async () => {
    for (const domain of domains) {
      const source = await dictionary(domain.source)
      for (const locale of domain.locales) {
        const target = await dictionary(domain.target(locale))
        const missing = Object.keys(source).filter((key) => !Object.hasOwn(target, key))
        const extra = Object.keys(target).filter((key) => !Object.hasOwn(source, key))
        expect({ domain: domain.name, locale, missing, extra }).toEqual({
          domain: domain.name,
          locale,
          missing: [],
          extra: [],
        })
      }
    }
  })

  test("non-English locales preserve English placeholders", async () => {
    for (const domain of domains) {
      const source = await dictionary(domain.source)
      for (const locale of domain.locales) {
        const target = await dictionary(domain.target(locale))
        const mismatched = Object.keys(source).filter(
          (key) => Object.hasOwn(target, key) && placeholders(source[key]).join() !== placeholders(target[key]).join(),
        )
        expect({ domain: domain.name, locale, mismatched }).toEqual({ domain: domain.name, locale, mismatched: [] })
      }
    }
  })

  test("control-center translations preserve Arforge professional terms", async () => {
    const source = await dictionary("./en.ts")
    const terms = [
      "Arforge",
      "Provider",
      "Server",
      "Agent",
      "Session",
      "Memory",
      "Learning",
      "Workflow",
      "Plugin",
      "Skill",
      "Hook",
      "Bridge",
      "Trace",
      "Plan",
      "API",
      "CLI",
      "JSON",
      "MRR",
      "Top-1",
      "PostgreSQL",
      "Git worktree",
      "Project Copy",
    ]
    const entries = Object.entries(source).filter(([key]) => key.startsWith("controlCenter."))

    for (const locale of appLocales) {
      const target = await dictionary(`./${locale}.ts`)
      const missing = entries.flatMap(([key, value]) =>
        terms
          .filter((term) => professionalTerm(value, term) && !target[key]?.includes(term))
          .map((term) => `${key}:${term}`),
      )
      expect({ locale, missing }).toEqual({ locale, missing: [] })
    }
  })

  test("control-center source messages map to the matching source-locale entries", async () => {
    const en = await dictionary("./en.ts")
    const zh = await dictionary("./zh.ts")
    const mismatched = Object.entries(controlCenterMessageKeys).flatMap(([message, key]) => {
      const expected = /[\p{Script=Han}]/u.test(message) ? zh[key] : en[key]
      return expected === message ? [] : [`${message} -> ${key} -> ${expected}`]
    })
    expect(mismatched).toEqual([])
  })

  test("non-English locales translate targeted unseen session keys", async () => {
    const source = await dictionary("./en.ts")
    for (const locale of appLocales) {
      const target = await dictionary(`./${locale}.ts`)
      for (const key of ["command.session.previous.unseen", "command.session.next.unseen"]) {
        expect(target[key]).toBeDefined()
        expect(target[key]).not.toBe(source[key])
      }
    }
  })

  test("changed-file summary keys preserve rendered English copy and localize complete phrases", async () => {
    const source = await dictionary("../../../ui/src/i18n/en.ts")
    expect(source["ui.sessionTurn.diffs.changed.one"].replace("{{count}}", "1")).toBe("1 Changed file")
    expect(source["ui.sessionTurn.diffs.changed.other"].replace("{{count}}", "2")).toBe("2 Changed files")
    expect(source["ui.sessionTurn.diffs.changed"]).toBeUndefined()

    for (const locale of appLocales) {
      const target = await dictionary(`../../../ui/src/i18n/${locale}.ts`)
      for (const key of ["ui.sessionTurn.diffs.changed.one", "ui.sessionTurn.diffs.changed.other"]) {
        expect(target[key].trim()).not.toBe("")
        expect(placeholders(target[key])).toEqual(["count"])
      }
    }
  })
})

async function dictionary(file: string) {
  const module: unknown = await import(file)
  if (typeof module !== "object" || module === null || !("dict" in module) || !isDictionary(module.dict)) {
    throw new Error(`Invalid translation dictionary: ${file}`)
  }
  return module.dict
}

function isDictionary(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  return Object.values(value).every((item) => typeof item === "string")
}

function placeholders(value: string) {
  return Array.from(value.matchAll(/{{\s*([^}]+?)\s*}}/g), (match) => match[1]).sort()
}

function professionalTerm(value: string, term: string) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`).test(value)
}
