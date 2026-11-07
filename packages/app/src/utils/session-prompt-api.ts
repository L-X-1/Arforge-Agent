import type { SessionPromptOutput } from "@arforge-ai/client/promise"
import type { Arforge } from "@arforge-ai/sdk-next/remote"
import type { CompatibleApi } from "./server-compat"

type PromptInput = Parameters<CompatibleApi["session"]["prompt"]>[0]
type SendPrompt = ReturnType<typeof Arforge.make>["sessions"]["prompt"]

// Keep the app's draft shape while using the canonical admission contract.
// Routing and request-scoped system instructions belong to this exact prompt,
// not to separate session mutations that could race with another submission.
export function createSessionPromptApi(send: SendPrompt) {
  return async (value: PromptInput, options?: Parameters<SendPrompt>[1]): Promise<SessionPromptOutput> => {
    // Consume matching parts once: different MCP servers may expose the same URI/name.
    const originalFiles = value.legacyParts?.filter((part) => part.type === "file") ?? []
    const admitted = await send(
      {
        sessionID: value.sessionID,
        id: value.id ?? undefined,
        delivery: value.delivery ?? undefined,
        resume: value.resume ?? undefined,
        prompt: {
          text: value.text,
          files: value.files?.map((file) => {
            const index = originalFiles.findIndex(
              (part) =>
                part.url === file.uri &&
                part.filename === file.name &&
                (part.source?.type !== "resource" ||
                  !file.mention ||
                  (part.source.text.value === file.mention.text &&
                    part.source.text.start === file.mention.start &&
                    part.source.text.end === file.mention.end)),
            )
            const original = index < 0 ? undefined : originalFiles.splice(index, 1)[0]
            if (
              !original &&
              originalFiles.some(
                (part) => part.url === file.uri && part.filename === file.name && part.source?.type === "resource",
              )
            )
              throw new Error("MCP attachment source no longer matches its captured mention")
            const resource =
              original?.source?.type === "resource"
                ? { server: original.source.clientName, uri: original.source.uri }
                : undefined
            if (resource && resource.uri !== file.uri)
              throw new Error("MCP attachment URI differs from its selected resource target")
            return {
              uri: file.uri,
              name: file.name,
              mime:
                original?.type === "file"
                  ? original.mime
                  : (/^data:([^;,]+)/.exec(file.uri)?.[1] ?? (file.mention ? "text/plain" : undefined)),
              // Legacy resource sources require a span; an empty span represents no mention.
              source:
                resource && file.mention?.text === "" && file.mention.start === 0 && file.mention.end === 0
                  ? undefined
                  : file.mention,
              ...(resource ? { resource } : {}),
            }
          }),
          agents: value.agents?.map((agent) => ({ name: agent.name, source: agent.mention })),
          system: value.system === undefined ? undefined : { text: value.system, source: "request", scope: "turn" },
          route:
            value.agent === undefined && value.model === undefined
              ? undefined
              : {
                  agent: value.agent,
                  model: value.model && {
                    id: value.model.modelID,
                    providerID: value.model.providerID,
                    variant: value.variant,
                  },
                },
        },
      },
      options,
    )

    // Project the real admission receipt for the existing UI. Never fabricate
    // an admission sequence or report success after an HTTP failure.
    return {
      admittedSeq: admitted.admittedSeq,
      id: admitted.id,
      sessionID: admitted.sessionID,
      timeCreated: admitted.timeCreated,
      type: "user",
      data: { text: admitted.prompt.text },
      delivery: admitted.delivery,
    }
  }
}
