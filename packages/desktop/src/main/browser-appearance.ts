import { browserStartLocales, type BrowserStartLocale } from "./browser-start-page-copy"

export type WorkbenchBrowserAppearance = {
  mode: "light" | "dark"
  locale: BrowserStartLocale
}

const defaults: WorkbenchBrowserAppearance = { mode: "light", locale: "en" }
const appearances = new WeakMap<object, WorkbenchBrowserAppearance>()
const observers = new WeakMap<object, Set<(appearance: WorkbenchBrowserAppearance) => void>>()

export function requireBrowserStartLocale(value: unknown): BrowserStartLocale {
  if (typeof value !== "string" || !browserStartLocales.includes(value as BrowserStartLocale)) {
    throw new TypeError("Invalid browser interface locale")
  }
  return value as BrowserStartLocale
}

export function getWorkbenchBrowserAppearance(owner: object): WorkbenchBrowserAppearance {
  return { ...(appearances.get(owner) ?? defaults) }
}

export function setWorkbenchBrowserAppearance(
  owner: object,
  next: { mode: "light" | "dark"; locale?: string },
) {
  const previous = getWorkbenchBrowserAppearance(owner)
  const appearance: WorkbenchBrowserAppearance = {
    mode: next.mode,
    locale: next.locale === undefined ? previous.locale : requireBrowserStartLocale(next.locale),
  }
  if (previous.mode === appearance.mode && previous.locale === appearance.locale) return
  appearances.set(owner, appearance)
  for (const observer of [...(observers.get(owner) ?? [])]) observer({ ...appearance })
}

export function observeWorkbenchBrowserAppearance(
  owner: object,
  observer: (appearance: WorkbenchBrowserAppearance) => void,
) {
  let subscribers = observers.get(owner)
  if (!subscribers) {
    subscribers = new Set()
    observers.set(owner, subscribers)
  }
  subscribers.add(observer)
  return () => {
    subscribers.delete(observer)
    if (subscribers.size === 0) observers.delete(owner)
  }
}
