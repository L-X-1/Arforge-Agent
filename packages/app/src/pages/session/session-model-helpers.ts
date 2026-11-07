import type { UserMessage } from "@arforge-ai/sdk/v2"

type Local = {
  session: {
    reset(): void
    restore(msg: UserMessage): void
  }
}

type ModelSelection = {
  model: {
    current(): { id: string; provider: { id: string } } | undefined
    set(model: { providerID: string; modelID: string }, options?: { restoring?: boolean }): void
    variant: {
      current(): string | undefined
      set(variant: string | undefined, options?: { restoring?: boolean }): void
    }
  }
}

type PromptState = {
  model: {
    current(): { providerID: string; modelID: string; variant?: string | null } | undefined
    set(model: { providerID: string; modelID: string; variant?: string | null }): void
  }
}

type ActiveDraft = Pick<PromptState, "model"> & {
  ready(): boolean
  dirty(): boolean
  context: { items(): readonly unknown[] }
}

export const resetSessionModel = (local: Local) => {
  local.session.reset()
}

export const syncSessionModel = (local: Local, msg: UserMessage, draft?: ActiveDraft) => {
  // Queued promotions can arrive while an unrelated draft is being edited.
  // The history route must not become the draft's next-send model in that case.
  if (draft?.ready() && (draft.dirty() || draft.context.items().length > 0) && draft.model.current()) return
  local.session.restore(msg)
}

export const syncPromptModel = (local: ModelSelection, prompt: PromptState) => {
  const model = local.model.current()
  if (!model) return
  const next = {
    providerID: model.provider.id,
    modelID: model.id,
    variant: local.model.variant.current(),
  }
  const current = prompt.model.current()
  if (current?.providerID === next.providerID && current.modelID === next.modelID && current.variant === next.variant)
    return
  prompt.model.set(next)
}

export const restorePromptModel = (local: ModelSelection, prompt: PromptState) => {
  const model = prompt.model.current()
  if (!model) return false
  const current = local.model.current()
  if (
    current?.provider.id === model.providerID &&
    current.id === model.modelID &&
    local.model.variant.current() === (model.variant ?? undefined)
  )
    return true
  if (current?.provider.id !== model.providerID || current.id !== model.modelID)
    local.model.set({ providerID: model.providerID, modelID: model.modelID }, { restoring: true })
  local.model.variant.set(model.variant ?? undefined, { restoring: true })
  return true
}
