import type { JSX } from "solid-js"
import { ManagementCollection } from "./management-collection"

export type ManagementTask = {
  id: string
  title: () => string
  description: () => string
  render: () => JSX.Element
}

/** Form tasks are not fabricated server entities. Their original controlled state stays above this view. */
export function ManagementTasks(props: {
  label: string
  scope: string
  scopeLabel?: string
  tasks: readonly ManagementTask[]
  toolbar?: JSX.Element
}) {
  return (
    <ManagementCollection
      label={props.label}
      scope={props.scope}
      scopeLabel={props.scopeLabel}
      items={props.tasks}
      identity={(task) => task.id}
      title={(task) => task.title()}
      description={(task) => task.description()}
      toolbar={props.toolbar}
    >
      {(task) => task.render()}
    </ManagementCollection>
  )
}
