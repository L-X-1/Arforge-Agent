import { confirmModelChoice, ModelChoiceError, type ModelChoice } from "./dialog-select-model-state"

export type ModelSelectionBinding = {
  key(): (ModelChoice & { variant?: string | null }) | undefined
  /** Stable server/workspace/session or independent-draft identity. */
  scope(): string
  ready(): boolean
  unavailable(): "provider" | "disconnected" | "removed" | undefined
  /** Async implementations must recheck expectedScope immediately before committing. */
  select(choice: ModelChoice, expectedScope: string): void | Promise<void>
}

type SelectionModel = {
  ready(): boolean
  list(): readonly { id: string; provider: { id: string } }[]
  current(): { id: string; provider: { id: string } } | undefined
  set(choice: ModelChoice, options: { recent: boolean }): void | Promise<void>
}

export async function confirmBoundModelChoice(input: {
  choice: ModelChoice
  model: SelectionModel
  binding?: ModelSelectionBinding
  scope(): string
  expectedScope: string
  active(): boolean
}) {
  const { binding, model } = input
  const assertScope = () => {
    if (!input.active() || input.scope() !== input.expectedScope ||
      (binding && binding.scope() !== input.expectedScope)) throw new ModelChoiceError("scope-changed")
  }
  assertScope()
  await confirmModelChoice({
    choice: input.choice,
    scope: input.scope,
    expectedScope: input.expectedScope,
    available: (choice) => (!binding || binding.ready()) && model.ready() &&
      model.list().some((item) => item.provider.id === choice.providerID && item.id === choice.modelID),
    write: (choice) => {
      assertScope()
      return binding ? binding.select(choice, input.expectedScope) : model.set(choice, { recent: false })
    },
    current: () => {
      assertScope()
      if (binding) return binding.key()
      const current = model.current()
      return current ? { providerID: current.provider.id, modelID: current.id } : undefined
    },
  })
  assertScope()
}
