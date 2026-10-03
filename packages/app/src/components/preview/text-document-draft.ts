import { TextDocument } from "@arforge-ai/schema/text-document"

export interface TextDraft {
  readonly format: 1
  readonly base: TextDocument.Info
  readonly text: string
}

export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

// Not an `arforge.` cache key: cache quota eviction must never evict user drafts.
export const textDraftKey = (scope: string, directory: string, filePath: string) =>
  `arforge-text-draft:${JSON.stringify([scope, directory, filePath])}`

export const isDirty = (draft: TextDraft | undefined) => !!draft && draft.text !== draft.base.text

export function acknowledgeSave(draft: TextDraft, saved: TextDocument.Info): TextDraft {
  // A save response must not discard text typed while the request was in flight.
  return { format: 1, base: saved, text: draft.text }
}

export function createTextDraftRepository(storage: () => DraftStorage) {
  const memory = new Map<string, TextDraft | null>()
  const observed = new Map<string, string | null>()
  return {
    restore(key: string): TextDraft | undefined {
      if (memory.has(key)) return memory.get(key) ?? undefined
      const raw = storage().getItem(key)
      observed.set(key, raw)
      if (raw === null) return
      const value: unknown = JSON.parse(raw)
      if (
        !value || typeof value !== "object" || !("format" in value) || value.format !== 1 ||
        !("base" in value) || !TextDocument.isInfo(value.base) ||
        !("text" in value) || typeof value.text !== "string"
      ) throw new Error("The stored draft could not be decoded. It was not deleted.")
      const draft: TextDraft = { format: 1, base: value.base, text: value.text }
      memory.set(key, draft)
      return draft
    },
    remember(key: string, draft: TextDraft | null) {
      memory.set(key, draft)
    },
    flush(key: string) {
      if (!memory.has(key)) return
      const draft = memory.get(key)
      const next = draft ? JSON.stringify(draft) : null
      const target = storage()
      const current = target.getItem(key)
      if (observed.has(key) && current !== observed.get(key) && current !== next)
        throw new Error("Another window changed this draft. The in-memory edit was retained without overwriting it.")
      if (next === null) target.removeItem(key)
      else target.setItem(key, next)
      observed.set(key, next)
    },
    unsavedKeys() {
      return [...memory].filter(([, draft]) => draft !== null && isDirty(draft)).map(([key]) => key)
    },
    hasUnsaved() {
      return [...memory.values()].some((draft) => draft !== null && isDirty(draft))
    },
  }
}

export const textDrafts = createTextDraftRepository(() => localStorage)

if (typeof window !== "undefined") {
  // Keep the warning active even after an unsaved file tab has been closed.
  window.addEventListener("beforeunload", (event) => {
    if (!textDrafts.hasUnsaved()) return
    event.preventDefault()
    event.returnValue = ""
  })
}
