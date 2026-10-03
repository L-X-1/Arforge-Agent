import { PermissionV2 } from "@arforge-ai/core/permission"
import type { AgentV2 } from "@arforge-ai/core/agent"
import type { SessionMessage } from "@arforge-ai/core/session/message"
import type { SessionSchema } from "@arforge-ai/core/session/schema"
import type { ToolRegistry } from "@arforge-ai/core/tool/registry"
import { Effect, Fiber } from "effect"

export interface Identity {
  readonly sessionID: SessionSchema.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly toolCallID: string
}

const belongsToExactInvocation = (request: PermissionV2.Request, identity: Identity) =>
  request.sessionID === identity.sessionID &&
  request.source?.type === "tool" &&
  request.source.messageID === identity.assistantMessageID &&
  request.source.callID === identity.toolCallID

/**
 * Converts the user's explicit `debug agent --tool` command into one-time
 * replies for only the permission requests created by that exact invocation.
 * ActionGateway remains the sole authorizer and capability issuer.
 */
const approveExactInvocation = Effect.fnUntraced(function* (permissions: PermissionV2.Interface, identity: Identity) {
  const replied = new Set<PermissionV2.ID>()
  while (true) {
    const pending = yield* permissions.list()
    for (const request of pending) {
      if (replied.has(request.id) || !belongsToExactInvocation(request, identity)) continue
      replied.add(request.id)
      yield* permissions
        .reply({ requestID: request.id, reply: "once" })
        .pipe(Effect.catchTag("PermissionV2.NotFoundError", () => Effect.void))
    }
    yield* Effect.sleep("5 millis")
  }
})

export const settle = Effect.fn("Cli.debug.agent.settleExplicitTool")(function* (input: {
  readonly permissions: PermissionV2.Interface
  readonly materialized: ToolRegistry.Materialization
  readonly identity: Identity
  readonly agent: AgentV2.ID
  readonly name: string
  readonly args: unknown
}) {
  const approver = yield* approveExactInvocation(input.permissions, input.identity).pipe(Effect.forkChild)
  return yield* input.materialized
    .settle({
      sessionID: input.identity.sessionID,
      agent: input.agent,
      assistantMessageID: input.identity.assistantMessageID,
      call: {
        type: "tool-call",
        id: input.identity.toolCallID,
        name: input.name,
        input: input.args,
      },
    })
    .pipe(Effect.ensuring(Fiber.interrupt(approver)))
})

export * as ExplicitToolApproval from "./explicit-tool-approval"
