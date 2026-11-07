import type { Arforge } from "@arforge-ai/sdk-next/remote"
import type { CompatibleApi } from "./server-compat"
import type { SessionCommandOutput } from "@arforge-ai/client/promise"

type Operations = Pick<ReturnType<typeof Arforge.make>["sessions"], "shell" | "command" | "compact">

/** Current encoders own the body and status contract; the installed vendor client predates these operations. */
export function createSessionOperationsApi(current: Operations) {
  return {
    shell: async (value: Parameters<CompatibleApi["session"]["shell"]>[0]) => {
      await current.shell({
        sessionID: value.sessionID, id: value.messageID ?? value.id,
        command: value.command, agent: value.agent,
        model: value.model && { providerID: value.model.providerID, id: value.model.modelID },
      })
    },
    command: async (value: Parameters<CompatibleApi["session"]["command"]>[0]): Promise<SessionCommandOutput> => {
      const admitted = await current.command({
        sessionID: value.sessionID, id: value.id,
        command: value.command, arguments: value.arguments,
        agent: value.agent, model: value.model,
        files: value.files, delivery: value.delivery,
      })
      return {
        admittedSeq: admitted.admittedSeq, id: admitted.id, sessionID: admitted.sessionID,
        timeCreated: admitted.timeCreated, delivery: admitted.delivery,
        type: "user", data: { text: admitted.prompt.text },
      }
    },
    compact: async (value: Parameters<CompatibleApi["session"]["compact"]>[0]): Promise<void> => {
      await current.compact({
        sessionID: value.sessionID,
        model: value.model && { providerID: value.model.providerID, id: value.model.modelID, variant: value.model.variant },
        expectedContext: value.expectedContext,
        expectedDirectory: value.expectedDirectory,
      })
    },
  }
}
