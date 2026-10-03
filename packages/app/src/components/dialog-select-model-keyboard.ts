import { handleDocumentSearchKeydown } from "@/utils/search-keydown"

export function handleModelPickerSearchKeydown(
  input: HTMLInputElement | undefined,
  event: KeyboardEvent,
  inputValue: string,
  setInputValue: (value: string) => void,
) {
  // Space activates the focused native button, including provider headers.
  // Do not turn that activation into text search or cancel its default action.
  if (event.key === " " && event.target instanceof Element && event.target.closest("button")) return false
  return handleDocumentSearchKeydown(input, event, inputValue, setInputValue)
}
