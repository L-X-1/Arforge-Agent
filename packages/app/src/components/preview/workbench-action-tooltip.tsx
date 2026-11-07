import type { JSX } from "solid-js"
import { TooltipV2 } from "@arforge-ai/ui/v2/tooltip-v2"

/** Ordinary workbench actions share pointer delay and immediate keyboard hints. */
export function WorkbenchActionTooltip(props: { label: string; class?: string; children: JSX.Element }) {
  return (
    <TooltipV2 value={props.label} placement="top" class={props.class} contentStyle={{ "max-width": "280px" }}>
      {props.children}
    </TooltipV2>
  )
}
