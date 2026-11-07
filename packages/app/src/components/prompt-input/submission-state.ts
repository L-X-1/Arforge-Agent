import { type ContextItem, type Prompt, type usePrompt } from "@/context/prompt"
import { unwrap } from "solid-js/store"

type PromptTarget = ReturnType<ReturnType<typeof usePrompt>["capture"]>

export function createPromptSubmissionState(input: {
  target: PromptTarget
  prompt: Prompt
  context: (ContextItem & { key: string })[]
}) {
  const initial = input.target
  const initialOwnership = initial.ownership.capture()
  let target = input.target
  let ownership = initialOwnership
  let cleared = false
  let clearInitial = true
  let writable = true
  let preserved = false
  const prompt = structuredClone(unwrap(input.prompt))
  const context = structuredClone(unwrap(input.context))

  return {
    prompt,
    context,
    canConsume: () => !preserved && initialOwnership.current(),
    preserve() {
      clearInitial = false
      writable = false
      preserved = true
    },
    target: () => target,
    update(action: () => void) {
      if (!writable || !ownership.current()) return false
      action()
      ownership = target.ownership.capture()
      return true
    },
    clear() {
      if (clearInitial && initial !== target && initialOwnership.current()) initial.reset()
      if (!writable || !ownership.current()) return false
      target.reset()
      ownership = target.ownership.capture()
      cleared = true
      return true
    },
    retarget(next: PromptTarget, options?: { consumeInitial?: boolean }) {
      clearInitial = options?.consumeInitial !== false
      // The Session may already have been opened/edited while its create reply was pending.
      writable = !next.dirty() && next.context.items().length === 0
      if (writable) context.forEach(next.context.add)
      target = next
      ownership = next.ownership.capture()
    },
    current: (value: PromptTarget) => writable && target === value && ownership.current(),
    restore() {
      if (!writable || !cleared || !ownership.current()) return
      return { target, prompt, context }
    },
  }
}
