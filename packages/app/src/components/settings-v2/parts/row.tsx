import { createUniqueId, onMount, onCleanup, type Component, type JSX } from "solid-js"
import { useSettingsSearch } from "../settings-search"
import "../settings-v2.css"

export interface SettingsRowV2Props {
  title: string | JSX.Element
  description: string | JSX.Element
  children: JSX.Element
  density?: "single" | "double"
  searchLabel?: string
  searchKeywords?: readonly string[]
}

export const SettingsRowV2: Component<SettingsRowV2Props> = (props) => {
  const id = createUniqueId()
  const search = useSettingsSearch()
  let root!: HTMLDivElement
  onMount(() => {
    const unregister = search?.register({
      id,
      label: () => props.searchLabel ?? (typeof props.title === "string" ? props.title : ""),
      description: () => (typeof props.description === "string" ? props.description : ""),
      keywords: () => props.searchKeywords ?? [],
      target: () => root,
    })
    onCleanup(() => unregister?.())
  })
  return (
    <div
      ref={root}
      tabIndex={-1}
      data-component="settings-v2-row"
      data-density={props.density}
      role="group"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
    >
      <div data-slot="settings-v2-row-copy">
        <div id={`${id}-title`} data-slot="settings-v2-row-title">
          {props.title}
        </div>
        <div id={`${id}-description`} data-slot="settings-v2-row-description">
          {props.description}
        </div>
      </div>
      <div data-slot="settings-v2-row-control">{props.children}</div>
    </div>
  )
}
