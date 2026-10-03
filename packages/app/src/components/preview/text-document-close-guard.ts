import { isDirty, textDraftKey, textDrafts, type TextDraft } from "./text-document-draft"

export type TextDraftCloseTarget = {
  scope?: string
  directory?: string
  paths?: readonly string[]
}

type DraftRepository = Pick<typeof textDrafts, "restore" | "flush" | "unsavedKeys">
type Dialogs = {
  confirm: (message: string) => boolean
  alert: (message: string) => void
  defer: (callback: () => void) => void
}

export function createTextDocumentCloseGuard(repository: DraftRepository, dialogs: Dialogs) {
  const approved = new Map<string, TextDraft>()
  let generation = 0

  const selected = (target?: TextDraftCloseTarget) => {
    const keys = target?.paths && target.scope !== undefined && target.directory !== undefined
      ? target.paths.map((path) => textDraftKey(target.scope!, target.directory!, path))
      : repository.unsavedKeys()
    return [...new Set(keys)].flatMap((key) => {
      const value: unknown = JSON.parse(key.slice("arforge-text-draft:".length))
      if (!Array.isArray(value) || value.length !== 3 || !value.every((part) => typeof part === "string")) {
        throw new Error("Invalid draft identity")
      }
      const [scope, directory, path] = value as string[]
      if (target?.scope !== undefined && scope !== target.scope) return []
      if (target?.directory !== undefined && directory !== target.directory) return []
      if (target?.paths && !target.paths.includes(path!)) return []
      const draft = repository.restore(key)
      return draft && isDirty(draft) ? [{ key, draft }] : []
    })
  }

  const prepare = (target: TextDraftCloseTarget | undefined, chinese: boolean, navigation: boolean, confirmed: boolean) => {
    try {
      const drafts = selected(target)
      if (drafts.length === 0) return true
      if (!confirmed && drafts.some(({ key, draft }) => approved.get(key) !== draft)) {
        const message = navigation
          ? chinese
            ? "\u6709\u672a\u4fdd\u5b58\u7684\u6587\u4ef6\u4fee\u6539\u3002\u4fdd\u7559\u8349\u7a3f\u5e76\u7ee7\u7eed\u5207\u6362\uff1f\u53d6\u6d88\u5c06\u7559\u5728\u5f53\u524d\u9875\u9762\u3002"
            : "There are unsaved file changes. Keep the drafts and continue? Cancel stays on this page."
          : chinese
            ? "\u6709\u672a\u4fdd\u5b58\u7684\u6587\u4ef6\u4fee\u6539\u3002\u4fdd\u7559\u8349\u7a3f\u5e76\u5173\u95ed\uff1f\u53d6\u6d88\u5c06\u4fdd\u7559\u5f53\u524d\u6807\u7b7e\u3002"
            : "There are unsaved file changes. Keep the drafts and close? Cancel keeps the current tabs."
        if (!dialogs.confirm(message)) return false
      }
      for (const { key } of drafts) repository.flush(key)
      for (const { key, draft } of drafts) approved.set(key, draft)
      const current = ++generation
      // Share this synchronous user action with nested tab/router guards only.
      // A later user action or a newly edited draft must ask again.
      dialogs.defer(() => {
        if (generation === current) approved.clear()
      })
      return true
    } catch {
      dialogs.alert(chinese
        ? "\u65e0\u6cd5\u5b89\u5168\u4fdd\u5b58\u672c\u5730\u8349\u7a3f\uff0c\u64cd\u4f5c\u5df2\u53d6\u6d88\u3002\u7f16\u8f91\u5185\u5bb9\u4ecd\u4fdd\u7559\uff1b\u8bf7\u5148\u89e3\u51b3\u8349\u7a3f\u5b58\u50a8\u6216\u591a\u7a97\u53e3\u51b2\u7a81\u3002"
        : "The local draft could not be safely retained, so the action was cancelled. Your edits remain available; resolve draft storage or another-window conflicts first.")
      return false
    }
  }

  return {
    confirm(target: TextDraftCloseTarget | undefined, chinese: boolean, navigation = false) {
      return prepare(target, chinese, navigation, false)
    },
    // Used only after the existing file-tab confirmation has already succeeded.
    withConfirmation(target: TextDraftCloseTarget, chinese: boolean, action: () => void) {
      if (!prepare(target, chinese, false, true)) return false
      action()
      return true
    },
  }
}

export const textDocumentCloseGuard = createTextDocumentCloseGuard(textDrafts, {
  confirm: (message) => typeof window !== "undefined" && window.confirm(message),
  alert: (message) => { if (typeof window !== "undefined") window.alert(message) },
  defer: (callback) => { setTimeout(callback, 0) },
})
