import type { NormalizedProviderListResponse } from "@arforge-ai/session-ui/context"

const emptyProviderCatalog: NormalizedProviderListResponse = { all: new Map(), connected: [], default: {} }

type DirectoryCatalog = {
  ready: boolean
  providers: NormalizedProviderListResponse
}

type ProviderCatalogInput =
  | {
      explicit: true
      directory?: string
      catalog?: DirectoryCatalog
    }
  | {
      explicit: false
      directory?: string
      catalog?: DirectoryCatalog
      global: NormalizedProviderListResponse
    }

export function selectProviderCatalog(input: ProviderCatalogInput) {
  if (input.directory && input.catalog?.ready) return input.catalog.providers
  if (input.explicit) return emptyProviderCatalog
  return input.global
}

export function providerConnectionChoices(catalog: NormalizedProviderListResponse) {
  const connected = new Set(catalog.connected)
  return Array.from(catalog.all.values()).filter(
    (provider) =>
      provider.source !== "custom" ||
      (provider.id !== "opencode" && provider.id !== "arforge") ||
      connected.has(provider.id),
  )
}
