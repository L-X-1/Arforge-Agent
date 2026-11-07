import type { OperationsApi } from "./server"

type Sessions = Pick<OperationsApi["sessions"], "rewindPreview" | "rewindApply">
type Preview = Awaited<ReturnType<Sessions["rewindPreview"]>>

/** Preview/cancel are read-only. Only an acknowledged conversation archive permits resending. */
export async function regenerateConversationReply(input: {
  readonly api: Sessions
  readonly target: { readonly sessionID: string; readonly messageID: string; readonly expectedDirectory: string }
  readonly current: () => boolean
  /** Admission requires idle state; a new Run becoming busy after its receipt is expected. */
  readonly ready?: () => boolean
  readonly confirm: (preview: Preview) => Promise<boolean>
  readonly refresh: () => Promise<unknown>
  readonly submit: () => Promise<unknown>
}) {
  const canWrite = () => input.current() && (input.ready?.() ?? true)
  if (!canWrite()) return "stale" as const
  const preview = await input.api.rewindPreview(input.target)
  if (!canWrite()) return "stale" as const
  if (!preview.expectedRevision) throw new Error("The server cannot safely preview this regeneration. Refresh the conversation before retrying.")
  if (!await input.confirm(preview)) return "cancelled" as const
  if (!canWrite()) return "stale" as const
  await input.api.rewindApply({ ...input.target, expectedLastSequence: preview.expectedLastSequence, expectedRevision: preview.expectedRevision })
  if (!canWrite()) return "stale" as const
  // An empty first-prompt history refresh can dispose this timeline owner.
  // Keep the acknowledged resend before that read, with all write fences intact.
  await input.submit()
  if (input.current()) await input.refresh()
  return "admitted" as const
}
