import { expect, test } from "bun:test"
import { runInNewContext } from "node:vm"
import { workbenchBrowserStartPage } from "./browser-start-page"
import { normalizeWorkbenchBrowserUrl } from "@arforge-ai/app/browser-workbench"

function startPage() {
  const doc = new DOMParser().parseFromString(workbenchBrowserStartPage("address123"), "text/html")
  const navigations: string[] = []
  runInNewContext(doc.querySelector("script")!.textContent!, {
    document: doc, URL, URLSearchParams,
    location: { assign: (url: string) => navigations.push(url) },
  })
  return {
    input: doc.querySelector<HTMLInputElement>("#address")!,
    form: doc.querySelector<HTMLFormElement>("form")!,
    button: doc.querySelector<HTMLButtonElement>("button")!,
    error: doc.querySelector("#error")!,
    navigations,
  }
}

test("start-page native form validation allows a bare domain before submission", () => {
  const page = startPage()
  page.input.value = "example.com/path?q=x#y"
  expect(page.input.inputMode).toBe("url")
  expect(page.form.checkValidity()).toBe(true)
  page.form.requestSubmit()
  expect(page.navigations).toEqual([normalizeWorkbenchBrowserUrl(page.input.value)])
  expect(page.error.textContent).toBe("")
})

test("the start-page Open button preserves localhost ports, path, query and hash", () => {
  const page = startPage()
  page.input.value = "127.0.0.1:443/path?q=x#section"
  page.button.click()
  expect(page.navigations).toEqual(["http://127.0.0.1:443/path?q=x#section"])
})

test("the generated start-page script accepts a trailing-dot localhost port", () => {
  const page = startPage()
  page.input.value = "localhost.:5173/path?q=x#y"
  page.button.click()
  expect(page.navigations).toEqual(["http://localhost.:5173/path?q=x#y"])
  expect(page.error.textContent).toBe("")
})

test("the generated start-page script preserves the canonical8192 boundary", () => {
  const prefix = "https://example.com/"
  const canonical = prefix + "x".repeat(8192 - prefix.length)
  const page = startPage()
  page.input.value = canonical.slice("https://".length)
  page.form.requestSubmit()
  expect(page.navigations).toEqual([canonical])
  expect(normalizeWorkbenchBrowserUrl(page.navigations[0])).toBe(canonical)
  const oversized = startPage()
  oversized.input.value = "example.com/" + "x".repeat(8192 - "example.com/".length)
  oversized.button.click()
  expect(oversized.navigations).toEqual([])
  expect(oversized.error.textContent).not.toBe("")
})

test("start-page submission and native policy reject the same dangerous addresses", () => {
  for (const value of ["javascript:443", "file:///C:/private", "data:text/html,hello", "ftp://example.com", "example.com/?token=secret", "user:pass@example.com"]) {
    const page = startPage()
    page.input.value = value
    page.form.requestSubmit()
    expect(() => normalizeWorkbenchBrowserUrl(value)).toThrow()
    expect(page.navigations).toEqual([])
    expect(page.error.textContent).not.toBe("")
  }
})
