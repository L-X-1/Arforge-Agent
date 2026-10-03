import { expect, test } from "bun:test"
import { createComponent, createRoot, createSignal, onCleanup } from "solid-js"
import { ClipboardProvider, useClipboard, type ClipboardService } from "../src/context/clipboard"
import { createSimpleContext } from "../src/context/helper"
import { LocationProvider, useLocation } from "../src/context/location"

test("simple providers initialize before lazy children and preserve nested owners", () => {
  const initialized: string[] = []
  const observed: string[] = []
  const cleaned: string[] = []
  const context = createSimpleContext<{ value: string }, { value: string }>({
    name: "Regression",
    init(props) {
      initialized.push(props.value)
      onCleanup(() => cleaned.push(props.value))
      return { value: props.value }
    },
  })
  function Consumer() {
    const value = context.use().value
    expect(initialized).toContain(value)
    observed.push(value)
    return value
  }

  let dispose = () => {}
  try {
    createRoot((cleanup) => {
      dispose = cleanup
      return createComponent(context.provider, {
        value: "outer",
        get children() {
          return [
            createComponent(Consumer, {}),
            createComponent(context.provider, {
              value: "inner",
              get children() {
                return createComponent(Consumer, {})
              },
            }),
            createComponent(Consumer, {}),
          ]
        },
      })
    })
    expect(initialized).toEqual(["outer", "inner"])
    expect(observed).toEqual(["outer", "inner", "outer"])
    expect(cleaned).toEqual([])
  } finally {
    dispose()
  }
  expect(cleaned.toSorted()).toEqual(["inner", "outer"])
})

test("required contexts still reject consumers outside their provider", () => {
  const context = createSimpleContext({ name: "Regression", init: () => ({ ready: true }) })
  expect(() => context.use()).toThrow("Regression context must be used within a context provider")
  expect(() => useLocation()).toThrow("Location context must be used within a LocationProvider")
})

test("location providers retain the reactive location accessor", () => {
  const first = { directory: "/tmp/arforge/location-first" }
  const second = { directory: "/tmp/arforge/location-second" }
  const [location, setLocation] = createSignal<Parameters<typeof LocationProvider>[0]["location"]>(first)
  let current!: ReturnType<typeof useLocation>
  let dispose = () => {}
  try {
    createRoot((cleanup) => {
      dispose = cleanup
      return createComponent(LocationProvider, {
        get location() {
          return location()
        },
        get children() {
          current = useLocation()
          return null
        },
      })
    })
    expect(current()).toBe(first)
    setLocation(second)
    expect(current()).toBe(second)
    setLocation(undefined)
    expect(current()).toBeUndefined()
  } finally {
    dispose()
  }
})

test("clipboard providers preserve an injected service without using the host clipboard", async () => {
  const written: string[] = []
  const service: ClipboardService = {
    async write(text) {
      written.push(text)
    },
    async read() {
      return { data: written.at(-1) ?? "", mime: "text/plain" }
    },
  }
  let current!: ReturnType<typeof useClipboard>
  let dispose = () => {}
  try {
    createRoot((cleanup) => {
      dispose = cleanup
      return createComponent(ClipboardProvider, {
        value: service,
        get children() {
          current = useClipboard()
          return null
        },
      })
    })
    expect(current).toBe(service)
    await current.write?.("provider regression")
    expect(written).toEqual(["provider regression"])
    expect(await current.read?.()).toEqual({ data: "provider regression", mime: "text/plain" })
  } finally {
    dispose()
  }
})
