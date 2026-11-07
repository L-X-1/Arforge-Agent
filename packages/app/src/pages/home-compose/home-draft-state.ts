import type { DraftTab, SessionTab, Tab } from "@/context/tabs"
import type { PromptInputSubmission } from "@/components/prompt-input/contracts"
import { pathKey } from "@/utils/path-key"
import { base64Encode } from "@arforge-ai/core/util/encode"
import { decode64 } from "@/utils/base64"

export type DraftSource = Pick<DraftTab, "server" | "directory">

/** Use only with the path query owned by this draft's server scope and directory. */
export function canSubmitDraftDirectory(input: {
  directory: string
  pathDirectory?: string
  pending: boolean
  success: boolean
  healthy?: boolean
  readable: boolean
}) {
  return (
    input.readable &&
    input.healthy !== false &&
    input.success &&
    !input.pending &&
    !!input.pathDirectory?.trim() &&
    pathKey(input.directory) === pathKey(input.pathDirectory)
  )
}

/** Guard the real submit callback, including keyboard/programmatic dispatch; abort stays usable. */
export function guardDraftSubmission(
  submission: PromptInputSubmission,
  canSubmit: () => boolean,
): PromptInputSubmission {
  return {
    abort: () => submission.abort(),
    handleSubmit: (event) => {
      event.preventDefault()
      if (!canSubmit()) return
      return submission.handleSubmit(event)
    },
  }
}

export function sameDraftSource(left: DraftSource, right: DraftSource) {
  return left.server === right.server && pathKey(left.directory) === pathKey(right.directory)
}

export function activeDraftID(pathname: string, search: string) {
  if (pathname !== "/" && pathname !== "/new-session") {
    const segment = /^\/([A-Za-z0-9_-]+)\/session\/?$/.exec(pathname)?.[1]
    const directory = decode64(segment)
    if (!directory || base64Encode(directory) !== segment) return
  }
  const query = new URLSearchParams(search)
  if (pathname === "/" && (query.get("history") === "1" || query.get("archived") === "1")) return
  return query.get("draftId") || undefined
}

/** A compatibility URL cannot borrow another draft's persisted prompt or submit owner. */
export function captureDraftForSource(tabs: readonly Tab[], draftID: string, source: DraftSource): DraftTab {
  const draft = tabs.find((tab): tab is DraftTab => tab.type === "draft" && tab.draftID === draftID)
  if (!draft || !sameDraftSource(draft, source)) throw new Error("Draft source changed or was closed")
  return { ...draft }
}

/** Dedupe concurrent creation without sharing a draft between servers or directories. */
export function createHomeDraftOwner(input: {
  ready: () => Promise<unknown>
  list: () => readonly Tab[]
  create: (source: DraftSource) => Promise<DraftTab>
}) {
  const pending = new Map<string, Promise<DraftTab>>()
  return async (source: DraftSource, preferredID?: string) => {
    const captured = { ...source }
    await input.ready()
    const matches = input
      .list()
      .filter((tab): tab is DraftTab => tab.type === "draft" && !!tab.home && sameDraftSource(tab, captured))
    const existing = matches.find((tab) => tab.draftID === preferredID) ?? matches.at(-1)
    if (existing) return existing
    const key = JSON.stringify([captured.server, pathKey(captured.directory)])
    const current = pending.get(key)
    if (current) return current
    const next = input.create(captured)
    pending.set(key, next)
    try {
      return await next
    } finally {
      if (pending.get(key) === next) pending.delete(key)
    }
  }
}

type DraftActions = {
  store: readonly Tab[]
  updateDraft: (id: string, next: Partial<Omit<DraftTab, "type" | "draftID">>) => void
  promoteDraft: (
    id: string,
    session: Omit<SessionTab, "type">,
    expected?: DraftSource,
    canNavigate?: () => boolean,
    canConsume?: () => boolean,
  ) => void | Promise<void>
}

/** Bind async callers to the draft they mounted with, even after the URL changes. */
export function bindDraftActions(input: {
  tabs: DraftActions
  draft: DraftTab
  active: () => boolean
  retarget?: (source: DraftSource) => void
}) {
  const snapshot = { ...input.draft }
  const current = () =>
    input.tabs.store.find(
      (tab): tab is DraftTab =>
        tab.type === "draft" && tab.draftID === snapshot.draftID && sameDraftSource(tab, snapshot),
    )
  return {
    draft: (_id: string) => {
      if (!current()) throw new Error("Draft source changed or was closed")
      return snapshot
    },
    updateDraft: (_id: string, next: Partial<Omit<DraftTab, "type" | "draftID">>) => {
      if (!current() || !input.active()) return
      const source = { server: next.server ?? snapshot.server, directory: next.directory ?? snapshot.directory }
      if (input.retarget && !sameDraftSource(source, snapshot)) {
        input.retarget(source)
        return
      }
      input.tabs.updateDraft(snapshot.draftID, next)
    },
    promoteDraft: (
      _id: string,
      session: Omit<SessionTab, "type">,
      _expected?: DraftSource,
      canNavigate?: () => boolean,
      canConsume?: () => boolean,
    ) => {
      if (!current()) return Promise.resolve()
      return Promise.resolve(
        input.tabs.promoteDraft(
          snapshot.draftID,
          { ...session, server: snapshot.server },
          snapshot,
          () => input.active() && canNavigate?.() !== false,
          canConsume,
        ),
      )
    },
  }
}
