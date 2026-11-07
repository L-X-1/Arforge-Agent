import { createComponent, createContext, useContext, type Accessor, type ParentProps } from "solid-js"

export type UIPresentation = "legacy" | "workspace"

const defaultPresentation: Accessor<UIPresentation> = () => "legacy"
const PresentationContext = createContext<Accessor<UIPresentation>>(defaultPresentation)

/** Presentation follows the Solid owner, including dialogs and menu portals. */
export function UIPresentationProvider(props: ParentProps<{ value: UIPresentation }>) {
  return createComponent(PresentationContext.Provider, {
    value: () => props.value,
    get children() {
      return props.children
    },
  })
}

export function useUIPresentation(override?: Accessor<UIPresentation | undefined>): Accessor<UIPresentation> {
  const inherited = useContext(PresentationContext)
  return () => override?.() ?? inherited()
}
