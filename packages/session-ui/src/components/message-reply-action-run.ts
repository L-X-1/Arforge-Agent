import type { AgentPartInput, FilePartInput, Part, TextPartInput, UserMessage } from "@arforge-ai/sdk/v2/client"

/** Detach the original request from reactive stores without copying injected text. */
export function captureReplyPrompt(user: UserMessage, parts: readonly Part[], id: string, model: UserMessage["model"] = user.model) {
  const original = JSON.parse(JSON.stringify(parts.filter((part) =>
    (part.type === "text" && !part.synthetic && !part.ignored) || part.type === "file" || part.type === "agent",
  ))) as Part[]
  return {
    sessionID: user.sessionID, id,
    agent: user.agent, model: { ...model }, variant: model.variant, system: user.system,
    text: original.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n"),
    legacyParts: original.flatMap<TextPartInput | FilePartInput | AgentPartInput>((part) => {
      if (part.type === "text") return [{ type: "text", text: part.text }]
      if (part.type === "file") return [{ type: "file", url: part.url, mime: part.mime, filename: part.filename, source: part.source }]
      if (part.type === "agent") return [{ type: "agent", name: part.name, source: part.source }]
      return []
    }),
    files: original.flatMap((part) => part.type === "file" ? [{ uri: part.url, name: part.filename,
      mention: part.source?.text ? { start: part.source.text.start, end: part.source.text.end, text: part.source.text.value } : undefined }] : []),
    agents: original.flatMap((part) => part.type === "agent" ? [{ name: part.name,
      mention: part.source ? { start: part.source.start, end: part.source.end, text: part.source.value } : undefined }] : []),
  }
}

/** Only a confirmed rollback may be followed by a new admission in the same source scope. */
export async function retryMessageReply(input: {
  current: () => boolean
  revert: () => Promise<{ state: "completed" } | { state: "status"; status: unknown }>
  submit: () => Promise<unknown>
}) {
  if (!input.current()) return "stale" as const
  const reverted = await input.revert()
  if (!input.current()) return "stale" as const
  if (reverted.state !== "completed") return "pending" as const
  await input.submit()
  return input.current() ? "admitted" as const : "stale" as const
}

/** A late fork receipt may not seed a draft or navigate a different source. */
export async function branchMessageReply<T>(input: {
  current: () => boolean
  fork: () => Promise<T>
  open: (forked: T) => void
}) {
  if (!input.current()) return "stale" as const
  const forked = await input.fork()
  if (!input.current()) return "stale" as const
  input.open(forked)
  return "opened" as const
}
