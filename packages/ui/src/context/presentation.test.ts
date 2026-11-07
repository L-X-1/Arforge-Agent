import { describe, expect, test } from "bun:test"
import { createComponent, createRoot, getOwner, runWithOwner, type Accessor, type Owner } from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import { UIPresentationProvider, useUIPresentation, type UIPresentation } from "./presentation"

describe("UI presentation ownership", () => {
  test("defaults to legacy and does not infer workspace presentation from the DOM", () => {
    createRoot((dispose) => {
      const shell = document.createElement("div")
      shell.dataset.component = "workspace-shell"
      document.body.append(shell)
      try {
        expect(useUIPresentation()()).toBe("legacy")
      } finally {
        shell.remove()
        dispose()
      }
    })
  })

  test("a portal outside the workspace DOM keeps its creating Solid owner's presentation", () => {
    const mount = document.createElement("div")
    document.body.append(mount)
    const root = createRoot((dispose) => {
      let presentation: Accessor<UIPresentation> | undefined
      createComponent(UIPresentationProvider, {
        value: "workspace",
        get children() {
          return createComponent(Portal, {
            mount,
            get children() {
              presentation = useUIPresentation()
              return document.createElement("span")
            },
          })
        },
      })
      return { dispose, presentation: () => presentation?.(), sibling: useUIPresentation() }
    })
    try {
      expect(root.presentation()).toBe("workspace")
      expect(mount.children.length).toBeGreaterThan(0)
      expect(root.sibling()).toBe("legacy")
    } finally {
      root.dispose()
      mount.remove()
    }
  })

  test("dialog roots recreated with runWithOwner retain presentation without changing the global provider", () => {
    createRoot((dispose) => {
      let owner: Owner | null = null
      createComponent(UIPresentationProvider, {
        value: "workspace",
        get children() {
          owner = getOwner()
          return undefined
        },
      })
      let dialogPresentation: UIPresentation | undefined
      runWithOwner(owner, () =>
        createRoot((close) => {
          dialogPresentation = useUIPresentation()()
          close()
        }),
      )
      expect(dialogPresentation).toBe("workspace")
      expect(useUIPresentation()()).toBe("legacy")
      dispose()
    })
  })

  test("nested legacy scopes and explicit component overrides stay isolated and reactive", () => {
    createRoot((dispose) => {
      const [state, setState] = createStore<{ value: UIPresentation; override?: UIPresentation }>({
        value: "workspace",
      })
      let inherited: Accessor<UIPresentation> | undefined
      let nested: Accessor<UIPresentation> | undefined
      let override: Accessor<UIPresentation> | undefined
      createComponent(UIPresentationProvider, {
        get value() {
          return state.value
        },
        get children() {
          inherited = useUIPresentation()
          override = useUIPresentation(() => state.override)
          createComponent(UIPresentationProvider, {
            value: "legacy",
            get children() {
              nested = useUIPresentation()
              return undefined
            },
          })
          return undefined
        },
      })
      expect(inherited?.()).toBe("workspace")
      expect(nested?.()).toBe("legacy")
      setState("override", "legacy")
      expect(override?.()).toBe("legacy")
      expect(inherited?.()).toBe("workspace")
      setState("value", "legacy")
      expect(inherited?.()).toBe("legacy")
      setState("override", "workspace")
      expect(override?.()).toBe("workspace")
      expect(nested?.()).toBe("legacy")
      dispose()
    })
  })
})
