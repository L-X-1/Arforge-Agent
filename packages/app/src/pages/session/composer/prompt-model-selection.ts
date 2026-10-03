import { useModels } from "@/context/models"
import type { ModelKey } from "@/context/local"
import { usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useProviders } from "@/hooks/use-providers"
import { createPromptModelState } from "./prompt-model-state"

export function createPromptModelSelection(input: { agent: () => { model?: ModelKey; variant?: string } | undefined }) {
  const sdk = useSDK()
  const sync = useSync()
  return createPromptModelState({
    agent: input.agent,
    models: useModels(),
    prompt: usePrompt(),
    providers: useProviders(() => sdk().directory),
    configured: () => sync().data.config.model,
    scope: () => ({ server: sdk().scope, directory: sdk().directory }),
  })
}
