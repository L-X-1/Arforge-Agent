import { createUniqueId, type Component, type JSX } from "solid-js"
import "../settings-v2.css"

export interface SettingsRowV2Props {
  title: string | JSX.Element
  description: string | JSX.Element
  children: JSX.Element
}

export const SettingsRowV2: Component<SettingsRowV2Props> = (props) => {
  const id = createUniqueId()
  return (
    <div data-component="settings-v2-row" role="group" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}>
      <div data-slot="settings-v2-row-copy">
        <div id={`${id}-title`} data-slot="settings-v2-row-title">{props.title}</div>
        <div id={`${id}-description`} data-slot="settings-v2-row-description">{props.description}</div>
      </div>
      <div data-slot="settings-v2-row-control">{props.children}</div>
    </div>
  )
}
