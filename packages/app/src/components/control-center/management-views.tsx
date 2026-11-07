import { For, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { TabsV2 } from "@arforge-ai/ui/v2/tabs-v2"
import "./management-views.css"

export type ManagementView = { id: string; label: string | (() => string); render: () => JSX.Element }

/** Existing category values remain unchanged. Inactive owners stay mounted with their drafts. */
export function ManagementViews(props: { label: string; views: readonly ManagementView[] }) {
  const [state, setState] = createStore({ value: props.views[0]?.id ?? "" })
  return (
    <TabsV2 value={state.value} onChange={(value) => setState("value", value)} class="arforge-management-views">
      <TabsV2.List aria-label={props.label}>
        <For each={props.views}>
          {(view) => (
            <TabsV2.Trigger value={view.id}>
              {typeof view.label === "function" ? view.label() : view.label}
            </TabsV2.Trigger>
          )}
        </For>
      </TabsV2.List>
      <For each={props.views}>
        {(view) => (
          <TabsV2.Content value={view.id} forceMount hidden={state.value !== view.id} inert={state.value !== view.id}>
            {view.render()}
          </TabsV2.Content>
        )}
      </For>
    </TabsV2>
  )
}
