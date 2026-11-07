import { publicErrorMessage } from "@/utils/public-error"
import { managementErrorText } from "@/components/settings-v2/management-state"

export function executionErrorPresentation(error: unknown, fallback: string, formatted?: string) {
  const data = error && typeof error === "object" && "data" in error ? error.data : undefined
  const message =
    data && typeof data === "object" && "message" in data && typeof data.message === "string"
      ? data.message
      : (formatted ?? publicErrorMessage(error, fallback))
  const type =
    error && typeof error === "object" && "name" in error && typeof error.name === "string" ? error.name : "Error"
  return {
    message: publicErrorMessage(managementErrorText(message, fallback)).slice(0, 2_000),
    type: publicErrorMessage(type).slice(0, 80),
  }
}
