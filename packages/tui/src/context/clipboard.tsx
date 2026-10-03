import { createComponent, createContext, type JSX, useContext } from "solid-js"
import { read, write } from "../clipboard"

export type ClipboardContent = Readonly<{ data: string; mime: string }>
export type ClipboardService = Readonly<{
  read?(): Promise<ClipboardContent | undefined>
  write?(text: string): Promise<void>
}>
const clipboard = { read, write }
const ClipboardContext = createContext<ClipboardService>(clipboard)

export function ClipboardProvider(props: { value?: ClipboardService; children: JSX.Element }) {
  return createComponent(ClipboardContext.Provider, {
    value: props.value ?? clipboard,
    get children() {
      return props.children
    },
  })
}

export function useClipboard() {
  return useContext(ClipboardContext)
}
