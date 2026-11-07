import { afterEach, describe, expect, test } from "bun:test"
import {
  bindTerminalContainerFocus,
  disposeIfDisposable,
  getHoveredLinkText,
  getSpeechRecognitionCtor,
  hasSetOption,
  isDisposable,
  setOptionIfSupported,
} from "./runtime-adapters"

const focusFixtures: HTMLElement[] = []
afterEach(() => {
  for (const element of focusFixtures.splice(0)) element.remove()
})
const terminalFixture = () => {
  const container = document.createElement("div")
  container.tabIndex = -1
  const input = document.createElement("textarea")
  const canvas = document.createElement("canvas")
  const other = document.createElement("button")
  container.append(input, canvas, other)
  document.body.append(container)
  focusFixtures.push(container)
  return { container, input, canvas, other }
}

describe("terminal container focus handoff", () => {
  test("retains the real input after the mouse selection handler focuses its container", () => {
    const { container, input, canvas } = terminalFixture()
    const unbind = bindTerminalContainerFocus(container, () => input.focus())
    container.addEventListener("pointerdown", () => input.focus())
    canvas.addEventListener("mousedown", () => container.focus())
    canvas.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }))
    expect(document.activeElement).toBe(input)
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true })
    canvas.dispatchEvent(down)
    expect(document.activeElement).toBe(input)
    expect(down.defaultPrevented).toBe(false)
    unbind()
  })

  test("does not intercept a descendant control's focus", () => {
    const { container, input, other } = terminalFixture()
    let calls = 0
    const unbind = bindTerminalContainerFocus(container, () => { calls++; input.focus() })
    other.focus()
    expect(document.activeElement).toBe(other)
    expect(calls).toBe(0)
    unbind()
  })

  test("does not schedule a later focus that can steal a new edit intent", async () => {
    const { container, input, other } = terminalFixture()
    const unbind = bindTerminalContainerFocus(container, () => input.focus())
    container.focus()
    expect(document.activeElement).toBe(input)
    other.focus()
    await new Promise<void>((done) => setTimeout(done, 0))
    expect(document.activeElement).toBe(other)
    unbind()
  })

  test("removes the handoff when the terminal is disposed", () => {
    const { container, input } = terminalFixture()
    let calls = 0
    const unbind = bindTerminalContainerFocus(container, () => { calls++; input.focus() })
    container.focus()
    expect(document.activeElement).toBe(input)
    expect(calls).toBe(1)
    unbind()
    container.focus()
    expect(document.activeElement).toBe(container)
    expect(calls).toBe(1)
  })
})

describe("runtime adapters", () => {
  test("detects and disposes disposable values", () => {
    let count = 0
    const value = {
      dispose: () => {
        count += 1
      },
    }
    expect(isDisposable(value)).toBe(true)
    disposeIfDisposable(value)
    expect(count).toBe(1)
  })

  test("ignores non-disposable values", () => {
    expect(isDisposable({ dispose: "nope" })).toBe(false)
    expect(() => disposeIfDisposable({ dispose: "nope" })).not.toThrow()
  })

  test("sets options only when setter exists", () => {
    const calls: Array<[string, unknown]> = []
    const value = {
      setOption: (key: string, next: unknown) => {
        calls.push([key, next])
      },
    }
    expect(hasSetOption(value)).toBe(true)
    setOptionIfSupported(value, "fontFamily", "Berkeley Mono")
    expect(calls).toEqual([["fontFamily", "Berkeley Mono"]])
    expect(() => setOptionIfSupported({}, "fontFamily", "Berkeley Mono")).not.toThrow()
  })

  test("reads hovered link text safely", () => {
    expect(getHoveredLinkText({ currentHoveredLink: { text: "https://example.com" } })).toBe("https://example.com")
    expect(getHoveredLinkText({ currentHoveredLink: { text: 1 } })).toBeUndefined()
    expect(getHoveredLinkText(null)).toBeUndefined()
  })

  test("resolves speech recognition constructor with webkit precedence", () => {
    // oxlint-disable-next-line no-extraneous-class
    class SpeechCtor {}
    // oxlint-disable-next-line no-extraneous-class
    class WebkitCtor {}
    const ctor = getSpeechRecognitionCtor({
      SpeechRecognition: SpeechCtor,
      webkitSpeechRecognition: WebkitCtor,
    })
    expect(ctor).toBe(WebkitCtor)
  })

  test("returns undefined when no valid speech constructor exists", () => {
    expect(getSpeechRecognitionCtor({ SpeechRecognition: "nope" })).toBeUndefined()
    expect(getSpeechRecognitionCtor(undefined)).toBeUndefined()
  })
})
