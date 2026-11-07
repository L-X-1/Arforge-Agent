import { CancelledError, type QueryClient } from "@tanstack/solid-query"
import type { ModelPreset } from "@arforge-ai/schema/model-preset"
import type { OperationsApi } from "./server"
import { pathKey } from "./path-key"

export async function loadModelPresetCatalog(input: {
  scope: string
  directory?: string
  models: Pick<OperationsApi["models"], "list">
  queryClient: QueryClient
  isCurrent: () => boolean
}): Promise<ModelPreset.Catalog | undefined> {
  if (!input.isCurrent()) return undefined
  const location = input.directory ? { directory: input.directory } : undefined
  const queryKey = [input.scope, input.directory ?? null, "models", "presets"]
  try {
    const catalog = await input.queryClient.fetchQuery({
      queryKey,
      staleTime: 60_000,
      retry: false,
      queryFn: async ({ signal }) => {
        const assertCurrent = () => {
          // A previously cancelled fetch may finish after its replacement started.
          // Its aborted signal must not cancel that newer same-key query.
          if (signal.aborted) throw new CancelledError({ revert: true })
          if (!input.isCurrent()) {
            // Use TanStack's cancellation path to abort and restore pre-fetch state.
            // Returning an empty wrapper here would publish fresh "unsupported" data
            // to a current A consumer deduplicated onto a retired A request.
            void input.queryClient.cancelQueries({ queryKey, exact: true }, { revert: true })
            throw new CancelledError({ revert: true })
          }
        }
        assertCurrent()
        try {
          const response = await input.models.list({ location, includePresets: true }, { signal })
          assertCurrent()
          if (input.directory && pathKey(response.location.directory) !== pathKey(input.directory))
            throw new Error("Model preset response belongs to a different directory")
          // A current older server's genuinely omitted optional field is supported.
          return { catalog: response.presets }
        } catch (error) {
          assertCurrent()
          throw error
        }
      },
    })
    return input.isCurrent() ? catalog.catalog : undefined
  } catch (error) {
    if (!input.isCurrent()) return undefined
    if (error instanceof CancelledError && error.revert) {
      // Query.fetch restores prior data, but deduplicated waiters receive the
      // retryer's rejection directly. Preserve the same valid cache for them.
      const previous = input.queryClient.getQueryData<{ catalog: ModelPreset.Catalog | undefined }>(queryKey)
      if (previous?.catalog) return previous.catalog
    }
    // A current owner sharing a retired empty fetch gets the normal unavailable /
    // Retry UI. The cancellation left no successful sentinel to suppress its retry.
    throw error
  }
}
