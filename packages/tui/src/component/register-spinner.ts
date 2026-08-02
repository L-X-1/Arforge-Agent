import { getComponentCatalogue } from "@opentui/solid/components"
import { registerSpinner } from "opentui-spinner/solid"

export function registerArforgeSpinner() {
  if (!getComponentCatalogue().spinner) registerSpinner()
}
