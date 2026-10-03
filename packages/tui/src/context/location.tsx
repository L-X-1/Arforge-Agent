import type { LocationRef } from "@arforge-ai/sdk/v2"
import { createComponent, createContext, useContext, type Accessor, type ParentProps } from "solid-js"

const context = createContext<Accessor<LocationRef | undefined>>()

export function LocationProvider(props: ParentProps<{ location?: LocationRef }>) {
  return createComponent(context.Provider, {
    value: () => props.location,
    get children() {
      return props.children
    },
  })
}

export function useLocation() {
  const value = useContext(context)
  if (!value) throw new Error("Location context must be used within a LocationProvider")
  return value
}
